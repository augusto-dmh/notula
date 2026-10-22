// SPDX-License-Identifier: Apache-2.0
// Signed webhooks: the `webhooks:*` IPC and the `webhook` plug-in.
//
// - Endpoints are personal (`my_notes_only` or `one_folder`), at most 20. The URL is a secret
//   (`integration.webhook.url.<id>`): only its scheme + host (`url_label`) is stored, logged or
//   returned. The signing secret (`whsec_` + base64 of 32 CSPRNG bytes) is shown once, by
//   `webhooks:create` and `webhooks:rotate-secret`, and lives only in safeStorage.
// - Every delivery is signed here, in main (Standard Webhooks layout): `webhook-id` (the event id),
//   `webhook-timestamp` (Unix seconds at send time) and `webhook-signature` = `v1,` + base64 of
//   HMAC-SHA256 over `<id>.<timestamp>.<body>`. Retries reuse the event id with a new timestamp.
// - Events: `note.summarized` (the first summary with content), `note.updated` (coalesced 60 s, at most
//   one per note per 5 min) and `note.access_added` (a note added to a `one_folder` endpoint's
//   folder). They go through the integration outbox: provider `webhook`, `destination_id` = the endpoint
//   id, `trigger` `folder` ("automatic"). The outbox row has no field for the event type,
//   so `target_key` is `<event type>:<event id>`, and `occurred_at` is the row's creation time.
// - 410 turns the endpoint off (`gone`); 20 consecutive failures or 72 h of failures turn it off
//   (`failures`) with an `info` card. A timeout after sending is `uncertain`, never retried.
// - Logs carry the endpoint id, `url_label`, the event id, the HTTP status and the attempt only.

import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { app, ipcMain } from 'electron'
import { notulaError } from '@shared/errors'
import type { InvokeChannel, InvokeReq, InvokeRes, PushChannel } from '@shared/ipc'
import type { IntegrationDelivery } from '@shared/types/integrations'
import type { Note } from '@shared/types/notes'
import { WEBHOOK_LIMITS, WEBHOOK_SECRET_PREFIX, type WebhookEndpoint, type WebhookEndpointInput, type WebhookEvent, type WebhookTestResult } from '@shared/types/webhooks'
import type { SecretId } from '@shared/types/settings'
import { bad, obj, onStorageReady } from '../automations/util'
import { exchange } from '../calendar-write/http'
import type { MainContext } from '../context'
import type { IntegrationPlugin, IntegrationSendOutcome } from '../integration-plugins'
import { latestSummaryPanel, markdownToHtml, panelMarkdown } from '../integrations/content'
import { expected } from '../ipc-expected'
import { log } from '../log'
import { egressFetch } from '../net/egress'
import { isLoopbackUrl } from '../net/loopback'
import { LOCAL_ONLY_REASON } from '../privacy'
import { readerTranscript } from '../sources/reader'

const EVENTS: readonly WebhookEvent[] = ['note.summarized', 'note.updated', 'note.access_added']
export const WEBHOOK_COPY = {
  urlRule: 'Webhooks can only go to a public https:// address, and this one isn’t.',
  gone: 'This endpoint asked Notula to stop sending (410).',
  folderGone: 'The folder for this webhook was deleted.',
  autoOff: (host: string): string => `Webhook turned off: ${host} kept failing.`
} as const

type EndpointRow = WebhookEndpoint & { url_secret_id: string; signing_secret_id: string }

const urlSecret = (id: string): SecretId => `integration.webhook.url.${id}`
const signingSecret = (id: string): SecretId => `integration.webhook.signing.${id}`

/** The URL rule: https, or http on a loopback address. Returns the cleaned URL and its label. */
export function checkWebhookUrl(raw: unknown): { url: string; label: string; local: boolean } {
  const v = typeof raw === 'string' ? raw.trim() : ''
  let u: URL
  try {
    u = new URL(v)
  } catch {
    throw bad(WEBHOOK_COPY.urlRule)
  }
  const local = u.protocol === 'http:' && isLoopbackUrl(v) && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)
  if (v.length > 2_000 || u.username || u.password || !(u.protocol === 'https:' || local) || !u.hostname) throw bad(WEBHOOK_COPY.urlRule)
  return { url: u.toString(), label: `${u.protocol}//${u.host}`, local }
}

