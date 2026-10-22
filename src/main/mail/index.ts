// SPDX-License-Identifier: Apache-2.0
// Gmail and Outlook: the `mail:*` IPC,
// `ctx.emailContext`, the `gmail` / `outlook` outbox plug-ins, the `email` block executor and the
// four chat tools.
//
// - Gate: `mail.enabled` (Labs, off). Reads need the account's `mail-read` grant, drafts and sends
//   `mail-send` (incremental consent on the calendar account).
// - Follow-up Send goes through the integration outbox: a `gmail` / `outlook` delivery, `scheduled` for
//   10 s so Undo can cancel it; when due, the plug-in creates the draft and sends it. A
//   timeout after sending is `uncertain`, never retried. Chat `email` cards count down 10 s on
//   the card before they run.
// - Mail is never stored: subjects, addresses and bodies live only in the request, the brief or the
//   chat turn that used them. Logs carry ids, counts and codes only. Local-only blocks every call.

import { ipcMain } from 'electron'
import { notulaError } from '@shared/errors'
import type { InvokeChannel, InvokeReq, InvokeRes, PushChannel } from '@shared/ipc'
import type { CalendarGrant, CalendarSource } from '@shared/types/calendar'
import type { IntegrationDelivery, IntegrationProvider } from '@shared/types/integrations'
import { MAIL_LIMITS, type EmailContext, type MailAccount, type MailDraftInput, type MailThread } from '@shared/types/mail'
import type { EmailDraftBlock } from '@shared/types/workflow-blocks'
import { blockStore, registerBlockType, type ExecResult } from '../blocks'
import type { ChatToolSpec } from '../chat/tool-api'
import type { EmailContextApi, MainContext } from '../context'
import { hasBlockingPlaceholder, markdownToHtml, markdownToPlain, unwrapPlaceholders } from '../follow-up/compose'
import type { IntegrationPlugin, IntegrationSendOutcome } from '../integration-plugins'
import { expected } from '../ipc-expected'
import { log } from '../log'
import { egressBlocked } from '../privacy'
import { textToHtml } from './mime'
import {
  gmailCreateDraft,
  gmailRead,
  gmailSearch,
  gmailSendDraft,
  graphCreateDraft,
  graphRead,
  graphSearch,
  graphSend,
  MAIL_COPY,
  MailError,
  type ReadThread,
  type SendDraft
} from './providers'

const EMAIL = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/
const FREE_MAIL = /@(gmail|googlemail|outlook|hotmail|live|msn|yahoo|icloud|me|aol|proton|protonmail)\.[a-z.]+$/i
const DRAFTS_URL = 'https://mail.google.com/mail/#drafts'
const TOOLS = { search: 'findEmails', person: 'findEmailsWithPerson', read: 'readEmail', write: 'draftFollowUpEmail' } as const

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
const bad = (m: string): Error => expected(notulaError('invalid-input', m))

function addresses(v: unknown, what: string): string[] {
  if (v === undefined || v === null) return []
  if (!Array.isArray(v)) throw bad(`${what} must be a list`)
  const seen = new Set<string>()
  const out: string[] = []
  for (const x of v) {
    const e = typeof x === 'string' ? x.trim() : ''
    if (!EMAIL.test(e)) throw bad(`${e || 'An address'} isn’t a valid email address`)
    if (seen.has(e.toLowerCase())) continue
    seen.add(e.toLowerCase())
    out.push(e)
  }
  if (out.length > 100) throw bad('Too many recipients')
  return out
}

/** The `email` block shape; attachments stay off. */
function normalizeEmail(raw: unknown): EmailDraftBlock {
  const c = obj(raw)
  const subject = typeof c['subject'] === 'string' ? c['subject'].replace(/[\r\n]+/g, ' ').slice(0, 998) : ''
  const body = typeof c['body'] === 'string' ? c['body'].slice(0, 100_000) : ''
  const out: EmailDraftBlock = { to: addresses(c['to'], 'To'), cc: addresses(c['cc'], 'Cc'), bcc: addresses(c['bcc'], 'Bcc'), subject, body }
  if (typeof c['inReplyToThread'] === 'string' && /^[A-Za-z0-9_=+/-]{1,512}$/.test(c['inReplyToThread'])) out.inReplyToThread = c['inReplyToThread']
  return out
}

