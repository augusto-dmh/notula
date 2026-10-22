// SPDX-License-Identifier: Apache-2.0
// registerSpeakerTags(): speaker attribution for Zoom, Teams and Meet, its detectors over
// notula-uia, the speaker timeline and chunk stamping; speaker-name suggestions; and their
// IPC. Handlers are registered with literal channels only.

import { ipcMain } from 'electron'
import { notulaError } from '@shared/errors'
import type { InvokeChannel, InvokeReq } from '@shared/ipc'
import type { AttributionStatus, SpeakerNameSuggestion } from '@shared/types/transcript'
import type { MainContext } from '../context'
import { expected } from '../ipc-expected'
import { maybeRunSpeechHarness } from '../transcription/harness'
import { getAttribution } from './attribution'
import { getSpeakerNames } from './names'

function noteIdOf(req: unknown): string {
  const id = (req as { noteId?: unknown } | null)?.noteId
  if (typeof id !== 'string' || !id || id.length > 200) throw expected(notulaError('invalid-input', 'noteId is required.'))
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
    (_e, req: InvokeReq<'speaker-names:accept'>): Promise<{ chunksNamed: number }> => {
      const noteId = noteIdOf(req)
      const identityKey = identityKeyOf(req)
      const name = typeof req?.name === 'string' ? req.name.trim() : ''
      if (!name || name.length > 200) throw expected(notulaError('invalid-input', 'A speaker name is required.'))
      return names.accept({
        noteId,
        identityKey,
        name,
        edited: req.edited === true,
        chosenFromList: req.chosenFromList === true
      })
    }
  )

  ipcMain.handle(
    'speaker-names:reject' satisfies InvokeChannel,
    (_e, req: InvokeReq<'speaker-names:reject'>): Promise<void> => names.reject(noteIdOf(req), identityKeyOf(req))
  )
}
