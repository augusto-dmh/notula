// SPDX-License-Identifier: Apache-2.0
// The extension source provider: what the connected
// extensions report, turned into content-source playbacks.
//
// - Sessions: `hello` → `hello.ack` with the chosen protocol, the desktop mode and the policy.
//   An extension older than MIN_EXT, or without a common protocol, gets mode `none`.
// - Mode per connection: `none` while detection is off or the device lock is on; `feed` +
//   `feed_tab` while the fed note (bus `sources:feed`) is bound to one of that connection's tabs;
//   else `candidates`. Policy: incognito, captions, replay (off in local-only mode), outline.
// - Playbacks (bus `sources:playback`, provider `extension`): one per tab and item (a new URL key
//   in the same tab is a new playback). `seen` until 20 s of non-ad playing time (and at least
//   2 min long, unless live or unknown), then `candidate`; `provisional` while an ad shows before
//   that; `ended` when the player ended. Private-window tabs are dropped unless
//   `sources.extension.allowIncognito` is on.
// - Coverage (bus `media:extension`): a browser is covered while one of its connections sent
//   `media` in the last 10 s, or nothing in that browser plays according to Windows.
//   With `sources.extensionPreferred` off nothing is covered and no playback is published.
// - Spans: while the fed note is bound to an extension tab, play / pause / seek / rate / ad / end
//   close a watched span, stored through the sources core's span writer.
// - Marks: for the fed note's video now; else appended to that video's existing note when
//   it isn't open (`marks.ts`); else held 10 min for that video and replayed once a note for it
//   is fed. `mark.ack` within the extension's 5 s wait.
// - Captions: `captions.request` once per fed tab and video; parts pass to the transcript plan on
//   bus `media:extension-captions` with the key recomputed from the tab's URL and 0-based parts.
// - Gates main enforces itself, whatever the peer does: in mode `none` (detection off, device
//   lock) only `hello` and `log` are acted on, and a `mark` is answered `no-media`; `page` is
//   dropped and forgotten while the Course pages switch is off; at most MAX_TABS tabs per connection.
// Notula never sends note text, titles, transcripts or URLs to the extension. Logs carry counts
// and state names only.

import { normalizeHost, parseSourceUrl } from '@shared/lib/source-key'
import { formatPosition } from '@shared/lib/position'
import type { ExtMedia, ExtMode, ExtPage, ExtPolicy, ExtStore, ExtToNotula, NotulaToExt } from '@shared/types/extension-protocol'
import { EXT_LIMITS, EXT_PROTOCOL } from '@shared/types/extension-protocol'
import type { Settings } from '@shared/types/settings'
import type { BrowserId, CanonicalKey, MediaSession, Playback, PlaybackState } from '@shared/types/sources'
import { SOURCES_LIMITS } from '@shared/types/sources'
import type { BusEvents } from '../../bus'
import type { MainContext } from '../../context'
import { log } from '../../log'
import { extensionTrack } from '../captions'
import { appendMarkToSourceNote } from '../marks'
import { SpanWriter } from '../spans'
import type { BridgeConn } from './server'

/** The oldest extension version this desktop accepts. Lives in code, not on a server. */
export const MIN_EXT = '1.0.0'

const TICK_MS = 1_000
const TAB_TTL_MS = 10 * 60_000
/** A gap larger than this between two reports isn't counted as played time. */
const PLAYED_GAP_MS = 6_000
const SEEK_SLACK_MS = 2_000
const MIN_SPAN_MS = 500
const HELD_MARKS_MAX = 20
/** The note's editor opens after Take notes; a held mark waits for it. */
const HELD_REPLAY_MS = 1_500
const SNAPSHOT_MIN_MS = 1_000
const COUNTS_EVERY_MS = 60_000
const MISSES_MAX = 20
const RECENT_TTL_MS = 2 * 60_000
const RECENT_MAX = 50
/** An honest extension reports a handful of tabs; past this the oldest goes. */
const MAX_TABS = 64

export interface BrowserSeen {
  extVersion: string
  store: ExtStore
  lastSeenAt: number
}

