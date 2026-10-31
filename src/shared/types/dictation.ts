// SPDX-License-Identifier: Apache-2.0
// System-wide voice typing. Electron's globalShortcut reports no key-up, so the plain
// shortcut toggles (press to start, press to stop); hold and hands-free chords go through
// the keyboard helper. Failed audio is kept encrypted.

import type { IsoTime } from './common'
import type { HookStatus } from './dictation-bar'
import type { AsrProviderId, LocalAsrModelId } from './transcript'

export type DictationTone = 'formal' | 'casual' | 'relaxed' | 'excited'
/** Where the text is going, from the foreground app (./targets.ts in main). */
export type DictationDestination = 'email' | 'work-chat' | 'personal-chat' | 'ai-chat' | 'code' | 'document' | 'terminal' | 'other'
/** The `dictation.styles` keys. AI chat and document follow `other`; code and terminal take no tone. */
export type DictationStyleKey = 'email' | 'work-chat' | 'personal-chat' | 'other'
export const DICTATION_STYLE_KEYS: readonly DictationStyleKey[] = ['email', 'work-chat', 'personal-chat', 'other']
/** The tones each styles key allows; a stored tone outside its list reads as null (automatic). */
export const DICTATION_STYLE_TONES: Record<DictationStyleKey, readonly DictationTone[]> = {
  email: ['formal', 'casual', 'excited'],
  'work-chat': ['formal', 'casual', 'excited'],
  'personal-chat': ['formal', 'casual', 'relaxed'],
  other: ['formal', 'casual', 'excited']
}
/** `keep`: text stays, retry audio lasts 24 h. `24h`: text and audio go after 24 h. `never`: only the text-free usage fields. */
export type DictationLocalRetention = 'keep' | '24h' | 'never'
export type DictationAsrChoice = 'auto' | AsrProviderId
export type DictationMicrophone = 'system-default' | { deviceId: string; label: string }

export type DictationAttemptStatus =
  | 'recording'
  | 'pasted'
  | 'clipboard'
  | 'delivery_failed'
  | 'empty'
  | 'failed'
  | 'cancelled'
  | 'retried'

export type DictationFailureReason =
  | 'offline'
  | 'connection_timeout'
  | 'transcription_start'
  | 'processing_failed'
  | 'clipboard_failed'
  | 'mic_denied'
  | 'mic_missing'
  | 'mic_busy'
  | 'mic_lost'
  | 'connection'

export type DictationMicError = 'mic_denied' | 'mic_missing' | 'mic_busy' | 'mic_lost'

/** A pill card shown over the plain state line. */
export type DictationCard =
  | { kind: 'conflict' }
  | { kind: 'mic-silent' }
  | { kind: 'mic-lid' }
  | { kind: 'learned'; words: string[] }
  | { kind: 'in-history' }
  /** On a paste whose formatting failed (once per cause per app session): a link to Settings ▸ AI. */
  | { kind: 'unformatted' }

/** A short sound the pill plays (`dictation.sounds`). */
export type DictationSound = 'start' | 'lock' | 'finish' | 'notice'

/** A dictionary term with its local usage (`dictation_terms` + `dictation_term_usage`). */
export interface DictationTerm {
  id: string
  term: string
  source: 'manual' | 'learned' | 'imported'
  starred: boolean
  created_at: IsoTime
  updated_at: IsoTime
  /** Set while removed (soft-deleted): never learned back, restorable. */
  deleted_at: IsoTime | null
  use_count: number
  last_used_at: IsoTime | null
}

export type DictationTermError = 'invalid' | 'full' | 'starred-full' | 'not-found'

/** `dictation:terms-add`, `-update`, `-restore`: the term, or why not. Adding an existing term returns it unchanged. */
export type DictationTermResult = { ok: true; term: DictationTerm } | { ok: false; error: DictationTermError }

export const DICTATION_TERM_LIMITS = { maxChars: 50, maxWords: 6, maxStarred: 20, maxTerms: 300 } as const

