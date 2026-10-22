// SPDX-License-Identifier: Apache-2.0
// The draft-block store and its `blocks:*` IPC.
//
// - Content is validated in main on every write by its type's `normalize`.
// - `blocks:update` and `blocks:execute` carry `expectedUpdatedAt`; a mismatch answers `{ stale: true }`.
// - An execution sets `creating` / `sending` / `updating` with a new `executionId` before the provider
//   call, then the final status. An in-progress execution older than 60 s reads as `unknown`, and an
//   `unknown` outcome is never retried by Notula; the user may try again only where the type's
//   provider call is idempotent (calendar events: stable ids).
// - Executors live with their features (calendar-write, mail) and register here at wiring time;
//   `slack_message` runs here through `ctx.integrations.share` (Slack bot mode), `google_doc` is a
//   preview, `markdown` has nothing to execute and `crm_update` is not built.
//
// Logs carry block ids, types and statuses only.

import { randomUUID } from 'node:crypto'
import { app, ipcMain } from 'electron'
import { notulaError } from '@shared/errors'
import type { InvokeChannel, InvokeReq, InvokeRes, PushChannel } from '@shared/ipc'
import type { IsoTime } from '@shared/types/common'
import { BLOCK_LIMITS, type BlockExecuteOptions, type BlockExecution, type WorkflowBlock, type WorkflowBlockType } from '@shared/types/workflow-blocks'
import type { MainContext } from '../context'
import { expected } from '../ipc-expected'
import { log } from '../log'
import { runWaHarness } from './dev-harness'

export const STALE_COPY = 'This draft changed. Review it and try again.'
const TYPES: readonly WorkflowBlockType[] = ['calendar_event', 'email', 'slack_message', 'crm_update', 'google_doc', 'markdown']
const IN_PROGRESS = new Set(['creating', 'sending', 'updating'])
const DONE = new Set(['created', 'sent', 'updated'])
/** A provider call that has not answered by then is `unknown`. */
const EXECUTE_TIMEOUT_MS = 55_000

export interface ExecResult {
  status: 'created' | 'sent' | 'updated' | 'failed' | 'unknown'
  errorCode?: string
  error?: string
  /** Type fields kept on the execution (`eventId`, `htmlLink`, `messageId`, …). */
  fields?: Record<string, unknown>
}

export interface BlockTypeDef {
  type: WorkflowBlockType
  /** The shape check on every write; throws `invalid-input: <message>`. Returns the stored content. */
  normalize(content: unknown): unknown
  inProgress?: 'creating' | 'sending' | 'updating'
  /** Running again after `unknown` cannot duplicate (stable provider ids). */
  idempotent?: boolean
  /** Shown when an `unknown` outcome blocks a retry. */
  unknownCopy?: string
  execute?(block: WorkflowBlock, options: BlockExecuteOptions, exec: { executionId: string; startedAt: IsoTime; signal: AbortSignal }): Promise<ExecResult>
}

const defs = new Map<WorkflowBlockType, BlockTypeDef>()

/** Called at wiring time by the feature that owns a type. */
export function registerBlockType(def: BlockTypeDef): void {
  defs.set(def.type, def)
}

