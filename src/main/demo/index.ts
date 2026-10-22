// SPDX-License-Identifier: Apache-2.0
// registerDemo(): the bundled demo meeting: the stage window, the simulated
// transcript and the side window mode; the `demo:*` IPC.
//
// - `demo:start` creates the demo note in main: event `demo_meeting_<UUID>`, never written to
//   `calendar_events`, so reminders, briefs and Coming up ignore it.
// - `demo:join` opens the stage window left of the side window and plays the bundled
//   script (`resources/demo/script.json`). `live` feeds the lines through `startSimulated`;
//   `replay` plays the captions only. The stage's caption follows Notula's own clock, which
//   uses the same scripted offsets, so the two stay in step through pauses.
// - The end of a live run (last line, or an early stop) starts the summary through `autoGenerate`
//   with the full script, and the example summary when no LLM is set up.
// - Closing the stage (any path) stops the feed, pushes the state and `demo:closed`, and puts the main
//   window back to wide with focus.

import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { ipcMain, nativeTheme, screen, type BrowserWindow, type Rectangle } from 'electron'
import { notulaError } from '@shared/errors'
import type { InvokeChannel, InvokeRes, PushChannel, SendChannel, SendPayload } from '@shared/ipc'
import { DEMO_ATTENDEE, DEMO_EVENT_ID_PREFIX, DEMO_LIMITS, type DemoMode, type DemoState } from '@shared/types/demo'
import type { CalendarEvent, CreationSource } from '@shared/types/notes'
import type { MainContext } from '../context'
import { resourcePath } from '../lifecycle/resources'
import { log } from '../log'
import { transcriptionControl, type SimulatedLine, type SimulatedSession } from '../transcription'

interface Script {
  lines: SimulatedLine[]
  /** The prompt transcript: every line, `Speaker: text`, one per line. */
  text: string
  durationMs: number
}

const TICK_MS = 250
const END_PAD_MS = 1_500

function platformSource(): CreationSource {
  if (process.platform === 'darwin') return 'macOS'
  if (process.platform === 'win32') return 'Windows'
  return 'desktop'
}

async function loadScript(): Promise<Script> {
  const raw = JSON.parse(await readFile(resourcePath('demo/script.json'), 'utf8')) as {
    speaker?: unknown
    lines?: { atMs?: unknown; durationMs?: unknown; text?: unknown; speaker?: unknown }[]
  }
  const fallbackSpeaker = typeof raw.speaker === 'string' && raw.speaker.trim() ? raw.speaker.trim() : DEMO_ATTENDEE.displayName
  const lines: SimulatedLine[] = (Array.isArray(raw.lines) ? raw.lines : [])
    .filter((l) => typeof l?.text === 'string' && l.text.trim() && typeof l.atMs === 'number' && Number.isFinite(l.atMs))
    .map((l) => ({
      atMs: Math.max(0, l.atMs as number),
      durationMs: typeof l.durationMs === 'number' && l.durationMs > 0 ? l.durationMs : 4_000,
      speaker: typeof l.speaker === 'string' && l.speaker.trim() ? l.speaker.trim() : fallbackSpeaker,
      text: (l.text as string).trim()
    }))
    .sort((a, b) => a.atMs - b.atMs)
  if (lines.length === 0) throw new Error('the demo script has no lines')
  const last = lines[lines.length - 1] as SimulatedLine
  return {
    lines,
    text: lines.map((l) => `${l.speaker}: ${l.text}`).join('\n'),
    durationMs: Math.min(DEMO_LIMITS.durationMs, last.atMs + last.durationMs + END_PAD_MS)
  }
}

async function loadExample(): Promise<string> {
  try {
    return await readFile(resourcePath('demo/example-summary.md'), 'utf8')
  } catch (err) {
    log('warn', 'demo:example-summary-missing', { err })
    return ''
  }
}

/** The side window is max(500, 31.5 %) at the right; the stage takes the rest of the work area. */
function stageBounds(display: Electron.Display): Rectangle {
  const wa = display.workArea
  const side = Math.max(DEMO_LIMITS.sideMinPx, Math.round(wa.width * DEMO_LIMITS.sideFraction))
  return { x: wa.x, y: wa.y, width: Math.max(320, wa.width - side), height: wa.height }
}

