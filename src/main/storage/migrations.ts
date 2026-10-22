// SPDX-License-Identifier: Apache-2.0
// Schema migrations. Ordered and forward-only. A table rebuild is create-new → copy →
// drop-old → rename inside the same transaction, and no migration drops user data without
// copying it first.
//
// A new database runs the baseline (version 8), which creates the whole schema.
// A database written by an earlier build (versions 1–7) is brought to the baseline by
// legacy-upgrade.ts when the build includes that module. Later migrations append
// here from version 9 on, and run for both.
//
// The runner (engine.ts) backs the file up, then applies every pending step in one
// BEGIN IMMEDIATE … COMMIT with `PRAGMA user_version` set inside it.

import { SCHEMA_VERSION } from './protocol'

export interface Migration {
  version: number
  name: string
  sql: string
}

/** The version the baseline creates. Databases below it come only from the legacy upgrade. */
export const BASELINE_VERSION = 8

const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ','now')`

/** Event id and sort time are stored generated columns over the linked calendar event. */
const EVENT_ID = `CASE WHEN json_valid(linked_event) THEN json_extract(linked_event, '$.id') END`
const SORT_EPOCH = `coalesce(
    CASE WHEN json_valid(linked_event) THEN coalesce(
      unixepoch(json_extract(linked_event, '$.start.dateTime')),
      unixepoch(json_extract(linked_event, '$.start.date'))
    ) END,
    unixepoch(created_at)
  )`