export function registerMail(ctx: MainContext): EmailContextApi {
  // ---------- accounts ----------

  const sources = async (): Promise<CalendarSource[]> =>
    ((await ctx.storage.listCalendarSources().catch(() => [])) as CalendarSource[]).filter((s) => s.kind === 'google' || s.kind === 'microsoft')

  const account = (s: CalendarSource): MailAccount => ({
    sourceId: s.id,
    provider: s.kind as 'google' | 'microsoft',
    email: s.accountEmail ?? '',
    grants: s.grants,
    state: s.status === 'error' && (s.errorType === 'missing_token' || s.errorType === 'access_denied') ? 'reconnect' : s.grants.includes('mail-read') || s.grants.includes('mail-send') ? 'ok' : 'missing-grant'
  })

  /** The account for a grant: the asked one, else the profile's, else the first that holds it. */
  const pick = async (grant: CalendarGrant, sourceId?: unknown): Promise<CalendarSource> => {
    const all = await sources()
    if (typeof sourceId === 'string' && sourceId) {
      const s = all.find((x) => x.id === sourceId)
      if (!s) throw expected(notulaError('not-found', 'That account is no longer connected.'))
      if (!s.grants.includes(grant)) throw expected(notulaError('provider-error', grant === 'mail-read' ? MAIL_COPY.needRead : MAIL_COPY.needSend))
      return s
    }
    const profile = String((await ctx.settings.get('profile.email').catch(() => '')) ?? '').toLowerCase()
    const holders = all.filter((x) => x.grants.includes(grant))
    const s = holders.find((x) => x.accountEmail?.toLowerCase() === profile) ?? holders[0]
    if (!s) throw expected(notulaError('provider-error', grant === 'mail-read' ? MAIL_COPY.needRead : MAIL_COPY.needSend))
    return s
  }

  const token = async (s: CalendarSource, grant: CalendarGrant): Promise<string> => {
    try {
      return await ctx.calendar.accessToken(s.id, grant)
    } catch (err) {
      const scopes = err instanceof Error && /missing_scopes/.test(err.message)
      throw new MailError(scopes ? 'missing_scopes' : 'missing_token', scopes ? (grant === 'mail-read' ? MAIL_COPY.needRead : MAIL_COPY.needSend) : MAIL_COPY.reconnect)
    }
  }

  const blocked = (): Promise<boolean> => egressBlocked(ctx, { kind: 'integration' })

  const asIpc = (err: unknown): Error => {
    if (err instanceof MailError) return expected(notulaError('provider-error', err.message))
    return err instanceof Error ? err : new Error('mail failed')
  }

  // ---------- reads ----------

  async function search(q: { sourceId?: unknown; query?: string; personEmail?: string; max: number; pageToken?: string }): Promise<{ threads: MailThread[]; nextPageToken: string | null }> {
    if (await blocked()) throw new MailError('local_only', MAIL_COPY.localOnly)
    const s = await pick('mail-read', q.sourceId)
    const t = await token(s, 'mail-read')
    const max = Math.max(1, Math.min(MAIL_LIMITS.searchMax, Math.floor(q.max) || 10))
    const person = q.personEmail && EMAIL.test(q.personEmail) ? q.personEmail : null
    const r =
      s.kind === 'google'
        ? await gmailSearch(ctx, t, person ? `from:${person} OR to:${person} newer_than:${MAIL_LIMITS.briefDays}d` : (q.query ?? '').slice(0, 500), person ? Math.min(max, MAIL_LIMITS.threadsPerPerson) : max, q.pageToken)
        : await graphSearch(ctx, t, person ? `participants:${person}` : (q.query ?? ''), person ? Math.min(max, MAIL_LIMITS.threadsPerPerson) : max)
    log('info', 'mail:searched', { provider: s.kind, person: !!person, threads: r.threads.length })
    return r
  }

  async function read(threadId: string): Promise<ReadThread> {
    if (await blocked()) throw new MailError('local_only', MAIL_COPY.localOnly)
    const s = await pick('mail-read')
    const t = await token(s, 'mail-read')
    const r = s.kind === 'google' ? await gmailRead(ctx, t, threadId) : await graphRead(ctx, t, threadId)
    log('info', 'mail:thread-read', { provider: s.kind, messages: r.messages.length })
    return r
  }

  // ---------- drafts and sends ----------

  /** The message for a send: the follow-up draft's current text when one is named, else the input. */
  async function message(s: CalendarSource, input: Partial<MailDraftInput>): Promise<SendDraft> {
    const from = s.accountEmail ?? ''
    if (input.followUpDraftId) {
      const d = await ctx.storage.getFollowUpDraft({ id: input.followUpDraftId })
      if (!d) throw expected(notulaError('not-found', 'This draft no longer exists.'))
      if (hasBlockingPlaceholder(d.body)) throw bad('Fill in the highlighted parts first.')
      const md = unwrapPlaceholders(d.body)
      if (!d.to.length && !d.cc.length && !d.bcc.length) throw bad('Add a recipient first.')
      return { from, to: d.to, cc: d.cc, bcc: d.bcc, subject: d.subject, html: markdownToHtml(md), text: markdownToPlain(md) }
    }
    const to = addresses(input.to, 'To')
    const cc = addresses(input.cc, 'Cc')
    const bcc = addresses(input.bcc, 'Bcc')
    if (!to.length && !cc.length && !bcc.length) throw bad('Add a recipient first.')
    const text = typeof input.text === 'string' ? input.text : ''
    const html = typeof input.html === 'string' && input.html ? input.html : textToHtml(text)
    return {
      from,
      to,
      cc,
      bcc,
      subject: typeof input.subject === 'string' ? input.subject.replace(/[\r\n]+/g, ' ').slice(0, 998) : '',
      html,
      text,
      ...(input.inReplyToThread ? { inReplyToThread: input.inReplyToThread } : {})
    }
  }

  async function saveDraft(s: CalendarSource, m: SendDraft): Promise<{ draftId: string; webUrl: string | null }> {
    if (await blocked()) throw new MailError('local_only', MAIL_COPY.localOnly)
    const t = await token(s, 'mail-send')
    const r = s.kind === 'google' ? { ...(await gmailCreateDraft(ctx, t, m)), webUrl: DRAFTS_URL } : await graphCreateDraft(ctx, t, m)
    log('info', 'mail:draft-saved', { provider: s.kind })
    return { draftId: r.draftId, webUrl: r.webUrl }
  }

  /** Creates the provider draft and sends it (one delivery or one card click). */
  async function sendNow(s: CalendarSource, m: SendDraft): Promise<{ messageId: string | null }> {
    if (await blocked()) throw new MailError('local_only', MAIL_COPY.localOnly)
    const t = await token(s, 'mail-send')
    if (s.kind === 'google') {
      const d = await gmailCreateDraft(ctx, t, m)
      const r = await gmailSendDraft(ctx, t, d.draftId)
      return { messageId: r.messageId }
    }
    const d = await graphCreateDraft(ctx, t, m)
    await graphSend(ctx, t, d.draftId)
    return { messageId: d.draftId }
  }

  // ---------- the outbox plug-ins ----------

  const pluginFor = (provider: Extract<IntegrationProvider, 'gmail' | 'outlook'>): IntegrationPlugin => ({
    provider,
    credentialKinds: [],
    async validate() {
      const all = (await sources()).filter((s) => s.kind === (provider === 'gmail' ? 'google' : 'microsoft') && s.grants.includes('mail-send'))
      return all.length ? { state: 'connected', accountLabel: all.map((s) => s.accountEmail ?? '').filter(Boolean).join(', ') || null, detail: null } : { state: 'not_configured', accountLabel: null, detail: null }
    },
    async share(_c, req) {
      // `targets[0].id` names the follow-up draft; `destination_id` is the sender account.
      const draftId = req.targets?.[0]?.id ?? ''
      const sourceId = req.destinationIds?.[0] ?? ''
      if (!draftId || !sourceId) throw bad('Pick the sender and the draft first.')
      return [
        {
          provider,
          destinationId: sourceId,
          automationId: null,
          noteId: req.noteId,
          panelId: null,
          targetKey: draftId,
          trigger: 'manual',
          status: 'scheduled',
          nextAttemptAt: new Date(Date.now() + MAIL_LIMITS.sendUndoMs).toISOString()
        }
      ]
    },
    async send(_c, d): Promise<IntegrationSendOutcome> {
      try {
        const s = (await sources()).find((x) => x.id === d.destinationId)
        if (!s) return { status: 'failed', retryable: false, errorCode: 'account_removed', errorMessage: 'That account is no longer connected.' }
        const m = await message(s, { followUpDraftId: d.targetKey })
        const r = await sendNow(s, m)
        log('info', 'mail:sent', { provider: s.kind, deliveryId: d.id })
        return { status: 'sent', ...(r.messageId ? { externalId: r.messageId } : {}), ...(s.kind === 'google' ? { externalUrl: 'https://mail.google.com/mail/#sent' } : {}) }
      } catch (err) {
        if (err instanceof MailError) {
          if (err.code === 'uncertain') return { status: 'uncertain', errorMessage: MAIL_COPY.maySent }
          return { status: 'failed', retryable: err.retryable, errorCode: err.code, errorMessage: err.message }
        }
        const msg = err instanceof Error ? err.message.replace(/^[a-z-]+: /, '') : MAIL_COPY.other
        return { status: 'failed', retryable: false, errorCode: 'invalid', errorMessage: msg }
      }
    },
    async disconnect() {
      // Mail access is a calendar grant: "Disconnect Gmail" turns the grants off in Settings ▸ Integrations.
    }
  })
  ctx.integrationPlugins.register(pluginFor('gmail'))
  ctx.integrationPlugins.register(pluginFor('outlook'))

  // ---------- the `email` block ----------

  registerBlockType({
    type: 'email',
    normalize: normalizeEmail,
    inProgress: 'sending',
    unknownCopy: MAIL_COPY.maySent,
    async execute(block, options): Promise<ExecResult> {
      const c = block.content as EmailDraftBlock
      try {
        const s = await pick('mail-send')
        const m = await message(s, { to: c.to, cc: c.cc, bcc: c.bcc, subject: c.subject, text: c.body, html: textToHtml(c.body), ...(c.inReplyToThread ? { inReplyToThread: c.inReplyToThread } : {}) })
        if (options.mode === 'draft') {
          const r = await saveDraft(s, m)
          return { status: 'created', fields: { draftId: r.draftId, webUrl: r.webUrl, provider: s.kind, drafted: true } }
        }
        const r = await sendNow(s, m)
        return { status: 'sent', fields: { messageId: r.messageId, provider: s.kind } }
      } catch (err) {
        if (err instanceof MailError) return err.code === 'uncertain' ? { status: 'unknown', errorCode: 'uncertain', error: MAIL_COPY.maySent } : { status: 'failed', errorCode: err.code, error: err.message }
        return { status: 'failed', errorCode: 'invalid', error: err instanceof Error ? err.message.replace(/^[a-z-]+: /, '') : MAIL_COPY.other }
      }
    }
  })

  // ---------- IPC ----------

  ipcMain.handle('mail:status' satisfies InvokeChannel, async (): Promise<InvokeRes<'mail:status'>> => (await sources()).map(account))

  ipcMain.handle('mail:search-threads' satisfies InvokeChannel, async (_e, req: InvokeReq<'mail:search-threads'>): Promise<InvokeRes<'mail:search-threads'>> => {
    const r = obj(req)
    try {
      return (
        await search({
          sourceId: r['sourceId'],
          ...(typeof r['query'] === 'string' ? { query: r['query'] } : {}),
          ...(typeof r['personEmail'] === 'string' ? { personEmail: r['personEmail'] } : {}),
          max: Number(r['max']) || 10
        })
      ).threads
    } catch (err) {
      throw asIpc(err)
    }
  })

  ipcMain.handle('mail:save-draft' satisfies InvokeChannel, async (_e, req: InvokeReq<'mail:save-draft'>): Promise<InvokeRes<'mail:save-draft'>> => {
    const r = obj(req) as Partial<MailDraftInput>
    try {
      const s = await pick('mail-send', r.sourceId)
      return await saveDraft(s, await message(s, r))
    } catch (err) {
      throw asIpc(err)
    }
  })

  ipcMain.handle('mail:send' satisfies InvokeChannel, async (_e, req: InvokeReq<'mail:send'>): Promise<InvokeRes<'mail:send'>> => {
    const r = obj(req) as Partial<MailDraftInput>
    if (await blocked()) throw expected(notulaError('provider-error', MAIL_COPY.localOnly))
    if (typeof r.followUpDraftId !== 'string' || !r.followUpDraftId) throw bad('Send works from a follow-up draft.')
    const s = await pick('mail-send', r.sourceId)
    const d = await ctx.storage.getFollowUpDraft({ id: r.followUpDraftId })
    if (!d) throw expected(notulaError('not-found', 'This draft no longer exists.'))
    // Checked now so the user hears at once; the text itself is read when the send is due.
    await message(s, { followUpDraftId: d.id })
    const out = await ctx.integrations.share({
      provider: s.kind === 'google' ? 'gmail' : 'outlook',
      noteId: d.document_id,
      panelId: null,
      destinationIds: [s.id],
      targets: [{ kind: 'person', id: d.id, label: '' }]
    })
    const deliveryId = out.deliveryIds[0]
    if (!deliveryId) throw expected(notulaError('internal', 'Couldn’t schedule the email.'))
    log('info', 'mail:send-scheduled', { provider: s.kind, deliveryId })
    return { deliveryId }
  })

  ipcMain.handle('mail:cancel-send' satisfies InvokeChannel, async (_e, req: InvokeReq<'mail:cancel-send'>): Promise<InvokeRes<'mail:cancel-send'>> => {
    const id = obj(req)['deliveryId']
    if (typeof id !== 'string' || !id) throw bad('deliveryId is required')
    // The outbox cancel (the outbox's rule): only a row that has not started sending.
    const row = await ctx.storage.updateIntegrationDelivery(id, {})
    if ((row.provider !== 'gmail' && row.provider !== 'outlook') || (row.status !== 'scheduled' && row.status !== 'pending')) throw bad('This was already sent or is being sent.')
    const d: IntegrationDelivery = await ctx.storage.updateIntegrationDelivery(id, { status: 'cancelled', nextAttemptAt: null })
    for (const wc of ctx.windows.targets()) wc.send('integrations:delivery' satisfies PushChannel, d)
    log('info', 'mail:send-cancelled', { provider: row.provider, deliveryId: id })
    return d
  })

  // ---------- chat tools ----------

  ctx.chat.registerToolProvider({
    id: 'mail',
    async tools(): Promise<ChatToolSpec[]> {
      if (!(await ctx.settings.get('mail.enabled')) || (await blocked())) return []
      const all = await sources()
      const canRead = all.some((s) => s.grants.includes('mail-read'))
      const canSend = all.some((s) => s.grants.includes('mail-send'))
      const out: ChatToolSpec[] = []
      if (canRead) {
        out.push(
          {
            def: {
              name: TOOLS.search,
              description: 'Searches the user’s email threads (Gmail search syntax on Gmail). Returns subjects, participants, dates and snippets.',
              inputSchema: {
                type: 'object',
                properties: { query: { type: 'string' }, maxResults: { type: 'number', description: 'Up to 20.' }, pageToken: { type: 'string' } },
                required: ['query'],
                additionalProperties: false
              }
            },
            category: 'email',
            needsApproval: false,
            readOnly: true,
            title: 'Email search'
          },
          {
            def: {
              name: TOOLS.person,
              description: 'Finds recent email threads (last 90 days) with one person by email address.',
              inputSchema: { type: 'object', properties: { email: { type: 'string' }, maxResults: { type: 'number' } }, required: ['email'], additionalProperties: false }
            },
            category: 'email',
            needsApproval: false,
            readOnly: true,
            title: 'Email with a person'
          },
          {
            def: {
              name: TOOLS.read,
              description: 'Reads one email thread by id (from a search). Quoted replies are removed; long threads are shortened.',
              inputSchema: { type: 'object', properties: { threadId: { type: 'string' } }, required: ['threadId'], additionalProperties: false }
            },
            category: 'email',
            needsApproval: false,
            readOnly: true,
            title: 'Read email'
          }
        )
      }
      if (canSend) {
        out.push({
          def: {
            name: TOOLS.write,
            description: 'Drafts an email for the user to review and send from a card. Nothing is sent by this tool; write the body as plain text.',
            inputSchema: {
              type: 'object',
              properties: {
                to: { type: 'array', items: { type: 'string' } },
                cc: { type: 'array', items: { type: 'string' } },
                bcc: { type: 'array', items: { type: 'string' } },
                subject: { type: 'string' },
                body: { type: 'string', description: 'Plain text.' },
                inReplyToThread: { type: 'string', description: 'A thread id to reply in (Gmail).' }
              },
              required: ['to', 'subject', 'body'],
              additionalProperties: false
            }
          },
          category: 'email',
          needsApproval: false,
          readOnly: true,
          title: 'Email draft'
        })
      }
      return out
    },
    async run(name, args, opts) {
      try {
        if (name === TOOLS.search || name === TOOLS.person) {
          const r = await search({
            ...(name === TOOLS.search ? { query: String(args['query'] ?? '') } : { personEmail: String(args['email'] ?? '') }),
            max: Number(args['maxResults']) || 10,
            ...(typeof args['pageToken'] === 'string' && args['pageToken'].length <= 4_096 ? { pageToken: args['pageToken'] } : {})
          })
          return { content: JSON.stringify(r), data: { count: r.threads.length }, isError: false }
        }
        if (name === TOOLS.read) {
          const id = String(args['threadId'] ?? '')
          if (!/^[A-Za-z0-9_=+/-]{1,512}$/.test(id)) return { content: 'That isn’t a thread id from a search.', isError: true }
          const r = await read(id)
          return { content: JSON.stringify(r), data: { messages: r.messages.length }, isError: false }
        }
        if (name === TOOLS.write) {
          const block = await blockStore().create({ type: 'email', threadId: opts.threadId, content: args })
          return {
            content: JSON.stringify({ draft: block.content, blockId: block.id, sent: false, note: 'The user reviews this draft on a card and sends it themselves.' }),
            data: { blockId: block.id },
            isError: false
          }
        }
        return { content: `Unknown tool ${name}.`, isError: true }
      } catch (err) {
        const msg = err instanceof MailError ? err.message : err instanceof Error ? err.message.replace(/^[a-z-]+: /, '') : MAIL_COPY.other
        return { content: msg, isError: true }
      }
    }
  })

  // ---------- ctx.emailContext (for briefs) ----------

  return {
    async forEvent(eventId: string): Promise<EmailContext[]> {
      try {
        if (!(await ctx.settings.get('mail.enabled')) || (await blocked())) return []
        if (!(await sources()).some((s) => s.grants.includes('mail-read'))) return []
        const ev = await ctx.calendar.getEvent(eventId)
        if (!ev) return []
        const mine = new Set((await ctx.calendar.myEmails()).map((e) => e.toLowerCase()))
        const myDomains = new Set([...mine].filter((e) => !FREE_MAIL.test(e)).map((e) => e.split('@')[1] ?? ''))
        const external = (ev.attendees ?? [])
          .map((a) => (typeof a.email === 'string' ? a.email.toLowerCase() : ''))
          .filter((e) => EMAIL.test(e) && !mine.has(e) && !myDomains.has(e.split('@')[1] ?? '') && !(e.endsWith('calendar.google.com') || e.includes('resource')))
          .slice(0, MAIL_LIMITS.briefAttendees)
        const out: EmailContext[] = []
        for (const email of external) {
          const r = await search({ personEmail: email, max: MAIL_LIMITS.briefThreads }).catch(() => null)
          if (!r?.threads.length) continue
          const since = Date.now() - MAIL_LIMITS.briefDays * 86_400_000
          const threads = r.threads
            .filter((t) => Date.parse(t.lastMessageAt) >= since)
            .slice(0, MAIL_LIMITS.briefThreads)
            .map((t) => ({ ...t, snippet: t.snippet.slice(0, MAIL_LIMITS.briefSnippetChars) }))
          if (threads.length) out.push({ attendeeEmail: email, threads })
        }
        log('info', 'mail:brief-context', { attendees: out.length })
        return out
      } catch {
        return []
      }
    }
  }
}
