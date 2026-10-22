// SPDX-License-Identifier: Apache-2.0
// registerRecipes(): the `recipes:*` IPC and the built-in recipes. Handlers are registered
// with literal channels only. Built-ins are read-only; deletes are soft, so the 3 s Undo is
// `recipes:restore`. The chat send path calls into send.ts.
//
// Usage and saves: uses are counted by main inside the chat send path (no renderer channel);
// only built-ins can be saved into "My recipes".

import { ipcMain } from 'electron'
import { notulaError } from '@shared/errors'
import type { InvokeChannel, InvokeReq, InvokeRes, PushChannel } from '@shared/ipc'
import type { ChatContext } from '@shared/types/chat'
import {
  RECIPE_NAME_MAX,
  RECIPE_PROMPT_MAX,
  RECIPE_SLUG_PATTERN,
  type RecipeAdditionalContext,
  type RecipeConfig,
  type RecipeUpsert,
  type RecipeView
} from '@shared/types/recipes'
import type { MainContext } from '../context'
import { expected } from '../ipc-expected'
import { log } from '../log'
import { isBuiltinRecipeId } from './catalog'
import { allRecipes, forgetRecentRecipe } from './send'

export {
  allRecipes,
  findRecipe,
  isSingleMeetingView,
  parseRecipeInvocation,
  recipeAllowedIn,
  recipeUserTurn,
  recipeViewFor,
  recordRecipeUse,
  resolveRecipeSend,
  type RecipeInvocation,
  type RecipeSend
} from './send'

const VIEWS: readonly RecipeView[] = ['upcoming-meeting', 'live-meeting', 'meeting', 'multi-meeting']
const CONTEXTS: readonly RecipeAdditionalContext[] = ['past_meetings', 'upcoming_events', 'with_transcripts', 'web_search']
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** A stored slug may be longer than a new one (the limit applies to new names only). */
const MAX_SLUG = 200
const MAX_DESCRIPTION = 2_000
const MAX_MODEL = 200
const MAX_JSON = 200_000
/** The tables whose changes reach the renderer as `recipes:changed`. */
const RECIPE_TABLES = ['recipes', 'recipe_usage', 'recipe_saves']

function bad(message: string): Error {
  return expected(notulaError('invalid-input', message))
}

function recipeId(v: unknown): string {
  if (typeof v !== 'string' || !UUID.test(v)) throw bad('id is invalid.')
  return v.toLowerCase()
}

function jsonSized<T>(v: T, name: string): T {
  if (JSON.stringify(v ?? null).length > MAX_JSON) throw bad(`${name} is too large.`)
  return v
}

function parseConfig(raw: unknown): RecipeConfig {
  if (!raw || typeof raw !== 'object') throw bad('config is required.')
  const c = raw as Record<string, unknown>
  const instructions = c['instructions']
  if (typeof instructions !== 'string' || !instructions.trim()) throw bad('Write a prompt for this recipe.')
  if (instructions.length > RECIPE_PROMPT_MAX) throw bad(`The prompt can be at most ${RECIPE_PROMPT_MAX.toLocaleString('en-US')} characters.`)
  const out: RecipeConfig = {
    instructions,
    makes_artifact: c['makes_artifact'] === true,
    examples: Array.isArray(c['examples']) ? jsonSized(c['examples'], 'examples') : [],
    shared_tab_visible: c['shared_tab_visible'] === true
  }
  const description = c['description']
  if (typeof description === 'string' && description.trim()) {
    if (description.length > MAX_DESCRIPTION) throw bad('description is too long.')
    out.description = description
  }
  const model = c['model']
  if (typeof model === 'string' && model.trim()) {
    if (model.length > MAX_MODEL) throw bad('model is invalid.')
    out.model = model.trim()
  }
  const views = c['recipe_views']
  if (views !== undefined && views !== null) {
    if (!Array.isArray(views) || views.some((v) => !VIEWS.includes(v as RecipeView))) throw bad('recipe_views is invalid.')
    out.recipe_views = [...new Set(views as RecipeView[])]
  }
  const contexts = c['extra_context']
  if (contexts !== undefined && contexts !== null) {
    if (!Array.isArray(contexts) || contexts.some((v) => !CONTEXTS.includes(v as RecipeAdditionalContext))) {
      throw bad('extra_context is invalid.')
    }
    out.extra_context = [...new Set(contexts as RecipeAdditionalContext[])]
  }
  const priority = c['sort_rank']
  if (typeof priority === 'number' && Number.isFinite(priority)) out.sort_rank = priority
  return out
}

