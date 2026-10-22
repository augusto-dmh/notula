// SPDX-License-Identifier: Apache-2.0
// Recipes: saved chat prompts. Stored rows use the
// `recipes` column names; built-ins are shared constants, never rows.

import type { ChatContext } from './chat'
import type { IsoTime } from './common'

/** Where a recipe may run ("Made for"). */
export type RecipeView = 'upcoming-meeting' | 'live-meeting' | 'meeting' | 'multi-meeting'

export type RecipeAdditionalContext = 'past_meetings' | 'upcoming_events' | 'with_transcripts' | 'web_search'

export interface RecipeConfig {
  instructions: string
  description?: string
  /** A chat model id; overrides the chat selection for one message. */
  model?: string
  recipe_views?: RecipeView[]
  extra_context?: RecipeAdditionalContext[]
  makes_artifact: boolean
  examples: unknown[]
  shared_tab_visible: boolean
  sort_rank?: number
}

export interface Recipe {
  id: string
  slug: string
  /** null for a built-in. */
  owner_id: string | null
  /** null for a built-in. */
  workspace_id: string | null
  config: RecipeConfig
  visibility: 'private' | 'workspace' | 'public'
  creation_context: ChatContext | null
  source_recipe_id: string | null
  /** Set when merged into list results; never stored. */
  is_builtin: boolean
  /** Computed from `recipe_saves`. */
  saved: boolean
  created_at: IsoTime
  updated_at: IsoTime
  deleted_at: IsoTime | null
}

export interface RecipeUpsert {
  id?: string
  slug: string
  config: RecipeConfig
  creation_context?: ChatContext | null
  source_recipe_id?: string | null
}

export const RECIPE_SLUG_PATTERN = /^[\p{L}\p{N}_-]+$/u
export const RECIPE_NAME_MAX = 48
export const RECIPE_PROMPT_MAX = 50_000
/** `recipes.recent`: ids kept per view. */
export const RECIPE_RECENT_MAX = 5

export const SINGLE_MEETING_VIEWS: RecipeView[] = ['upcoming-meeting', 'live-meeting', 'meeting']

/** The built-ins' fixed ids. The content lives in src/main/recipes/catalog.ts. */
export const BUILTIN_RECIPE_IDS = {
  'open-todos': '21025151-eacf-4d98-a3fb-b7af230db295',
  'recap-recent': 'cedf6cd7-55e7-4184-b229-25181fbefa87'
} as const

// ---------- recipe usage ----------

/** `recipes:usage`: recipe id → its use count. */
export type RecipesUsage = Record<string, { total_count: number }>

/** The usage badge shows from this many uses. */
export const RECIPE_USAGE_BADGE_MIN = 5
