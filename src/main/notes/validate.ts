// SPDX-License-Identifier: Apache-2.0
// Payload whitelisting for the notes IPC handlers. A renderer payload is
// rebuilt from known keys only, so a patch can never set `transcribe`,
// `ended_count` or generation fields, whatever it carries.

import { notulaError } from '@shared/errors'
import type {
  AutoDeleteRequest,
  CalendarEvent,
  CreationOrigin,
  NoteCreateInput,
  NotePatch,
  NotesListQuery,
  TagCategory
} from '@shared/types/notes'
import type { PanelPatch } from '@shared/types/panels'
import type { RecoveryAction } from '@shared/types/storage'

/** Upper bound for one JSON-valued field (ProseMirror documents included). */
const MAX_JSON_BYTES = 8 * 1024 * 1024
/** Upper bound for one Yjs update. */
export const MAX_YDOC_UPDATE_BYTES = 16 * 1024 * 1024
const MAX_TEXT = 4 * 1024 * 1024

const ORIGINS: readonly CreationOrigin[] = [
  'new_note_button',
  'app_menu',
  'tray',
  'dock_menu',
  'notification',
  'deep_link',
  'unknown',
  // Entry points only; the stored created_via stays the platform.
  'unscheduled_meeting_alert',
  'home_event',
  'home_start_button',
  // Imports, chat, the demo and the macOS screen corner.
  'audio-import',
  'chat_tool',
  'demo',
  'screen_corner',
  // The dictation bar's record button and shortcut.
  'dictation_bar',
  // Content sources and the Markdown importer.
  'video_detected',
  'source_linked',
  'markdown_import'
]
const TAG_CATEGORIES: readonly TagCategory[] = ['meeting_kind', 'is_sensitive']
const RECOVERY_ACTIONS: readonly RecoveryAction[] = ['retry', 'open-data-folder', 'export-copy', 'start-fresh']
/** `notes:list` `ids` (the search page's results; search has no result limit). */
const MAX_LIST_IDS = 100_000
const ID = /^[^\s]{1,200}$/
const ROOM_ID = /^(notes|summary):1:[^\s:]{1,200}$/

const bad = (message: string): Error => notulaError('invalid-input', message)

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Uint8Array)
}

export function object(v: unknown, what: string): Record<string, unknown> {
  if (!isPlainObject(v)) throw bad(`${what} must be an object`)
  return v
}

export function id(v: unknown, what = 'id'): string {
  if (typeof v !== 'string' || !ID.test(v)) throw bad(`${what} is not a valid id`)
  return v
}

function optBool(v: unknown, what: string): boolean | undefined {
  if (v === undefined) return undefined
  if (typeof v !== 'boolean') throw bad(`${what} must be a boolean`)
  return v
}

function textOrNull(v: unknown, what: string): string | null {
  if (v === null) return null
  if (typeof v !== 'string' || v.length > MAX_TEXT) throw bad(`${what} must be text ≤ ${MAX_TEXT} chars`)
  return v
}

function isoOrNull(v: unknown, what: string): string | null {
  if (v === null) return null
  if (typeof v !== 'string' || Number.isNaN(Date.parse(v))) throw bad(`${what} must be an ISO time or null`)
  return v
}

/** Any JSON value of bounded size (ProseMirror JSON, people, …). */
function json(v: unknown, what: string): unknown {
  let text: string | undefined
  try {
    text = JSON.stringify(v)
  } catch {
    throw bad(`${what} must be JSON`)
  }
  if (text === undefined || text.length > MAX_JSON_BYTES) throw bad(`${what} must be JSON under 8 MB`)
  return v
}

function calendarEventOrNull(v: unknown, what: string): CalendarEvent | null {
  if (v === null) return null
  const ev = object(v, what)
  if (typeof ev['id'] !== 'string' || !ev['id']) throw bad(`${what} needs an event id`)
  return json(ev, what) as CalendarEvent
}

export function recoveryAction(v: unknown): RecoveryAction {
  const action = object(v, 'request')['action']
  if (!RECOVERY_ACTIONS.includes(action as RecoveryAction)) throw bad('unknown recovery action')
  return action as RecoveryAction
}

