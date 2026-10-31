// SPDX-License-Identifier: Apache-2.0
// StorageApi: the only way to persist anything. Implemented as an RPC client to the
// notula-storage utility process (storage/index.ts); consumed by the IPC handlers and
// every main-side module. Methods come in one group per feature; the newer groups are
// served by the repos in src/main/repos/. Every write produces a change event; a
// rebuild of the people maps emits a change batch with the pseudo-table `people_maps`.
//
// Every method is async. Except the lifecycle group, every method rejects with
// `storage-unavailable` (shared/errors.ts) unless the status is `ready`.

import type {
  ActionItem,
  ActionItemAttribution,
  ActionItemChannel,
  ActionItemFeedback,
  ActionItemFeedbackInput,
  ActionItemReview,
  ActionItemsQuery,
  RegeneratedActionItem
} from '@shared/types/action-items'
import type { AttachmentInfo, AttachmentKind, AttachmentParentType, AttachmentStatus } from '@shared/types/attachments'
import type { PrepBrief } from '@shared/types/briefs'
import type { CalendarGrant, CalendarInfo, CalendarSource, Participant, UpcomingPage } from '@shared/types/calendar'
import type { ChatMessage, ChatThread, ChatThreadQuery } from '@shared/types/chat'
import type { AudioSource, IsoTime } from '@shared/types/common'
import type { DataExportFormat } from '@shared/types/data-export'
import type { DictationAttempt } from '@shared/types/dictation'
import type {
  Folder,
  FolderCreate,
  FolderNoteSource,
  FolderPatch,
  FolderRule,
  FolderRuleInput,
  FoldersState
} from '@shared/types/folders'
import type { FollowUpDraft } from '@shared/types/follow-up'
import type {
  IntegrationAutomation,
  IntegrationAutomationInput,
  IntegrationDelivery,
  IntegrationDestination,
  IntegrationProvider
} from '@shared/types/integrations'
import type { McpLocalServerToken, McpServerInfo } from '@shared/types/mcp'
import type {
  AttachedLink,
  CalendarEvent,
  CreationSource,
  DocumentTag,
  Note,
  NoteCreateInput,
  NoteListItem,
  NoteListPage,
  NotePatch,
  NotePeople,
  NotesListQuery,
  ScreenShareContext,
  TrashItem
} from '@shared/types/notes'
import type { Panel } from '@shared/types/panels'
import type {
  CompaniesQuery,
  CompanyDetail,
  CompanyRow,
  PeopleQuery,
  PersonDetail,
  PersonRow
} from '@shared/types/people'
import type { Recipe, RecipesUsage, RecipeUpsert } from '@shared/types/recipes'
import type { ImportJob, RecordingInfo, RecordingState, RecordingsUsage } from '@shared/types/recordings'
import type { ScratchpadDay, ScratchpadDaySummary } from '@shared/types/scratchpad'
import type { SearchResponse } from '@shared/types/search'
import type { SecretId, SettingKey, Settings } from '@shared/types/settings'
import type {
  CanonicalKey,
  CatalogItem,
  LessonOrigin,
  LessonState,
  NoteSource,
  NoteSourcePatch,
  NoteSourceView,
  SeriesDetail,
  SeriesKind,
  SeriesListItem,
  SeriesState,
  SourceConfidence,
  SourceDetectedVia,
  SourceEnrichment,
  SourceKind,
  SourceProvider,
  SourceSeries,
  SourceSpan,
  SourceTrackState,
  TranscriptPlan
} from '@shared/types/sources'
import type {
  CandidateLink,
  ImportBatch,
  ImportBatchState,
  ImportFormat,
  ImportItem,
  ImportItemState,
  ImportOptions,
  ImportPreset,
  ImportUndoPreview
} from '@shared/types/imports-markdown'
import type { RecoveryAction, StorageStatus } from '@shared/types/storage'
import type { NoteTemplate, NoteTemplateCreate, NoteTemplatePatch } from '@shared/types/templates'
import type {
  SpeakerAgreementMethod,
  SpeakerAgreementRevokedVia,
  SpeakerCandidate,
  SpeakerBand,
  SpeakerChannel,
  SpeakerMatchKind,
  SpeakerMatchRow,
  SpeakerMergePreview,
  SpeakerNoticeLanguage,
  SpeakerPersonView,
  SpeakerSampleRow,
  SpeakerSampleVia
} from '@shared/types/speakers'
import type { SpeakerNameSuggestion, TranscriptChunk, TranscriptProviderId } from '@shared/types/transcript'
import type { YdocState } from '@shared/types/ydoc'

/** The implicit local workspace and owner, created on first open. */
import type { AutomationRule, AutomationRuleInput, AutomationRun, AutomationRunStatus } from '@shared/types/automations'
import type { ConsentChannel, ConsentReason, ConsentStatusValue } from '@shared/types/consent'
import type { CustomerCallsBacklogNote, CustomerCallsSyncStatus } from '@shared/types/customer-calls'
import type { Dispatch, DispatchRunStatus, DispatchStatus, DispatchTodo, DispatchTodoStatus } from '@shared/types/dispatch'
import type { LocalApiKey, LocalApiScope } from '@shared/types/local-api'
import type { MeetingDockHistory } from '@shared/types/meeting-dock'
import type { Reminder, ReminderStatus } from '@shared/types/reminder-cards'
import type { RetentionPreview, RetentionRun } from '@shared/types/retention'
import type { SummaryFeedback, SummaryFeedbackDirection, SummaryFeedbackList } from '@shared/types/summary-feedback'
import type { ManualTask, TasksList } from '@shared/types/tasks'
import type { TranscriptReport } from '@shared/types/transcript-reports'
import type { UserContextPerson, UserContextSection, UserContextSectionId } from '@shared/types/user-context'
import type { WebhookEndpoint } from '@shared/types/webhooks'
import type { BlockExecution, WorkflowBlock } from '@shared/types/workflow-blocks'
export interface StorageIdentity {
  workspaceId: string
  ownerId: string
}

/** One committed write batch. `tables` are SQL table names. */
export interface StorageChange {
  tables: string[]
  ids: string[]
}

export interface NewTranscriptionSession {
  id: string
  document_id: string
  /** An ASR provider, or `captions` / `import` for sessions written from a source or an import. */
  provider: TranscriptProviderId
  model: string
  language: string
  started_at: IsoTime
}

/** A `transcription_sessions` row. */
export interface TranscriptionSession extends NewTranscriptionSession {
  workspace_id: string
  owner_id: string
  ended_at: IsoTime | null
  end_reason: string | null
}

export type NewPanel = Omit<Panel, 'id' | 'workspace_id' | 'owner_id' | 'created_at' | 'updated_at'> & {
  id?: string
}

// ---------- helper types (main-only) ----------

/** The facts the auto-delete rules are checked against. */
export interface NoteEmptiness {
  created_via: string
  is_event_main_note: boolean
  event_id: string | null
  event_summary: string | null
  title: string | null
  chunk_count: number
  live_panel_count: number
  notes_text_length: number
  deleted: boolean
}

/** Own notes, not deleted. */
export interface NoteQuery {
  ids?: string[]
  from?: IsoTime
  to?: IsoTime
  limit?: number
  order?: 'newest' | 'oldest'
}

/** Trigram FTS over notes and panels (terms of 3+ characters). */
export interface FtsQuery {
  terms: string[]
  limit: number
  sources: ('documents' | 'panels')[]
  documentIds?: string[]
}

export interface FtsHit {
  documentId: string
  matchedTerms: number
  inTitle: boolean
  source: 'document' | 'panel'
  panelId: string | null
}

/** `upsertChatThread`: everything but the owner fields and the times, which storage sets. */
export type ChatThreadUpsert = Partial<Omit<ChatThread, 'workspace_id' | 'owner_id' | 'created_at' | 'updated_at'>> & {
  id: string
}

/** `upsertChatMessage`: storage sets the owner fields and the times. */
export type ChatMessageUpsert = Omit<ChatMessage, 'workspace_id' | 'owner_id' | 'created_at' | 'updated_at' | 'deleted_at'>

/** A `calendar_sources` row as main sees it: the renderer's shape plus the ICS cache validators. */
export type CalendarSourceRow = CalendarSource & { httpEtag: string | null; httpLastModified: string | null }


/** A `recordings` row with its per-file key (never leaves main). */
export type RecordingRow = RecordingInfo & { file_key: Uint8Array }

export interface NewRecording {
  id: string
  note_id: string
  session_id: string
  source: AudioSource
  started_at: IsoTime
  file_key: Uint8Array
}

/** An `audio_imports` row with its source path (never leaves main). */
export type ImportJobRow = ImportJob & { source_path: string }

export interface NewAttachment {
  id?: string
  parent_type: AttachmentParentType
  parent_id: string
  kind: AttachmentKind
  file_name: string
  mime_type: string
  width?: number | null
  height?: number | null
  page_count?: number | null
  status: AttachmentStatus
  screen_capture_info?: ScreenShareContext | null
  /** A note image counted toward the 10-image limit. */
  counted: boolean
  /** Plaintext; the worker encrypts it with a fresh key. */
  bytes: Uint8Array
}

