// SPDX-License-Identifier: Apache-2.0
// Customer calls and their IPC.
//
// - Labs `customerCalls.enabled` (main-only). Enabling creates the "Customer calls" folder, stores it
//   in `customerCalls.folderId`, turns on `tags.classify` and enables the built-in rule
//   (CUSTOMER_CALLS_RULE_ID) on the automations loop, which works with `automations.enabled` off.
//   Deleting the folder turns the feature off; turning it on again creates a new folder.
// - The folder carries preset `client_meetings` and is found by
//   `customerCalls.folderId`.
// - Backlog: classified notes from the last 30 days that match the rule but are not in the folder.
//   With `classifyOlder`, up to 50 unclassified notes from
//   those days are classified first ("Check older notes").
// - Sync status: per note and bound provider from the delivery ledger; `sync`
//   sends the "Not synced" notes through `ctx.integrations.folderSend`, 100 at a
//   time, user-initiated.

import { ipcMain } from 'electron'
import { notulaError } from '@shared/errors'
import type { InvokeChannel, InvokeReq, InvokeRes } from '@shared/ipc'
import { CUSTOMER_CALLS, type CustomerCallsStatus, type CustomerCallsSyncStatus } from '@shared/types/customer-calls'
import type { IntegrationProvider } from '@shared/types/integrations'
import { automations, CUSTOMER_CALLS_RULE_ID } from '../automations'
import { bad, normDomain, normEmail, obj, onStorageReady } from '../automations/util'
import type { MainContext } from '../context'
import { expected } from '../ipc-expected'
import { log } from '../log'

const FOLDER_TITLE = 'Customer calls'
const MAX_EXCLUSIONS = 500
const DAY_MS = 86_400_000

