// SPDX-License-Identifier: Apache-2.0
// Row ↔ record mapping inside the storage worker. Records keep the SQL column
// names; booleans are stored 0/1 and JSON columns as text, and
// both arrive decoded.

import type { AttachedLink, DocumentTag, Note, NoteAttachment, NoteListItem } from '@shared/types/notes'
import type { Panel } from '@shared/types/panels'
import type { DetectedSpeaker, TranscriptChunk } from '@shared/types/transcript'
import type { TranscriptionSession } from './api'

type Row = Record<string, unknown>

export function nowIso(): string {
  return new Date().toISOString()
}

/** SQLite binds BLOBs from Buffers; IPC delivers plain Uint8Arrays. */
export function toBuffer(bytes: Uint8Array): Buffer {
  return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

/** Parses a JSON column; a malformed value reads as `fallback` rather than failing the read. */
export function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

/** JSON column value for a write: undefined stays undefined (column untouched), null stays null. */
export function toJson(value: unknown): string | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  return JSON.stringify(value)
}

const bool = (v: unknown): boolean => v === 1 || v === true
const boolOrNull = (v: unknown): boolean | null => (v === null || v === undefined ? null : bool(v))
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null)

export const NOTE_COLUMNS = [
  'id',
  'workspace_id',
  'owner_id',
  'created_at',
  'updated_at',
  'deleted_at',
  'title',
  'type',
  'created_via',
  'transcribe',
  'notes',
  'notes_text',
  'notes_md',
  'linked_event',
  'people',
  'private_notes_visible',
  'counts_as_meeting',
  'once_trashed',
  'is_scratchpad',
  'is_event_main_note',
  'ended_count',
  'transcript_purged_at',
  'crdt_version',
  'tags',
  'is_shared',
  'event_id',
  'sort_epoch',
  // migration 4
  'attachments',
  'saved_links'
] as const

export const NOTE_LIST_COLUMNS = [
  'id',
  'title',
  'created_at',
  'updated_at',
  'owner_id',
  'workspace_id',
  'linked_event',
  'people',
  'event_id',
  'sort_epoch',
  'is_shared',
  'transcribe'
] as const

export function toNote(r: Row): Note {
  return {
    id: r['id'] as string,
    workspace_id: r['workspace_id'] as string,
    owner_id: r['owner_id'] as string,
    created_at: r['created_at'] as string,
    updated_at: r['updated_at'] as string,
    deleted_at: strOrNull(r['deleted_at']),
    title: strOrNull(r['title']),
    type: 'meeting',
    created_via: r['created_via'] as Note['created_via'],
    transcribe: bool(r['transcribe']),
    notes: parseJson<unknown>(r['notes'], null),
    notes_text: strOrNull(r['notes_text']),
    notes_md: strOrNull(r['notes_md']),
    linked_event: parseJson<Note['linked_event']>(r['linked_event'], null),
    people: parseJson<Note['people']>(r['people'], null),
    private_notes_visible: bool(r['private_notes_visible']),
    counts_as_meeting: boolOrNull(r['counts_as_meeting']),
    once_trashed: bool(r['once_trashed']),
    is_scratchpad: bool(r['is_scratchpad']),
    is_event_main_note: bool(r['is_event_main_note']),
    ended_count: Number(r['ended_count'] ?? 0),
    transcript_purged_at: strOrNull(r['transcript_purged_at']),
    crdt_version: Number(r['crdt_version'] ?? 1),
    tags: objectsOnly(parseJson<unknown>(r['tags'], [])) as unknown as DocumentTag[],
    is_shared: bool(r['is_shared']),
    event_id: strOrNull(r['event_id']),
    sort_epoch: Number(r['sort_epoch'] ?? 0),
    attachments: objectsOnly(parseJson<unknown>(r['attachments'], [])) as unknown as NoteAttachment[],
    saved_links: objectsOnly(parseJson<unknown>(r['saved_links'], [])) as unknown as AttachedLink[]
  }
}

/**
 * A JSON list column's object entries. Older notes stored `tags` as strings, which
 * no longer match `DocumentTag` and are skipped (the tags module does the final parse).
 */
function objectsOnly(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)) : []
}

