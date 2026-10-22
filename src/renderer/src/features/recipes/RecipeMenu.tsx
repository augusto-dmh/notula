// SPDX-License-Identifier: Apache-2.0
// The recipe menu, opened by the chat composer's
// slash command with the text after "/" as `query`. Header "Recipes" with "Create
// recipe" (prefilled with the query) and "Browse all"; sections "Recent" (≤ 3, only
// without a query), "My recipes" and "All recipes", each limited to the chat's view
// and ranked; fuzzy search, ≤ 50 per section. The arrow keys move the
// highlight and Enter picks while the composer keeps focus; Escape and an outside
// click close it.

import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import type { Recipe } from '@shared/types/recipes'
import { IconPlus } from '../../app/icons'
import { navigate } from '../../app/navigation'
import { NuxTip } from '../nux'
import { IconSlashTile } from './icons'
import type { RecipeMenuProps } from './index'
import { allowedIn, compareRecipes, displayName, sanitizeSlugInput, searchRecipes } from './slug'
import { useRecentRecipeIds, useRecipes } from './store'
import './recipes.css'

const RECENT_SHOWN = 3
const SECTION_MAX = 50

interface Section {
  id: string
  title: string
  recipes: Recipe[]
}

export function RecipeMenuView({ view, query, onPick, onCreate, onClose }: RecipeMenuProps): JSX.Element {
  const { recipes, loading } = useRecipes()
  const recent = useRecentRecipeIds()
  const [active, setActive] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)

  const sections = useMemo((): Section[] => {
    const allowed = recipes.filter((r) => allowedIn(r, view))
    const q = query.trim()
    const mine = allowed.filter((r) => !r.is_builtin)
    const all = allowed.filter((r) => r.is_builtin)
    const out: Section[] = []
    if (!q) {
      const ids = recent[view] ?? []
      const recents = ids
        .map((id) => allowed.find((r) => r.id === id))
        .filter((r): r is Recipe => !!r)
        .slice(0, RECENT_SHOWN)
      if (recents.length) out.push({ id: 'recent', title: 'Recent', recipes: recents })
      out.push({ id: 'mine', title: 'My recipes', recipes: [...mine].sort(compareRecipes).slice(0, SECTION_MAX) })
      out.push({ id: 'all', title: 'All recipes', recipes: [...all].sort(compareRecipes).slice(0, SECTION_MAX) })
    } else {
      out.push({ id: 'mine', title: 'My recipes', recipes: searchRecipes(mine, q, SECTION_MAX) })
      out.push({ id: 'all', title: 'All recipes', recipes: searchRecipes(all, q, SECTION_MAX) })
    }
    return out.filter((s) => s.recipes.length > 0)
  }, [recipes, recent, view, query])

  const flat = useMemo(() => sections.flatMap((s) => s.recipes), [sections])
  useEffect(() => setActive(0), [query, view])

  const latest = useRef({ flat, active, onPick, onClose })
  latest.current = { flat, active, onPick, onClose }

  // The composer keeps focus: the menu listens for its keys first.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const { flat: items, active: i } = latest.current
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (!items.length) return
        e.preventDefault()
        e.stopPropagation()
        setActive((i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length)
      } else if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        const pick = items[i]
        if (!pick) return
        e.preventDefault()
        e.stopPropagation()
        latest.current.onPick(pick)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        latest.current.onClose()
      }
    }
    const onDown = (e: MouseEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) latest.current.onClose()
    }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('mousedown', onDown, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('mousedown', onDown, true)
    }
  }, [])

  useEffect(() => {
    rootRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [active])

  let index = -1
  return (
    <div className="recipe-menu rcp-menu" role="listbox" aria-label="Recipes" ref={rootRef} onMouseDown={(e) => e.preventDefault()}>
      {/* The recipes tip. */}
      <NuxTip id="recipes" />
      <div className="rcp-menu__header">
        <span className="rcp-menu__title">Recipes</span>
        <span className="rcp-menu__actions">
          <button type="button" className="n-btn n-btn--ghost n-btn--sm" onClick={() => onCreate(sanitizeSlugInput(query))}>
            <IconPlus size={13} />
            Create recipe
          </button>
          <button
            type="button"
            className="n-btn n-btn--ghost n-btn--sm"
            onClick={() => {
              onClose()
              navigate('/recipes')
            }}
          >
            Browse all
          </button>
        </span>
      </div>
      <div className="rcp-menu__scroll">
        {loading ? <p className="rcp-menu__note">Loading…</p> : null}
        {!loading && flat.length === 0 ? (
          <p className="rcp-menu__note">{query.trim() ? `No recipes found matching “${query.trim()}”` : 'No recipes yet'}</p>
        ) : null}
        {sections.map((s) => (
          <div key={s.id} className="rcp-menu__section">
            <div className="rcp-menu__heading">{s.title}</div>
            {s.recipes.map((r) => {
              index++
              const i = index
              return (
                <button
                  key={`${s.id}:${r.id}`}
                  type="button"
                  role="option"
                  aria-selected={i === active}
                  data-active={i === active}
                  className="rcp-menu__item"
                  onMouseEnter={() => setActive(i)}
                  onClick={() => onPick(r)}
                >
                  <IconSlashTile size={24} />
                  <span className="rcp-menu__text">
                    <span className="rcp-menu__name">{displayName(r.slug)}</span>
                    {r.config.description ? <span className="rcp-menu__desc">{r.config.description}</span> : null}
                  </span>
                  <span className="rcp-menu__slug">/{r.slug}</span>
                </button>
              )
            })}
          </div>
        ))}
      </div>
    </div>
  )
}
