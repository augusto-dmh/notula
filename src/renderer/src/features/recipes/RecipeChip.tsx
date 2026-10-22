// SPDX-License-Identifier: Apache-2.0
// The recipe chip on a sent chat message: the
// recipe's icon and display name for a leading `/<slug>` or `/<id>`; clicking it views
// the recipe. A reference that matches no recipe shows "/Unknown recipe".

import type { JSX } from 'react'
import { IconSlashTile } from './icons'
import { openModal } from './RecipeModal'
import { displayName } from './slug'
import { findRecipe, useRecipes } from './store'
import './recipes.css'

export function RecipeChipView({ recipeRef, onView }: { recipeRef: string; onView?(recipeId: string): void }): JSX.Element {
  const { recipes, loading } = useRecipes()
  const recipe = findRecipe(recipes, recipeRef)
  if (!recipe) {
    return (
      <span className="recipe-chip rcp-chip rcp-chip--unknown" title={loading ? undefined : 'This recipe no longer exists'}>
        <IconSlashTile size={16} />
        {loading ? `/${recipeRef}` : '/Unknown recipe'}
      </span>
    )
  }
  return (
    <button
      type="button"
      className="recipe-chip rcp-chip"
      title="View recipe"
      aria-label={`View recipe ${displayName(recipe.slug)}`}
      onClick={() => (onView ? onView(recipe.id) : openModal({ mode: 'view', recipeId: recipe.id }))}
    >
      <IconSlashTile size={16} />
      {displayName(recipe.slug)}
    </button>
  )
}