export function listQuery(v: unknown): NotesListQuery {
  const q = object(v, 'query')
  if (q['scope'] !== 'own') throw bad("scope must be 'own'")
  const out: NotesListQuery = { scope: 'own' }
  if (q['limit'] !== undefined) {
    const limit = q['limit']
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 0) throw bad('limit must be an integer ≥ 0')
    out.limit = limit
  }
  if (q['excludeEventTimes'] !== undefined) {
    const list = q['excludeEventTimes']
    if (!Array.isArray(list) || list.length > 10_000) throw bad('excludeEventTimes must be an array')
    out.excludeEventTimes = list.map((x) => {
      const e = object(x, 'excludeEventTimes[]')
      if (typeof e['eventId'] !== 'string' || typeof e['displayTimeUnixSeconds'] !== 'number') {
        throw bad('excludeEventTimes[] must be { eventId, displayTimeUnixSeconds }')
      }
      return { eventId: e['eventId'], displayTimeUnixSeconds: e['displayTimeUnixSeconds'] }
    })
  }
  // The folder page, the "My notes" page and the search page.
  if (q['folderId'] !== undefined) out.folderId = id(q['folderId'], 'folderId')
  if (q['ids'] !== undefined) {
    const list = q['ids']
    if (!Array.isArray(list) || list.length > MAX_LIST_IDS) throw bad(`ids must be an array of at most ${MAX_LIST_IDS} ids`)
    out.ids = list.map((x) => id(x, 'ids[]'))
  }
  const ownOnly = optBool(q['ownOnly'], 'ownOnly')
  if (ownOnly !== undefined) out.ownOnly = ownOnly
  // Every filter must match. This validates the
  // shape; the notes repo applies it.
  if (q['tags'] !== undefined) {
    const list = q['tags']
    if (!Array.isArray(list) || list.length > 10) throw bad('tags must be an array of at most 10 filters')
    out.tags = list.map((x) => {
      const f = object(x, 'tags[]')
      if (!TAG_CATEGORIES.includes(f['category'] as TagCategory)) throw bad('tags[].category is unknown')
      const values = f['values']
      if (!Array.isArray(values) || values.length > 100 || !values.every((v) => v === null || (typeof v === 'string' && v.length <= 200))) {
        throw bad('tags[].values must be strings or null')
      }
      return { category: f['category'] as TagCategory, values: [...(values as (string | null)[])] }
    })
  }
  return out
}

export function getRequest(v: unknown): { id: string; includeDeleted?: boolean } {
  const r = object(v, 'request')
  const includeDeleted = optBool(r['includeDeleted'], 'includeDeleted')
  return { id: id(r['id']), ...(includeDeleted !== undefined ? { includeDeleted } : {}) }
}

export function createInput(v: unknown): NoteCreateInput {
  const r = object(v, 'input')
  const origin = r['origin'] === undefined ? 'unknown' : r['origin']
  if (!ORIGINS.includes(origin as CreationOrigin)) throw bad('unknown origin')
  const out: NoteCreateInput = { origin: origin as CreationOrigin }
  if (r['title'] !== undefined) out.title = textOrNull(r['title'], 'title')
  if (r['calendarEvent'] !== undefined) out.calendarEvent = calendarEventOrNull(r['calendarEvent'], 'calendarEvent')
  if (r['notes'] !== undefined) out.notes = json(r['notes'], 'notes')
  const transcribe = optBool(r['transcribe'], 'transcribe')
  if (transcribe !== undefined) out.transcribe = transcribe
  return out
}