export function bad(message: string): Error {
  return expected(notulaError('invalid-input', message))
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
const text = (v: unknown, max: number, what: string): string => {
  if (v === undefined || v === null) return ''
  if (typeof v !== 'string') throw bad(`${what} must be text`)
  if (v.length > max) throw bad(`${what} is too long`)
  return v
}

/** The view callers get: an in-progress execution older than 60 s reads as `unknown` (expired). */
export function view(b: WorkflowBlock): WorkflowBlock {
  const e = b.execution
  if (e && IN_PROGRESS.has(e.status) && Date.now() - Date.parse(e.startedAt) > BLOCK_LIMITS.creatingExpiresMs) {
    return { ...b, execution: { ...e, status: 'unknown', errorCode: 'expired', error: 'Notula can’t tell whether this finished.' } }
  }
  return b
}

// ---------- the built-in types ----------

const SLACK_CONVERSATION = /^[CDG][A-Z0-9]{2,30}$/
const SLACK_USER = /^[UW][A-Z0-9]{2,30}$/

function normalizeSlack(content: unknown): unknown {
  const c = obj(content)
  const ids = Array.isArray(c['destination_ids']) ? (c['destination_ids'] as unknown[]).filter((x): x is string => typeof x === 'string') : []
  const conv = ids.length === 1 && SLACK_CONVERSATION.test(ids[0] ?? '')
  const users = ids.length >= 1 && ids.length <= 8 && ids.every((x) => SLACK_USER.test(x))
  if (!conv && !users) throw bad('Pick one channel, or up to 8 people for one message')
  const mentions = Array.isArray(c['mentions']) ? (c['mentions'] as unknown[]).map(obj) : []
  if (mentions.length > 20) throw bad('A message can mention at most 20 people')
  const cleanMentions = mentions.map((m) => {
    const id = typeof m['user_id'] === 'string' ? m['user_id'] : ''
    if (!SLACK_USER.test(id)) throw bad('A mention needs a Slack user id')
    return { user_id: id, display_name: text(m['display_name'], 200, 'A mention name') }
  })
  const message = text(c['message'], 40_000, 'The message')
  for (const m of message.matchAll(/<@([UW][A-Z0-9]+)>/g)) {
    if (!cleanMentions.some((x) => x.user_id === m[1])) throw bad('Every @mention needs its person')
  }
  return { destination: text(c['destination'], 200, 'The destination'), destination_ids: ids, mentions: cleanMentions, message }
}

function normalizeMarkdown(content: unknown): unknown {
  const c = obj(content)
  const body = text(c['body'], 20_000, 'The text')
  if (/\|.*\|\s*\n\s*\|?\s*:?-{3,}/.test(body) || /!?\[[^\]]*\]\([^)]*\)/.test(body) || /<[a-z][^>]*>/i.test(body) || /^\s*[-*]\s+\[[ xX]\]/m.test(body)) {
    throw bad('Use plain text only: no tables, links, images, HTML or checklists.')
  }
  return { label: text(c['label'], 80, 'The label'), title: text(c['title'], 240, 'The title'), time: text(c['time'], 120, 'The time'), body }
}

function normalizeCrm(content: unknown): unknown {
  const c = obj(content)
  const updates = Array.isArray(c['updates']) ? (c['updates'] as unknown[]).map(obj) : []
  if (!updates.length) throw bad('Add at least one field to update')
  const keys = new Set<string>()
  for (const u of updates) {
    const key = typeof u['fieldKey'] === 'string' ? u['fieldKey'] : ''
    if (!key || keys.has(key)) throw bad('Each field can be updated once')
    keys.add(key)
    if (!['text', 'number', 'date', 'select'].includes(String(u['fieldType']))) throw bad('Unknown field type')
    if (u['fieldType'] === 'select' && !(Array.isArray(u['options']) && (u['options'] as unknown[]).includes(u['value']))) throw bad('Pick one of the field’s options')
  }
  if (c['associationType'] !== 'company' && c['associationType'] !== 'deal') throw bad('Unknown record type')
  return c
}

function normalizeDoc(content: unknown): unknown {
  return obj(content)
}

// ---------- the store ----------

export interface BlocksApi {
  /** For chat tools: stores a new block in the thread (content normalized first). */
  create(b: { type: WorkflowBlockType; threadId: string; content: unknown; assistantMessageId?: string | null; toolCallId?: string | null }): Promise<WorkflowBlock>
  get(id: string): Promise<WorkflowBlock | null>
}

let current: BlocksApi | null = null

/** The store for the block chat tools (registered before calendar-write and mail in index.ts). */
export function blockStore(): BlocksApi {
  if (!current) throw notulaError('internal', 'blocks not registered')
  return current
}