export type AttachmentPatch = Partial<{
  status: AttachmentStatus
  error: string | null
  content_markdown: string | null
  token_estimate: number | null
  content_summary: string | null
  page_count: number | null
  screen_capture_info: ScreenShareContext | null
  /** Re-parents. */
  parent_id: string
}>

export interface NewActionItem {
  intent: string
  detail: string | null
  attribution: ActionItemAttribution[]
  summaryLine: string | null
  channel: ActionItemChannel | null
  /** Set by main from `summaryLine` (stamp.ts). */
  lineFingerprint?: string | null
}

/** One row written by "Keep regenerated", with the line main stamps its id onto. */
export interface AppliedActionItem {
  id: string
  noteId: string
  panelId: string | null
  summaryLine: string | null
}

export type FollowUpDraftUpsert = Omit<FollowUpDraft, 'created_at' | 'updated_at' | 'note_title'>

export interface CompanyIconRow {
  domain: string
  bytes: Uint8Array | null
  mime_type: string | null
  fetched_at: IsoTime
  status: 'ok' | 'failed'
}

export type PrepBriefUpsert = Omit<PrepBrief, 'created_at' | 'updated_at'>

export interface BriefContextQuery {
  eventStart: IsoTime
  seriesId: string | null
  externalEmails: string[]
  domains: string[]
  names: string[]
  companyNames: string[]
  limit: number
  perNoteChars: number
}

export interface BriefContextNote {
  id: string
  title: string | null
  date: IsoTime
  attendees: string[]
  text: string
  group: 1 | 2 | 3
}

/** A destination row with the id of the secret holding its webhook or hook URL. */
export type IntegrationDestinationRow = IntegrationDestination & { secret_id: string | null }

export type NewIntegrationDelivery = Omit<
  IntegrationDelivery,
  | 'id'
  | 'attempts'
  | 'createdAt'
  | 'updatedAt'
  | 'noteTitle'
  | 'externalId'
  | 'externalUrl'
  | 'errorCode'
  | 'errorMessage'
  | 'sentAt'
>

export type IntegrationDeliveryPatch = Partial<
  Pick<
    IntegrationDelivery,
    'status' | 'attempts' | 'nextAttemptAt' | 'externalId' | 'externalUrl' | 'errorCode' | 'errorMessage' | 'sentAt'
  >
>

/** The stored fields of McpServerInfo. */
export type McpConnectionRow = Omit<McpServerInfo, 'state' | 'error' | 'toolCount' | 'toolsCut' | 'instructions' | 'hasToken'>

/** A `dictation_sessions` row with its audio key (never leaves main). */
export type DictationAttemptRow = DictationAttempt & { audio_key: Uint8Array | null }

export type DictationAttemptPatch = Partial<
  Pick<DictationAttempt, 'status' | 'failure_reason' | 'language' | 'audio_duration_ms' | 'text' | 'audio_purge_at' | 'speech_duration_ms' | 'word_count'>
>



/** One record per note; never the message text. */
export interface ConsentPostRow {
  id: string
  note_id: string
  channel: ConsentChannel | null
  status: ConsentStatusValue
  reason: ConsentReason | null
  attempted_at: IsoTime | null
  completed_at: IsoTime | null
}

/** Main only: the vectors never cross IPC and are never logged. */
export interface VoiceprintRow {
  id: string
  model_id: string
  centroids: { vector: number[]; totalSpeechMs: number; updatedAt: IsoTime }[]
  total_speech_ms: number
  updated_at: IsoTime
}

// ---------- speaker profiles (migration 12; main only, src/main/storage/speaker-*-repo.ts) ----------
// Vectors are Float32Array, L2-normalized. They never cross IPC to the renderer and are never logged.

/** A `speaker_people` row. `email` is lower-cased; `mergedInto` set on a merged row. */
export interface SpeakerPersonRow {
  id: string
  displayName: string
  email: string | null
  isSelf: boolean
  autoRecognize: boolean
  mergedInto: string | null
  lastMatchedAt: IsoTime | null
  skippedSamples: number
  createdAt: IsoTime
  updatedAt: IsoTime
  /** The person has at least one exemplar (of any model). Set on every row the repo returns. */
  hasVoice?: boolean
}

/** A candidate for the job (a known person): confirmed or recognized lately, or of the same calendar series. */
export interface KnownSpeakerPerson {
  personId: string
  name: string
  email: string | null
  isSelf: boolean
  /** The latest match row's time. */
  lastAt: IsoTime | null
  sameSeries: boolean
  /** Named (confirmed or auto) in the note the query named. */
  inNote: boolean
}

/** One voice space of the matching gallery: a person × channel of one model. */
export interface SpeakerVoiceSpaceRow {
  personId: string
  modelId: string
  channel: SpeakerChannel
  centroid: Float32Array
  count: number
  cleanMs: number
  confirmations: number
  exemplars: { id: string; vector: Float32Array; weight: number }[]
}

/** Provenance and vector of a new exemplar. `weight` = min(1, cleanMs / 30 s). */
export interface NewSpeakerExemplar {
  personId: string
  modelId: string
  channel: SpeakerChannel
  vector: Float32Array
  cleanMs: number
  weight: number
  sourceNoteId: string | null
  sourcePassId: string | null
  sourceLabel: string | null
  spanStartMs: number | null
  spanEndMs: number | null
  via: SpeakerSampleVia
  /**
   * The far-from-profile floor: with ≥ 3 exemplars in the channel, a vector whose
   * cosine to the centroid is below it is skipped and counted. Null skips the check.
   */
  farCosine: number | null
}

/**
 * `added` (`replacedId` set when the cap replaced one), `skipped-far` (counted on the person),
 * `refused-no-agreement` (a non-self person without an active agreement) or `refused-off`
 * (Recognize my voice off for the user, Recognize voices off for anyone else). Refusals are
 * logged as a code.
 */
export type AddSpeakerExemplarResult =
  | { status: 'added'; id: string; replacedId: string | null }
  | { status: 'skipped-far' }
  | { status: 'refused-no-agreement' }
  | { status: 'refused-off' }

/** A `speaker_cluster_vectors` row. `label` is `r<N>`; `source` the audio source. */
export interface SpeakerClusterVectorRow {
  noteId: string
  passId: string
  source: AudioSource
  label: string
  modelId: string
  vector: Float32Array
  speechMs: number
  cleanMs: number
  createdAt: IsoTime
  expiresAt: IsoTime
}

export type NewSpeakerClusterVector = Omit<SpeakerClusterVectorRow, 'createdAt' | 'expiresAt'>

/** A "Not <name>": the pairing only, no vector. */
export interface SpeakerNegativeRow {
  noteId: string
  passId: string
  identityKey: string
  personId: string
  createdAt: IsoTime
}

/**
 * A request waiting for an agreement: a time span and a channel, never a vector. The span is
 * epoch ms, wall clock (`wallClockAnchorMs + s_ms` / `+ e_ms`), of the cluster's longest turn, and
 * `source` its channel; a request without `source` counts every channel.
 */
export interface SpeakerPendingRow {
  id: string
  personId: string
  noteId: string
  startMs: number
  endMs: number
  source: AudioSource | null
  askedAt: IsoTime
}

/** `addSpeakerPending`: `source` is optional (null counts every channel). */
export type NewSpeakerPending = Omit<SpeakerPendingRow, 'id' | 'askedAt' | 'source'> & { source?: AudioSource | null }

/** A `speaker_agreements` row, with its text. Main only; the renderer gets `SpeakerAgreementInfo`. */
export interface SpeakerAgreementRow {
  id: string
  personId: string
  attestedAt: IsoTime
  method: SpeakerAgreementMethod
  noticeVersion: string
  noticeLanguage: SpeakerNoticeLanguage
  noticeText: string
  evidenceText: string | null
  evidenceNoteId: string | null
  evidenceAtMs: number | null
  revokedAt: IsoTime | null
  revokedVia: SpeakerAgreementRevokedVia | null
}

export type NewSpeakerAgreement = Omit<SpeakerAgreementRow, 'id' | 'attestedAt' | 'revokedAt' | 'revokedVia'>

/** Counts of a voice delete (Forget, Forget all, expiry, switch off). Every one runs `secure_delete` + a TRUNCATE checkpoint. */
export interface SpeakerVoiceDeleted {
  exemplars: number
  spaces: number
  clusterVectors: number
  negatives: number
  pending: number
  agreementsStamped: number
}

export type NewTranscriptReport = Omit<TranscriptReport, 'id' | 'created_at'> & { excerpt: unknown[] }

export interface RecurringRecapRow {
  document_id: string
  content_version: string
  title: string
  bullets: string[]
  created_at: IsoTime
}

export interface SummaryFeedbackUpsert {
  panel_id: string
  document_id: string
  template_key: string
  direction?: SummaryFeedbackDirection | null
  comment?: string | null
  dismissed_at?: IsoTime | null
}

export type DispatchTodoUpsert = Omit<DispatchTodo, 'id' | 'created_at' | 'updated_at' | 'meeting_title' | 'meeting_at'>
export type DispatchInsert = Omit<Dispatch, 'id' | 'label' | 'created_at' | 'updated_at'>

