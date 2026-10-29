// SPDX-License-Identifier: Apache-2.0
// Speaker profiles: naming speakers across meetings from
// meeting-app names, the conversation, and voiceprints of people who agreed.
//
// No type here carries a vector, a score, a probability or any other voice evidence: those
// stay in main. The renderer gets bands, sources, names, person ids, counts
// and dates. Agreement text reaches it only through `speaker-people:agreement-text`.

import type { IsoTime } from './common'

// ---------- bands and sources ----------

/** One per cluster, from the post-meeting decision. */
export type SpeakerBand = 'auto' | 'suggest' | 'tie' | 'none'

/** `ProviderWord.auto_src`: what named an auto cluster. */
export type SpeakerAutoSource = 'app' | 'voice' | 'app+voice'

/** Where a suggestion row's candidate came from. */
export type SpeakerCandidateSource = 'app' | 'voice' | 'conversation' | 'elimination'

/** A suggestion row's candidate (at most 2 per row). No score. */
export interface SpeakerCandidate {
  personId?: string
  name: string
  source: SpeakerCandidateSource
}

/** The channel of a cluster, an exemplar or a voice space. The mic is `microphone` in `AudioSource`. */
export type SpeakerChannel = 'mic' | 'system'

// ---------- states ----------

/** One each for Recognize voices and Recognize my voice. */
export type SpeakerVoiceLayerState = 'off' | 'needs-separation' | 'needs-model' | 'ready'

/** The identification model (`speaker-id`). `mismatch`: the calibration `modelSha` ≠ the installed file. */
export type SpeakerModelState = 'missing' | 'downloading' | 'ready' | 'error' | 'mismatch'

/** The post-meeting job of one note. In `queued`, `diarizing` and `deciding` the pill and the sheet are disabled. */
export type SpeakerJobState = 'idle' | 'queued' | 'diarizing' | 'deciding' | 'written' | 'abandoned' | 'failed'

/** `speakers:job-state` and `speakers:job-changed`. `reason` is a code, set only with `failed`. */
export interface SpeakerJobStatus {
  noteId: string
  state: SpeakerJobState
  reason?: string
}

/** The job states in which the note's pills and the who's-who sheet don't open. */
export const SPEAKER_JOB_BUSY: readonly SpeakerJobState[] = ['queued', 'diarizing', 'deciding']

/** A person's voice, as the person page shows it. `stale`: the person's samples are of another model. */
export type SpeakerPersonVoiceState = 'none' | 'pending' | 'consented' | 'remembered' | 'forgotten' | 'expired' | 'stale'

// ---------- agreements ----------

export type SpeakerAgreementMethod = 'email' | 'spoken' | 'written' | 'other'
export type SpeakerAgreementRevokedVia = 'forget' | 'forget_all' | 'withdrawn' | 'expired'
/** The language of a notice or a message. */
export type SpeakerNoticeLanguage = 'en' | 'pt'
/** `speaker-people:forget-voice`. */
export type SpeakerForgetReason = 'forget' | 'withdrawn'

/** The display fields of an agreement record. The notice text and the evidence aren't here. */
export interface SpeakerAgreementInfo {
  method: SpeakerAgreementMethod
  attestedAt: IsoTime
  noticeVersion: string
  language: SpeakerNoticeLanguage
  hasEvidence: boolean
  revokedAt?: IsoTime
  revokedVia?: SpeakerAgreementRevokedVia
}

// ---------- samples and matches ----------

/** `speaker_exemplars.confirmed_via`. */
export type SpeakerSampleVia = 'agreement' | 'confirm' | 'rename' | 'sheet' | 'sample' | 'passive' | 'legacy'

/** `speaker_matches.kind`. */
export type SpeakerMatchKind = 'auto_app' | 'auto_voice' | 'confirmed'

/** `speaker-people:samples`: one row per sample, no vector. */
export interface SpeakerSampleRow {
  sampleId: string
  channel: SpeakerChannel
  createdAt: IsoTime
  /** Absent once the source note is gone ("deleted meeting"). */
  noteId?: string
  noteTitle?: string
  cleanMs: number
  via: SpeakerSampleVia
}

/** `speaker-people:matches`: the meetings where the person was named or recognized. */
export interface SpeakerMatchRow {
  noteId: string
  title: string
  date: IsoTime
  kind: SpeakerMatchKind
}

// ---------- people ----------

/** A persisted person. `email` is lower-cased. */
export interface SpeakerPerson {
  personId: string
  name: string
  email?: string
  isSelf: boolean
  autoRecognize: boolean
  /** Set on a person merged into another; ids on words resolve through it. */
  mergedInto?: string
}

/** `speaker-people:list`: the popover's and the card's roster. `personId` is absent for an attendee with no person yet. */
export interface SpeakerRosterRow {
  personId?: string
  name: string
  email?: string
  isSelf: boolean
  hasVoice: boolean
  /** An attendee of the linked event of `noteId`. */
  attendee: boolean
}

/**
 * One meeting a pending request covers. `canName`: the agreement exists and the cluster still has a vector.
 * The request itself (`speaker_pending`, main only) holds a time span, frozen as epoch ms, wall
 * clock (`wallClockAnchorMs + s_ms` / `+ e_ms`): the cluster's longest turn, plus its channel.
 */
export interface SpeakerPendingMeeting {
  noteId: string
  title: string
  askedAt: IsoTime
  canName: boolean
}

