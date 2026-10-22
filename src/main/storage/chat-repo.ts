// SPDX-License-Identifier: Apache-2.0
// The `chat_threads` and `chat_messages` tables.
// Deletes are soft; threads survive a note purge, so a `meeting:<id>` key may
// point at a note that no longer exists.
//
// Order: messages by turn index, the user message
// before the assistant one within a turn, then by creation time. Threads: pinned
// first, then the newest `updated_at`. Writing a message touches its thread.

import type { ChatMessage, ChatThread, ChatThreadQuery } from '@shared/types/chat'
import { CHAT_LIMITS } from '@shared/types/chat'
import type { ChatMessageUpsert, ChatThreadUpsert } from './api'
import { nowIso, parseJson } from './rows'
import { inTransaction, invalid, notFound, type StoreCtx } from './store'

const THREAD_COLS = [
  'id',
  'workspace_id',
  'owner_id',
  'created_at',
  'updated_at',
  'deleted_at',
  'creation_platform',
  'title',
  'grouping_key',
  'initiated_by',
  'is_pinned'
].join(', ')

/**
 * `needs_input`, computed. The thread's newest assistant
 * message holds a tool call whose approval (a write or a question) is still pending.
 */
const NEEDS_INPUT = `(
  SELECT EXISTS (
    SELECT 1 FROM json_each(CASE WHEN json_valid(m.outputs) THEN m.outputs ELSE '[]' END) o
    WHERE json_extract(o.value, '$.type') = 'tool_call'
      AND json_extract(o.value, '$.tool_call.approval.status') = 'pending'
  )
  FROM chat_messages m
  WHERE m.thread_id = chat_threads.id AND m.role = 'assistant' AND m.deleted_at IS NULL
  ORDER BY m.turn_index DESC, m.created_at DESC, m.rid DESC
  LIMIT 1
) AS needs_input`

const MESSAGE_COLS = [
  'id',
  'thread_id',
  'workspace_id',
  'owner_id',
  'created_at',
  'updated_at',
  'deleted_at',
  'role',
  'turn_index',
  'attachments',
  'raw_text',
  'context',
  'sources',
  'outputs',
  'status',
  'custom_type',
  'trace_id'
].join(', ')

const PLATFORMS = ['web', 'macos', 'ios', 'windows', 'android', 'watchos', 'mcp'] as const
const STATUSES = ['in_progress', 'completed', 'error', 'cancelled'] as const
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_KEY = 500
const MAX_TEXT = 200_000
/** One stored JSON column (outputs with tool results, a context with its documents). */
const MAX_JSON = 4_000_000

/** `role` sorts the user message first within a turn. */
const ORDER = `turn_index ASC, CASE role WHEN 'user' THEN 0 ELSE 1 END ASC, created_at ASC, rid ASC`

type Row = Record<string, unknown>

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null)

function toThread(r: Row): ChatThread {
  const platform = str(r['creation_platform'])
  return {
    id: str(r['id']),
    workspace_id: str(r['workspace_id']),
    owner_id: str(r['owner_id']),
    created_at: str(r['created_at']),
    updated_at: str(r['updated_at']),
    deleted_at: strOrNull(r['deleted_at']),
    creation_platform: (PLATFORMS as readonly string[]).includes(platform) ? (platform as ChatThread['creation_platform']) : 'web',
    title: strOrNull(r['title']),
    grouping_key: strOrNull(r['grouping_key']),
    initiated_by: r['initiated_by'] === 'dispatch' ? 'dispatch' : 'user',
    is_pinned: r['is_pinned'] === 1 || r['is_pinned'] === true,
    // Computed by the chat engine (a pending approval or question on the newest answer).
    needs_input: Number(r['needs_input'] ?? 0) === 1
  }
}

