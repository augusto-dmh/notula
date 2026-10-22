// SPDX-License-Identifier: Apache-2.0
// registerFollowUp(): follow-up email drafts and the `follow-up:*` IPC.
//
// - Drafting and rewriting run locally through the user's provider (draft.ts). One live
//   draft per note: generating again replaces it.
// - Automatic drafts (`followUpEmail.auto`): once after a summary completes on a note with
//   an external attendee and no draft yet; a `low` confidence draft is stored and hidden
//   by the confidence buckets.
// - Notula sends nothing: "Open in mail app" hands a `mailto:` URL to the OS (the only
//   scheme opened), with the 2,000-character clipboard fallback; Copy writes HTML and
//   text.
// - Local-only mode with a cloud provider blocks drafting and rewriting.

import { randomUUID } from 'node:crypto'
import { ClipboardItem, clipboard, ipcMain, shell } from 'electron'
import { notulaError, parseError } from '@shared/errors'
import type { InvokeChannel, InvokeReq, InvokeRes, PushChannel } from '@shared/ipc'
import { FOLLOW_UP_LIMITS, type FollowUpDraft, type FollowUpDraftPatch, type FollowUpHandoffResult } from '@shared/types/follow-up'
import { LOCAL_ONLY_COPY } from '@shared/types/local-only'
import type { MainContext } from '../context'
import { JsonTaskError, notePeople, readyProvider } from '../enhance/note-context'
import { expected } from '../ipc-expected'
import { log } from '../log'
import { egressBlocked, LOCAL_ONLY_REASON } from '../privacy'
import type { FollowUpDraftUpsert } from '../storage/api'
import { hasBlockingPlaceholder, mailtoUrl, markdownToHtml, markdownToPlain, unwrapPlaceholders, validAddresses } from './compose'
import { draftFollowUp, rewriteFollowUp } from './draft'

/** The user-facing messages. */
const COPY = {
  localOnly: 'Follow-up drafts need a local model while local-only mode is on.',
  failed: 'Couldn’t draft the email. Try again.',
  placeholders: 'Fill in the highlighted gaps before sending',
  empty: "Can't send an empty email"
} as const

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const bad = (message: string): Error => expected(notulaError('invalid-input', message))

function id(v: unknown, what: string): string {
  if (typeof v !== 'string' || !v || v.length > 200) throw bad(`${what} is required.`)
  return v
}

function upsertOf(d: FollowUpDraft, patch: Partial<FollowUpDraftUpsert>): FollowUpDraftUpsert {
  const { note_title: _title, created_at: _c, updated_at: _u, ...rest } = d
  return { ...rest, ...patch }
}

function patchOf(v: unknown): FollowUpDraftPatch {
  if (!isObject(v)) throw bad('patch must be an object.')
  const out: FollowUpDraftPatch = {}
  for (const k of ['to', 'cc', 'bcc'] as const) {
    if (v[k] === undefined) continue
    if (!Array.isArray(v[k]) || (v[k] as unknown[]).length > 100) throw bad(`${k} is invalid.`)
    out[k] = validAddresses(v[k])
  }
  if (v['subject'] !== undefined) {
    if (typeof v['subject'] !== 'string' || v['subject'].length > 1_000) throw bad('subject is invalid.')
    out.subject = v['subject']
  }
  if (v['body'] !== undefined) {
    if (typeof v['body'] !== 'string' || v['body'].length > 200_000) throw bad('body is invalid.')
    out.body = v['body']
  }
  if (v['feedback_direction'] !== undefined) {
    const f = v['feedback_direction']
    if (f !== null && f !== 'positive' && f !== 'negative') throw bad('feedback_direction is invalid.')
    out.feedback_direction = f
  }
  if (v['feedback_text'] !== undefined) {
    const t = v['feedback_text']
    if (t !== null && (typeof t !== 'string' || t.length > 4_000)) throw bad('feedback_text is invalid.')
    out.feedback_text = t
  }
  if (v['outcome'] !== undefined) {
    if (v['outcome'] !== 'opened') throw bad('outcome is invalid.')
    out.outcome = 'opened'
  }
  return out
}

/** The buckets, with no staleness signals (Notula reads no mailbox): low confidence or > 3 days old is removed. */
function suggested(d: FollowUpDraft, now: number): boolean {
  if (d.follow_up_need === 'low') return false
  if (now - Date.parse(d.created_at) > FOLLOW_UP_LIMITS.removeAfterMs) return false
  if (d.outcome !== null && d.outcome !== 'opened') return false
  if (d.status === 'error') return false
  if (d.status === 'completed' && !d.subject.trim() && !d.body.trim()) return false
  return true
}