/** The whole schema of version 8, in creation order: each table with its indexes, then the triggers. */
export const BASELINE = `
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE documents (
  rid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  title TEXT,
  type TEXT NOT NULL DEFAULT 'meeting',
  created_via TEXT NOT NULL DEFAULT 'unknown',
  transcribe INTEGER NOT NULL DEFAULT 1,
  notes TEXT,
  notes_text TEXT,
  notes_md TEXT,
  linked_event TEXT,
  people TEXT,
  private_notes_visible INTEGER NOT NULL DEFAULT 0,
  counts_as_meeting INTEGER,
  once_trashed INTEGER NOT NULL DEFAULT 0,
  is_scratchpad INTEGER NOT NULL DEFAULT 0,
  is_event_main_note INTEGER NOT NULL DEFAULT 0,
  ended_count INTEGER NOT NULL DEFAULT 0,
  transcript_purged_at TEXT,
  crdt_version INTEGER NOT NULL DEFAULT 1,
  tags TEXT NOT NULL DEFAULT '[]',
  is_shared INTEGER NOT NULL DEFAULT 0,
  event_id TEXT GENERATED ALWAYS AS (${EVENT_ID}) STORED,
  sort_epoch INTEGER GENERATED ALWAYS AS (${SORT_EPOCH}) STORED,
  attachments TEXT NOT NULL DEFAULT '[]',
  saved_links TEXT NOT NULL DEFAULT '[]'
);

CREATE INDEX documents_list_idx ON documents (owner_id, workspace_id, sort_epoch DESC, id)
  WHERE deleted_at IS NULL;

CREATE INDEX documents_event_idx ON documents (event_id) WHERE deleted_at IS NULL;

CREATE INDEX documents_trash_idx ON documents (deleted_at) WHERE deleted_at IS NOT NULL;

CREATE TABLE note_panels (
  rid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  document_id TEXT NOT NULL REFERENCES documents (id),
  workspace_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  content_edited_at TEXT,
  deleted_at TEXT,
  title TEXT NOT NULL,
  template_key TEXT,
  content TEXT,
  content_markdown TEXT,
  generated_content TEXT,
  last_opened_at TEXT,
  crdt_version INTEGER NOT NULL DEFAULT 1,
  enhance_started_at TEXT,
  enhance_failed_at TEXT,
  enhance_error TEXT,
  speakers_attributed INTEGER NOT NULL DEFAULT 0,
  ai_line_map TEXT,
  suggested_questions TEXT,
  user_feedback TEXT
);

CREATE INDEX note_panels_document_idx ON note_panels (document_id, deleted_at);

CREATE TABLE transcription_sessions (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  language TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  end_reason TEXT
);

CREATE INDEX transcription_sessions_document_idx ON transcription_sessions (document_id, started_at);

CREATE TABLE transcript_chunks (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  transcription_session_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('microphone', 'system')),
  start_timestamp TEXT NOT NULL,
  end_timestamp TEXT NOT NULL,
  text TEXT NOT NULL,
  is_final INTEGER NOT NULL,
  detected_speaker_name TEXT,
  detected_speaker TEXT,
  provider_details TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX transcript_chunks_order_idx ON transcript_chunks (document_id, start_timestamp, end_timestamp, id);

CREATE TABLE ydocs (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  room_id TEXT NOT NULL,
  data BLOB NOT NULL,
  origin TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX ydocs_room_idx ON ydocs (room_id, seq);

CREATE TABLE calendar_events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  data TEXT NOT NULL,
  updated_at TEXT,
  source_id TEXT,
  calendar_id TEXT,
  ical_uid TEXT
);

CREATE INDEX calendar_events_start_idx ON calendar_events (start_time);

CREATE INDEX calendar_events_end_idx ON calendar_events (end_time);

CREATE INDEX calendar_events_source_idx ON calendar_events (source_id, start_time);

CREATE INDEX calendar_events_ical_uid_idx ON calendar_events (ical_uid, start_time);

CREATE TABLE settings (
  owner_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT,
  PRIMARY KEY (owner_id, key)
);

CREATE TABLE settings_rejected (
  id TEXT PRIMARY KEY,
  owner_id TEXT,
  key TEXT,
  value TEXT,
  reason TEXT,
  moved_at TEXT
);

CREATE TABLE secrets (
  id TEXT PRIMARY KEY,
  ciphertext BLOB NOT NULL,
  updated_at TEXT
);

CREATE VIRTUAL TABLE documents_fts USING fts5 (
  document_id UNINDEXED, title, notes_text,
  tokenize = 'trigram case_sensitive 0'
);

CREATE VIRTUAL TABLE note_panels_fts USING fts5 (
  panel_id UNINDEXED, document_id UNINDEXED, content_plain,
  tokenize = 'trigram case_sensitive 0'
);

CREATE TABLE fts_queue (
  kind TEXT NOT NULL CHECK (kind IN ('document', 'panel')),
  row_id TEXT NOT NULL,
  queued_at TEXT NOT NULL,
  PRIMARY KEY (kind, row_id)
) WITHOUT ROWID;

CREATE TABLE note_templates (
  rid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT,
  deleted_at TEXT,
  title TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  sections TEXT NOT NULL DEFAULT '[]',
  category TEXT,
  icon TEXT,
  shared_with TEXT,
  copied_from TEXT
);

CREATE INDEX note_templates_owner_idx ON note_templates (owner_id, deleted_at);

CREATE TABLE recipes (
  rid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  config TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'workspace', 'public')),
  creation_context TEXT,
  source_recipe_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE INDEX recipes_owner_slug_idx ON recipes (owner_id, slug) WHERE deleted_at IS NULL;

CREATE TABLE chat_threads (
  rid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  creation_platform TEXT NOT NULL,
  title TEXT,
  grouping_key TEXT,
  initiated_by TEXT NOT NULL DEFAULT 'user' CHECK (initiated_by IN ('user', 'dispatch')),
  is_pinned INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX chat_threads_grouping_idx ON chat_threads (grouping_key, updated_at DESC) WHERE deleted_at IS NULL;

CREATE INDEX chat_threads_pinned_idx ON chat_threads (is_pinned) WHERE is_pinned = 1 AND deleted_at IS NULL;

CREATE TABLE chat_messages (
  rid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  thread_id TEXT NOT NULL REFERENCES chat_threads (id),
  workspace_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  turn_index INTEGER NOT NULL,
  attachments TEXT NOT NULL DEFAULT '[]',
  raw_text TEXT NOT NULL DEFAULT '',
  context TEXT,
  sources TEXT,
  outputs TEXT,
  status TEXT NOT NULL CHECK (status IN ('in_progress', 'completed', 'error', 'cancelled')),
  custom_type TEXT,
  trace_id TEXT
);

CREATE INDEX chat_messages_thread_idx ON chat_messages (thread_id, turn_index, role, created_at) WHERE deleted_at IS NULL;

CREATE TABLE file_deletions (
  path TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  queued_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE calendar_sources (
  rid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('ics', 'google', 'microsoft')),
  label TEXT NOT NULL,
  account_email TEXT,
  my_email TEXT,
  url_host TEXT,
  insecure INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ok',
  error_type TEXT,
  last_synced_at TEXT,
  last_error TEXT,
  http_etag TEXT,
  http_last_modified TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  grants TEXT NOT NULL DEFAULT '[]'
);

CREATE INDEX calendar_sources_owner_idx ON calendar_sources (owner_id, deleted_at);

CREATE TABLE calendars (
  rid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  source_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  native_id TEXT NOT NULL,
  name TEXT NOT NULL,
  color TEXT,
  is_primary INTEGER NOT NULL DEFAULT 0,
  access_role TEXT,
  visible INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX calendars_source_idx ON calendars (source_id);

CREATE TABLE folders (
  rid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  parent_id TEXT,
  title TEXT NOT NULL DEFAULT '',
  description TEXT,
  icon TEXT,
  preset TEXT,
  is_favourite INTEGER NOT NULL DEFAULT 0,
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'workspace')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX folders_owner_parent_idx ON folders (owner_id, parent_id);

CREATE TABLE folder_notes (
  folder_id TEXT NOT NULL REFERENCES folders (id) ON DELETE CASCADE,
  note_id TEXT NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  source TEXT NOT NULL CHECK (
    source IN ('manual', 'palette', 'dragged', 'add_notes', 'suggestion', 'series_rule')
  ),
  PRIMARY KEY (folder_id, note_id)
) WITHOUT ROWID;

CREATE INDEX folder_notes_note_idx ON folder_notes (note_id);

CREATE TABLE folder_rules (
  rid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  folder_id TEXT NOT NULL REFERENCES folders (id) ON DELETE CASCADE,
  recurring_event_id TEXT NOT NULL,
  target TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (folder_id, recurring_event_id)
);

CREATE TABLE document_tags (
  document_id TEXT NOT NULL,
  category TEXT NOT NULL,
  value TEXT
);

CREATE INDEX idx_document_tags_category_value_document_id ON document_tags (category, value, document_id);

CREATE INDEX idx_document_tags_document_id ON document_tags (document_id);

CREATE TABLE speaker_guesses (
  document_id TEXT NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  speaker_key TEXT NOT NULL,
  position INTEGER NOT NULL,
  suggestion TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (document_id, speaker_key)
) WITHOUT ROWID;

CREATE TABLE recordings (
  rid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  note_id TEXT NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('microphone', 'system')),
  started_at TEXT NOT NULL,
  ended_at TEXT,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  bytes INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL CHECK (state IN ('recording', 'complete', 'incomplete')),
  file_key BLOB NOT NULL
);

CREATE INDEX recordings_note_idx ON recordings (note_id);

CREATE INDEX recordings_ended_idx ON recordings (ended_at);

CREATE TABLE audio_imports (
  rid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  note_id TEXT,
  file_name TEXT NOT NULL,
  source_path TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  phase TEXT NOT NULL CHECK (
    phase IN ('queued', 'creating', 'reading', 'transcribing', 'summarizing', 'complete', 'failed')
  ),
  error TEXT,
  engine TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX audio_imports_phase_idx ON audio_imports (phase);

CREATE TABLE attachments (
  rid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  parent_type TEXT NOT NULL CHECK (parent_type IN ('note', 'chat_thread', 'folder')),
  parent_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('image', 'file')),
  file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  width INTEGER,
  height INTEGER,
  page_count INTEGER,
  sha256 TEXT NOT NULL,
  wrapped_key BLOB NOT NULL,
  counted INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL CHECK (status IN ('processing', 'ready', 'failed')),
  error TEXT,
  content_markdown TEXT,
  token_estimate INTEGER,
  content_summary TEXT,
  screen_capture_info TEXT,
  created_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE INDEX attachments_parent_idx ON attachments (parent_type, parent_id);

CREATE TABLE blob_keys (
  purpose TEXT PRIMARY KEY,
  key BLOB NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE action_items (
  rid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  source_document_id TEXT REFERENCES documents (id) ON DELETE CASCADE,
  source_panel_id TEXT,
  intent TEXT NOT NULL,
  detail TEXT,
  attribution TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'done')),
  archived_at TEXT,
  review_status TEXT CHECK (review_status IN ('kept', 'dismissed')),
  review_reason TEXT,
  reviewed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE INDEX action_items_document_idx ON action_items (source_document_id);

CREATE INDEX action_items_archived_created_idx ON action_items (archived_at, created_at DESC);

CREATE TABLE action_item_feedback (
  rid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  action_item_id TEXT REFERENCES action_items (id) ON DELETE CASCADE,
  document_id TEXT REFERENCES documents (id) ON DELETE CASCADE,
  panel_id TEXT,
  heading_text TEXT,
  item_text TEXT,
  direction TEXT NOT NULL CHECK (direction IN ('positive', 'negative')),
  feedback TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX action_item_feedback_item_idx ON action_item_feedback (action_item_id);

CREATE INDEX action_item_feedback_panel_idx ON action_item_feedback (panel_id);

CREATE TABLE followup_drafts (
  rid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  document_id TEXT NOT NULL UNIQUE REFERENCES documents (id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('generating', 'completed', 'error')),
  outcome TEXT CHECK (outcome IN ('opened', 'copied', 'discarded', 'handed_off')),
  "to" TEXT NOT NULL DEFAULT '[]',
  cc TEXT NOT NULL DEFAULT '[]',
  bcc TEXT NOT NULL DEFAULT '[]',
  subject TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  previous_body TEXT,
  follow_up_need TEXT,
  error_message TEXT,
  feedback_direction TEXT,
  feedback_text TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX followup_drafts_created_idx ON followup_drafts (created_at);

CREATE TABLE scratchpad_days (
  rid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  date TEXT NOT NULL,
  content TEXT NOT NULL,
  has_text INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (owner_id, date)
);

CREATE TABLE recipe_usage (
  recipe_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  total_count INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (recipe_id, owner_id)
) WITHOUT ROWID;

CREATE TABLE recipe_saves (
  recipe_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (recipe_id, owner_id)
) WITHOUT ROWID;

CREATE TABLE company_icons (
  domain TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  bytes BLOB,
  mime_type TEXT,
  fetched_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ok', 'failed'))
);

CREATE TABLE prep_briefs (
  rid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  event_id TEXT NOT NULL UNIQUE,
  document_id TEXT,
  status TEXT NOT NULL DEFAULT 'generating' CHECK (status IN ('generating', 'streaming', 'completed', 'error')),
  headline TEXT,
  content TEXT,
  brief_sources TEXT NOT NULL DEFAULT '[]',
  worth_showing INTEGER,
  steps TEXT NOT NULL DEFAULT '[]',
  error_message TEXT,
  auto_opened INTEGER NOT NULL DEFAULT 0,
  dismissed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE integration_destinations (
  rid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('slack-channel', 'slack-webhook', 'notion-target', 'zapier-hook')),
  label TEXT NOT NULL,
  external_id TEXT,
  secret_id TEXT,
  "trigger" TEXT CHECK ("trigger" IN ('share', 'folder')),
  options TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'disconnected', 'disabled')),
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX integration_destinations_provider_idx ON integration_destinations (provider);

CREATE TABLE integration_automations (
  rid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  folder_id TEXT NOT NULL REFERENCES folders (id) ON DELETE CASCADE,
  destination_id TEXT,
  options TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1,
  enabled_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX integration_automations_destination_uidx ON integration_automations (folder_id, provider, destination_id)
  WHERE destination_id IS NOT NULL;

CREATE UNIQUE INDEX integration_automations_folder_uidx ON integration_automations (folder_id, provider)
  WHERE destination_id IS NULL;

CREATE TABLE integration_automation_runs (
  automation_id TEXT NOT NULL REFERENCES integration_automations (id) ON DELETE CASCADE,
  note_id TEXT NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  ran_at TEXT NOT NULL,
  result TEXT NOT NULL CHECK (result IN ('queued', 'no_targets')),
  PRIMARY KEY (automation_id, note_id)
) WITHOUT ROWID;

CREATE TABLE integration_deliveries (
  rid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  destination_id TEXT,
  automation_id TEXT,
  note_id TEXT NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  panel_id TEXT,
  target_key TEXT NOT NULL DEFAULT '',
  "trigger" TEXT NOT NULL CHECK ("trigger" IN ('manual', 'folder', 'test')),
  status TEXT NOT NULL CHECK (
    status IN ('scheduled', 'pending', 'sending', 'sent', 'failed', 'uncertain', 'cancelled')
  ),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  external_id TEXT,
  external_url TEXT,
  error_code TEXT,
  error_message TEXT,
  sent_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  held_at TEXT
);

CREATE INDEX integration_deliveries_due_idx ON integration_deliveries (status, next_attempt_at);

CREATE INDEX integration_deliveries_note_idx ON integration_deliveries (note_id, provider);

CREATE INDEX integration_deliveries_held_idx ON integration_deliveries (held_at) WHERE held_at IS NOT NULL;

CREATE TABLE mcp_connections (
  rid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  transport_type TEXT NOT NULL CHECK (transport_type IN ('http', 'sse', 'stdio')),
  url TEXT,
  auth_type TEXT NOT NULL DEFAULT 'none' CHECK (auth_type IN ('none', 'bearer_token', 'oauth')),
  command TEXT,
  args TEXT NOT NULL DEFAULT '[]',
  cwd TEXT,
  env_names TEXT NOT NULL DEFAULT '[]',
  allow_private_network INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  is_oauth_connected INTEGER NOT NULL DEFAULT 0,
  tool_policy TEXT NOT NULL DEFAULT '{}',
  server_policy TEXT NOT NULL DEFAULT 'ask',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX mcp_connections_url_uidx ON mcp_connections (url) WHERE url IS NOT NULL;

CREATE TABLE mcp_server_tokens (
  rid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('stdio', 'http')),
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);

CREATE TABLE dictation_sessions (
  rid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('recording', 'pasted', 'clipboard', 'delivery_failed', 'empty', 'failed', 'cancelled', 'retried')
  ),
  failure_reason TEXT,
  language TEXT,
  audio_duration_ms INTEGER NOT NULL DEFAULT 0,
  text TEXT,
  audio_purge_at TEXT,
  audio_key BLOB
);

CREATE INDEX dictation_sessions_created_idx ON dictation_sessions (created_at DESC);

CREATE TABLE consent_posts (
  rid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  note_id TEXT NOT NULL UNIQUE REFERENCES documents (id) ON DELETE CASCADE,
  channel TEXT CHECK (channel IN ('zoom', 'teams', 'meet')),
  status TEXT NOT NULL CHECK (
    status IN ('attempted', 'success', 'failure', 'unavailable', 'copied', 'confirmed', 'cancelled')
  ),
  reason TEXT,
  attempted_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE voiceprints (
  rid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  centroids TEXT NOT NULL,
  total_speech_ms INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (owner_id, model_id)
);

CREATE TABLE transcript_reports (
  rid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  note_id TEXT NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK (
    category IN ('misheard_words', 'gaps', 'language_wrong', 'speaker_errors', 'other')
  ),
  comments TEXT NOT NULL DEFAULT '',
  start_timestamp TEXT,
  end_timestamp TEXT,
  excerpt TEXT NOT NULL DEFAULT '[]',
  excerpt_text TEXT NOT NULL DEFAULT '',
  asr_provider TEXT,
  asr_model TEXT,
  asr_language TEXT,
  asr_local INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX transcript_reports_note_idx ON transcript_reports (note_id);

CREATE TABLE retention_runs (
  rid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  ran_at TEXT NOT NULL,
  period_hours INTEGER NOT NULL,
  notes INTEGER NOT NULL DEFAULT 0,
  sections INTEGER NOT NULL DEFAULT 0,
  recordings INTEGER NOT NULL DEFAULT 0,
  bytes_freed INTEGER NOT NULL DEFAULT 0,
  note_ids TEXT NOT NULL DEFAULT '[]',
  errors TEXT NOT NULL DEFAULT '[]',
  "trigger" TEXT NOT NULL CHECK ("trigger" IN ('startup', 'daily'))
);

CREATE INDEX retention_runs_ran_idx ON retention_runs (ran_at DESC);

CREATE TABLE meeting_dock_history (
  document_id TEXT PRIMARY KEY REFERENCES documents (id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  exchanges TEXT NOT NULL DEFAULT '[]',
  pending TEXT,
  input TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE reminders (
  rid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  reminder_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (
    kind IN ('missing_invite', 'no_meeting_link', 'attendees_absent', 'late_for_meeting', 'followup_drafts')
  ),
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'dismissed', 'resolved')),
  resolved_reason TEXT,
  due_at TEXT,
  expires_at TEXT,
  presentation TEXT NOT NULL,
  actions TEXT NOT NULL DEFAULT '[]',
  thread_id TEXT,
  context TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX reminders_status_due_idx ON reminders (status, due_at);

CREATE TABLE recurring_recaps (
  rid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  document_id TEXT NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  content_version TEXT NOT NULL,
  title TEXT NOT NULL,
  bullets TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (document_id, content_version)
);

CREATE TABLE manual_tasks (
  rid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  text TEXT NOT NULL,
  checked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX manual_tasks_created_idx ON manual_tasks (created_at DESC);

CREATE TABLE summary_feedback (
  rid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  panel_id TEXT NOT NULL UNIQUE,
  document_id TEXT NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  template_key TEXT NOT NULL DEFAULT '',
  direction TEXT CHECK (direction IN ('positive', 'negative')),
  comment TEXT,
  dismissed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX summary_feedback_template_idx ON summary_feedback (template_key, updated_at DESC);

CREATE TABLE user_context_sections (
  rid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  section_id TEXT NOT NULL CHECK (
    section_id IN (
      'identity', 'current-work', 'relationships', 'work-habits', 'communication', 'calendar', 'reference',
      'assistant-guide'
    )
  ),
  content TEXT NOT NULL DEFAULT '',
  origin TEXT NOT NULL CHECK (origin IN ('user', 'drafted')),
  drafted_at TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE (owner_id, section_id)
);

CREATE TABLE dispatch_todos (
  rid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  action_item_id TEXT NOT NULL UNIQUE REFERENCES action_items (id) ON DELETE CASCADE,
  document_id TEXT REFERENCES documents (id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('email', 'slack', 'calendar', 'todo')),
  confidence TEXT CHECK (confidence IN ('high', 'low')),
  title TEXT NOT NULL,
  task TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'dismissed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX dispatch_todos_status_created_idx ON dispatch_todos (status, created_at DESC);

CREATE TABLE dispatches (
  rid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  todo_id TEXT REFERENCES dispatch_todos (id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('email', 'slack', 'calendar')),
  task TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT '',
  run_day TEXT NOT NULL,
  reason TEXT,
  thread_id TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'archived')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX dispatches_run_day_idx ON dispatches (run_day);

CREATE INDEX dispatches_status_idx ON dispatches (status);

CREATE TABLE dispatch_runs (
  run_day TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('classifying', 'starting', 'done', 'discarded', 'error', 'interrupted', 'paused')
  ),
  started_at TEXT,
  finished_at TEXT,
  proposed INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  PRIMARY KEY (owner_id, run_day)
) WITHOUT ROWID;

CREATE TABLE local_api_keys (
  rid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  key_hash TEXT NOT NULL UNIQUE,
  scopes TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  expires_at TEXT,
  revoked_at TEXT
);

CREATE TABLE workflow_blocks (
  rid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (
    type IN ('calendar_event', 'email', 'slack_message', 'crm_update', 'google_doc', 'markdown')
  ),
  source_type TEXT NOT NULL CHECK (source_type IN ('chat_thread')),
  source_id TEXT NOT NULL,
  assistant_message_id TEXT,
  tool_call_id TEXT,
  content TEXT NOT NULL,
  execution TEXT,
  dismissed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX workflow_blocks_source_idx ON workflow_blocks (source_type, source_id);

CREATE TABLE automation_rules (
  rid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  enabled_at TEXT,
  "trigger" TEXT NOT NULL DEFAULT 'meeting_ended' CHECK ("trigger" IN ('meeting_ended')),
  predicates TEXT NOT NULL DEFAULT '[]',
  actions TEXT NOT NULL,
  confirm_sends INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE automation_runs (
  rid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  rule_id TEXT NOT NULL REFERENCES automation_rules (id) ON DELETE CASCADE,
  note_id TEXT NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (
    status IN ('matched', 'no_match', 'needs_confirmation', 'executed', 'dismissed', 'failed')
  ),
  reason TEXT,
  delivery_id TEXT,
  evaluated_at TEXT NOT NULL,
  executed_at TEXT,
  UNIQUE (rule_id, note_id)
);

CREATE INDEX automation_runs_status_idx ON automation_runs (status);

CREATE TABLE webhook_endpoints (
  rid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  url_secret_id TEXT NOT NULL,
  url_label TEXT NOT NULL,
  signing_secret_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('my_notes_only', 'one_folder')),
  folder_id TEXT REFERENCES folders (id) ON DELETE SET NULL,
  events TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  disabled_reason TEXT CHECK (disabled_reason IN ('user', 'gone', 'failures')),
  include_transcript INTEGER NOT NULL DEFAULT 0,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  first_failure_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TRIGGER documents_fts_enqueue_insert AFTER INSERT ON documents BEGIN
  INSERT OR REPLACE INTO fts_queue (kind, row_id, queued_at) VALUES ('document', NEW.id, ${NOW});
END;

CREATE TRIGGER documents_fts_enqueue_update AFTER UPDATE OF title, notes_text, deleted_at ON documents BEGIN
  INSERT OR REPLACE INTO fts_queue (kind, row_id, queued_at) VALUES ('document', NEW.id, ${NOW});
END;

CREATE TRIGGER documents_fts_delete AFTER DELETE ON documents BEGIN
  DELETE FROM documents_fts WHERE rowid = OLD.rid;
  DELETE FROM fts_queue WHERE kind = 'document' AND row_id = OLD.id;
END;

CREATE TRIGGER note_panels_fts_enqueue_insert AFTER INSERT ON note_panels BEGIN
  INSERT OR REPLACE INTO fts_queue (kind, row_id, queued_at) VALUES ('panel', NEW.id, ${NOW});
END;

CREATE TRIGGER note_panels_fts_enqueue_update AFTER UPDATE OF content_markdown, deleted_at ON note_panels BEGIN
  INSERT OR REPLACE INTO fts_queue (kind, row_id, queued_at) VALUES ('panel', NEW.id, ${NOW});
END;

CREATE TRIGGER note_panels_fts_delete AFTER DELETE ON note_panels BEGIN
  DELETE FROM note_panels_fts WHERE rowid = OLD.rid;
  DELETE FROM fts_queue WHERE kind = 'panel' AND row_id = OLD.id;
END;

CREATE TRIGGER document_tags_ai AFTER INSERT ON documents BEGIN
  INSERT INTO document_tags (document_id, category, value) SELECT NEW.id, json_extract(je.value, '$.category'), json_extract(je.value, '$.value')
    FROM json_each(CASE WHEN json_valid(NEW.tags) THEN NEW.tags ELSE '[]' END) je
    WHERE je.type = 'object' AND json_extract(je.value, '$.category') IS NOT NULL;
END;

CREATE TRIGGER document_tags_au AFTER UPDATE OF tags ON documents BEGIN
  DELETE FROM document_tags WHERE document_id = OLD.id OR document_id = NEW.id;
  INSERT INTO document_tags (document_id, category, value) SELECT NEW.id, json_extract(je.value, '$.category'), json_extract(je.value, '$.value')
    FROM json_each(CASE WHEN json_valid(NEW.tags) THEN NEW.tags ELSE '[]' END) je
    WHERE je.type = 'object' AND json_extract(je.value, '$.category') IS NOT NULL;
END;

CREATE TRIGGER document_tags_ad AFTER DELETE ON documents BEGIN
  DELETE FROM document_tags WHERE document_id = OLD.id;
END;

CREATE TRIGGER recordings_ad AFTER DELETE ON recordings BEGIN
  INSERT OR IGNORE INTO file_deletions (path, reason, queued_at) VALUES ('rel:' || 'audio/' || OLD.note_id || '/' || OLD.id || '.naud', 'recording-deleted', ${NOW});
END;

CREATE TRIGGER attachments_note_ad AFTER DELETE ON documents BEGIN
  DELETE FROM attachments WHERE parent_type = 'note' AND parent_id = OLD.id;
END;

CREATE TRIGGER attachments_folder_ad AFTER DELETE ON folders BEGIN
  DELETE FROM attachments WHERE parent_type = 'folder' AND parent_id = OLD.id;
END;

CREATE TRIGGER attachments_thread_au AFTER UPDATE OF deleted_at ON chat_threads WHEN NEW.deleted_at IS NOT NULL BEGIN
  DELETE FROM attachments WHERE parent_type = 'chat_thread' AND parent_id = NEW.id;
END;

CREATE TRIGGER attachments_ad AFTER DELETE ON attachments BEGIN
  INSERT OR IGNORE INTO file_deletions (path, reason, queued_at) VALUES ('rel:' || 'attachments/' || substr(OLD.id, 1, 2) || '/' || OLD.id || '.bin', 'attachment-deleted', ${NOW});
END;

CREATE TRIGGER dictation_sessions_ad AFTER DELETE ON dictation_sessions WHEN OLD.audio_key IS NOT NULL BEGIN
  INSERT OR IGNORE INTO file_deletions (path, reason, queued_at) VALUES ('rel:' || 'dictation-audio/' || OLD.id, 'dictation-deleted', ${NOW});
END;

CREATE TRIGGER workflow_blocks_thread_au AFTER UPDATE OF deleted_at ON chat_threads WHEN NEW.deleted_at IS NOT NULL BEGIN
  DELETE FROM workflow_blocks WHERE source_type = 'chat_thread' AND source_id = NEW.id;
END;
`