export function registerCustomerCalls(ctx: MainContext): void {
  async function folderExists(id: string | null): Promise<boolean> {
    if (!id) return false
    return (await ctx.storage.listFolders()).folders.some((f) => f.id === id)
  }

  async function backlog(days: number): Promise<Awaited<ReturnType<MainContext['storage']['customerCallsBacklog']>>> {
    const s = await ctx.settings.getAll()
    const folderId = s['customerCalls.folderId']
    if (!s['customerCalls.enabled'] || !folderId) return []
    return ctx.storage.customerCallsBacklog({
      folderId,
      since: new Date(Date.now() - days * DAY_MS).toISOString(),
      excludedEmails: s['customerCalls.excludedEmails'],
      excludedDomains: s['customerCalls.excludedDomains']
    })
  }

  async function status(): Promise<CustomerCallsStatus> {
    const s = await ctx.settings.getAll()
    return {
      enabled: s['customerCalls.enabled'],
      folderId: s['customerCalls.folderId'],
      autoAdd: s['customerCalls.autoAdd'],
      excludedEmails: s['customerCalls.excludedEmails'],
      excludedDomains: s['customerCalls.excludedDomains'],
      backlogCount: s['customerCalls.enabled'] ? (await backlog(CUSTOMER_CALLS.backlogDays).catch(() => [])).length : 0
    }
  }

  async function setRule(folderId: string | null, enabled: boolean): Promise<void> {
    await ctx.storage.upsertAutomationRule({
      id: CUSTOMER_CALLS_RULE_ID,
      name: FOLDER_TITLE,
      description: null,
      enabled: enabled && !!folderId,
      trigger: 'meeting_ended',
      predicates: [{ type: 'classification', operator: 'include', selected_ids: [...CUSTOMER_CALLS.meetingTypes] }],
      actions: [{ type: 'file_in_folder', folder_id: folderId ?? '' }],
      confirm_sends: false
    })
  }

  async function turnOff(why: string, clearFolder: boolean): Promise<void> {
    await ctx.settings.set('customerCalls.enabled', false)
    if (clearFolder) await ctx.settings.set('customerCalls.folderId', null)
    await setRule(null, false).catch(() => undefined)
    log('info', 'customer-calls:off', { why })
  }

  // Deleting the folder turns the view off.
  onStorageReady(ctx, () => {
    ctx.bus.on('storage:changed', (c) => {
      if (!c.tables.includes('folders')) return
      void (async () => {
        const s = await ctx.settings.getAll()
        if (s['customerCalls.enabled'] && !(await folderExists(s['customerCalls.folderId']))) await turnOff('folder_deleted', true)
      })().catch(() => undefined)
    })
  })

  ipcMain.handle('customer-calls:status' satisfies InvokeChannel, (): Promise<InvokeRes<'customer-calls:status'>> => status())

  ipcMain.handle('customer-calls:enable' satisfies InvokeChannel, async (): Promise<InvokeRes<'customer-calls:enable'>> => {
    const s = await ctx.settings.getAll()
    let folderId = s['customerCalls.folderId']
    if (!(await folderExists(folderId))) {
      const f = await ctx.storage.createFolder({ title: FOLDER_TITLE, preset: 'client_meetings' })
      folderId = f.id
      await ctx.settings.set('customerCalls.folderId', folderId)
    }
    await ctx.settings.set('customerCalls.enabled', true)
    if (!s['tags.classify']) await ctx.settings.set('tags.classify', true)
    await setRule(folderId, true)
    log('info', 'customer-calls:on', { folderId })
    automations()?.wake()
    return status()
  })

  ipcMain.handle('customer-calls:disable' satisfies InvokeChannel, async (): Promise<InvokeRes<'customer-calls:disable'>> => {
    await turnOff('user', false)
    return status()
  })

  ipcMain.handle('customer-calls:set-exclusions' satisfies InvokeChannel, async (_e, req: InvokeReq<'customer-calls:set-exclusions'>): Promise<InvokeRes<'customer-calls:set-exclusions'>> => {
    const r = obj(req)
    const emails = [...new Set((Array.isArray(r['emails']) ? (r['emails'] as unknown[]) : []).map(normEmail))]
    const domains = [...new Set((Array.isArray(r['domains']) ? (r['domains'] as unknown[]) : []).map(normDomain))]
    if (emails.includes(null)) throw bad('Enter valid email addresses.')
    if (domains.includes(null)) throw bad('Enter valid company domains, like acme.com.')
    if (emails.length > MAX_EXCLUSIONS || domains.length > MAX_EXCLUSIONS) throw bad(`Up to ${MAX_EXCLUSIONS} people and ${MAX_EXCLUSIONS} companies.`)
    await ctx.settings.set('customerCalls.excludedEmails', emails as string[])
    await ctx.settings.set('customerCalls.excludedDomains', domains as string[])
    log('info', 'customer-calls:exclusions', { emails: emails.length, domains: domains.length })
    return status()
  })

  ipcMain.handle('customer-calls:list-backlog' satisfies InvokeChannel, async (_e, req: InvokeReq<'customer-calls:list-backlog'>): Promise<InvokeRes<'customer-calls:list-backlog'>> => {
    const r = obj(req)
    const days = Math.max(1, Math.min(365, Math.floor(Number(r['days']) || CUSTOMER_CALLS.backlogDays)))
    if (r['classifyOlder'] === true) {
      const since = new Date(Date.now() - days * DAY_MS).toISOString()
      const page = await ctx.storage.listNotes({ scope: 'own', limit: 500 })
      let n = 0
      for (const item of page.items) {
        if (n >= CUSTOMER_CALLS.classifyOlderMax) break
        if (item.created_at < since) continue
        const note = await ctx.storage.getNote(item.id)
        if (!note || note.tags.some((t) => t.category === 'meeting_kind')) continue
        n += 1
        await ctx.tags.classify(item.id).catch(() => [])
      }
      log('info', 'customer-calls:classified-older', { notes: n })
    }
    return backlog(days)
  })

  ipcMain.handle('customer-calls:add' satisfies InvokeChannel, async (_e, req: InvokeReq<'customer-calls:add'>): Promise<InvokeRes<'customer-calls:add'>> => {
    const s = await ctx.settings.getAll()
    const folderId = s['customerCalls.folderId']
    if (!s['customerCalls.enabled'] || !folderId) throw expected(notulaError('invalid-input', 'Turn on Customer calls first.'))
    const ids = [...new Set((Array.isArray(obj(req)['noteIds']) ? (obj(req)['noteIds'] as unknown[]) : []).filter((x): x is string => typeof x === 'string' && !!x))].slice(0, 200)
    if (!ids.length) return { added: 0, skipped: 0 }
    // With remove, take the notes out of the folder and clear their meeting type.
    if (obj(req)['remove'] === true) {
      for (const id of ids) await ctx.storage.removeNoteFromFolder(folderId, id).catch(() => undefined)
      await ctx.storage.setManualMeetingType(ids, null)
      log('info', 'customer-calls:removed', { notes: ids.length })
      return { added: 0, skipped: ids.length }
    }
    const added = await ctx.storage.addNotesToFolder(folderId, ids, 'add_notes')
    // Adding from this view sets the meeting type (step 3; manual).
    const untyped: string[] = []
    for (const id of ids) {
      const note = await ctx.storage.getNote(id)
      const t = note?.tags.find((x) => x.category === 'meeting_kind')?.value ?? null
      if (!t || !(CUSTOMER_CALLS.meetingTypes as readonly string[]).includes(t)) untyped.push(id)
    }
    if (untyped.length) await ctx.storage.setManualMeetingType(untyped, 'sales')
    log('info', 'customer-calls:added', { added, skipped: ids.length - added })
    return { added, skipped: ids.length - added }
  })

  ipcMain.handle('customer-calls:sync-status' satisfies InvokeChannel, async (_e, req: InvokeReq<'customer-calls:sync-status'>): Promise<InvokeRes<'customer-calls:sync-status'>> => {
    const r = obj(req)
    const folderId = await ctx.settings.get('customerCalls.folderId')
    if (!folderId) return []
    const noteIds = (Array.isArray(r['noteIds']) ? (r['noteIds'] as unknown[]) : []).filter((x): x is string => typeof x === 'string' && !!x).slice(0, 500)
    const bindings = (await ctx.storage.listIntegrationAutomations({ folderId })).filter((a) => a.enabled)
    const out: CustomerCallsSyncStatus[] = []
    for (const b of bindings) out.push(...(await ctx.storage.customerCallsSyncStatus({ noteIds, providers: [b.provider], since: b.updatedAt })))
    const sync = r['sync'] as IntegrationProvider | undefined
    if (typeof sync === 'string' && bindings.some((b) => b.provider === sync)) {
      const missing = out.filter((x) => x.provider === sync && x.state === 'not-synced').map((x) => x.noteId)
      for (let i = 0; i < missing.length; i += CUSTOMER_CALLS.syncBatch) {
        await ctx.integrations.folderSend({ provider: sync, folderId, noteIds: missing.slice(i, i + CUSTOMER_CALLS.syncBatch) })
      }
      log('info', 'customer-calls:sync', { provider: sync, notes: missing.length })
      const again: CustomerCallsSyncStatus[] = []
      for (const b of bindings) again.push(...(await ctx.storage.customerCallsSyncStatus({ noteIds, providers: [b.provider], since: b.updatedAt })))
      return again
    }
    return out
  })
}