async function parseUpsert(ctx: MainContext, raw: unknown): Promise<RecipeUpsert> {
  const r = (raw ?? {}) as Partial<Record<keyof RecipeUpsert, unknown>>
  const id = r.id === undefined || r.id === null ? undefined : recipeId(r.id)
  if (id && isBuiltinRecipeId(id)) throw bad('Built-in recipes can’t be changed.')
  const slug = r.slug
  if (typeof slug !== 'string' || !slug || slug.length > MAX_SLUG || !RECIPE_SLUG_PATTERN.test(slug)) {
    throw bad('Use letters, numbers, - and _ for the recipe name.')
  }
  const existing = id ? await ctx.storage.getRecipe(id) : null
  // A new name may be at most 48 characters.
  if ((!existing || existing.slug !== slug) && slug.length > RECIPE_NAME_MAX) {
    throw bad(`Recipe name must be ${RECIPE_NAME_MAX} characters or fewer.`)
  }
  const out: RecipeUpsert = { slug, config: parseConfig(r.config) }
  if (id) out.id = id
  if (r.creation_context !== undefined) {
    if (r.creation_context !== null && typeof r.creation_context !== 'object') throw bad('creation_context is invalid.')
    out.creation_context = jsonSized(r.creation_context as ChatContext | null, 'creation_context')
  }
  if (r.source_recipe_id !== undefined) {
    out.source_recipe_id = r.source_recipe_id === null ? null : recipeId(r.source_recipe_id)
  }
  return out
}

export function registerRecipes(ctx: MainContext): void {
  ipcMain.handle('recipes:list' satisfies InvokeChannel, (): Promise<InvokeRes<'recipes:list'>> => allRecipes(ctx))

  ipcMain.handle(
    'recipes:upsert' satisfies InvokeChannel,
    async (_e, req: InvokeReq<'recipes:upsert'>): Promise<InvokeRes<'recipes:upsert'>> => {
      const recipe = await ctx.storage.upsertRecipe(await parseUpsert(ctx, req))
      log('info', 'recipes:saved', { id: recipe.id })
      return recipe
    }
  )

  ipcMain.handle('recipes:delete' satisfies InvokeChannel, async (_e, req: InvokeReq<'recipes:delete'>): Promise<void> => {
    const id = recipeId(req?.id)
    if (isBuiltinRecipeId(id)) throw bad('Built-in recipes can’t be deleted.')
    await ctx.storage.setRecipeDeleted(id, true)
    await forgetRecentRecipe(ctx, id)
    log('info', 'recipes:deleted', { id })
  })

  ipcMain.handle('recipes:restore' satisfies InvokeChannel, async (_e, req: InvokeReq<'recipes:restore'>): Promise<void> => {
    const id = recipeId(req?.id)
    if (isBuiltinRecipeId(id)) return
    await ctx.storage.setRecipeDeleted(id, false)
    log('info', 'recipes:restored', { id })
  })

  // ---------- usage and saves ----------

  ipcMain.handle('recipes:usage' satisfies InvokeChannel, (): Promise<InvokeRes<'recipes:usage'>> => ctx.storage.recipeUsage())

  ipcMain.handle('recipes:save' satisfies InvokeChannel, async (_e, req: InvokeReq<'recipes:save'>): Promise<void> => {
    const id = recipeId(req?.recipeId)
    // Until server sharing exists, only built-ins can be saved.
    if (!isBuiltinRecipeId(id)) throw bad('Only built-in recipes can be added to My recipes.')
    await ctx.storage.setRecipeSaved(id, true)
    // No telemetry: `shared_recipe_added` is a local debug line.
    log('debug', 'recipes:saved-to-mine', { id })
  })

  ipcMain.handle('recipes:unsave' satisfies InvokeChannel, async (_e, req: InvokeReq<'recipes:unsave'>): Promise<void> => {
    const id = recipeId(req?.recipeId)
    await ctx.storage.setRecipeSaved(id, false)
    log('debug', 'recipes:removed-from-mine', { id })
  })

  ctx.bus.on('storage:changed', (change) => {
    if (!change.tables.some((t) => RECIPE_TABLES.includes(t))) return
    const payload = { ids: change.ids }
    for (const wc of ctx.windows.targets()) wc.send('recipes:changed' satisfies PushChannel, payload)
  })
}
