// SPDX-License-Identifier: Apache-2.0
// Content sources: a note linked to the video or course lesson it
// came from. Playbacks are memory only; a source, its series, catalog and watched spans are
// stored (migration 9) and belong to the note.
//
// Stored records use the SQL column names (snake_case), like `Note`. In-memory and IPC-only
// shapes are camelCase. Every union here is extensible: the tables carry no CHECK on them.

import type { IsoTime } from './common'

// ---------- what a source is ----------

/** `lesson` = a course item, or a YouTube video inside a course series. */
export type SourceKind = 'video' | 'live' | 'lesson' | 'other'

/** The platform, recognised from the URL. */
export type SourceProvider =
  | 'youtube'
  | 'circle'
  | 'udemy'
  | 'coursera'
  | 'hotmart'
  | 'kiwify'
  | 'memberkit'
  | 'vimeo'
  | 'web'

/**
 * `exact`: the URL came from the browser (extension, address bar, a unique History row) or the
 * user. `high`: verified on two independent fields. `guess`: anything else.
 */
export type SourceConfidence = 'exact' | 'high' | 'guess'

/** How the source was found. `import` comes from the Markdown importer. */
export type SourceDetectedVia = 'media-session' | 'history' | 'search' | 'extension' | 'manual' | 'backfill' | 'import'

/**
 * `youtube:<videoId>` · `circle:<host>:<lessonId>` · `udemy:<courseSlug>:<lectureId>` ·
 * `coursera:<courseSlug>:<itemId>` · `url:<normalized URL>` · `title:<site>:<normalized title>`
 * (a guess key, replaced once a URL is known; it never drives Continue without a confirm).
 */
export type CanonicalKey = string

/** A guess key starts with this. */
export const GUESS_KEY_PREFIX = 'title:'

/** The smallest reference to a source: what a request or a card carries. */
export interface SourceRef {
  canonicalKey: CanonicalKey
  provider: SourceProvider
  kind: SourceKind
  url: string | null
  title: string
}

/** The series a draft points at, before it is stored. */
export interface SeriesHint {
  kind: SeriesKind
  provider: SourceProvider
  /** e.g. `youtube:playlist:<listId>`, `circle:<host>:course:<slug>`, `youtube:channel:<id or name>`. */
  canonicalKey: CanonicalKey
  title: string | null
  /** 1-based, when the URL or the page gives it (playlist `index=`, a course outline). */
  index: number | null
  section: string | null
}

/** An identified source before it is linked to a note: identify(), the Link dialog, backfill, import. */
export interface SourceDraft extends SourceRef {
  channel: string | null
  durationMs: number | null
  live: boolean
  confidence: SourceConfidence
  detectedVia: SourceDetectedVia
  /** The browser site suffix or host (`youtube.com`, `courses.example.com`). */
  site: string | null
  series: SeriesHint | null
  lesson: { number: number | null; label: string | null; state: LessonState } | null
}

/** A lesson number's standing. Manual numbers are never overwritten. */
export type LessonState = 'numbered' | 'guessed' | 'pending'
/** Where a `numbered` lesson number came from. */
export type LessonOrigin = 'catalog' | 'playlist' | 'extension' | 'manual'

/** Enrichment (`note_sources.enrichment` JSON): yt-dlp metadata and oEmbed facts. */
export interface SourceEnrichment {
  state: 'none' | 'queued' | 'done' | 'failed'
  checkedAt: IsoTime | null
  chapters: { startMs: number; title: string }[]
  captionTracks: CaptionTrack[]
  /** The video's own language (BCP 47), when known. */
  language: string | null
  descriptionLinks: string[]
  playlist: { id: string; title: string | null; index: number | null } | null
}

export interface CaptionTrack {
  lang: string
  kind: 'manual' | 'asr'
  name: string | null
  /** Where the cues come from. */
  via: 'yt-dlp' | 'extension'
}

/** Video captions of a source (not `CaptionsState`, which is live captions). */
export type SourceTrackState = 'none' | 'queued' | 'fetching' | 'ready' | 'unavailable' | 'failed'

/** The transcript plan. */
export type TranscriptPlan = 'pending' | 'captions' | 'system-audio' | 'none'

