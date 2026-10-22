// SPDX-License-Identifier: Apache-2.0
// Tab state and what the service worker sends about each tab.
//
// Content scripts report per frame; this module joins frames by tab (page metadata from frame 0,
// media from the frame that plays), applies the privacy gates (granted site, private
// windows) and the rates: on every play, pause, seek, rate change, end and URL change, plus every
// 1 s for the feed tab and every 5 s for other playing tabs in mode `candidates`.

import {
  EXT_LIMITS,
  type ExtCaptions,
  type ExtCue,
  type ExtMedia,
  type ExtTabKey
} from '../lib/protocol'
import { jsonBytes } from '../lib/check'
import type { CaptionsTrack, ChaptersReport, FrameReport, PageReport } from '../lib/messages'
import { siteOf } from '../lib/keys'
import { bridge, send, sendPaced, touchIdle } from './bridge'
import { count } from './counters'

interface FrameEntry {
  report: FrameReport
  at: number
}

export interface TabEntry {
  tabId: number
  key: ExtTabKey
  incognito: boolean
  audible: boolean
  frames: Map<number, FrameEntry>
  /** The video key frame 0 reported last; a change means the tab moved to another video. */
  video: string | null
  page: PageReport | null
  pageSent: string | null
  chapters: ChaptersReport | null
  chaptersSent: string | null
  tracks: CaptionsTrack[]
  tracksSent: Set<string>
  /** Notula asked about this tab (outline.request), so `page` may be sent outside the feed. */
  asked: boolean
  mediaSent: boolean
  lastSentAt: number
  lastPlayingAt: number
  seq: number
  /** Content-script messages per second, to drop floods. */
  bucket: { n: number; at: number }
  /** An incognito tab plays but private windows aren't allowed (`paused-incognito`). */
  blocked: boolean
}

const tabs = new Map<number, TabEntry>()
let sessionId = ''
const TRACKS_PER_TAB = 4
const CONTENT_PER_SECOND = 20

/** Settings mirrored from storage, kept current by the service worker's entry. */
export const gates = { allowIncognito: false, captions: true }

export async function initTabs(): Promise<void> {
  try {
    const s = await chrome.storage.session.get('sessionId')
    if (typeof s.sessionId === 'string' && /^[0-9a-f]{16}$/.test(s.sessionId)) {
      sessionId = s.sessionId
      return
    }
  } catch {
    // Fall through to a fresh id.
  }
  const bytes = crypto.getRandomValues(new Uint8Array(8))
  sessionId = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
  await chrome.storage.session.set({ sessionId }).catch(() => undefined)
}

export function tabKey(tabId: number): ExtTabKey {
  return `${sessionId}:${tabId}`
}

export function getTab(tabId: number): TabEntry | undefined {
  return tabs.get(tabId)
}

export function findByKey(key: string): TabEntry | undefined {
  for (const e of tabs.values()) if (e.key === key) return e
  return undefined
}

export function allTabs(): IterableIterator<TabEntry> {
  return tabs.values()
}

function entry(tab: chrome.tabs.Tab): TabEntry | null {
  if (tab.id === undefined || tab.id < 0) return null
  let e = tabs.get(tab.id)
  if (!e) {
    e = {
      tabId: tab.id,
      key: tabKey(tab.id),
      incognito: tab.incognito,
      audible: tab.audible ?? false,
      frames: new Map(),
      video: null,
      page: null,
      pageSent: null,
      chapters: null,
      chaptersSent: null,
      tracks: [],
      tracksSent: new Set(),
      asked: false,
      mediaSent: false,
      lastSentAt: 0,
      lastPlayingAt: 0,
      seq: 0,
      bucket: { n: 0, at: 0 },
      blocked: false
    }
    tabs.set(tab.id, e)
  }
  e.incognito = tab.incognito
  if (tab.audible !== undefined) e.audible = tab.audible
  return e
}

