// SPDX-License-Identifier: Apache-2.0
// Gmail and Microsoft Graph mail calls, main only. Mail
// content passes through memory and is never stored; nothing here logs a subject, an address or a
// body.

import { randomBytes } from 'node:crypto'
import { MAIL_LIMITS, type MailThread } from '@shared/types/mail'
import type { MainContext } from '../context'
import { exchange, insufficientScope, providerHttp, type Exchange } from '../calendar-write/http'
import { buildForwardRaw, buildRaw, forwardSubject, parseForwardSource, stripQuoted } from './mime'

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {})
const arr = (v: unknown): Obj[] => (Array.isArray(v) ? (v as unknown[]).map(obj) : [])
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

export const MAIL_COPY = {
  localOnly: 'Email is off while Local-only mode is on.',
  reconnect: 'Reconnect your calendar to continue.',
  needRead: 'Notula needs permission to read mail. Turn it on in Settings.',
  needSend: 'Notula needs permission to send mail. Turn it on in Settings.',
  maySent: 'Notula can’t tell whether this email went out. Check your Sent folder before you send it again.',
  network: 'Couldn’t reach your mail account. Check your connection and try again.',
  other: 'Couldn’t reach your mailbox. Try again.',
  replyAndForward: 'Choose either a reply or a forward, not both.',
  forwardTooLarge: 'This email is too large to forward with its attachments. Forward it without them.'
} as const

export class MailError extends Error {
  constructor(
    readonly code: 'local_only' | 'missing_token' | 'missing_scopes' | 'network' | 'uncertain' | 'provider',
    message: string,
    readonly retryable = false
  ) {
    super(message)
  }
}

function raise(x: Exclude<Exchange, { ok: true }>, need: 'read' | 'send', sending = false): never {
  if (x.kind === 'local-only') throw new MailError('local_only', MAIL_COPY.localOnly)
  if (x.kind === 'network') throw new MailError('network', MAIL_COPY.network, true)
  if (x.kind === 'uncertain') throw sending ? new MailError('uncertain', MAIL_COPY.maySent) : new MailError('network', MAIL_COPY.network, true)
  if (x.status === 401) throw new MailError('missing_token', MAIL_COPY.reconnect)
  if (insufficientScope(x)) throw new MailError('missing_scopes', need === 'read' ? MAIL_COPY.needRead : MAIL_COPY.needSend)
  if (x.status === 429 || x.status >= 500) throw sending && x.status >= 500 ? new MailError('uncertain', MAIL_COPY.maySent) : new MailError('network', MAIL_COPY.network, true)
  throw new MailError('provider', MAIL_COPY.other)
}

const auth = (token: string, extra: Record<string, string> = {}): Record<string, string> => ({ authorization: `Bearer ${token}`, accept: 'application/json', ...extra })
const cap = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

export interface ReadThread {
  id: string
  subject: string
  messages: { from: string; to: string[]; cc: string[]; sentAt: string; text: string }[]
}

export interface SendDraft {
  from: string
  to: string[]
  cc: string[]
  bcc: string[]
  subject: string
  html: string
  text: string
  inReplyToThread?: string | null
  /** Forwards this message (Gmail or Graph message id); `text` is the introduction above it. */
  forward?: { messageId: string; includeAttachments: boolean } | null
}

// ---------- Gmail ----------

function header(msg: Obj, name: string): string {
  const h = arr(obj(msg['payload'])['headers']).find((x) => str(x['name']).toLowerCase() === name.toLowerCase())
  return str(h?.['value'])
}

function gmailThread(t: Obj): MailThread {
  const msgs = arr(t['messages'])
  const last = msgs[msgs.length - 1] ?? {}
  const people = new Set<string>()
  for (const m of msgs) for (const h of ['From', 'To', 'Cc']) for (const p of header(m, h).split(',')) if (p.trim()) people.add(p.trim())
  const ms = Number(str(last['internalDate']))
  return {
    id: str(t['id']),
    subject: header(msgs[0] ?? {}, 'Subject') || '(no subject)',
    participants: [...people].slice(0, 20),
    lastMessageAt: Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : new Date(0).toISOString(),
    snippet: str(last['snippet'] ?? t['snippet'])
  }
}

