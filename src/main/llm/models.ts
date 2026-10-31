// SPDX-License-Identifier: Apache-2.0
// Chat model resolution: a recipe model wins
// over the chat selection (`chat.model.single` / `chat.model.multi`); aliases apply
// (`MODEL_ALIASES`), then a model the provider no longer lists falls back to Auto
// (the provider's settings model), and the stored selection is rewritten to `auto`.
// Summaries, titles and meeting-end-check never use this: they keep the settings model.
// Also the Gemini preset's model pick when its key is saved (`pickGeminiModel`).

import {
  CHAT_MODEL_AUTO,
  GEMINI_PRESET,
  isGeminiBaseUrl,
  MODEL_ALIASES,
  newestFlashModel,
  type LlmProviderId
} from '@shared/types/enhance'
import type { Settings } from '@shared/types/settings'
import type { MainContext } from '../context'
import { log } from '../log'
import { buildProvider, LLM_PROVIDERS } from './registry'

export interface ResolvedChatModel {
  provider: LlmProviderId
  /** The model id to send ('' when the provider has none configured). */
  model: string
  /** True when the result is the provider's settings model (Auto, or a fallback to it). */
  auto: boolean
}

/** The provider's model list is cached for one hour. */
const LIST_TTL_MS = 3_600_000
/** A failed listing is retried after a minute, not on every message. */
const LIST_FAILURE_TTL_MS = 60_000
const LIST_TIMEOUT_MS = 8_000

const listCache = new Map<string, { at: number; ttl: number; models: string[] | null }>()

function settingsModel(s: Settings): string {
  const provider = s['llm.provider']
  if (provider === 'anthropic') return s['llm.anthropic.model']
  if (provider === 'openai') return s['llm.openai.model']
  return s['llm.local.model']
}

function providerOf(s: Settings): LlmProviderId {
  return LLM_PROVIDERS.includes(s['llm.provider']) ? s['llm.provider'] : 'anthropic'
}

function alias(model: string): string {
  return MODEL_ALIASES[model] ?? model
}

/** For a selection, '' or `auto` is Auto; anything else is its alias or itself. */
export function normalizeSelection(value: string | null | undefined): string {
  const v = (value ?? '').trim()
  return v === '' || v === CHAT_MODEL_AUTO ? CHAT_MODEL_AUTO : alias(v)
}

/** For a recipe, '' is "no model" (the selection applies). */
export function normalizeRecipeModel(value: string | null | undefined): string | null {
  const v = (value ?? '').trim()
  return v === '' || v === CHAT_MODEL_AUTO ? null : alias(v)
}

/**
 * The models the active provider lists, or null when the list can't disprove a model
 * (the request failed, or an OpenAI-compatible server lists nothing).
 */
async function listedModels(ctx: Pick<MainContext, 'settings' | 'secrets'>, s: Settings): Promise<string[] | null> {
  const provider = providerOf(s)
  const key = `${provider}|${provider === 'openai' ? s['llm.openai.baseUrl'] : provider === 'local' ? s['llm.local.baseUrl'] : ''}`
  const hit = listCache.get(key)
  if (hit && Date.now() - hit.at < hit.ttl) return hit.models
  try {
    const models = await buildProvider(provider, s, ctx.secrets).listModels(AbortSignal.timeout(LIST_TIMEOUT_MS))
    const value = models.length > 0 ? models : null
    listCache.set(key, { at: Date.now(), ttl: LIST_TTL_MS, models: value })
    return value
  } catch (err) {
    log('debug', 'chat:model-list-unavailable', { provider, err: err instanceof Error ? err.message : String(err) })
    listCache.set(key, { at: Date.now(), ttl: LIST_FAILURE_TTL_MS, models: null })
    return null
  }
}

export async function resolveChatModel(
  ctx: Pick<MainContext, 'settings' | 'secrets'>,
  opts: { kind: 'single' | 'multi'; recipeModel?: string | null }
): Promise<ResolvedChatModel> {
  const s = await ctx.settings.getAll()
  const provider = providerOf(s)
  const auto = settingsModel(s)
  const recipe = normalizeRecipeModel(opts.recipeModel)
  const key = opts.kind === 'single' ? 'chat.model.single' : 'chat.model.multi'
  const selection = normalizeSelection(s[key])
  const wanted = recipe ?? (selection === CHAT_MODEL_AUTO ? null : selection)
  if (!wanted || wanted === auto) return { provider, model: auto, auto: true }

  const listed = await listedModels(ctx, s)
  if (listed === null || listed.includes(wanted)) return { provider, model: wanted, auto: false }

  // A model the provider no longer lists is Auto.
  log('debug', 'chat:model-fallback', { provider, kind: opts.kind, model: wanted, source: recipe ? 'recipe' : 'selection' })
  if (!recipe) {
    await ctx.settings
      .set(key, CHAT_MODEL_AUTO)
      .catch((err: unknown) => log('warn', 'chat:model-reset-failed', { key, err }))
  }
  return { provider, model: auto, auto: true }
}

/**
 * After a Gemini key is saved: the newest Flash the key lists, unless the user chose a
 * model that is still listed. The preset's model doesn't count as a choice, since setup
 * writes it before any list can be read; it stays only when the list can't be read.
 */
export async function pickGeminiModel(ctx: Pick<MainContext, 'settings' | 'secrets'>): Promise<void> {
  const s = await ctx.settings.getAll()
  if (!isGeminiBaseUrl(s['llm.openai.baseUrl'])) return
  const current = s['llm.openai.model'].trim()
  let listed: string[]
  try {
    listed = await buildProvider('openai', s, ctx.secrets).listModels(AbortSignal.timeout(LIST_TIMEOUT_MS))
  } catch (err) {
    log('info', 'llm:model-pick-unavailable', { err: err instanceof Error ? err.message : String(err) })
    if (!current) await ctx.settings.set('llm.openai.model', GEMINI_PRESET.model)
    return
  }
  if (current && current !== GEMINI_PRESET.model && listed.includes(current)) return
  const newest = newestFlashModel(listed) ?? (current || GEMINI_PRESET.model)
  if (newest === current) return
  await ctx.settings.set('llm.openai.model', newest)
  log('info', 'llm:model-picked', { model: newest, previous: current || null })
}

/** Drops the cached lists (a provider, key or base URL changed). */
export function forgetModelLists(): void {
  listCache.clear()
}
