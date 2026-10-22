// SPDX-License-Identifier: Apache-2.0
// LlmProviderRegistry: settings 'llm.provider' picks the provider; its
// model and base URL come from settings, its key from the secrets store. Providers are
// built per request, so a settings or key change applies to the next call.
//
// The OpenAI-compatible providers read "This model accepts images", and a
// cloud provider built while local-only mode is on refuses every network call (the
// guard in privacy.ts). Every LLM call in Notula is built here.

import type { CloudLlmProviderId, LlmProviderId } from '@shared/types/enhance'
import type { SecretId, Settings } from '@shared/types/settings'
import type { SecretsApi, SettingsApi } from '../context'
import { enhanceError } from '../enhance/errors'
import { log } from '../log'
import { isLoopbackUrl } from '../net/loopback'
import { egressBlocked, LOCAL_ONLY_REASON } from '../privacy'
import { createAnthropicProvider } from './anthropic'
import { createOpenAiCompatibleProvider } from './openai-compatible'
import type { LlmChatEvent, LlmProvider, LlmStreamEvent } from './types'

export const LLM_PROVIDERS: readonly LlmProviderId[] = ['anthropic', 'openai', 'local']
export const CLOUD_LLM_PROVIDERS: readonly CloudLlmProviderId[] = ['anthropic', 'openai']

export function llmSecretId(provider: CloudLlmProviderId): SecretId {
  return provider === 'anthropic' ? 'llm.anthropic' : 'llm.openai'
}

export function buildProvider(id: LlmProviderId, settings: Settings, secrets: SecretsApi): LlmProvider {
  const p = localOnlyGuard(id, settings, rawProvider(id, settings, secrets))
  return id === 'local' && isLoopbackUrl(settings['llm.local.baseUrl']) ? p : abortableOnLocalOnly(p)
}

// ---------- turning local-only on stops in-flight non-local requests ----------

let localOnlyStop = new AbortController()

/** index.ts, on `settings:changed` with `privacy.localOnly` true. */
export function abortNonLocalLlmRequests(): void {
  const c = localOnlyStop
  localOnlyStop = new AbortController()
  c.abort(enhanceError('provider-error', 'Stopped: Nothing leaves this machine is on'))
}

function abortableOnLocalOnly(p: LlmProvider): LlmProvider {
  const join = (signal: AbortSignal): AbortSignal => AbortSignal.any([signal, localOnlyStop.signal])
  return {
    id: p.id,
    model: p.model,
    available: () => p.available(),
    stream: (req, signal, onActivity) => p.stream(req, join(signal), onActivity),
    complete: (req, signal) => p.complete(req, join(signal)),
    listModels: (signal) => p.listModels(join(signal)),
    test: (signal) => p.test(join(signal)),
    chat: (req, signal, onActivity) => p.chat(req, join(signal), onActivity),
    contextWindow: () => p.contextWindow(),
    acceptsImages: () => p.acceptsImages()
  }
}

function rawProvider(id: LlmProviderId, settings: Settings, secrets: SecretsApi): LlmProvider {
  switch (id) {
    case 'anthropic':
      return createAnthropicProvider({
        model: settings['llm.anthropic.model'],
        getKey: () => secrets.get('llm.anthropic')
      })
    case 'openai':
      return createOpenAiCompatibleProvider({
        id: 'openai',
        baseUrl: settings['llm.openai.baseUrl'],
        model: settings['llm.openai.model'],
        getKey: () => secrets.get('llm.openai'),
        acceptsImages: settings['llm.openai.acceptsImages'] === true
      })
    case 'local':
      return createOpenAiCompatibleProvider({
        id: 'local',
        baseUrl: settings['llm.local.baseUrl'],
        model: settings['llm.local.model'],
        getKey: null,
        acceptsImages: settings['llm.local.acceptsImages'] === true
      })
  }
}

/**
 * Local-only mode: the provider being built stands in for `llm.provider`, so a
 * key test of a cloud provider is blocked too, not only the selected one.
 */
function localOnlyGuard(id: LlmProviderId, settings: Settings, p: LlmProvider): LlmProvider {
  if (id === 'local' || settings['privacy.localOnly'] !== true) return p
  const snapshot: Settings = { ...settings, 'llm.provider': id }
  const view: SettingsApi = {
    getAll: async () => snapshot,
    get: async (key) => snapshot[key],
    set: () => Promise.reject(new Error('read-only settings view'))
  }
  const gate = async (): Promise<void> => {
    if (!(await egressBlocked({ settings: view }, { kind: 'llm' }))) return
    log('info', 'llm:blocked', { provider: id, reason: LOCAL_ONLY_REASON })
    throw enhanceError('provider-error', 'Local-only mode is on, so Notula sends nothing to a cloud AI provider. Choose the local model in Settings ▸ AI.')
  }
  return {
    id: p.id,
    model: p.model,
    available: () => p.available(),
    async *stream(req, signal, onActivity): AsyncIterable<LlmStreamEvent> {
      await gate()
      yield* p.stream(req, signal, onActivity)
    },
    complete: async (req, signal) => {
      await gate()
      return p.complete(req, signal)
    },
    listModels: async (signal) => {
      await gate()
      return p.listModels(signal)
    },
    test: async (signal) => {
      await gate()
      return p.test(signal)
    },
    async *chat(req, signal, onActivity): AsyncIterable<LlmChatEvent> {
      await gate()
      yield* p.chat(req, signal, onActivity)
    },
    contextWindow: async () => ((await egressBlocked({ settings: view }, { kind: 'llm' })) ? null : p.contextWindow()),
    acceptsImages: () => p.acceptsImages()
  }
}

/** The provider the user selected. */
export async function currentProvider(settings: SettingsApi, secrets: SecretsApi): Promise<LlmProvider> {
  const all = await settings.getAll()
  const id = LLM_PROVIDERS.includes(all['llm.provider']) ? all['llm.provider'] : 'anthropic'
  return buildProvider(id, all, secrets)
}
