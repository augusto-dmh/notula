// SPDX-License-Identifier: Apache-2.0
// Running a recipe from chat: the main-side
// half that the chat engine calls. Notula has no server to resolve
// `/<recipe id>`, so the user turn sent to the model is built here from the recipe's
// instructions plus the text typed after the slug, while the stored and shown message
// keeps `/<slug> <text>` for the recipe chip and "Copy text".
//
// The chat send path, in order:
//   const run = await resolveRecipeSend(ctx, { text: req.text, recipeId: req.recipeId })
//   // run === null → an ordinary message
//   // store run.displayText as the user message's raw_text; send run.promptText as its
//   // model-facing content; run.model (when set) overrides the chat model selection;
//   // run.contexts feeds the context builder (`web_search` is ignored)
//   await recordRecipeUse(ctx, run.recipe.id, recipeViewFor(viewContext))
// Test recipe (`preview`): `recipeUserTurn(req.preview.recipe.config, '')`.

import {
  RECIPE_RECENT_MAX,
  RECIPE_SLUG_PATTERN,
  SINGLE_MEETING_VIEWS,
  type Recipe,
  type RecipeAdditionalContext,
  type RecipeConfig,
  type RecipeView
} from '@shared/types/recipes'
import type { ChatViewContext } from '@shared/types/chat'
import type { MainContext } from '../context'
import { log } from '../log'
import { builtinRecipe, builtinRecipes } from './catalog'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** `/<slug>` at the very start, then whitespace or the end. */
const INVOCATION = /^\/([\p{L}\p{N}_-]+)(?=\s|$)/u

export interface RecipeInvocation {
  /** The slug or id after the `/`. */
  ref: string
  /** The trimmed text after it; may be empty. */
  rest: string
}

export interface RecipeSend {
  recipe: Recipe
  rest: string
  /** What the message stores and shows: `/<slug>` plus the typed text. */
  displayText: string
  /** The model-facing user turn. */
  promptText: string
  /** The recipe's pinned chat model, or null for the chat's own selection. */
  model: string | null
  /** `extra_context` for the context builder; `web_search` is ignored until a web tool exists. */
  contexts: RecipeAdditionalContext[]
}

/** A leading `/<slug>` (or `/<id>`), else null. The text is trimmed first. */
export function parseRecipeInvocation(text: string): RecipeInvocation | null {
  const t = text.trim()
  const m = INVOCATION.exec(t)
  if (!m || !m[1]) return null
  return { ref: m[1], rest: t.slice(m[0].length).trim() }
}

/** The user's recipes (not deleted) and the built-ins, each built-in marked `saved` from `recipe_saves`. */
export async function allRecipes(ctx: MainContext): Promise<Recipe[]> {
  const [rows, saved] = await Promise.all([
    ctx.storage.listRecipes(),
    ctx.storage.listSavedRecipeIds().catch((err: unknown) => {
      log('warn', 'recipes:saved-read-failed', { err })
      return [] as string[]
    })
  ])
  return [...rows, ...builtinRecipes().map((r) => ({ ...r, saved: saved.includes(r.id) }))]
}

/**
 * A recipe by id or slug. Slugs match case-insensitively; when several share one, the
 * user's own wins over a built-in, then the newest update.
 */
export async function findRecipe(ctx: MainContext, ref: string): Promise<Recipe | null> {
  if (UUID.test(ref)) {
    const byId = builtinRecipe(ref) ?? (await ctx.storage.getRecipe(ref.toLowerCase()))
    if (byId && !byId.deleted_at) return byId
  }
  if (!RECIPE_SLUG_PATTERN.test(ref)) return null
  const key = ref.toLowerCase()
  const hits = (await allRecipes(ctx)).filter((r) => r.slug.toLowerCase() === key)
  hits.sort((a, b) => Number(a.is_builtin) - Number(b.is_builtin) || b.updated_at.localeCompare(a.updated_at))
  return hits[0] ?? null
}

