// SPDX-License-Identifier: Apache-2.0
// The `recipes` table. Rows only: built-ins are
// shared constants that main merges into list results. Visibility stays `private`
// until a server exists; deletes are soft, so Undo is a restore.

import { randomUUID } from 'node:crypto'
import type { ChatContext } from '@shared/types/chat'
import type { Recipe, RecipeConfig, RecipeUpsert } from '@shared/types/recipes'
import { nowIso, parseJson } from './rows'
import { inTransaction, notFound, type StoreCtx } from './store'

const COLS = [
  'id',
  'workspace_id',
  'owner_id',
  'slug',
  'config',
  'visibility',
  'creation_context',
  'source_recipe_id',
  'created_at',
  'updated_at',
  'deleted_at'
].join(', ')

/** Whether the owner saved the recipe into "My recipes". */
const SAVED = `EXISTS (SELECT 1 FROM recipe_saves rs WHERE rs.recipe_id = recipes.id AND rs.owner_id = recipes.owner_id) AS saved`

type Row = Record<string, unknown>

const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null)

const EMPTY_CONFIG: RecipeConfig = { instructions: '', makes_artifact: false, examples: [], shared_tab_visible: false }

function toRecipe(r: Row): Recipe {
  const visibility = r['visibility']
  return {
    id: String(r['id']),
    slug: typeof r['slug'] === 'string' ? r['slug'] : '',
    owner_id: strOrNull(r['owner_id']),
    workspace_id: strOrNull(r['workspace_id']),
    config: { ...EMPTY_CONFIG, ...parseJson<Partial<RecipeConfig>>(r['config'], {}) },
    visibility: visibility === 'workspace' || visibility === 'public' ? visibility : 'private',
    creation_context: parseJson<ChatContext | null>(r['creation_context'], null),
    source_recipe_id: strOrNull(r['source_recipe_id']),
    is_builtin: false,
    saved: Number(r['saved'] ?? 0) === 1,
    created_at: String(r['created_at']),
    updated_at: String(r['updated_at']),
    deleted_at: strOrNull(r['deleted_at'])
  }
}

/** The owner's recipes that are not deleted, newest update first. */
export function listRecipes(s: StoreCtx): Recipe[] {
  const rows = s.db
    .prepare(`SELECT ${COLS}, ${SAVED} FROM recipes WHERE owner_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC, slug`)
    .all(s.identity.ownerId) as Row[]
  return rows.map(toRecipe)
}

/** A row by id, deleted ones included (Undo restores it). */
export function getRecipe(s: StoreCtx, id: string): Recipe | null {
  const row = s.db.prepare(`SELECT ${COLS}, ${SAVED} FROM recipes WHERE id = ?`).get(id) as Row | undefined
  return row ? toRecipe(row) : null
}

/** Inserts a new recipe, or replaces the slug and config of the owner's existing one. */
export function upsertRecipe(s: StoreCtx, r: RecipeUpsert): Recipe {
  const now = nowIso()
  const current = r.id ? getRecipe(s, r.id) : null
  if (current && current.owner_id !== s.identity.ownerId) throw notFound('recipe', current.id)
  if (current) {
    const params: Record<string, unknown> = { id: current.id, slug: r.slug, config: JSON.stringify(r.config), now }
    const sets = ['slug = @slug', 'config = @config', 'updated_at = @now']
    if (r.creation_context !== undefined) {
      sets.push('creation_context = @creation_context')
      params['creation_context'] = r.creation_context === null ? null : JSON.stringify(r.creation_context)
    }
    if (r.source_recipe_id !== undefined) {
      sets.push('source_recipe_id = @source_recipe_id')
      params['source_recipe_id'] = r.source_recipe_id
    }
    inTransaction(s.db, () => s.db.prepare(`UPDATE recipes SET ${sets.join(', ')} WHERE id = @id`).run(params))
    s.touch('recipes', current.id)
    return getRecipe(s, current.id) as Recipe
  }
  const id = r.id ?? randomUUID()
  inTransaction(s.db, () =>
    s.db
      .prepare(
        `INSERT INTO recipes (id, workspace_id, owner_id, slug, config, visibility, creation_context, source_recipe_id,
           created_at, updated_at, deleted_at)
         VALUES (@id, @workspace_id, @owner_id, @slug, @config, 'private', @creation_context, @source_recipe_id,
           @now, @now, NULL)`
      )
      .run({
        id,
        workspace_id: s.identity.workspaceId,
        owner_id: s.identity.ownerId,
        slug: r.slug,
        config: JSON.stringify(r.config),
        creation_context: r.creation_context ? JSON.stringify(r.creation_context) : null,
        source_recipe_id: r.source_recipe_id ?? null,
        now
      })
  )
  s.touch('recipes', id)
  return getRecipe(s, id) as Recipe
}

/**
 * Soft delete, or the Undo that clears it. `updated_at` is left alone, so an Undo puts
 * the recipe back exactly where it was in "newest update first" lists.
 */
export function setRecipeDeleted(s: StoreCtx, id: string, deleted: boolean): void {
  const current = getRecipe(s, id)
  if (!current || current.owner_id !== s.identity.ownerId) throw notFound('recipe', id)
  if ((current.deleted_at !== null) === deleted) return
  inTransaction(s.db, () => s.db.prepare(`UPDATE recipes SET deleted_at = ? WHERE id = ?`).run(deleted ? nowIso() : null, id))
  s.touch('recipes', id)
}
