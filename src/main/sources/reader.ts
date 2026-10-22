// SPDX-License-Identifier: Apache-2.0
// The transcript a reader sees: for a source note with video captions,
// the captions only; a second "Transcribe audio" session beside them stays in the transcript panel
// (its Audio view) but no other reader gets the same speech twice. Summaries and note chat apply
// the same rule through `sourcePromptInputs`. A data rule, so it holds while Sources is off too.
// A note without a source, every meeting, gets its chunks back untouched.
//
// Not for the capture, speaker or voiceprint paths, which work on the audio sessions themselves.

import { sourceTranscriptChunks } from '@shared/lib/source-transcript'
import type { TranscriptChunk } from '@shared/types/transcript'
import type { MainContext } from '../context'

export async function readerTranscript(ctx: MainContext, noteId: string, chunks: TranscriptChunk[]): Promise<TranscriptChunk[]> {
  const source = await ctx.storage.getNoteSource(noteId).catch(() => null)
  return source ? sourceTranscriptChunks(chunks, source) : chunks
}
