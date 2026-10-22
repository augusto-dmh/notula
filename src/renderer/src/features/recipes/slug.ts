// SPDX-License-Identifier: Apache-2.0
// Recipe names, views and ranking.

import Fuse from 'fuse.js'
import {
  RECIPE_SLUG_PATTERN,
  SINGLE_MEETING_VIEWS,
  type Recipe,
  type RecipeView
} from '@shared/types/recipes'
import { usageCount } from './store'

const SLUG_CHAR = /[\p{L}\p{N}_-]/u
const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true })

/** `-` and `_` become spaces and the first letter is upper-cased. */
export function displayName(slug: string): string {
  const s = slug.replace(/[-_]+/g, ' ').trim()
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : slug
}

/**
 * The slug as typed: a space becomes `-` (unless the name already ends with one)
 * and characters outside the slug pattern are rejected.
 */
export function sanitizeSlugInput(raw: string): string {
  let out = ''
  for (const ch of raw) {
    if (/\s/u.test(ch)) {
      if (out && !out.endsWith('-')) out += '-'
    } else if (SLUG_CHAR.test(ch)) {
      out += ch
    }
  }
  return out
}

export function isValidSlug(slug: string): boolean {
  return RECIPE_SLUG_PATTERN.test(slug)
}

export type MadeFor = 'single' | 'multi'

/** "Single meeting" → the three single-meeting views; "Multiple meetings" → `multi-meeting`. */
export function viewsFor(madeFor: MadeFor): RecipeView[] {
  return madeFor === 'single' ? [...SINGLE_MEETING_VIEWS] : ['multi-meeting']
}

export function madeForOf(views: readonly RecipeView[] | undefined): MadeFor | null {
  if (!views || views.length === 0) return null
  if (views.every((v) => v === 'multi-meeting')) return 'multi'
  if (views.every((v) => v !== 'multi-meeting')) return 'single'
  return null
}

/** A recipe with no views set is allowed everywhere. */
export function allowedIn(recipe: Recipe, view: RecipeView): boolean {
  const views = recipe.config.recipe_views
  return !views || views.length === 0 || views.includes(view)
}

/** Owner, publisher, workspace, unlisted, other. Notula: own, then the built-ins. */
function sourceRank(r: Recipe): number {
  if (!r.is_builtin) return 0
  if (r.visibility === 'public') return 1
  if (r.visibility === 'workspace') return 2
  return 3
}

/**
 * Higher `sort_rank` first; then own, publisher, workspace,
 * unlisted; then usage; then recipes made in
 * the same chat context; then by name.
 */
export function compareRecipes(a: Recipe, b: Recipe): number {
  return (
    (b.config.sort_rank ?? 0) - (a.config.sort_rank ?? 0) ||
    sourceRank(a) - sourceRank(b) ||
    usageCount(b.id) - usageCount(a.id) ||
    collator.compare(displayName(a.slug), displayName(b.slug))
  )
}

/** Fuzzy over the display name (0.4), the slug (0.1) and the description (0.2). */
export function searchRecipes(recipes: Recipe[], query: string, limit = 50): Recipe[] {
  const q = query.trim()
  if (!q) return recipes.slice(0, limit)
  const fuse = new Fuse(
    recipes.map((r) => ({ r, name: displayName(r.slug), slug: r.slug, description: r.config.description ?? '' })),
    {
      keys: [
        { name: 'name', weight: 0.4 },
        { name: 'slug', weight: 0.1 },
        { name: 'description', weight: 0.2 }
      ],
      threshold: 0.3,
      ignoreLocation: true
    }
  )
  return fuse
    .search(q)
    .slice(0, limit)
    .map((h) => h.item.r)
}

/** A leading `/<ref>` of a message; null when there is none. */
export function leadingRecipeRef(text: string): { ref: string; rest: string } | null {
  const m = /^\/([\p{L}\p{N}_-]+)(?=\s|$)/u.exec(text.trim())
  if (!m || !m[1]) return null
  return { ref: m[1], rest: text.trim().slice(m[0].length).trim() }
}
