// SPDX-License-Identifier: Apache-2.0
// The Salesforce, Pipedrive and Ashby plug-ins, and `integrations:connect-oauth` /
// `integrations:cancel-oauth`.
//
// - The plug-ins join the integration layer through the plug-in registry only while their Labs switch is
//   on: `integrations.salesforce.enabled` (Labs until verified on a Developer Edition org) and
//   `integrations.pipedriveAshby.enabled`. Off, the provider is unknown to the integrations IPC.
// - `integrations:connect-oauth` runs a plug-in's loopback flow in main (Salesforce here,
//   Dropbox from the file connectors) and replies with a fresh status; the cancel closes the listener.

import { ipcMain } from 'electron'
import { notulaError } from '@shared/errors'
import type { InvokeChannel, InvokeReq, InvokeRes, PushChannel } from '@shared/ipc'
import type { IntegrationStatus } from '@shared/types/integrations'
import { obj, onStorageReady } from '../automations/util'
import type { MainContext } from '../context'
import { expected } from '../ipc-expected'
import { log } from '../log'
import { egressBlocked } from '../privacy'
import { ashbyPlugin } from './ashby'
import { pipedrivePlugin } from './pipedrive'
import { salesforcePlugin } from './salesforce'

export function registerIntegrationsPlus(ctx: MainContext): void {
  const salesforce = salesforcePlugin()
  const pipedrive = pipedrivePlugin()
  const ashby = ashbyPlugin()
  const off: { salesforce: (() => void) | null; crm: (() => void)[] } = { salesforce: null, crm: [] }

  const pushChanged = (provider: string): void => {
    for (const wc of ctx.windows.targets()) wc.send('integrations:changed' satisfies PushChannel, { provider: provider as never })
  }

  async function apply(): Promise<void> {
    const s = await ctx.settings.getAll()
    if (s['integrations.salesforce.enabled'] && !off.salesforce) off.salesforce = ctx.integrationPlugins.register(salesforce)
    if (!s['integrations.salesforce.enabled'] && off.salesforce) {
      off.salesforce()
      off.salesforce = null
    }
    if (s['integrations.pipedriveAshby.enabled'] && !off.crm.length) off.crm = [ctx.integrationPlugins.register(pipedrive), ctx.integrationPlugins.register(ashby)]
    if (!s['integrations.pipedriveAshby.enabled'] && off.crm.length) {
      for (const f of off.crm) f()
      off.crm = []
    }
  }
  void apply().catch(() => undefined)
  onStorageReady(ctx, () => void apply().catch(() => undefined))
  ctx.bus.on('settings:changed', (c) => {
    if (c.keys.includes('integrations.salesforce.enabled') || c.keys.includes('integrations.pipedriveAshby.enabled')) {
      void apply().then(() => {
        pushChanged('salesforce')
        pushChanged('pipedrive')
        pushChanged('ashby')
      })
    }
  })

  ipcMain.handle('integrations:connect-oauth' satisfies InvokeChannel, async (_e, req: InvokeReq<'integrations:connect-oauth'>): Promise<InvokeRes<'integrations:connect-oauth'>> => {
    const provider = obj(req)['provider']
    if (provider !== 'salesforce' && provider !== 'dropbox') throw expected(notulaError('invalid-input', 'Unknown integration.'))
    const plugin = ctx.integrationPlugins.get(provider)
    if (!plugin?.connectOAuth) throw expected(notulaError('invalid-input', 'Turn this integration on in Labs first.'))
    if (await egressBlocked(ctx, { kind: 'integration' })) throw expected(notulaError('provider-error', 'Integrations are off while Local-only mode is on.'))
    log('info', 'integrations:oauth-start', { provider })
    await plugin.connectOAuth(ctx)
    const r = await plugin.validate(ctx).catch(() => ({ state: 'unreachable' as const, accountLabel: null, detail: null }))
    const status: IntegrationStatus = { provider, state: r.state, accountLabel: r.accountLabel, maskedCredential: null, lastValidatedAt: new Date().toISOString(), detail: r.detail, blockedByLocalOnly: false }
    pushChanged(provider)
    return status
  })

  ipcMain.handle('integrations:cancel-oauth' satisfies InvokeChannel, async (_e, req: InvokeReq<'integrations:cancel-oauth'>): Promise<void> => {
    const provider = obj(req)['provider']
    if (provider !== 'salesforce' && provider !== 'dropbox') return
    ctx.integrationPlugins.get(provider)?.cancelOAuth?.()
    log('info', 'integrations:oauth-cancelled', { provider })
  })
}
