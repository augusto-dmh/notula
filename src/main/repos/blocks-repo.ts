// SPDX-License-Identifier: Apache-2.0
// Workflow blocks: the storage-worker side of their StorageApi group. Worker-safe: no Electron imports.
//
// - Content is validated in main before it gets here; the repo only checks the envelope.
// - Optimistic concurrency: a write with `expectedUpdatedAt` that no longer matches returns
//   `{ stale: true }`. Every write moves `updated_at` strictly forward, so two writes in the same
//   millisecond still get different stamps.
// - Rows go with their chat thread (trigger `workflow_blocks_thread_au`, migration 5).

import { randomUUID } from 'node:crypto'
import type { IsoTime } from '@shared/types/common'
import type { BlockExecution, WorkflowBlock, WorkflowBlockType } from '@shared/types/workflow-blocks'
import type { NewWorkflowBlock } from '../storage/api'
import { nowIso, parseJson } from '../storage/rows'
import { inTransaction, invalid, notFound, type StoreCtx } from '../storage/store'

type Row = Record<string, unknown>

const TYPES: readonly WorkflowBlockType[] = ['calendar_event', 'email', 'slack_message', 'crm_update', 'google_doc', 'markdown']
/** The serialized content's cap (a calendar draft or an email is far below it). */
const MAX_CONTENT_CHARS = 200_000

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)

function toBlock(r: Row): WorkflowBlock {
  return {
    id: String(r['id']),
    type: String(r['type']) as WorkflowBlockType,
    source_type: 'chat_thread',
    source_id: String(r['source_id']),
    assistant_message_id: str(r['assistant_message_id']),
    tool_call_id: str(r['tool_call_id']),
    content: parseJson<unknown>(r['content'], null),
    execution: parseJson<BlockExecution | null>(r['execution'], null),
    dismissed_at: str(r['dismissed_at']),
    created_at: String(r['created_at']),
    updated_at: String(r['updated_at'])
  }
}

function row(s: StoreCtx, id: string): Row | undefined {
  return s.db
    .prepare('SELECT * FROM workflow_blocks WHERE id = ? AND owner_id = ? AND workspace_id = ?')
    .get(id, s.identity.ownerId, s.identity.workspaceId) as Row | undefined
}

/** A stamp after `prev`, even within the same millisecond. */
function nextStamp(prev: string): IsoTime {
  const now = nowIso()
  if (now > prev) return now
  const t = Date.parse(prev)
  return new Date((Number.isFinite(t) ? t : Date.now()) + 1).toISOString()
}

function contentJson(content: unknown): string {
  const text = JSON.stringify(content ?? null)
  if (text.length > MAX_CONTENT_CHARS) throw invalid('The draft is too large')
  return text
}

export function getWorkflowBlock(s: StoreCtx, id: string): WorkflowBlock | null {
  if (typeof id !== 'string' || !id) return null
  const r = row(s, id)
  return r ? toBlock(r) : null
}

export function listWorkflowBlocks(s: StoreCtx, q: { sourceType: 'chat_thread'; sourceId: string }): WorkflowBlock[] {
  if (q?.sourceType !== 'chat_thread' || typeof q.sourceId !== 'string' || !q.sourceId) throw invalid('sourceType and sourceId are required')
  const rows = s.db
    .prepare(
      `SELECT * FROM workflow_blocks WHERE owner_id = ? AND workspace_id = ? AND source_type = 'chat_thread' AND source_id = ?
       ORDER BY created_at, rid`
    )
    .all(s.identity.ownerId, s.identity.workspaceId, q.sourceId) as Row[]
  return rows.map(toBlock)
}

export function createWorkflowBlock(s: StoreCtx, b: NewWorkflowBlock): WorkflowBlock {
  if (!TYPES.includes(b?.type)) throw invalid('Unknown block type')
  if (b.source_type !== 'chat_thread' || typeof b.source_id !== 'string' || !b.source_id) throw invalid('A block needs its chat thread')
  const id = randomUUID()
  const now = nowIso()
  s.db
    .prepare(
      `INSERT INTO workflow_blocks (id, workspace_id, owner_id, type, source_type, source_id, assistant_message_id, tool_call_id,
         content, execution, dismissed_at, created_at, updated_at)
       VALUES (@id, @workspace, @owner, @type, 'chat_thread', @source, @message, @call, @content, NULL, NULL, @now, @now)`
    )
    .run({
      id,
      workspace: s.identity.workspaceId,
      owner: s.identity.ownerId,
      type: b.type,
      source: b.source_id,
      message: str(b.assistant_message_id),
      call: str(b.tool_call_id),
      content: contentJson(b.content),
      now
    })
  s.touch('workflow_blocks', id)
  const r = row(s, id)
  if (!r) throw notFound('Block', id)
  return toBlock(r)
}

export function updateWorkflowBlock(
  s: StoreCtx,
  id: string,
  patch: { content?: unknown; dismissed_at?: IsoTime },
  expectedUpdatedAt?: IsoTime
): WorkflowBlock | { stale: true } {
  return inTransaction(s.db, () => {
    const r = row(s, id)
    if (!r) throw notFound('Block', id)
    if (expectedUpdatedAt !== undefined && String(r['updated_at']) !== expectedUpdatedAt) return { stale: true as const }
    const content = patch.content !== undefined ? contentJson(patch.content) : String(r['content'])
    const dismissed = patch.dismissed_at !== undefined ? (str(patch.dismissed_at) ?? null) : str(r['dismissed_at'])
    const stamp = nextStamp(String(r['updated_at']))
    s.db.prepare('UPDATE workflow_blocks SET content = ?, dismissed_at = ?, updated_at = ? WHERE rid = ?').run(content, dismissed, stamp, r['rid'])
    s.touch('workflow_blocks', id)
    return toBlock({ ...r, content, dismissed_at: dismissed, updated_at: stamp })
  })
}

export function setBlockExecution(s: StoreCtx, id: string, execution: BlockExecution, expectedUpdatedAt?: IsoTime): WorkflowBlock | { stale: true } {
  if (!execution || typeof execution.status !== 'string' || typeof execution.executionId !== 'string') throw invalid('execution needs a status and an executionId')
  return inTransaction(s.db, () => {
    const r = row(s, id)
    if (!r) throw notFound('Block', id)
    if (expectedUpdatedAt !== undefined && String(r['updated_at']) !== expectedUpdatedAt) return { stale: true as const }
    const text = JSON.stringify(execution)
    const stamp = nextStamp(String(r['updated_at']))
    s.db.prepare('UPDATE workflow_blocks SET execution = ?, updated_at = ? WHERE rid = ?').run(text, stamp, r['rid'])
    s.touch('workflow_blocks', id)
    return toBlock({ ...r, execution: text, updated_at: stamp })
  })
}