/** The dictionary's id for a term: NFC, trimmed, single spaces, lower case. */
export function normaliseTerm(term: string): string {
  return term.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase()
}

/** A term is 1–50 characters, at most 6 words and has no comma. */
export function validTerm(term: unknown): term is string {
  if (typeof term !== 'string') return false
  const t = term.normalize('NFC').trim().replace(/\s+/g, ' ')
  return t.length >= 1 && t.length <= DICTATION_TERM_LIMITS.maxChars && t.split(' ').length <= DICTATION_TERM_LIMITS.maxWords && !t.includes(',')
}

/** The onboarding's practice boxes (their accessible names): main formats into them as these destinations. */
export const PRACTICE_LABELS = { aiChat: 'Practice: AI prompt', email: 'Practice: email' } as const

/** A hands-free shortcut entry: a chord, or a chord pressed twice quickly. */
export type DictationHandsFreeEntry = string | { keys: string; doubleTap: true }

/** A recorded conflict note on a shortcut row, until that row's value changes. */
export interface DictationConflictNote {
  id: 'dictation' | 'dictationHold' | 'dictationHandsFree'
  /** JSON of the row's stored value when the note was raised. */
  value: string
}

export type DictationDeliveryFailure =
  | 'not_pasted'
  | 'no_focus'
  | 'secure_input'
  | 'modifiers_held'
  | 'platform'
  | 'native_error'

/** A `dictation_sessions` row without its `audio_key`. */
export interface DictationAttempt {
  id: string
  created_at: IsoTime
  status: DictationAttemptStatus
  failure_reason: DictationFailureReason | null
  language: string | null
  audio_duration_ms: number
  text: string | null
  audio_purge_at: IsoTime | null
  has_audio: boolean
  /** The speech meter's total for the attempt; null on rows from before it was kept. */
  speech_duration_ms: number | null
  /** Words delivered (pasted, copied or retried); null when no text was delivered. */
  word_count: number | null
}

/** `notice`: a card over the idle pill (the conflict note, learned words). */
export type DictationStateKind = 'idle' | 'recording' | 'processing' | 'pasted' | 'copied' | 'empty' | 'saved' | 'error' | 'notice'

/** `dictation:state` (pill window). */
export interface DictationState {
  kind: DictationStateKind
  ready: boolean
  handsFree: boolean
  reason: DictationFailureReason | DictationDeliveryFailure | null
  type: 'shortcut' | 'double-tap' | 'click' | null
  card?: DictationCard | null
  /** Set on the push that should play it, while `dictation.sounds` is on. */
  sound?: DictationSound | null
}

/** `dictation:capture` (pill window): start, stop or cancel the mic capture. */
export interface DictationCaptureCommand {
  action: 'start' | 'stop' | 'cancel'
  sessionId: string
  microphone: DictationMicrophone | null
}

export interface DictationStatus {
  platformSupported: boolean
  labsEnabled: boolean
  enabled: boolean
  armed: boolean
  shortcut: string
  shortcutRegistered: boolean
  shortcutError: string | null
  /** Toggle only. The dictation bar's hold chord is reported as `hook`. */
  holdMode: false
  /** The keyboard helper behind the hold and hands-free chords (`shortcuts:hook-status`). */
  hook: HookStatus
  asr: AsrProviderId | null
  asrError: 'no-provider' | null
  accessibility: 'granted' | 'missing' | 'not-needed'
  /** The shortcut row another app may also answer (the neutral conflict note), or null. */
  conflict: DictationConflictNote['id'] | null
  /** The installed local model can't hear the chosen languages, so voice typing listens for English. */
  englishOnly: boolean
  /** The on-device model voice typing uses; null with a cloud engine. */
  localModel: LocalAsrModelId | null
  /** `app.getPreferredSystemLanguages()` as base codes, suggested first in the language picker. */
  systemLanguages: string[]
}

