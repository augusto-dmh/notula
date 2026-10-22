// SPDX-License-Identifier: Apache-2.0
// registerIntegrations(): Slack, Notion, HubSpot, Attio, Affinity and Zapier with the user's own credentials,
// the local scheduler and the delivery outbox; the `integrations:*` IPC.
// Handlers are registered with literal channels only. No reply carries a credential or a
// webhook URL: statuses and destinations hold masked values (`••••` + last 4).

import { app, ipcMain } from 'electron'
import { notulaError } from '@shared/errors'
import type { InvokeChannel, InvokeReq } from '@shared/ipc'
import type {
  IntegrationAutomation,
  IntegrationDelivery,
  IntegrationDestination,
  IntegrationProvider,
  IntegrationSearchResult,
  IntegrationStatus
} from '@shared/types/integrations'
import type { IntegrationsApi, MainContext } from '../context'
import { expected } from '../ipc-expected'
import { log } from '../log'
import { slackDraft } from './draft'
import { IntegrationsScheduler } from './scheduler'
import { IntegrationsService, LOCAL_ONLY_COPY, needAnyProvider, PROVIDERS } from './service'

const PLUGIN_PROVIDERS: readonly IntegrationProvider[] = ['salesforce', 'pipedrive', 'ashby', 'webhook', 'dropbox', 'gmail', 'outlook']

function obj(req: unknown): Record<string, unknown> {
  return req && typeof req === 'object' ? (req as Record<string, unknown>) : {}
}