export interface DispatchRunRow {
  run_day: string
  status: DispatchRunStatus
  started_at: IsoTime | null
  finished_at: IsoTime | null
  proposed: number
  archived: number
  reason: string | null
}

/** The companion CLI's note item. */
export interface ApiNoteItem {
  id: string
  title: string | null
  created_at: IsoTime
  updated_at: IsoTime
  type: 'meeting'
  status: string | null
  owner: { name: string | null; email: string | null }
  calendar_event: {
    event_title: string | null
    invitees: { email: string }[]
    organiser: string | null
    calendar_event_id: string | null
    scheduled_start_time: IsoTime | null
    scheduled_end_time: IsoTime | null
  } | null
  /** Content sources; null for a note without one. Optional until the source join lands. */
  source?: ApiNoteSource | null
}

/** A note item's `source` (content sources). */
export interface ApiNoteSource {
  kind: SourceKind
  provider: SourceProvider
  url: string | null
  title: string
  channel: string | null
  duration_ms: number | null
  live: boolean
  series: { id: string; kind: SeriesKind; title: string } | null
  lesson: { number: number | null; label: string | null; state: LessonState } | null
  confidence: SourceConfidence
  watched: { spans: { wall_start: number; wall_end: number; pos_start_ms: number; pos_end_ms: number; rate: number }[]; percent: number | null }
}

/** `notes.list` filters (content sources). */
export interface ApiNoteFilters {
  sourceKind?: SourceKind
  seriesId?: string
  hasSource?: boolean
  /** `false`: source notes in no series (the vault's unfiled inbox). */
  hasSeries?: boolean
}

/** A row of `series.list`. */
export interface ApiSeriesItem {
  id: string
  kind: SeriesKind
  provider: SourceProvider
  title: string
  folder_id: string | null
  state: SeriesState
  note_count: number
  catalog_count: number
  pending_count: number
  last_watched_at: IsoTime | null
}

/** `series.get`: lessons in catalog order, with note ids, pending and duplicates. */
export interface ApiSeriesDetail extends ApiSeriesItem {
  lessons: {
    number: number | null
    label: string | null
    section: string | null
    title: string
    url: string | null
    duration_ms: number | null
    note_id: string | null
    state: LessonState | null
    watched_percent: number | null
  }[]
  pending_note_ids: string[]
  duplicates: { canonical_key: string; note_ids: string[] }[]
}

/** The companion CLI's note list. */
export interface ApiNoteFull extends ApiNoteItem {
  notes_text: string
  notes_md: string
  summary_text: string | null
  summary_markdown: string | null
  /** Content sources: the stamped projection, a separate field (`notes_md` is unchanged). */
  notes_md_stamped?: string | null
}

/** The companion CLI's note detail, plus `transcript_purged_at`. */
export interface ApiTranscript {
  id: string
  title: string | null
  transcript_purged_at: IsoTime | null
  transcript: {
    id: string
    text: string
    source: AudioSource
    is_final: boolean
    start_timestamp: IsoTime
    end_timestamp: IsoTime
    /** Content sources: the chunk's video position, for a source note. */
    position_ms?: number | null
  }[]
}

/** The companion CLI's transcript. */
export interface ApiFolder {
  id: string
  name: string
  parent_folder_id: string | null
  visibility: string
  document_count: number
}

export type NewWorkflowBlock = Omit<WorkflowBlock, 'id' | 'created_at' | 'updated_at' | 'execution' | 'dismissed_at'>

/** `upsertWebhookEndpoint`: the endpoint plus its two secret ids (the values live in `secrets`). */
export type WebhookEndpointRow = WebhookEndpoint & { url_secret_id: string; signing_secret_id: string }

/** A note in a data export, with its sanitized, de-duplicated base name. */
export interface ExportNoteRef {
  id: string
  baseName: string
  trashed: boolean
  hasTranscript: boolean
  /** The Markdown export's folder: the note's Notula folders, `/`-separated, each part sanitized ('' = the root). */
  relDir?: string
}

// ---------- content sources (sources-repo.ts) ----------

/** `createNoteSource`: a note's source. Unset optional fields take their defaults. */
export interface NewNoteSource {
  note_id: string
  kind: SourceKind
  provider: SourceProvider
  canonical_key: CanonicalKey
  url: string | null
  title: string
  channel?: string | null
  duration_ms?: number | null
  live?: boolean
  series_id?: string | null
  lesson_number?: number | null
  lesson_label?: string | null
  /** Default `pending`. */
  lesson_state?: LessonState
  lesson_origin?: LessonOrigin | null
  confidence: SourceConfidence
  detected_via: SourceDetectedVia
  enrichment?: SourceEnrichment | null
  /** Default `none`. */
  track_state?: SourceTrackState
  track_language?: string | null
  /** Default `pending`. */
  transcript_plan?: TranscriptPlan
  generated_title?: string | null
}

/**
 * `updateNoteSource`: the renderer-reachable `NoteSourcePatch` plus the main-only fields.
 * Unset fields are kept; `null` clears a nullable one.
 */
export type NoteSourceUpdate = NoteSourcePatch &
  Partial<
    Pick<
      NoteSource,
      | 'kind'
      | 'provider'
      | 'canonical_key'
      | 'duration_ms'
      | 'live'
      | 'lesson_state'
      | 'lesson_origin'
      | 'confidence'
      | 'detected_via'
      | 'enrichment'
      | 'track_state'
      | 'track_language'
      | 'transcript_plan'
      | 'superseded_session_ids'
      | 'generated_title'
    >
  >

/** A non-trashed note with a given canonical key (`findNotesBySource`), newest first. */
export interface SourceNoteMatch {
  noteId: string
  title: string | null
  createdAt: IsoTime
  confidence: SourceConfidence
  /** The end of the newest watched span (epoch ms → ISO), or null. */
  lastWatchedAt: IsoTime | null
  /** The newest span's end position: where Continue picks up. */
  lastPositionMs: number | null
}

export type NewSourceSpan = Pick<SourceSpan, 'wall_start' | 'wall_end' | 'pos_start_ms' | 'pos_end_ms' | 'rate'>

/** `upsertSeries`: found by (kind, provider, canonical_key) for the local owner. */
export interface NewSourceSeries {
  kind: SeriesKind
  provider: SourceProvider
  canonical_key: CanonicalKey
  title: string
  folder_id?: string | null
  /** Default `active`. */
  state?: SeriesState
}

export type SourceSeriesPatch = Partial<Pick<SourceSeries, 'title' | 'folder_id' | 'state'>>

export type NewCatalogItem = Pick<CatalogItem, 'number' | 'section' | 'title' | 'url' | 'canonical_key' | 'duration_ms'>

/** `applyLessonNumbers`: one note's number from a catalog, a playlist or the extension. */
export interface LessonNumberUpdate {
  noteId: string
  lesson_number: number | null
  lesson_label: string | null
  lesson_state: LessonState
  lesson_origin: LessonOrigin | null
}

/** A stored merge (`source_merges`); `extra` is the caller's own undo data. */
export interface SourceMergeRecord {
  mergeId: string
  keptNoteId: string
  trashedNoteId: string
  extra: unknown
  createdAt: IsoTime
  undoneAt: IsoTime | null
}

/** What `mergeSourceNotes` moved onto the kept note. */
export interface SourceMergeMoved {
  sessions: number
  chunks: number
  spans: number
  panels: number
  attachments: number
  folders: number
  attendees: number
}

// ---------- Markdown importer (imports-md-repo.ts) ----------

export interface NewImportItem {
  id?: string
  source_key: string
  rel_path: string
  format: ImportFormat
  content_hash: string
  size_bytes: number
  export_note_id?: string | null
  candidates?: CandidateLink[]
  meta?: Record<string, unknown>
  imported_title?: string | null
}

export interface NewImportBatch {
  id?: string
  root_path: string
  preset: ImportPreset
  options: ImportOptions
  items: NewImportItem[]
}

export interface ImportBatchPatch {
  state?: ImportBatchState
  error?: string | null
  created_folder_ids?: string[]
  finished_at?: IsoTime | null
}

export interface ImportItemPatch {
  state?: ImportItemState
  reason?: string | null
  content_hash?: string
  candidates?: CandidateLink[]
  meta?: Record<string, unknown>
}

/** An earlier imported item matching a key, a hash or both, with its note's standing. */
export interface ImportMatchItem {
  id: string
  batch_id: string
  source_key: string
  rel_path: string
  content_hash: string
  state: ImportItemState
  note_id: string | null
  /** `purged`: the note was deleted for good (its id is gone). */
  note_state: 'live' | 'trashed' | 'purged'
}

export interface ImportMatches {
  items: ImportMatchItem[]
  /** Notula export ids that exist as notes here. */
  exportNotes: { id: string; state: 'live' | 'trashed' }[]
}

