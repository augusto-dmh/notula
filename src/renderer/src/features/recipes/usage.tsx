// SPDX-License-Identifier: Apache-2.0
// Recipe usage and saves in the renderer: the
// `Used <n> times` badge from 5 uses, and the Add / Remove toggle that saves a built-in
// recipe into "My recipes" with its 3 s toast.

import type { JSX } from 'react'
import { parseError } from '@shared/errors'
import { RECIPE_USAGE_BADGE_MIN, type Recipe } from '@shared/types/recipes'
import { showToast } from '../../app/toast'
import { useRecipeUsage } from './store'

const TOAST_MS = 3_000

/** The number to 999, then "1.2k" (no ".0") to 9,999, then rounded thousands. */
export function formatUses(n: number): string {
  if (n < 1_000) return String(n)
  if (n < 10_000) {
    const k = Math.floor(n / 100) / 10
    return `${Number.isInteger(k) ? k.toFixed(0) : k.toFixed(1)}k`
  }
  return `${Math.round(n / 1_000)}k`
}

export function UsageBadge({ recipeId }: { recipeId: string }): JSX.Element | null {
  const usage = useRecipeUsage()
  const n = usage[recipeId]?.total_count ?? 0
  if (n < RECIPE_USAGE_BADGE_MIN) return null
  const label = formatUses(n)
  return (
    <span className="rcp-uses n-tooltip" data-tooltip={`Used ${label} times`} aria-label={`Used ${label} times`}>
      <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M4 17l5-5 4 4 7-7" />
        <path d="M15 9h5v5" />
      </svg>
      {label}
    </span>
  )
}

/** Built-ins only until sharing exists. */
export async function toggleSaved(recipe: Recipe): Promise<void> {
  try {
    if (recipe.saved) {
      await window.notula.recipes.unsave({ recipeId: recipe.id })
      showToast({ id: 'recipe-saved', title: 'Removed from My recipes', durationMs: TOAST_MS })
    } else {
      await window.notula.recipes.save({ recipeId: recipe.id })
      showToast({ id: 'recipe-saved', kind: 'success', title: 'Added to My recipes', durationMs: TOAST_MS })
    }
  } catch (err) {
    showToast({ id: 'recipe-saved', kind: 'error', title: 'Couldn’t update My recipes', description: parseError(err).message })
  }
}

export function SaveToggle({ recipe, variant }: { recipe: Recipe; variant: 'icon' | 'button' }): JSX.Element | null {
  if (!recipe.is_builtin) return null
  const label = recipe.saved ? 'Remove from My recipes' : 'Add to My recipes'
  const icon = (
    <svg width={15} height={15} viewBox="0 0 24 24" fill={recipe.saved ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={1.75} strokeLinejoin="round" aria-hidden="true">
      <path d="M6.5 4h11a1 1 0 0 1 1 1v15l-6.5-4-6.5 4V5a1 1 0 0 1 1-1z" />
    </svg>
  )
  if (variant === 'button') {
    return (
      <button type="button" className={`n-btn n-btn--sm rcp-save${recipe.saved ? ' is-saved' : ''}`} aria-pressed={recipe.saved} onClick={() => void toggleSaved(recipe)}>
        {icon}
        {label}
      </button>
    )
  }
  return (
    <span className="n-tooltip n-tooltip--end rcp-save-icon" data-tooltip={label}>
      <button
        type="button"
        className={`n-icon-btn n-icon-btn--sm rcp-save${recipe.saved ? ' is-saved' : ''}`}
        aria-label={label}
        aria-pressed={recipe.saved}
        onClick={(e) => {
          e.stopPropagation()
          void toggleSaved(recipe)
        }}
      >
        {icon}
      </button>
    </span>
  )
}