export async function gmailSearch(ctx: MainContext, token: string, q: string, max: number, pageToken?: string): Promise<{ threads: MailThread[]; nextPageToken: string | null }> {
  const http = providerHttp(ctx, 'integration', 'mail')
  const list = await exchange(() =>
    http.fetch('https://gmail.googleapis.com/gmail/v1/users/me/threads', {
      query: { q, maxResults: String(Math.max(1, Math.min(MAIL_LIMITS.searchMax, max))), ...(pageToken ? { pageToken } : {}) },
      headers: auth(token)
    })
  )
  if (!list.ok) raise(list, 'read')
  const ids = arr(list.body['threads']).map((t) => str(t['id'])).filter(Boolean)
  const threads: MailThread[] = []
  for (const id of ids) {
    const t = await exchange(() =>
      http.fetch('https://gmail.googleapis.com/gmail/v1/users/me/threads/{id}', {
        params: { id },
        query: new URLSearchParams([['format', 'metadata'], ['metadataHeaders', 'Subject'], ['metadataHeaders', 'From'], ['metadataHeaders', 'To'], ['metadataHeaders', 'Cc']]),
        headers: auth(token)
      })
    )
    if (t.ok) threads.push(gmailThread(t.body))
  }
  return { threads, nextPageToken: str(list.body['nextPageToken']) || null }
}

function gmailText(part: Obj): string {
  const mime = str(part['mimeType'])
  const data = str(obj(part['body'])['data'])
  if (mime === 'text/plain' && data) return Buffer.from(data, 'base64url').toString('utf8')
  for (const p of arr(part['parts'])) {
    const t = gmailText(p)
    if (t) return t
  }
  if (mime === 'text/html' && data) return Buffer.from(data, 'base64url').toString('utf8').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
  return ''
}

export async function gmailRead(ctx: MainContext, token: string, id: string): Promise<ReadThread> {
  const http = providerHttp(ctx, 'integration', 'mail')
  const t = await exchange(() => http.fetch('https://gmail.googleapis.com/gmail/v1/users/me/threads/{id}', { params: { id }, query: { format: 'full' }, headers: auth(token) }))
  if (!t.ok) raise(t, 'read')
  return threadFrom(
    str(t.body['id']),
    header(arr(t.body['messages'])[0] ?? {}, 'Subject'),
    arr(t.body['messages']).map((m) => ({
      from: header(m, 'From'),
      to: header(m, 'To').split(',').map((x) => x.trim()).filter(Boolean),
      cc: header(m, 'Cc').split(',').map((x) => x.trim()).filter(Boolean),
      sentAt: new Date(Number(str(m['internalDate'])) || 0).toISOString(),
      text: stripQuoted(gmailText(obj(m['payload'])))
    }))
  )
}

function threadFrom(id: string, subject: string, messages: ReadThread['messages']): ReadThread {
  let budget = MAIL_LIMITS.readThreadChars
  const out: ReadThread['messages'] = []
  for (const m of messages) {
    if (budget <= 0) break
    const text = cap(m.text, Math.min(MAIL_LIMITS.readMessageChars, budget))
    budget -= text.length
    out.push({ ...m, text })
  }
  return { id, subject: subject || '(no subject)', messages: out }
}

/** The reply headers from a thread's last message. */
async function gmailReplyHeaders(ctx: MainContext, token: string, threadId: string): Promise<{ inReplyTo: string | null; references: string | null }> {
  const http = providerHttp(ctx, 'integration', 'mail')
  const t = await exchange(() =>
    http.fetch('https://gmail.googleapis.com/gmail/v1/users/me/threads/{id}', {
      params: { id: threadId },
      query: new URLSearchParams([['format', 'metadata'], ['metadataHeaders', 'Message-ID'], ['metadataHeaders', 'References']]),
      headers: auth(token)
    })
  )
  if (!t.ok) return { inReplyTo: null, references: null }
  const msgs = arr(t.body['messages'])
  const last = msgs[msgs.length - 1] ?? {}
  const mid = header(last, 'Message-ID')
  const refs = header(last, 'References')
  return { inReplyTo: mid || null, references: [refs, mid].filter(Boolean).join(' ') || null }
}