/**
 * Version 9: content sources (a note's video or lesson, its series, catalog and watched spans,
 * and the undo records of a merge) and the Markdown importer's batches and items. Only new
 * tables, indexes and one trigger; no existing table changes.
 *
 * The source tables carry no CHECK on their kinds, providers, confidences, states or plans, so
 * a new value never needs a table rebuild. A deleted folder pauses the series filed into it, and
 * its `folder_id` becomes null, so no folder is ever recreated for it.
 */
const SOURCES_AND_IMPORTS = `
CREATE TABLE source_series (
  rid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  provider TEXT NOT NULL,
  canonical_key TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  folder_id TEXT REFERENCES folders (id) ON DELETE SET NULL,
  state TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (owner_id, kind, provider, canonical_key)
);

CREATE INDEX source_series_folder_idx ON source_series (folder_id);

CREATE TABLE note_sources (
  rid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  note_id TEXT NOT NULL UNIQUE REFERENCES documents (id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  provider TEXT NOT NULL,
  canonical_key TEXT NOT NULL,
  url TEXT,
  title TEXT NOT NULL DEFAULT '',
  channel TEXT,
  duration_ms INTEGER,
  live INTEGER NOT NULL DEFAULT 0,
  series_id TEXT REFERENCES source_series (id) ON DELETE SET NULL,
  lesson_number INTEGER,
  lesson_label TEXT,
  lesson_state TEXT NOT NULL DEFAULT 'pending',
  lesson_origin TEXT,
  confidence TEXT NOT NULL,
  detected_via TEXT NOT NULL,
  enrichment TEXT,
  track_state TEXT NOT NULL DEFAULT 'none',
  track_language TEXT,
  transcript_plan TEXT NOT NULL DEFAULT 'pending',
  superseded_session_ids TEXT NOT NULL DEFAULT '[]',
  generated_title TEXT,
  notes_md_stamped TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX note_sources_key_idx ON note_sources (canonical_key);

CREATE INDEX note_sources_series_idx ON note_sources (series_id, lesson_number);

CREATE TABLE source_spans (
  rid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  note_id TEXT NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  wall_start INTEGER NOT NULL,
  wall_end INTEGER NOT NULL,
  pos_start_ms INTEGER NOT NULL,
  pos_end_ms INTEGER NOT NULL,
  rate REAL NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE INDEX source_spans_note_idx ON source_spans (note_id, wall_start);

CREATE TABLE series_catalog_items (
  rid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  series_id TEXT NOT NULL REFERENCES source_series (id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  number INTEGER,
  section TEXT,
  title TEXT NOT NULL DEFAULT '',
  url TEXT,
  canonical_key TEXT,
  duration_ms INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (series_id, position)
);

CREATE INDEX series_catalog_items_key_idx ON series_catalog_items (canonical_key);

CREATE TABLE source_merges (
  rid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  kept_note_id TEXT NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  trashed_note_id TEXT NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  undo TEXT NOT NULL,
  extra TEXT,
  created_at TEXT NOT NULL,
  undone_at TEXT
);

CREATE INDEX source_merges_kept_idx ON source_merges (kept_note_id);

CREATE INDEX source_merges_trashed_idx ON source_merges (trashed_note_id);

CREATE TABLE import_batches (
  rid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  root_path TEXT NOT NULL,
  preset TEXT NOT NULL,
  options TEXT NOT NULL DEFAULT '{}',
  state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'complete', 'cancelled', 'failed', 'undone')),
  counts TEXT NOT NULL DEFAULT '{}',
  created_folder_ids TEXT NOT NULL DEFAULT '[]',
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT,
  undone_at TEXT
);

CREATE INDEX import_batches_owner_idx ON import_batches (owner_id, created_at);

CREATE TABLE import_items (
  rid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  batch_id TEXT NOT NULL REFERENCES import_batches (id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  source_key TEXT NOT NULL,
  rel_path TEXT NOT NULL,
  format TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  note_id TEXT REFERENCES documents (id) ON DELETE SET NULL,
  export_note_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('planned', 'done', 'skipped', 'failed', 'undone')),
  reason TEXT,
  candidates TEXT NOT NULL DEFAULT '[]',
  meta TEXT NOT NULL DEFAULT '{}',
  imported_title TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX import_items_source_key_idx ON import_items (owner_id, source_key);

CREATE INDEX import_items_hash_idx ON import_items (owner_id, content_hash);

CREATE INDEX import_items_note_idx ON import_items (note_id);

CREATE INDEX import_items_batch_idx ON import_items (batch_id, state);

CREATE TRIGGER source_series_folder_bd BEFORE DELETE ON folders BEGIN
  UPDATE source_series SET state = 'paused', updated_at = ${NOW} WHERE folder_id = OLD.id;
END;
`

export const MIGRATIONS: readonly Migration[] = [
  { version: BASELINE_VERSION, name: 'baseline', sql: BASELINE },
  { version: 9, name: 'sources-and-imports', sql: SOURCES_AND_IMPORTS }
]

/**
 * Dev only (`NOTULA_DEV_FAIL_MIGRATION=1`): one more migration that creates a table
 * and then fails, so the rollback, the backup and the recovery screen can be seen.
 */
export const DEV_FAIL_MIGRATION: Migration = {
  version: SCHEMA_VERSION + 1,
  name: 'dev-fail-migration',
  sql: `
CREATE TABLE dev_fail_probe (x INTEGER);
INSERT INTO dev_fail_probe_missing (x) VALUES (1);
`
}

if (MIGRATIONS[MIGRATIONS.length - 1]?.version !== SCHEMA_VERSION) {
  throw new Error('migrations.ts: the last migration must match SCHEMA_VERSION')
}