/** False drops the message: more than 20 per second from one tab's content scripts. */
export function admit(tab: chrome.tabs.Tab): boolean {
  const e = tab.id !== undefined ? tabs.get(tab.id) : undefined
  if (!e) return true
  const now = Date.now()
  if (now - e.bucket.at >= 1_000) e.bucket = { n: 0, at: now }
  e.bucket.n++
  if (e.bucket.n > CONTENT_PER_SECOND) {
    count('content:rate')
    return false
  }
  return true
}

/** Private windows: nothing leaves unless both our switch and Notula's policy allow it. */
function allowed(e: TabEntry): boolean {
  return !e.incognito || (gates.allowIncognito && bridge.policy.incognito)
}

function isPlaying(e: TabEntry): boolean {
  for (const f of e.frames.values()) {
    const m = f.report.media
    if (m && !m.paused && !m.ended) return true
  }
  return false
}

/** The frame whose media counts: playing, not muted, largest on screen, latest to start. */
function mainFrame(e: TabEntry): [number, FrameEntry] | null {
  let best: [number, FrameEntry] | null = null
  const score = (f: FrameEntry): number[] => {
    const m = f.report.media
    if (!m) return [-1]
    return [m.paused || m.ended ? 0 : 1, m.muted ? 0 : 1, m.area, m.started_at]
  }
  for (const [id, f] of e.frames) {
    if (!f.report.media) continue
    if (!best) {
      best = [id, f]
      continue
    }
    const a = score(f)
    const b = score(best[1])
    for (let i = 0; i < a.length; i++) {
      const d = (a[i] ?? 0) - (b[i] ?? 0)
      if (d > 0) best = [id, f]
      if (d !== 0) break
    }
  }
  return best
}

const MEDIA_URL_MAX = 1_000

/** The tab's `media` message, cut to fit 4 KiB. */
function mediaMessage(e: TabEntry): ExtMedia | null {
  const main = mainFrame(e)
  if (!main) return null
  const [frameId, f] = main
  const m = f.report.media
  if (!m) return null
  const meta = e.frames.get(0)?.report ?? f.report
  const msg: ExtMedia = {
    type: 'media',
    tab: e.key,
    frame: frameId,
    url: meta.url.slice(0, MEDIA_URL_MAX),
    canonical_url: meta.canonical_url?.slice(0, MEDIA_URL_MAX) ?? null,
    title: meta.title,
    site: siteOf(meta.url),
    incognito: e.incognito,
    audible: e.audible,
    media: {
      current_time: m.current_time,
      duration: m.duration,
      rate: m.rate,
      paused: m.paused,
      ended: m.ended,
      live: m.live,
      muted: m.muted
    },
    ad: { showing: f.report.ad || meta.ad },
    session: f.report.session ?? meta.session ?? null,
    adapter: meta.adapter,
    observed_at: f.at,
    seq: e.seq + 1
  }
  if (jsonBytes(msg) > EXT_LIMITS.mediaBytes) msg.canonical_url = null
  if (jsonBytes(msg) > EXT_LIMITS.mediaBytes) msg.session = null
  if (jsonBytes(msg) > EXT_LIMITS.mediaBytes) msg.title = msg.title.slice(0, 120)
  if (jsonBytes(msg) > EXT_LIMITS.mediaBytes) {
    count('send:media-too-big')
    return null
  }
  return msg
}

/** Whether `media` for this tab may be sent now, by mode. */
function mediaAllowed(e: TabEntry): boolean {
  if (!bridge.ready || !allowed(e)) return false
  if (bridge.mode === 'candidates') return true
  if (bridge.mode === 'feed') return e.key === bridge.feedTab
  return false
}

function sendMedia(e: TabEntry): void {
  const msg = mediaMessage(e)
  if (!msg) return
  if (send(msg)) {
    e.seq = msg.seq
    e.mediaSent = true
    e.lastSentAt = Date.now()
  }
}

function sendGone(e: TabEntry, reason: 'closed' | 'navigated' | 'stopped'): void {
  if (!e.mediaSent) return
  e.mediaSent = false
  if (bridge.ready && allowed(e)) send({ type: 'media.gone', tab: e.key, reason })
}