export function registerIntegrations(ctx: MainContext): IntegrationsApi {
  const svc = new IntegrationsService(ctx)
  const scheduler = new IntegrationsScheduler(ctx, svc)

  ipcMain.handle('integrations:status' satisfies InvokeChannel, (_e, req: InvokeReq<'integrations:status'>): Promise<IntegrationStatus[]> => {
    const p = obj(req)['provider']
    return svc.statuses(p === undefined ? undefined : needAnyProvider(ctx, p))
  })

  ipcMain.handle('integrations:set-credential' satisfies InvokeChannel, (_e, req: InvokeReq<'integrations:set-credential'>): Promise<IntegrationStatus> =>
    svc.setCredential(req)
  )

  ipcMain.handle('integrations:remove-credential' satisfies InvokeChannel, async (_e, req: InvokeReq<'integrations:remove-credential'>): Promise<void> => {
    const r = obj(req)
    const id = r['destinationId']
    await svc.remove(needAnyProvider(ctx, r['provider']), typeof id === 'string' && id ? id : undefined)
  })

  ipcMain.handle('integrations:validate' satisfies InvokeChannel, (_e, req: InvokeReq<'integrations:validate'>): Promise<IntegrationStatus> =>
    svc.validate(needAnyProvider(ctx, obj(req)['provider']))
  )

  ipcMain.handle(
    'integrations:list-destinations' satisfies InvokeChannel,
    (_e, req: InvokeReq<'integrations:list-destinations'>): Promise<IntegrationDestination[]> => svc.listDestinations(needAnyProvider(ctx, obj(req)['provider']))
  )

  ipcMain.handle(
    'integrations:save-destination' satisfies InvokeChannel,
    (_e, req: InvokeReq<'integrations:save-destination'>): Promise<IntegrationDestination> => svc.saveDestination(req)
  )

  ipcMain.handle(
    'integrations:test-destination' satisfies InvokeChannel,
    (_e, req: InvokeReq<'integrations:test-destination'>): Promise<IntegrationDelivery> => svc.testDestination(String(obj(req)['destinationId'] ?? ''))
  )

  ipcMain.handle('integrations:search' satisfies InvokeChannel, (_e, req: InvokeReq<'integrations:search'>): Promise<IntegrationSearchResult[]> => svc.search(req))

  ipcMain.handle('integrations:share' satisfies InvokeChannel, (_e, req: InvokeReq<'integrations:share'>): Promise<{ deliveryIds: string[] }> => svc.share(req))

  ipcMain.handle(
    'integrations:list-automations' satisfies InvokeChannel,
    (_e, req: InvokeReq<'integrations:list-automations'>): Promise<IntegrationAutomation[]> => {
      const r = obj(req)
      const p = r['provider']
      return ctx.storage.listIntegrationAutomations({
        ...(typeof r['folderId'] === 'string' && r['folderId'] ? { folderId: r['folderId'] } : {}),
        ...(p !== undefined ? { provider: needAnyProvider(ctx, p) } : {})
      })
    }
  )

  ipcMain.handle(
    'integrations:set-automation' satisfies InvokeChannel,
    async (_e, req: InvokeReq<'integrations:set-automation'>): Promise<IntegrationAutomation> => {
      const r = obj(req)
      const p = needAnyProvider(ctx, r['provider'])
      // A plug-in takes folder rules when it maps a note to folder targets.
      const pluginFolder = !!svc.plugin(p)?.folderTargets
      if (p !== 'slack' && p !== 'zapier' && p !== 'attio' && !pluginFolder) throw expected(notulaError('invalid-input', 'This integration has no folder automation.'))
      const folderId = typeof r['folderId'] === 'string' ? r['folderId'] : ''
      if (!folderId) throw expected(notulaError('invalid-input', 'folderId is required.'))
      const destinationId = typeof r['destinationId'] === 'string' && r['destinationId'] ? r['destinationId'] : null
      if ((p === 'slack' || p === 'zapier') && !destinationId) throw expected(notulaError('invalid-input', 'Pick a destination for this folder.'))
      const options = obj(r['options'])
      const objectTypes = Array.isArray(options['objectTypes']) ? (options['objectTypes'] as unknown[]).filter((t): t is 'companies' | 'people' | 'deals' => t === 'companies' || t === 'people' || t === 'deals') : undefined
      const enabled = r['enabled'] === true
      if (p === 'slack' && enabled) {
        // One channel per folder: binding a new one replaces the previous binding.
        for (const old of await ctx.storage.listIntegrationAutomations({ folderId, provider: 'slack' })) {
          if (old.destinationId !== destinationId && old.enabled) await ctx.storage.upsertIntegrationAutomation({ id: old.id, folderId, provider: 'slack', destinationId: old.destinationId, enabled: false })
        }
      }
      const existing = p === 'slack' ? (await ctx.storage.listIntegrationAutomations({ folderId, provider: 'slack' })).find((a) => a.destinationId === destinationId) : undefined
      const a = await ctx.storage.upsertIntegrationAutomation({
        ...(existing ? { id: existing.id } : {}),
        folderId,
        provider: p,
        destinationId,
        ...(objectTypes ? { options: { objectTypes } } : {}),
        enabled
      })
      log('info', 'integrations:automation-set', { provider: p, automationId: a.id, enabled })
      svc.pushChanged(p)
      scheduler.wake()
      return a
    }
  )

  ipcMain.handle(
    'integrations:list-deliveries' satisfies InvokeChannel,
    (_e, req: InvokeReq<'integrations:list-deliveries'>): Promise<IntegrationDelivery[]> => {
      const r = obj(req)
      const p = r['provider']
      const limit = Math.max(1, Math.min(100, Math.floor(Number(r['limit']) || 20)))
      return ctx.storage.listIntegrationDeliveries({
        ...(p !== undefined ? { provider: needAnyProvider(ctx, p) } : {}),
        ...(typeof r['noteId'] === 'string' && r['noteId'] ? { noteId: r['noteId'] } : {}),
        limit
      })
    }
  )

  ipcMain.handle('integrations:retry-delivery' satisfies InvokeChannel, (_e, req: InvokeReq<'integrations:retry-delivery'>): Promise<IntegrationDelivery> =>
    svc.retry(String(obj(req)['deliveryId'] ?? ''))
  )

  ipcMain.handle('integrations:cancel-delivery' satisfies InvokeChannel, (_e, req: InvokeReq<'integrations:cancel-delivery'>): Promise<IntegrationDelivery> =>
    svc.cancel(String(obj(req)['deliveryId'] ?? ''))
  )

  ipcMain.handle('integrations:slack-draft' satisfies InvokeChannel, async (_e, req: InvokeReq<'integrations:slack-draft'>): Promise<{ text: string | null }> => {
    const r = obj(req)
    const noteId = typeof r['noteId'] === 'string' ? r['noteId'] : ''
    if (!noteId) throw expected(notulaError('invalid-input', 'noteId is required.'))
    return { text: await slackDraft(ctx, noteId, typeof r['panelText'] === 'string' ? r['panelText'] : '') }
  })

  // ---------- scheduler wiring ----------

  const start = (): void => {
    void scheduler.start().catch((err: unknown) => log('error', 'integrations:start-failed', { err: err instanceof Error ? err.name : 'error' }))
  }
  ctx.bus.on('storage:status', (s) => {
    if (s.state === 'ready') start()
  })
  void ctx.storage
    .status()
    .then((s) => {
      if (s.state === 'ready') start()
    })
    .catch(() => {})
  ctx.bus.on('enhance:completed', (e) => {
    if (e.ok) scheduler.wake()
  })
  ctx.bus.on('storage:changed', (c) => {
    if (c.tables.includes('folder_notes') || c.tables.includes('integration_automations')) scheduler.wake(Date.now() + 1_000)
  })
  ctx.bus.on('settings:changed', (c) => {
    if (c.keys.includes('privacy.localOnly')) {
      log('info', 'integrations:local-only', { on: c.settings['privacy.localOnly'], copy: c.settings['privacy.localOnly'] ? LOCAL_ONLY_COPY : null })
      for (const p of PROVIDERS) svc.pushChanged(p)
      // The plug-in providers' rows show the local-only state too.
      for (const p of PLUGIN_PROVIDERS) if (ctx.integrationPlugins.get(p)) svc.pushChanged(p)
      scheduler.wake()
    }
    if (c.keys.includes('integrations.zapier.folderRunIds')) scheduler.wake()
    if (c.keys.includes('integrations.slack.mode')) svc.pushChanged('slack')
  })
  app.on('before-quit', () => scheduler.stop())

  // The integration layer for main-side callers: built-in providers and registered plug-ins alike.
  return {
    share: (req) => svc.share(req),
    folderSend: (q) => svc.folderSend(q),
    status: (provider) => svc.status(provider)
  }
}