export function toNoteListItem(r: Row): NoteListItem {
  return {
    id: r['id'] as string,
    title: strOrNull(r['title']),
    created_at: r['created_at'] as string,
    updated_at: r['updated_at'] as string,
    owner_id: r['owner_id'] as string,
    workspace_id: r['workspace_id'] as string,
    linked_event: parseJson<Note['linked_event']>(r['linked_event'], null),
    people: parseJson<Note['people']>(r['people'], null),
    event_id: strOrNull(r['event_id']),
    sort_epoch: Number(r['sort_epoch'] ?? 0),
    is_shared: bool(r['is_shared']),
    transcribe: bool(r['transcribe'])
  }
}

/** Panel columns a write may set (everything but identity and creation). */
export const PANEL_WRITABLE = [
  'content_edited_at',
  'deleted_at',
  'title',
  'template_key',
  'content',
  'content_markdown',
  'generated_content',
  'last_opened_at',
  'crdt_version',
  'enhance_started_at',
  'enhance_failed_at',
  'enhance_error',
  'speakers_attributed',
  'ai_line_map'
] as const satisfies readonly (keyof Panel)[]

export const PANEL_JSON = new Set<string>(['content', 'ai_line_map'])
export const PANEL_BOOL = new Set<string>(['speakers_attributed'])

export function toPanel(r: Row): Panel {
  return {
    id: r['id'] as string,
    document_id: r['document_id'] as string,
    workspace_id: r['workspace_id'] as string,
    owner_id: r['owner_id'] as string,
    created_at: r['created_at'] as string,
    updated_at: r['updated_at'] as string,
    content_edited_at: strOrNull(r['content_edited_at']),
    deleted_at: strOrNull(r['deleted_at']),
    title: (r['title'] as string) ?? '',
    template_key: strOrNull(r['template_key']),
    content: parseJson<unknown>(r['content'], null),
    content_markdown: strOrNull(r['content_markdown']),
    generated_content: strOrNull(r['generated_content']),
    last_opened_at: strOrNull(r['last_opened_at']),
    enhance_started_at: strOrNull(r['enhance_started_at']),
    enhance_failed_at: strOrNull(r['enhance_failed_at']),
    enhance_error: strOrNull(r['enhance_error']) as Panel['enhance_error'],
    ai_line_map: parseJson<Panel['ai_line_map']>(r['ai_line_map'], null),
    speakers_attributed: bool(r['speakers_attributed']),
    crdt_version: Number(r['crdt_version'] ?? 1)
  }
}

/** A panel column value encoded for SQLite. */
export function encodePanelValue(column: string, value: unknown): unknown {
  if (PANEL_JSON.has(column)) return toJson(value) ?? null
  if (PANEL_BOOL.has(column)) return value ? 1 : 0
  return value ?? null
}

export function toChunk(r: Row): TranscriptChunk {
  const chunk: TranscriptChunk = {
    id: r['id'] as string,
    document_id: r['document_id'] as string,
    workspace_id: r['workspace_id'] as string,
    owner_id: r['owner_id'] as string,
    transcription_session_id: r['transcription_session_id'] as string,
    source: r['source'] as TranscriptChunk['source'],
    start_timestamp: r['start_timestamp'] as string,
    end_timestamp: r['end_timestamp'] as string,
    text: (r['text'] as string) ?? '',
    is_final: bool(r['is_final']),
    detected_speaker_name: strOrNull(r['detected_speaker_name']),
    detectedSpeaker: parseJson<DetectedSpeaker | null>(r['detected_speaker'], null)
  }
  const details = parseJson<TranscriptChunk['providerDetails'] | null>(r['provider_details'], null)
  if (details) chunk.providerDetails = details
  return chunk
}

export function toSession(r: Row): TranscriptionSession {
  return {
    id: r['id'] as string,
    document_id: r['document_id'] as string,
    workspace_id: r['workspace_id'] as string,
    owner_id: r['owner_id'] as string,
    provider: r['provider'] as TranscriptionSession['provider'],
    model: r['model'] as string,
    language: r['language'] as string,
    started_at: r['started_at'] as string,
    ended_at: strOrNull(r['ended_at']),
    end_reason: strOrNull(r['end_reason'])
  }
}