/** One item's note, written in one transaction by `importNoteItem`. */
export interface ImportNotePayload {
  itemId: string
  note: {
    /** A Notula export's id, kept when no note has it; otherwise a new one is made. */
    id?: string | null
    title: string | null
    created_at: IsoTime
    updated_at: IsoTime
    created_via: CreationSource
    notes_md: string
    notes_text: string
    people?: NotePeople | null
    tags?: DocumentTag[]
    /** A Notula export's Trash entry, imported into Trash. */
    trashed?: boolean
  }
  /** Summary panels: `content_markdown` is the seed, `content` stays null. */
  panels: { title: string; template_key: string | null; content_markdown: string }[]
  transcript: {
    session: {
      id?: string
      provider: TranscriptProviderId
      model: string
      language: string
      started_at: IsoTime
      ended_at: IsoTime
      end_reason: string
    }
    chunks: {
      source: AudioSource
      start_timestamp: IsoTime
      end_timestamp: IsoTime
      text: string
      detected_speaker_name?: string | null
    }[]
  } | null
  /** Memberships with source `add_notes`. */
  folderIds: string[]
  /** A source to link at once (a Notula export's source block). */
  source?: Omit<NewNoteSource, 'note_id'> | null
}

/** `getImportCandidates`: the newest done item of each note. */
export interface ImportCandidateRow {
  noteId: string
  itemId: string
  batchId: string
  relPath: string
  format: ImportFormat
  candidates: CandidateLink[]
  meta: Record<string, unknown>
}

export interface StorageApi {
  // lifecycle
  open(): Promise<StorageStatus>
  status(): Promise<StorageStatus>
  recover(action: RecoveryAction): Promise<StorageStatus>
  identity(): Promise<StorageIdentity>
  /** Subscribes to committed write batches; returns the unsubscribe function. */
  onChange(cb: (change: StorageChange) => void): () => void
  close(): Promise<void>

  // notes
  listNotes(q: NotesListQuery): Promise<NoteListPage>
  getNote(id: string, opts?: { includeDeleted?: boolean }): Promise<Note | null>
  createNote(input: NoteCreateInput & { created_via: CreationSource }): Promise<Note>
  updateNote(id: string, patch: NotePatch): Promise<Note>
  /** Main-only: replaces the note's attached links; never reachable from a renderer patch. */
  setAttachedLinks(id: string, links: AttachedLink[]): Promise<Note>
  trashNote(id: string): Promise<void>
  restoreNote(id: string): Promise<void>
  findNoteByEvent(eventId: string, startTime?: IsoTime): Promise<Note | null>
  /** Main-only field. */
  setTranscribe(id: string, value: boolean): Promise<void>
  /** Main-only field. Resolves with the new count. */
  incrementMeetingEndCount(id: string): Promise<number>

  // ydoc (compaction is internal)
  loadYdoc(roomId: string): Promise<YdocState>
  appendYdoc(roomId: string, update: Uint8Array, origin: string): Promise<{ seq: number }>

  // panels
  listPanels(noteId: string, opts?: { includeDeleted?: boolean }): Promise<Panel[]>
  getPanel(id: string): Promise<Panel | null>
  createPanel(p: NewPanel): Promise<Panel>
  /** The full internal patch, generation fields included. */
  updatePanel(id: string, patch: Partial<Panel>): Promise<Panel>
  listGeneratingPanels(): Promise<Panel[]>

  // transcript
  /** Without the chunks of the note's superseded sessions (content sources); unchanged for every other note. */
  getTranscript(noteId: string): Promise<TranscriptChunk[]>
  /** One transaction. */
  upsertChunks(chunks: TranscriptChunk[]): Promise<void>
  createSession(s: NewTranscriptionSession): Promise<void>
  endSession(id: string, ended_at: IsoTime, end_reason: string): Promise<void>
  latestSession(noteId: string): Promise<TranscriptionSession | null>

  // settings
  getSettingsRaw(): Promise<Partial<Settings>>
  setSettingRaw<K extends SettingKey>(key: K, value: Settings[K]): Promise<void>

  // secrets: safeStorage ciphertext only; main does the safeStorage work
  getSecretBlob(id: SecretId): Promise<Uint8Array | null>
  setSecretBlob(id: SecretId, blob: Uint8Array): Promise<void>
  deleteSecretBlob(id: SecretId): Promise<void>
  /** The ids only, never a value (the diagnostics scrub). */
  listSecretIds(): Promise<SecretId[]>

  // library
  /** The notes Trash lists, newest deletion first. */
  listTrash(): Promise<TrashItem[]>
  /**
   * One transaction: the note, its panels, FTS rows and queue entries, transcript
   * sessions and chunks, every Yjs row of its rooms (quarantine copies included), and
   * `file_deletions` rows for its temp audio. Rejects `invalid-input` unless `deleted_at` is set.
   */
  deleteNotePermanently(id: string): Promise<{ roomsDeleted: number }>
  /** null when the note does not exist. */
  noteEmptiness(id: string): Promise<NoteEmptiness | null>
  /** Sets only `deleted_at` and `updated_at` (auto-delete). */
  markNoteDeleted(id: string): Promise<void>
  queryNotes(q: NoteQuery): Promise<NoteListItem[]>
  searchFts(q: FtsQuery): Promise<FtsHit[]>
  /** The sync seam; no caller yet. */
  exportYdocState(roomId: string): Promise<{ stateBase64: string; version: number }>

  // templates: rows only; built-ins are merged by main
  listTemplates(): Promise<NoteTemplate[]>
  getTemplate(id: string): Promise<NoteTemplate | null>
  createTemplate(t: NoteTemplateCreate): Promise<NoteTemplate>
  updateTemplate(id: string, patch: NoteTemplatePatch & { deleted_at?: IsoTime | null }): Promise<NoteTemplate>

  // recipes: rows only; built-ins are merged by main
  listRecipes(): Promise<Recipe[]>
  getRecipe(id: string): Promise<Recipe | null>
  upsertRecipe(r: RecipeUpsert): Promise<Recipe>
  setRecipeDeleted(id: string, deleted: boolean): Promise<void>

  // chat
  /** Pinned first, then `updated_at` descending. */
  listChatThreads(q: ChatThreadQuery): Promise<ChatThread[]>
  getChatThread(id: string): Promise<ChatThread | null>
  upsertChatThread(t: ChatThreadUpsert): Promise<ChatThread>
  /** Soft; its messages too. */
  deleteChatThread(id: string): Promise<void>
  /** Turn order: by turn index, the user message first within a turn, then creation time. */
  listChatMessages(threadId: string): Promise<ChatMessage[]>
  /** Also bumps the thread's `updated_at`. */
  upsertChatMessage(m: ChatMessageUpsert): Promise<ChatMessage>
  /** Soft-deletes every message after `messageId`; resolves with the count. */
  truncateChatMessagesAfter(threadId: string, messageId: string): Promise<number>

  // calendar
  /** Not deleted. */
  listCalendarSources(): Promise<CalendarSourceRow[]>
  upsertCalendarSource(s: CalendarSourceRow): Promise<CalendarSourceRow>
  /** The held incremental grants. The upsert never writes them. */
  setCalendarSourceGrants(sourceId: string, grants: CalendarGrant[]): Promise<void>
  /** Soft-deletes the source; hard-deletes its calendars and events. */
  removeCalendarSource(id: string): Promise<{ eventsDeleted: number }>
  listCalendars(sourceId?: string): Promise<CalendarInfo[]>
  /** Keeps each existing calendar's visibility; new calendars are visible when in `defaults.visibleIds`. */
  replaceCalendars(
    sourceId: string,
    calendars: Omit<CalendarInfo, 'visible'>[],
    defaults: { visibleIds: string[] }
  ): Promise<CalendarInfo[]>
  /** Hiding deletes that calendar's events. */
  setCalendarVisible(calendarId: string, visible: boolean): Promise<{ eventsDeleted: number }>
  /**
   * One transaction: upsert `events`, then delete this source's rows in `scope.calendarIds`
   * that are missing from them.
   */
  replaceSourceEvents(
    sourceId: string,
    events: CalendarEvent[],
    scope: { calendarIds: string[] }
  ): Promise<{ upserted: number; deleted: number }>
  /** Display dedupe: an OAuth row before an ICS row, then the lowest id. */
  listEventsInRange(q: { from: IsoTime; to: IsoTime }): Promise<CalendarEvent[]>
  getCalendarEvent(id: string): Promise<CalendarEvent | null>
  /** Coming up. */
  upcomingEvents(q: { page: number; now: IsoTime; filterPersonal: boolean; myEmails: string[] }): Promise<UpcomingPage>
  /** Notes follow their events; resolves with the changed note ids. */
  followEventUpdates(events: CalendarEvent[]): Promise<string[]>
  /** The known participants. */
  participants(q: { query: string; noteId?: string; myEmails: string[]; limit: number }): Promise<Participant[]>

