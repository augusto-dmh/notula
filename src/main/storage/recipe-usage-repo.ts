// SPDX-License-Identifier: Apache-2.0
// Recipe usage and saves: `recipe_usage` and
// `recipe_saves`. Built-ins are not rows, so there is no FK; a soft-deleted recipe keeps
// its usage row, so Undo restores its count. Counts are the local user's runs.

import type { RecipesUsage } from '@shared/types/recipes'
import { nowIso } from './rows'
import { invalid, type StoreCtx } from './store'

const MAX_ID = 200

function recipeId(v: unknown): string {
  if (typeof v !== 'string' || !v.trim() || v.length > MAX_ID) throw invalid('recipeId is invalid')
  return v.trim().toLowerCase()
}

/** One more use: the count goes up and `last_used_at` moves to now. */
export function recordRecipeUse(s: StoreCtx, rawId: string): { total_count: number } {
  const id = recipeId(rawId)
  const now = nowIso()
  s.db
    .prepare(
      `INSERT INTO recipe_usage (recipe_id, workspace_id, owner_id, total_count, last_used_at, updated_at)
       VALUES (@id, @workspace, @owner, 1, @now, @now)
       ON CONFLICT (recipe_id, owner_id) DO UPDATE SET total_count = total_count + 1, last_used_at = @now, updated_at = @now`
    )
    .run({ id, workspace: s.identity.workspaceId, owner: s.identity.ownerId, now })
  const row = s.db.prepare(`SELECT total_count FROM recipe_usage WHERE recipe_id = ? AND owner_id = ?`).get(id, s.identity.ownerId) as
    | { total_count: number }
    | undefined
  s.touch('recipe_usage', id)
  return { total_count: Number(row?.total_count ?? 1) }
}

/** Recipe id → `{ total_count }`. */
export function recipeUsage(s: StoreCtx): RecipesUsage {
  const rows = s.db.prepare(`SELECT recipe_id, total_count FROM recipe_usage WHERE owner_id = ?`).all(s.identity.ownerId) as {
    recipe_id: string
    total_count: number
  }[]
  const out: RecipesUsage = {}
  for (const r of rows) out[r.recipe_id] = { total_count: Number(r.total_count) }
  return out
}

/** Add / Remove to "My recipes". Idempotent. */
export function setRecipeSaved(s: StoreCtx, rawId: string, saved: boolean): void {
  const id = recipeId(rawId)
  if (typeof saved !== 'boolean') throw invalid('saved must be a boolean')
  const r = saved
    ? s.db
        .prepare(`INSERT OR IGNORE INTO recipe_saves (recipe_id, workspace_id, owner_id, created_at) VALUES (?, ?, ?, ?)`)
        .run(id, s.identity.workspaceId, s.identity.ownerId, nowIso())
    : s.db.prepare(`DELETE FROM recipe_saves WHERE recipe_id = ? AND owner_id = ?`).run(id, s.identity.ownerId)
  if (r.changes > 0) s.touch('recipe_saves', id)
}

/** Newest save first. */
export function listSavedRecipeIds(s: StoreCtx): string[] {
  const rows = s.db
    .prepare(`SELECT recipe_id FROM recipe_saves WHERE owner_id = ? ORDER BY created_at DESC, recipe_id`)
    .all(s.identity.ownerId) as { recipe_id: string }[]
  return rows.map((r) => r.recipe_id)
}
