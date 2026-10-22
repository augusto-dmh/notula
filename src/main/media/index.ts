// SPDX-License-Identifier: Apache-2.0
// registerMedia(): the passive playback provider of content sources (Windows).
//
// It owns the `notula-media` utility process with one hidden PowerShell reader
// (`resources/media/session.ps1`, media sessions plus on-demand tab-strip and address-bar reads),
// its restart policy and status, and the pure eligibility / ad-guard / span / binding state
// machine (`machine.ts`). It publishes bus `media:sessions` (raw, every change) and
// `sources:playback` with provider `media-session`. It runs only while `sources.enabled` and
// `sources.detect` are on, and skips browsers the extension provider covers (bus
// `media:extension`).
//
// - Window first: when a playback passes the debounce, its tab is read once (InPrivate or not,
//   site, the address bar if the tab is selected) before it can become a candidate's draft.
// - `mediaFeed` is the seam for the sources core: bind a note to a playback, read the
//   position feed, receive watched spans and binding changes. Nothing here stores anything.
// - Startup sweeps History copies a crash may have left (identify.ts), whatever the settings.

import type { BrowserId, CanonicalKey, DetectorStatus, MediaSession, Playback, SourcePosition } from '@shared/types/sources'
import { SOURCES_LIMITS } from '@shared/types/sources'
import { parseSourceUrl } from '@shared/lib/source-key'
import type { MainContext } from '../context'
import { log } from '../log'
import { sweepHistoryCopies } from '../sources/identify'
import { mediaReader } from './host'
import { locateTab } from './locate'
import {
  bindingOf,
  createMachine,
  feedSample,
  needsTicks,
  snapshot,
  step,
  type BindingState,
  type MachineEffect,
  type MachineInput,
  type MediaMachine,
  type SpanRecord
} from './machine'

const TICK_MS = 1_000

type SpanListener = (e: { noteId: string; span: SpanRecord }) => void
type BindingListener = (e: { noteId: string; state: BindingState; playbackId: string | null }) => void

let machine: MediaMachine = newMachine()
let ctxRef: MainContext | null = null
let tickTimer: NodeJS.Timeout | null = null
let lastSessions: MediaSession[] = []
let lastPlaybacks: Playback[] = []
let covered = new Set<BrowserId>()
let running = false
const spanListeners = new Set<SpanListener>()
const bindingListeners = new Set<BindingListener>()

function newMachine(): MediaMachine {
  return createMachine({
    debounceMs: SOURCES_LIMITS.debounceMs,
    eligiblePlayedMs: SOURCES_LIMITS.eligiblePlayedMs,
    minDurationMs: SOURCES_LIMITS.minDurationMs,
    spanMergeMs: SOURCES_LIMITS.spanMergeMs
  })
}

function publish(): void {
  const ctx = ctxRef
  if (!ctx) return
  lastPlaybacks = snapshot(machine, Date.now())
  ctx.bus.emit('sources:playback', { provider: 'media-session', playbacks: lastPlaybacks })
}

function apply(input: MachineInput): void {
  const effects = step(machine, input, Date.now())
  handle(effects)
  scheduleTicks()
}

function handle(effects: MachineEffect[]): void {
  let changed = false
  for (const e of effects) {
    switch (e.type) {
      case 'changed':
        changed = true
        break
      case 'locate':
        void readWindow(e.playbackId, e.browser, e.title)
        break
      case 'candidate':
        log('debug', 'media:candidate', {})
        break
      case 'ended':
        log('debug', 'media:ended', { reason: e.reason })
        break
      case 'span':
        for (const l of spanListeners) l({ noteId: e.noteId, span: e.span })
        break
      case 'binding':
        log('info', 'media:binding', { state: e.state })
        for (const l of bindingListeners) l({ noteId: e.noteId, state: e.state, playbackId: e.playbackId })
        break
    }
  }
  if (changed) publish()
}

/** Window first: InPrivate or not, the site, the selected tab's address. */
async function readWindow(playbackId: string, browser: BrowserId, title: string): Promise<void> {
  const tab = await locateTab(browser, title, true).catch(() => null)
  if (!running) return
  const parsed = tab?.url ? parseSourceUrl(tab.url) : null
  apply({
    type: 'window',
    playbackId,
    privateWindow: tab ? tab.privateWindow : 'unknown',
    site: tab?.site ?? null,
    url: parsed?.url ?? null,
    short: parsed?.short ?? false
  })
}