function newSecret(): string {
  return WEBHOOK_SECRET_PREFIX + randomBytes(WEBHOOK_LIMITS.secretBytes).toString('base64')
}

/** `v1,` + base64 HMAC-SHA256 over `<id>.<timestamp>.<body>`, keyed with the secret's raw bytes. */
export function signWebhook(secret: string, id: string, timestamp: number, body: string): string {
  const key = Buffer.from(secret.startsWith(WEBHOOK_SECRET_PREFIX) ? secret.slice(WEBHOOK_SECRET_PREFIX.length) : secret, 'base64')
  return `v1,${createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64')}`
}

function publicEndpoint(e: EndpointRow | WebhookEndpoint): WebhookEndpoint {
  const { url_secret_id: _u, signing_secret_id: _s, ...pub } = e as EndpointRow
  return pub
}

function events(v: unknown): WebhookEvent[] {
  if (!Array.isArray(v)) throw bad('Pick at least one event.')
  const out = EVENTS.filter((e) => v.includes(e))
  if (!out.length) throw bad('Pick at least one event.')
  return out
}

// ---------- payload ----------

interface PayloadInput {
  eventId: string
  eventType: WebhookEvent
  occurredAt: string
  note: Note | null
  includeTranscript: boolean
  automation: { id: string; name: string } | null
  test: boolean
}

function offsetIso(iso: string): string {
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return iso
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  const pad = (n: number): string => String(Math.floor(Math.abs(n))).padStart(2, '0')
  const local = new Date(d.getTime() + off * 60_000).toISOString().slice(0, 19)
  return `${local}${sign}${pad(off / 60)}:${pad(off % 60)}`
}

async function buildBody(ctx: MainContext, p: PayloadInput): Promise<string> {
  const base: Record<string, unknown> = {
    event_id: p.eventId,
    event_type: p.eventType,
    note_id: p.note?.id ?? '00000000-0000-4000-8000-000000000000',
    occurred_at: offsetIso(p.occurredAt),
    data: p.eventType === 'note.updated' ? { changed_fields: ['summary'] } : {}
  }
  let note: Record<string, unknown>
  if (!p.note) {
    note = {
      id: base['note_id'],
      title: 'Test note from Notula',
      created_at: offsetIso(p.occurredAt),
      updated_at: offsetIso(p.occurredAt),
      meeting: null,
      attendees: [],
      folders: [],
      summary_markdown: '### Test\n\nThis is a test event from Notula.',
      summary_html: '<h3>Test</h3>\n<p>This is a test event from Notula.</p>',
      notes_md: '',
      app_url: 'notula://notes/test'
    }
  } else {
    const n = p.note
    const [panels, folders] = await Promise.all([ctx.storage.listPanels(n.id), ctx.storage.listFolders()])
    const md = panelMarkdown(latestSummaryPanel(panels))
    const ev = n.linked_event
    const attendees = (Array.isArray(ev?.attendees) ? ev.attendees.map((a) => ({ name: a.displayName ?? '', email: a.email })) : (n.people?.attendees ?? []).map((a) => ({ name: a.name ?? '', email: a.email ?? '' }))).filter((a) => a.email)
    note = {
      id: n.id,
      title: n.title ?? '',
      created_at: offsetIso(n.created_at),
      updated_at: offsetIso(n.updated_at),
      meeting: ev ? { title: ev.summary ?? '', start: ev.start?.dateTime ?? ev.start?.date ?? null, end: ev.end?.dateTime ?? ev.end?.date ?? null } : null,
      attendees,
      folders: folders.folders.filter((f) => (folders.membership[f.id] ?? []).includes(n.id)).map((f) => ({ id: f.id, title: f.title })),
      summary_markdown: md,
      summary_html: md ? markdownToHtml(md) : '',
      notes_md: n.notes_md ?? '',
      app_url: `notula://notes/${n.id}`
    }
    if (p.includeTranscript) {
      const chunks = await readerTranscript(ctx, n.id, await ctx.storage.getTranscript(n.id))
      note['transcript'] = chunks
        .filter((c) => c.is_final && c.text.trim())
        .map((c) => ({ speaker: (c as { detected_speaker_name?: string | null }).detected_speaker_name || (c.source === 'microphone' ? 'Me' : 'Them'), start: c.start_timestamp, text: c.text }))
    }
  }
  const payload: Record<string, unknown> = { ...base, note }
  if (p.automation) payload['automation'] = p.automation
  if (p.test) payload['test'] = true
  let body = JSON.stringify(payload)
  const truncated: string[] = []
  for (const field of ['transcript', 'notes_md'] as const) {
    if (Buffer.byteLength(body) <= WEBHOOK_LIMITS.bodyMaxBytes) break
    if (!(field in note)) continue
    delete note[field]
    truncated.push(field)
    payload['truncated'] = truncated
    body = JSON.stringify(payload)
  }
  return body
}

