// SPDX-License-Identifier: Apache-2.0
// Which on-device speech model a session or a dictation uses. Pure: the callers
// pass the settings and what is installed.
//
// - A model picked in Settings is used when it is installed and covers the language.
// - `auto`: English keeps the English default (Parakeet TDT 110M); any other language,
//   or multi-language, takes Whisper large-v3-turbo, or Parakeet TDT 0.6B v3 first when
//   `asr.local.prefer` is `speed`. The first installed model that covers it wins.
// - Nothing installed: English still answers the English default, which a meeting
//   downloads on demand; other languages answer null, because a multilingual
//   model is only ever downloaded when the user asks for it.

import { DEFAULT_LOCAL_ASR_MODEL, localLanguageCode, localModelCovers, type LocalAsrChoice, type LocalAsrModelId } from '@shared/types/transcript'

export interface LocalChoiceInput {
  choice: LocalAsrChoice
  prefer: 'accuracy' | 'speed'
  isReady(id: LocalAsrModelId): boolean
}

const MULTI_ORDER: Record<LocalChoiceInput['prefer'], readonly LocalAsrModelId[]> = {
  accuracy: ['whisper-large-v3-turbo-int8', 'parakeet-tdt-0.6b-v3-int8'],
  speed: ['parakeet-tdt-0.6b-v3-int8', 'whisper-large-v3-turbo-int8']
}

export function chooseLocalModel(language: string, i: LocalChoiceInput): LocalAsrModelId | null {
  if (i.choice !== 'auto' && localModelCovers(i.choice, language) && i.isReady(i.choice)) return i.choice
  const english = localLanguageCode(language) === 'en'
  const order = english ? [DEFAULT_LOCAL_ASR_MODEL, ...MULTI_ORDER[i.prefer]] : MULTI_ORDER[i.prefer]
  const hit = order.find((id) => localModelCovers(id, language) && i.isReady(id))
  if (hit) return hit
  return english ? DEFAULT_LOCAL_ASR_MODEL : null
}

/** The Whisper language for a session language: '' detects it per segment. */
export function whisperLanguage(language: string): string {
  const code = localLanguageCode(language)
  return code === 'multi' ? '' : code
}