export interface ProviderHooks {
  settings(): Settings | null
  locked(): boolean
  appVersion(): string
  /** A hello arrived from this brand (persisted for not-installed vs waiting). */
  seen(brand: string, info: BrowserSeen): void
  statusChanged(): void
}

interface Session {
  conn: BridgeConn
  hello: { brand: string; browser: BrowserId | null; extVersion: string; store: ExtStore } | null
  outdated: boolean
  mode: ExtMode | null
  feedTab: string | null
  policy: string | null
  lastMediaAt: number
  lastSeenAt: number
}

interface Tab {
  key: string
  connId: number
  media: ExtMedia
  page: ExtPage | null
  itemKey: CanonicalKey
  playbackId: string
  seenAt: number
  playedMs: number
  lastAt: number
  candidate: boolean
  receivedAt: number
}

interface OpenSpan {
  noteId: string
  tabKey: string
  playbackId: string
  wallStart: number
  posStartMs: number
  rate: number
  lastWall: number
  lastPos: number
}

interface HeldMark {
  positionMs: number
  observedAt: number
  browser: BrowserId | null
  until: number
}

export function browserOf(brand: string): BrowserId | null {
  if (/edge/i.test(brand)) return 'edge'
  if (/brave/i.test(brand)) return 'brave'
  if (/chrome/i.test(brand)) return 'chrome'
  return null
}

/** `1.2.3` comparison; missing parts count as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((p) => Number.parseInt(p, 10) || 0)
  const pb = b.split('.').map((p) => Number.parseInt(p, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d < 0 ? -1 : 1
  }
  return 0
}

/** The canonical key of a reported URL; the URL without its fragment when no provider knows it. */
function itemKeyOf(m: ExtMedia): CanonicalKey {
  const parsed = parseSourceUrl(m.url) ?? (m.canonical_url ? parseSourceUrl(m.canonical_url) : null)
  if (parsed) return parsed.canonicalKey
  return `url:${m.url.split('#')[0]}`
}

/**
 * Is the extension's `video` key the tab's item? Exact for `youtube:`, `udemy:` and `coursera:`.
 * Two providers still differ in form: `circle:` (the extension keeps `www.` in the host)
 * and `url:` (the extension's own URL normalisation); those are re-parsed and compared exactly.
 */
export function sameVideo(extKey: string, itemKey: CanonicalKey): boolean {
  if (extKey === itemKey) return true
  if (extKey.startsWith('circle:')) {
    const m = /^circle:([^:]+):([^:]+)$/.exec(extKey)
    return !!m && `circle:${normalizeHost(m[1] as string)}:${m[2] as string}` === itemKey
  }
  if (extKey.startsWith('url:')) {
    const parsed = parseSourceUrl(extKey.slice(4))
    return !!parsed && (parsed.canonicalKey === itemKey || `url:${extKey.slice(4).split('#')[0]}` === itemKey)
  }
  return false
}

export class ExtensionProvider {
  private readonly sessions = new Map<number, Session>()
  private readonly tabs = new Map<string, Tab>()
  private readonly held = new Map<CanonicalKey, HeldMark>()
  /** Tabs of a connection that closed, by `<tab>|<item>`, for a reconnect within RECENT_TTL_MS. */
  private readonly recent = new Map<string, Tab>()
  private readonly requested = new Set<string>()
  private readonly counts = new Map<string, number>()
  private readonly misses = new Set<string>()
  private readonly writer: SpanWriter
  private feed: BusEvents['sources:feed'] = null
  private span: OpenSpan | null = null
  /** Browsers Windows reports as playing something (bus `media:sessions`). */
  private smtcPlaying = new Set<BrowserId>()
  private covered: string[] = []
  private timer: NodeJS.Timeout | null = null
  private snapshotTimer: NodeJS.Timeout | null = null
  private lastSnapshotAt = 0
  private lastCountsAt = Date.now()
  private lastLocked = false
  private nextItem = 1
  private readonly offs: (() => void)[] = []