/** NotePatch keys only; everything else is dropped. */
export function notePatch(v: unknown): { patch: NotePatch; dropped: string[] } {
  const p = object(v, 'patch')
  const patch: NotePatch = {}
  const dropped: string[] = []
  for (const [key, value] of Object.entries(p)) {
    if (value === undefined) continue
    switch (key) {
      case 'title':
        patch.title = textOrNull(value, key)
        break
      case 'notes':
        patch.notes = json(value, key)
        break
      case 'notes_text':
        patch.notes_text = textOrNull(value, key)
        break
      case 'notes_md':
        patch.notes_md = textOrNull(value, key)
        break
      case 'private_notes_visible':
        if (typeof value !== 'boolean') throw bad(`${key} must be a boolean`)
        patch.private_notes_visible = value
        break
      case 'people':
        if (value !== null) object(value, key)
        patch.people = json(value, key) as NotePatch['people']
        break
      case 'linked_event':
        patch.linked_event = calendarEventOrNull(value, key)
        break
      case 'counts_as_meeting':
        if (value !== null && typeof value !== 'boolean') throw bad(`${key} must be a boolean or null`)
        patch.counts_as_meeting = value
        break
      default:
        dropped.push(key)
    }
  }
  return { patch, dropped }
}

export function findByEvent(v: unknown): { eventId: string; startTime?: string } {
  const r = object(v, 'request')
  if (typeof r['eventId'] !== 'string' || !r['eventId'] || r['eventId'].length > 1024) {
    throw bad('eventId must be 1–1024 characters')
  }
  if (r['startTime'] === undefined) return { eventId: r['eventId'] }
  const startTime = isoOrNull(r['startTime'], 'startTime')
  return startTime === null ? { eventId: r['eventId'] } : { eventId: r['eventId'], startTime }
}

export function roomId(v: unknown): string {
  if (typeof v !== 'string' || !ROOM_ID.test(v)) throw bad('roomId must be <notes|summary>:1:<id>')
  return v
}

export function ydocAppend(v: unknown): { roomId: string; update: Uint8Array; origin: string } {
  const r = object(v, 'request')
  const update = r['update']
  if (!(update instanceof Uint8Array) || update.byteLength === 0 || update.byteLength > MAX_YDOC_UPDATE_BYTES) {
    throw bad('update must be non-empty bytes under 16 MB')
  }
  const origin = r['origin']
  if (typeof origin !== 'string' || origin.length > 200) throw bad('origin must be a short string')
  return { roomId: roomId(r['roomId']), update, origin }
}

/** The permanent delete: the dialog's confirmation is part of the request. */
export function deletePermanentlyRequest(v: unknown): { id: string } {
  const r = object(v, 'request')
  if (r['confirmed'] !== true) throw bad('confirmed must be true: a permanent delete needs the confirmation dialog')
  return { id: id(r['id']) }
}

/** The empty-note auto-delete request. */
export function autoDeleteRequest(v: unknown): AutoDeleteRequest {
  const r = object(v, 'request')
  const path = r['path']
  if (path !== 'leave' && path !== 'indicator') throw bad("path must be 'leave' or 'indicator'")
  const out: AutoDeleteRequest = { id: id(r['id']), path }
  const length = r['editorTextLength']
  if (length !== undefined) {
    if (typeof length !== 'number' || !Number.isFinite(length) || length < 0) throw bad('editorTextLength must be a number')
    out.editorTextLength = Math.floor(length)
  }
  const inNavHistory = optBool(r['inNavHistory'], 'inNavHistory')
  if (inNavHistory !== undefined) out.inNavHistory = inNavHistory
  return out
}

/** PanelPatch keys only; generation fields are main-only. */
export function panelPatch(v: unknown): { patch: PanelPatch; dropped: string[] } {
  const p = object(v, 'patch')
  const patch: PanelPatch = {}
  const dropped: string[] = []
  for (const [key, value] of Object.entries(p)) {
    if (value === undefined) continue
    switch (key) {
      case 'title':
        if (typeof value !== 'string' || value.length > 1000) throw bad('title must be a string')
        patch.title = value
        break
      case 'content':
        patch.content = json(value, key)
        break
      case 'content_markdown':
        patch.content_markdown = textOrNull(value, key)
        break
      case 'last_opened_at':
        patch.last_opened_at = isoOrNull(value, key)
        break
      case 'deleted_at':
        patch.deleted_at = isoOrNull(value, key)
        break
      default:
        dropped.push(key)
    }
  }
  return { patch, dropped }
}
