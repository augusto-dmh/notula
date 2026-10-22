// SPDX-License-Identifier: Apache-2.0
// Speaker attribution in main.
//
// - Detectors: one per app (Zoom, Teams, Meet in Chrome), each behind its switch
//   (`attribution.zoom|teams|meet`, off by default). A detector runs while its switch is on
//   and its app is in the meeting-app list (bus `meetings:mic-apps`); only the first to start
//   owns attribution. Windows only for now; macOS shows "Coming later".
// - Readers: main forks `notula-uia` while a detector runs; it runs the PowerShell UIA reader
//   (resources/uia/attribution.ps1) and relays its JSON records. Restarts, `failed` and
//   `unavailable` come from the worker.
// - Records → events: self tiles are excluded; the record's speaker becomes an event
//   with the app's detection lag; the user speaking (`selfActive`, or their name)
//   clears instead. A speaker inferred from the lit tiles, when no tile is unnamed, is kept
//   only as the chunk fallback.
// - Stamping: final system chunks get `detectedSpeaker`, `detected_speaker_name` and word
//   `att` from the timeline, through the session's `SystemAttribution` hook.
// - Health: blind after 10 s without a record that sees tiles; a health line every 30 s,
//   local log only. Names stay on local chunks.

import { join, basename, dirname } from 'node:path'
import { app, utilityProcess, type UtilityProcess } from 'electron'
import type { PushChannel } from '@shared/ipc'
import type { MicApp } from '@shared/types/meetings'
import { DEFAULT_SETTINGS, type Settings } from '@shared/types/settings'
import {
  ATTRIBUTION_LIMITS,
  DEFAULT_MEET_SELECTORS,
  type AttributionApp,
  type AttributionAppStatus,
  type AttributionSource,
  type AttributionState,
  type AttributionStatus,
  type ProviderWord,
  type TranscriptChunk
} from '@shared/types/transcript'
import type { MainContext } from '../context'
import { resourcePath } from '../lifecycle/resources'
import { log } from '../log'
import type { SystemAttribution } from '../transcription/session'
import type { MainToUia, UiaReaderState, UiaToMain } from '../uia/protocol'
import { SpeakerTimeline, type Winner } from './timeline'

const APPS: readonly AttributionApp[] = ['zoom', 'teams', 'meet']
const SOURCE: Record<AttributionApp, AttributionSource> = { zoom: 'zoom-uia', teams: 'teams-uia', meet: 'meet-uia' }
/** Windows defaults (ms between someone starting to speak and the tile lighting). */
const LAG_WINDOWS: Record<AttributionApp, number> = { zoom: 1_400, teams: 900, meet: 500 }
const ROSTER: Record<AttributionApp, string> = {
  zoom: 'zoom-roster',
  teams: 'teams-roster',
  meet: 'meet-roster'
}
const MEET_PWA = '.app.kjgfgldnnfoeklkmfkjfagphfepbbdan'
/** The meeting-app ids that start each detector. */
function appMatches(app: AttributionApp, appId: string): boolean {
  switch (app) {
    case 'zoom':
      return appId === 'us.zoom.xos'
    case 'teams':
      return appId === 'com.microsoft.teams2'
    case 'meet':
      return (
        appId === 'com.google.Chrome' ||
        appId === 'com.google.Chrome.beta' ||
        appId === 'company.thebrowser.dia' ||
        appId.endsWith(MEET_PWA)
      )
  }
}
const SETTING: Record<AttributionApp, 'attribution.zoom' | 'attribution.teams' | 'attribution.meet'> = {
  zoom: 'attribution.zoom',
  teams: 'attribution.teams',
  meet: 'attribution.meet'
}
const UTILITY_IDLE_MS = 3_000
const BLIND_CHECK_MS = 1_000

interface Detector {
  app: AttributionApp
  state: AttributionState
  detail: string | null
  /** The worker's view of the reader; null while none was started. */
  reader: UiaReaderState | null
  /** Sticky until the switch is turned off and on again, or the app leaves the list. */
  stuck: 'failed' | 'unavailable' | null
  eventsReceived: number
  speakers: Set<string>
  /** The last record that saw tiles (ms). */
  lastSeenTilesAt: number
  /** The detector's "current speaker", the chunk fallback. */
  fallback: { id: string; name: string; at: number } | null
  /** Zoom's revealed self name. */
  selfName: string | null
  lastSpeaker: string | null
}