  constructor(
    private readonly ctx: MainContext,
    private readonly hooks: ProviderHooks
  ) {
    this.writer = new SpanWriter(ctx)
    const onFeed = (f: BusEvents['sources:feed']): void => this.onFeed(f)
    const onSessions = (e: BusEvents['media:sessions']): void => this.onSessions(e.sessions)
    ctx.bus.on('sources:feed', onFeed)
    ctx.bus.on('media:sessions', onSessions)
    this.offs.push(
      () => ctx.bus.off('sources:feed', onFeed),
      () => ctx.bus.off('media:sessions', onSessions)
    )
  }

  // ---------- what Settings shows ----------

  browsers(): { brand: string; live: boolean; outdated: boolean; extVersion: string; store: ExtStore; lastSeenAt: number }[] {
    const out = new Map<string, { brand: string; live: boolean; outdated: boolean; extVersion: string; store: ExtStore; lastSeenAt: number }>()
    for (const s of this.sessions.values()) {
      if (!s.hello) continue
      const cur = out.get(s.hello.brand)
      const live = !s.outdated
      if (cur && cur.live && !live) continue
      out.set(s.hello.brand, { brand: s.hello.brand, live, outdated: s.outdated, extVersion: s.hello.extVersion, store: s.hello.store, lastSeenAt: s.lastSeenAt })
    }
    return [...out.values()]
  }

  adapterMisses(): string[] {
    return [...this.misses]
  }

  // ---------- sessions ----------

  opened(conn: BridgeConn): void {
    this.sessions.set(conn.id, { conn, hello: null, outdated: false, mode: null, feedTab: null, policy: null, lastMediaAt: 0, lastSeenAt: Date.now() })
    this.syncTimer()
  }

  closed(conn: BridgeConn): void {
    const s = this.sessions.get(conn.id)
    this.sessions.delete(conn.id)
    for (const [k, t] of [...this.tabs]) if (t.connId === conn.id) this.dropTab(k, true)
    if (s?.hello) this.hooks.statusChanged()
    this.publish(true)
    this.syncTimer()
  }

  message(conn: BridgeConn, msg: ExtToNotula): void {
    const s = this.sessions.get(conn.id)
    if (!s) return
    s.lastSeenAt = Date.now()
    if (msg.type === 'hello') return this.onHello(s, msg)
    if (!s.hello) return this.count('before-hello')
    if (s.outdated) return this.count('outdated')
    // Mode `none` holds here too, not only in a well-behaved extension.
    if (msg.type !== 'log' && this.modeFor(s).mode === 'none') {
      this.count('mode-none')
      if (msg.type === 'mark') s.conn.send({ type: 'mark.ack', ok: false, position: null, reason: 'no-media' })
      return
    }
    switch (msg.type) {
      case 'media':
        return this.onMedia(s, msg)
      case 'media.gone': {
        const t = this.tabs.get(msg.tab)
        if (t && t.connId === conn.id) {
          this.dropTab(msg.tab)
          this.publish(true)
        }
        return
      }
      case 'page': {
        // Course pages off: course, section, lesson, playlist and channel aren't kept.
        if (!this.policy().outline) return this.count('page-policy')
        const t = this.tabs.get(msg.tab)
        if (t && t.connId === conn.id) t.page = msg
        return
      }
      case 'captions':
        return this.onCaptions(s, msg)
      case 'mark':
        return this.onMark(s, msg)
      case 'log':
        return this.onLog(msg.event, msg.count)
      case 'captions-unavailable':
        return this.count(`captions-unavailable:${msg.reason}`)
      // No desktop consumer yet: course outlines and chapters are counted and dropped.
      case 'outline':
      case 'chapters':
        return this.count(msg.type)
    }
  }