// ---------- one POST ----------

type PostResult = { kind: 'ok'; status: number } | { kind: 'http'; status: number; retryAfterMs: number | null } | { kind: 'network' } | { kind: 'uncertain' } | { kind: 'local-only' }

async function post(ctx: MainContext, url: string, secret: string, eventId: string, body: string, signal?: AbortSignal): Promise<PostResult> {
  const ts = Math.floor(Date.now() / 1000)
  const timeout = AbortSignal.timeout(WEBHOOK_LIMITS.timeoutMs)
  const x = await exchange(() =>
    egressFetch(
      ctx,
      { kind: 'integration' },
      url,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': `Notula-Webhooks/${app.getVersion()}`,
          'webhook-id': eventId,
          'webhook-timestamp': String(ts),
          'webhook-signature': signWebhook(secret, eventId, ts, body)
        },
        body,
        redirect: 'manual',
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout
      },
      'webhooks'
    )
  )
  if (x.ok) return { kind: 'ok', status: x.status }
  if (x.kind === 'http') return { kind: 'http', status: x.status, retryAfterMs: x.retryAfterMs }
  return x
}

// ---------- the service ----------

export interface WebhooksApi {
  /** For automations: queues a `note.summarized`-style delivery; null when the endpoint is off or gone. */
  queueForAutomation(endpointId: string, noteId: string, rule: { id: string; name: string }): Promise<{ deliveryId: string } | null>
  endpointLabel(endpointId: string): Promise<string | null>
}

let api: WebhooksApi | null = null

/** Automations reach the webhook service through this, after `registerWebhooks`. */
export function webhooks(): WebhooksApi | null {
  return api
}