  // folders
  listFolders(): Promise<FoldersState>
  /** Rejects `invalid-input` for a third level. */
  createFolder(f: FolderCreate): Promise<Folder>
  /** `is_favourite` cascades to descendants; a `parent_id` change is validated (no third level, no cycle). */
  updateFolder(id: string, patch: FolderPatch): Promise<Folder>
  /** One transaction: lifts subfolders to the parent, removes memberships and rules; never touches notes. */
  deleteFolder(id: string): Promise<void>
  /** Idempotent; bumps the folder's `updated_at`. Resolves with the number of notes added. */
  addNotesToFolder(folderId: string, noteIds: string[], source: FolderNoteSource): Promise<number>
  removeNoteFromFolder(folderId: string, noteId: string): Promise<void>
  /** Replaces the rule for the same series in that folder. */
  setFolderRule(r: FolderRuleInput): Promise<FolderRule>
  deleteFolderRule(id: string): Promise<void>

  // search
  /** The search page's local query. */
  searchNotes(query: string): Promise<SearchResponse>

  // speaker names
  listSpeakerNameSuggestions(noteId: string): Promise<SpeakerNameSuggestion[]>
  /** One transaction: deletes the note's rows, inserts in order. */
  replaceSpeakerNameSuggestions(noteId: string, rows: Omit<SpeakerNameSuggestion, 'created_at'>[]): Promise<void>
  deleteSpeakerNameSuggestion(noteId: string, identityKey: string): Promise<void>
  /** One row's band, candidates or pending flag; a missing row is a no-op. */
  patchSpeakerNameSuggestion(
    noteId: string,
    identityKey: string,
    patch: { band?: SpeakerBand; candidates?: SpeakerCandidate[]; pending?: boolean }
  ): Promise<void>

  // speaker profiles (main only; src/main/storage/speaker-*-repo.ts). Every delete of a vector
  // runs with `secure_delete` on, then a TRUNCATE checkpoint. No vector reaches a log.
  // people
  /** Idempotent: one `is_self` row per owner. Its name follows `profile.name`, "Me" while empty. Also run at storage start. */
  ensureSelfPerson(displayName: string | null): Promise<SpeakerPersonRow>
  /** `resolveMerged` follows `merged_into` to the surviving person. */
  getSpeakerPerson(id: string, opts?: { resolveMerged?: boolean }): Promise<SpeakerPersonRow | null>
  findSpeakerPersonByEmail(email: string): Promise<SpeakerPersonRow | null>
  /** Unmerged people; by name or email when `query` is set; most recently matched first. */
  listSpeakerPeople(q: { query?: string; ids?: string[]; limit: number }): Promise<SpeakerPersonRow[]>
  /** `invalid-input` when the email is taken (UNIQUE per owner). */
  createSpeakerPerson(p: { displayName: string; email: string | null }): Promise<SpeakerPersonRow>
  updateSpeakerPerson(
    id: string,
    patch: { displayName?: string; autoRecognize?: boolean; lastMatchedAt?: IsoTime }
  ): Promise<SpeakerPersonRow>
  linkSpeakerPersonEmail(id: string, email: string): Promise<{ ok: true } | { taken: { personId: string; name: string } }>
  previewSpeakerMerge(q: { fromId: string; intoId: string }): Promise<SpeakerMergePreview>
  /**
   * Moves exemplars, voice spaces, negatives, matches, pending requests and agreements, then
   * re-applies the cap. Into the user: refused (`invalid-input`) while the other person
   * has a sample, an agreement record or a pending request.
   */
  mergeSpeakerPeople(q: { fromId: string; intoId: string }): Promise<SpeakerMergePreview>
  /**
   * Refused (`invalid-input`) unless the person has no voice, no agreement record and no pending
   * request, and for a merged row. The rows merged into the person go with it.
   */
  deleteSpeakerPerson(id: string): Promise<void>
  /** Known people: matched since `since`, plus the people of `recurringEventId`'s series; at most `limit` by recency. */
  knownSpeakerPeople(q: { noteId: string; since: IsoTime; recurringEventId: string | null; limit: number }): Promise<KnownSpeakerPerson[]>
  /**
   * `speaker-people:get`. `modelId` is the installed extractor's id (null when missing), for `stale`.
   * A pending meeting's `canName` is a display hint (any live vector in the note): `name-pending`
   * re-resolves the span to the current cluster and checks its vector and that it is unnamed.
   */
  speakerPersonView(q: { personId: string; modelId: string | null }): Promise<SpeakerPersonView | null>
  /**
   * The counts of `speakers:get-status`, and `movedFromLabs`: migration 12 found the Labs switch
   * on or a Labs self voiceprint.
   */
  speakerVoiceSummary(q: { modelId: string | null }): Promise<{
    peopleWithVoice: number
    peopleWithAgreement: number
    self: { present: boolean; sampleCount: number; updatedAt: IsoTime | null }
    movedFromLabs: boolean
  }>
  // exemplars and voice spaces
  /** The matching gallery of one model: the unmerged people's voice spaces, with their exemplars. */
  speakerVoiceGallery(q: { modelId: string; personIds?: string[] }): Promise<SpeakerVoiceSpaceRow[]>
  /** Applies the agreement guard, the far-from-profile check and the cap; recomputes the centroid exactly. */
  addSpeakerExemplar(e: NewSpeakerExemplar): Promise<AddSpeakerExemplarResult>
  listSpeakerSamples(personId: string): Promise<SpeakerSampleRow[]>
  /** Recomputes the centroid exactly. Resolves with the person, or null when the sample is gone. */
  removeSpeakerExemplar(id: string): Promise<{ personId: string } | null>
  /**
   * Once, at first start on schema 12. `aliasModelId` (the ResNet-34 file's SHA when it is
   * the shipped extractor): legacy centroids become self `legacy` exemplars. Otherwise they are
   * secure-deleted. Either way the legacy table ends empty.
   */
  convertLegacyVoiceprints(q: { aliasModelId: string | null }): Promise<{ converted: number; deleted: number }>
  // cluster vectors (the 14-day store)
  /** Skips every row while `speakers.voices` is off (read in the same transaction) and rows of a trashed note. */
  saveSpeakerClusterVectors(rows: NewSpeakerClusterVector[]): Promise<void>
  listSpeakerClusterVectors(q: { noteId: string; passId?: string; modelId?: string }): Promise<SpeakerClusterVectorRow[]>
  /** Notes that still hold a cluster vector of this model (relabel's fan-out). */
  notesWithSpeakerClusterVectors(q: { modelId: string }): Promise<string[]>
  /**
   * `labels` limits it to those clusters of `passId`. Resolves with the count deleted. `{all}` or a
   * whole note (no `passId`) also drops the pending requests left without a vector;
   * a pass or labels leave pending requests to the caller (re-pass re-map, naming).
   */
  deleteSpeakerClusterVectors(q: { noteId: string; passId?: string; labels?: string[] } | { all: true }): Promise<number>
  // negatives
  addSpeakerNegative(n: Omit<SpeakerNegativeRow, 'createdAt'>): Promise<void>
  deleteSpeakerNegative(q: { noteId: string; identityKey: string; personId: string }): Promise<void>
  listSpeakerNegatives(noteId: string): Promise<SpeakerNegativeRow[]>
  /** Re-pass: each old identity key moves to its successor of `passId`; `to: null` deletes it. */
  remapSpeakerNegatives(q: { noteId: string; passId: string; map: { from: string; to: string | null }[] }): Promise<void>
  // pending requests
  /** `invalid-input` when the note holds no live cluster vector. */
  addSpeakerPending(p: NewSpeakerPending): Promise<SpeakerPendingRow>
  listSpeakerPending(q: { personId?: string; noteId?: string }): Promise<SpeakerPendingRow[]>
  deleteSpeakerPending(ids: string[]): Promise<number>
  // agreements
  recordSpeakerAgreement(a: NewSpeakerAgreement): Promise<SpeakerAgreementRow>
  /** The active record, else the latest revoked one. */
  getSpeakerAgreement(personId: string): Promise<SpeakerAgreementRow | null>
  /** Every record of the person, newest first (Export agreement record keeps the history). */
  listSpeakerAgreements(personId: string): Promise<SpeakerAgreementRow[]>
  /** Revoked records only (Remove record); `invalid-input` for an active one. */
  deleteSpeakerAgreement(personId: string): Promise<void>
  // forget and sweeps
  /** Exemplars, voice spaces and pending requests of the person; the active agreement is stamped `via`. */
  forgetSpeakerVoice(q: { personId: string; via: Exclude<SpeakerAgreementRevokedVia, 'forget_all'> }): Promise<SpeakerVoiceDeleted>
  /**
   * Every exemplar, voice space, cluster vector, negative and pending request; active agreements
   * are stamped `forget_all`. `keepSelf`: the self person's exemplars and voice spaces stay.
   */
  forgetAllSpeakerVoices(q: { keepSelf: boolean }): Promise<SpeakerVoiceDeleted>
  /**
   * Cluster vectors past `expires_at` (14 days), every pending request whose note holds no live
   * vector, and voices not matched for 365 days (stamped `expired`). `modelId` (the installed
   * extractor's id): cluster vectors of another model go too. With `speakers.voices` off,
   * every cluster vector goes.
   */
  sweepSpeakerData(q: { now: IsoTime; modelId?: string }): Promise<{ clusterVectors: number; peopleExpired: string[] }>
  // matches
  /** One row per (note, person, kind), refreshed. */
  recordSpeakerMatches(rows: { noteId: string; personId: string; kind: SpeakerMatchKind }[]): Promise<void>
  listSpeakerMatches(personId: string): Promise<SpeakerMatchRow[]>

