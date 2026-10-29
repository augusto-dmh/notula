// SPDX-License-Identifier: Apache-2.0
// Transcript chunks and ASR providers.

import type { AudioSource, IsoTime } from './common'
import type { SpeakerAutoSource, SpeakerBand, SpeakerCandidate } from './speakers'

export type AsrProviderId = 'deepgram' | 'assemblyai' | 'local'
export type CloudAsrProviderId = 'deepgram' | 'assemblyai'
/**
 * Who wrote a transcription session's chunks: an ASR provider, a source's video captions
 * (content sources), or the Markdown importer. Not an ASR choice: `AsrProviderId` stays narrow.
 */
export type TranscriptProviderId = AsrProviderId | 'captions' | 'import'

export interface ProviderWord {
  w: string
  s_ms: number
  e_ms: number
  conf: number
  spk?: number
  lang?: string
  spk_conf?: number
  lang_conf?: number
  /** Diarization: `r<N>`, a speaker within `ProviderDetails.mergeScopeId`. */
  merged_spk?: string
  /** The attribution participant id. */
  att?: string
  /** A user-confirmed name. Written by a user action only. */
  confirmed_spk?: string
  /** The person behind `confirmed_spk`; absent for a free-text name with no person. User only. */
  confirmed_pid?: string
  /** The post-meeting job's name for an auto cluster (`Me` for self). Pipeline only. */
  auto_spk?: string
  /** The person behind `auto_spk`, when known. Pipeline only. */
  auto_pid?: string
  /** What named the cluster. Pipeline only. */
  auto_src?: SpeakerAutoSource
}

export interface ProviderDetails {
  words: ProviderWord[]
  turnEndScore?: number
  provider: TranscriptProviderId
  model: string
  wallClockAnchorMs: number
  /** Diarization: the pass that assigned `ProviderWord.merged_spk`. */
  mergeScopeId?: string
  /**
   * The pass whose post-meeting decision was written on this chunk. While it equals
   * `mergeScopeId`, `att` prints only on auto and confirmed clusters.
   */
  named_pass?: string
  /** A source note: the chunk's start as a video position, mapped through the watched spans. */
  sourcePositionMs?: number
}

/**
 * Stored with snake_case field names plus the workspace and owner fields that keep a future
 * multi-user build possible. `detectedSpeaker` and `providerDetails` are camelCase.
 */
export interface TranscriptChunk {
  id: string
  document_id: string
  workspace_id: string
  owner_id: string
  transcription_session_id: string
  source: AudioSource
  start_timestamp: IsoTime
  end_timestamp: IsoTime
  text: string
  is_final: boolean
  detected_speaker_name: string | null
  /** The attributed participant of a final system chunk, or null. */
  detectedSpeaker: DetectedSpeaker | null
  providerDetails?: ProviderDetails
}

/** Coalesced per 100 ms. */
export interface TranscriptChanged {
  noteId: string
  upserted: TranscriptChunk[]
  removedIds: string[]
}

export interface TranscriptionSessionInfo {
  noteId: string
  sessionId: string
  provider: TranscriptProviderId
  model: string
  language: string
}

export const SPEAKER_LABEL_ME = 'Me'
export const SPEAKER_LABEL_THEM = 'Them'
export const DELETED_CHUNK_MARKER = '[DELETED]'
/** The label of a word-level turn no speaker could be assigned to. */
export const SPEAKER_UNATTRIBUTED = 'Unattributed'

// ---------- local models ----------

/** The local speech models: the English default and the two multilingual downloads. */
export type LocalAsrModelId = 'parakeet-tdt-110m-en-int8' | 'parakeet-tdt-0.6b-v3-int8' | 'whisper-large-v3-turbo-int8'

/** The manifest entries (src/main/asr/manifest.ts). `speaker-id`: the speaker identification extractor. */
export type LocalModelId = LocalAsrModelId | 'diarization-en' | 'speaker-id'

/** `asr.local.model`: `auto` picks an installed model that covers the session language. */
export type LocalAsrChoice = 'auto' | LocalAsrModelId

/** What the renderer shows and main chooses by. Sizes and pins live in the manifest. */
export interface LocalAsrModelInfo {
  id: LocalAsrModelId
  name: string
  /** Lower-case base codes the model transcribes, plus `multi` when it detects the language itself. */
  languages: readonly string[]
  languageSummary: string
  licence: string
  attribution: string
  recommended: boolean
}

