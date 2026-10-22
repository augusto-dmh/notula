// SPDX-License-Identifier: Apache-2.0
// registerActionItems(): action items extracted after each summary, and the
// `action-items:*` IPC.
//
// - Extraction runs on bus `enhance:completed { ok: true }` while `actionItems.enabled` is
//   on, once per completed generation, one at a time. A reply without usable JSON is
//   logged, writes nothing and is not retried this session.
// - The items replace the note's unreviewed, unarchived ones; their summary lines get the
//   item ids in the summary room (stamp.ts).
// - Regenerate all: every source note of the open items, at most 2 in flight, 60 s
//   each; nothing is written until "Keep regenerated".
// - Local-only mode with a cloud provider skips extraction with `local-only mode`.

import { randomUUID } from 'node:crypto'
import { ipcMain } from 'electron'
import { notulaError, parseError } from '@shared/errors'
import type { InvokeChannel, InvokeReq, InvokeRes, PushChannel } from '@shared/ipc'
import {
  ACTION_ITEMS_LIMITS,
  type ActionItemFeedbackInput,
  type ActionItemsQuery,
  type ActionItemsRegenerateEvent,
  type RegeneratedActionItem
} from '@shared/types/action-items'
import type { MainContext } from '../context'
import { JsonTaskError, latestSummary, readyProvider } from '../enhance/note-context'
import { expected } from '../ipc-expected'
import { log } from '../log'
import { LOCAL_ONLY_REASON } from '../privacy'
import { extractActionItems } from './extract'
import { SummaryStamper } from './stamp'

const HEARTBEAT_MS = 5_000
/** A preview not applied within this time is dropped. */
const RUN_TTL_MS = 60 * 60_000

interface Run {
  noteIds: string[]
  items: RegeneratedActionItem[] | null
  at: number
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

function bad(message: string): Error {
  return expected(notulaError('invalid-input', message))
}

function id(v: unknown, what: string): string {
  if (typeof v !== 'string' || !v || v.length > 200) throw bad(`${what} is required.`)
  return v
}

function query(v: unknown): ActionItemsQuery {
  if (v === undefined || v === null) return {}
  if (!isObject(v)) throw bad('query must be an object.')
  const q: ActionItemsQuery = {}
  if (v['includeArchived'] !== undefined) q.includeArchived = v['includeArchived'] === true
  for (const k of ['noteIds', 'ids'] as const) {
    const list = v[k]
    if (list === undefined) continue
    if (!Array.isArray(list) || list.length > 1_000 || list.some((x) => typeof x !== 'string')) throw bad(`${k} is invalid.`)
    q[k] = list as string[]
  }
  for (const k of ['createdAfter', 'createdBefore'] as const) {
    const t = v[k]
    if (t === undefined) continue
    if (typeof t !== 'string' || Number.isNaN(Date.parse(t))) throw bad(`${k} is invalid.`)
    q[k] = t
  }
  if (v['limit'] !== undefined) {
    const n = v['limit']
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) throw bad('limit is invalid.')
    q.limit = Math.floor(n)
  }
  return q
}

function feedbackInput(v: unknown): ActionItemFeedbackInput {
  if (!isObject(v)) throw bad('feedback must be an object.')
  const direction = v['direction']
  if (direction !== 'positive' && direction !== 'negative') throw bad('direction is invalid.')
  const text = v['feedback']
  if (text !== null && text !== undefined && (typeof text !== 'string' || text.length > 4_000)) throw bad('feedback is invalid.')
  const feedback = typeof text === 'string' ? text : null
  if (typeof v['actionItemId'] === 'string') return { direction, feedback, actionItemId: id(v['actionItemId'], 'actionItemId') }
  const line = (x: unknown, what: string): string => {
    if (typeof x !== 'string' || !x.trim() || x.length > 2_000) throw bad(`${what} is invalid.`)
    return x
  }
  return { direction, feedback, panelId: id(v['panelId'], 'panelId'), headingText: line(v['headingText'], 'headingText'), itemText: line(v['itemText'], 'itemText') }
}

