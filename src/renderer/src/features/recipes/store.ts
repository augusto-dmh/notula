// SPDX-License-Identifier: Apache-2.0
// Renderer state for recipes: every visible recipe
// (`recipes:list`, refreshed on `recipes:changed`) with optimistic local saves and
// deletes, the unsaved draft that "Create" reopens, and
// the Recipes page tab a save switches to. Also
// the usage map (`recipes:usage`), refreshed with the list.

import { useSyncExternalStore } from 'react'
import { parseError } from '@shared/errors'
import type { Recipe, RecipesUsage, RecipeUpsert, RecipeView } from '@shared/types/recipes'
import { debugLog } from '../../app/platform'
import { getPrefs, subscribePrefs } from '../settings/prefs-store'

type Listener = () => void

function emitter(): { emit(): void; subscribe(l: Listener): () => void } {
  const listeners = new Set<Listener>()
  return {
    emit: () => {
      for (const l of listeners) l()
    },
    subscribe: (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    }
  }
}

// ---------- the list ----------

export interface RecipesSnapshot {
  recipes: Recipe[]
  loading: boolean
}

const listEvents = emitter()
let snapshot: RecipesSnapshot = { recipes: [], loading: true }
/** Ids deleted locally whose refresh may still list them for a moment. */
const hidden = new Set<string>()
let started = false
let loadSeq = 0

export async function refreshRecipes(): Promise<Recipe[]> {
  const seq = ++loadSeq
  try {
    const list = await window.notula.recipes.list()
    if (seq === loadSeq) {
      snapshot = { recipes: list.filter((r) => !hidden.has(r.id)), loading: false }
      listEvents.emit()
    }
  } catch (err) {
    debugLog('recipes-load-failed', { err: parseError(err) })
    if (seq === loadSeq && snapshot.loading) {
      snapshot = { recipes: [], loading: false }
      listEvents.emit()
    }
  }
  return snapshot.recipes
}

// ---------- usage ----------

let usage: RecipesUsage = {}
let usageSeq = 0

export async function refreshUsage(): Promise<void> {
  const seq = ++usageSeq
  try {
    const next = await window.notula.recipes.usage()
    if (seq !== usageSeq) return
    usage = next
    listEvents.emit()
  } catch (err) {
    debugLog('recipes-usage-failed', { err: parseError(err) })
  }
}

/** A recipe's use count (0 when it has never run). */
export function usageCount(id: string): number {
  return usage[id]?.total_count ?? 0
}

export function useRecipeUsage(): RecipesUsage {
  return useSyncExternalStore(subscribeList, () => usage)
}

function start(): void {
  if (started) return
  started = true
  window.notula.recipes.onChanged(() => {
    void refreshRecipes()
    void refreshUsage()
  })
  void refreshRecipes()
  void refreshUsage()
}

function subscribeList(l: Listener): () => void {
  start()
  return listEvents.subscribe(l)
}

export function useRecipes(): RecipesSnapshot {
  return useSyncExternalStore(subscribeList, () => snapshot)
}

export function currentRecipes(): Recipe[] {
  start()
  return snapshot.recipes
}

/** By id, else by slug (case-insensitive; the user's own first, then the newest). */
export function findRecipe(recipes: Recipe[], ref: string): Recipe | null {
  const byId = recipes.find((r) => r.id === ref.toLowerCase())
  if (byId) return byId
  const key = ref.toLowerCase()
  const hits = recipes.filter((r) => r.slug.toLowerCase() === key)
  hits.sort((a, b) => Number(a.is_builtin) - Number(b.is_builtin) || b.updated_at.localeCompare(a.updated_at))
  return hits[0] ?? null
}

export function putLocalRecipe(r: Recipe): void {
  hidden.delete(r.id)
  const exists = snapshot.recipes.some((x) => x.id === r.id)
  snapshot = { ...snapshot, recipes: exists ? snapshot.recipes.map((x) => (x.id === r.id ? r : x)) : [r, ...snapshot.recipes] }
  listEvents.emit()
}

export function hideLocalRecipe(id: string, hide: boolean): void {
  if (hide) hidden.add(id)
  else hidden.delete(id)
  if (hide) {
    snapshot = { ...snapshot, recipes: snapshot.recipes.filter((r) => r.id !== id) }
    listEvents.emit()
  } else void refreshRecipes()
}

// ---------- recent (a preference, written by chat on each run) ----------

const EMPTY_RECENT: Partial<Record<RecipeView, string[]>> = {}

export function useRecentRecipeIds(): Partial<Record<RecipeView, string[]>> {
  return useSyncExternalStore(subscribePrefs, () => getPrefs()?.['recipes.recent'] ?? EMPTY_RECENT)
}

// ---------- the unsaved draft ----------

let draft: Partial<RecipeUpsert> | null = null

export function savedDraft(): Partial<RecipeUpsert> | null {
  return draft
}

export function keepDraft(d: Partial<RecipeUpsert> | null): void {
  draft = d
}

// ---------- the Recipes page tab ----------

export type RecipesTab = 'discover' | 'mine'

const tabEvents = emitter()
let tab: RecipesTab = 'discover'

export function setRecipesTab(next: RecipesTab): void {
  if (tab === next) return
  tab = next
  tabEvents.emit()
}

export function useRecipesTab(): RecipesTab {
  return useSyncExternalStore(tabEvents.subscribe, () => tab)
}
