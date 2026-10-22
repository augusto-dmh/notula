// SPDX-License-Identifier: Apache-2.0
// Playbacks, identification, Recently played and the `source-detected` card.
//
// - Every provider publishes one snapshot at a time on bus `sources:playback` (media-session from
//   the passive provider, extension later). States: seen → provisional → candidate | muted →
//   ended. A candidate is identified once with `identify(stage: 'local')`; the result joins
//   Recently played (memory only, 20, newest first, cleared when the feature goes off or at quit).
// - The card has its own gates, not shared with other cards: `sources.offer`
//   `ask`, not during onboarding, one card per canonical key per 12 h, ≥ 120 s between cards, one
//   at a time, 60 s lifetime, a last-moment check that drops it once the playback stopped, and no
//   card while a meeting note captures (a capturing source note doesn't block).
//   `notifications.scheduledBlocked` doesn't apply (notify/index.ts).
// - A guess key never offers Continue. A key the open or capturing source note
//   already has is never offered.
// - Next item: the feed's playback ended and a candidate of the same series starts in the same
//   browser within 30 s: a `next` card, exempt from the 120 s gap and the 12 h key rule, while
//   the feed holds stamping until it is answered or gone.
// Logs carry states and counts only, never titles, channels or URLs.

import type { PushChannel } from '@shared/ipc'
import type { ExtPage } from '@shared/types/extension-protocol'
import type { NotificationAction } from '@shared/types/notify'
import type { Settings } from '@shared/types/settings'
import type {
  CanonicalKey,
  Playback,
  PlaybackProviderId,
  PlayingItem,
  SourceCardAction,
  SourceCardPayload,
  SourceDraft,
  SourceMute,
  SourceNoteRequest
} from '@shared/types/sources'
import { GUESS_KEY_PREFIX, SOURCES_LIMITS } from '@shared/types/sources'
import type { MainContext } from '../context'
import { log } from '../log'
import { identify } from './identify'
import { applyPage } from './page'

/** Re-check a waiting candidate this often (a gate may open: gap, capture, one at a time). */
const RETRY_MS = 5_000
/** Margin over the card lifetime before a card no one answered counts as gone. */
const CARD_GRACE_MS = 2_000
/** A playback identification found nothing for is tried again after this long. */
const IDENTIFY_RETRY_MS = 30_000
/** The end is reported once the old session is gone past the debounce: a next item may start just before. */
const NEXT_SLACK_MS = 5_000

export const isGuessKey = (key: CanonicalKey): boolean => key.startsWith(GUESS_KEY_PREFIX)

export interface Track {
  playback: Playback
  draft: SourceDraft | null
  identifying: boolean
  /** When identification last found nothing (back-off). */
  failedAt: number | null
  /** The title the draft was identified from. */
  identifiedTitle: string | null
  /** The newest non-trashed note with the same exact or high key (Recently played, Continue). */
  noteId: string | null
  /** `waiting`: identified, a gate is closed for now; `done`: offered or never to be offered. */
  offer: 'none' | 'waiting' | 'done'
}

/** What the feed tells the offer (Next item, keys already being noted). */
export interface FeedView {
  /** Keys of the open and the capturing source notes: never offered. */
  busyKeys(): Set<CanonicalKey>
  /** The fed note's playback ended or was replaced: its series, browser and when. */
  nextContext(): { noteId: string; seriesKey: CanonicalKey; browser: string; endedAt: number } | null
  hold(on: boolean): void
  /** A playback was identified: the feed may (re)bind to it. */
  identified(track: Track): void
  /** A provider's snapshot was applied: a bound playback of that provider may have ended. */
  snapshotApplied(provider: PlaybackProviderId): void
  /** The capturing note's source, or null (cached). */
  capturingSource(): Promise<{ noteId: string; hasSource: boolean } | null>
}

export interface OfferHooks {
  settings(): Settings
  feed: FeedView
  /** The renderer's sources branch creates or continues the note (`notes:new-requested`). */
  requestNote(req: SourceNoteRequest): void
  grant(allow: boolean): Promise<void>
  mute(m: SourceMute): Promise<void>
  openSettings(): void
  /** The series key a draft files into (filing.ts), for Next item. */
  seriesKeyOf(draft: SourceDraft): CanonicalKey | null
  /** The extension's course-page facts for an extension playback's tab, when Course pages is on. */
  pageOf(playback: Playback): ExtPage | null
}

interface ActiveCard {
  id: string
  key: CanonicalKey
  playbackId: string
  mode: SourceCardPayload['mode']
  until: number
}