  // recordings
  createRecording(r: NewRecording): Promise<RecordingRow>
  updateRecording(
    id: string,
    patch: { ended_at?: IsoTime | null; duration_ms?: number; bytes?: number; state?: RecordingState }
  ): Promise<void>
  listRecordings(q: { noteId?: string; endedBefore?: IsoTime; states?: RecordingState[] }): Promise<RecordingRow[]>
  /** Files are queued by trigger. */
  deleteRecordings(ids: string[]): Promise<{ deleted: string[] }>
  recordingsUsage(): Promise<RecordingsUsage>
  /** At startup: `recording` rows become `incomplete`. Resolves with the count. */
  markInterruptedRecordings(): Promise<number>

  // imports
  createImportJob(j: { id: string; file_name: string; source_path: string; size_bytes: number }): Promise<ImportJob>
  updateImportJob(
    id: string,
    patch: { note_id?: string | null; phase?: ImportJob['phase']; error?: string | null; engine?: ImportJob['engine'] }
  ): Promise<ImportJob>
  listImportJobs(): Promise<ImportJobRow[]>
  deleteImportJob(id: string): Promise<void>

  // attachments
  /**
   * Encrypts with a fresh key, writes `<id>.bin.partial`, inserts the row and, for a
   * counted note image, appends the NoteAttachment record to `documents.attachments`, in
   * one transaction; renames after commit. Rejects `invalid-input: Maximum of 10 attachments reached`.
   */
  createAttachment(a: NewAttachment): Promise<AttachmentInfo>
  /** Decrypts and verifies `sha256`; null (and a log line) when unavailable. */
  readAttachment(id: string): Promise<{ mimeType: string; bytes: Uint8Array } | null>
  /** A `screen_capture_info` patch also updates the note's record; `parent_id` re-parents. */
  updateAttachment(id: string, patch: AttachmentPatch): Promise<AttachmentInfo>
  listAttachments(q: { parentType: AttachmentParentType; parentId: string } | { ids: string[] }): Promise<AttachmentInfo[]>
  attachmentContent(id: string): Promise<{
    file_name: string
    mime_type: string
    content_markdown: string | null
    content_summary: string | null
  } | null>
  /** The row, the note's record and the file, in one operation. */
  deleteAttachment(id: string): Promise<void>

  // action items
  listActionItems(q: ActionItemsQuery): Promise<ActionItem[]>
  /** Replaces the note's unreviewed, unarchived items. */
  replaceNoteActionItems(noteId: string, panelId: string, items: NewActionItem[]): Promise<ActionItem[]>
  reviewActionItem(id: string, review: ActionItemReview, reason?: string): Promise<ActionItem>
  archiveActionItem(id: string): Promise<void>
  addActionItemFeedback(f: ActionItemFeedbackInput): Promise<ActionItemFeedback>
  setActionItemDraftThread(id: string, threadId: string): Promise<void>
  /** One transaction. */
  applyRegeneratedActionItems(noteIds: string[], items: RegeneratedActionItem[]): Promise<{ insertedCount: number; inserted: AppliedActionItem[] }>

  // tags
  /** Keeps a `manual` meeting type. */
  setClassifierTags(noteId: string, t: { meetingType: string; isSensitive: boolean }): Promise<DocumentTag[]>
  setManualMeetingType(noteIds: string[], value: string | null): Promise<{ undoToken: string }>
  undoManualMeetingType(undoToken: string): Promise<number>

  // follow-up
  getFollowUpDraft(q: { noteId: string } | { id: string }): Promise<FollowUpDraft | null>
  upsertFollowUpDraft(d: FollowUpDraftUpsert): Promise<FollowUpDraft>
  listFollowUpDrafts(q: { createdAfter: IsoTime }): Promise<FollowUpDraft[]>

  // people
  listPeople(q: PeopleQuery & { myEmails: string[] }): Promise<PersonRow[]>
  getPerson(email: string, myEmails: string[]): Promise<PersonDetail | null>
  listCompanies(q: CompaniesQuery & { myEmails: string[]; genericDomains: string[] }): Promise<CompanyRow[]>
  getCompany(domain: string, o: { myEmails: string[]; genericDomains: string[] }): Promise<CompanyDetail | null>

  // recipe usage
  recordRecipeUse(recipeId: string): Promise<{ total_count: number }>
  recipeUsage(): Promise<RecipesUsage>
  setRecipeSaved(recipeId: string, saved: boolean): Promise<void>
  listSavedRecipeIds(): Promise<string[]>

  // company icons
  getCompanyIcon(domain: string): Promise<CompanyIconRow | null>
  putCompanyIcon(row: CompanyIconRow): Promise<void>
  deleteAllCompanyIcons(): Promise<number>

  // briefs
  getBrief(eventId: string): Promise<PrepBrief | null>
  upsertBrief(b: PrepBriefUpsert): Promise<PrepBrief>
  /** The prep brief's three context groups; trashed and demo notes excluded. */
  briefContext(q: BriefContextQuery): Promise<BriefContextNote[]>

  // integrations
  listIntegrationDestinations(q?: { provider?: IntegrationProvider; ids?: string[] }): Promise<IntegrationDestinationRow[]>
  upsertIntegrationDestination(d: IntegrationDestinationRow): Promise<IntegrationDestinationRow>
  deleteIntegrationDestinations(q: { provider: IntegrationProvider; id?: string }): Promise<{
    deleted: IntegrationDestinationRow[]
  }>
  listIntegrationAutomations(q: {
    folderId?: string
    provider?: IntegrationProvider
    enabledOnly?: boolean
  }): Promise<IntegrationAutomation[]>
  /** Stamps `enabled_at` when turned on. */
  upsertIntegrationAutomation(a: IntegrationAutomationInput & { id?: string }): Promise<IntegrationAutomation>
  setIntegrationAutomationsEnabled(provider: IntegrationProvider, enabled: boolean): Promise<number>
  /** One transaction behind the UNIQUE (automation_id, note_id) guard. */
  claimAutomationRun(
    automationId: string,
    noteId: string,
    result: 'queued' | 'no_targets',
    deliveries: NewIntegrationDelivery[]
  ): Promise<{ created: boolean; deliveries: IntegrationDelivery[] }>
  createIntegrationDeliveries(ds: NewIntegrationDelivery[]): Promise<IntegrationDelivery[]>
  updateIntegrationDelivery(id: string, patch: IntegrationDeliveryPatch): Promise<IntegrationDelivery>
  listIntegrationDeliveries(q: {
    provider?: IntegrationProvider
    noteId?: string
    statuses?: IntegrationDelivery['status'][]
    limit: number
  }): Promise<IntegrationDelivery[]>
  dueIntegrationDeliveries(now: IsoTime, limit: number): Promise<IntegrationDelivery[]>
  /**
   * Enabled rules × notes added to the folder after `enabled_at` and after `since`,
   * whose summary completed with content, without a run row.
   */
  pendingAutomationNotes(since: IsoTime): Promise<{ automationId: string; noteId: string }[]>
  expireIntegrationDeliveries(before: IsoTime): Promise<number>

  // MCP
  listMcpConnections(): Promise<McpConnectionRow[]>
  upsertMcpConnection(c: McpConnectionRow): Promise<McpConnectionRow>
  deleteMcpConnection(id: string): Promise<void>
  listMcpServerTokens(): Promise<McpLocalServerToken[]>
  createMcpServerToken(t: {
    id: string
    name: string
    kind: McpLocalServerToken['kind']
    token_hash: string
  }): Promise<McpLocalServerToken>
  findMcpServerToken(tokenHash: string): Promise<(McpLocalServerToken & { token_hash: string }) | null>
  touchMcpServerToken(id: string, at: IsoTime): Promise<void>
  deleteMcpServerToken(id: string): Promise<void>

  // dictation
  createDictationAttempt(a: {
    id: string
    created_at: IsoTime
    language: string | null
    audio_key: Uint8Array | null
  }): Promise<DictationAttempt>
  updateDictationAttempt(id: string, patch: DictationAttemptPatch): Promise<DictationAttempt>
  listDictationAttempts(limit: number): Promise<DictationAttempt[]>
  /** With `audio_key`. */
  getDictationAttempt(id: string): Promise<DictationAttemptRow | null>
  /**
   * Files are queued by trigger. `forget` (with `ids`): drop the audio, delete rows without a
   * word count, and keep the rest as usage only (no text, no expiry).
   */
  deleteDictationAttempts(q: { ids?: string[]; all?: true; expiredBefore?: IsoTime; forget?: true }): Promise<{ deleted: string[] }>
  markInterruptedDictations(): Promise<number>

  // scratchpad
  listScratchpadDays(today: string): Promise<ScratchpadDaySummary[]>
  getScratchpadDay(date: string): Promise<ScratchpadDay>
  saveScratchpadDay(date: string, content: unknown, hasText: boolean): Promise<{ updatedAt: IsoTime }>

