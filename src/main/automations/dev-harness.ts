// SPDX-License-Identifier: Apache-2.0
// Smoke harness for rules, automations, customer calls and webhooks. Dev only: unpackaged
// builds with `NOTULA_DEV_WB_HARNESS=1`, a scratch NOTULA_USER_DATA_DIR, and a local fixture server in
// NOTULA_DEV_PROVIDER_MOCK that also receives the webhooks (no real provider or URL is ever called).
// Capture never starts: rule checks only block or hold a start and then decline it. The device lock
// is simulated by wrapping `ctx.deviceLock.isLocked` (what is checked is that a decision waits for
// unlock, not the lock itself).
// Writes `<userData>/wb-harness.json`, then quits.

import { createHmac, randomUUID } from 'node:crypto'
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type { CalendarEvent } from '@shared/types/notes'
import type { MainContext } from '../context'
import { log } from '../log'
import { automations } from './index'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export async function runWbHarness(ctx: MainContext): Promise<void> {
  const out: Record<string, unknown> = { startedAt: new Date().toISOString() }
  const file = join(app.getPath('userData'), 'wb-harness.json')
  const save = (): void => writeFileSync(file, JSON.stringify(out, null, 2))
  const check = (name: string, ok: boolean, detail?: unknown): void => {
    out[name] = { ok, ...(detail !== undefined ? { detail } : {}) }
    log('info', 'wb-harness:check', { name, ok })
    save()
  }
  const fixture = process.env['NOTULA_DEV_PROVIDER_MOCK'] ?? ''
  const hooks = async (): Promise<{ path: string; headers: Record<string, string>; body: string }[]> => (await (await fetch(`${fixture}/__hooks`)).json()) as never
  const stats = async (): Promise<Record<string, { count: number; last: string }>> => (await (await fetch(`${fixture}/__stats`)).json()) as never
  /** Outbox reads for plug-in providers fail until the outbox repo accepts them (reported blocked). */
  const deliveries = (q: Parameters<MainContext['storage']['listIntegrationDeliveries']>[0]): ReturnType<MainContext['storage']['listIntegrationDeliveries']> =>
    ctx.storage.listIntegrationDeliveries(q).catch((e: unknown) => {
      out['outbox.blocked'] = { ok: false, detail: e instanceof Error ? e.message : String(e) }
      return []
    })
  const until = async (fn: () => Promise<boolean> | boolean, ms: number, step = 400): Promise<boolean> => {
    for (let t = 0; t < ms; t += step) {
      if (await Promise.resolve().then(fn).catch(() => false)) return true
      await sleep(step)
    }
    return false
  }

  try {
    await until(() => ctx.storage.identity().then(() => true), 60_000)
    await until(() => !!ctx.windows.main() && !ctx.windows.main()?.webContents.isLoading(), 60_000)
    const wc = ctx.windows.main()?.webContents
    if (!wc) throw new Error('no main window')
    const js = async <T>(code: string): Promise<T> => (await wc.executeJavaScript(`(async () => { ${code} })()`, true)) as T
    const now = (): string => new Date().toISOString()
    for (const [k, v] of [
      ['onboarding.aiProvidersDoneAt', now()],
      ['onboarding.calendarDoneAt', now()],
      ['profile.email', 'me@acme.test'],
      ['transcriptionRules.enabled', true],
      ['automations.enabled', true],
      ['integrations.salesforce.enabled', true],
      ['integrations.pipedriveAshby.enabled', true],
      ['connectors.files.enabled', true]
    ] as const) {
      await ctx.settings.set(k as never, v as never)
    }
    await sleep(1_500)
    await js(`window.__wb = { stops: [], decisions: [] }
      window.notula.capture.onStopRequested((p) => window.__wb.stops.push(p))
      window.notula.transcriptionRules.onDecision((d) => window.__wb.decisions.push(d))
      return true`)

    const t0 = Date.now()
    const event = (summary: string, emails: string[], startOffsetMin = -1): CalendarEvent => ({
      id: `wb-${randomUUID()}`,
      iCalUID: `wb-${randomUUID()}@test`,
      summary,
      start: { dateTime: new Date(t0 + startOffsetMin * 60_000).toISOString() },
      end: { dateTime: new Date(t0 + 30 * 60_000).toISOString() },
      attendees: [{ email: 'me@acme.test', self: true, responseStatus: 'accepted' }, ...emails.map((e) => ({ email: e, responseStatus: 'accepted' }))]
    })
    const note = async (title: string, emails: string[]): Promise<string> => (await ctx.storage.createNote({ origin: 'unknown', title, calendarEvent: event(title, emails), created_via: 'Windows' })).id
    /** A meeting that just ended, with a summary. */
    const endMeeting = async (noteId: string, md = '### Summary\n\n- We agreed on pricing.\n- Next call Friday.'): Promise<string> => {
      const sid = randomUUID()
      const started = new Date(Date.now() - 60_000).toISOString()
      await ctx.storage.createSession({ id: sid, document_id: noteId, provider: 'local', model: 'harness', language: 'en', started_at: started })
      await ctx.storage.endSession(sid, now(), 'note_stop_button')
      await sleep(5)
      const ts = now()
      const p = await ctx.storage.createPanel({
        document_id: noteId,
        content_edited_at: ts,
        deleted_at: null,
        title: 'Summary',
        template_key: null,
        content: null,
        content_markdown: md,
        generated_content: md,
        last_opened_at: null,
        enhance_started_at: ts,
        enhance_failed_at: null,
        enhance_error: null,
        ai_line_map: null,
        speakers_attributed: false,
        crdt_version: 1
      })
      ctx.bus.emit('enhance:completed', { noteId, panelId: p.id, ok: true, auto: true })
      return p.id
    }

    // ---------- signed webhooks ----------
    const secretPath = `hook/${randomUUID().replace(/-/g, '')}`
    const created = await js<{ endpoint: { id: string }; signingSecret: string; test: { ok: boolean } }>(
      `return window.notula.webhooks.create({ url: '${fixture}/${secretPath}', scope: 'my_notes_only', events: ['note.summarized', 'note.updated'], includeTranscript: false })`
    )
    const recv = await hooks()
    const first = recv.find((h) => h.path.includes(secretPath))
    const verify = (h: { headers: Record<string, string>; body: string }, body: string): boolean => {
      const key = Buffer.from(created.signingSecret.slice('whsec_'.length), 'base64')
      const sig = `v1,${createHmac('sha256', key).update(`${h.headers['webhook-id']}.${h.headers['webhook-timestamp']}.${body}`).digest('base64')}`
      return sig === h.headers['webhook-signature']
    }
    const tampered = first ? first.body.replace(/"test":true/, '"test":true ') : ''
    check('webhook.create-test-signed', !!first && created.test.ok && verify(first, first.body) && created.signingSecret.startsWith('whsec_'), {
      test: created.test,
      headers: first ? Object.keys(first.headers).filter((k) => k.startsWith('webhook-')) : null
    })
    check('webhook.one-byte-change-fails', !!first && tampered !== first.body && !verify(first, tampered))
    const listed = await js<unknown[]>('return window.notula.webhooks.list()')
    const listedText = JSON.stringify(listed)
    check('webhook.list-no-url-or-secret', !listedText.includes(secretPath) && !listedText.includes('whsec_') && !listedText.includes('secret_id'), { url_label: (listed[0] as { url_label?: string })?.url_label })

    // 500 and slow endpoints (the slow one's test times out after 20 s).
    const e500 = await js<{ endpoint: { id: string }; test: { ok: boolean; httpStatusCode: number | null } }>(`return window.notula.webhooks.create({ url: '${fixture}/hook500', scope: 'my_notes_only', events: ['note.summarized'], includeTranscript: false })`)
    const eSlow = await js<{ endpoint: { id: string }; test: { ok: boolean; errorMessage: string | null } }>(`return window.notula.webhooks.create({ url: '${fixture}/hookslow', scope: 'my_notes_only', events: ['note.summarized'], includeTranscript: false })`)
    check('webhook.test-failures-reported', !e500.test.ok && e500.test.httpStatusCode === 500 && !eSlow.test.ok, { e500: e500.test, slow: eSlow.test })

    const gen = await note('Webhook generated call', ['pat@buyer.test'])
    await endMeeting(gen)
    const gotGenerated = await until(async () => (await hooks()).some((h) => h.path.includes(secretPath) && h.body.includes('"event_type":"note.summarized"') && h.body.includes(gen)), 20_000)
    const genHook = (await hooks()).find((h) => h.path.includes(secretPath) && h.body.includes(gen))
    check('webhook.note-generated-once-signed', gotGenerated && !!genHook && verify(genHook, genHook.body) && (await hooks()).filter((h) => h.path.includes(secretPath) && h.body.includes(gen)).length === 1, {
      payloadKeys: genHook ? Object.keys(JSON.parse(genHook.body) as object) : null
    })
    await until(async () => (await deliveries({ provider: 'webhook', noteId: gen, limit: 10 })).every((d) => !['pending', 'sending'].includes(d.status)), 40_000)
    const rows = await deliveries({ provider: 'webhook', noteId: gen, limit: 10 })
    const r500 = rows.find((d) => d.destinationId === e500.endpoint.id)
    const rSlow = rows.find((d) => d.destinationId === eSlow.endpoint.id)
    check('webhook.500-retried', r500?.status === 'failed' && !!r500.nextAttemptAt, { status: r500?.status, next: r500?.nextAttemptAt, code: r500?.errorCode })
    check('webhook.timeout-uncertain-not-retried', rSlow?.status === 'uncertain' && !rSlow.nextAttemptAt, { status: rSlow?.status })
    for (const id of [e500.endpoint.id, eSlow.endpoint.id]) await js(`return window.notula.webhooks.delete({ id: '${id}' })`)

    // Off, generate, on: nothing for that note.
    await js(`return window.notula.webhooks.update({ id: '${created.endpoint.id}', enabled: false })`)
    const offNote = await note('Webhook while off', ['pat@buyer.test'])
    await endMeeting(offNote)
    await sleep(3_000)
    await js(`return window.notula.webhooks.update({ id: '${created.endpoint.id}', enabled: true })`)
    await sleep(2_000)
    check('webhook.off-sends-nothing-later', !(await hooks()).some((h) => h.body.includes(offNote)) && !(await deliveries({ provider: 'webhook', noteId: offNote, limit: 10 })).length)

    // ---------- automations (predicates and actions) ----------
    const folders = async (): Promise<Awaited<ReturnType<MainContext['storage']['listFolders']>>> => ctx.storage.listFolders()
    const clients = await ctx.storage.createFolder({ title: 'Clients' })
    const ruleExternal = await js<{ id: string }>(
      `return window.notula.automations.save({ name: 'External to Clients', description: null, enabled: true, trigger: 'meeting_ended', predicates: [{ type: 'external', operator: 'include', selected_ids: [], config: { skip_shared_inboxes: true } }], actions: [{ type: 'file_in_folder', folder_id: '${clients.id}' }], confirm_sends: false })`
    )
    const ruleSensitive = await js<{ id: string }>(
      `return window.notula.automations.save({ name: 'Webhook all', description: null, enabled: true, trigger: 'meeting_ended', predicates: [{ type: 'all', operator: 'include', selected_ids: [] }], actions: [{ type: 'post_webhook', webhook_id: '${created.endpoint.id}' }], confirm_sends: false })`
    )
    const ext = await note('Call with a buyer', ['pat@buyer.test'])
    const intl = await note('Team sync', ['colleague@acme.test'])
    const gmail = await note('Coffee with a friend', ['friend@gmail.com'])
    const sens = await note('Sensitive review', ['colleague@acme.test'])
    await ctx.storage.setClassifierTags(sens, { meetingType: 'one_to_one', isSensitive: true })
    for (const n of [ext, intl, gmail, sens]) await endMeeting(n)
    automations()?.wake()
    await until(async () => (await ctx.storage.listAutomationRuns({ ruleId: ruleExternal.id, limit: 20 })).length >= 4, 30_000)
    const members = (await folders()).membership[clients.id] ?? []
    check('automation.external-files-only-external', members.includes(ext) && !members.includes(intl) && !members.includes(gmail), { members: members.length })
    const sensRun = (await ctx.storage.listAutomationRuns({ ruleId: ruleSensitive.id, noteId: sens, limit: 5 }))[0]
    check('automation.sensitive-waits', sensRun?.status === 'needs_confirmation' && !(await hooks()).some((h) => h.body.includes(sens) && h.body.includes('"automation"')), { status: sensRun?.status, reason: sensRun?.reason })
    if (sensRun) {
      const r = await js<{ status: string }>(`return window.notula.automations.resolveRun({ runId: '${sensRun.id}', choice: 'send' })`).catch((e: unknown) => ({ status: `error: ${String(e)}` }))
      const sent = await until(async () => (await hooks()).some((h) => h.body.includes(sens) && h.body.includes('"automation"')), 15_000)
      check('automation.confirmed-send-delivered', r.status === 'executed' && sent)
    }
    const runsBefore = (await ctx.storage.listAutomationRuns({ ruleId: ruleExternal.id, limit: 50 })).length
    automations()?.wake()
    await sleep(2_500)
    check('automation.once-only', (await ctx.storage.listAutomationRuns({ ruleId: ruleExternal.id, limit: 50 })).length === runsBefore)
    await js(`return window.notula.automations.delete({ id: '${ruleExternal.id}' })`)
    check('automation.delete-keeps-filed', ((await folders()).membership[clients.id] ?? []).includes(ext))
    await js(`return window.notula.automations.delete({ id: '${ruleSensitive.id}' })`)

    // ---------- Customer calls ----------
    const status = await js<{ enabled: boolean; folderId: string | null }>('return window.notula.customerCalls.enable()')
    const ccFolder = status.folderId ?? ''
    const sales = await note('Discovery call with Buyer', ['pat@buyer.test'])
    await ctx.storage.setClassifierTags(sales, { meetingType: 'sales', isSensitive: false })
    const internalSync = await note('Weekly internal sync', ['colleague@acme.test'])
    await ctx.storage.setClassifierTags(internalSync, { meetingType: 'team_sync', isSensitive: false })
    const sensSales = await note('Sensitive sales call', ['pat@buyer.test'])
    await ctx.storage.setClassifierTags(sensSales, { meetingType: 'sales', isSensitive: true })
    for (const n of [sales, internalSync, sensSales]) await endMeeting(n)
    automations()?.wake()
    await until(async () => ((await folders()).membership[ccFolder] ?? []).includes(sales), 30_000)
    await sleep(2_000)
    const cc1 = (await folders()).membership[ccFolder] ?? []
    check('customer-calls.sales-lands-once', status.enabled && cc1.filter((x) => x === sales).length === 1 && !cc1.includes(internalSync) && !cc1.includes(sensSales), { folderNotes: cc1.length })
    await js(`return window.notula.customerCalls.add({ noteIds: ['${sales}'], remove: true })`)
    automations()?.wake()
    await sleep(3_000)
    const backlog = await js<{ noteId: string }[]>('return window.notula.customerCalls.listBacklog({ days: 30 })')
    check('customer-calls.not-a-customer-call-stays-out', !((await folders()).membership[ccFolder] ?? []).includes(sales) && !backlog.some((b) => b.noteId === sales))

    // ---------- CRM plug-ins against the fixture ----------
    const crmNote = await note('Pricing call with Buyer Inc', ['pat@buyer.test', 'casey@cand.test'])
    await endMeeting(crmNote)
    await ctx.settings.set('integrations.salesforce.options', { eventHandling: 'create_new', eventBodySource: 'meeting_summary', eventWhatId: 'opportunity', contentNoteEnabled: true })
    await js(`await window.notula.integrations.setCredential({ provider: 'salesforce', kind: 'oauth-client', value: JSON.stringify({ key: '3MVG9fixtureConsumerKey0000000' }), label: 'https://acme.my.salesforce.com' }); return true`)
    const sfStatus = await js<{ state: string; accountLabel: string | null }>(`return window.notula.integrations.connectOAuth({ provider: 'salesforce' })`).catch((e: unknown) => ({ state: `error: ${String(e)}`, accountLabel: null }))
    check('salesforce.connect', sfStatus.state === 'connected', sfStatus)
    const sfResults = await js<{ kind: string; id: string; label: string }[]>(`return window.notula.integrations.search({ provider: 'salesforce', noteId: '${crmNote}' })`).catch(() => [])
    check('salesforce.suggestions', ['contact', 'account', 'opportunity'].every((k) => sfResults.some((r) => r.kind === k)), sfResults.map((r) => r.kind))
    const sfShare = await js<{ deliveryIds: string[] }>(`return window.notula.integrations.share({ provider: 'salesforce', noteId: '${crmNote}', panelId: null, targets: ${JSON.stringify(sfResults.map((r) => ({ kind: r.kind, id: r.id, label: r.label })))} })`).catch(() => ({ deliveryIds: [] }))
    await until(async () => (await deliveries({ provider: 'salesforce', noteId: crmNote, limit: 5 })).some((d) => d.status === 'sent' || d.status === 'failed'), 20_000)
    const sfRow = (await deliveries({ provider: 'salesforce', noteId: crmNote, limit: 5 }))[0]
    const st = await stats()
    check('salesforce.save-event-and-note', sfShare.deliveryIds.length === 1 && sfRow?.status === 'sent' && (st['/acme.my.salesforce.com/services/data/v60.0/sobjects/Event']?.count ?? 0) >= 1 && (st['/acme.my.salesforce.com/services/data/v60.0/sobjects/ContentNote']?.count ?? 0) >= 1, {
      status: sfRow?.status,
      error: sfRow?.errorMessage,
      externalUrl: sfRow?.externalUrl
    })

    await js(`return window.notula.integrations.setCredential({ provider: 'pipedrive', kind: 'pipedrive-token', value: 'pdFixtureToken000000000000000000', label: 'acme.pipedrive.com' })`).catch(() => null)
    const pd = await js<{ state: string; accountLabel: string | null }[]>(`return window.notula.integrations.validate({ provider: 'pipedrive' }).then((s) => [s])`).catch(() => [])
    const pdResults = await js<{ kind: string; id: string; label: string }[]>(`return window.notula.integrations.search({ provider: 'pipedrive', noteId: '${crmNote}' })`).catch(() => [])
    await js(`return window.notula.integrations.share({ provider: 'pipedrive', noteId: '${crmNote}', panelId: null, targets: ${JSON.stringify(pdResults.map((r) => ({ kind: r.kind, id: r.id, label: r.label })))} })`).catch(() => null)
    await until(async () => (await deliveries({ provider: 'pipedrive', noteId: crmNote, limit: 5 })).some((d) => d.status === 'sent' || d.status === 'failed'), 20_000)
    const pdRow = (await deliveries({ provider: 'pipedrive', noteId: crmNote, limit: 5 }))[0]
    const pdBody = (await stats())['/acme.pipedrive.com/api/v2/activities']?.last ?? ''
    check('pipedrive.connect-and-save-done-activity', pd[0]?.state === 'connected' && pdResults.some((r) => r.kind === 'person') && pdRow?.status === 'sent' && pdBody.includes('"done":true') && pdBody.includes('"type":"meeting"'), {
      label: pd[0]?.accountLabel,
      status: pdRow?.status,
      error: pdRow?.errorMessage
    })

    await js(`return window.notula.integrations.setCredential({ provider: 'ashby', kind: 'ashby-key', value: 'ashbyFixtureKey0000000000000' })`).catch(() => null)
    const asResults = await js<{ kind: string; id: string; label: string }[]>(`return window.notula.integrations.search({ provider: 'ashby', noteId: '${crmNote}' })`).catch(() => [])
    await js(`return window.notula.integrations.share({ provider: 'ashby', noteId: '${crmNote}', panelId: null, targets: ${JSON.stringify(asResults.map((r) => ({ kind: r.kind, id: r.id, label: r.label })))} })`).catch(() => null)
    await until(async () => (await deliveries({ provider: 'ashby', noteId: crmNote, limit: 5 })).some((d) => d.status === 'sent' || d.status === 'failed'), 20_000)
    const asRow = (await deliveries({ provider: 'ashby', noteId: crmNote, limit: 5 }))[0]
    const asBody = (await stats())['/api.ashbyhq.com/candidate.createNote']?.last ?? ''
    check('ashby.save-note-no-notify', asResults.some((r) => r.kind === 'candidate') && asRow?.status === 'sent' && asBody.includes('"sendNotifications":false') && asBody.includes('text/html'), { status: asRow?.status, error: asRow?.errorMessage })

    // Dropbox Connect through `integrations:connect-oauth`.
    await js(`return window.notula.integrations.setCredential({ provider: 'dropbox', kind: 'oauth-client', value: 'fixtureappkey123' })`).catch(() => null)
    const dbx = await js<{ state: string }>(`return window.notula.integrations.connectOAuth({ provider: 'dropbox' })`).catch((e: unknown) => ({ state: `error: ${String(e)}` }))
    check('dropbox.connect-via-row-469', dbx.state === 'connected', dbx)

    // ---------- Local-only ----------
    await ctx.settings.set('privacy.localOnly', true)
    await sleep(1_000)
    const loTest = await js<{ ok: boolean; errorMessage: string | null }>(`return window.notula.webhooks.test({ id: '${created.endpoint.id}' })`)
    const loShare = await js<string>(`return window.notula.integrations.share({ provider: 'salesforce', noteId: '${crmNote}', panelId: null, targets: [{ kind: 'contact', id: '003000000000001AAA', label: 'Pat' }] }).then(() => 'sent', (e) => String(e))`)
    const loFolder = await ctx.storage.createFolder({ title: 'Local-only folder' })
    const loRoute = await js<{ id: string }>(`return window.notula.automations.save({ name: 'LO route', description: null, enabled: true, trigger: 'meeting_ended', predicates: [{ type: 'all', operator: 'include', selected_ids: [] }], actions: [{ type: 'file_in_folder', folder_id: '${loFolder.id}' }], confirm_sends: false })`)
    const loHook = await js<{ id: string }>(`return window.notula.automations.save({ name: 'LO hook', description: null, enabled: true, trigger: 'meeting_ended', predicates: [{ type: 'all', operator: 'include', selected_ids: [] }], actions: [{ type: 'post_webhook', webhook_id: '${created.endpoint.id}' }], confirm_sends: false })`)
    const hooksBefore = (await hooks()).length
    const loNote = await note('Local-only meeting', ['pat@buyer.test'])
    await endMeeting(loNote)
    automations()?.wake()
    await until(async () => (await ctx.storage.listAutomationRuns({ noteId: loNote, limit: 10 })).length >= 2, 20_000)
    await sleep(2_000)
    const loRuns = await ctx.storage.listAutomationRuns({ noteId: loNote, limit: 10 })
    const loDeliveries = await deliveries({ provider: 'webhook', noteId: loNote, limit: 10 })
    check('local-only.webhooks-and-crm-blocked-folder-routes', !loTest.ok && /Local-only/i.test(loTest.errorMessage ?? '') && loShare !== 'sent' && (await hooks()).length === hooksBefore && loDeliveries.every((d) => d.status === 'pending') && ((await folders()).membership[loFolder.id] ?? []).includes(loNote) && loRuns.find((r) => r.rule_id === loHook.id)?.reason === 'local-only mode', {
      test: loTest.errorMessage,
      share: loShare.slice(0, 120),
      webhookRows: loDeliveries.map((d) => d.status),
      runs: loRuns.map((r) => [r.rule_id === loRoute.id ? 'route' : 'hook', r.status, r.reason])
    })
    await ctx.settings.set('privacy.localOnly', false)
    for (const id of [loRoute.id, loHook.id]) await js(`return window.notula.automations.delete({ id: '${id}' })`)

    // ---------- transcription rules ----------
    await ctx.settings.set('transcriptionRules.rules', [
      { id: 'wb-block-interview', enabled: true, action: 'block', condition: { type: 'event_name', match: 'contains', strings: ['interview'] }, presentation: { text: null, link: null } },
      { id: 'wb-confirm-external', enabled: true, action: 'confirm', condition: { type: 'has_outside_guest' }, presentation: { text: null, link: null } }
    ])
    const desired = (noteId: string): string => `window.notula.capture.setDesiredState({ capture: 'on', noteId: '${noteId}', requestedAt: new Date().toISOString(), language: 'en', keywords: [], asr: 'local' })`
    const interview = await note('Interview: Sam', ['colleague@acme.test'])
    await js(`${desired(interview)}; return true`)
    const blocked = await until(() => js<boolean>(`return window.__wb.stops.some((s) => s.reason === 'recording_rule') && window.__wb.decisions.some((d) => d.noteId === '${interview}' && d.outcome === 'block')`), 10_000)
    check('rules.block-start', blocked && !ctx.capture.isCapturing() && ctx.capture.heldStart() === null)

    // A held decision while locked waits for unlock.
    let locked = true
    const real = ctx.deviceLock
    ctx.deviceLock = { ...real, isLocked: () => locked }
    const ask = await note('Call with a prospect', ['pat@buyer.test'])
    await js(`window.__wb.decisions = []; ${desired(ask)}; return true`)
    await until(() => ctx.capture.heldStart()?.noteId === ask, 10_000)
    await sleep(2_500)
    const pushedWhileLocked = await js<number>('return window.__wb.decisions.length')
    const heldWhileLocked = ctx.capture.heldStart()
    locked = false
    const pushedAfter = await until(() => js<boolean>(`return window.__wb.decisions.some((d) => d.noteId === '${ask}' && d.outcome === 'confirm')`), 5_000)
    ctx.deviceLock = real
    const d = await js<{ decisionKey: string } | undefined>(`return window.__wb.decisions.find((d) => d.noteId === '${ask}')`)
    if (d) await js(`window.__wb.stops = []; return window.notula.transcriptionRules.resolve({ noteId: '${ask}', decisionKey: '${d.decisionKey}', choice: 'decline' })`)
    const declined = await until(() => js<boolean>(`return window.__wb.stops.some((s) => s.reason === 'start_cancelled')`), 5_000)
    check('rules.held-while-locked-waits-for-unlock', heldWhileLocked?.gateId === 'transcription-rules' && pushedWhileLocked === 0 && pushedAfter && declined && !ctx.capture.isCapturing() && ctx.capture.heldStart() === null, {
      pushedWhileLocked,
      held: heldWhileLocked
    })
    await ctx.settings.set('transcriptionRules.rules', [])

    // ---------- no secret in a log, a reply or the endpoints table ----------
    const needles = [secretPath, created.signingSecret, 'sf-access-token-fixture', 'sf-refresh-token-fixture', 'pdFixtureToken000000000000000000', 'ashbyFixtureKey0000000000000', 'dbx-access-fixture', 'dbx-refresh-fixture', '3MVG9fixtureConsumerKey0000000']
    const hits: string[] = []
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name)
        const s = statSync(p)
        if (s.isDirectory()) walk(p)
        else if (/\.(log|jsonl|txt|json)$/i.test(name) && name !== 'wb-harness.json' && s.size < 50_000_000) {
          const text = readFileSync(p, 'utf8')
          for (const n of needles) if (text.includes(n)) hits.push(`${name}: ${n.slice(0, 6)}…`)
        }
      }
    }
    walk(app.getPath('userData'))
    const eps = await ctx.storage.listWebhookEndpoints()
    check('secrets.none-in-logs-or-rows', hits.length === 0 && eps.every((e) => !e.url_label.includes('hook/')), { hits })
  } catch (err) {
    check('harness.error', false, err instanceof Error ? `${err.message}\n${err.stack ?? ''}`.slice(0, 1_500) : String(err))
  }
  out['finishedAt'] = new Date().toISOString()
  out['allOk'] = Object.values(out).every((v) => typeof v !== 'object' || v === null || (v as { ok?: boolean }).ok !== false)
  save()
  log('info', 'wb-harness:done', { allOk: out['allOk'] })
  setTimeout(() => app.quit(), 1_000)
}