/** The feed tab gets the full set: page, chapters and captions the player loaded. */
function sendFeedExtras(e: TabEntry): void {
  if (!bridge.ready || bridge.mode !== 'feed' || e.key !== bridge.feedTab || !allowed(e)) return
  sendPage(e)
  if (e.chapters && e.chaptersSent !== e.chapters.video && e.chapters.video === e.video) {
    const c = e.chapters
    if (send({ type: 'chapters', tab: e.key, video: c.video, items: c.items, source: c.source })) e.chaptersSent = c.video
  }
  if (captionsAllowed()) for (const t of e.tracks) if (t.video === e.video) sendTrack(e, t)
}

/** Course, section, lesson, playlist and channel: only while Notula's Course pages switch is on. */
function sendPage(e: TabEntry): void {
  if (!e.page || !allowed(e) || !bridge.policy.outline) return
  const json = JSON.stringify(e.page.page)
  if (e.pageSent === json) return
  const feed = bridge.mode === 'feed' && e.key === bridge.feedTab
  if (!feed && !e.asked) return
  if (send({ type: 'page', tab: e.key, ...e.page.page })) e.pageSent = json
}

export function captionsAllowed(): boolean {
  return gates.captions && bridge.policy.captions
}

function trackId(t: CaptionsTrack): string {
  return `${t.video}|${t.lang}|${t.source}`
}

/** Splits a track into parts of at most 512 KiB, by cue, and queues them paced. */
export function sendTrack(e: TabEntry, t: CaptionsTrack): boolean {
  const id = trackId(t)
  if (e.tracksSent.has(id)) return true
  const parts = splitCues(t.cues)
  if (parts.length > EXT_LIMITS.captionsParts) {
    count('captions:too-many-parts')
    parts.length = EXT_LIMITS.captionsParts
  }
  const msgs: ExtCaptions[] = parts.map((cues, i) => ({
    type: 'captions',
    tab: e.key,
    video: t.video,
    lang: t.lang,
    kind: t.kind,
    source: t.source,
    part: i + 1,
    parts: parts.length,
    cues
  }))
  if (!sendPaced(msgs)) return false
  e.tracksSent.add(id)
  return true
}

const PART_BUDGET = EXT_LIMITS.captionsPartBytes - 512

function splitCues(cues: ExtCue[]): ExtCue[][] {
  const parts: ExtCue[][] = []
  let cur: ExtCue[] = []
  let size = 0
  for (const c of cues) {
    const n = jsonBytes(c) + 1
    if (size + n > PART_BUDGET && cur.length) {
      parts.push(cur)
      cur = []
      size = 0
    }
    cur.push(c)
    size += n
  }
  if (cur.length || !parts.length) parts.push(cur)
  return parts
}

// ---------- inputs ----------

export interface ReportResult {
  /** A playback started: the caller may open the port. */
  started: boolean
}

export function onFrameReport(tab: chrome.tabs.Tab, frameId: number, r: FrameReport): ReportResult {
  const e = entry(tab)
  if (!e) return { started: false }
  const wasPlaying = isPlaying(e)
  const now = Date.now()

  if (frameId === 0 && r.video !== e.video) {
    // Another video in the same tab (a single-page app navigates without a reload).
    if (e.video !== null) sendGone(e, 'navigated')
    e.video = r.video
    e.page = null
    e.pageSent = null
    e.chapters = null
    e.chaptersSent = null
    e.tracks = e.tracks.filter((t) => t.video === r.video)
    e.asked = false
  }
  if (r.event === 'gone' && frameId !== 0) e.frames.delete(frameId)
  else e.frames.set(frameId, { report: r, at: now })

  const playing = isPlaying(e)
  if (playing) e.lastPlayingAt = now
  e.blocked = e.incognito && !allowed(e) && playing

  if (mediaAllowed(e)) {
    const feed = bridge.mode === 'feed'
    if (r.event === 'tick') {
      const every = feed ? EXT_LIMITS.feedIntervalMs : EXT_LIMITS.candidatesIntervalMs
      if (playing && now - e.lastSentAt >= every - 100) sendMedia(e)
    } else if (playing || e.mediaSent || r.event === 'pause' || r.event === 'ended') {
      if (mainFrame(e)) sendMedia(e)
      else sendGone(e, r.event === 'gone' ? 'stopped' : 'navigated')
    }
    if (feed) sendFeedExtras(e)
  }
  if (wasPlaying !== playing) touchIdle()
  return { started: !wasPlaying && playing && allowed(e) }
}