  private onHello(s: Session, msg: Extract<ExtToNotula, { type: 'hello' }>): void {
    const [min, max] = msg.protocol
    const chosen = Math.min(max, EXT_PROTOCOL.current)
    const compatible = chosen >= Math.max(min, EXT_PROTOCOL.oldest)
    const outdated = !compatible || compareVersions(msg.ext.version, MIN_EXT) < 0
    const wasHello = s.hello !== null
    s.hello = { brand: msg.browser.brand, browser: browserOf(msg.browser.brand), extVersion: msg.ext.version, store: msg.ext.store }
    s.outdated = outdated
    const mode = outdated ? { mode: 'none' as const, feedTab: null } : this.modeFor(s)
    const policy = this.policy()
    s.mode = mode.mode
    s.feedTab = mode.feedTab
    s.policy = JSON.stringify(policy)
    s.conn.send({
      type: 'hello.ack',
      protocol: compatible ? chosen : EXT_PROTOCOL.current,
      app: { version: this.hooks.appVersion().slice(0, 40) },
      mode: mode.mode,
      feed_tab: mode.feedTab,
      policy,
      min_ext: MIN_EXT
    })
    log('info', 'ext-bridge:session', { browser: s.hello.browser ?? 'other', store: msg.ext.store, outdated, mode: mode.mode, again: wasHello })
    this.hooks.seen(msg.browser.brand, { extVersion: msg.ext.version, store: msg.ext.store, lastSeenAt: Date.now() })
    this.hooks.statusChanged()
    if (mode.mode === 'feed') this.requestCaptions()
  }

  // ---------- modes and policy ----------

  private detecting(): boolean {
    const st = this.hooks.settings()
    return !!st && st['sources.enabled'] && st['sources.detect'] && st['sources.extension.enabled'] && !this.hooks.locked()
  }

  private modeFor(s: Session): { mode: ExtMode; feedTab: string | null } {
    if (!this.detecting()) return { mode: 'none', feedTab: null }
    const f = this.feed
    if (f && f.provider === 'extension' && f.tabKey && this.tabs.get(f.tabKey)?.connId === s.conn.id) return { mode: 'feed', feedTab: f.tabKey }
    return { mode: 'candidates', feedTab: null }
  }

  policy(): ExtPolicy {
    const st = this.hooks.settings()
    const captions = !!st && st['sources.extension.captions'] && st['sources.videoCaptions']
    return {
      incognito: !!st && st['sources.extension.allowIncognito'],
      captions,
      // A replay is a network request from the page: never in local-only mode.
      captions_replay: captions && !!st && !st['privacy.localOnly'],
      outline: !!st && st['sources.extension.coursePages']
    }
  }

  /** Settings, the feed or the lock changed: push what differs, per connection. */
  refresh(): void {
    const policy = this.policy()
    const policyText = JSON.stringify(policy)
    for (const s of this.sessions.values()) {
      if (!s.hello || s.outdated) continue
      const m = this.modeFor(s)
      if (m.mode !== s.mode || m.feedTab !== s.feedTab) {
        s.mode = m.mode
        s.feedTab = m.feedTab
        s.conn.send({ type: 'mode', mode: m.mode, feed_tab: m.feedTab })
        log('info', 'ext-bridge:mode', { mode: m.mode })
      }
      if (policyText !== s.policy) {
        s.policy = policyText
        s.conn.send({ type: 'policy', policy })
      }
    }
    // Private-window tabs go when the switch goes off; page fields when Course pages goes off.
    if (!policy.incognito) for (const [k, t] of [...this.tabs]) if (t.media.incognito) this.dropTab(k)
    if (!policy.outline) {
      for (const t of this.tabs.values()) t.page = null
      for (const t of this.recent.values()) t.page = null
    }
    this.publish(true)
  }

  // ---------- media ----------