function toMessage(r: Row): ChatMessage {
  const status = str(r['status'])
  return {
    id: str(r['id']),
    thread_id: str(r['thread_id']),
    workspace_id: str(r['workspace_id']),
    owner_id: str(r['owner_id']),
    created_at: str(r['created_at']),
    updated_at: str(r['updated_at']),
    deleted_at: strOrNull(r['deleted_at']),
    role: r['role'] === 'assistant' ? 'assistant' : 'user',
    turn_index: Number(r['turn_index']) || 0,
    attachments: parseJson<unknown[]>(r['attachments'], []),
    raw_text: str(r['raw_text']),
    context: parseJson<ChatMessage['context']>(r['context'], null),
    sources: parseJson<ChatMessage['sources']>(r['sources'], null),
    outputs: parseJson<ChatMessage['outputs']>(r['outputs'], null),
    status: (STATUSES as readonly string[]).includes(status) ? (status as ChatMessage['status']) : 'completed',
    custom_type: strOrNull(r['custom_type']),
    trace_id: strOrNull(r['trace_id'])
  }
}

function uuid(v: unknown, what: string): string {
  if (typeof v !== 'string' || !UUID.test(v)) throw invalid(`${what} must be a UUID`)
  return v.toLowerCase()
}

function json(v: unknown, what: string): string | null {
  if (v === null || v === undefined) return null
  const text = JSON.stringify(v)
  if (text.length > MAX_JSON) throw invalid(`${what} is too large`)
  return text
}

/** Any row of the owner's, deleted ones included. */
function threadRow(s: StoreCtx, id: string): ChatThread | null {
  const row = s.db.prepare(`SELECT ${THREAD_COLS}, ${NEEDS_INPUT} FROM chat_threads WHERE id = ? AND owner_id = ?`).get(id, s.identity.ownerId) as
    | Row
    | undefined
  return row ? toThread(row) : null
}

function messageRow(s: StoreCtx, id: string): (ChatMessage & { rid: number }) | null {
  const row = s.db
    .prepare(`SELECT rid, ${MESSAGE_COLS} FROM chat_messages WHERE id = ? AND owner_id = ?`)
    .get(id, s.identity.ownerId) as Row | undefined
  return row ? { ...toMessage(row), rid: Number(row['rid']) } : null
}

/** No `groupingKey` = every key. Dispatch-initiated threads only when asked. */
export function listChatThreads(s: StoreCtx, q: ChatThreadQuery): ChatThread[] {
  if (q !== undefined && (typeof q !== 'object' || q === null)) throw invalid('query must be an object')
  const key = q?.groupingKey
  if (key !== undefined && (typeof key !== 'string' || key.length > MAX_KEY)) throw invalid('groupingKey is invalid')
  const rows = s.db
    .prepare(
      `SELECT ${THREAD_COLS}, ${NEEDS_INPUT} FROM chat_threads
       WHERE owner_id = @owner AND deleted_at IS NULL
         AND (@key IS NULL OR grouping_key = @key)
         AND (@dispatch = 1 OR initiated_by = 'user')
       ORDER BY is_pinned DESC, updated_at DESC, rid DESC`
    )
    .all({ owner: s.identity.ownerId, key: key ?? null, dispatch: q?.includeDispatch === true ? 1 : 0 }) as Row[]
  return rows.map(toThread)
}

/** A live thread; null when missing or deleted. */
export function getChatThread(s: StoreCtx, id: string): ChatThread | null {
  if (typeof id !== 'string') throw invalid('id must be a string')
  const t = threadRow(s, id.toLowerCase())
  return t && !t.deleted_at ? t : null
}

/**
 * Creates the thread, or updates the fields given. Pinning beyond the limit rejects
 * `invalid-input: Maximum of 10 pinned chats`. A rename or a pin does
 * not move `updated_at`, so the thread keeps its place in the date groups.
 */