export function registerDemo(ctx: MainContext): void {
  let win: BrowserWindow | null = null
  let script: Script | null = null
  let session: SimulatedSession | null = null
  let noteId: string | null = null
  let mode: DemoMode | null = null
  let playing = false
  let lineIndex = -1
  /** The script clock: elapsed play time, excluding pauses. */
  let baseElapsed = 0
  let resumedAt = 0
  let ticker: ReturnType<typeof setInterval> | null = null
  let generated = false

  const alive = (w: BrowserWindow | null): w is BrowserWindow => w !== null && !w.isDestroyed()
  const elapsed = (): number => baseElapsed + (playing ? Date.now() - resumedAt : 0)

  function state(): DemoState {
    const line = script && lineIndex >= 0 ? script.lines[lineIndex] : undefined
    return {
      active: alive(win),
      noteId,
      mode,
      playing,
      lineIndex: Math.max(0, lineIndex),
      lineCount: script?.lines.length ?? 0,
      caption: line?.text ?? null,
      speaker: line?.speaker ?? null,
      elapsedMs: Math.min(elapsed(), script?.durationMs ?? 0),
      durationMs: script?.durationMs ?? 0
    }
  }

  function push(): void {
    const s = state()
    for (const wc of ctx.windows.targets()) wc.send('demo:state-changed' satisfies PushChannel, s)
  }

  function stopTicker(): void {
    if (ticker) clearInterval(ticker)
    ticker = null
  }

  /** Advances the caption by the clock; pushes on a line change and every tick for the progress bar. */
  function tick(): void {
    if (!script) return
    const t = elapsed()
    let idx = -1
    for (let i = 0; i < script.lines.length; i++) if ((script.lines[i] as SimulatedLine).atMs <= t) idx = i
    lineIndex = idx
    if (t >= script.durationMs) {
      baseElapsed = script.durationMs
      playing = false
      stopTicker()
      log('info', 'demo:finished', { mode })
      if (mode === 'live') void finishLive('demo_finished')
    }
    push()
  }

  function play(): void {
    if (playing || !script || elapsed() >= script.durationMs) return
    playing = true
    resumedAt = Date.now()
    session?.resume()
    stopTicker()
    ticker = setInterval(tick, TICK_MS)
    push()
  }

  function pause(): void {
    if (!playing) return
    baseElapsed = elapsed()
    playing = false
    session?.pause()
    stopTicker()
    push()
  }

  /** The stop starts the summary as for any meeting, with the full script as its transcript. */
  async function finishLive(reason: 'demo_finished' | 'user_stopped' | 'window_closed'): Promise<void> {
    const s = session
    const id = noteId
    session = null
    if (s) {
      try {
        await s.stop(reason)
      } catch (err) {
        log('warn', 'demo:session-stop-failed', { err })
      }
    }
    if (!id || generated || !script) return
    generated = true
    try {
      const fallbackMarkdown = await loadExample()
      const r = await ctx.enhance.autoGenerate(id, { transcriptText: script.text, fallbackMarkdown })
      log('debug', 'demo:summary', { started: r !== null, reason })
    } catch (err) {
      log('warn', 'demo:summary-failed', { err })
    }
  }

  function ensureWindow(): BrowserWindow {
    if (alive(win)) return win
    const anchor = ctx.windows.main()
    const display = anchor && !anchor.isDestroyed() ? screen.getDisplayMatching(anchor.getBounds()) : screen.getPrimaryDisplay()
    const dark = nativeTheme.shouldUseDarkColors
    const w = ctx.windows.createSecondary({
      kind: 'demo',
      route: '/demo',
      title: 'Demo meeting',
      ...stageBounds(display),
      minWidth: 320,
      minHeight: 320,
      backgroundColor: dark ? '#17181a' : '#f7f7f5',
      titleBarStyle: 'hidden',
      ...(process.platform === 'win32'
        ? { titleBarOverlay: { color: dark ? '#17181a' : '#f7f7f5', symbolColor: dark ? '#e8e8e6' : '#3a3a38', height: 36 } }
        : {}),
      skipTaskbar: false
    })
    w.webContents.once('did-finish-load', () => {
      if (!w.isDestroyed()) w.showInactive()
    })
    w.on('closed', () => {
      if (win === w) win = null
      onClosed()
    })
    win = w
    return w
  }

  function onClosed(): void {
    const wasLive = mode === 'live' && session !== null
    const elapsedAtClose = elapsed()
    pause()
    stopTicker()
    if (wasLive) void finishLive(elapsedAtClose >= (script?.durationMs ?? 0) ? 'demo_finished' : 'window_closed')
    playing = false
    push()
    const main = ctx.windows.main()
    if (main && !main.webContents.isDestroyed()) main.webContents.send('demo:closed' satisfies PushChannel)
    void ctx.windowModes
      .set('wide', { focus: true, reason: 'demo' })
      .catch((err: unknown) => log('warn', 'demo:wide-failed', { err }))
    if (main && !main.isDestroyed()) {
      if (main.isMinimized()) main.restore()
      main.show()
      main.focus()
    }
    log('info', 'demo:closed')
  }

  async function join(id: string, m: DemoMode): Promise<void> {
    const note = await ctx.storage.getNote(id)
    if (!note || !note.event_id?.startsWith(DEMO_EVENT_ID_PREFIX)) {
      log('warn', 'demo:join-not-demo')
      return
    }
    try {
      script = await loadScript()
    } catch (err) {
      log('error', 'demo:script-unavailable', { err })
      return
    }
    // A running live feed ends before another run starts.
    if (session) await finishLive('user_stopped')
    stopTicker()
    noteId = id
    mode = m
    playing = false
    baseElapsed = 0
    lineIndex = -1
    if (m === 'live') {
      generated = false
      session = transcriptionControl(ctx).startSimulated(id, script.lines)
      session.onEnded((reason) => log('debug', 'demo:session-ended', { reason }))
    }
    const w = ensureWindow()
    if (w.webContents.isLoading()) {
      // Shown inactive once loaded.
    } else {
      w.showInactive()
    }
    await ctx.windowModes
      .set('side', { focus: true, reason: 'demo' })
      .catch((err: unknown) => log('warn', 'demo:side-failed', { err }))
    play()
    log('info', 'demo:joined', { mode: m })
  }

  // ---------- IPC ----------

  ipcMain.handle('demo:start' satisfies InvokeChannel, async (e): Promise<InvokeRes<'demo:start'>> => {
    if (ctx.windows.kindOf(e.sender) !== 'main') throw notulaError('invalid-input', 'demo:start comes from the main window')
    const now = Date.now()
    const event: CalendarEvent = {
      id: `${DEMO_EVENT_ID_PREFIX}${randomUUID()}`,
      summary: 'Demo meeting',
      start: { dateTime: new Date(now).toISOString() },
      end: { dateTime: new Date(now + DEMO_LIMITS.durationMs).toISOString() },
      attendees: [{ email: DEMO_ATTENDEE.email, displayName: DEMO_ATTENDEE.displayName, organizer: true }],
      organizer: { email: DEMO_ATTENDEE.email, displayName: DEMO_ATTENDEE.displayName }
    }
    const note = await ctx.storage.createNote({
      origin: 'demo',
      title: 'Demo meeting',
      calendarEvent: event,
      created_via: platformSource()
    })
    await ctx.settings
      .set('onboarding.demoStarted', true)
      .catch((err: unknown) => log('warn', 'demo:flag-save-failed', { err }))
    log('info', 'demo:started')
    return { noteId: note.id }
  })

  ipcMain.on('demo:join' satisfies SendChannel, (e, raw: SendPayload<'demo:join'>) => {
    if (ctx.windows.kindOf(e.sender) !== 'main') return
    const id = raw?.noteId
    const m = raw?.mode
    if (typeof id !== 'string' || !id || id.length > 200 || (m !== 'live' && m !== 'replay')) return
    void join(id, m).catch((err: unknown) => log('error', 'demo:join-failed', { err }))
  })

  ipcMain.on('demo:close' satisfies SendChannel, () => {
    if (alive(win)) win.close()
  })

  ipcMain.handle('demo:is-active' satisfies InvokeChannel, (): InvokeRes<'demo:is-active'> => alive(win))

  ipcMain.handle('demo:get-state' satisfies InvokeChannel, (): InvokeRes<'demo:get-state'> => state())

  ipcMain.on('demo:set-playing' satisfies SendChannel, (_e, raw: SendPayload<'demo:set-playing'>) => {
    if (typeof raw?.playing !== 'boolean') return
    if (raw.playing) {
      // Resume after the end restarts nothing: replay is a fresh `demo:join`.
      play()
    } else {
      pause()
    }
  })
}