export class SourceOffers {
  private readonly snapshots = new Map<PlaybackProviderId, Playback[]>()
  private readonly tracks = new Map<string, Track>()
  private recent: PlayingItem[] = []
  /** When each key last got a card (12 h rule). */
  private readonly offeredAt = new Map<CanonicalKey, number>()
  private lastCardAt = 0
  private card: ActiveCard | null = null
  private retry: NodeJS.Timeout | null = null
  private active = false

  constructor(
    private readonly ctx: MainContext,
    private readonly hooks: OfferHooks
  ) {}

  // ---------- life cycle ----------

  setActive(on: boolean): void {
    if (on === this.active) return
    this.active = on
    if (on) return
    // Off: memory only, so everything is forgotten.
    if (this.card) this.ctx.notify.hide(this.card.id)
    this.card = null
    this.snapshots.clear()
    this.tracks.clear()
    this.recent = []
    this.offeredAt.clear()
    this.stopRetry()
    this.pushPlaying()
  }

  /** Present playbacks, most recently updated first. */
  current(): Track[] {
    return [...this.tracks.values()].sort((a, b) => b.playback.updatedAt - a.playback.updatedAt)
  }

  track(playbackId: string): Track | null {
    return this.tracks.get(playbackId) ?? null
  }

  playing(): PlayingItem[] {
    return this.active ? this.recent : []
  }

  /** A lookup improved a playback's draft (after Take notes): Recently played follows. */
  updateDraft(playbackId: string, draft: SourceDraft): void {
    const t = this.tracks.get(playbackId)
    if (t) t.draft = draft
    const item = this.recent.find((i) => i.playback.id === playbackId)
    if (item) {
      item.draft = draft
      this.pushPlaying()
    }
  }

  /** The playback was noted (Take notes, Continue, Switch note): it isn't offered again. */
  noted(playbackId: string, noteId: string): void {
    const t = this.tracks.get(playbackId)
    if (t) {
      t.offer = 'done'
      t.noteId = noteId
    }
    const item = this.recent.find((i) => i.playback.id === playbackId)
    if (item) {
      item.noteId = noteId
      this.pushPlaying()
    }
  }

  // ---------- snapshots ----------

  onSnapshot(provider: PlaybackProviderId, playbacks: Playback[]): void {
    if (!this.active) return
    this.snapshots.set(provider, playbacks)
    const present = new Set<string>()
    let recentChanged = false
    for (const p of playbacks) {
      if (p.state === 'ended') continue
      present.add(p.id)
      const t = this.tracks.get(p.id)
      if (!t) {
        this.tracks.set(p.id, { playback: p, draft: null, identifying: false, failedAt: null, identifiedTitle: null, noteId: null, offer: 'none' })
        continue
      }
      if (t.playback.title !== p.title) {
        // A new title is a new item: identify again, offer again.
        t.draft = null
        t.identifiedTitle = null
        t.failedAt = null
        t.offer = 'none'
      }
      t.playback = p
      const item = this.recent.find((i) => i.playback.id === p.id)
      if (item && (item.playback.status !== p.status || item.playback.state !== p.state)) recentChanged = true
      if (item) item.playback = p
    }
    for (const [id, t] of [...this.tracks]) {
      if (t.playback.provider !== provider || present.has(id)) continue
      this.tracks.delete(id)
      const item = this.recent.find((i) => i.playback.id === id)
      if (item) {
        item.playback = { ...item.playback, status: 'stopped', state: 'ended' }
        recentChanged = true
      }
    }
    if (recentChanged) this.pushPlaying()
    // Before any identification: an extension playback that left marks the end for Next item.
    this.hooks.feed.snapshotApplied(provider)
    const now = Date.now()
    for (const t of this.tracks.values()) {
      if (t.playback.state !== 'candidate' || t.draft || t.identifying) continue
      if (t.failedAt !== null && now - t.failedAt < IDENTIFY_RETRY_MS) continue
      void this.identifyLocal(t)
    }
  }

  private async identifyLocal(t: Track): Promise<void> {
    t.identifying = true
    const title = t.playback.title
    let draft: SourceDraft | null = null
    try {
      draft = (await identify(this.ctx, t.playback, { stage: 'local' }))?.draft ?? null
      // The extension's course, section and lesson fields.
      if (draft && t.playback.provider === 'extension') draft = applyPage(draft, this.hooks.pageOf(t.playback))
    } catch (err) {
      log('warn', 'sources:identify-local-failed', { err })
    } finally {
      t.identifying = false
    }
    // Gone, switched off, or a new title arrived meanwhile.
    if (!this.active || this.tracks.get(t.playback.id) !== t || t.playback.title !== title) return
    if (!draft) {
      t.failedAt = Date.now()
      return
    }
    t.draft = draft
    t.identifiedTitle = title
    t.noteId = isGuessKey(draft.canonicalKey) ? null : await this.newestNote(draft.canonicalKey)
    this.remember(t)
    this.hooks.feed.identified(t)
    await this.consider(t)
  }