export function upsertChatThread(s: StoreCtx, t: ChatThreadUpsert): ChatThread {
  if (typeof t !== 'object' || t === null) throw invalid('thread must be an object')
  const id = uuid(t.id, 'id')
  if (t.title !== undefined && t.title !== null && (typeof t.title !== 'string' || t.title.length > 1_000)) throw invalid('title is invalid')
  if (t.grouping_key !== undefined && t.grouping_key !== null && (typeof t.grouping_key !== 'string' || t.grouping_key.length > MAX_KEY)) {
    throw invalid('grouping_key is invalid')
  }
  if (t.creation_platform !== undefined && !(PLATFORMS as readonly string[]).includes(t.creation_platform)) {
    throw invalid('creation_platform is invalid')
  }
  if (t.initiated_by !== undefined && t.initiated_by !== 'user' && t.initiated_by !== 'dispatch') throw invalid('initiated_by is invalid')
  if (t.is_pinned !== undefined && typeof t.is_pinned !== 'boolean') throw invalid('is_pinned must be a boolean')

  return inTransaction(s.db, () => {
    const current = threadRow(s, id)
    if (!current && s.db.prepare(`SELECT 1 FROM chat_threads WHERE id = ?`).get(id)) throw notFound('chat thread', id)
    if (t.is_pinned === true && !current?.is_pinned) {
      const pinned = s.db
        .prepare(`SELECT COUNT(*) AS n FROM chat_threads WHERE owner_id = ? AND is_pinned = 1 AND deleted_at IS NULL AND id != ?`)
        .get(s.identity.ownerId, id) as { n: number }
      if (pinned.n >= CHAT_LIMITS.maxPinned) throw invalid(`Maximum of ${CHAT_LIMITS.maxPinned} pinned chats`)
    }
    const now = nowIso()
    if (!current) {
      s.db
        .prepare(
          `INSERT INTO chat_threads (id, workspace_id, owner_id, created_at, updated_at, deleted_at, creation_platform,
             title, grouping_key, initiated_by, is_pinned)
           VALUES (@id, @workspace, @owner, @now, @now, @deleted_at, @platform, @title, @key, @initiated_by, @pinned)`
        )
        .run({
          id,
          workspace: s.identity.workspaceId,
          owner: s.identity.ownerId,
          now,
          deleted_at: t.deleted_at ?? null,
          platform: t.creation_platform ?? 'web',
          title: t.title ?? null,
          key: t.grouping_key ?? null,
          initiated_by: t.initiated_by ?? 'user',
          pinned: t.is_pinned ? 1 : 0
        })
    } else {
      const sets: string[] = []
      const params: Record<string, unknown> = { id }
      const set = (col: string, value: unknown): void => {
        sets.push(`${col} = @${col}`)
        params[col] = value
      }
      if (t.title !== undefined) set('title', t.title)
      if (t.grouping_key !== undefined) set('grouping_key', t.grouping_key)
      if (t.creation_platform !== undefined) set('creation_platform', t.creation_platform)
      if (t.initiated_by !== undefined) set('initiated_by', t.initiated_by)
      if (t.is_pinned !== undefined) set('is_pinned', t.is_pinned ? 1 : 0)
      if (t.deleted_at !== undefined) set('deleted_at', t.deleted_at)
      if (sets.length > 0) s.db.prepare(`UPDATE chat_threads SET ${sets.join(', ')} WHERE id = @id`).run(params)
    }
    s.touch('chat_threads', id)
    return threadRow(s, id) as ChatThread
  })
}

/** Soft: the thread and its messages. */
export function deleteChatThread(s: StoreCtx, id: string): void {
  const tid = uuid(id, 'id')
  const current = threadRow(s, tid)
  if (!current) throw notFound('chat thread', tid)
  if (current.deleted_at) return
  const now = nowIso()
  inTransaction(s.db, () => {
    s.db.prepare(`UPDATE chat_threads SET deleted_at = ?, is_pinned = 0 WHERE id = ?`).run(now, tid)
    s.db.prepare(`UPDATE chat_messages SET deleted_at = ? WHERE thread_id = ? AND deleted_at IS NULL`).run(now, tid)
  })
  s.touch('chat_threads', tid)
  s.touch('chat_messages', tid)
}

export function listChatMessages(s: StoreCtx, threadId: string): ChatMessage[] {
  const tid = uuid(threadId, 'threadId')
  const rows = s.db
    .prepare(`SELECT ${MESSAGE_COLS} FROM chat_messages WHERE thread_id = ? AND owner_id = ? AND deleted_at IS NULL ORDER BY ${ORDER}`)
    .all(tid, s.identity.ownerId) as Row[]
  return rows.map(toMessage)
}