const PARAKEET_V3_LANGUAGES = [
  'bg', 'hr', 'cs', 'da', 'nl', 'en', 'et', 'fi', 'fr', 'de', 'el', 'hu', 'it', 'lv', 'lt', 'mt', 'pl', 'pt', 'ro',
  'sk', 'sl', 'es', 'sv', 'ru', 'uk'
] as const

/** Whisper's language codes (the large-v3 tokenizer). */
export const WHISPER_LANGUAGES = [
  'en', 'zh', 'de', 'es', 'ru', 'ko', 'fr', 'ja', 'pt', 'tr', 'pl', 'ca', 'nl', 'ar', 'sv', 'it', 'id', 'hi', 'fi', 'vi',
  'he', 'uk', 'el', 'ms', 'cs', 'ro', 'da', 'hu', 'ta', 'no', 'th', 'ur', 'hr', 'bg', 'lt', 'la', 'mi', 'ml', 'cy', 'sk',
  'te', 'fa', 'lv', 'bn', 'sr', 'az', 'sl', 'kn', 'et', 'mk', 'br', 'eu', 'is', 'hy', 'ne', 'mn', 'bs', 'kk', 'sq', 'sw',
  'gl', 'mr', 'pa', 'si', 'km', 'sn', 'yo', 'so', 'af', 'oc', 'ka', 'be', 'tg', 'sd', 'gu', 'am', 'yi', 'lo', 'uz', 'fo',
  'ht', 'ps', 'tk', 'nn', 'mt', 'sa', 'lb', 'my', 'bo', 'tl', 'mg', 'as', 'tt', 'haw', 'ln', 'ha', 'ba', 'jw', 'su', 'yue'
] as const

/** In the order Settings lists them: the recommended model first. */
export const LOCAL_ASR_MODELS: readonly LocalAsrModelInfo[] = [
  {
    id: 'whisper-large-v3-turbo-int8',
    name: 'Whisper large-v3-turbo',
    languages: ['multi', ...WHISPER_LANGUAGES],
    languageSummary: '99 languages, including Brazilian Portuguese',
    licence: 'MIT',
    attribution: 'OpenAI Whisper large-v3-turbo, converted for sherpa-onnx by the k2-fsa project.',
    recommended: true
  },
  {
    id: 'parakeet-tdt-0.6b-v3-int8',
    name: 'Parakeet TDT 0.6B v3',
    languages: ['multi', ...PARAKEET_V3_LANGUAGES],
    languageSummary: '25 European languages, including Portuguese. Faster than Whisper.',
    licence: 'CC BY 4.0',
    attribution: 'NVIDIA Parakeet TDT 0.6B v3, converted for sherpa-onnx by the k2-fsa project.',
    recommended: false
  },
  {
    id: 'parakeet-tdt-110m-en-int8',
    name: 'Parakeet TDT 110M',
    languages: ['en'],
    languageSummary: 'English only. Small and quick.',
    licence: 'CC BY 4.0',
    attribution: 'NVIDIA Parakeet TDT 110M, converted for sherpa-onnx by the k2-fsa project.',
    recommended: false
  }
]

export const RECOMMENDED_LOCAL_ASR_MODEL: LocalAsrModelId = 'whisper-large-v3-turbo-int8'

export function localAsrModelInfo(id: LocalAsrModelId): LocalAsrModelInfo {
  return LOCAL_ASR_MODELS.find((m) => m.id === id) as LocalAsrModelInfo
}

/** The base code a language setting or tag asks for: `multi` for multilingual or automatic, `pt-BR` → `pt`. */
export function localLanguageCode(language: string): string {
  if (language === 'multi' || language === 'auto' || !language) return 'multi'
  const b = language.trim().toLowerCase().split(/[-_]/)[0] ?? ''
  return b === 'nb' ? 'no' : b
}

export function localModelCovers(id: LocalAsrModelId, language: string): boolean {
  return localAsrModelInfo(id).languages.includes(localLanguageCode(language))
}

export type LocalModelState = { modelId: LocalModelId } & (
  | { state: 'missing'; totalBytes: number }
  | { state: 'downloading'; receivedBytes: number; totalBytes: number }
  | { state: 'ready'; totalBytes: number }
  | { state: 'error'; message: string; totalBytes: number }
)

/** The English local ASR model; the default of the `asr:*-local-model` requests. */
export const DEFAULT_LOCAL_ASR_MODEL: LocalAsrModelId = 'parakeet-tdt-110m-en-int8'