function scheduleTicks(): void {
  const want = running && (needsTicks(machine) || machine.binding !== null)
  if (want && !tickTimer) {
    tickTimer = setInterval(() => apply({ type: 'tick' }), TICK_MS)
    tickTimer.unref()
  } else if (!want && tickTimer) {
    clearInterval(tickTimer)
    tickTimer = null
  }
}

function onSessions(sessions: MediaSession[]): void {
  const ctx = ctxRef
  if (!ctx || !running) return
  const previous = lastSessions
  lastSessions = sessions
  ctx.bus.emit('media:sessions', { sessions, previous })
  // Browsers the extension covers skip the passive pipeline.
  apply({ type: 'sessions', sessions: sessions.filter((s) => !covered.has(s.browser)) })
}

async function reconcile(ctx: MainContext): Promise<void> {
  const want = process.platform === 'win32' && (await ctx.settings.get('sources.enabled')) && (await ctx.settings.get('sources.detect'))
  if (want === running) return
  running = want
  if (want) {
    apply({ type: 'mutes', mutes: await ctx.settings.get('sources.muted') })
    mediaReader.start()
    return
  }
  mediaReader.stop()
  // Off: forget every playback (memory only), close an open span, publish the empty snapshot.
  handle(step(machine, { type: 'unbind' }, Date.now()))
  machine = newMachine()
  lastSessions = []
  scheduleTicks()
  publish()
}

export function registerMedia(ctx: MainContext): void {
  ctxRef = ctx
  void sweepHistoryCopies(ctx)
  if (process.platform !== 'win32') return
  mediaReader.onSessions(onSessions)
  ctx.bus.on('settings:changed', ({ keys, settings }) => {
    if (keys.includes('sources.enabled') || keys.includes('sources.detect')) {
      void reconcile(ctx).catch((err: unknown) => log('error', 'media:reconcile-failed', { err }))
    }
    if (keys.includes('sources.muted') && running) apply({ type: 'mutes', mutes: settings['sources.muted'] })
  })
  ctx.bus.on('media:extension', (snap) => {
    const next = new Set(snap.covered.filter((b): b is BrowserId => b === 'edge' || b === 'chrome' || b === 'brave'))
    const added = [...next].filter((b) => !covered.has(b))
    covered = next
    if (added.length && running) apply({ type: 'drop', browsers: added })
  })
  void reconcile(ctx).catch((err: unknown) => log('error', 'media:reconcile-failed', { err }))
}

// ---------- the seam for the sources core ----------

/** The detector row of `sources:get-status`. */
export function detectorStatus(): DetectorStatus {
  return mediaReader.status()
}

export function onDetectorStatus(l: (s: DetectorStatus) => void): () => void {
  return mediaReader.onStatus(l)
}

/**
 * The position feed, spans and binding. The sources core binds the note it opened
 * from a playback, reads `sample()` about once a second for `sources:position`, stores the spans
 * it receives, and binds again after re-identifying a new title with the same key.
 */
export const mediaFeed = {
  /** The last published snapshot (most recently changed first). */
  playbacks(): Playback[] {
    return lastPlaybacks
  },
  bind(noteId: string, canonicalKey: CanonicalKey, playbackId: string): void {
    apply({ type: 'bind', noteId, canonicalKey, playbackId })
  },
  unbind(): void {
    apply({ type: 'unbind' })
  },
  /** A Next item card is waiting: stop stamping until it is answered. */
  hold(on: boolean): void {
    apply({ type: 'hold', on })
  },
  binding(): ReturnType<typeof bindingOf> {
    return bindingOf(machine)
  },
  sample(): SourcePosition | null {
    return feedSample(machine, Date.now())
  },
  onSpan(l: SpanListener): () => void {
    spanListeners.add(l)
    return () => spanListeners.delete(l)
  },
  onBinding(l: BindingListener): () => void {
    bindingListeners.add(l)
    return () => bindingListeners.delete(l)
  }
}