/** One per note (`note_sources`, migration 9). */
export interface NoteSource {
  id: string
  workspace_id: string
  owner_id: string
  note_id: string
  kind: SourceKind
  provider: SourceProvider
  canonical_key: CanonicalKey
  url: string | null
  title: string
  channel: string | null
  duration_ms: number | null
  live: boolean
  series_id: string | null
  lesson_number: number | null
  lesson_label: string | null
  lesson_state: LessonState
  lesson_origin: LessonOrigin | null
  confidence: SourceConfidence
  detected_via: SourceDetectedVia
  enrichment: SourceEnrichment | null
  track_state: SourceTrackState
  track_language: string | null
  transcript_plan: TranscriptPlan
  /** Transcript sessions hidden by a switch to video captions (kept, never used by prompts). */
  superseded_session_ids: string[]
  /** The title the source gave the note; a note title still equal to it follows the source. */
  generated_title: string | null
  /** The renderer's stamped projection; main never re-serializes it. */
  notes_md_stamped: string | null
  created_at: IsoTime
  updated_at: IsoTime
}

/** `sources:update`. Unset fields are kept; `null` clears. */
export interface NoteSourcePatch {
  title?: string
  channel?: string | null
  url?: string | null
  series_id?: string | null
  lesson_number?: number | null
  lesson_label?: string | null
  notes_md_stamped?: string | null
}

/** `sources:get-for-note`: the source plus what the chip and breadcrumb show. */
export interface NoteSourceView {
  source: NoteSource
  series: Pick<SourceSeries, 'id' | 'kind' | 'title' | 'folder_id' | 'state'> | null
  watched: { percent: number | null; spans: number; lastWatchedAt: IsoTime | null }
  /** The newest other non-trashed note with this key (the chip's "Same as <note>?"). */
  sameKeyNoteIds: string[]
}

// ---------- series, catalog, spans ----------

export type SeriesKind = 'course' | 'playlist' | 'channel' | 'custom'
/** `paused`: ungrouped, its folder deleted, or `sources.autoFile` off. */
export type SeriesState = 'active' | 'paused'

/** `source_series`. UNIQUE(owner_id, kind, provider, canonical_key). */
export interface SourceSeries {
  id: string
  workspace_id: string
  owner_id: string
  kind: SeriesKind
  provider: SourceProvider
  canonical_key: CanonicalKey
  title: string
  folder_id: string | null
  state: SeriesState
  created_at: IsoTime
  updated_at: IsoTime
}

/** `series_catalog_items`: the ordered items of a series. */
export interface CatalogItem {
  id: string
  workspace_id: string
  owner_id: string
  series_id: string
  number: number | null
  section: string | null
  title: string
  url: string | null
  canonical_key: CanonicalKey | null
  duration_ms: number | null
  /** Order in the catalog, 0-based. */
  position: number
}

/** A row of `sources:list-series`. */
export interface SeriesListItem extends SourceSeries {
  noteCount: number
  catalogCount: number
  pendingCount: number
  lastWatchedAt: IsoTime | null
}

/** `sources:get-series`: lessons in catalog order. */
export interface SeriesDetail {
  series: SourceSeries
  lessons: SeriesLesson[]
  /** Notes sharing a canonical key, oldest first in each group. */
  duplicates: { canonicalKey: CanonicalKey; noteIds: string[] }[]
}

export interface SeriesLesson {
  catalogItemId: string | null
  number: number | null
  label: string | null
  section: string | null
  title: string
  url: string | null
  canonicalKey: CanonicalKey | null
  durationMs: number | null
  /** Null = not watched (no note). */
  noteId: string | null
  lessonState: LessonState | null
  watchedPercent: number | null
  lastWatchedAt: IsoTime | null
}

/** `source_spans`: one stretch of continuous playback while the note was open. */
export interface SourceSpan {
  id: string
  workspace_id: string
  owner_id: string
  note_id: string
  /** Epoch ms. */
  wall_start: number
  wall_end: number
  pos_start_ms: number
  pos_end_ms: number
  rate: number
}

export type CatalogInput = { kind: 'text'; text: string } | { kind: 'file'; handle: string }

/** `sources:import-catalog`. */
export interface CatalogImportResult {
  items: number
  sections: number
  /** Lessons whose `pending` or `guessed` number the catalog replaced. */
  numbered: number
  /** Lines the grammar couldn't read (counts only). */
  skippedLines: number
  dryRun: boolean
}

// ---------- playback (memory only) ----------

/** Where playback and identity facts come from. */
export type PlaybackProviderId = 'media-session' | 'extension' | 'manual'

/** Measured browser app ids (v1: Edge and Chrome). */
export type BrowserId = 'edge' | 'chrome' | 'brave'

