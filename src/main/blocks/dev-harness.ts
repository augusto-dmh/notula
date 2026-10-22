// SPDX-License-Identifier: Apache-2.0
// Smoke harness for calendar writes, draft blocks, mail and file connectors. Dev only: unpackaged
// builds with `NOTULA_DEV_WA_HARNESS=1`, a scratch NOTULA_USER_DATA_DIR, and a local fixture server
// in both NOTULA_DEV_PROVIDER_MOCK and NOTULA_DEV_CALENDAR_MOCK (no real provider is ever called).
// It seeds two fake OAuth accounts, drives the real IPC from the main window, writes
// `<userData>/wa-harness.json` and leaves the app running for the caller to close.

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type { CalendarEventDraft } from '@shared/types/workflow-blocks'
import { writeClient, writeSourceSecret } from '../calendar/secrets'
import type { MainContext } from '../context'
import { log } from '../log'
import type { BlocksApi } from './index'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export async function runWaHarness(ctx: MainContext, blocks: BlocksApi): Promise<void> {
  const out: Record<string, unknown> = { startedAt: new Date().toISOString() }
  const file = join(app.getPath('userData'), 'wa-harness.json')
  const save = (): void => writeFileSync(file, JSON.stringify(out, null, 2))
  const check = (name: string, ok: boolean, detail?: unknown): void => {
    out[name] = { ok, ...(detail !== undefined ? { detail } : {}) }
    log('info', 'wa-harness:check', { name, ok })
    save()
  }
  const fixture = process.env['NOTULA_DEV_PROVIDER_MOCK'] ?? ''
  const stats = async (): Promise<Record<string, unknown>> => (await (await fetch(`${fixture}/__stats`)).json()) as Record<string, unknown>
  const until = async (fn: () => Promise<boolean> | boolean, ms: number, step = 500): Promise<boolean> => {
    for (let t = 0; t < ms; t += step) {
      if (await fn()) return true
      await sleep(step)
    }
    return false
  }

  try {
    await until(() => ctx.storage.identity().then(() => true).catch(() => false), 60_000)
    await until(() => !!ctx.windows.main() && !ctx.windows.main()?.webContents.isLoading(), 60_000)
    const wc = ctx.windows.main()?.webContents
    if (!wc) throw new Error('no main window')
    const js = async <T>(code: string): Promise<T> => (await wc.executeJavaScript(`(async () => { ${code} })()`, true)) as T
    const now = new Date().toISOString()
    for (const [k, v] of [
      ['onboarding.aiProvidersDoneAt', now],
      ['onboarding.calendarDoneAt', now],
      ['profile.email', 'me@example.com'],
      ['calendarWrite.enabled', true],
      ['mail.enabled', true],
      ['connectors.files.enabled', true]
    ] as const) {
      await ctx.settings.set(k as never, v as never)
    }

    // ---------- two fake OAuth accounts ----------
    await writeClient(ctx, 'google', { clientId: 'fixture-google-client' })
    await writeClient(ctx, 'microsoft', { clientId: 'fixture-ms-client' })
    const base = { myEmail: null, urlHost: null, insecure: false, status: 'ok' as const, errorType: null, lastSyncedAt: null, lastError: null, createdAt: now, httpEtag: null, httpLastModified: null, grants: [] }
    const G = 'wa-google-source'
    const M = 'wa-ms-source'
    await ctx.storage.upsertCalendarSource({ ...base, id: G, kind: 'google', label: 'me@example.com', accountEmail: 'me@example.com' })
    await ctx.storage.upsertCalendarSource({ ...base, id: M, kind: 'microsoft', label: 'me@contoso.com', accountEmail: 'me@contoso.com' })
    await ctx.storage.replaceCalendars(M, [{ id: `microsoft:${M}:mscal1`, sourceId: M, name: 'Calendar', color: null, primary: true, accessRole: 'owner' }], { visibleIds: [`microsoft:${M}:mscal1`] })
    const far = Date.now() + 3_600_000
    await writeSourceSecret(ctx, G, { kind: 'oauth', refreshToken: 'FAKE-REFRESH-seed-g', accessToken: 'ya29.FAKE-ACCESS-seed-g', expiresAt: far })
    await writeSourceSecret(ctx, M, { kind: 'oauth', refreshToken: 'FAKE-REFRESH-seed-m', accessToken: 'ya29.FAKE-ACCESS-seed-m', expiresAt: far })
    await ctx.storage.setCalendarSourceGrants(G, ['mail-read', 'mail-send', 'files-read'])
    await ctx.storage.setCalendarSourceGrants(M, ['calendar-write'])

    // ---------- setGrant runs the consent with the held grants + calendar-write ----------
    const granted = await js<{ grants: string[] }>(`return await window.notula.calendar.setGrant({ sourceId: '${G}', grant: 'calendar-write', enabled: true })`)
    const s1 = await stats()
    const auth = (s1['authorizeScopes'] as { scope: string; include: string | null; hint: string | null }[]).at(-1)
    check('e27-set-grant', granted.grants.includes('calendar-write') && granted.grants.includes('mail-read') && !!auth?.scope.includes('calendar.events') && auth?.include === 'true' && auth?.hint === 'me@example.com', { grants: granted.grants, auth })

    const draft = (summary: string): CalendarEventDraft => ({
      eventType: 'default',
      summary,
      timeOptions: [{ start: { dateTime: '2026-10-20T10:00:00-03:00', timeZone: 'America/Sao_Paulo' }, end: { dateTime: '2026-10-20T10:30:00-03:00', timeZone: 'America/Sao_Paulo' } }],
      conference: { kind: 'googleMeet' },
      attendees: [{ email: 'ana@example.org' }],
      description: '',
      addMeAsGuest: true,
      execution: null,
      dismissedAt: null
    })
    const exec = (id: string, extra = ''): Promise<{ block?: { execution: { status: string; errorCode?: string } | null }; failure: { errorCode: string } | null; stale?: true }> =>
      js(`const b = await window.notula.blocks.get({ blockId: '${id}' }); return await window.notula.blocks.execute({ blockId: b.id, type: b.type, expectedUpdatedAt: b.updated_at${extra} })`)

    // ---------- one event per card; timeout after send = unknown, never retried ----------
    const a = await blocks.create({ type: 'calendar_event', threadId: 'wa-thread', content: draft('Follow-up A') })
    const a1 = await exec(a.id, `, options: { targetSourceId: '${G}' }`)
    const a2 = await exec(a.id, `, options: { targetSourceId: '${G}' }`)
    const sA = await stats()
    const idA = a.id.replace(/-/g, '')
    check('calendar-create-twice-one-event', a1.block?.execution?.status === 'created' && a2.failure === null && (sA['inserts'] as Record<string, number>)[idA] === 1, { first: a1.block?.execution?.status, second: a2.block?.execution?.status, posts: (sA['inserts'] as Record<string, number>)[idA] })

    await fetch(`${fixture}/__hang-next-insert`)
    const b = await blocks.create({ type: 'calendar_event', threadId: 'wa-thread', content: draft('Follow-up B') })
    const b1 = await exec(b.id, `, options: { targetSourceId: '${G}' }`)
    const idB = b.id.replace(/-/g, '')
    await sleep(3_000)
    const sB = await stats()
    const postsAfterUnknown = (sB['inserts'] as Record<string, number>)[idB]
    const b2 = await exec(b.id, `, options: { targetSourceId: '${G}' }`)
    const sB2 = await stats()
    check('calendar-timeout-unknown-not-retried', b1.block?.execution?.status === 'unknown' && postsAfterUnknown === 1, { status: b1.block?.execution?.status, code: b1.block?.execution?.errorCode, postsAfterUnknown })
    check('calendar-try-again-same-event', b2.block?.execution?.status === 'created' && (sB2['events'] as string[]).filter((x) => x === idB).length === 1, { status: b2.block?.execution?.status, posts: (sB2['inserts'] as Record<string, number>)[idB] })

    const c = await blocks.create({ type: 'calendar_event', threadId: 'wa-thread', content: { ...draft('Weekly sync'), recurrenceRules: ['RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=TU;COUNT=5'] } })
    const c1 = await exec(c.id, `, options: { targetSourceId: '${M}' }`)
    const sC = await stats()
    const gc = (sC['graphCreates'] as { transactionId: string; recurrence: { range?: { numberOfOccurrences?: number } } | null }[]).at(-1)
    check('graph-create-transaction-id', c1.block?.execution?.status === 'created' && gc?.transactionId === c.id && gc?.recurrence?.range?.numberOfOccurrences === 5, { status: c1.block?.execution?.status, gc })

    // ---------- mail: a chat email card saves a draft and sends ----------
    const e = await blocks.create({ type: 'email', threadId: 'wa-thread', content: { to: ['ana@example.org'], cc: [], bcc: [], subject: 'Notes from today ✓', body: 'MAIL-BODY-MARKER line one' } })
    const e1 = await exec(e.id, `, options: { mode: 'draft' }`)
    const e2b = await blocks.create({ type: 'email', threadId: 'wa-thread', content: { to: ['ana@example.org'], cc: [], bcc: [], subject: 'Sent copy', body: 'MAIL-BODY-MARKER two' } })
    const e2 = await exec(e2b.id, `, options: { mode: 'send' }`)
    const sE = await stats()
    const head = (sE['drafts'] as { head: string; hasHtml: boolean; hasText: boolean }[])[0]
    check('mail-draft-and-send', e1.block?.execution?.status === 'created' && e2.block?.execution?.status === 'sent' && (sE['draftSends'] as number) === 1 && !!head?.head.includes('From: me@example.com') && !!head?.head.includes('=?UTF-8?B?') && !!head?.hasHtml && !!head?.hasText, { e1: e1.block?.execution?.status, e2: e2.block?.execution?.status, head: head?.head.split('\r\n').filter((l) => !l.startsWith('To:')) })
    const threads = await js<{ subject: string }[]>(`return await window.notula.mail.searchThreads({ query: 'pricing', max: 5 })`)
    check('mail-search', threads.length === 1 && threads[0]?.subject === 'Pricing follow-up', { n: threads.length })

    // ---------- files ----------
    const st = await js<{ connector: string; state: string }[]>(`return await window.notula.connectors.listFilesStatus()`)
    const found = await js<{ id: string }[]>(`return await window.notula.connectors.searchFiles({ connector: 'google_drive', query: 'plan', limit: 5 })`)
    const read = await js<{ text: string }>(`return await window.notula.connectors.readFile({ connector: 'google_drive', id: 'f1' })`)
    check('files-search-read', st.find((x) => x.connector === 'google_drive')?.state === 'connected' && found.length === 1 && read.text.startsWith('Q3 plan'), { st, n: found.length })

    // ---------- local-only blocks calendar writes, mail and file reads ----------
    await ctx.settings.set('privacy.localOnly' as never, true as never)
    await sleep(1_000)
    const before = ((await stats())['requests'] as string[]).length
    const f = await blocks.create({ type: 'calendar_event', threadId: 'wa-thread', content: draft('Blocked') })
    const f1 = await exec(f.id, `, options: { targetSourceId: '${G}' }`)
    const g = await blocks.create({ type: 'email', threadId: 'wa-thread', content: { to: ['ana@example.org'], cc: [], bcc: [], subject: 'x', body: 'y' } })
    const g1 = await exec(g.id, `, options: { mode: 'send' }`)
    const mailErr = await js<string>(`try { await window.notula.mail.searchThreads({ query: 'x', max: 1 }); return 'ok' } catch (e) { return String(e.message) }`)
    const fileErr = await js<string>(`try { await window.notula.connectors.searchFiles({ connector: 'google_drive', query: 'x', limit: 1 }); return 'ok' } catch (e) { return String(e.message) }`)
    const grantErr = await js<string>(`try { await window.notula.calendar.setGrant({ sourceId: '${G}', grant: 'files-read', enabled: false }); return 'ok' } catch (e) { return String(e.message) }`)
    const after = ((await stats())['requests'] as string[]).length
    check(
      'local-only-blocks',
      f1.block?.execution?.errorCode === 'local_only' && g1.block?.execution?.errorCode === 'local_only' && /Local-only|local-only/.test(mailErr) && /Local-only|local-only/.test(fileErr) && /local-only/.test(grantErr) && after === before,
      { calendar: f1.block?.execution?.errorCode, mail: g1.block?.execution?.errorCode, mailErr, fileErr, grantErr, requestsDuring: after - before }
    )
    await ctx.settings.set('privacy.localOnly' as never, false as never)

    // ---------- no token or mailbox content in the log or an IPC reply ----------
    await sleep(500)
    const logText = readFileSync(join(app.getPath('userData'), 'logs', 'app.log'), 'utf8')
    const replies = JSON.stringify(await js<unknown>(`return [await window.notula.mail.status(), await window.notula.calendar.sources(), await window.notula.blocks.list({ sourceType: 'chat_thread', sourceId: 'wa-thread' })]`))
    const leaks = ['FAKE-ACCESS', 'FAKE-REFRESH', 'fixture-code', 'MAIL-BODY-MARKER', 'Pricing follow-up', 'Q3 plan'].filter((m) => logText.includes(m))
    const replyLeaks = ['FAKE-ACCESS', 'FAKE-REFRESH', 'fixture-google-client'].filter((m) => replies.includes(m))
    check('no-secret-leak', leaks.length === 0 && replyLeaks.length === 0, { logLeaks: leaks, replyLeaks, logBytes: logText.length })
  } catch (err) {
    out['error'] = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
    save()
  }
  out['finishedAt'] = new Date().toISOString()
  save()
}
