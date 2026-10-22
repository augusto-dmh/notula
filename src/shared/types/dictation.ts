// SPDX-License-Identifier: Apache-2.0
// System-wide voice typing. Electron's globalShortcut reports no key-up, so the plain
// shortcut toggles (press to start, press to stop); hold and hands-free chords go through
// the keyboard helper. Failed audio is kept encrypted.

import type { IsoTime } from './common'
import type { HookStatus } from './dictation-bar'
import type { AsrProviderId } from './transcript'

export type DictationTone = 'formal' | 'casual' | 'relaxed' | 'excited'
export type DictationCategory = 'email' | 'work' | 'casual' | 'other'
export type DictationTargetHint = 'email' | 'chat' | 'terminal'
export type DictationRetention = 'off' | '24h' | '7d' | '14d'
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
}

export type DictationStateKind = 'idle' | 'recording' | 'processing' | 'copied' | 'empty' | 'saved' | 'error'

/** `dictation:state` (pill window). */
export interface DictationState {
  kind: DictationStateKind
  ready: boolean
  handsFree: boolean
  reason: DictationFailureReason | DictationDeliveryFailure | null
  type: 'shortcut' | 'double-tap' | 'click' | null
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
  contextChars: 2_400,
  minSpeechMs: 300,
  restoreClipboardMs: 750,
  modifiersWaitMs: 1_000,
  chatAutoStopMs: 600_000,
  warmIdleMs: 600_000,
  dictionaryMax: 30,
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