/** `speaker-people:get`. */
export interface SpeakerPersonView {
  person: SpeakerPerson
  voice: {
    state: SpeakerPersonVoiceState
    /** The first sample's date; null without a voice. */
    since: IsoTime | null
    recognizedCount: number
    /** When the voice is forgotten if not recognized; null without a voice. */
    expiresAt: IsoTime | null
    autoRecognize: boolean
    skippedSamples: number
    stale: boolean
  }
  agreement: SpeakerAgreementInfo | null
  pending: SpeakerPendingMeeting[]
  /** "Link to <email>", or "Merge with <person>" when `intoPersonId` already holds that email. */
  mergeOffer?: { email: string; intoPersonId?: string }
  canDelete: boolean
}

/** `speaker-people:merge-preview`, for the merge dialog's confirmation. */
export interface SpeakerMergePreview {
  samplesRemoved: number
  agreementsMoved: number
  meetingsMoved: number
  /**
   * Set when either person withdrew after the surviving active record was made: the merge forgets
   * the voice and stamps that record `withdrawn` (the dialog says "<name> withdrew on <date>").
   */
  withdrawnAt?: IsoTime
}

// ---------- status ----------

/** `speakers:get-status` and `speakers:status-changed`. `autoConditions` is a count, not thresholds. */
export interface SpeakersStatus {
  voices: SpeakerVoiceLayerState
  selfVoice: SpeakerVoiceLayerState
  model: { state: SpeakerModelState; totalBytes: number; receivedBytes: number }
  self: { present: boolean; sampleCount: number; updatedAt: IsoTime | null }
  peopleWithVoice: number
  /** People with an active agreement record, with or without a sample (Settings asks "Also forget…?" when > 0). */
  peopleWithAgreement?: number
  calibration: { present: boolean; autoConditions: number }
  /** A Labs self voice was carried over ("Your voice moved here from Labs"). */
  movedFromLabs: boolean
  /**
   * The LLM step would send to a cloud provider now (a remote Ollama host counts; local-only mode
   * pauses it): main's rule for Settings' transfer note.
   */
  llmCloud?: boolean
}

// ---------- the calibration file ----------

/** The language of a cluster: its session's language lock, else the ASR's detected language. */
export type SpeakerCalibrationLanguage = 'pt' | 'en' | 'other'
/** The clean-speech bucket: under 10 s, 10–30 s, 30 s and more. Only `>=30s` can carry `autoEnabled`. */
export type SpeakerCleanBucket = '<10s' | '10-30s' | '>=30s'
/** The signals fusion weighs. Calendar and channel are hard constraints, not signals. */
export type SpeakerFusionSignal = 'voice' | 'app' | 'conversation' | 'elimination'

/** One condition: channel × language × clean-speech bucket. */
export interface SpeakerCalibrationCondition {
  channel: SpeakerChannel
  language: SpeakerCalibrationLanguage
  bucket: SpeakerCleanBucket
  autoEnabled: boolean
  tauAuto: number
  tauSuggest: number
  margin: number
  tieMargin: number
  /** Maps a voice score to P(correct): `1 / (1 + exp(-(a·x + b)))`. */
  logistic: { a: number; b: number }
  /** The bench's evidence for this condition; 0 and null before a bench run. */
  autoClusters: number
  wrongNames: number
  wrongNameUpper: number | null
  coverage: number | null
}

/** `resources/speakers/calibration.json`. Aggregates only, keyed by the extractor's SHA-256. */
export interface SpeakerCalibration {
  modelSha: string
  /** The bench report's hash; null while the file holds hand-set priors. */
  reportHash: string | null
  createdAt: IsoTime
  benchVersion: number
  conditions: SpeakerCalibrationCondition[]
  /** The far-from-profile cosine floor per channel. */
  farCosine: Record<SpeakerChannel, number>
  fusion: Record<SpeakerFusionSignal, { weight: number; offset: number }>
}

// ---------- limits ----------

export const SPEAKER_PROFILE_LIMITS = {
  /** The clean spans and the identification embedding. */
  spansPerCluster: 12,
  spanMinMs: 1_500,
  spanMaxMs: 10_000,
  spanMergeGapMs: 400,
  vectorMinCleanMs: 3_000,
  embeddingCapMs: 2 * 60_000,
  /** The decision rules. */
  autoMinSpeechMs: 30_000,
  voiceSuggestOnlyBelowMs: 10_000,
  appTileShare: 0.8,
  appNextTileMax: 0.1,
  appCoverage: 0.5,
  defaultTieMargin: 0.03,
  /** Known people, and how many of them reach the LLM step. */
  knownPeopleDays: 90,
  knownPeopleMax: 50,
  knownPeopleToLlm: 10,
  /** Voice storage and retention. */
  exemplarCap: 16,
  exemplarMaxDims: 1_024,
  exemplarWeightFullMs: 30_000,
  farCheckMinExemplars: 3,
  clusterVectorDays: 14,
  voiceExpiryDays: 365,
  sweepEveryMs: 24 * 3_600_000,
  /** Confirmations a voice space needs before voice can name automatically. */
  autoMinConfirmations: 2,
  /** The interface. */
  undoWindowMs: 10_000,
  clipMaxMs: 8_000,
  evidenceTextMaxChars: 20_000,
  spokenExcerptMaxChars: 500,
  /** The LLM step's timeout; a timeout counts as abstaining. */
  llmTimeoutMs: 60_000
} as const
