// SPDX-License-Identifier: Apache-2.0
// Consent: the storage-worker side of its StorageApi group. Worker-safe: no Electron imports.
//
// One record per note (`consent_posts.note_id` is UNIQUE). It never holds the message text.

import type { ConsentChannel, ConsentReason, ConsentStatusValue } from '@shared/types/consent'
import type { ConsentPostRow } from '../storage/api'
import { nowIso } from '../storage/rows'
import { inTransaction, invalid, type StoreCtx } from '../storage/store'

type Row = Record<string, unknown>

const CHANNELS: readonly ConsentChannel[] = ['zoom', 'teams', 'meet']
const STATUSES: readonly ConsentStatusValue[] = ['attempted', 'success', 'failure', 'unavailable', 'copied', 'confirmed', 'cancelled']
const REASONS: readonly ConsentReason[] = [
  'composer-missing',
  'composer-not-empty',
  'composer-partial-text',
  'composer-unreadable',
  'several-meeting-windows',
  'foreground-lost',
  'timeout',
  'helper-unavailable'
]

function str(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null
}

function toPost(r: Row): ConsentPostRow {
  return {
    id: String(r['id']),
    note_id: String(r['note_id']),
    channel: CHANNELS.includes(r['channel'] as ConsentChannel) ? (r['channel'] as ConsentChannel) : null,
    status: STATUSES.includes(r['status'] as ConsentStatusValue) ? (r['status'] as ConsentStatusValue) : 'failure',
    reason: REASONS.includes(r['reason'] as ConsentReason) ? (r['reason'] as ConsentReason) : null,
    attempted_at: str(r['attempted_at']),
    completed_at: str(r['completed_at'])
  }
}

export function getConsentPost(s: StoreCtx, noteId: string): ConsentPostRow | null {
  if (typeof noteId !== 'string' || !noteId) return null
  const r = s.db
    .prepare(`SELECT * FROM consent_posts WHERE note_id = ? AND owner_id = ? AND workspace_id = ?`)
    .get(noteId, s.identity.ownerId, s.identity.workspaceId) as Row | undefined
  return r ? toPost(r) : null
}

export function upsertConsentPost(s: StoreCtx, p: ConsentPostRow): ConsentPostRow {
  if (!p || typeof p.id !== 'string' || !p.id || typeof p.note_id !== 'string' || !p.note_id) throw invalid('id and note_id are required')
  if (!STATUSES.includes(p.status)) throw invalid('unknown consent status')
  if (p.channel !== null && !CHANNELS.includes(p.channel)) throw invalid('unknown consent channel')
  if (p.reason !== null && !REASONS.includes(p.reason)) throw invalid('unknown consent reason')
  const now = nowIso()
  return inTransaction(s.db, () => {
    const exists = s.db.prepare(`SELECT 1 FROM documents WHERE id = ?`).get(p.note_id)
    if (!exists) throw invalid(`note ${p.note_id} not found`)
    s.db
      .prepare(
        `INSERT INTO consent_posts (id, workspace_id, owner_id, note_id, channel, status, reason, attempted_at, completed_at, created_at, updated_at)
         VALUES (@id, @ws, @owner, @note, @channel, @status, @reason, @attempted, @completed, @now, @now)
         ON CONFLICT (note_id) DO UPDATE SET channel = excluded.channel, status = excluded.status, reason = excluded.reason,
           attempted_at = excluded.attempted_at, completed_at = excluded.completed_at, updated_at = excluded.updated_at`
      )
      .run({
        id: p.id,
        ws: s.identity.workspaceId,
        owner: s.identity.ownerId,
        note: p.note_id,
        channel: p.channel,
        status: p.status,
        reason: p.reason,
        attempted: p.attempted_at,
        completed: p.completed_at,
        now
      })
    s.touch('consent_posts', p.note_id)
    return getConsentPost(s, p.note_id) as ConsentPostRow
  })
}
