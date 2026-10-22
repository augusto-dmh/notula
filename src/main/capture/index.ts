// SPDX-License-Identifier: Apache-2.0
// registerCapture(): capture IPC, the display-media and
// permission handlers, the power blocker, input devices, and the monitors that
// run in main (audio health, inactivity). Handlers are registered with
// literal channels only; pushes write their literal at the send site (push.ts).

import { app, ipcMain, shell, type BrowserWindow } from 'electron'
import { notulaError } from '@shared/errors'
import type { InvokeChannel, InvokeReq, InvokeRes, SendChannel, SendPayload } from '@shared/ipc'
import { AUDIO_SOURCES, type DesiredCaptureState, type InactivityAction } from '@shared/types/capture'
import type { AudioSource, StopReason } from '@shared/types/common'
import type { CaptureQuery, MainContext } from '../context'
import { log } from '../log'
import { transcriptionControl } from '../transcription'
import { CaptureController } from './controller'
import { EngineLogLimiter, parseEngineEvent } from './events'
import { AudioHealth } from './health'
import { InactivityMonitor } from './inactivity'
import { installMediaHandlers } from './media-handlers'
import { pushStopRequested } from './push'

const SHUTDOWN_FLUSH_CAP_MS = 10_000

/** Every reason a renderer may echo back; main's own stops come back as `capture:stop-requested`. */
const STOP_REASONS: readonly StopReason[] = [
  'toggle_off',
  'note_stop_button',
  'indicator_stop_button',
  'bubble_stop_button',
  'inactivity_prompt_stop',
  'idle_timeout',
  'view_closed',
  'window_closed',
  'app_shutdown',
  'system_sleep',
  'system_wake',
  'meeting_app_left_confirmed',
  'meeting_app_left_at_event_end',
  'document_deleted',
  // A held start that was cancelled, or a transcription rule
  'start_cancelled',
  'recording_rule',
  // End of watching (content sources)
  'source_ended'
]

const INACTIVITY_ACTIONS: readonly InactivityAction[] = ['keep', 'stop']

/** Validates the renderer's desired state; anything malformed is dropped. */
function parseDesired(raw: unknown): DesiredCaptureState | null {
  if (!raw || typeof raw !== 'object') return null
  const d = raw as Record<string, unknown>
  if (d['capture'] === 'off') {
    const reason = d['reason']
    return typeof reason === 'string' && STOP_REASONS.includes(reason as StopReason)
      ? { capture: 'off', reason: reason as StopReason }
      : null
  }
  if (d['capture'] !== 'on') return null
  const { noteId, requestedAt, language, keywords, asr } = d
  if (typeof noteId !== 'string' || !noteId || typeof requestedAt !== 'string' || typeof language !== 'string') return null
  if (asr !== 'deepgram' && asr !== 'assemblyai' && asr !== 'local') return null
  const kw = Array.isArray(keywords) ? keywords.filter((k): k is string => typeof k === 'string').slice(0, 100) : []
  // Absent = both sources, as before; a malformed list is dropped to that default.
  const sources = parseAudioSources(d['audioSources'])
  return { capture: 'on', noteId, requestedAt, language, keywords: kw, asr, ...(sources ? { audioSources: sources } : {}) }
}

function parseAudioSources(v: unknown): AudioSource[] | null {
  if (!Array.isArray(v) || v.length < 1 || v.length > 2) return null
  const out = AUDIO_SOURCES.filter((s) => v.includes(s))
  return out.length === v.length ? out : null
}

