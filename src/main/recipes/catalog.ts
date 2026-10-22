// SPDX-License-Identifier: Apache-2.0
// The built-in recipes: the two space-chat defaults
// (`open-todos`, `recap-recent`), read-only. Constants, never rows; the ids are fixed in the
// shared contract.

import { BUILTIN_RECIPE_IDS, type Recipe, type RecipeConfig } from '@shared/types/recipes'

type BuiltinSlug = keyof typeof BUILTIN_RECIPE_IDS

const CATALOG_DATE = '2026-10-01T00:00:00.000Z'

const CONFIGS: Record<BuiltinSlug, RecipeConfig> = {
  'open-todos': {
    instructions:
      'List the open to-dos from the meetings in this space, most recent meeting first. Use list_todos when it is available, and the meetings\' notes for anything it does not cover. ' +
      'Group them by meeting (title and date), one line per to-do with its owner and due date when stated; mark the ones that are the user\'s own. ' +
      'Leave out anything already done, and cite the meeting each to-do comes from.',
    description: 'The open to-dos from these meetings, grouped by meeting.',
    recipe_views: ['multi-meeting'],
    makes_artifact: false,
    examples: [],
    shared_tab_visible: false
  },
  'recap-recent': {
    instructions:
      'Bring the user up to date on the meetings in this space, newest first: for each, one or two lines on what happened, the decisions, and what changed since the meeting before. ' +
      'End with what needs the user\'s attention now (open questions, deadlines, their own next steps). Keep it short and cite each meeting.',
    description: 'A short digest of what happened and what needs you now.',
    recipe_views: ['multi-meeting'],
    makes_artifact: false,
    examples: [],
    shared_tab_visible: false
  }
}

const BUILTINS: readonly Recipe[] = Object.freeze(
  (Object.keys(CONFIGS) as BuiltinSlug[]).map(
    (slug): Recipe => ({
      id: BUILTIN_RECIPE_IDS[slug],
      slug,
      owner_id: null,
      workspace_id: null,
      config: CONFIGS[slug],
      visibility: 'public',
      creation_context: null,
      source_recipe_id: null,
      is_builtin: true,
      // Computed from `recipe_saves` by the caller.
      saved: false,
      created_at: CATALOG_DATE,
      updated_at: CATALOG_DATE,
      deleted_at: null
    })
  )
)
const BY_ID = new Map(BUILTINS.map((r) => [r.id, r]))

export function builtinRecipes(): Recipe[] {
  return BUILTINS.map((r) => structuredClone(r))
}

export function builtinRecipe(id: string): Recipe | null {
  const r = BY_ID.get(id.toLowerCase())
  return r ? structuredClone(r) : null
}

export function isBuiltinRecipeId(id: string): boolean {
  return BY_ID.has(id.toLowerCase())
}
