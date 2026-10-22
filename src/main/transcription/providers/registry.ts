// SPDX-License-Identifier: Apache-2.0
// The AsrProviderRegistry: `asr.provider` picks the primary; failover
// candidates are the other providers the user has configured, plus the local
// engine once its model is installed and covers the language.

import type { AsrProviderId } from '@shared/types/transcript'
import type { LocalModelManager } from '../../asr/models'
import type { SecretsApi, SettingsApi } from '../../context'
import { createAssemblyAiProvider } from './assemblyai'
import { createDeepgramProvider } from './deepgram'
import { createLocalProvider } from './local'
import type { AsrProvider } from './types'

export type AsrRegistry = Record<AsrProviderId, AsrProvider>

export function createAsrRegistry(deps: { secrets: SecretsApi; settings: SettingsApi; models: LocalModelManager }): AsrRegistry {
  return {
    deepgram: createDeepgramProvider(deps),
    assemblyai: createAssemblyAiProvider(deps),
    local: createLocalProvider({ models: deps.models, settings: deps.settings })
  }
}

const ORDER: AsrProviderId[] = ['deepgram', 'assemblyai', 'local']

/** The primary first, then every other available provider. */
export async function providerChain(
  registry: AsrRegistry,
  primary: AsrProviderId,
  language: string
): Promise<{ chain: AsrProviderId[]; primaryUnavailable: string | null }> {
  const chain: AsrProviderId[] = []
  let primaryUnavailable: string | null = null
  for (const id of [primary, ...ORDER.filter((p) => p !== primary)]) {
    const a = await registry[id].available(language)
    if (a.ok) chain.push(id)
    else if (id === primary) primaryUnavailable = a.reason
  }
  return { chain, primaryUnavailable }
}

/** How many times a source may fail over away from each provider. */
export const FAILOVER_BUDGET: Record<AsrProviderId, number> = {
  assemblyai: 3,
  deepgram: Number.POSITIVE_INFINITY,
  local: Number.POSITIVE_INFINITY
}