/** `dictation:capture-event` microphone health, from the pill's capture. */
export type DictationMicHealth = 'silent' | 'signal' | 'stall' | 'reopened'

/**
 * The language the recognizer is asked for: one chosen language as is; none or several use the
 * provider's automatic (multilingual) mode; the English-only local model always gets `en`.
 */
export function dictationLanguage(languages: readonly string[], englishOnly: boolean): string {
  if (englishOnly) return 'en'
  return languages.length === 1 ? languages[0]! : 'auto'
}

export const DICTATION_DEFAULT_SHORTCUT = 'CommandOrControl+Shift+Space'

export const DICTATION_LIMITS = {
  doubleTapMs: 400,
  repeatIgnoreMs: 300,
  readyMs: 6_000,
  coldLocalReadyMs: 30_000,
  contextMs: 600,
  formatTimeoutMs: 10_000,
  segmentMinMs: 100_000,
  segmentMaxMs: 115_000,
  segmentSilenceMs: 300,
  keytermsMax: 100,
  screenKeytermsMax: 40,
  keytermMaxChars: 50,
  contextChars: 1_500,
  minSpeechMs: 300,
  restoreClipboardMs: 750,
  modifiersWaitMs: 1_000,
  chatAutoStopMs: 600_000,
  warmIdleMs: 600_000,
  maxLanguages: 5,
  /** 1,195 s of 16 kHz samples: the recording stops itself and finishes. */
  maxSamples: 19_120_000,
  keytermsDictionary: 30,
  keytermsPeople: 10,
  /** Usage decay: (uses + 1) × 0.5^(days / 14). */
  usageHalfLifeDays: 14,
  micSilentMs: 3_000,
  micSilentAfterSignalMs: 5_000,
  micReopenMs: 5_000,
  micStallMs: 2_000,
  observeEveryMs: 500,
  observeMaxMs: 30_000,
  observeFreshMs: 1_500,
  learnTimeoutMs: 5_000,
  learnMaxCandidates: 4,
  learnSpanWords: 4,
  learnSpanChars: 200,
  duplicateGapWords: 3,
  learnedCardMs: 6_000,
  /** The conflict card: at once, then after gaps of at least 1, 2 and 5 days. */
  conflictGapsDays: [1, 2, 5],
  retryAudioMs: 86_400_000,
  maxShortcutEntries: 3,
  pill: { width: 320, height: 180, bottomOffset: 4 },
  copiedMs: 2_500,
  shortcutRecordMs: 10_000
} as const

/** The provider language lists (list A, list B). */
export const DICTATION_LANGUAGE_LISTS: { a: readonly string[]; b: readonly string[] } = {
  a: [
    'af', 'ar', 'ca', 'da', 'de', 'en', 'es', 'et', 'fa', 'fi', 'fr', 'gl', 'he', 'hi', 'it', 'ja', 'ko', 'mr', 'nl',
    'nn', 'no', 'pt', 'ro', 'ru', 'sv', 'tr', 'ur', 'vi', 'xh', 'yue', 'zh', 'zu'
  ],
  b: [
    'af', 'ar', 'as', 'be', 'bg', 'bn', 'bs', 'ca', 'cs', 'da', 'de', 'de-CH', 'el', 'en', 'es', 'et', 'fa', 'fi', 'fr',
    'gu', 'he', 'hi', 'hr', 'hu', 'hy', 'id', 'it', 'ja', 'ka', 'kk', 'kn', 'ko', 'lt', 'lv', 'mk', 'mn', 'mr', 'ms',
    'ne', 'nl', 'nl-BE', 'no', 'pa', 'pl', 'ps', 'pt', 'ro', 'ru', 'sk', 'sl', 'sr', 'sv', 'ta', 'te', 'th', 'tl',
    'tr', 'uk', 'ur', 'vi', 'zh', 'zh-HK', 'zh-Hant'
  ]
}
