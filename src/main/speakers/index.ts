// SPDX-License-Identifier: Apache-2.0
// registerSpeakerTags(): speaker attribution for Zoom, Teams and Meet, its detectors over
// notula-uia, the speaker timeline and chunk stamping; speaker-name suggestions; the user's
// naming paths (`naming.ts`), their Undo window (`undo.ts`) and clips (`clip.ts`); and their
// IPC. Handlers are registered with literal channels only.

import { app, ipcMain } from 'electron'
import { notulaError } from '@shared/errors'
import type { InvokeChannel, InvokeReq, InvokeRes } from '@shared/ipc'
import type { AttributionStatus, SpeakerNameAcceptResult, SpeakerNameSuggestion } from '@shared/types/transcript'
import type { MainContext } from '../context'
import { expected } from '../ipc-expected'
import { log } from '../log'
import { maybeRunSpeechHarness } from '../transcription/harness'
import { getAttribution } from './attribution'
import { speakerClip } from './clip'
import { acceptName, acceptRequest, askFirst, namePending, notPerson, skipSpeaker } from './naming'
import { getSpeakerNames } from './names'
import { flushAll, hasPendingUndo, undo } from './undo'

/** At quit, the open Undo windows' effects run, within this bound, before storage closes. */
const UNDO_FLUSH_CAP_MS = 10_000

function noteIdOf(req: unknown): string {
  const id = (req as { noteId?: unknown } | null)?.noteId
  if (typeof id !== 'string' || !id || id.length > 200) throw expected(notulaError('invalid-input', 'noteId is required.'))
  return id
}

function personIdOf(req: unknown): string {
  const id = (req as { personId?: unknown } | null)?.personId
  if (typeof id !== 'string' || !id || id.length > 200) throw expected(notulaError('invalid-input', 'personId is required.'))
  return id
}

function identityKeyOf(req: unknown): string {
  const key = (req as { identityKey?: unknown } | null)?.identityKey
  if (typeof key !== 'string' || !key || key.length > 400) throw expected(notulaError('invalid-input', 'identityKey is required.'))
  return key
}

export function registerSpeakerTags(ctx: MainContext): void {
  const attribution = getAttribution(ctx)
  attribution.start()
  const names = getSpeakerNames(ctx)
  names.start()

  // Dev builds only: the ctx.speech / startSimulated seam harness.
  maybeRunSpeechHarness(ctx)

  ipcMain.handle('attribution:get-status' satisfies InvokeChannel, (): AttributionStatus => attribution.status())

  ipcMain.handle(
    'speaker-names:list' satisfies InvokeChannel,
    (_e, req: InvokeReq<'speaker-names:list'>): Promise<SpeakerNameSuggestion[]> => names.list(noteIdOf(req))
  )

  ipcMain.handle(
    'speaker-names:accept' satisfies InvokeChannel,
    (_e, req: InvokeReq<'speaker-names:accept'>): Promise<SpeakerNameAcceptResult> => acceptName(ctx, acceptRequest(req))
  )

  ipcMain.handle(
    'speaker-names:reject' satisfies InvokeChannel,
    (_e, req: InvokeReq<'speaker-names:reject'>): Promise<InvokeRes<'speaker-names:reject'>> => skipSpeaker(ctx, noteIdOf(req), identityKeyOf(req))
  )

  ipcMain.handle(
    'speaker-names:not-person' satisfies InvokeChannel,
    (_e, req: InvokeReq<'speaker-names:not-person'>): Promise<InvokeRes<'speaker-names:not-person'>> =>
      notPerson(ctx, noteIdOf(req), identityKeyOf(req), personIdOf(req))
  )

  ipcMain.handle(
    'speaker-names:ask-first' satisfies InvokeChannel,
    (_e, req: InvokeReq<'speaker-names:ask-first'>): Promise<InvokeRes<'speaker-names:ask-first'>> =>
      askFirst(ctx, noteIdOf(req), identityKeyOf(req), personIdOf(req))
  )

  // The identity key is a hint here: the request's time span picks the cluster.
  ipcMain.handle(
    'speaker-names:name-pending' satisfies InvokeChannel,
    (_e, req: InvokeReq<'speaker-names:name-pending'>): Promise<InvokeRes<'speaker-names:name-pending'>> => {
      const key = (req as { identityKey?: unknown } | null)?.identityKey
      return namePending(ctx, noteIdOf(req), typeof key === 'string' && key && key.length <= 400 ? key : null, personIdOf(req))
    }
  )

  // Never refused: Undo of an earlier naming stays allowed while a job runs.
  ipcMain.handle(
    'speaker-names:undo' satisfies InvokeChannel,
    async (_e, req: InvokeReq<'speaker-names:undo'>): Promise<InvokeRes<'speaker-names:undo'>> => {
      const token = (req as { undoToken?: unknown } | null)?.undoToken
      if (typeof token !== 'string' || !token || token.length > 100) throw expected(notulaError('invalid-input', 'undoToken is required.'))
      return { ok: await undo(token) }
    }
  )

  ipcMain.handle(
    'speaker-names:clip' satisfies InvokeChannel,
    (_e, req: InvokeReq<'speaker-names:clip'>): Promise<InvokeRes<'speaker-names:clip'>> => speakerClip(ctx, noteIdOf(req), identityKeyOf(req))
  )

  // Quit inside an Undo window: the deferred effects run now, before storage closes.
  let flushing = false
  app.on('before-quit', (e) => {
    if (flushing || !hasPendingUndo()) return
    e.preventDefault()
    flushing = true
    const cap = new Promise<void>((resolve) => setTimeout(resolve, UNDO_FLUSH_CAP_MS))
    void Promise.race([flushAll(), cap])
      .catch((err: unknown) => log('warn', 'speakers:undo-flush-failed', { err }))
      .finally(() => app.quit())
  })
}
