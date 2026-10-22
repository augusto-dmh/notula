// SPDX-License-Identifier: Apache-2.0
// Notes (the `documents` table) and the requests around them.
// Stored records use the SQL column names as they are (snake_case).

import type { IsoTime } from './common'
import type { SourceNoteRequest } from './sources'

export interface CalendarEventTime {
  dateTime?: string
  date?: string
  timeZone?: string
}

export interface CalendarAttendee {
  email: string
  displayName?: string
  self?: boolean
  resource?: boolean
  responseStatus?: string
  /** `ROLE=OPT-PARTICIPANT` / Graph `optional`. */
  optional?: boolean
  /** The attendee is the organizer. */
  organizer?: boolean
}

/** A calendar event, stored as JSON exactly as received. */
export interface CalendarEvent {
  id: string
  iCalUID?: string
  summary?: string
  start?: CalendarEventTime
  end?: CalendarEventTime
  attendees?: CalendarAttendee[]
  [k: string]: unknown
}

export interface NotePerson {
  email?: string
  name?: string
  company?: string
  jobTitle?: string
}

export interface NotePeople {
  creator?: NotePerson
  attendees?: NotePerson[]
  attendee_overrides?: unknown[]
}

/**
 * Stored. Computed in main from the platform; `chat_tool` for notes chat creates.
 */
export type CreationSource = 'macOS' | 'Windows' | 'desktop' | 'unknown' | 'chat_tool'

/** The entry point a note was created from. Not stored. */
export type CreationOrigin =
  | 'new_note_button'
  | 'app_menu'
  | 'tray'
  | 'dock_menu'
  | 'notification'
  | 'deep_link'
  | 'unknown'
  /** A detected-meeting notification. The stored `created_via` stays the platform. */
  | 'unscheduled_meeting_alert'
  /** Coming up: a row click. */
  | 'home_event'
  /** Coming up: Start now. */
  | 'home_start_button'
  /** An imported recording. */
  | 'audio-import'
  /** A note chat created. */
  | 'chat_tool'
  /** The demo meeting. */
  | 'demo'
  /** The macOS screen corner. */
  | 'screen_corner'
  /** The dictation bar's record button and shortcut. */
  | 'dictation_bar'
  /** A `source-detected` card: Take notes, Continue, Switch note. */
  | 'video_detected'
  /** Link source by hand, Recently played, or a mark with no note yet. */
  | 'source_linked'
  /** The Markdown importer. Its notes are written in one storage call, not through `notes:create`. */
  | 'markdown_import'

export interface Note {
  id: string
  workspace_id: string
  owner_id: string
  created_at: IsoTime
  updated_at: IsoTime
  deleted_at: IsoTime | null
  title: string | null
  type: 'meeting'
  created_via: CreationSource
  transcribe: boolean
  /** ProseMirror JSON, or null. */
  notes: unknown
  notes_text: string | null
  notes_md: string | null
  linked_event: CalendarEvent | null
  people: NotePeople | null
  private_notes_visible: boolean
  counts_as_meeting: boolean | null
  once_trashed: boolean
  is_scratchpad: boolean
  is_event_main_note: boolean
  ended_count: number
  transcript_purged_at: IsoTime | null
  crdt_version: number
  /** The classifier's and the manual tags. Main-only writes. */
  tags: DocumentTag[]
  is_shared: boolean
  /** Generated from `linked_event.id`. */
  event_id: string | null
  /** Generated: event start (dateTime, else date), else `created_at`. */
  sort_epoch: number
  /** The note's images, in order. Main-only writes (the `attachments:*` channels). */
  attachments: NoteAttachment[]
  /** Links from the meeting invite. Main-only writes (`attached-links:update`). */
  saved_links: AttachedLink[]
}

export type NoteListItem = Pick<
  Note,
  | 'id'
  | 'title'
  | 'created_at'
  | 'updated_at'
  | 'owner_id'
  | 'workspace_id'
  | 'linked_event'
  | 'people'
  | 'event_id'
  | 'sort_epoch'
  | 'is_shared'
  | 'transcribe'
>

export interface NotesListQuery {
  scope: 'own'
  /** Omit for all. */
  limit?: number
  excludeEventTimes?: { eventId: string; displayTimeUnixSeconds: number }[]
  /**
   * Each filter applies inside the listable scope,
   * the per-event dedupe and the display-time order.
   * `folderId`: members of that folder; `'my-notes'` (`MY_NOTES_SECTION_ID`) means no folder filter.
   */
  folderId?: string
  /** Only these note ids (the `/search` page's results). */
  ids?: string[]
  /** Only the user's own notes (the search page's "My notes" seam). */
  ownOnly?: boolean
  /**
   * Every filter must match; each matches notes with a `document_tags`
   * row of that `category` whose `value` is in `values` (null matches a null value).
   */
  tags?: NoteTagFilter[]
}