export type PlaybackStatus = 'playing' | 'paused' | 'stopped'

/** The playback life cycle. */
export type PlaybackState =
  | 'seen'
  | 'provisional'
  | 'candidate'
  | 'identified'
  | 'offered'
  | 'noted'
  | 'skipped'
  | 'muted'
  | 'ended'

/** One playback a provider reports. Never stored. */
export interface Playback {
  /** Stable for this playback within one app run. */
  id: string
  provider: PlaybackProviderId
  browser: BrowserId
  /** The extension's opaque tab key, else null. */
  tabKey: string | null
  title: string
  artist: string | null
  status: PlaybackStatus
  positionMs: number | null
  durationMs: number | null
  rate: number
  /** Epoch ms of the position sample. */
  updatedAt: number
  live: boolean
  /** True while an ad plays (the extension's ad state, or the passive ad guard). */
  ad: boolean
  /** InPrivate/Incognito, or not known: nothing about it is persisted or looked up before Take notes. */
  privateWindow: boolean | 'unknown'
  /** The URL when a provider has it (extension, address bar). */
  url: string | null
  site: string | null
  state: PlaybackState
  /** Accumulated `playing` time. */
  playedMs: number
  /** Epoch ms the provider first saw this playback (History time correlation). */
  seenAt?: number
}

/** One session as the passive reader reports it (bus `media:sessions`). Raw, never stored. */
export interface MediaSession {
  /** The OS app id (`MSEdge`, `Chrome`); only measured browser ids reach the bus. */
  appId: string
  browser: BrowserId
  title: string
  artist: string | null
  album: string | null
  status: PlaybackStatus
  positionMs: number | null
  /** `≤ 0` = live. */
  endMs: number | null
  rate: number
  /** Epoch ms the OS last updated the timeline. */
  lastUpdatedAt: number
}

/** A row of Recently played (`sources:list-playing`). At most 20, cleared at quit. */
export interface PlayingItem {
  playback: Playback
  draft: SourceDraft | null
  /** The newest non-trashed note with the same exact or high key. */
  noteId: string | null
}

/** `sources:position`, about once a second while a source note is open and bound. */
export interface SourcePosition {
  noteId: string
  canonicalKey: CanonicalKey
  /** Null = no known position (no stamp). */
  positionMs: number | null
  rate: number
  status: PlaybackStatus
  /** Epoch ms of the sample; the renderer interpolates from it while `playing`. */
  observedAt: number
  ad: boolean
  /** False while a Next item card is unanswered or the binding is lost. */
  stamping: boolean
  provider: PlaybackProviderId
}

/** `sources:mark`: append an empty paragraph stamped at this position to the open note. */
export interface SourceMark {
  noteId: string
  positionMs: number
  /** Epoch ms. */
  wallMs: number
  origin: 'extension' | 'shortcut'
}

// ---------- detector, grant, tools ----------

export type DetectorState = 'off' | 'starting' | 'running' | 'restarting' | 'failed' | 'unavailable'

export interface DetectorStatus {
  state: DetectorState
  /** For `unavailable` and `failed`: a reason code, never a title or URL. */
  reason: string | null
  /** The last identification step that ran, for the status row. */
  lastStep: IdentifyStep | null
}

export type IdentifyStep = 'tab' | 'address-bar' | 'history' | 'fallback' | 'search' | 'verify' | 'enrich' | 'extension'

/** The first-use grant: History reads and online lookups. */
export interface Grant {
  readHistory: boolean
  onlineLookups: boolean
  /** The first-use prompt was answered (Allow or Not now). */
  asked: boolean
}

export type ToolsState = 'absent' | 'downloading' | 'ready' | 'updating' | 'failed' | 'external' | 'off'

/** Managed yt-dlp. */
export interface ToolsStatus {
  state: ToolsState
  version: string | null
  /** `external`: the PATH copy in use. */
  path: string | null
  reason: string | null
  /** While downloading or updating. */
  progress: { receivedBytes: number; totalBytes: number | null } | null
  /** Shown before the download. */
  sizeBytes: number | null
  licence: 'Unlicense'
  lastCheckedAt: IsoTime | null
  blockedByLocalOnly: boolean
}

/** `sources:get-status`. */
export interface SourcesStatus {
  enabled: boolean
  /** False off Windows. */
  supported: boolean
  detector: DetectorStatus
  grant: Grant
  tools: ToolsStatus
  /** The extension provider is connected for at least one browser. */
  extensionConnected: boolean
}

