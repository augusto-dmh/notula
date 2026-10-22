// SPDX-License-Identifier: Apache-2.0
// TranscriptPanel and the transcript's settings rows, banner and card.

import { createElement, type JSX } from 'react'
import { SpeakerNameCard } from './SpeakerNameCard'

export interface TranscriptPanelProps {
  noteId: string
  reveal: { quote: string; nonce: number } | null
  onClose(): void
  /** `bubble`: no header, Copy or close; the live list, search and the empty states. */
  variant?: 'note' | 'bubble'
}

export { TranscriptPanel } from './TranscriptPanel'

// ---------- speech settings ----------

/** Settings ▸ AI, in the transcription block: the local model. */
export { LocalAsrSettings } from './LocalAsrSettings'

/** Settings ▸ Preferences: the speech rows (speaker separation, multi-language models). */
export { SpeechPreferencesRows } from './SpeechPreferencesRows'

// ---------- speaker names ----------

/** NotePage, top of the page: the speaker-name suggestion banner. */
export function SpeakerNameBanner({ noteId }: { noteId: string }): JSX.Element | null {
  return createElement(SpeakerNameCard, { noteId, variant: 'banner' })
}
