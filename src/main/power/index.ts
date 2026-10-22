// SPDX-License-Identifier: Apache-2.0
// registerPower(): sleep and wake during a meeting; the `power:*` IPC, bus `power:suspended` /
// `power:resumed`.
//
// Electron `powerMonitor` on every platform, no native module:
// - `suspend` while capturing stops with `system_sleep` through the normal drained
//   path (`ctx.capture.stop`), right away;
// - `resume` within 2 h of that stop offers "Resume transcript?" on the note. Nothing
//   ever resumes on its own;
// - `lock-screen` does nothing: meetings go on while the screen is locked.
// The display-sleep blocker stays with capture.

import { ipcMain, powerMonitor } from 'electron'
import type { InvokeChannel, InvokeRes, PushChannel, SendChannel, SendPayload } from '@shared/ipc'
import type { PowerResumed } from '@shared/types/capture'
import type { MainContext } from '../context'
import { log } from '../log'

/** A sleep stop older than this is not offered for resume. */
const RESUME_WINDOW_MS = 2 * 3_600_000

interface Suspended {
  noteId: string
  at: number
  /** Settles when the drained stop has finished. */
  drained: Promise<void>
  settled: boolean
}

export function registerPower(ctx: MainContext): void {
  let suspended: Suspended | null = null
  let pending: PowerResumed | null = null

  const fresh = (p: PowerResumed | null): PowerResumed | null =>
    p && Date.now() - Date.parse(p.suspendedAt) <= RESUME_WINDOW_MS ? p : null

  powerMonitor.on('suspend', () => {
    const at = new Date()
    const noteId = ctx.capture.isCapturing() ? ctx.capture.currentNoteId() : null
    log('info', 'power:suspend', { capturing: noteId !== null })
    if (noteId) {
      const s: Suspended = { noteId, at: at.getTime(), drained: Promise.resolve(), settled: false }
      s.drained = ctx.capture
        .stop('system_sleep')
        .catch((err: unknown) => log('error', 'power:sleep-stop-failed', { err }))
        .finally(() => {
          s.settled = true
        })
      suspended = s
      // A newer sleep stop replaces an older, unanswered prompt.
      pending = null
    }
    ctx.bus.emit('power:suspended', { noteId, at: at.toISOString() })
  })

  powerMonitor.on('resume', () => {
    const resumedAt = new Date().toISOString()
    const s = suspended
    suspended = null
    log('info', 'power:resume', { suspendedNote: s !== null })
    if (s && !s.settled) {
      // The freeze cut the drain short; it completes now: its budgets
      // count awake time only, and unanswered audio is replayed (transcription/awake.ts).
      log('warn', 'power:drain-interrupted', { noteId: s.noteId })
    }
    if (s && Date.now() - s.at <= RESUME_WINDOW_MS) {
      pending = { suspendedNoteId: s.noteId, suspendedAt: new Date(s.at).toISOString(), resumedAt }
      for (const wc of ctx.windows.targets()) wc.send('power:resumed' satisfies PushChannel, pending)
    }
    ctx.bus.emit('power:resumed', {
      suspendedNoteId: s?.noteId ?? null,
      suspendedAt: s ? new Date(s.at).toISOString() : null,
      resumedAt
    })
  })

  powerMonitor.on('lock-screen', () => log('debug', 'power:lock-screen', { capturing: ctx.capture.isCapturing() }))

  ipcMain.handle('power:get-resumed' satisfies InvokeChannel, (): InvokeRes<'power:get-resumed'> => {
    pending = fresh(pending)
    return pending
  })

  ipcMain.on('power:dismiss-resumed' satisfies SendChannel, (_e, raw: SendPayload<'power:dismiss-resumed'>) => {
    const noteId = raw?.noteId
    if (typeof noteId !== 'string' || !pending || pending.suspendedNoteId !== noteId) return
    log('info', 'power:resume-prompt-answered', { resumed: raw.resumed === true })
    pending = null
  })

  // A note started by hand answers the prompt too: nothing to resume any more.
  ctx.bus.on('capture:started', ({ noteId }) => {
    if (pending?.suspendedNoteId === noteId) pending = null
  })
}