export function registerBlocks(ctx: MainContext): BlocksApi {
  const running = new Set<string>()

  const push = (blockId: string): void => {
    for (const wc of ctx.windows.targets()) wc.send('blocks:changed' satisfies PushChannel, { blockId })
  }

  const def = (t: unknown): BlockTypeDef => {
    if (typeof t !== 'string' || !TYPES.includes(t as WorkflowBlockType)) throw bad('Unknown block type')
    const d = defs.get(t as WorkflowBlockType)
    if (!d) throw expected(notulaError('internal', `${t} blocks are not available`))
    return d
  }

  const need = async (id: unknown): Promise<WorkflowBlock> => {
    if (typeof id !== 'string' || !id) throw bad('blockId is required')
    const b = await ctx.storage.getWorkflowBlock(id)
    if (!b) throw expected(notulaError('not-found', 'This draft no longer exists.'))
    return b
  }

  registerBlockType({ type: 'slack_message', normalize: normalizeSlack, inProgress: 'sending', unknownCopy: 'Notula can’t confirm this reached Slack. Check the channel before sending again.', execute: (b) => sendSlack(ctx, b) })
  registerBlockType({ type: 'markdown', normalize: normalizeMarkdown })
  registerBlockType({ type: 'google_doc', normalize: normalizeDoc })
  registerBlockType({ type: 'crm_update', normalize: normalizeCrm, inProgress: 'updating' })

  async function execute(req: InvokeReq<'blocks:execute'>): Promise<InvokeRes<'blocks:execute'>> {
    const r = obj(req)
    const b = await need(r['blockId'])
    const d = def(r['type'])
    if (b.type !== d.type) throw bad('That draft is a different kind')
    if (typeof r['expectedUpdatedAt'] !== 'string') throw bad('expectedUpdatedAt is required')
    if (b.updated_at !== r['expectedUpdatedAt']) return { stale: true }
    const cur = view(b)
    const fail = (errorCode: string, error: string): InvokeRes<'blocks:execute'> => ({ block: cur, failure: { errorCode, error } })
    if (b.dismissed_at) return fail('dismissed', 'This draft was dismissed.')
    if (!d.execute) return fail('not_supported', 'This draft has nothing to run.')
    const st = cur.execution?.status ?? null
    if (st && DONE.has(st)) return { block: cur, failure: null }
    if (running.has(b.id) || (st && IN_PROGRESS.has(st))) return fail('busy', 'This is already running.')
    if (st === 'unknown' && !d.idempotent) return fail('unknown', d.unknownCopy ?? 'Notula can’t tell whether this went through. Check before trying again.')
    const o = obj(r['options'])
    const options: BlockExecuteOptions = {
      ...(o['mode'] === 'draft' || o['mode'] === 'send' ? { mode: o['mode'] } : {}),
      ...(typeof o['targetSourceId'] === 'string' && o['targetSourceId'] ? { targetSourceId: o['targetSourceId'] } : {})
    }
    const executionId = randomUUID()
    const startedAt = new Date().toISOString()
    running.add(b.id)
    try {
      const claimed = await ctx.storage.setBlockExecution(b.id, { status: d.inProgress ?? 'creating', executionId, startedAt }, b.updated_at)
      if ('stale' in claimed) return { stale: true }
      push(b.id)
      log('info', 'blocks:execute', { blockId: b.id, type: b.type, executionId })
      const ctl = new AbortController()
      const timer = setTimeout(() => ctl.abort(), EXECUTE_TIMEOUT_MS)
      let out: ExecResult
      try {
        out = await d.execute(claimed, options, { executionId, startedAt, signal: ctl.signal })
      } catch (err) {
        // A throw after the in-progress claim cannot prove nothing left.
        log('warn', 'blocks:execute-threw', { blockId: b.id, type: b.type, err: err instanceof Error ? err.name : 'error' })
        out = { status: 'unknown', errorCode: 'client_error', error: d.unknownCopy ?? 'Notula can’t tell whether this went through.' }
      } finally {
        clearTimeout(timer)
      }
      const final: BlockExecution = {
        ...(out.fields ?? {}),
        status: out.status,
        executionId,
        startedAt,
        completedAt: new Date().toISOString(),
        ...(out.errorCode ? { errorCode: out.errorCode } : {}),
        ...(out.error ? { error: out.error } : {})
      }
      const saved = await ctx.storage.setBlockExecution(b.id, final)
      push(b.id)
      log(out.status === 'unknown' ? 'warn' : 'info', 'blocks:executed', { blockId: b.id, type: b.type, executionId, status: out.status, code: out.errorCode ?? null })
      const block = 'stale' in saved ? cur : saved
      return { block, failure: out.status === 'failed' || out.status === 'unknown' ? { errorCode: out.errorCode ?? out.status, error: out.error ?? '' } : null }
    } finally {
      running.delete(b.id)
    }
  }

  ipcMain.handle('blocks:get' satisfies InvokeChannel, async (_e, req: InvokeReq<'blocks:get'>): Promise<InvokeRes<'blocks:get'>> => view(await need(obj(req)['blockId'])))

  ipcMain.handle('blocks:list' satisfies InvokeChannel, async (_e, req: InvokeReq<'blocks:list'>): Promise<InvokeRes<'blocks:list'>> => {
    const r = obj(req)
    if (r['sourceType'] !== 'chat_thread' || typeof r['sourceId'] !== 'string' || !r['sourceId']) throw bad('sourceType and sourceId are required')
    return (await ctx.storage.listWorkflowBlocks({ sourceType: 'chat_thread', sourceId: r['sourceId'] })).map(view)
  })

  ipcMain.handle('blocks:update' satisfies InvokeChannel, async (_e, req: InvokeReq<'blocks:update'>): Promise<InvokeRes<'blocks:update'>> => {
    const r = obj(req)
    const b = await need(r['blockId'])
    const d = def(r['type'])
    if (b.type !== d.type) throw bad('That draft is a different kind')
    let out: WorkflowBlock | { stale: true }
    if (r['dismiss'] === true) {
      out = await ctx.storage.updateWorkflowBlock(b.id, { dismissed_at: new Date().toISOString() })
      log('info', 'blocks:dismissed', { blockId: b.id, type: b.type })
    } else {
      const st = view(b).execution?.status
      if (st && (IN_PROGRESS.has(st) || DONE.has(st))) throw bad(DONE.has(st) ? 'This draft was already used.' : 'This is running. Wait for it to finish.')
      if (b.dismissed_at) throw bad('This draft was dismissed.')
      const expectedAt = typeof r['expectedUpdatedAt'] === 'string' ? r['expectedUpdatedAt'] : undefined
      out = await ctx.storage.updateWorkflowBlock(b.id, { content: d.normalize(r['content']) }, expectedAt)
    }
    if ('stale' in out) return out
    push(b.id)
    return view(out)
  })

  ipcMain.handle('blocks:execute' satisfies InvokeChannel, (_e, req: InvokeReq<'blocks:execute'>): Promise<InvokeRes<'blocks:execute'>> => execute(req))

  current = {
    async create(b) {
      const d = def(b.type)
      const block = await ctx.storage.createWorkflowBlock({
        type: d.type,
        source_type: 'chat_thread',
        source_id: b.threadId,
        assistant_message_id: b.assistantMessageId ?? null,
        tool_call_id: b.toolCallId ?? null,
        content: d.normalize(b.content)
      })
      log('info', 'blocks:created', { blockId: block.id, type: block.type })
      push(block.id)
      return block
    },
    get: async (id) => {
      const b = await ctx.storage.getWorkflowBlock(id)
      return b ? view(b) : null
    }
  }
  if (!app.isPackaged && process.env['NOTULA_DEV_WA_HARNESS'] === '1') {
    const api = current
    setTimeout(() => void runWaHarness(ctx, api), 3_000)
  }
  return current
}