export function registerCapture(ctx: MainContext): CaptureQuery {
  const transcription = transcriptionControl(ctx)
  const controller = new CaptureController(ctx, transcription)
  const stopFromMain = (reason: StopReason): Promise<void> => controller.stopFromMain(reason)
  const health = new AudioHealth(ctx, () => controller.restart('system'))
  const inactivity = new InactivityMonitor(ctx, transcription, stopFromMain)
  controller.setHooks({
    started: (noteId, sources) => {
      health.started(noteId, sources)
      inactivity.started(noteId, sources)
    },
    switched: (noteId, sources) => {
      health.switched(noteId, sources)
      inactivity.switched(noteId, sources)
    },
    stopped: (noteId) => {
      health.stopped()
      inactivity.stopped(noteId)
    },
    systemBuffer: (pcm) => health.systemBuffer(pcm),
    micBuffer: (pcm) => health.micBuffer(pcm),
    activeMic: (label) => health.activeMic(label),
    sourceError: (source, name) => health.sourceError(source, name)
  })

  installMediaHandlers()

  ipcMain.on('capture:set-desired-state' satisfies SendChannel, (_e, raw: SendPayload<'capture:set-desired-state'>) => {
    const desired = parseDesired(raw)
    if (!desired) {
      log('warn', 'capture:desired-state-invalid')
      return
    }
    controller.setDesired(desired)
  })

  ipcMain.handle(
    'capture:await-session-stopped' satisfies InvokeChannel,
    async (_e, req: InvokeReq<'capture:await-session-stopped'>): Promise<InvokeRes<'capture:await-session-stopped'>> => {
      const noteId = req?.noteId
      if (typeof noteId !== 'string' || !noteId) throw notulaError('invalid-input', 'noteId is required.')
      return transcription.awaitStopped(noteId)
    }
  )

  // ---------- audio health and inactivity ----------

  ipcMain.handle('capture:get-health' satisfies InvokeChannel, (): InvokeRes<'capture:get-health'> => health.current())

  ipcMain.handle(
    'capture:get-inactivity' satisfies InvokeChannel,
    (): InvokeRes<'capture:get-inactivity'> => inactivity.current()
  )

  ipcMain.on('capture:inactivity-action' satisfies SendChannel, (_e, raw: SendPayload<'capture:inactivity-action'>) => {
    const noteId = raw?.noteId
    const action = raw?.action
    if (typeof noteId !== 'string' || !noteId || !INACTIVITY_ACTIONS.includes(action)) {
      log('warn', 'capture:inactivity-action-invalid')
      return
    }
    inactivity.answer(noteId, action)
  })

  const engineLogs = new EngineLogLimiter()
  const invalidLogs = new EngineLogLimiter()
  ipcMain.on('capture:event' satisfies SendChannel, (_e, raw: SendPayload<'capture:event'>) => {
    // Every field is checked and rebuilt: a bad payload is dropped, never thrown.
    const event = parseEngineEvent(raw)
    if (!event) {
      const type = (raw as { type?: unknown } | null)?.type
      if (invalidLogs.allow((n) => log('warn', 'capture:event-invalid-suppressed', { events: n }))) {
        log('warn', 'capture:event-invalid', { type: typeof type === 'string' ? type.slice(0, 40) : typeof type })
      }
      return
    }
    if (event.type === 'log' && !engineLogs.allow((n) => log('warn', 'capture:engine-log-suppressed', { lines: n }))) return
    controller.onEngineEvent(event)
  })

  // Always resolves.
  ipcMain.handle('capture:get-status' satisfies InvokeChannel, (): InvokeRes<'capture:get-status'> => controller.status())

  ipcMain.handle(
    'capture:restart' satisfies InvokeChannel,
    (_e, req: InvokeReq<'capture:restart'>): InvokeRes<'capture:restart'> =>
      controller.restart(req?.scope === 'system' ? 'system' : 'all')
  )

  ipcMain.on('power:prevent-display-sleep' satisfies SendChannel, () => {
    if (controller.isCapturing()) controller.preventDisplaySleep()
  })

  ipcMain.on('power:allow-display-sleep' satisfies SendChannel, () => controller.allowDisplaySleep())

  ipcMain.handle('input:get-state' satisfies InvokeChannel, (): InvokeRes<'input:get-state'> => controller.inputState())

  ipcMain.on('input:set-preference' satisfies SendChannel, (_e, pref: SendPayload<'input:set-preference'>) =>
    controller.setInputPreference(pref)
  )

  ipcMain.on('system:open-sound-settings' satisfies SendChannel, () => {
    const target =
      process.platform === 'win32'
        ? 'ms-settings:sound'
        : process.platform === 'darwin'
          ? 'x-apple.systempreferences:com.apple.preference.sound'
          : null
    if (!target) {
      log('info', 'system:sound-settings-unsupported', { platform: process.platform })
      return
    }
    void shell.openExternal(target).catch((err: unknown) => log('warn', 'system:sound-settings-failed', { err }))
  })

  // window_closed: the renderer's page-hide stop can arrive after the quit that
  // closing the last window triggers, so main applies it when the main window is
  // destroyed. The stop runs on `closed`, not `close`, because the
  // close button now only hides the window and hiding never stops capture.
  app.on('browser-window-created', (_e, win) => watchMainWindowClosed(ctx, win, () => controller.isCapturing(), () => {
    void controller.stop('window_closed')
  }))

  // app_shutdown: stop capture and flush the final chunks before storage closes.
  let shuttingDown = false
  app.on('before-quit', (e) => {
    if (shuttingDown || (!controller.isCapturing() && !controller.hasStopsInFlight())) return
    e.preventDefault()
    shuttingDown = true
    if (!controller.isCapturing()) {
      // A stop already in flight (e.g. window_closed) finishes first.
      void withCap(controller.settled()).finally(() => app.quit())
      return
    }
    // Closing the last window quits the app (Windows): that stop is `window_closed`.
    const reason: StopReason = ctx.windows.main() ? 'app_shutdown' : 'window_closed'
    pushStopRequested(ctx.windows, { reason })
    void withCap(controller.stop(reason)).finally(() => app.quit())
  })

  return {
    isCapturing: () => controller.isCapturing(),
    currentNoteId: () => controller.currentNoteId(),
    stop: stopFromMain,
    // start gates
    registerStartGate: (g) => controller.registerStartGate(g),
    heldStart: () => controller.heldStart(),
    releaseHeldStart: (noteId) => controller.releaseHeldStart(noteId),
    cancelHeldStart: (noteId, reason) => controller.cancelHeldStart(noteId, reason)
  }
}

/**
 * Calls `onClosed` when `win` turns out to be the main window and is destroyed while
 * capturing. `browser-window-created` fires inside the constructor, before the
 * windows module records its main window, so the check waits a tick.
 */
function watchMainWindowClosed(ctx: MainContext, win: BrowserWindow, capturing: () => boolean, onClosed: () => void): void {
  let isMain = false
  setImmediate(() => {
    isMain = !win.isDestroyed() && ctx.windows.main() === win
  })
  win.on('close', () => {
    isMain ||= ctx.windows.main() === win
  })
  win.on('closed', () => {
    if (isMain && capturing()) onClosed()
  })
}

function withCap(p: Promise<void>): Promise<void> {
  return Promise.race([
    p.catch((err: unknown) => log('error', 'capture:shutdown-flush-failed', { err })),
    new Promise<void>((r) => setTimeout(r, SHUTDOWN_FLUSH_CAP_MS))
  ])
}