  private async newestNote(key: CanonicalKey): Promise<string | null> {
    try {
      return (await this.ctx.storage.findNotesBySource(key, { limit: 1 }))[0]?.noteId ?? null
    } catch {
      return null
    }
  }

  private remember(t: Track): void {
    if (!t.draft) return
    const item: PlayingItem = { playback: t.playback, draft: t.draft, noteId: t.noteId }
    this.recent = [item, ...this.recent.filter((i) => i.playback.id !== t.playback.id)].slice(0, SOURCES_LIMITS.recentlyPlayed)
    this.pushPlaying()
  }

  private pushPlaying(): void {
    const items = this.playing()
    for (const wc of this.ctx.windows.targets()) wc.send('sources:playing-changed' satisfies PushChannel, items)
  }

  // ---------- the card ----------

  private muted(t: Track, s: Settings): boolean {
    const mutes = new Set(s['sources.muted'].map((m) => m.toLowerCase()))
    const channel = t.draft?.channel ?? t.playback.artist
    const site = t.draft?.site ?? t.playback.site
    return (!!channel && mutes.has(`channel:${channel.trim().toLowerCase()}`)) || (!!site && mutes.has(`site:${site.trim().toLowerCase()}`))
  }

  private cardShowing(now: number): boolean {
    if (this.card && now > this.card.until) this.clearCard(this.card.id)
    return this.card !== null
  }

  private clearCard(id: string): void {
    if (this.card?.id !== id) return
    if (this.card.mode === 'next') this.hooks.feed.hold(false)
    this.card = null
  }

  /** The gates, then the card. Leaves the track `waiting` while a gate may still open. */
  private async consider(t: Track): Promise<void> {
    const draft = t.draft
    if (!draft || t.offer === 'done' || !this.active) return
    const s = this.hooks.settings()
    const key = draft.canonicalKey
    const now = Date.now()
    const done = (reason: string): void => {
      t.offer = 'done'
      log('debug', 'sources:offer-skipped', { reason })
    }
    if (s['sources.offer'] !== 'ask') return done('offer-off')
    if (t.playback.state === 'muted' || this.muted(t, s)) return done('muted')
    if (this.hooks.feed.busyKeys().has(key)) return done('already-noting')
    if (t.playback.status === 'stopped') return done('stopped')

    // Next item: it started in the same browser within 30 s of the fed note's playback ending.
    const next = this.hooks.feed.nextContext()
    const seriesKey = this.hooks.seriesKeyOf(draft)
    const startedAt = t.playback.seenAt ?? now - t.playback.playedMs
    const isNext =
      next !== null &&
      seriesKey !== null &&
      seriesKey === next.seriesKey &&
      next.browser === t.playback.browser &&
      startedAt >= next.endedAt - NEXT_SLACK_MS &&
      startedAt - next.endedAt <= SOURCES_LIMITS.nextItemWindowMs

    t.offer = 'waiting'
    if (!isNext && now - (this.offeredAt.get(key) ?? 0) < SOURCES_LIMITS.cardPerKeyMs) return done('per-key')
    if (this.ctx.ui.inOnboarding()) return this.armRetry()
    if (this.cardShowing(now)) return this.armRetry()
    if (!isNext && now - this.lastCardAt < SOURCES_LIMITS.cardGapMs) return this.armRetry()
    if (await this.meetingCapturing()) return this.armRetry()
    if (this.card || t.offer !== 'waiting' || !this.active) return

    const matches = isGuessKey(key) || isNext ? [] : await this.ctx.storage.findNotesBySource(key, { limit: 1 }).catch(() => [])
    if (this.card || t.offer !== 'waiting' || !this.active) return
    const match = matches[0] ?? null
    const mode: SourceCardPayload['mode'] = isNext ? 'next' : match ? 'continue' : 'offer'
    const payload: SourceCardPayload = {
      mode,
      title: draft.title,
      channel: draft.channel,
      site: draft.site,
      guess: draft.confidence === 'guess',
      noteTitle: match ? match.title || 'Untitled note' : null,
      lastPositionMs: match?.lastPositionMs ?? null,
      firstUse: !s['sources.grantAsked']
    }
    t.offer = 'done'
    this.show(t, payload, match?.noteId ?? null, now)
  }