export function registerActionItems(ctx: MainContext): void {
  const stamper = new SummaryStamper(ctx)
  /** `<panelId>:<content_edited_at>`: each completed generation is extracted once. */
  const done = new Set<string>()
  let queue: Promise<unknown> = Promise.resolve()
  const runs = new Map<string, Run>()
  let regenerating = false

  const pushRegenerate = (e: ActionItemsRegenerateEvent): void => {
    for (const wc of ctx.windows.targets()) wc.send('action-items:regenerate-progress' satisfies PushChannel, e)
  }

  // The page and the summary thumbs follow every write (`action-items:changed`).
  ctx.bus.on('storage:changed', (c) => {
    if (!c.tables.includes('action_items')) return
    for (const wc of ctx.windows.targets()) wc.send('action-items:changed' satisfies PushChannel, { noteIds: c.ids })
  })

  // ---------- extraction after a summary ----------

  async function extractFor(noteId: string, panelId: string): Promise<void> {
    if (!(await ctx.settings.get('actionItems.enabled'))) return
    const [note, panel] = await Promise.all([ctx.storage.getNote(noteId), ctx.storage.getPanel(panelId)])
    if (!note || !panel || panel.deleted_at || panel.document_id !== noteId) return
    if (latestSummary([panel]) === null) return
    const key = `${panelId}:${panel.content_edited_at ?? ''}`
    if (done.has(key)) return
    done.add(key)
    let provider
    try {
      provider = await readyProvider(ctx)
    } catch (err) {
      const reason = err instanceof JsonTaskError && err.reason === 'local-only' ? LOCAL_ONLY_REASON : (err as Error).message
      log('info', 'action-items:skipped', { noteId, panelId, reason })
      return
    }
    const started = Date.now()
    try {
      const items = await extractActionItems(ctx, provider, { note, panel })
      const stored = await ctx.storage.replaceNoteActionItems(noteId, panelId, items)
      const stamps = stored.flatMap((s, i) => {
        const line = items[i]?.summaryLine
        return line ? [{ id: s.id, line }] : []
      })
      const stamped = await stamper.stamp(panelId, stamps)
      log('info', 'action-items:extracted', { noteId, panelId, items: stored.length, stamped, ms: Date.now() - started, provider: provider.id })
    } catch (err) {
      log('warn', 'action-items:extract-failed', {
        noteId,
        panelId,
        reason: err instanceof JsonTaskError ? err.reason : 'store',
        message: err instanceof Error ? err.message : String(err)
      })
    }
  }

  ctx.bus.on('enhance:completed', (e) => {
    if (!e.ok) return
    queue = queue.then(() => extractFor(e.noteId, e.panelId)).catch((err: unknown) => log('error', 'action-items:queue-failed', { err }))
  })

  // ---------- regenerate all ----------

  async function regenerate(runId: string): Promise<void> {
    const run = runs.get(runId) as Run
    const total = run.noteIds.length
    pushRegenerate({ runId, type: 'ready', total })
    const heartbeat = setInterval(() => pushRegenerate({ runId, type: 'heartbeat' }), HEARTBEAT_MS)
    const abort = new AbortController()
    const results = new Map<string, RegeneratedActionItem[]>()
    let completed = 0
    try {
      const provider = await readyProvider(ctx)
      const pending = [...run.noteIds]
      const worker = async (): Promise<void> => {
        for (let noteId = pending.shift(); noteId !== undefined; noteId = pending.shift()) {
          if (abort.signal.aborted) return
          const note = await ctx.storage.getNote(noteId)
          const panel = note ? latestSummary(await ctx.storage.listPanels(noteId)) : null
          if (!note || !panel) {
            results.set(noteId, [])
          } else {
            try {
              const items = await extractActionItems(ctx, provider, { note, panel }, abort.signal)
              results.set(
                noteId,
                items.map((i) => ({ sourceNoteId: noteId, intent: i.intent, detail: i.detail, attribution: i.attribution }))
              )
            } catch (err) {
              abort.abort()
              throw err
            }
          }
          completed++
          pushRegenerate({ runId, type: 'progress', completed, total })
        }
      }
      await Promise.all(Array.from({ length: Math.min(ACTION_ITEMS_LIMITS.regenerateInFlight, total) }, worker))
      const items = run.noteIds.flatMap((n) => results.get(n) ?? [])
      run.items = items
      pushRegenerate({ runId, type: 'complete', sourceNoteIds: run.noteIds, items })
      log('info', 'action-items:regenerated', { runId, notes: total, items: items.length })
    } catch (err) {
      runs.delete(runId)
      const message = err instanceof JsonTaskError && err.reason === 'local-only' ? LOCAL_ONLY_REASON : 'Couldn’t regenerate action items. Try again.'
      log('warn', 'action-items:regenerate-failed', { runId, message: err instanceof Error ? err.message : String(err) })
      pushRegenerate({ runId, type: 'error', message })
    } finally {
      clearInterval(heartbeat)
      regenerating = false
    }
  }

  // ---------- IPC ----------

  ipcMain.handle(
    'action-items:list' satisfies InvokeChannel,
    (_e, req: InvokeReq<'action-items:list'>): Promise<InvokeRes<'action-items:list'>> => ctx.storage.listActionItems(query(req))
  )

  ipcMain.handle(
    'action-items:review' satisfies InvokeChannel,
    (_e, req: InvokeReq<'action-items:review'>): Promise<InvokeRes<'action-items:review'>> => {
      if (!isObject(req)) throw bad('request must be an object.')
      const review = req['reviewStatus']
      if (review !== 'kept' && review !== 'dismissed') throw bad('reviewStatus is invalid.')
      return ctx.storage.reviewActionItem(id(req['id'], 'id'), review)
    }
  )

  ipcMain.handle(
    'action-items:archive' satisfies InvokeChannel,
    (_e, req: InvokeReq<'action-items:archive'>): Promise<void> => ctx.storage.archiveActionItem(id(isObject(req) ? req['id'] : null, 'id'))
  )

  ipcMain.handle(
    'action-items:feedback' satisfies InvokeChannel,
    (_e, req: InvokeReq<'action-items:feedback'>): Promise<InvokeRes<'action-items:feedback'>> => ctx.storage.addActionItemFeedback(feedbackInput(req))
  )

  ipcMain.handle(
    'action-items:regenerate-preview' satisfies InvokeChannel,
    async (): Promise<InvokeRes<'action-items:regenerate-preview'>> => {
      if (regenerating) throw expected(notulaError('busy', 'Action items are already being regenerated.'))
      const open = await ctx.storage.listActionItems({})
      const noteIds = [...new Set(open.map((i) => i.sourceNoteId).filter((n): n is string => !!n))]
      if (noteIds.length === 0) throw bad('There are no meetings to regenerate action items from.')
      for (const [k, r] of runs) if (Date.now() - r.at > RUN_TTL_MS) runs.delete(k)
      const runId = randomUUID()
      runs.set(runId, { noteIds, items: null, at: Date.now() })
      regenerating = true
      // Resolves at once with the run id; the events follow as pushes.
      setImmediate(() => void regenerate(runId))
      return { runId }
    }
  )

  ipcMain.handle(
    'action-items:apply-regenerated' satisfies InvokeChannel,
    async (_e, req: InvokeReq<'action-items:apply-regenerated'>): Promise<InvokeRes<'action-items:apply-regenerated'>> => {
      const runId = id(isObject(req) ? req['runId'] : null, 'runId')
      const run = runs.get(runId)
      if (!run || !run.items) throw expected(notulaError('not-found', 'That preview is no longer available.'))
      try {
        const result = await ctx.storage.applyRegeneratedActionItems(run.noteIds, run.items)
        runs.delete(runId)
        return result
      } catch (err) {
        log('warn', 'action-items:apply-failed', { runId, code: parseError(err).code })
        throw err
      }
    }
  )
}