/** A forward of one message as a raw message: the original is read whole (`mail-read`). */
async function gmailForwardRaw(ctx: MainContext, token: string, m: SendDraft, forward: NonNullable<SendDraft['forward']>): Promise<string> {
  const http = providerHttp(ctx, 'integration', 'mail')
  const x = await exchange(() => http.fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/{id}', { params: { id: forward.messageId }, query: { format: 'raw' }, headers: auth(token) }))
  if (!x.ok) raise(x, 'read')
  const original = parseForwardSource(Buffer.from(str(x.body['raw']), 'base64url').toString('latin1'))
  const raw = buildForwardRaw({ ...m, subject: forwardSubject(m.subject || original.subject) }, original, forward.includeAttachments, `notula-${randomBytes(12).toString('hex')}`)
  if (!raw) throw new MailError('provider', MAIL_COPY.forwardTooLarge)
  return raw
}

export async function gmailCreateDraft(ctx: MainContext, token: string, m: SendDraft): Promise<{ draftId: string; messageId: string | null }> {
  const http = providerHttp(ctx, 'integration', 'mail')
  const reply = m.inReplyToThread ? await gmailReplyHeaders(ctx, token, m.inReplyToThread) : { inReplyTo: null, references: null }
  const raw = m.forward ? await gmailForwardRaw(ctx, token, m, m.forward) : buildRaw({ ...m, ...reply }, `notula-${randomBytes(12).toString('hex')}`)
  const x = await exchange(() =>
    http.fetch('https://gmail.googleapis.com/gmail/v1/users/me/drafts', {
      method: 'POST',
      headers: auth(token, { 'content-type': 'application/json' }),
      body: JSON.stringify({ message: { raw, ...(m.inReplyToThread ? { threadId: m.inReplyToThread } : {}) } })
    })
  )
  if (!x.ok) raise(x, 'send')
  return { draftId: str(x.body['id']), messageId: str(obj(x.body['message'])['id']) || null }
}

export async function gmailSendDraft(ctx: MainContext, token: string, draftId: string): Promise<{ messageId: string | null; threadId: string | null }> {
  const http = providerHttp(ctx, 'integration', 'mail')
  const x = await exchange(() =>
    http.fetch('https://gmail.googleapis.com/gmail/v1/users/me/drafts/send', {
      method: 'POST',
      headers: auth(token, { 'content-type': 'application/json' }),
      body: JSON.stringify({ id: draftId })
    })
  )
  if (!x.ok) raise(x, 'send', true)
  return { messageId: str(x.body['id']) || null, threadId: str(x.body['threadId']) || null }
}

// ---------- Microsoft Graph ----------

const SELECT = 'subject,from,toRecipients,ccRecipients,receivedDateTime,bodyPreview,conversationId'

function address(v: unknown): string {
  const e = obj(obj(v)['emailAddress'])
  const a = str(e['address'])
  const n = str(e['name'])
  return n && a && n !== a ? `${n} <${a}>` : a
}

function graphThreads(messages: Obj[]): MailThread[] {
  const by = new Map<string, Obj[]>()
  for (const m of messages) {
    const c = str(m['conversationId'])
    if (!c) continue
    by.set(c, [...(by.get(c) ?? []), m])
  }
  return [...by.entries()].map(([id, ms]) => {
    const sorted = ms.sort((a, b) => str(a['receivedDateTime']).localeCompare(str(b['receivedDateTime'])))
    const last = sorted[sorted.length - 1] ?? {}
    const people = new Set<string>()
    for (const m of sorted) for (const p of [address(m['from']), ...arr(m['toRecipients']).map(address), ...arr(m['ccRecipients']).map(address)]) if (p) people.add(p)
    return {
      id,
      subject: str(sorted[0]?.['subject']) || '(no subject)',
      participants: [...people].slice(0, 20),
      lastMessageAt: str(last['receivedDateTime']) || new Date(0).toISOString(),
      snippet: str(last['bodyPreview'])
    }
  })
}

/** `$search` quoting: the query inside double quotes, with its own quotes removed. */
const searchTerm = (q: string): string => `"${q.replace(/["\\]/g, ' ').trim().slice(0, 500)}"`

export async function graphSearch(ctx: MainContext, token: string, q: string, max: number): Promise<{ threads: MailThread[]; nextPageToken: null }> {
  const http = providerHttp(ctx, 'integration', 'mail')
  const x = await exchange(() =>
    http.fetch('https://graph.microsoft.com/v1.0/me/messages', {
      query: { $search: searchTerm(q), $top: String(Math.max(1, Math.min(50, max * 3))), $select: SELECT },
      headers: auth(token)
    })
  )
  if (!x.ok) raise(x, 'read')
  return { threads: graphThreads(arr(x.body['value'])).slice(0, max), nextPageToken: null }
}

export async function graphRead(ctx: MainContext, token: string, conversationId: string): Promise<ReadThread> {
  const http = providerHttp(ctx, 'integration', 'mail')
  const x = await exchange(() =>
    http.fetch('https://graph.microsoft.com/v1.0/me/messages', {
      query: { $filter: `conversationId eq '${conversationId.replace(/'/g, "''")}'`, $select: `${SELECT},body`, $top: '50' },
      headers: auth(token, { prefer: 'outlook.body-content-type="text"' })
    })
  )
  if (!x.ok) raise(x, 'read')
  const ms = arr(x.body['value']).sort((a, b) => str(a['receivedDateTime']).localeCompare(str(b['receivedDateTime'])))
  return threadFrom(
    conversationId,
    str(ms[0]?.['subject']),
    ms.map((m) => ({
      from: address(m['from']),
      to: arr(m['toRecipients']).map(address),
      cc: arr(m['ccRecipients']).map(address),
      sentAt: str(m['receivedDateTime']),
      text: stripQuoted(str(obj(m['body'])['content']))
    }))
  )
}

const recipients = (list: string[]): Obj[] => list.map((address) => ({ emailAddress: { address } }))

/** A forward draft: Graph copies the original (with its attachments) and puts the comment above it. */
async function graphForwardDraft(ctx: MainContext, token: string, m: SendDraft, forward: NonNullable<SendDraft['forward']>): Promise<{ draftId: string; webUrl: string | null }> {
  const http = providerHttp(ctx, 'integration', 'mail')
  const json = auth(token, { 'content-type': 'application/json' })
  const x = await exchange(() =>
    http.fetch('https://graph.microsoft.com/v1.0/me/messages/{id}/createForward', {
      method: 'POST',
      params: { id: forward.messageId },
      headers: json,
      body: JSON.stringify({ comment: m.text, toRecipients: recipients(m.to) })
    })
  )
  if (!x.ok) raise(x, 'send')
  const draftId = str(x.body['id'])
  if (m.cc.length || m.bcc.length) {
    const p = await exchange(() =>
      http.fetch('https://graph.microsoft.com/v1.0/me/messages/{id}', {
        method: 'PATCH',
        params: { id: draftId },
        headers: json,
        body: JSON.stringify({ ccRecipients: recipients(m.cc), bccRecipients: recipients(m.bcc) })
      })
    )
    if (!p.ok) raise(p, 'send')
  }
  if (!forward.includeAttachments) {
    const list = await exchange(() => http.fetch('https://graph.microsoft.com/v1.0/me/messages/{id}/attachments', { params: { id: draftId }, query: { $select: 'id' }, headers: auth(token) }))
    if (!list.ok) raise(list, 'send')
    for (const a of arr(list.body['value'])) {
      const del = await exchange(() =>
        http.fetch('https://graph.microsoft.com/v1.0/me/messages/{id}/attachments/{attachmentId}', { method: 'DELETE', params: { id: draftId, attachmentId: str(a['id']) }, headers: auth(token) })
      )
      if (!del.ok) raise(del, 'send')
    }
  }
  return { draftId, webUrl: str(x.body['webLink']) || null }
}

export async function graphCreateDraft(ctx: MainContext, token: string, m: SendDraft): Promise<{ draftId: string; webUrl: string | null }> {
  if (m.forward) return graphForwardDraft(ctx, token, m, m.forward)
  const http = providerHttp(ctx, 'integration', 'mail')
  const x = await exchange(() =>
    http.fetch('https://graph.microsoft.com/v1.0/me/messages', {
      method: 'POST',
      headers: auth(token, { 'content-type': 'application/json' }),
      body: JSON.stringify({
        subject: m.subject,
        body: { contentType: 'HTML', content: m.html },
        toRecipients: recipients(m.to),
        ccRecipients: recipients(m.cc),
        bccRecipients: recipients(m.bcc)
      })
    })
  )
  if (!x.ok) raise(x, 'send')
  return { draftId: str(x.body['id']), webUrl: str(x.body['webLink']) || null }
}

export async function graphSend(ctx: MainContext, token: string, id: string): Promise<void> {
  const http = providerHttp(ctx, 'integration', 'mail')
  const x = await exchange(() =>
    http.fetch('https://graph.microsoft.com/v1.0/me/messages/{id}/send', { method: 'POST', params: { id }, headers: auth(token) })
  )
  if (!x.ok) raise(x, 'send', true)
}
