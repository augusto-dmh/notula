// SPDX-License-Identifier: Apache-2.0
// The Recipes page, `/recipes`: "Discover" lists
// Notula's built-in recipes; "My recipes" splits the user's own ("Made by me") from
// "Saved" (built-ins saved into "My recipes"). A view filter narrows either tab to before,
// during or after a meeting, or across meetings; Ctrl/Cmd+F focuses the search;
// "Change view" switches between grid and list. "Create" reopens the unsaved draft if
// there is one.

import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import type { Recipe, RecipeView } from '@shared/types/recipes'
import { IconPlus, IconSearch } from '../../app/icons'
import { isMod } from '../../app/platform'
import { IconGrid, IconRows, IconSlashTile } from './icons'
import { openModal } from './RecipeModal'
import { allowedIn, compareRecipes, displayName, madeForOf, searchRecipes } from './slug'
import { savedDraft, setRecipesTab, useRecipes, useRecipesTab } from './store'
import { SaveToggle, UsageBadge } from './usage'
import './recipes.css'

const VIEW_FILTERS: { value: RecipeView | 'all'; label: string }[] = [
  { value: 'all', label: 'Any time' },
  { value: 'upcoming-meeting', label: 'Before a meeting' },
  { value: 'live-meeting', label: 'During a meeting' },
  { value: 'meeting', label: 'After a meeting' },
  { value: 'multi-meeting', label: 'Across meetings' }
]

let layout: 'grid' | 'list' = 'grid'

function openCreate(): void {
  const draft = savedDraft()
  openModal(draft ? { mode: 'create', draft } : { mode: 'create' })
}

export function RecipesPageView(): JSX.Element {
  const { recipes, loading } = useRecipes()
  const tab = useRecipesTab()
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<RecipeView | 'all'>('all')
  const [view, setView] = useState(layout)
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!isMod(e) || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'f') return
      // A dialog on top (the recipe modal) keeps its own find behaviour.
      if (document.querySelector('dialog[open]')) return
      e.preventDefault()
      searchRef.current?.focus()
      searchRef.current?.select()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const shown = useMemo(() => {
    let list = recipes.filter((r) => (tab === 'discover' ? r.is_builtin : !r.is_builtin))
    if (filter !== 'all') list = list.filter((r) => allowedIn(r, filter))
    // Ranking priority, ownership, then usage.
    list = query.trim() ? searchRecipes(list, query) : [...list].sort(compareRecipes)
    return list
  }, [recipes, tab, filter, query])

  const saved = useMemo(() => {
    let list = recipes.filter((r) => r.is_builtin && r.saved)
    if (filter !== 'all') list = list.filter((r) => allowedIn(r, filter))
    return query.trim() ? searchRecipes(list, query) : list
  }, [recipes, filter, query])

  const ownCount = recipes.filter((r) => !r.is_builtin).length

  return (
    <div className="rcp-page">
      <header className="rcp-page__header">
        <div>
          <h1 className="rcp-page__title">Recipes</h1>
          <p className="rcp-page__lede">Saved prompts you can run in any chat by typing / and the recipe’s name.</p>
        </div>
        <button type="button" className="n-btn n-btn--primary n-btn--sm" onClick={openCreate}>
          <IconPlus size={14} />
          Create
        </button>
      </header>

      <div className="rcp-page__bar">
        <div className="rcp-tabs" role="tablist" aria-label="Recipes">
          <button type="button" role="tab" className="rcp-tabs__tab" aria-selected={tab === 'discover'} onClick={() => setRecipesTab('discover')}>
            Discover
          </button>
          <button type="button" role="tab" className="rcp-tabs__tab" aria-selected={tab === 'mine'} onClick={() => setRecipesTab('mine')}>
            My recipes
            {ownCount > 0 ? <span className="rcp-tabs__count">{ownCount}</span> : null}
          </button>
        </div>
        <span className="rcp-page__spacer" />
        <label className="rcp-search">
          <IconSearch size={14} />
          <input
            ref={searchRef}
            className="rcp-search__input"
            placeholder="Search recipes"
            aria-label="Search recipes"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && query) {
                e.preventDefault()
                setQuery('')
              }
            }}
          />
        </label>
        <select className="n-input rcp-filter" aria-label="Show recipes for" value={filter} onChange={(e) => setFilter(e.target.value as RecipeView | 'all')}>
          {VIEW_FILTERS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
        <span className="n-tooltip n-tooltip--end" data-tooltip="Change view">
          <button
            type="button"
            className="n-icon-btn"
            aria-label="Change view"
            onClick={() => {
              layout = view === 'grid' ? 'list' : 'grid'
              setView(layout)
            }}
          >
            {view === 'grid' ? <IconRows size={16} /> : <IconGrid size={16} />}
          </button>
        </span>
      </div>

      {loading ? null : tab === 'discover' ? (
        <RecipeList recipes={shown} layout={view} empty={query || filter !== 'all' ? 'No recipes match.' : 'No recipes yet'} />
      ) : (
        <>
          {ownCount === 0 && !query && filter === 'all' ? (
            <div className="rcp-empty">
              <IconSlashTile size={40} />
              <h2 className="rcp-empty__title">No recipes yet</h2>
              <p className="rcp-empty__body">Save a prompt once, then type / in chat to run it.</p>
              <button type="button" className="n-btn n-btn--primary n-btn--sm" onClick={openCreate}>
                <IconPlus size={14} />
                Create recipe
              </button>
            </div>
          ) : (
            <section className="rcp-page__section">
              <h2 className="rcp-page__section-title">Made by you</h2>
              <RecipeList recipes={shown} layout={view} empty="No recipes match." />
            </section>
          )}
          <section className="rcp-page__section">
            <h2 className="rcp-page__section-title">Saved</h2>
            {saved.length ? (
              <RecipeList recipes={saved} layout={view} empty="No recipes match." />
            ) : (
              <p className="rcp-page__note">Recipes you save from Discover will show here.</p>
            )}
          </section>
        </>
      )}
    </div>
  )
}

function RecipeList({ recipes, layout: mode, empty }: { recipes: Recipe[]; layout: 'grid' | 'list'; empty: string }): JSX.Element {
  if (recipes.length === 0) return <p className="rcp-page__note">{empty}</p>
  return (
    <ul className={`rcp-list rcp-list--${mode}`}>
      {recipes.map((r) => {
        const madeFor = madeForOf(r.config.recipe_views)
        return (
          <li key={r.id} className="rcp-list__item">
            <button type="button" className="rcp-card" onClick={() => openModal({ mode: 'view', recipeId: r.id })}>
              <IconSlashTile size={mode === 'grid' ? 32 : 28} />
              <span className="rcp-card__text">
                <span className="rcp-card__name">{displayName(r.slug)}</span>
                <span className="rcp-card__slug">/{r.slug}</span>
                <span className="rcp-card__desc">{r.config.description || r.config.instructions}</span>
              </span>
              <span className="rcp-card__badges">
                <UsageBadge recipeId={r.id} />
                <span className="rcp-badge">{madeFor === 'single' ? 'Single meeting' : madeFor === 'multi' ? 'Multiple meetings' : 'Any meeting'}</span>
              </span>
            </button>
            <SaveToggle recipe={r} variant="icon" />
          </li>
        )
      })}
    </ul>
  )
}