/** Inserts or replaces a message of a live thread, and touches the thread. */
export function upsertChatMessage(s: StoreCtx, m: ChatMessageUpsert): ChatMessage {
  if (typeof m !== 'object' || m === null) throw invalid('message must be an object')
  const id = uuid(m.id, 'id')
  const threadId = uuid(m.thread_id, 'thread_id')
  if (m.role !== 'user' && m.role !== 'assistant') throw invalid('role is invalid')
  if (!(STATUSES as readonly string[]).includes(m.status)) throw invalid('status is invalid')
  if (!Number.isInteger(m.turn_index) || m.turn_index < 0) throw invalid('turn_index must be a non-negative integer')
  if (typeof m.raw_text !== 'string' || m.raw_text.length > MAX_TEXT) throw invalid('raw_text is invalid')
  if (!Array.isArray(m.attachments)) throw invalid('attachments must be an array')
  if (m.outputs !== null && !Array.isArray(m.outputs)) throw invalid('outputs must be an array or null')

  const params = {
    id,
    thread_id: threadId,
    workspace: s.identity.workspaceId,
    owner: s.identity.ownerId,
    role: m.role,
    turn_index: m.turn_index,
    attachments: json(m.attachments, 'attachments') ?? '[]',
    raw_text: m.raw_text,
    context: json(m.context, 'context'),
    sources: json(m.sources, 'sources'),
    outputs: json(m.outputs, 'outputs'),
    status: m.status,
    custom_type: m.custom_type ?? null,
    trace_id: m.trace_id ?? null,
    now: nowIso()
  }
  inTransaction(s.db, () => {
    const thread = threadRow(s, threadId)
    if (!thread || thread.deleted_at) throw notFound('chat thread', threadId)
    const current = messageRow(s, id)
    if (current && current.thread_id !== threadId) throw invalid('message belongs to another thread')
    if (!current && s.db.prepare(`SELECT 1 FROM chat_messages WHERE id = ?`).get(id)) throw notFound('chat message', id)
    if (current) {
      s.db
        .prepare(
          `UPDATE chat_messages SET role = @role, turn_index = @turn_index, attachments = @attachments, raw_text = @raw_text,
             context = @context, sources = @sources, outputs = @outputs, status = @status, custom_type = @custom_type,
             trace_id = @trace_id, updated_at = @now, deleted_at = NULL
           WHERE id = @id`
        )
        .run(params)
    } else {
      s.db
        .prepare(
          `INSERT INTO chat_messages (id, thread_id, workspace_id, owner_id, created_at, updated_at, deleted_at, role, turn_index,
             attachments, raw_text, context, sources, outputs, status, custom_type, trace_id)
           VALUES (@id, @thread_id, @workspace, @owner, @now, @now, NULL, @role, @turn_index, @attachments, @raw_text, @context,
             @sources, @outputs, @status, @custom_type, @trace_id)`
        )
        .run(params)
    }
    // Writing a message moves the thread up the list.
    s.db.prepare(`UPDATE chat_threads SET updated_at = ? WHERE id = ?`).run(params.now, threadId)
  })
  s.touch('chat_messages', id)
  s.touch('chat_threads', threadId)
  return toMessage(s.db.prepare(`SELECT ${MESSAGE_COLS} FROM chat_messages WHERE id = ?`).get(id) as Row)
}

/** Soft-deletes every message of the thread after `messageId` (an edit or a retry). */
export function truncateChatMessagesAfter(s: StoreCtx, threadId: string, messageId: string): number {
  const tid = uuid(threadId, 'threadId')
  const mid = uuid(messageId, 'messageId')
  const m = messageRow(s, mid)
  if (!m || m.thread_id !== tid) throw notFound('chat message', mid)
  const rank = m.role === 'user' ? 0 : 1
  const result = inTransaction(s.db, () =>
    s.db
      .prepare(
        `UPDATE chat_messages SET deleted_at = @now
         WHERE thread_id = @tid AND deleted_at IS NULL AND id != @mid
           AND (turn_index, CASE role WHEN 'user' THEN 0 ELSE 1 END, created_at, rid) > (@turn, @rank, @created, @rid)`
      )
      .run({ now: nowIso(), tid, mid, turn: m.turn_index, rank, created: m.created_at, rid: m.rid })
  )
  if (result.changes > 0) {
    s.touch('chat_messages', mid)
    s.touch('chat_threads', tid)
  }
  return result.changes
}