  private onMedia(s: Session, m: ExtMedia): void {
    const now = Date.now()
    const st = this.hooks.settings()
    if (m.incognito && !(st && st['sources.extension.allowIncognito'])) {
      this.count('incognito-dropped')
      if (this.tabs.has(m.tab)) this.dropTab(m.tab)
      return
    }
    const prev = this.tabs.get(m.tab)
    if (prev && prev.connId !== s.conn.id) return this.count('tab-other-connection')
    if (prev && m.seq <= prev.media.seq) return this.count('stale')
    s.lastMediaAt = now
    const itemKey = itemKeyOf(m)
    let t = prev
    if (!t || t.itemKey !== itemKey) {
      if (t && this.span?.tabKey === m.tab) this.closeSpan(now, null)
      // The same tab and item after a reconnect keeps its playback (the core's binding follows it).
      const backKey = `${m.tab}|${itemKey}`
      const back = this.recent.get(backKey)
      this.recent.delete(backKey)
      t = {
        key: m.tab,
        connId: s.conn.id,
        media: m,
        page: back?.page ?? null,
        itemKey,
        playbackId: back?.playbackId ?? `ext:${this.nextItem++}`,
        seenAt: back?.seenAt ?? now,
        playedMs: back?.playedMs ?? 0,
        lastAt: now,
        candidate: back?.candidate ?? false,
        receivedAt: now
      }
      this.tabs.set(m.tab, t)
      this.capTabs(s.conn.id)
    } else {
      const wasPlaying = !t.media.media.paused && !t.media.media.ended && !t.media.ad.showing
      const gap = now - t.lastAt
      if (wasPlaying && gap > 0 && gap <= PLAYED_GAP_MS) t.playedMs += gap
      t.media = m
      t.lastAt = now
      t.receivedAt = now
    }
    if (!t.candidate && t.playedMs >= SOURCES_LIMITS.eligiblePlayedMs && !m.ad.showing) {
      const durationMs = m.media.duration !== null && !m.media.live ? m.media.duration * 1_000 : null
      if (durationMs === null || durationMs >= SOURCES_LIMITS.minDurationMs) t.candidate = true
    }
    this.followSpan(t, now)
    this.publish(false)
  }

  /** At most MAX_TABS per connection: the least recently reported go first. */
  private capTabs(connId: number): void {
    const mine = [...this.tabs.values()].filter((t) => t.connId === connId)
    if (mine.length <= MAX_TABS) return
    mine.sort((a, b) => a.receivedAt - b.receivedAt)
    for (const t of mine.slice(0, mine.length - MAX_TABS)) {
      this.dropTab(t.key)
      this.count('tabs-cap')
    }
  }

  private dropTab(key: string, keep = false): void {
    const t = this.tabs.get(key)
    if (!t) return
    if (keep) {
      this.recent.set(`${key}|${t.itemKey}`, { ...t, receivedAt: Date.now() })
      while (this.recent.size > RECENT_MAX) this.recent.delete(this.recent.keys().next().value as string)
    }
    if (this.span?.tabKey === key) this.closeSpan(Date.now(), null)
    this.tabs.delete(key)
    for (const r of [...this.requested]) if (r.startsWith(`${key}|`)) this.requested.delete(r)
  }

  private stateOf(t: Tab): PlaybackState {
    if (t.media.media.ended) return 'ended'
    if (t.candidate) return 'candidate'
    return t.media.ad.showing ? 'provisional' : 'seen'
  }

  private playbackOf(t: Tab, browser: BrowserId): Playback {
    const m = t.media
    const now = Date.now()
    const status = m.media.ended ? 'stopped' : m.media.paused ? 'paused' : 'playing'
    const updatedAt = Math.min(now, Math.max(m.observed_at, t.receivedAt - 5_000))
    return {
      id: t.playbackId,
      provider: 'extension',
      browser,
      tabKey: t.key,
      title: (m.title || m.session?.title || '').trim(),
      artist: m.session?.artist ?? t.page?.channel?.name ?? null,
      status,
      positionMs: Math.round(m.media.current_time * 1_000),
      durationMs: m.media.duration !== null && !m.media.live ? Math.round(m.media.duration * 1_000) : null,
      rate: m.media.rate > 0 ? m.media.rate : 1,
      updatedAt,
      live: m.media.live,
      ad: m.ad.showing,
      privateWindow: m.incognito,
      url: m.url,
      site: m.site,
      state: this.stateOf(t),
      playedMs: t.playedMs,
      seenAt: t.seenAt
    }
  }

  private preferred(): boolean {
    return !!this.hooks.settings()?.['sources.extensionPreferred']
  }

