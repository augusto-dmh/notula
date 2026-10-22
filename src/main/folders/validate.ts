// SPDX-License-Identifier: Apache-2.0
// Payload whitelisting for the folder IPC. A renderer payload is rebuilt from
// known keys only; the storage repo then applies the folder rules (depth, cycles,
// ownership) on what is left.

import { notulaError } from '@shared/errors'
import type {
  FolderCreate,
  FolderNoteSource,
  FolderPatch,
  FolderPresetId,
  FolderRuleInput,
  FolderRuleTarget
} from '@shared/types/folders'
import type { TemplateIcon } from '@shared/types/templates'
import { id, object } from '../notes/validate'

const bad = (message: string): Error => notulaError('invalid-input', message)

const PRESETS: readonly FolderPresetId[] = [
  'interviews',
  'standups',
  'projects',
  'sales_pipeline',
  'team_syncs',
  'coaching',
  'demos',
  'client_meetings'
]
const SOURCES: readonly FolderNoteSource[] = [
  'manual',
  'palette',
  'dragged',
  'add_notes',
  'suggestion',
  'series_rule'
]
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_TITLE = 500
const MAX_DESCRIPTION = 10_000
const MAX_NOTE_IDS = 10_000
const MAX_TEXT_ID = 1_024

function text(v: unknown, what: string, max: number): string {
  if (typeof v !== 'string' || v.length > max) throw bad(`${what} must be a string of at most ${max} characters`)
  return v
}

function textOrNull(v: unknown, what: string, max: number): string | null {
  return v === null ? null : text(v, what, max)
}

function icon(v: unknown): TemplateIcon | null {
  if (v === null) return null
  const o = object(v, 'icon')
  if (o['type'] === 'icon') return { type: 'icon', value: text(o['value'], 'icon.value', 64), color: text(o['color'], 'icon.color', 64) }
  if (o['type'] === 'emoji') {
    return { type: 'emoji', value: text(o['value'], 'icon.value', 64), hexcode: text(o['hexcode'], 'icon.hexcode', 64) }
  }
  throw bad("icon.type must be 'icon' or 'emoji'")
}

function parentId(v: unknown, what: string): string | null {
  return v === null ? null : id(v, what)
}

export function createRequest(v: unknown): FolderCreate {
  const r = object(v, 'folder')
  const out: FolderCreate = { title: text(r['title'], 'title', MAX_TITLE) }
  if (r['id'] !== undefined) {
    if (typeof r['id'] !== 'string' || !UUID.test(r['id'])) throw bad('id must be a UUID')
    out.id = r['id']
  }
  if (r['description'] !== undefined) out.description = textOrNull(r['description'], 'description', MAX_DESCRIPTION)
  if (r['icon'] !== undefined) out.icon = icon(r['icon'])
  if (r['parentId'] !== undefined) out.parentId = parentId(r['parentId'], 'parentId')
  if (r['preset'] !== undefined && r['preset'] !== null) {
    if (!PRESETS.includes(r['preset'] as FolderPresetId)) throw bad('unknown preset')
    out.preset = r['preset'] as FolderPresetId
  }
  return out
}

export function updateRequest(v: unknown): { id: string; patch: FolderPatch } {
  const r = object(v, 'request')
  const p = object(r['patch'], 'patch')
  const patch: FolderPatch = {}
  if (p['title'] !== undefined) patch.title = text(p['title'], 'title', MAX_TITLE)
  if (p['description'] !== undefined) patch.description = textOrNull(p['description'], 'description', MAX_DESCRIPTION)
  if (p['icon'] !== undefined) patch.icon = icon(p['icon'])
  if (p['is_favourite'] !== undefined) {
    if (typeof p['is_favourite'] !== 'boolean') throw bad('is_favourite must be a boolean')
    patch.is_favourite = p['is_favourite']
  }
  if (p['parent_id'] !== undefined) patch.parent_id = parentId(p['parent_id'], 'parent_id')
  return { id: id(r['id']), patch }
}

/** Only the confirmation dialog sends `confirmed: true`. */
export function deleteRequest(v: unknown): { id: string; confirmed: true } {
  const r = object(v, 'request')
  if (r['confirmed'] !== true) throw bad('confirmed must be true')
  return { id: id(r['id']), confirmed: true }
}

export function addNotesRequest(v: unknown): { folderId: string; noteIds: string[]; source: FolderNoteSource } {
  const r = object(v, 'request')
  const list = r['noteIds']
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_NOTE_IDS) {
    throw bad(`noteIds must be an array of 1 to ${MAX_NOTE_IDS} ids`)
  }
  if (!SOURCES.includes(r['source'] as FolderNoteSource)) throw bad('unknown source')
  return {
    folderId: id(r['folderId'], 'folderId'),
    noteIds: list.map((x) => id(x, 'noteIds[]')),
    source: r['source'] as FolderNoteSource
  }
}

export function removeNoteRequest(v: unknown): { folderId: string; noteId: string } {
  const r = object(v, 'request')
  return { folderId: id(r['folderId'], 'folderId'), noteId: id(r['noteId'], 'noteId') }
}

function target(v: unknown): FolderRuleTarget {
  const t = object(v, 'target')
  if (t['type'] === 'single') return { type: 'single', event_id: text(t['event_id'], 'target.event_id', MAX_TEXT_ID) }
  if (t['type'] === 'all') {
    const skip = t['excluded_event_ids']
    if (!Array.isArray(skip) || skip.length > 10_000) throw bad('target.excluded_event_ids must be an array')
    return { type: 'all', excluded_event_ids: skip.map((x) => text(x, 'target.excluded_event_ids[]', MAX_TEXT_ID)) }
  }
  throw bad("target.type must be 'single' or 'all'")
}

export function ruleRequest(v: unknown): FolderRuleInput {
  const r = object(v, 'rule')
  const series = text(r['recurringEventId'], 'recurringEventId', MAX_TEXT_ID)
  if (!series) throw bad('recurringEventId must not be empty')
  return { folderId: id(r['folderId'], 'folderId'), recurringEventId: series, target: target(r['target']) }
}

export function idRequest(v: unknown, key: 'id' | 'noteId'): string {
  return id(object(v, 'request')[key], key)
}
