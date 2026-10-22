// SPDX-License-Identifier: Apache-2.0
// The wait for a note's final speaker labels before its prompt inputs are built: the late
// finals of its last session and, when diarization is on, the diarization pass at stop.
// Both live behind `TranscriptionControl.awaitSpeakerLabels`.
// A failed wait is logged and generation goes on with the labels it has.

import type { MainContext } from '../context'
import { log } from '../log'
import { transcriptionControl } from '../transcription'

export async function awaitFinalSpeakerLabels(ctx: MainContext, noteId: string): Promise<void> {
  try {
    await transcriptionControl(ctx).awaitSpeakerLabels(noteId)
  } catch (err) {
    log('warn', 'enhance:speaker-wait-failed', { noteId, err })
  }
}
