// SPDX-License-Identifier: Apache-2.0
// The quiet line: "2 speakers to name", only where the card can't
// show, the bubble's panel. A click opens the note, whose card leads to the who's-who sheet.

import type { JSX } from 'react'
import { useCaptureSnapshot } from '../capture/store'
import { useLiveTranscript } from './live-transcript'
import { useSpeakerNote } from './speaker-note'
import { speakersToName } from '../speaker-profiles/strings'
import './speaker-pill.css'

export function SpeakerQuietLine({ noteId }: { noteId: string }): JSX.Element | null {
  const { chunks, loaded } = useLiveTranscript(noteId)
  const cap = useCaptureSnapshot()
  const capturing = cap.transcribingNoteId === noteId
  const { view, unnamed } = useSpeakerNote(noteId, chunks, capturing)
  if (!loaded || capturing || view.busy || !unnamed.length) return null
  return (
    <button type="button" className="nt-spk-quiet nt-spk-quiet--static" onClick={() => window.notula.bubble.openNote({ noteId })}>
      {speakersToName(unnamed.length)}
    </button>
  )
}
