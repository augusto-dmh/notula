// SPDX-License-Identifier: Apache-2.0
// Storage status and the recovery state. Notula never wipes user data: a failure opens a
// recovery state and the user decides.

export type StorageState =
  | 'starting'
  | 'ready'
  | 'migration-failed'
  | 'version-ahead'
  | 'key-unavailable'
  | 'open-failed'
  | 'encryption-unavailable'

export interface StorageStatus {
  state: StorageState
  detail?: string
  dataPath: string
  backupPath?: string
  schemaVersion?: number
  expectedVersion: number
  /** Rooms holding quarantined Yjs rows (`quarantine:` copies), counted at open. */
  damagedRooms?: number
}

/**
 * - `export-copy`: save dialog, then copy db + wal + shm + key.
 * - `start-fresh`: move those files to `recovered/<ts>/`, then create a new DB.
 *   The UI must confirm it first. Nothing is ever deleted.
 */
export type RecoveryAction = 'retry' | 'open-data-folder' | 'export-copy' | 'start-fresh'

/**
 * Tables named in change events. `notes:changed` forwards only `documents`,
 * `note_panels` and `calendar_events`; the other tables have their own pushes
 * (`templates:changed`, `recipes:changed`, `chat:changed`, `calendar:changed`,
 * `folders:changed`, `attachments:changed`, `action-items:changed`, …).
 */
export type StoreTable =
  | 'documents'
  | 'note_panels'
  | 'calendar_events'
  | 'note_templates'
  | 'recipes'
  | 'chat_threads'
  | 'chat_messages'
  | 'calendar_sources'
  | 'calendars'
  | 'folders'
  | 'folder_notes'
  | 'folder_rules'
  // Feature tables
  | 'attachments'
  | 'action_items'
  | 'followup_drafts'
  | 'prep_briefs'
  | 'scratchpad_days'
  | 'integration_deliveries'
  | 'mcp_connections'
  | 'dictation_sessions'
  | 'recordings'
  | 'audio_imports'
  | 'speaker_guesses'
  // Workflow and Labs tables; `notes:changed` still forwards only the note tables
  | 'consent_posts'
  | 'voiceprints'
  | 'transcript_reports'
  | 'retention_runs'
  | 'meeting_dock_history'
  | 'reminders'
  | 'recurring_recaps'
  | 'manual_tasks'
  | 'summary_feedback'
  | 'user_context_sections'
  | 'dispatch_todos'
  | 'dispatches'
  | 'dispatch_runs'
  | 'local_api_keys'
  | 'workflow_blocks'
  | 'automation_rules'
  | 'automation_runs'
  | 'webhook_endpoints'
  // Content sources and the Markdown importer (migration 9)
  | 'note_sources'
  | 'source_series'
  | 'source_spans'
  | 'series_catalog_items'
  | 'import_batches'
  | 'import_items'

/** Coalesced per microtask in the storage process. */
export interface NotesChanged {
  tables: StoreTable[]
  ids: string[]
}
