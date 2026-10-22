// SPDX-License-Identifier: Apache-2.0
// The submitted search: renderer memory only,
// reset on restart. The palette writes it; `/search` reads it.

import { useSyncExternalStore } from 'react'
import type { SearchMatchType } from '@shared/types/search'

export interface StoredSearch {
  type: 'freeform'
  query: string
  ids: string[]
  /** Per note: the snippet, else the title, else "New note". */
  snippets: Record<string, string>
  matchTypes: Record<string, SearchMatchType>
  /** The phrase of a quoted query, else the query. */
  term: string
  /** Changes on every submission, so the page restarts on a repeated query too. */
  submittedAt: number
}

export type SearchScope = 'all' | 'mine'

const listeners = new Set<() => void>()
let stored: StoredSearch | null = null
let scope: SearchScope = 'all'

function emit(): void {
  for (const l of listeners) l()
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function setStoredSearch(next: StoredSearch, nextScope?: SearchScope): void {
  stored = next
  if (nextScope) scope = nextScope
  emit()
}

export function getStoredSearch(): StoredSearch | null {
  return stored
}

export function useStoredSearch(): StoredSearch | null {
  return useSyncExternalStore(subscribe, () => stored)
}

export function setSearchScope(next: SearchScope): void {
  if (scope === next) return
  scope = next
  emit()
}

export function useSearchScope(): SearchScope {
  return useSyncExternalStore(subscribe, () => scope)
}