  // data export. Every write refuses a path outside `root`, a direct child folder main created for this export.
  /** The listable scope, plus Trash when asked; base names sanitized, cut to 120 characters and de-duplicated. */
  listExportNotes(q: { includeTrash: boolean; format?: DataExportFormat }): Promise<ExportNoteRef[]>
  /** At most 20 notes per call. `format: 'markdown'`: Export notes as Markdown. */
  writeExportNotes(q: { root: string; notes: ExportNoteRef[]; markdown: boolean; transcripts: boolean; format?: DataExportFormat }): Promise<{
    written: { id: string; notesFile: string | null; transcriptFile: string | null }[]
    errors: { noteId: string; message: string }[]
  }>
  writeExportIndex(q: {
    root: string
    rows: { id: string; notesFile: string | null; transcriptFile: string | null }[]
  }): Promise<void>
  writeExportReadme(q: { root: string; text: string }): Promise<void>
  /**
   * Encrypted: checkpoint, then the recovery file set plus `Local State`; decrypted:
   * `sqlcipher_export` into an attached plaintext database.
   */
  writeDatabaseCopy(q: { root: string; kind: 'encrypted' | 'decrypted'; localStatePath: string }): Promise<{ files: string[] }>

  // ---------- served by the repos in src/main/repos/ ----------
  // consent (src/main/repos/consent-repo.ts)
  getConsentPost(noteId: string): Promise<ConsentPostRow | null>
  upsertConsentPost(p: ConsentPostRow): Promise<ConsentPostRow>

  // voiceprint (main only; the vectors never cross IPC) (src/main/repos/voiceprint-repo.ts)
  getVoiceprint(modelId: string): Promise<VoiceprintRow | null>
  saveVoiceprint(v: VoiceprintRow): Promise<void>
  deleteVoiceprints(): Promise<number>

  // transcript reports (src/main/repos/transcript-reports-repo.ts)
  createTranscriptReport(r: NewTranscriptReport): Promise<TranscriptReport>
  listTranscriptReports(q: { noteId?: string }): Promise<TranscriptReport[]>
  deleteTranscriptReport(id: string): Promise<boolean>
  reportExcerpt(noteId: string, chunkIds?: string[]): Promise<{ text: string; excerpt: unknown[]; start: IsoTime | null; end: IsoTime | null }>

  // retention (src/main/repos/retention-repo.ts)
  previewRetention(q: { olderThan: IsoTime; skipNoteIds: string[] }): Promise<RetentionPreview>
  purgeTranscripts(q: { olderThan: IsoTime; skipNoteIds: string[]; batch: number }): Promise<{ notes: number; sections: number; recordings: number; bytes: number; noteIds: string[]; errors: string[]; more: boolean }>
  recordRetentionRun(r: RetentionRun): Promise<void>
  listRetentionRuns(limit: number): Promise<RetentionRun[]>
  deleteTranscriptSections(noteId: string, chunkIds: string[]): Promise<{ deleted: number }>

  // meeting dock (src/main/repos/meeting-dock-repo.ts)
  getMeetingDockHistory(noteId: string): Promise<MeetingDockHistory | null>
  saveMeetingDockHistory(h: MeetingDockHistory): Promise<void>

  // reminders (src/main/repos/reminders-repo.ts)
  listReminders(q: { statuses?: ReminderStatus[]; keys?: string[] }): Promise<Reminder[]>
  upsertReminders(rs: Reminder[]): Promise<Reminder[]>
  pruneReminders(before: IsoTime): Promise<number>

  // recurring recap (src/main/repos/recurring-recap-repo.ts)
  previousSeriesNote(q: { eventId: string; recurringEventId: string; before: IsoTime; candidates: number }): Promise<{ noteId: string; title: string | null; meetingAt: IsoTime; markdown: string; contentVersion: string } | null>
  getRecurringRecap(documentId: string, contentVersion: string): Promise<RecurringRecapRow | null>
  putRecurringRecap(r: RecurringRecapRow): Promise<void>

  // free slots (src/main/repos/live-context-repo.ts)
  findFreeSlot(q: { from: IsoTime; to: IsoTime; durationMin: number; workHours: { start: string; end: string }; tzOffsetMin: number; myEmails: string[] }): Promise<{ start: IsoTime; end: IsoTime } | null>

  // tasks (src/main/repos/tasks-repo.ts)
  listTasks(q: { since: IsoTime; showCompleted: boolean; includeOlder: boolean }): Promise<TasksList>
  toggleTaskItem(t: { panelId: string; nodePath: number[]; checked: boolean }): Promise<{ roomId: string; update: Uint8Array } | null>
  addManualTask(text: string): Promise<ManualTask>
  setManualTask(id: string, checked: boolean): Promise<void>
  deleteManualTask(id: string): Promise<void>
  taskBadge(since: IsoTime): Promise<number>

  // summary feedback (src/main/repos/summary-feedback-repo.ts)
  summaryFeedbackFacts(panelId: string): Promise<{ ownNotes: number; isLatestWithContent: boolean; isDemo: boolean; dismissed: boolean; templateSlug: string; documentId: string } | null>
  upsertSummaryFeedback(f: SummaryFeedbackUpsert): Promise<SummaryFeedback>
  listSummaryFeedback(templateSlug: string): Promise<SummaryFeedbackList>

  // user context (src/main/repos/user-context-repo.ts)
  listUserContextSections(): Promise<UserContextSection[]>
  upsertUserContextSection(s: { section_id: UserContextSectionId; content: string; origin: 'user' | 'drafted'; drafted_at: IsoTime | null }): Promise<UserContextSection>
  userContextPeople(q: { decayDays: number; limit: number; myEmails: string[] }): Promise<UserContextPerson[]>
  userContextDraftInputs(q: { since: IsoTime; notes: number; chars: number }): Promise<{ noteId: string; title: string | null; date: IsoTime; text: string }[]>
  /** The user's own notes with a transcript, demo notes aside, counted up to `cap`. */
  userContextRecordedNotes(q: { cap: number }): Promise<number>

  // dispatch (src/main/repos/dispatch-repo.ts)
  listDispatchTodos(q: { statuses?: DispatchTodoStatus[]; since?: IsoTime }): Promise<DispatchTodo[]>
  upsertDispatchTodos(ts: DispatchTodoUpsert[]): Promise<DispatchTodo[]>
  setDispatchTodoStatus(id: string, status: DispatchTodoStatus): Promise<void>
  listDispatches(q: { view: 'today' | 'archived'; day: string }): Promise<Dispatch[]>
  insertDispatches(ds: DispatchInsert[]): Promise<Dispatch[]>
  resurfaceDispatches(items: { id: string; day: string; reason: string }[]): Promise<void>
  archiveUnstartedDispatches(beforeDay: string): Promise<number>
  setDispatch(id: string, patch: { status?: DispatchStatus; thread_id?: string }): Promise<void>
  getDispatchRun(day: string): Promise<DispatchRunRow | null>
  upsertDispatchRun(r: DispatchRunRow): Promise<void>
  pruneDispatchRuns(beforeDay: string): Promise<number>

  // local API (key hashes never leave main) (src/main/repos/local-api-repo.ts)
  listLocalApiKeys(): Promise<LocalApiKey[]>
  createLocalApiKey(k: { id: string; description: string; scopes: LocalApiScope[]; key_hash: string; expires_at: IsoTime | null }): Promise<LocalApiKey>
  findLocalApiKey(keyHash: string): Promise<(LocalApiKey & { key_hash: string }) | null>
  updateLocalApiKey(id: string, patch: { description?: string; scopes?: LocalApiScope[]; revoked_at?: IsoTime }): Promise<LocalApiKey>
  touchLocalApiKey(id: string, at: IsoTime): Promise<void>
  deleteLocalApiKey(id: string): Promise<void>
  apiListNotes(
    q: { limit: number; offset: number; createdAfter?: IsoTime; createdBefore?: IsoTime } & ApiNoteFilters
  ): Promise<{ notes: ApiNoteItem[]; hasMore: boolean }>
  apiGetNotes(ids: string[]): Promise<{ notes: ApiNoteFull[]; notFound: string[] }>
  /** Superseded sessions are left out; `position_ms` follows the source rules. */
  apiTranscript(id: string): Promise<ApiTranscript | null>
  apiListFolders(q: { search?: string }): Promise<ApiFolder[]>
  /** `series.list`: the local owner's series, by title. */
  apiListSeries(): Promise<ApiSeriesItem[]>
  /** `series.get`; null when unknown. */
  apiGetSeries(id: string): Promise<ApiSeriesDetail | null>