  private computeCovered(now: number): string[] {
    if (!this.preferred()) return []
    const out = new Set<BrowserId>()
    for (const s of this.sessions.values()) {
      const b = s.hello?.browser
      if (!b || s.outdated) continue
      // Quiet while Windows still reports this browser playing: the passive pipeline takes over.
      if (now - s.lastMediaAt <= EXT_LIMITS.coveredQuietMs || !this.smtcPlaying.has(b)) out.add(b)
    }
    return [...out].sort()
  }

  /** Publishes `sources:playback` and `media:extension`; `force` skips the 1 s throttle. */
  private publish(force: boolean): void {
    const now = Date.now()
    if (!force && now - this.lastSnapshotAt < SNAPSHOT_MIN_MS) {
      if (!this.snapshotTimer) {
        this.snapshotTimer = setTimeout(() => {
          this.snapshotTimer = null
          this.publish(true)
        }, SNAPSHOT_MIN_MS - (now - this.lastSnapshotAt))
        this.snapshotTimer.unref()
      }
      return
    }
    if (this.snapshotTimer) clearTimeout(this.snapshotTimer)
    this.snapshotTimer = null
    this.lastSnapshotAt = now
    const preferred = this.preferred()
    const playbacks: Playback[] = []
    const tabs: ExtMedia[] = []
    const pages: ExtPage[] = []
    for (const t of this.tabs.values()) {
      const browser = this.sessions.get(t.connId)?.hello?.browser
      tabs.push(t.media)
      if (t.page) pages.push(t.page)
      if (preferred && browser) playbacks.push(this.playbackOf(t, browser))
    }
    playbacks.sort((a, b) => b.updatedAt - a.updatedAt)
    const covered = this.computeCovered(now)
    const coverChanged = covered.join() !== this.covered.join()
    this.covered = covered
    this.ctx.bus.emit('media:extension', { covered, tabs, pages })
    this.ctx.bus.emit('sources:playback', { provider: 'extension', playbacks })
    if (coverChanged) {
      log('info', 'ext-bridge:covered', { browsers: covered })
      this.hooks.statusChanged()
    }
  }

  private onSessions(sessions: MediaSession[]): void {
    const next = new Set<BrowserId>()
    for (const s of sessions) if (s.status === 'playing') next.add(s.browser)
    this.smtcPlaying = next
  }

  // ---------- the feed and spans ----------

  private onFeed(f: BusEvents['sources:feed']): void {
    const prev = this.feed
    this.feed = f
    const now = Date.now()
    if (this.span && (!f || f.noteId !== this.span.noteId || f.provider !== 'extension' || f.tabKey !== this.span.tabKey)) this.closeSpan(now, null)
    if (f && f.provider === 'extension' && f.tabKey) {
      const t = this.tabs.get(f.tabKey)
      if (t) this.followSpan(t, now)
    }
    if (prev?.noteId !== f?.noteId || prev?.tabKey !== f?.tabKey) {
      this.refresh()
      this.requestCaptions()
      this.replayHeld()
    }
  }

  private followSpan(t: Tab, now: number): void {
    const f = this.feed
    const fed = !!f && f.provider === 'extension' && f.tabKey === t.key && f.canonicalKey === t.itemKey
    const m = t.media
    const playing = fed && !m.media.paused && !m.media.ended && !m.ad.showing
    const pos = m.media.current_time * 1_000
    const rate = m.media.rate > 0 ? m.media.rate : 1
    const sp = this.span
    // The open span always belongs to the fed tab (onFeed closes it when the feed moves).
    if (sp && sp.tabKey !== t.key) return
    if (sp) {
      const expected = sp.lastPos + (now - sp.lastWall) * sp.rate
      const seek = Math.abs(pos - expected) > SEEK_SLACK_MS
      if (!playing || sp.playbackId !== t.playbackId || rate !== sp.rate || seek) {
        // A seek happened somewhere since the last sample: count it as played up to now.
        this.closeSpan(now, seek && playing ? expected : pos)
      } else {
        sp.lastWall = now
        sp.lastPos = pos
        return
      }
    }
    if (playing && f) {
      this.span = { noteId: f.noteId, tabKey: t.key, playbackId: t.playbackId, wallStart: now, posStartMs: pos, rate, lastWall: now, lastPos: pos }
    }
  }

