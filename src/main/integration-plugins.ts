// SPDX-License-Identifier: Apache-2.0
// The integration plug-in registry.
//
// The integration layer consults it for every provider it doesn't build in: status and validate,
// set-credential, search, share (the returned deliveries go into the layer's outbox), the outbox
// executor (`send()` inside the layer's request policy, token buckets and ledger), folder rules and
// disconnect. The plug-in modules
// register `salesforce`, `pipedrive`, `ashby`, `webhook`, `dropbox`, `gmail` and `outlook` at call
// time, never at module load. A plug-in never schedules or retries by itself.

import type {
  IntegrationAutomation,
  IntegrationCredentialInput,
  IntegrationCredentialKind,
  IntegrationDelivery,
  IntegrationProvider,
  IntegrationSearchQuery,
  IntegrationSearchResult,
  IntegrationShareRequest,
  IntegrationStatus
} from '@shared/types/integrations'
import type { MainContext } from './context'
import type { NewIntegrationDelivery } from './storage/api'

export type IntegrationSendOutcome =
  | { status: 'sent'; externalId?: string; externalUrl?: string; warnings?: string[] }
  | { status: 'failed'; retryable: boolean; errorCode: string; errorMessage: string }
  | { status: 'uncertain'; errorMessage: string }

export interface IntegrationPlugin {
  provider: IntegrationProvider
  credentialKinds: IntegrationCredentialKind[]
  validate(ctx: MainContext): Promise<Pick<IntegrationStatus, 'state' | 'accountLabel' | 'detail'>>
  /** Stores through ctx.secrets. */
  setCredential?(ctx: MainContext, input: IntegrationCredentialInput): Promise<void>
  connectOAuth?(ctx: MainContext): Promise<void>
  cancelOAuth?(): void
  search?(ctx: MainContext, q: IntegrationSearchQuery): Promise<IntegrationSearchResult[]>
  /** The deliveries to queue. */
  share?(ctx: MainContext, req: IntegrationShareRequest): Promise<NewIntegrationDelivery[]>
  /** The outbox executor. */
  send(ctx: MainContext, d: IntegrationDelivery, signal: AbortSignal): Promise<IntegrationSendOutcome>
  folderTargets?(ctx: MainContext, noteId: string, automation: IntegrationAutomation): Promise<NewIntegrationDelivery[]>
  disconnect(ctx: MainContext): Promise<void>
}

/** `ctx.integrationPlugins`. */
export interface IntegrationPluginsApi {
  /** Replaces an earlier plug-in for the same provider. Returns the unregister function. */
  register(p: IntegrationPlugin): () => void
  get(provider: IntegrationProvider): IntegrationPlugin | null
}

const plugins = new Map<IntegrationProvider, IntegrationPlugin>()

export function registerIntegrationPlugin(p: IntegrationPlugin): () => void {
  plugins.set(p.provider, p)
  return () => {
    if (plugins.get(p.provider) === p) plugins.delete(p.provider)
  }
}

export function getIntegrationPlugin(provider: IntegrationProvider): IntegrationPlugin | null {
  return plugins.get(provider) ?? null
}

/** The registry behind `ctx.integrationPlugins`. */
export const integrationPlugins: IntegrationPluginsApi = {
  register: registerIntegrationPlugin,
  get: getIntegrationPlugin
}
