// SPDX-License-Identifier: Apache-2.0
// The daily scratchpad: `scratchpad_days`, one row per
// owner and local date. `content` is the day's bullet list as ProseMirror JSON; `has_text`
// is kept by main on every save.
//
// - Listing: today, then earlier dates with text, newest first; never a later date.
// - An unreadable `content` reads as null (the renderer shows one empty bullet) and is
//   logged; the row stays until the next save.
// - Days are not notes: no search, chat context or Trash.

import { randomUUID } from 'node:crypto'
import type { IsoTime } from '@shared/types/common'
import type { ScratchpadDay, ScratchpadDaySummary } from '@shared/types/scratchpad'
import { nowIso } from './rows'
import { invalid, type StoreCtx } from './store'

const DATE = /^\d{4}-\d{2}-\d{2}$/
/** One day's outline, serialized. Far above any hand-typed day. */
const MAX_CONTENT_CHARS = 2_000_000

function requireDate(date: unknown, what = 'date'): string {
  if (typeof date !== 'string' || !DATE.test(date)) throw invalid(`${what} must be YYYY-MM-DD`)
  return date
}

export function listScratchpadDays(s: StoreCtx, today: string): ScratchpadDaySummary[] {
  requireDate(today, 'today')
  const rows = s.db
    .prepare(
      `SELECT date, has_text FROM scratchpad_days
       WHERE owner_id = @owner AND workspace_id = @workspace AND date <= @today
         AND (date = @today OR has_text = 1)
       ORDER BY date DESC`
    )
    .all({ owner: s.identity.ownerId, workspace: s.identity.workspaceId, today }) as { date: string; has_text: number }[]
  const days: ScratchpadDaySummary[] = rows.map((r) => ({ date: r.date, hasText: r.has_text === 1 }))
  if (days[0]?.date !== today) days.unshift({ date: today, hasText: false })
  return days
}

export function getScratchpadDay(s: StoreCtx, date: string): ScratchpadDay {
  requireDate(date)
  const row = s.db
    .prepare(
      `SELECT id, content, updated_at FROM scratchpad_days
       WHERE owner_id = @owner AND workspace_id = @workspace AND date = @date`
    )
    .get({ owner: s.identity.ownerId, workspace: s.identity.workspaceId, date }) as
    | { id: string; content: string; updated_at: string }
    | undefined
  if (!row) return { date, content: null, updatedAt: null }
  let content: unknown = null
  try {
    const parsed = JSON.parse(row.content) as unknown
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { content?: unknown }).content)) content = parsed
    else s.log('warn', 'scratchpad-content-unreadable', { id: row.id, reason: 'shape' })
  } catch {
    s.log('warn', 'scratchpad-content-unreadable', { id: row.id, reason: 'json' })
  }
  return { date, content, updatedAt: row.updated_at }
}

export function saveScratchpadDay(s: StoreCtx, date: string, content: unknown, hasText: boolean): { updatedAt: IsoTime } {
  requireDate(date)
  if (!content || typeof content !== 'object' || !Array.isArray((content as { content?: unknown }).content)) {
    throw invalid('content must be a document with a content array')
  }
  const json = JSON.stringify(content)
  if (json.length > MAX_CONTENT_CHARS) throw invalid('the day is too large to save')
  const now = nowIso()
  const row = s.db
    .prepare(
      `INSERT INTO scratchpad_days (id, workspace_id, owner_id, date, content, has_text, created_at, updated_at)
       VALUES (@id, @workspace, @owner, @date, @content, @hasText, @now, @now)
       ON CONFLICT (owner_id, date) DO UPDATE SET
         content = excluded.content, has_text = excluded.has_text, updated_at = excluded.updated_at
       RETURNING id`
    )
    .get({
      id: randomUUID(),
      workspace: s.identity.workspaceId,
      owner: s.identity.ownerId,
      date,
      content: json,
      hasText: hasText ? 1 : 0,
      now
    }) as { id: string }
  s.touch('scratchpad_days', row.id)
  return { updatedAt: now }
}