// ---------- search, backfill, merge, hints ----------

/** `sources:search` (the Link dialog's Search by title). */
export interface SourceSearchResult {
  draft: SourceDraft
  /** Why it matched, for the row. */
  matched: ('title' | 'channel' | 'duration')[]
}

/** A row of the Find sources preview. */
export interface BackfillRow {
  id: string
  noteId: string
  noteTitle: string | null
  proposal: SourceDraft | null
  /** Several `source` candidates: the user picks one. */
  choices: SourceDraft[]
  confidence: SourceConfidence | null
  reason: 'url-in-note' | 'import-candidate' | 'import-series' | 'title-search' | 'no-match'
  /** Ticked by default only for `exact` and `high`. */
  ticked: boolean
}

export interface BackfillPreview {
  previewId: string
  rows: BackfillRow[]
  /** Lookups were off or blocked: title search didn't run. */
  lookupsSkipped: boolean
  /**
   * Notes whose title search waited for a later preview (a per-preview cap on lookups).
   */
  searchesLeft?: number
  /** Older notes weren't read yet (the preview filled up, or the page cap): the next preview continues. */
  moreLeft?: boolean
}

export interface MergeResult {
  mergeId: string
  keptNoteId: string
  trashedNoteId: string
}

/**
 * One-off questions the UI may stop asking: `course-host` ("Recognize lessons from <host>?",
 * key = host), `file-rule` ("File future videos … here?", key = series id), `same-as`
 * (the chip's "Same as <note>?", key = note id).
 */
export type SourceHint = 'course-host' | 'file-rule' | 'same-as'

// ---------- the source-detected card ----------

/** What the `source-detected` card shows. */
export interface SourceCardPayload {
  mode: 'offer' | 'continue' | 'next'
  title: string
  channel: string | null
  site: string | null
  /** "Not sure which video" when the match is a guess. */
  guess: boolean
  /** Continue: the newest matching note and its last position. */
  noteTitle: string | null
  lastPositionMs: number | null
  /** The first-use line with Allow and Not now. */
  firstUse: boolean
}

/** The card's buttons and menu items; clicks arrive as `source:<action>`. */
export type SourceCardAction =
  | 'take-notes'
  | 'skip'
  | 'continue'
  | 'new-note'
  | 'switch-note'
  | 'keep-note'
  | 'allow'
  | 'not-now'
  | 'mute-channel'
  | 'mute-site'
  | 'settings'

export const SOURCE_CARD_ACTIONS: readonly SourceCardAction[] = [
  'take-notes',
  'skip',
  'continue',
  'new-note',
  'switch-note',
  'keep-note',
  'allow',
  'not-now',
  'mute-channel',
  'mute-site',
  'settings'
]

/** The note a card asks the renderer to create or continue (`NewNoteRequest.source`). */
export interface SourceNoteRequest {
  draft: SourceDraft
  /** The Recently played row it came from, if any. */
  playbackId: string | null
  mode: 'new' | 'continue'
  /** `continue`: the note to open. */
  noteId: string | null
}

/**
 * The built-in lesson template's id, selected for source notes while
 * `sources.lessonTemplate` is on. It is in `BUILTIN_TEMPLATE_IDS` as `lesson`, with
 * its catalog entry.
 */
export const LESSON_TEMPLATE_ID = '9b8f4427-7f53-4488-bd79-0c3689d18cd3'

// ---------- limits and settings values ----------

export type SourcesOfferMode = 'ask' | 'off'
export type SourcesYtDlpMode = 'managed' | 'external' | 'off'
/** `channel:<name>` or `site:<host>`. */
export type SourceMute = `channel:${string}` | `site:${string}`

export const SOURCES_LIMITS = {
  recentlyPlayed: 20,
  mutes: 200,
  courseHosts: 100,
  catalogItems: 2_000,
  spansPerNote: 5_000,
  debounceMs: 1_500,
  eligiblePlayedMs: 20_000,
  minDurationMs: 120_000,
  cardLifetimeMs: 60_000,
  cardGapMs: 120_000,
  cardPerKeyMs: 12 * 60 * 60 * 1_000,
  nextItemWindowMs: 30_000,
  endedStopMs: 3 * 60 * 1_000,
  pausedStopMs: 15 * 60 * 1_000,
  planDecideMs: 5_000,
  spanMergeMs: 2_000,
  muteChars: 300,
  searchResults: 3
} as const