export function onPageReport(tab: chrome.tabs.Tab, p: PageReport): void {
  const e = entry(tab)
  if (!e) return
  if (p.video !== e.video && e.video !== null && p.video !== null) return
  e.page = p
  sendPage(e)
}

export function onChapters(tab: chrome.tabs.Tab, c: ChaptersReport): void {
  const e = entry(tab)
  if (!e) return
  e.chapters = c
  sendFeedExtras(e)
}

/** A track the player loaded or the user asked to read; kept until the tab leaves the video. */
export function onTrack(tab: chrome.tabs.Tab, t: CaptionsTrack): TabEntry | null {
  const e = entry(tab)
  if (!e) return null
  const id = trackId(t)
  e.tracks = [...e.tracks.filter((x) => trackId(x) !== id), t].slice(-TRACKS_PER_TAB)
  sendFeedExtras(e)
  return e
}

export function onTabRemoved(tabId: number): void {
  const e = tabs.get(tabId)
  if (!e) return
  sendGone(e, 'closed')
  tabs.delete(tabId)
  touchIdle()
}

/** A full page load: frames re-report within a second if anything still plays. */
export function onTabLoading(tabId: number): void {
  const e = tabs.get(tabId)
  if (!e) return
  e.frames.clear()
  setTimeout(() => {
    const cur = tabs.get(tabId)
    if (cur && !mainFrame(cur)) {
      sendGone(cur, 'navigated')
      touchIdle()
    }
  }, 3_000)
}

export function onAudible(tabId: number, audible: boolean): void {
  const e = tabs.get(tabId)
  if (e) e.audible = audible
}

/** The port came up, or Notula changed mode or policy: send the current picture. */
export function flushAll(): void {
  for (const e of tabs.values()) {
    e.mediaSent = false
    e.pageSent = null
    e.chaptersSent = null
    e.tracksSent.clear()
    if (mediaAllowed(e) && (isPlaying(e) || e.key === bridge.feedTab)) sendMedia(e)
    sendFeedExtras(e)
  }
}

/** Before an idle disconnect: playback stopped for 120 s (`media.gone` with reason `stopped`). */
export function goneStopped(): void {
  for (const e of tabs.values()) if (!isPlaying(e)) sendGone(e, 'stopped')
}

export function anyPlaying(): boolean {
  for (const e of tabs.values()) if (allowed(e) && isPlaying(e)) return true
  return false
}

export function tabPlaying(e: TabEntry): boolean {
  return isPlaying(e)
}

export function tabAllowed(e: TabEntry): boolean {
  return allowed(e)
}

/** The frame playing now, for replies that must come from the player's frame. */
export function mediaFrameId(e: TabEntry): number {
  return mainFrame(e)?.[0] ?? 0
}

/** Position for Mark this moment from the last report, moved on by the time since. */
export function lastPosition(e: TabEntry): number | null {
  const main = mainFrame(e)
  if (!main) return null
  const m = main[1].report.media
  if (!m) return null
  if (m.paused || m.ended || main[1].report.ad) return m.current_time
  return m.current_time + ((Date.now() - main[1].at) / 1_000) * m.rate
}

/** The most recent tab that played, for a mark with no media in the active tab. */
export function latestPlaying(): TabEntry | null {
  let best: TabEntry | null = null
  for (const e of tabs.values()) {
    if (!mainFrame(e) || !allowed(e)) continue
    if (!best || e.lastPlayingAt > best.lastPlayingAt) best = e
  }
  return best
}

export function markAsked(e: TabEntry): void {
  e.asked = true
  sendPage(e)
}