// ---------- speaker attribution ----------

export type AttributionApp = 'zoom' | 'teams' | 'meet'
export type AttributionSource = 'zoom-uia' | 'teams-uia' | 'meet-uia'

/** `TranscriptChunk.detectedSpeaker`. */
export interface DetectedSpeaker {
  participantId: string
  participantName: string
  source: AttributionSource | 'diarization'
}

export type AttributionState = 'off' | 'waiting' | 'active' | 'blind' | 'unavailable' | 'failed'

export interface AttributionAppStatus {
  app: AttributionApp
  enabled: boolean
  state: AttributionState
  speakerEventCount: number
  uniqueSpeakers: number
  detail: string | null
}

/** `attribution:get-status` / `attribution:status-changed`. */
export interface AttributionStatus {
  /** Windows only for now. */
  supported: boolean
  apps: AttributionAppStatus[]
}

/** `attribution.meetSelectors`: the Meet reader's class names, editable. */
export interface MeetSelectors {
  galleryTileClass: string
  selfPreviewClass: string
  speakingIndicatorClass: string
  talkingMeansActive: boolean
  selfByNameMatch: boolean
  selfFromMeetingControls: boolean
}

export const DEFAULT_MEET_SELECTORS: MeetSelectors = {
  galleryTileClass: 'dkjMxf',
  selfPreviewClass: 'aGWPv',
  speakingIndicatorClass: 'kssMZb',
  talkingMeansActive: true,
  selfByNameMatch: true,
  selfFromMeetingControls: false
}

export const ATTRIBUTION_LIMITS = {
  pollMs: { zoom: 250, teams: 250, meet: 500 },
  timelineMax: 10_000,
  minIntervalMs: 200,
  openIntervalMaxMs: 10_000,
  padBeforeMs: 500,
  padAfterMs: 300,
  padWeight: 0.25,
  fallbackFreshMs: 10_000,
  healthLogMs: 30_000,
  restartDelayMs: 1_000,
  maxRestarts: 5,
  restartResetMs: 30_000,
  killGraceMs: 1_000,
  fullAttribution: 0.95
} as const

// ---------- speaker-name suggestions ----------

export type SpeakerEvidenceType =
  | 'introduced_self'
  | 'named_then_replied'
  | 'elimination'
  | 'addressed_not_speaking'
  | 'app_speaker_data'

export interface SpeakerNameSuggestion {
  identityKey: string
  label: string
  name: string | null
  evidenceTypes: SpeakerEvidenceType[]
  channel: AudioSource
  labelStream: 'reconciled' | 'provider'
  transcriptExcerpts: string[]
  position: number
  created_at: IsoTime
  /** The speaker's band. A row of a note without a pass is `suggest` (a name) or `none`. */
  band: SpeakerBand
  /** At most 2, best first. No score. */
  candidates: SpeakerCandidate[]
  /** The pass the row was computed for; null for a note without a pass. */
  passId: string | null
  /** A request waits for the person's agreement. The person isn't stored on the row. */
  pending: boolean
  /**
   * The cluster has a stored voice sample (a cluster vector of the installed model), so Ask first
   * can work. Filled by `speaker-names:list` only, never stored; a boolean, never the vector.
   */
  hasVoiceSample?: boolean
}

/**
 * `speaker-names:accept`. Who is named: `personId` (a person), `email` (a roster entry with
 * no person yet), `newName` (a new person), `self` (Me), or none of them (a free-text
 * `name` with no person). `name` is always the label written on the words.
 */
export interface SpeakerNameAccept {
  noteId: string
  identityKey: string
  name: string
  edited: boolean
  chosenFromList: boolean
  personId?: string
  email?: string
  newName?: string
  self?: boolean
  /** Remember voice was on for this action. */
  remember: boolean
  /** `turn`: Only this turn, the chunks of `turnChunkIds`; it never teaches. */
  scope: 'speaker' | 'turn'
  turnChunkIds?: string[]
  /** The pass the renderer saw; null for a note without a pass. Refused with `stale` when it isn't current. */
  passId: string | null
}

/** `speaker-names:accept`. `undoToken` is null when nothing was written; `needsAgreement`: the person has none yet. */
export interface SpeakerNameAcceptResult {
  chunksNamed: number
  undoToken: string | null
  needsAgreement: boolean
}

export const SPEAKER_NAME_LIMITS = { excerpts: 4, excerptChars: 240, quoteMinWords: 3, timeoutMs: 60_000 } as const