export function registerFollowUp(ctx: MainContext): void {
  /** Notes with a draft being written, so a second click joins the first run. */
  const running = new Map<string, { runId: string; draftId: string }>()
  let autoQueue: Promise<unknown> = Promise.resolve()

  // One push site per channel, each with its literal channel.
  const pushProgress = (runId: string, noteId: string): void => {
    for (const wc of ctx.windows.targets()) wc.send('follow-up:progress' satisfies PushChannel, { runId, noteId, step: 'drafting' })
  }
  const pushResult = (runId: string, draft: FollowUpDraft): void => {
    for (const wc of ctx.windows.targets()) wc.send('follow-up:result' satisfies PushChannel, { runId, draft })
  }
  const pushError = (runId: string, noteId: string, message: string): void => {
    for (const wc of ctx.windows.targets()) wc.send('follow-up:error' satisfies PushChannel, { runId, noteId, message })
  }

  async function requireDraft(draftId: string): Promise<FollowUpDraft> {
    const d = await ctx.storage.getFollowUpDraft({ id: draftId })
    if (!d) throw expected(notulaError('not-found', 'That draft no longer exists.'))
    return d
  }

  /** Starts a draft: resolves at once with the ids, the result comes as a push. */
  async function generate(noteId: string, why: 'manual' | 'auto'): Promise<{ runId: string; draftId: string }> {
    const live = running.get(noteId)
    if (live) return live
    const note = await ctx.storage.getNote(noteId)
    if (!note) throw expected(notulaError('not-found', 'That note does not exist.'))
    const runId = randomUUID()
    const draftId = randomUUID()
    const base: FollowUpDraftUpsert = {
      id: draftId,
      document_id: noteId,
      status: 'generating',
      outcome: null,
      to: [],
      cc: [],
      bcc: [],
      subject: '',
      body: '',
      previous_body: null,
      follow_up_need: null,
      error_message: null,
      feedback_direction: null,
      feedback_text: null
    }
    await ctx.storage.upsertFollowUpDraft(base)
    running.set(noteId, { runId, draftId })
    void (async () => {
      pushProgress(runId, noteId)
      const started = Date.now()
      try {
        const provider = await readyProvider(ctx)
        const out = await draftFollowUp(ctx, provider, note)
        const draft = await ctx.storage.upsertFollowUpDraft({
          ...base,
          status: 'completed',
          to: out.to,
          cc: out.cc,
          subject: out.subject,
          body: out.body,
          follow_up_need: out.confidence
        })
        log('info', 'follow-up:drafted', { noteId, why, confidence: out.confidence, ms: Date.now() - started, provider: provider.id })
        pushResult(runId, draft)
      } catch (err) {
        // Local-only and "no key / no model" say what to do; anything else gets the generic message.
        const message =
          err instanceof JsonTaskError && err.reason === 'local-only'
            ? COPY.localOnly
            : err instanceof JsonTaskError && err.reason === 'unavailable'
              ? err.message
              : COPY.failed
        if (message === COPY.localOnly) log('info', 'follow-up:blocked', { noteId, reason: LOCAL_ONLY_REASON })
        log('warn', 'follow-up:draft-failed', { noteId, why, message: err instanceof Error ? err.message : String(err) })
        await ctx.storage.upsertFollowUpDraft({ ...base, status: 'error', error_message: message }).catch(() => undefined)
        pushError(runId, noteId, message)
      } finally {
        running.delete(noteId)
      }
    })()
    return { runId, draftId }
  }

  // ---------- automatic drafts ----------

  ctx.bus.on('enhance:completed', (e) => {
    if (!e.ok) return
    autoQueue = autoQueue
      .then(async () => {
        const settings = await ctx.settings.getAll()
        if (!settings['followUpEmail.enabled'] || !settings['followUpEmail.auto']) return
        if (await ctx.storage.getFollowUpDraft({ noteId: e.noteId })) return
        const note = await ctx.storage.getNote(e.noteId)
        if (!note) return
        const people = await notePeople(ctx, note)
        if (!people.attendees.some((a) => a.external)) {
          log('info', 'follow-up:auto-skipped', { noteId: e.noteId, reason: 'no-external-attendee' })
          return
        }
        await generate(e.noteId, 'auto')
      })
      .catch((err: unknown) => log('error', 'follow-up:auto-failed', { err: parseError(err) }))
  })

  // ---------- IPC ----------

  ipcMain.handle(
    'follow-up:get' satisfies InvokeChannel,
    (_e, req: InvokeReq<'follow-up:get'>): Promise<InvokeRes<'follow-up:get'>> =>
      ctx.storage.getFollowUpDraft({ noteId: id(isObject(req) ? req['noteId'] : null, 'noteId') })
  )

  ipcMain.handle(
    'follow-up:generate' satisfies InvokeChannel,
    (_e, req: InvokeReq<'follow-up:generate'>): Promise<InvokeRes<'follow-up:generate'>> =>
      generate(id(isObject(req) ? req['noteId'] : null, 'noteId'), 'manual')
  )

  ipcMain.handle(
    'follow-up:rewrite' satisfies InvokeChannel,
    async (_e, req: InvokeReq<'follow-up:rewrite'>): Promise<InvokeRes<'follow-up:rewrite'>> => {
      if (!isObject(req)) throw bad('request must be an object.')
      const draft = await requireDraft(id(req['draftId'], 'draftId'))
      const instruction = req['instruction']
      if (typeof instruction !== 'string' || !instruction.trim() || instruction.length > 4_000) throw bad('Say how to rewrite the draft.')
      const referenced = req['referencedText']
      if (referenced !== undefined && (typeof referenced !== 'string' || referenced.length > 20_000)) throw bad('referencedText is invalid.')
      let provider
      try {
        provider = await readyProvider(ctx)
      } catch (err) {
        throw expected(notulaError('provider-error', err instanceof JsonTaskError && err.reason === 'local-only' ? COPY.localOnly : (err as Error).message))
      }
      try {
        const out = await rewriteFollowUp(provider, draft, instruction.trim(), typeof referenced === 'string' && referenced.trim() ? referenced : undefined)
        await ctx.storage.upsertFollowUpDraft(upsertOf(draft, { subject: out.subject, body: out.body, previous_body: draft.body }))
        log('info', 'follow-up:rewritten', { draftId: draft.id, provider: provider.id })
        return out
      } catch (err) {
        log('warn', 'follow-up:rewrite-failed', { draftId: draft.id, message: err instanceof Error ? err.message : String(err) })
        throw expected(notulaError('provider-error', 'The draft could not be rewritten. Try again.'))
      }
    }
  )

  ipcMain.handle(
    'follow-up:update' satisfies InvokeChannel,
    async (_e, req: InvokeReq<'follow-up:update'>): Promise<InvokeRes<'follow-up:update'>> => {
      if (!isObject(req)) throw bad('request must be an object.')
      const draft = await requireDraft(id(req['draftId'], 'draftId'))
      const patch = patchOf(req['patch'])
      const { outcome, ...fields } = patch
      // `opened` is recorded once, and never over another outcome.
      const next = outcome === 'opened' && draft.outcome === null ? { outcome: 'opened' as const } : {}
      return ctx.storage.upsertFollowUpDraft(upsertOf(draft, { ...fields, ...next }))
    }
  )

  ipcMain.handle(
    'follow-up:handoff' satisfies InvokeChannel,
    async (_e, req: InvokeReq<'follow-up:handoff'>): Promise<InvokeRes<'follow-up:handoff'>> => {
      if (!isObject(req)) throw bad('request must be an object.')
      const draft = await requireDraft(id(req['draftId'], 'draftId'))
      const mode = req['mode']
      if (mode !== 'mail-app' && mode !== 'copy') throw bad('mode is invalid.')
      const markdown = unwrapPlaceholders(draft.body)
      const plain = markdownToPlain(markdown)
      const html = markdownToHtml(markdown)
      let result: FollowUpHandoffResult
      if (mode === 'copy') {
        await clipboard.write([new ClipboardItem({ 'text/html': html, 'text/plain': plain })])
        result = { outcome: 'copied', bodyOnClipboard: true }
      } else {
        // The mail app is a hand-off of Notula content; Copy is unaffected.
        if (await egressBlocked(ctx, { kind: 'handoff' })) throw bad(LOCAL_ONLY_COPY.blocked)
        if (hasBlockingPlaceholder(draft.body)) throw bad(COPY.placeholders)
        if (!plain.trim()) throw bad(COPY.empty)
        const fields = { to: draft.to, cc: draft.cc, bcc: draft.bcc, subject: draft.subject }
        let url = mailtoUrl({ ...fields, body: plain })
        let bodyOnClipboard = false
        if (url.length > FOLLOW_UP_LIMITS.mailtoMaxChars) {
          url = mailtoUrl({ ...fields, body: null })
          await clipboard.write([new ClipboardItem({ 'text/html': html, 'text/plain': plain })])
          bodyOnClipboard = true
        }
        if (!url.startsWith('mailto:')) throw expected(notulaError('internal', 'Only mail links can be opened.'))
        await shell.openExternal(url)
        result = { outcome: 'handed_off', bodyOnClipboard }
      }
      await ctx.storage.upsertFollowUpDraft(upsertOf(draft, { outcome: result.outcome }))
      log('info', 'follow-up:handed-off', { draftId: draft.id, outcome: result.outcome, bodyOnClipboard: result.bodyOnClipboard })
      return result
    }
  )

  ipcMain.handle(
    'follow-up:discard' satisfies InvokeChannel,
    async (_e, req: InvokeReq<'follow-up:discard'>): Promise<void> => {
      const draft = await requireDraft(id(isObject(req) ? req['draftId'] : null, 'draftId'))
      await ctx.storage.upsertFollowUpDraft(upsertOf(draft, { outcome: 'discarded' }))
    }
  )

  ipcMain.handle('follow-up:list-suggested' satisfies InvokeChannel, async (): Promise<InvokeRes<'follow-up:list-suggested'>> => {
    if (!(await ctx.settings.get('followUpEmail.enabled'))) return []
    const now = Date.now()
    const drafts = await ctx.storage.listFollowUpDrafts({ createdAfter: new Date(now - FOLLOW_UP_LIMITS.removeAfterMs).toISOString() })
    return drafts.filter((d) => suggested(d, now))
  })
}