  /** Closes the open span at `now`; `posEnd` null = the last sample moved on to now. */
  private closeSpan(now: number, posEnd: number | null): void {
    const sp = this.span
    this.span = null
    if (!sp) return
    const end = posEnd ?? sp.lastPos + (now - sp.lastWall) * sp.rate
    if (now - sp.wallStart < MIN_SPAN_MS) return
    this.writer.add(sp.noteId, { wallStart: sp.wallStart, wallEnd: now, posStartMs: sp.posStartMs, posEndMs: Math.max(sp.posStartMs, end), rate: sp.rate })
  }

  // ---------- captions ----------

  private requestCaptions(): void {
    const f = this.feed
    if (!f || f.provider !== 'extension' || !f.tabKey || !this.policy().captions) return
    const t = this.tabs.get(f.tabKey)
    const s = t ? this.sessions.get(t.connId) : undefined
    if (!t || !s || s.mode !== 'feed' || t.itemKey !== f.canonicalKey || extensionTrack(t.itemKey)) return
    const id = `${t.key}|${t.itemKey}`
    if (this.requested.has(id)) return
    this.requested.add(id)
    s.conn.send({ type: 'captions.request', tab: t.key, video: t.itemKey, langs: [] })
  }

  private onCaptions(s: Session, msg: Extract<ExtToNotula, { type: 'captions' }>): void {
    if (!this.policy().captions) return this.count('captions-policy')
    const t = this.tabs.get(msg.tab)
    if (!t || t.connId !== s.conn.id) return this.count('captions-unknown-tab')
    // The desktop's key wins; the extension's `video` must name the same item.
    if (!sameVideo(msg.video, t.itemKey)) return this.count('captions-other-video')
    this.ctx.bus.emit('media:extension-captions', { ...msg, video: t.itemKey, part: msg.part - 1 })
  }

  // ---------- marks ----------

  private onMark(s: Session, msg: Extract<ExtToNotula, { type: 'mark' }>): void {
    const reply = (ack: Omit<Extract<NotulaToExt, { type: 'mark.ack' }>, 'type'>): void => s.conn.send({ type: 'mark.ack', ...ack })
    // The lock is read now, not from the 1 s poll: no mark lands in a note while the device is locked.
    if (this.hooks.locked() || msg.tab === null || msg.current_time === null) return reply({ ok: false, position: null, reason: 'no-media' })
    const positionMs = Math.round(msg.current_time * 1_000)
    const position = formatPosition(positionMs)
    const t = this.tabs.get(msg.tab)
    const key = t && t.connId === s.conn.id ? t.itemKey : null
    const f = this.feed
    const sameTab = !!f && f.provider === 'extension' && f.tabKey === msg.tab
    if (f && (sameTab || (key !== null && key === f.canonicalKey))) {
      this.ctx.bus.emit('sources:mark', {
        browser: s.hello?.browser ?? null,
        tabKey: sameTab ? msg.tab : null,
        positionMs,
        observedAt: Math.min(Date.now(), msg.observed_at),
        origin: 'extension'
      })
      log('info', 'ext-bridge:mark', { result: 'fed' })
      return reply({ ok: true, position, reason: null })
    }
    if (!key) {
      log('info', 'ext-bridge:mark', { result: 'no-media' })
      return reply({ ok: false, position: null, reason: 'no-media' })
    }
    const observedAt = Math.min(Date.now(), msg.observed_at)
    const hold = (): void => {
      // No note for this video yet (or one never opened): kept for 10 min; Take notes or Continue picks it up.
      this.held.delete(key)
      this.held.set(key, { positionMs, observedAt, browser: s.hello?.browser ?? null, until: Date.now() + EXT_LIMITS.markHoldMs })
      while (this.held.size > HELD_MARKS_MAX) this.held.delete(this.held.keys().next().value as string)
      log('info', 'ext-bridge:mark', { result: 'held' })
      reply({ ok: false, position, reason: 'held' })
    }
    // The video's note exists but isn't open: the paragraph goes into it now.
    void appendMarkToSourceNote(this.ctx, key, positionMs, observedAt).then((r) => {
      if (r.result !== 'appended') return hold()
      log('info', 'ext-bridge:mark', { result: 'appended' })
      reply({ ok: true, position, reason: null })
    })
  }