function norm(name: string | null | undefined): string {
  return (name ?? '').replace(/\s*\((you|me)\)\s*$/i, '').trim().toLowerCase()
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

/**
 * Dev builds only: `NOTULA_DEV_MIC_APPS` (comma-separated app ids) counts as apps in the
 * meeting-app list, so a reader can be checked against a test window that holds no microphone.
 */
function devMicApps(): MicApp[] {
  if (app.isPackaged) return []
  const raw = process.env['NOTULA_DEV_MIC_APPS']?.trim()
  if (!raw) return []
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((appId) => ({ appId, name: appId }))
}

/** out/main/uia.js, from the main bundle (or a shared chunk next to it). */
function uiaWorkerPath(): string {
  const here = basename(__dirname) === 'chunks' ? dirname(__dirname) : __dirname
  return join(here, 'uia.js')
}

export class AttributionService implements SystemAttribution {
  private settings: Settings = structuredClone(DEFAULT_SETTINGS)
  private micApps: MicApp[] = []
  private readonly detectors: Record<AttributionApp, Detector>
  private owner: AttributionApp | null = null
  private readonly timeline = new SpeakerTimeline()
  private proc: UtilityProcess | null = null
  private idleTimer: NodeJS.Timeout | null = null
  private lastHealthAt = 0
  private started = false
  private readonly supported = process.platform === 'win32'

  constructor(private readonly ctx: MainContext) {
    const d = (app: AttributionApp): Detector => ({
      app,
      state: 'off',
      detail: null,
      reader: null,
      stuck: null,
      eventsReceived: 0,
      speakers: new Set(),
      lastSeenTilesAt: 0,
      fallback: null,
      selfName: null,
      lastSpeaker: null
    })
    this.detectors = { zoom: d('zoom'), teams: d('teams'), meet: d('meet') }
  }

  /** Called once by registerSpeakerTags. */
  start(): void {
    if (this.started) return
    this.started = true
    const load = (): void => {
      void this.ctx.settings
        .getAll()
        .then((s) => this.applySettings(s, []))
        .catch((err: unknown) => log('warn', 'attribution:settings-unavailable', { err }))
    }
    this.ctx.bus.on('storage:status', (s) => {
      if (s.state === 'ready') load()
    })
    load()
    this.ctx.bus.on('settings:changed', ({ keys, settings }) => this.applySettings(settings, keys))
    this.ctx.bus.on('meetings:mic-apps', ({ apps }) => {
      const before = this.micApps
      this.micApps = [...apps, ...devMicApps().filter((d) => !apps.some((a) => a.appId === d.appId))]
      // An app that left the list may retry after a failure when it comes back.
      for (const app of APPS) {
        const was = before.some((a) => appMatches(app, a.appId))
        const is = apps.some((a) => appMatches(app, a.appId))
        if (was && !is && this.detectors[app].stuck === 'failed') this.detectors[app].stuck = null
      }
      this.reconcile('mic-apps')
    })
    setInterval(() => this.tick(), BLIND_CHECK_MS).unref()
    this.devStampProbe()
    if (devMicApps().length) {
      this.micApps = devMicApps()
      log('info', 'attribution:dev-mic-apps', { apps: this.micApps.map((a) => a.appId).join(',') })
    }
    this.ctx.bus.on('capture:stopped', ({ noteId }) => void this.logSessionSummary(noteId))
  }

  private applySettings(next: Settings, keys: string[]): void {
    const prev = this.settings
    this.settings = next
    for (const app of APPS) {
      const turnedOn = !prev[SETTING[app]] && next[SETTING[app]]
      if (turnedOn) this.detectors[app].stuck = null
    }
    const readerArgsChanged =
      keys.includes('profile.name') ||
      (keys.includes('attribution.meetSelectors') && JSON.stringify(prev['attribution.meetSelectors']) !== JSON.stringify(next['attribution.meetSelectors']))
    if (readerArgsChanged && this.owner) {
      // The running reader gets the new self name or selectors with a restart.
      const app = this.owner
      this.stopReader(app)
      this.owner = null
      this.timeline.clearAll()
    }
    this.reconcile('settings')
  }

  // ---------- detector lifecycle ----------

  private reconcile(why: string): void {
    if (!this.supported) {
      this.publishIfChanged(() => {
        for (const app of APPS) {
          const d = this.detectors[app]
          d.state = 'off'
          d.detail = 'Coming later on macOS'
        }
      })
      return
    }
    const eligible = (app: AttributionApp): boolean =>
      this.settings[SETTING[app]] === true &&
      this.detectors[app].stuck === null &&
      this.micApps.some((a) => appMatches(app, a.appId))
    // The owner stops when its switch goes off or its app leaves the list.
    if (this.owner && !eligible(this.owner)) {
      const app = this.owner
      log('info', 'attribution:detector-stop', { app, why })
      this.stopReader(app)
      this.owner = null
      this.timeline.clearAll()
    }
    // The first eligible app, in meeting-app list order, owns attribution.
    if (!this.owner) {
      for (const mic of this.micApps) {
        const app = APPS.find((a) => appMatches(a, mic.appId) && eligible(a))
        if (!app) continue
        this.owner = app
        log('info', 'attribution:detector-start', { app, why })
        this.startReader(app)
        break
      }
    }
    this.publishIfChanged(() => {
      for (const app of APPS) {
        const d = this.detectors[app]
        if (!this.settings[SETTING[app]]) {
          d.state = 'off'
          d.detail = null
        } else if (d.stuck) {
          d.state = d.stuck
          d.detail = d.stuck === 'unavailable' ? 'Not available on this PC' : 'Stopped after repeated errors'
        } else if (app === this.owner) {
          if (d.state !== 'active' && d.state !== 'blind') {
            d.state = 'blind'
            d.detail = 'Looking for the meeting window'
          }
        } else if (this.owner && this.micApps.some((a) => appMatches(app, a.appId))) {
          d.state = 'waiting'
          d.detail = 'Another meeting app is being read'
        } else {
          d.state = 'waiting'
          d.detail = null
        }
      }
    })
    if (!this.owner) this.scheduleIdle()
  }

  private startReader(app: AttributionApp): void {
    const d = this.detectors[app]
    d.reader = null
    d.lastSeenTilesAt = 0
    d.fallback = null
    d.lastSpeaker = null
    const proc = this.ensureProc()
    if (!proc) {
      d.stuck = 'failed'
      this.owner = null
      return
    }
    const selectors = app === 'meet' ? (this.settings['attribution.meetSelectors'] ?? DEFAULT_MEET_SELECTORS) : {}
    const msg: MainToUia = {
      type: 'start',
      app,
      args: {
        scriptPath: resourcePath('uia/attribution.ps1'),
        intervalMs: ATTRIBUTION_LIMITS.pollMs[app],
        selectorsB64: Buffer.from(JSON.stringify(selectors), 'utf8').toString('base64'),
        selfNameB64: Buffer.from(this.settings['profile.name'] ?? '', 'utf8').toString('base64')
      }
    }
    proc.postMessage(msg)
  }

  private stopReader(app: AttributionApp): void {
    const d = this.detectors[app]
    d.fallback = null
    if (d.lastSpeaker !== null) this.pushActiveSpeaker(null)
    d.lastSpeaker = null
    this.proc?.postMessage({ type: 'stop', app } satisfies MainToUia)
  }

  private ensureProc(): UtilityProcess | null {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
    if (this.proc) return this.proc
    try {
      const proc = utilityProcess.fork(uiaWorkerPath(), [], { serviceName: 'notula-uia' })
      this.proc = proc
      proc.on('message', (m: UiaToMain) => this.onWorker(m))
      proc.once('exit', (code: number) => {
        if (this.proc !== proc) return
        this.proc = null
        if (this.owner) {
          // The worker died under a running reader: one restart, as a reader restart would.
          log('warn', 'attribution:worker-exited', { code, owner: this.owner })
          const app = this.owner
          this.owner = null
          this.timeline.clearAll()
          this.detectors[app].state = 'blind'
          setTimeout(() => this.reconcile('worker-exit'), ATTRIBUTION_LIMITS.restartDelayMs).unref()
        }
      })
      proc.once('spawn', () => log('info', 'attribution:worker-forked', { pid: proc.pid ?? 0 }))
      return proc
    } catch (err) {
      log('error', 'attribution:worker-fork-failed', { err })
      return null
    }
  }

  /** No reader for a few seconds: the worker goes (its PowerShell children exit with it). */
  private scheduleIdle(): void {
    if (!this.proc || this.idleTimer) return
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      if (this.owner || !this.proc) return
      const proc = this.proc
      this.proc = null
      try {
        proc.kill()
      } catch {
        // Already gone.
      }
      log('info', 'attribution:worker-stopped', {})
    }, UTILITY_IDLE_MS)
  }

  private onWorker(m: UiaToMain): void {
    if (!m || typeof m !== 'object') return
    switch (m.type) {
      case 'log':
        log(m.level, m.event, m.data)
        return
      case 'state':
        this.onReaderState(m.app, m.state, m.detail)
        return
      case 'record':
        if (m.app === this.owner) this.onRecord(m.app, m.record)
        return
    }
  }

  private onReaderState(app: AttributionApp, state: UiaReaderState, detail: string | null): void {
    const d = this.detectors[app]
    d.reader = state
    if (state === 'failed' || state === 'unavailable') {
      // After 5 failed restarts the detector stops; the transcript is unaffected.
      log('warn', state === 'failed' ? 'attribution:detector-giving-up' : 'attribution:detector-unavailable', { app, detail })
      d.stuck = state
      if (this.owner === app) {
        this.owner = null
        this.timeline.clearAll()
        if (d.lastSpeaker !== null) this.pushActiveSpeaker(null)
        d.lastSpeaker = null
      }
      this.reconcile(`reader-${state}`)
      return
    }
    if (state === 'restarting') {
      this.publishIfChanged(() => {
        d.state = 'blind'
        d.detail = 'Restarting the reader'
      })
    }
  }

  // ---------- records ----------

  private isSelf(d: Detector, name: string | null): boolean {
    const n = norm(name)
    if (!n) return false
    return n === norm(this.settings['profile.name']) || (d.selfName !== null && n === norm(d.selfName))
  }

  private onRecord(app: AttributionApp, r: Record<string, unknown>): void {
    const d = this.detectors[app]
    const event = r['event']
    if (event === `${app === 'meet' ? 'meet' : app}-speaker-monitor-version`) {
      log('info', 'attribution:app-version', { app, version: str(r['zoomVersion']) ?? str(r['teamsVersion']) ?? '' })
      return
    }
    if (event === 'reader-error') {
      log('debug', 'attribution:reader-error', { app, message: str(r['message']) ?? '' })
      return
    }
    if (event !== ROSTER[app]) return
    const now = Date.now()
    const ts = typeof r['timestamp'] === 'number' && Number.isFinite(r['timestamp']) ? (r['timestamp'] as number) : now
    // Zoom reveals the user's own name.
    const selfDisplay = app === 'zoom' ? str(r['ownName']) : null
    if (selfDisplay && selfDisplay !== d.selfName) {
      if (d.selfName) log('info', 'attribution:zoom-self-name-upgraded', {})
      d.selfName = selfDisplay
    }
    const parts = (Array.isArray(r['participants']) ? r['participants'] : []).filter(
      (p): p is Record<string, unknown> => !!p && typeof p === 'object'
    )
    const windowPresent = r['hasMeetingWindow'] !== false
    const tiles = parts.filter((p) => p['isSelf'] !== true && !this.isSelf(d, str(p['name'])))
    if (tiles.length && windowPresent) d.lastSeenTilesAt = now
    // The lit-tile speaker is kept for the fallback, only when no tile is unnamed.
    const unnamed = tiles.some((p) => !str(p['name']))
    const lit = tiles.filter((p) => p['active'] === true && str(p['name']))
    const litName = str(lit[0]?.['name'])
    d.fallback = !unnamed && litName ? { id: litName, name: litName, at: now } : null

    const speaker = windowPresent ? str(r['participantName']) : null
    const selfActive = r['selfActive'] === true || (speaker !== null && this.isSelf(d, speaker))
    if (!speaker || selfActive) {
      if (selfActive) log('debug', 'attribution:active-speaker-self-filtered-by-id', { app })
      if (this.timeline.clear(ts)) {
        log('debug', 'attribution:active-speaker-cleared', { app })
        this.pushActiveSpeaker(null)
      }
      d.lastSpeaker = null
      this.refreshState(d, now)
      return
    }
    const change = this.timeline.speaker(speaker, speaker, SOURCE[app], ts, LAG_WINDOWS[app])
    d.eventsReceived++
    d.speakers.add(speaker)
    if (change === 'changed') log('debug', 'attribution:active-speaker-changed', { app, speakers: d.speakers.size })
    d.lastSpeaker = speaker
    // Every accepted non-self event, a refresh included, is pushed.
    this.pushActiveSpeaker(speaker)
    this.refreshState(d, now)
  }

  private refreshState(d: Detector, now: number): void {
    if (d.app !== this.owner) return
    const seeing = now - d.lastSeenTilesAt <= ATTRIBUTION_LIMITS.fallbackFreshMs
    this.publishIfChanged(() => {
      d.state = seeing ? 'active' : 'blind'
      d.detail = seeing ? null : 'Looking for the meeting window'
    })
  }

  private pushActiveSpeaker(participantName: string | null): void {
    const noteId = this.ctx.capture.currentNoteId()
    if (!noteId) return
    for (const wc of this.ctx.windows.targets()) {
      wc.send('attribution:active-speaker' satisfies PushChannel, { noteId, participantName })
    }
  }

  /** Blindness (no tiles for 10 s) and the 30 s health line (local only). */
  private tick(): void {
    const app = this.owner
    if (!app) return
    const d = this.detectors[app]
    const now = Date.now()
    this.refreshState(d, now)
    if (now - this.lastHealthAt >= ATTRIBUTION_LIMITS.healthLogMs) {
      this.lastHealthAt = now
      log('info', 'attribution:health', {
        app,
        state: d.state,
        events: d.eventsReceived,
        speakers: d.speakers.size,
        blind: d.state === 'blind',
        timeline: this.timeline.size
      })
    }
  }

  // ---------- status ----------

  status(): AttributionStatus {
    return {
      supported: this.supported,
      apps: APPS.map(
        (app): AttributionAppStatus => ({
          app,
          enabled: this.settings[SETTING[app]] === true,
          state: this.detectors[app].state,
          speakerEventCount: this.detectors[app].eventsReceived,
          uniqueSpeakers: this.detectors[app].speakers.size,
          detail: this.detectors[app].detail
        })
      )
    }
  }

  private lastPublished = ''

  private publishIfChanged(mutate: () => void): void {
    mutate()
    const s = this.status()
    // Counters change on every event; the push carries state changes only.
    const key = JSON.stringify(s.apps.map((a) => [a.app, a.enabled, a.state, a.detail]))
    if (key === this.lastPublished) return
    this.lastPublished = key
    for (const wc of this.ctx.windows.targets()) wc.send('attribution:status-changed' satisfies PushChannel, s)
  }

  // ---------- stamping ----------

  /** Some attribution source is on: a detector owns attribution and its reader runs. */
  active(): boolean {
    const app = this.owner
    if (!app) return false
    const s = this.detectors[app].state
    return s === 'active' || s === 'blind'
  }

  stamp(chunk: TranscriptChunk): TranscriptChunk {
    const app = this.owner
    if (!app || !this.active() || chunk.source !== 'system' || !chunk.is_final) return chunk
    const now = Date.now()
    const start = Date.parse(chunk.start_timestamp)
    const end = Date.parse(chunk.end_timestamp)
    if (!Number.isFinite(start) || !Number.isFinite(end)) return chunk
    let winner: Winner | null = this.timeline.chunkSpeaker(start, end, now)
    if (!winner) {
      const f = this.detectors[app].fallback
      if (f && now - f.at <= ATTRIBUTION_LIMITS.fallbackFreshMs) winner = { participantId: f.id, participantName: f.name, source: SOURCE[app] }
    }
    const details = chunk.providerDetails
    let words: ProviderWord[] | undefined = details?.words
    if (details && words?.length) {
      const anchor = details.wallClockAnchorMs
      const atts = this.timeline.wordSpeakers(
        words.map((w) => ({ startMs: anchor + w.s_ms, endMs: anchor + w.e_ms })),
        start,
        end,
        now
      )
      words = words.map((w, i) => {
        const { att: _old, ...rest } = w
        const att = atts[i]
        return att ? { ...rest, att } : rest
      })
    }
    return {
      ...chunk,
      detected_speaker_name: winner?.participantName ?? null,
      detectedSpeaker: winner
        ? { participantId: winner.participantId, participantName: winner.participantName, source: winner.source }
        : null,
      ...(details && words ? { providerDetails: { ...details, words } } : {})
    }
  }

  /**
   * Dev builds only (`NOTULA_DEV_ATTRIBUTION_PROBE=1`): every 3 s while a detector runs, stamps a
   * synthetic final system chunk covering the last 2 s (three words) with the live timeline and
   * logs the result, so stamping can be checked without playing any audio.
   */
  private devStampProbe(): void {
    if (app.isPackaged || process.env['NOTULA_DEV_ATTRIBUTION_PROBE'] !== '1') return
    setInterval(() => {
      if (!this.active()) return
      const end = Date.now() - 500
      const start = end - 2_000
      const chunk: TranscriptChunk = {
        id: 'probe',
        document_id: 'probe',
        workspace_id: '',
        owner_id: '',
        transcription_session_id: 'probe',
        source: 'system',
        start_timestamp: new Date(start).toISOString(),
        end_timestamp: new Date(end).toISOString(),
        text: 'one two three',
        is_final: true,
        detected_speaker_name: null,
        detectedSpeaker: null,
        providerDetails: {
          words: [
            { w: 'one', s_ms: 0, e_ms: 600, conf: 1 },
            { w: 'two', s_ms: 700, e_ms: 1_300, conf: 1 },
            { w: 'three', s_ms: 1_400, e_ms: 2_000, conf: 1 }
          ],
          provider: 'local',
          model: 'probe',
          wallClockAnchorMs: start
        }
      }
      const s = this.stamp(chunk)
      log('info', 'attribution:probe-stamp', {
        name: s.detected_speaker_name ?? '',
        source: s.detectedSpeaker?.source ?? '',
        words: (s.providerDetails?.words ?? []).map((w) => w.att ?? '-').join(',')
      })
    }, 3_000).unref()
  }

  /** The end-of-meeting attribution summary, a local log line only. */
  private async logSessionSummary(noteId: string): Promise<void> {
    if (!APPS.some((a) => this.settings[SETTING[a]])) return
    try {
      const chunks = (await this.ctx.storage.getTranscript(noteId)).filter((c) => c.is_final)
      const system = chunks.filter((c) => c.source === 'system')
      const systemChars = system.reduce((n, c) => n + c.text.length, 0)
      const attributedChars = system.filter((c) => c.detected_speaker_name).reduce((n, c) => n + c.text.length, 0)
      const totalChars = chunks.reduce((n, c) => n + c.text.length, 0)
      const ratio = systemChars ? attributedChars / systemChars : 0
      const sources = new Set(system.map((c) => c.detectedSpeaker?.source).filter(Boolean))
      const level = totalChars === 0 ? 'unknown' : ratio >= ATTRIBUTION_LIMITS.fullAttribution ? 'full' : attributedChars > 0 ? 'partial' : 'none'
      log('info', 'attribution:session-summary', {
        noteId,
        level,
        ratio: Math.round(ratio * 100) / 100,
        systemChars,
        attributedChars,
        source: sources.size > 1 ? 'mixed' : ([...sources][0] ?? '')
      })
    } catch (err) {
      log('debug', 'attribution:session-summary-failed', { noteId, err })
    }
  }
}

let service: AttributionService | null = null

/** The app-wide service; created by the transcription manager or registerSpeakerTags, whichever runs first. */
export function getAttribution(ctx: MainContext): AttributionService {
  if (!service) service = new AttributionService(ctx)
  return service
}