// ---------- slack_message (Slack bot mode through the integration layer) ----------

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

async function sendSlack(ctx: MainContext, b: WorkflowBlock): Promise<ExecResult> {
  const c = b.content as { destination_ids: string[]; message: string }
  const ids = c.destination_ids ?? []
  if (ids.length !== 1) return { status: 'failed', errorCode: 'not_supported', error: 'Messages to several people aren’t supported yet. Pick one channel or one person.' }
  if ((await ctx.settings.get('integrations.slack.mode')) === 'webhook') {
    return { status: 'failed', errorCode: 'bot_required', error: 'Sending to a channel you pick needs the Slack bot connection. Set it up in Settings ▸ Integrations.' }
  }
  const thread = await ctx.storage.getChatThread(b.source_id)
  const noteId = thread?.grouping_key?.startsWith('meeting:') ? thread.grouping_key.slice('meeting:'.length) : null
  if (!noteId) return { status: 'failed', errorCode: 'no_note', error: 'Send Slack messages from a note’s chat.' }
  let ids2: string[]
  try {
    const r = await ctx.integrations.share({
      provider: 'slack',
      noteId,
      panelId: null,
      targets: [{ kind: 'channel', id: ids[0] ?? '', label: '' }],
      content: { markdown: c.message, text: c.message, html: `<p>${escapeHtml(c.message)}</p>` },
      delayMs: 0
    })
    ids2 = r.deliveryIds
  } catch (err) {
    const msg = err instanceof Error ? err.message.replace(/^[a-z-]+: /, '') : 'Couldn’t send to Slack.'
    return { status: 'failed', errorCode: 'share_failed', error: msg }
  }
  const rows = await ctx.storage.listIntegrationDeliveries({ provider: 'slack', noteId, limit: 20 })
  const d = rows.find((x) => x.id === ids2[0])
  if (d?.status === 'sent') return { status: 'sent', fields: { channelId: ids[0], messageTs: d.externalId ?? null } }
  if (d?.status === 'failed') return { status: 'failed', errorCode: d.errorCode ?? 'failed', error: d.errorMessage ?? 'Couldn’t send to Slack.' }
  return { status: 'unknown', errorCode: d?.errorCode ?? 'uncertain', error: d?.errorMessage ?? 'Notula can’t confirm this reached Slack. Check the channel before sending again.' }
}