  private show(t: Track, payload: SourceCardPayload, matchId: string | null, now: number): void {
    const draft = t.draft as SourceDraft
    const lesson = draft.kind === 'lesson'
    const question =
      payload.mode === 'next'
        ? lesson
          ? 'Switch to the next lesson?'
          : 'Switch to the next video?'
        : payload.mode === 'continue'
          ? 'Continue your notes?'
          : lesson
            ? 'Take notes on this lesson?'
            : 'Take notes on this video?'
    const playbackId = t.playback.id
    const key = draft.canonicalKey
    let id = ''
    id = this.ctx.notify.show({
      variant: 'source-detected',
      title: question,
      body: '',
      source: payload,
      showDelayMs: 0,
      hideAfterMs: SOURCES_LIMITS.cardLifetimeMs,
      // A capturing source note must not silence its own Next item.
      quietWhileRecording: false,
      allowDuringOnboarding: false,
      lastMomentCheck: async () => {
        const ok = await this.lastMomentCheck(playbackId, key)
        if (!ok) {
          this.clearCard(id)
          return false
        }
        const at = Date.now()
        this.lastCardAt = at
        this.offeredAt.set(key, at)
        this.pruneOffered(at)
        return true
      },
      onAction: (action) => this.onAction(id, action, { playbackId, draft, matchId })
    })
    this.card = { id, key, playbackId, mode: payload.mode, until: now + SOURCES_LIMITS.cardLifetimeMs + CARD_GRACE_MS }
    if (payload.mode === 'next') this.hooks.feed.hold(true)
    log('info', 'sources:card-queued', { mode: payload.mode, confidence: draft.confidence, firstUse: payload.firstUse })
  }

  /** The playback still plays (or is paused), and no meeting note started capturing. */
  private async lastMomentCheck(playbackId: string, key: CanonicalKey): Promise<boolean> {
    if (!this.active || this.ctx.ui.inOnboarding()) return false
    const t = this.tracks.get(playbackId)
    if (!t || t.playback.status === 'stopped' || t.draft?.canonicalKey !== key) return false
    if (this.hooks.settings()['sources.offer'] !== 'ask') return false
    return !(await this.meetingCapturing())
  }

  private async meetingCapturing(): Promise<boolean> {
    const c = await this.hooks.feed.capturingSource()
    return c !== null && !c.hasSource
  }

  private pruneOffered(now: number): void {
    for (const [k, at] of this.offeredAt) if (now - at >= SOURCES_LIMITS.cardPerKeyMs) this.offeredAt.delete(k)
  }

  private onAction(cardId: string, action: NotificationAction, c: { playbackId: string; draft: SourceDraft; matchId: string | null }): void {
    if (!action.startsWith('source:')) return
    const a = action.slice('source:'.length) as SourceCardAction
    log('info', 'sources:card-action', { action: a })
    // Every action except the first-use answer dismisses the card (notify hides it).
    this.clearCard(cardId)
    const { playbackId, draft, matchId } = c
    switch (a) {
      case 'take-notes':
      case 'new-note':
        this.hooks.requestNote({ draft, playbackId, mode: 'new', noteId: null })
        break
      case 'continue':
        // Never for a guess key: the card offered Take notes for it.
        this.hooks.requestNote({ draft, playbackId, mode: matchId && !isGuessKey(draft.canonicalKey) ? 'continue' : 'new', noteId: matchId })
        break
      case 'switch-note':
        void this.switchNote(draft, playbackId)
        break
      case 'keep-note':
      case 'skip':
        break
      case 'allow':
      case 'not-now':
        void this.hooks.grant(a === 'allow').catch((err: unknown) => log('warn', 'sources:grant-failed', { err }))
        break
      case 'mute-channel':
        if (draft.channel) void this.hooks.mute(`channel:${draft.channel.trim()}`).catch((err: unknown) => log('warn', 'sources:mute-failed', { err }))
        break
      case 'mute-site':
        if (draft.site) void this.hooks.mute(`site:${draft.site.trim().toLowerCase()}`).catch((err: unknown) => log('warn', 'sources:mute-failed', { err }))
        break
      case 'settings':
        this.hooks.openSettings()
        break
    }
  }

  /** Next item: continue that item's note when one exists (exact or high key), else a new one. */
  private async switchNote(draft: SourceDraft, playbackId: string): Promise<void> {
    const noteId = isGuessKey(draft.canonicalKey) ? null : await this.newestNote(draft.canonicalKey)
    this.hooks.requestNote({ draft, playbackId, mode: noteId ? 'continue' : 'new', noteId })
  }

  // ---------- retries ----------

  private armRetry(): void {
    if (this.retry) return
    this.retry = setTimeout(() => {
      this.retry = null
      let waiting = false
      for (const t of this.tracks.values()) {
        if (t.offer !== 'waiting') continue
        waiting = true
        void this.consider(t)
      }
      if (!waiting) this.stopRetry()
    }, RETRY_MS)
    this.retry.unref()
  }

  private stopRetry(): void {
    if (this.retry) clearTimeout(this.retry)
    this.retry = null
  }
}
