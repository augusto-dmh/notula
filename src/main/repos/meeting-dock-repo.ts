// SPDX-License-Identifier: Apache-2.0
// Meeting dock: the storage-worker side of its StorageApi group. Worker-safe: no Electron imports.
//
// One row per note (`meeting_dock_history`, cascades with the note): the exchanges, the pending
// question and the draft input. An unreadable stored value starts empty.

import type { MeetingDockExchange, MeetingDockHistory } from '@shared/types/meeting-dock'
import { nowIso, parseJson } from '../storage/rows'
import { invalid, type StoreCtx } from '../storage/store'

type Row = Record<string, unknown>

const MAX_EXCHANGES = 200
const MAX_TEXT = 100_000

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

function exchangeOf(v: unknown): MeetingDockExchange | null {
  if (!isObject(v) || typeof v['id'] !== 'string' || typeof v['question'] !== 'string' || typeof v['answer'] !== 'string') return null
  const status = v['status'] === 'error' || v['status'] === 'interrupted' ? v['status'] : 'done'
  const sources = Array.isArray(v['sources'])
    ? v['sources']
        .filter((s): s is Record<string, unknown> => isObject(s) && typeof s['noteId'] === 'string')
        .map((s) => ({
          noteId: String(s['noteId']),
          title: typeof s['title'] === 'string' ? s['title'] : null,
          kind: s['kind'] === 'note' ? ('note' as const) : ('transcript' as const)
        }))
    : []
  return {
    id: v['id'],
    question: v['question'].slice(0, MAX_TEXT),
    answer: v['answer'].slice(0, MAX_TEXT),
    status,
    at: typeof v['at'] === 'string' ? v['at'] : nowIso(),
    sources
  }
}

function pendingOf(v: unknown): MeetingDockHistory['pending'] {
  if (!isObject(v) || typeof v['question'] !== 'string') return null
  return { question: v['question'].slice(0, MAX_TEXT), startedAt: typeof v['startedAt'] === 'string' ? v['startedAt'] : nowIso() }
}

export function getMeetingDockHistory(s: StoreCtx, noteId: string): MeetingDockHistory | null {
  if (typeof noteId !== 'string' || !noteId) return null
  const r = s.db
    .prepare(`SELECT exchanges, pending, input FROM meeting_dock_history WHERE document_id = ? AND owner_id = ?`)
    .get(noteId, s.identity.ownerId) as Row | undefined
  if (!r) return null
  const exchanges = parseJson<unknown[]>(r['exchanges'], [])
  return {
    noteId,
    exchanges: (Array.isArray(exchanges) ? exchanges : []).map(exchangeOf).filter((e): e is MeetingDockExchange => e !== null),
    pending: pendingOf(parseJson<unknown>(r['pending'], null)),
    input: typeof r['input'] === 'string' ? r['input'] : ''
  }
}

export function saveMeetingDockHistory(s: StoreCtx, h: MeetingDockHistory): void {
  if (!isObject(h) || typeof h.noteId !== 'string' || !h.noteId) throw invalid('noteId is required')
  if (!Array.isArray(h.exchanges)) throw invalid('exchanges must be a list')
  const exchanges = h.exchanges.map(exchangeOf).filter((e): e is MeetingDockExchange => e !== null).slice(-MAX_EXCHANGES)
  const pending = pendingOf(h.pending)
  const input = typeof h.input === 'string' ? h.input.slice(0, MAX_TEXT) : ''
  const exists = s.db.prepare(`SELECT 1 FROM documents WHERE id = ? AND owner_id = ?`).get(h.noteId, s.identity.ownerId)
  if (!exists) throw invalid(`note ${h.noteId} not found`)
  s.db
    .prepare(
      `INSERT INTO meeting_dock_history (document_id, workspace_id, owner_id, exchanges, pending, input, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (document_id) DO UPDATE SET exchanges = excluded.exchanges, pending = excluded.pending,
         input = excluded.input, updated_at = excluded.updated_at`
    )
    .run(h.noteId, s.identity.workspaceId, s.identity.ownerId, JSON.stringify(exchanges), pending ? JSON.stringify(pending) : null, input, nowIso())
  s.touch('meeting_dock_history', h.noteId)
}