export function registerWebhooks(ctx: MainContext): void {
  /** Notes whose summary has been sent as `note.summarized` (or seen), and the markdown last seen. */
  const lastSummary = new Map<string, string>()
  const editTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const lastEditSent = new Map<string, number>()
  const recentlyGenerated = new Map<string, number>()
  /** Folder id → its notes, for `note.access_added`. */
  const folderMembers = new Map<string, Set<string>>()
  let ready = false

  const push = (ids: string[]): void => {
    for (const wc of ctx.windows.targets()) wc.send('webhooks:changed' satisfies PushChannel, { ids })
  }

  const list = (): Promise<EndpointRow[]> => ctx.storage.listWebhookEndpoints()
  async function get(id: unknown): Promise<EndpointRow> {
    if (typeof id !== 'string' || !id) throw bad('id is required')
    const e = (await list()).find((x) => x.id === id)
    if (!e) throw expected(notulaError('not-found', 'That webhook no longer exists.'))
    return e
  }

  async function save(e: EndpointRow): Promise<WebhookEndpoint> {
    const out = await ctx.storage.upsertWebhookEndpoint(e)
    push([e.id])
    return out
  }

  async function inScope(e: EndpointRow, noteId: string): Promise<boolean> {
    if (e.scope === 'my_notes_only') return true
    if (!e.folder_id) return false
    const f = await ctx.storage.listFolders()
    return (f.membership[e.folder_id] ?? []).includes(noteId)
  }

  async function queue(e: EndpointRow, noteId: string, type: WebhookEvent, automationId: string | null): Promise<string | null> {
    if (!e.enabled) return null
    const panel = latestSummaryPanel(await ctx.storage.listPanels(noteId))
    const eventId = randomUUID()
    const [d] = await ctx.storage.createIntegrationDeliveries([
      {
        provider: 'webhook',
        destinationId: e.id,
        automationId,
        noteId,
        panelId: panel?.id ?? null,
        targetKey: `${type}:${eventId}`,
        trigger: 'folder',
        status: 'pending',
        nextAttemptAt: new Date().toISOString()
      }
    ])
    if (!d) return null
    for (const wc of ctx.windows.targets()) wc.send('integrations:delivery' satisfies PushChannel, d)
    log('info', 'webhooks:queued', { endpointId: e.id, label: e.url_label, eventId, type })
    ctx.bus.emit('integrations:wake', { reason: 'held-released' })
    return d.id
  }

  async function fire(noteId: string, type: WebhookEvent): Promise<void> {
    for (const e of await list()) {
      if (!e.enabled || !e.events.includes(type)) continue
      if (type === 'note.access_added' && e.scope !== 'one_folder') continue
      if (!(await inScope(e, noteId))) continue
      await queue(e, noteId, type, null)
    }
  }

  // ---------- events ----------

  async function onSummary(noteId: string): Promise<void> {
    const md = panelMarkdown(latestSummaryPanel(await ctx.storage.listPanels(noteId)))
    if (!md) return
    const prior = await ctx.storage.listIntegrationDeliveries({ provider: 'webhook', noteId, limit: 100 })
    const generatedBefore = prior.some((d) => d.targetKey.startsWith('note.summarized:') && d.trigger !== 'test')
    recentlyGenerated.set(noteId, Date.now())
    if (!generatedBefore && !lastSummary.has(noteId)) {
      lastSummary.set(noteId, md)
      await fire(noteId, 'note.summarized')
      return
    }
    // A regeneration is an edit.
    scheduleEdit(noteId)
  }

  function scheduleEdit(noteId: string): void {
    const prev = editTimers.get(noteId)
    if (prev) clearTimeout(prev)
    const t = setTimeout(() => {
      editTimers.delete(noteId)
      void flushEdit(noteId).catch((err: unknown) => log('warn', 'webhooks:edit-failed', { noteId, err: err instanceof Error ? err.name : 'error' }))
    }, WEBHOOK_LIMITS.editCoalesceMs)
    t.unref?.()
    editTimers.set(noteId, t)
  }

  async function flushEdit(noteId: string): Promise<void> {
    const sinceLast = Date.now() - (lastEditSent.get(noteId) ?? 0)
    if (sinceLast < WEBHOOK_LIMITS.editMinGapMs) {
      const t = setTimeout(() => void flushEdit(noteId).catch(() => undefined), WEBHOOK_LIMITS.editMinGapMs - sinceLast)
      t.unref?.()
      editTimers.set(noteId, t)
      return
    }
    const md = panelMarkdown(latestSummaryPanel(await ctx.storage.listPanels(noteId)))
    if (!md || md === lastSummary.get(noteId)) return
    lastSummary.set(noteId, md)
    lastEditSent.set(noteId, Date.now())
    await fire(noteId, 'note.updated')
  }

  async function onPanelsChanged(ids: string[]): Promise<void> {
    for (const id of new Set(ids)) {
      if (!lastSummary.has(id)) continue
      // The completion write of a generation is not an edit.
      if (Date.now() - (recentlyGenerated.get(id) ?? 0) < 10_000) continue
      scheduleEdit(id)
    }
  }

  async function syncFolders(changed: string[] | null): Promise<void> {
    const eps = (await list()).filter((e) => e.scope === 'one_folder')
    // A deleted folder leaves the endpoint with no folder: turn it off.
    for (const e of eps) {
      if (!e.folder_id && e.enabled) {
        await save({ ...e, enabled: false, disabled_reason: 'user' })
        log('info', 'webhooks:folder-removed', { endpointId: e.id })
      }
    }
    const watched = new Set(eps.filter((e) => e.enabled && e.folder_id && e.events.includes('note.access_added')).map((e) => e.folder_id as string))
    const f = await ctx.storage.listFolders()
    for (const folderId of watched) {
      const now = new Set(f.membership[folderId] ?? [])
      const before = folderMembers.get(folderId)
      folderMembers.set(folderId, now)
      if (!before || (changed && !changed.includes(folderId))) continue
      for (const noteId of now) {
        if (before.has(noteId)) continue
        for (const e of eps) {
          if (e.enabled && e.folder_id === folderId && e.events.includes('note.access_added')) await queue(e, noteId, 'note.access_added', null)
        }
      }
    }
    for (const k of [...folderMembers.keys()]) if (!watched.has(k)) folderMembers.delete(k)
  }

  ctx.bus.on('enhance:completed', (e) => {
    if (!e.ok || !ready) return
    void onSummary(e.noteId).catch((err: unknown) => log('warn', 'webhooks:summary-failed', { err: err instanceof Error ? err.name : 'error' }))
  })
  ctx.bus.on('storage:changed', (c) => {
    if (!ready) return
    if (c.tables.includes('note_panels')) void onPanelsChanged(c.ids).catch(() => undefined)
    if (c.tables.includes('folder_notes') || c.tables.includes('folders') || c.tables.includes('webhook_endpoints')) {
      void syncFolders(c.tables.includes('folder_notes') ? c.ids : null).catch(() => undefined)
    }
  })
  onStorageReady(ctx, () => {
    ready = true
    void syncFolders(null).catch(() => undefined)
  })

  // ---------- the outbox executor ----------

  async function settle(e: EndpointRow, ok: boolean): Promise<void> {
    const r = await ctx.storage.recordWebhookResult(e.id, ok, new Date().toISOString()).catch(() => ({ autoDisabled: false }))
    if (!r.autoDisabled) return
    push([e.id])
    log('warn', 'webhooks:auto-disabled', { endpointId: e.id, label: e.url_label })
    const host = (() => {
      try {
        return new URL(e.url_label).host
      } catch {
        return e.url_label
      }
    })()
    ctx.notify.show({
      variant: 'info',
      title: 'Webhook turned off',
      body: WEBHOOK_COPY.autoOff(host),
      showDelayMs: 0,
      hideAfterMs: 15_000,
      quietWhileRecording: false,
      allowDuringOnboarding: false,
      onAction: () => undefined
    })
  }

  const plugin: IntegrationPlugin = {
    provider: 'webhook',
    credentialKinds: [],
    async validate() {
      const eps = await list().catch(() => [] as EndpointRow[])
      const on = eps.filter((e) => e.enabled).length
      return { state: eps.length ? 'connected' : 'not_configured', accountLabel: eps.length ? `${on} of ${eps.length} on` : null, detail: null }
    },
    async send(_c, d: IntegrationDelivery, signal): Promise<IntegrationSendOutcome> {
      const e = (await list()).find((x) => x.id === d.destinationId)
      if (!e) return { status: 'failed', retryable: false, errorCode: 'endpoint_removed', errorMessage: 'This webhook was deleted.' }
      if (!e.enabled) return { status: 'failed', retryable: false, errorCode: 'endpoint_off', errorMessage: 'This webhook is turned off.' }
      const [url, secret] = await Promise.all([ctx.secrets.get(urlSecret(e.id)), ctx.secrets.get(signingSecret(e.id))])
      if (!url || !secret) return { status: 'failed', retryable: false, errorCode: 'missing_secret', errorMessage: 'Set this webhook up again.' }
      const sep = d.targetKey.indexOf(':')
      const type = (sep > 0 ? d.targetKey.slice(0, sep) : 'note.summarized') as WebhookEvent
      const eventId = sep > 0 ? d.targetKey.slice(sep + 1) : d.targetKey || d.id
      const note = await ctx.storage.getNote(d.noteId)
      let automation: { id: string; name: string } | null = null
      if (d.automationId) {
        const rule = (await ctx.storage.listAutomationRules()).find((r) => r.id === d.automationId)
        if (rule) automation = { id: rule.id, name: rule.name }
      }
      const body = await buildBody(ctx, { eventId, eventType: EVENTS.includes(type) ? type : 'note.summarized', occurredAt: d.createdAt, note, includeTranscript: e.include_transcript, automation, test: false })
      const r = await post(ctx, url, secret, eventId, body, signal)
      log('info', 'webhooks:attempt', { endpointId: e.id, label: e.url_label, eventId, attempt: d.attempts, status: r.kind === 'ok' || r.kind === 'http' ? r.status : r.kind })
      if (r.kind === 'ok') {
        await settle(e, true)
        return { status: 'sent' }
      }
      if (r.kind === 'local-only') return { status: 'failed', retryable: true, errorCode: 'local_only', errorMessage: LOCAL_ONLY_REASON }
      if (r.kind === 'uncertain') return { status: 'uncertain', errorMessage: 'Notula can’t tell whether this arrived. Check your tool, then try again if it’s missing.' }
      await settle(e, false)
      if (r.kind === 'network') return { status: 'failed', retryable: true, errorCode: 'network', errorMessage: 'Couldn’t reach this webhook.' }
      if (r.status === 410) {
        await save({ ...e, enabled: false, disabled_reason: 'gone' })
        return { status: 'failed', retryable: false, errorCode: 'http_410', errorMessage: WEBHOOK_COPY.gone }
      }
      // Retries 429, 500, 502, 503 and 504.
      const retryable = [429, 500, 502, 503, 504].includes(r.status)
      return { status: 'failed', retryable, errorCode: `http_${r.status}`, errorMessage: `The destination responded with status ${r.status}` }
    },
    async disconnect() {
      // Endpoints are removed one by one (`webhooks:delete`).
    }
  }

  async function test(e: { id: string; include_transcript: boolean }, url: string, secret: string): Promise<WebhookTestResult> {
    const eventId = randomUUID()
    const body = await buildBody(ctx, { eventId, eventType: 'note.summarized', occurredAt: new Date().toISOString(), note: null, includeTranscript: false, automation: null, test: true })
    const r = await post(ctx, url, secret, eventId, body)
    log('info', 'webhooks:test', { endpointId: e.id, eventId, status: r.kind === 'ok' || r.kind === 'http' ? r.status : r.kind })
    if (r.kind === 'ok') return { ok: true, httpStatusCode: r.status, errorMessage: null }
    if (r.kind === 'http') return { ok: false, httpStatusCode: r.status, errorMessage: null }
    if (r.kind === 'local-only') return { ok: false, httpStatusCode: null, errorMessage: 'Nothing leaves this computer while Local-only mode is on.' }
    if (r.kind === 'uncertain') return { ok: false, httpStatusCode: null, errorMessage: 'The destination didn’t answer in time.' }
    return { ok: false, httpStatusCode: null, errorMessage: 'Couldn’t reach this URL.' }
  }

  // ---------- IPC ----------

  ipcMain.handle('webhooks:list' satisfies InvokeChannel, async (): Promise<InvokeRes<'webhooks:list'>> => (await list()).map(publicEndpoint))

  ipcMain.handle('webhooks:create' satisfies InvokeChannel, async (_e, req: InvokeReq<'webhooks:create'>): Promise<InvokeRes<'webhooks:create'>> => {
    const r = obj(req) as Partial<WebhookEndpointInput>
    const { url, label } = checkWebhookUrl(r.url)
    const scope = r.scope === 'one_folder' ? 'one_folder' : r.scope === 'my_notes_only' ? 'my_notes_only' : null
    if (!scope) throw bad('Pick which notes to send.')
    const folderId = scope === 'one_folder' && typeof r.folderId === 'string' && r.folderId ? r.folderId : null
    if (scope === 'one_folder' && !folderId) throw bad('Pick a folder.')
    if ((await list()).length >= WEBHOOK_LIMITS.maxEndpoints) throw bad(`You can have up to ${WEBHOOK_LIMITS.maxEndpoints} webhooks.`)
    const id = randomUUID()
    const secret = newSecret()
    await ctx.secrets.set(urlSecret(id), url)
    await ctx.secrets.set(signingSecret(id), secret)
    const now = new Date().toISOString()
    const row: EndpointRow = {
      id,
      url_label: label,
      scope,
      folder_id: folderId,
      events: events(r.events),
      enabled: true,
      disabled_reason: null,
      include_transcript: r.includeTranscript === true,
      last_delivery: null,
      created_at: now,
      updated_at: now,
      url_secret_id: urlSecret(id),
      signing_secret_id: signingSecret(id)
    }
    let endpoint: WebhookEndpoint
    try {
      endpoint = await save(row)
    } catch (err) {
      await ctx.secrets.clear(urlSecret(id))
      await ctx.secrets.clear(signingSecret(id))
      throw err
    }
    log('info', 'webhooks:created', { endpointId: id, label, scope })
    return { endpoint, signingSecret: secret, test: await test(row, url, secret) }
  })

  ipcMain.handle('webhooks:update' satisfies InvokeChannel, async (_e, req: InvokeReq<'webhooks:update'>): Promise<InvokeRes<'webhooks:update'>> => {
    const r = obj(req)
    const e = await get(r['id'])
    const next: EndpointRow = { ...e }
    if (r['url'] !== undefined) {
      const { url, label } = checkWebhookUrl(r['url'])
      await ctx.secrets.set(urlSecret(e.id), url)
      next.url_label = label
    }
    if (r['scope'] !== undefined) next.scope = r['scope'] === 'one_folder' ? 'one_folder' : 'my_notes_only'
    if (r['folderId'] !== undefined) next.folder_id = typeof r['folderId'] === 'string' && r['folderId'] ? r['folderId'] : null
    if (next.scope === 'one_folder' && !next.folder_id) throw bad('Pick a folder.')
    if (next.scope === 'my_notes_only') next.folder_id = null
    if (r['events'] !== undefined) next.events = events(r['events'])
    if (r['includeTranscript'] !== undefined) next.include_transcript = r['includeTranscript'] === true
    if (typeof r['enabled'] === 'boolean') {
      if (r['enabled'] && next.scope === 'one_folder' && !next.folder_id) throw bad(WEBHOOK_COPY.folderGone)
      next.enabled = r['enabled']
      next.disabled_reason = r['enabled'] ? null : 'user'
    }
    log('info', 'webhooks:updated', { endpointId: e.id, label: next.url_label, enabled: next.enabled })
    return save(next)
  })

  ipcMain.handle('webhooks:delete' satisfies InvokeChannel, async (_e, req: InvokeReq<'webhooks:delete'>): Promise<void> => {
    const e = await get(obj(req)['id'])
    await ctx.storage.deleteWebhookEndpoint(e.id)
    await ctx.secrets.clear(urlSecret(e.id))
    await ctx.secrets.clear(signingSecret(e.id))
    // Automations that target it stop.
    const off: string[] = []
    for (const rule of await ctx.storage.listAutomationRules()) {
      const a = rule.actions[0]
      if (a.type === 'post_webhook' && a.webhook_id === e.id && rule.enabled) {
        await ctx.storage.upsertAutomationRule({ ...rule, enabled: false })
        off.push(rule.id)
      }
    }
    if (off.length) for (const wc of ctx.windows.targets()) wc.send('automations:changed' satisfies PushChannel, { ruleIds: off })
    log('info', 'webhooks:deleted', { endpointId: e.id, label: e.url_label, automationsOff: off.length })
    push([e.id])
  })

  ipcMain.handle('webhooks:test' satisfies InvokeChannel, async (_e, req: InvokeReq<'webhooks:test'>): Promise<InvokeRes<'webhooks:test'>> => {
    const e = await get(obj(req)['id'])
    const [url, secret] = await Promise.all([ctx.secrets.get(urlSecret(e.id)), ctx.secrets.get(signingSecret(e.id))])
    if (!url || !secret) throw expected(notulaError('missing-key', 'Set this webhook up again.'))
    return test(e, url, secret)
  })

  ipcMain.handle('webhooks:rotate-secret' satisfies InvokeChannel, async (_e, req: InvokeReq<'webhooks:rotate-secret'>): Promise<InvokeRes<'webhooks:rotate-secret'>> => {
    const e = await get(obj(req)['id'])
    const secret = newSecret()
    await ctx.secrets.set(signingSecret(e.id), secret)
    log('info', 'webhooks:secret-rotated', { endpointId: e.id })
    push([e.id])
    return { signingSecret: secret }
  })

  ctx.integrationPlugins.register(plugin)

  api = {
    async queueForAutomation(endpointId, noteId, rule) {
      const e = (await list()).find((x) => x.id === endpointId)
      if (!e || !e.enabled) return null
      const id = await queue(e, noteId, 'note.summarized', rule.id)
      return id ? { deliveryId: id } : null
    },
    async endpointLabel(endpointId) {
      return (await list()).find((x) => x.id === endpointId)?.url_label ?? null
    }
  }
}