  private replayHeld(): void {
    const f = this.feed
    if (!f) return
    const h = this.held.get(f.canonicalKey)
    if (!h) return
    this.held.delete(f.canonicalKey)
    if (Date.now() > h.until) return
    setTimeout(() => {
      // Still the same note being fed, and the device still unlocked.
      if (this.feed?.noteId !== f.noteId || this.hooks.locked()) return
      this.ctx.bus.emit('sources:mark', {
        browser: h.browser,
        tabKey: this.feed.provider === 'extension' ? this.feed.tabKey : null,
        positionMs: h.positionMs,
        observedAt: h.observedAt,
        origin: 'extension'
      })
      log('info', 'ext-bridge:mark', { result: 'replayed' })
    }, HELD_REPLAY_MS).unref()
  }

  // ---------- counts ----------

  count(event: string, n = 1): void {
    this.counts.set(event, (this.counts.get(event) ?? 0) + n)
  }

  private onLog(event: string, n: number): void {
    const miss = /^adapter-miss:([a-z0-9.-]+):([a-z-]+)$/i.exec(event)
    if (miss) {
      const site = (miss[1] as string).toLowerCase()
      if (!this.misses.has(site) && this.misses.size < MISSES_MAX) {
        this.misses.add(site)
        this.hooks.statusChanged()
      }
      // Logs never carry a site: the field only.
      return this.count(`ext:adapter-miss:${miss[2] as string}`, n)
    }
    this.count(`ext:${event.split(':').slice(0, 2).join(':')}`, n)
  }

  private flushCounts(now: number): void {
    if (now - this.lastCountsAt < COUNTS_EVERY_MS) return
    this.lastCountsAt = now
    if (this.counts.size === 0) return
    log('info', 'ext-bridge:counts', Object.fromEntries([...this.counts].slice(0, 50)))
    this.counts.clear()
  }

  // ---------- the tick ----------

  private syncTimer(): void {
    const want = this.sessions.size > 0 || this.tabs.size > 0 || this.recent.size > 0 || this.held.size > 0
    if (want && !this.timer) {
      this.timer = setInterval(() => this.tick(), TICK_MS)
      this.timer.unref()
    } else if (!want && this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  private tick(): void {
    const now = Date.now()
    for (const [k, t] of [...this.tabs]) if (now - t.receivedAt > TAB_TTL_MS) this.dropTab(k)
    for (const [k, h] of [...this.held]) if (now > h.until) this.held.delete(k)
    for (const [k, t] of [...this.recent]) if (now - t.receivedAt > RECENT_TTL_MS) this.recent.delete(k)
    const locked = this.hooks.locked()
    if (locked !== this.lastLocked) {
      this.lastLocked = locked
      this.refresh()
    }
    // Coverage moves with time (10 s of quiet).
    if (this.computeCovered(now).join() !== this.covered.join()) this.publish(true)
    this.flushCounts(now)
    this.syncTimer()
  }

  // ---------- stop ----------

  /** The bridge stopped: forget everything (memory only) and publish the empty snapshots. */
  reset(): void {
    this.closeSpan(Date.now(), null)
    this.sessions.clear()
    this.tabs.clear()
    this.held.clear()
    this.recent.clear()
    this.requested.clear()
    this.misses.clear()
    this.publish(true)
    this.syncTimer()
  }

  async shutdown(): Promise<void> {
    this.closeSpan(Date.now(), null)
    for (const off of this.offs.splice(0)) off()
    await this.writer.flush()
  }
}