export interface NoteListPage {
  items: NoteListItem[]
  hasMore: boolean
}

export interface NoteCreateInput {
  origin: CreationOrigin
  title?: string | null
  calendarEvent?: CalendarEvent | null
  notes?: unknown
  transcribe?: boolean
}

/**
 * Renderer-writable note fields. Main sets `updated_at`; `transcribe` and
 * `ended_count` are main-only. `tags`, `attachments` and `saved_links` are main-only too.
 */
export type NotePatch = Partial<
  Pick<
    Note,
    | 'title'
    | 'notes'
    | 'notes_text'
    | 'notes_md'
    | 'private_notes_visible'
    | 'people'
    | 'linked_event'
    | 'counts_as_meeting'
  >
>

export interface NewNoteRequest {
  creationSource: CreationOrigin
  event?: CalendarEvent
  autoTranscribe: boolean
  expandBrief?: boolean
  holdInPersonNotice?: boolean
  /** The entry point's `opened_from`, passed through to the note page. */
  openSource?: string
  /** A source note: the renderer's sources branch creates or continues it. */
  source?: SourceNoteRequest
}

// ---------- Trash ----------

/** A row of the Trash popover (`notes:list-trash`), newest deletion first. */
export interface TrashItem {
  id: string
  title: string | null
  deleted_at: IsoTime
  linked_event: CalendarEvent | null
}

/**
 * `notes:auto-delete-if-empty`. Path `leave`: NotePage unmount;
 * path `indicator`: after a `indicator_stop_button` stop.
 */
export interface AutoDeleteRequest {
  id: string
  path: 'leave' | 'indicator'
  editorTextLength?: number
  inNavHistory?: boolean
}

/** Why a note was kept. */
export type AutoDeleteSkip =
  | 'in-nav-history'
  | 'missing'
  | 'primary-event-note'
  | 'transcribing-calendar-meeting'
  | 'creation-source'
  | 'has-transcript'
  | 'has-panels'
  | 'has-notes'
  | 'has-title'
  | 'transcript-unreadable'
  | 'already-deleted'

export interface AutoDeleteResult {
  deleted: boolean
  skipped: AutoDeleteSkip | null
}

/** A trashed note is purged 30 days after `deleted_at`. */
export const TRASH_RETENTION_MS = 30 * 24 * 3_600_000

/** Stored creation sources a note may be auto-deleted from. */
export const AUTO_DELETE_CREATION_SOURCES = ['', 'macOS', 'Windows', 'desktop', 'shared_tab'] as const

/** Note ids with this prefix are demo meetings, never auto-deleted. */
export const DEMO_MEETING_PREFIX = 'demo_meeting'

// ---------- tags ----------

export type TagCategory = 'meeting_kind' | 'is_sensitive'

/** One `documents.tags` entry, mirrored into `document_tags` by the migration-4 triggers. */
export interface DocumentTag {
  category: TagCategory
  /** `is_sensitive`: the strings `'true'` / `'false'`. */
  value: string | null
  source: 'manual' | 'notula-local' | (string & {})
  updated_at: IsoTime
}

export interface NoteTagFilter {
  category: TagCategory
  values: (string | null)[]
}

/** The 24 version-2 meeting types. */
export const MEETING_TYPES_V2: readonly string[] = [
  'project_work',
  'team_sync',
  'product_design',
  'sales',
  'account_care',
  'support_case',
  'research',
  'recruiting',
  'one_to_one',
  'onboarding',
  'strategy',
  'board',
  'finance',
  'fundraising',
  'procurement',
  'partnerships',
  'advisory',
  'legal',
  'marketing',
  'teaching',
  'care_session',
  'community',
  'working_session',
  'unknown'
]

/** The 9 version-2 sensitivity categories. */
export const SENSITIVITY_CATEGORIES_V2: readonly string[] = [
  'personnel_matter',
  'legal_privilege',
  'health',
  'private_life',
  'personal_finance_identity',
  'insider_information',
  'security_incident',
  'declared_confidential',
  'other_sensitive'
]

/** The pending meeting type. */
export const MEETING_TYPE_PENDING = 'pending_classification'

// ---------- attachments on a note ----------

/** A screen-share or snapshot image's description. */
export interface ScreenShareContext {
  captured_at: IsoTime
  description: string
  /** `none` = a placeholder (no model description). */
  model: string
}

/** One image of `Note.attachments`. */
export interface NoteAttachment {
  id: string
  type: 'image'
  /** `notula-attachment:<id>` (ATTACHMENT_URL_PREFIX). */
  url: string
  width: number
  height: number
  mime_type: string
  byte_size: number
  screen_capture_info?: ScreenShareContext
}

/** A link from the meeting invite. */
export interface AttachedLink {
  url: string
  label: string
  status: 'added' | 'dismissed'
}

export const ATTACHMENT_URL_PREFIX = 'notula-attachment:'