  // content sources (src/main/storage/sources-repo.ts). Note-keyed writes publish the note id
  // under `note_sources` / `source_spans`; series writes publish the series id under
  // `source_series` / `series_catalog_items`.
  getNoteSource(noteId: string): Promise<NoteSource | null>
  /** The source plus its series, watched coverage and the other notes with its key; null without a source. */
  getNoteSourceView(noteId: string): Promise<NoteSourceView | null>
  /**
   * Links a source to a note (one per note). Rejects `invalid-input` when the note already has
   * one, unless `replace`: then every field comes from `input` and only the row id,
   * `created_at`, `notes_md_stamped` and `superseded_session_ids` are kept.
   */
  createNoteSource(input: NewNoteSource, opts?: { replace?: boolean }): Promise<NoteSource>
  updateNoteSource(noteId: string, patch: NoteSourceUpdate): Promise<NoteSource>
  /** Unlinks: the source row and the note's spans. Resolves false when there was none. */
  deleteNoteSource(noteId: string): Promise<boolean>
  /** Own, non-trashed notes with this key, newest first. */
  findNotesBySource(canonicalKey: CanonicalKey, opts?: { excludeNoteId?: string; limit?: number }): Promise<SourceNoteMatch[]>
  /** Sources of own, non-trashed notes, by series and/or note ids (at least one). Oldest note first. */
  listNoteSources(q: { seriesId?: string; noteIds?: string[] }): Promise<NoteSource[]>
  /** Appends spans (one transaction). Beyond 5,000 per note the oldest neighbours merge pairwise. */
  addSourceSpans(noteId: string, spans: NewSourceSpan[]): Promise<{ added: number; merged: number }>
  /** By wall start. */
  listSourceSpans(noteId: string): Promise<SourceSpan[]>
  /** Finds or creates; an existing series keeps its title unless that is empty. */
  upsertSeries(input: NewSourceSeries): Promise<{ series: SourceSeries; created: boolean }>
  getSeries(id: string): Promise<SourceSeries | null>
  /** The series filed into this folder, if any (the oldest when several are). */
  findSeriesByFolder(folderId: string): Promise<SourceSeries | null>
  /** With note, catalog and pending counts, by title. */
  listSeries(): Promise<SeriesListItem[]>
  /** Lessons in catalog order, then the series' notes the catalog doesn't cover; duplicates. */
  getSeriesDetail(id: string): Promise<SeriesDetail | null>
  updateSeries(id: string, patch: SourceSeriesPatch): Promise<SourceSeries>
  pauseSeries(id: string): Promise<SourceSeries>
  /** One transaction: the series' catalog becomes `items`, in order (at most 2,000). */
  replaceCatalog(seriesId: string, items: NewCatalogItem[]): Promise<CatalogItem[]>
  listCatalog(seriesId: string): Promise<CatalogItem[]>
  deleteCatalog(seriesId: string): Promise<number>
  /** A catalog item by canonical key, then by URL. */
  findCatalogItem(seriesId: string, q: { canonicalKey?: string | null; url?: string | null }): Promise<CatalogItem | null>
  /**
   * Writes lesson numbers; a `manual` number is never overwritten. With `onlyUnsettled`
   * (the default) only `pending` and `guessed` lessons change. Resolves with the count changed.
   */
  applyLessonNumbers(rows: LessonNumberUpdate[], opts?: { onlyUnsettled?: boolean }): Promise<number>
  /** Own, non-trashed notes sharing a canonical key, oldest first in each group. */
  listSourceDuplicates(q?: { seriesId?: string }): Promise<{ canonicalKey: CanonicalKey; noteIds: string[] }[]>
  /**
   * The storage half of a merge, one transaction: the older note is kept; the newer note's
   * transcript sessions and chunks, spans, panels and note attachments move to it, its folders
   * and attendees are added to it, and it goes to Trash. The note text is left to the caller,
   * which may keep its own undo data in `extra`.
   */
  mergeSourceNotes(q: { noteIds: [string, string]; extra?: unknown }): Promise<{
    mergeId: string
    keptNoteId: string
    trashedNoteId: string
    moved: SourceMergeMoved
  }>
  getSourceMerge(mergeId: string): Promise<SourceMergeRecord | null>
  setSourceMergeExtra(mergeId: string, extra: unknown): Promise<void>
  /** Moves back what is still on the kept note, removes the added folders and attendees, and restores the note from Trash. */
  undoSourceMerge(mergeId: string): Promise<{ keptNoteId: string; restoredNoteId: string; extra: unknown }>

  // Markdown importer (src/main/storage/imports-md-repo.ts)
  /** One transaction: the batch (`queued`) and its items (`planned`). Rejects while another batch is queued or running. */
  createImportBatch(b: NewImportBatch): Promise<{ batch: ImportBatch; items: ImportItem[] }>
  getImportBatch(id: string): Promise<ImportBatch | null>
  /** Newest first. */
  listImportBatches(): Promise<ImportBatch[]>
  /** In creation order. */
  listImportItems(batchId: string, q?: { states?: ImportItemState[] }): Promise<ImportItem[]>
  /** `counts` is always recomputed from the items. */
  updateImportBatch(id: string, patch: ImportBatchPatch): Promise<ImportBatch>
  updateImportItem(id: string, patch: ImportItemPatch): Promise<ImportItem>
  /** Earlier `done` or `undone` items by source key or content hash, and export ids already here. */
  findImportMatches(q: { sourceKeys: string[]; hashes: string[]; exportIds: string[] }): Promise<ImportMatches>
  /**
   * One transaction: the note, its panels, its transcript session and chunks, its folder
   * memberships, its source, and the item set `done` with its note id.
   */
  importNoteItem(p: ImportNotePayload): Promise<{ noteId: string; item: ImportItem }>
  /** The batch's notes that still exist, flagged when opened or changed since the import. */
  importUndoPreview(batchId: string): Promise<ImportUndoPreview>
  /**
   * After the caller trashed the chosen notes: deletes the folders the batch created that are
   * now empty, and marks the batch and its items `undone`.
   */
  undoImportBatch(batchId: string): Promise<{ batch: ImportBatch; foldersDeleted: number }>
  /** Deletes every batch that isn't queued or running (the notes stay). Resolves with the count. */
  clearImportHistory(): Promise<number>
  getImportCandidates(noteIds: string[]): Promise<ImportCandidateRow[]>

  // general (src/main/repos/general-repo.ts)
  noteCount(q: { excludeTrashed: true }): Promise<number>
  databaseCreatedAt(): Promise<IsoTime | null>

  // local-only held sends (src/main/repos/local-only-repo.ts)
  holdDueIntegrationDeliveries(now: IsoTime): Promise<number>
  listHeldIntegrationDeliveries(): Promise<IntegrationDelivery[]>
  releaseHeldIntegrationDelivery(id: string, action: 'send' | 'discard'): Promise<IntegrationDelivery>

  // workflow blocks (src/main/repos/blocks-repo.ts)
  getWorkflowBlock(id: string): Promise<WorkflowBlock | null>
  listWorkflowBlocks(q: { sourceType: 'chat_thread'; sourceId: string }): Promise<WorkflowBlock[]>
  createWorkflowBlock(b: NewWorkflowBlock): Promise<WorkflowBlock>
  updateWorkflowBlock(id: string, patch: { content?: unknown; dismissed_at?: IsoTime }, expectedUpdatedAt?: IsoTime): Promise<WorkflowBlock | { stale: true }>
  setBlockExecution(id: string, execution: BlockExecution, expectedUpdatedAt?: IsoTime): Promise<WorkflowBlock | { stale: true }>

  // automations (src/main/repos/automations-repo.ts)
  listAutomationRules(): Promise<AutomationRule[]>
  upsertAutomationRule(r: AutomationRuleInput): Promise<AutomationRule>
  deleteAutomationRule(id: string): Promise<void>
  claimAutomationRunOnce(ruleId: string, noteId: string, run: { status: AutomationRunStatus; reason: string | null }): Promise<{ created: boolean; run: AutomationRun }>
  updateAutomationRun(id: string, patch: { status?: AutomationRunStatus; reason?: string | null; delivery_id?: string | null; executed_at?: IsoTime | null }): Promise<AutomationRun>
  listAutomationRuns(q: { ruleId?: string; noteId?: string; status?: AutomationRunStatus; limit: number }): Promise<AutomationRun[]>
  endedMeetingNotes(q: { since: IsoTime; noSummaryWaitMs: number; now: IsoTime }): Promise<{ noteId: string; endedAt: IsoTime }[]>
  automationFacts(noteId: string): Promise<{ attendees: { email: string; name: string }[]; recurringEventId: string | null; meetingType: string | null; isSensitive: boolean | null; hasSummary: boolean }>

  // customer calls (src/main/repos/crm-repo.ts)
  customerCallsBacklog(q: { folderId: string; since: IsoTime; excludedEmails: string[]; excludedDomains: string[] }): Promise<CustomerCallsBacklogNote[]>
  customerCallsSyncStatus(q: { noteIds: string[]; providers: IntegrationProvider[]; since: IsoTime | null }): Promise<CustomerCallsSyncStatus[]>

  // webhooks (src/main/repos/webhooks-repo.ts)
  listWebhookEndpoints(): Promise<(WebhookEndpoint & { url_secret_id: string; signing_secret_id: string })[]>
  upsertWebhookEndpoint(e: WebhookEndpointRow): Promise<WebhookEndpoint>
  deleteWebhookEndpoint(id: string): Promise<void>
  recordWebhookResult(id: string, ok: boolean, at: IsoTime): Promise<{ autoDisabled: boolean }>
}
