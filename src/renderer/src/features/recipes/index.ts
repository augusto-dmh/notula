// SPDX-License-Identifier: Apache-2.0
// Recipes in the renderer: the /recipes page, the recipe modal and its host, the `/`
// recipe menu and the recipe chip. This module holds the public signatures; the bodies
// live in the files below.
//
// For the chat composer: render <RecipeMenu view query onPick onCreate onClose/> while
// a leading "/" is typed (it takes ArrowUp/ArrowDown/Enter/Escape while mounted);
// `onCreate(slug)` → openRecipeModal({ mode: 'create', draft: { slug, creation_context } });
// "Save as recipe" → openRecipeModal({ mode: 'create', draft: { slug: '', config: {
// instructions: text, makes_artifact: false, examples: [], shared_tab_visible: false },
// creation_context } }). A sent message's leading `/<ref>` renders as <RecipeChip/>.

import { createElement, type JSX } from 'react'
import type { Recipe, RecipeUpsert, RecipeView } from '@shared/types/recipes'
import { RecipeChipView } from './RecipeChip'
import { RecipeMenuView } from './RecipeMenu'
import { ModalHost, openModal } from './RecipeModal'
import { RecipesPageView } from './RecipesPage'

export type RecipeModalOptions =
  | { mode: 'view' | 'edit'; recipeId: string }
  | { mode: 'create'; draft?: Partial<RecipeUpsert> }

export interface RecipeMenuProps {
  view: RecipeView
  query: string
  onPick(r: Recipe): void
  onCreate(prefillSlug: string): void
  onClose(): void
}

/** `/recipes`. */
export function RecipesPage(): JSX.Element {
  return createElement(RecipesPageView)
}

/** Mounted once in App; hosts the recipe modal. */
export function RecipeModalHost(): JSX.Element | null {
  return createElement(ModalHost)
}

export function openRecipeModal(opts: RecipeModalOptions): void {
  openModal(opts)
}

export function RecipeMenu(p: RecipeMenuProps): JSX.Element {
  return createElement(RecipeMenuView, p)
}

/** `recipeRef` is a slug or an id; an unknown one shows "/Unknown recipe". */
export function RecipeChip(p: { recipeRef: string; onView?(recipeId: string): void }): JSX.Element {
  return createElement(RecipeChipView, p)
}

// Helpers for chat's composer and message rendering.
export { allowedIn, displayName as recipeDisplayName, leadingRecipeRef } from './slug'