/** The model-facing turn: the recipe's instructions, then what the user typed after the slug. */
export function recipeUserTurn(config: Pick<RecipeConfig, 'instructions'>, rest: string): string {
  const instructions = config.instructions.trim()
  const extra = rest.trim()
  return extra ? `${instructions}\n\nAdditional input from me:\n${extra}` : instructions
}

/**
 * The recipe is the explicitly picked one, else the one a leading
 * `/<slug>` names. Null when the message runs no recipe (or names an unknown one,
 * which is then sent as ordinary text).
 */
export async function resolveRecipeSend(
  ctx: MainContext,
  req: { text: string; recipeId: string | null }
): Promise<RecipeSend | null> {
  const parsed = parseRecipeInvocation(req.text)
  let recipe: Recipe | null = null
  if (req.recipeId) recipe = await findRecipe(ctx, req.recipeId)
  if (!recipe && parsed) recipe = await findRecipe(ctx, parsed.ref)
  if (!recipe) return null
  // The picked recipe's own `/slug` is not part of the user's text.
  const rest =
    parsed && (parsed.ref.toLowerCase() === recipe.slug.toLowerCase() || parsed.ref.toLowerCase() === recipe.id)
      ? parsed.rest
      : req.text.trim()
  return {
    recipe,
    rest,
    displayText: rest ? `/${recipe.slug} ${rest}` : `/${recipe.slug}`,
    promptText: recipeUserTurn(recipe.config, rest),
    model: recipe.config.model?.trim() || null,
    contexts: [...(recipe.config.extra_context ?? [])]
  }
}

/** The recipe view of a chat's context. */
export function recipeViewFor(view: ChatViewContext): RecipeView {
  if (view.view === 'live-meeting') return 'live-meeting'
  if (view.view === 'meeting') return view.isUpcoming ? 'upcoming-meeting' : 'meeting'
  return 'multi-meeting'
}

/** A recipe with no views set is allowed everywhere. */
export function recipeAllowedIn(recipe: Pick<Recipe, 'config'>, view: RecipeView): boolean {
  const views = recipe.config.recipe_views
  return !views || views.length === 0 || views.includes(view)
}

export function isSingleMeetingView(view: RecipeView): boolean {
  return SINGLE_MEETING_VIEWS.includes(view)
}

/**
 * One more use in `recipe_usage`, then the
 * recipe moves to the front of that view's "recent" list (≤ 5 per view). Both changes reach
 * the renderer as `recipes:changed` and `prefs:changed`.
 */
export async function recordRecipeUse(ctx: MainContext, recipeId: string, view: RecipeView): Promise<void> {
  try {
    const { total_count } = await ctx.storage.recordRecipeUse(recipeId)
    // No telemetry: the `recipe_used` event is a local debug line, never sent.
    log('debug', 'recipes:used', { recipeId, view, total: total_count })
  } catch (err) {
    log('warn', 'recipes:usage-save-failed', { recipeId, err })
  }
  try {
    const recent = { ...(await ctx.settings.get('recipes.recent')) }
    recent[view] = [recipeId, ...(recent[view] ?? []).filter((id) => id !== recipeId)].slice(0, RECIPE_RECENT_MAX)
    await ctx.settings.set('recipes.recent', recent)
  } catch (err) {
    log('warn', 'recipes:recent-save-failed', { recipeId, view, err })
  }
}

/** Deleting a recipe removes it from every "recent" list. */
export async function forgetRecentRecipe(ctx: MainContext, recipeId: string): Promise<void> {
  try {
    const recent = await ctx.settings.get('recipes.recent')
    let changed = false
    const next: typeof recent = {}
    for (const [view, ids] of Object.entries(recent) as [RecipeView, string[]][]) {
      const kept = ids.filter((id) => id !== recipeId)
      if (kept.length !== ids.length) changed = true
      next[view] = kept
    }
    if (changed) await ctx.settings.set('recipes.recent', next)
  } catch (err) {
    log('warn', 'recipes:recent-forget-failed', { recipeId, err })
  }
}
