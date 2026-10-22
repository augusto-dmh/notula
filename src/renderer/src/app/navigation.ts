// SPDX-License-Identifier: Apache-2.0
// The hash router. Production loads index.html from
// file://, so the route lives in the hash: `#/meeting/<id>?opened_from=new_note_button`.
//
// For the Settings shell, it also keeps:
// - a key and an index on every history entry, so a page can keep per-entry state
//   (the Settings scroll position) and know whether it was reached by Back/Forward;
// - Settings navigation that replaces Settings entries instead of stacking them, and
//   `leaveSettings()`, which goes back to the page the user was on before Settings.

import { useSyncExternalStore } from 'react'
import type { SettingsSection } from '@shared/types/settings'

export interface Route {
  path: string
  params: Record<string, string>
  query: URLSearchParams
}

/** How the current entry was reached: a push, a replace, or Back/Forward (`pop`). */
export type NavKind = 'push' | 'replace' | 'pop' | 'load'

interface EntryState {
  notulaKey: string
  notulaIndex: number
}

/**
 * Patterns with `:name` segments; the first match fills `params`. `/person/:email` serves
 * the palette's People group.
 */
const PATTERNS = [
  '/meeting/:id',
  '/settings',
  '/permissions',
  '/',
  '/settings/:section',
  '/chat',
  '/chat/:threadId',
  '/recipes',
  '/search',
  '/list/:id',
  '/person/:email',
  '/action-items',
  '/scratchpad',
  '/people',
  '/companies',
  '/company/:domain',
  // Labs pages
  '/tasks',
  '/wiki',
  '/wiki/:section',
  '/dispatches',
  '/dispatches/archived',
  '/view/customer-calls'
] as const

const listeners = new Set<() => void>()
let currentHash = ''
let snapshot: Route = parse('/')
let lastKind: NavKind = 'load'

function readHash(): string {
  const h = window.location.hash.replace(/^#/, '')
  return h === '' ? '/' : h
}

function match(path: string): Record<string, string> | null {
  const parts = path.split('/').filter(Boolean)
  for (const pattern of PATTERNS) {
    const want = pattern.split('/').filter(Boolean)
    if (want.length !== parts.length) continue
    const params: Record<string, string> = {}
    let ok = true
    for (let i = 0; i < want.length; i++) {
      const w = want[i] as string
      const p = parts[i] as string
      if (w.startsWith(':')) {
        try {
          params[w.slice(1)] = decodeURIComponent(p)
        } catch {
          params[w.slice(1)] = p
        }
      } else if (w !== p) {
        ok = false
        break
      }
    }
    if (ok) return params
  }
  return null
}

/** True when `path` (a pathname) is one of Notula's routes (deep link `open`). */
export function isKnownRoute(path: string): boolean {
  return match(path) !== null
}

function parse(hash: string): Route {
  const q = hash.indexOf('?')
  const rawPath = q === -1 ? hash : hash.slice(0, q)
  const path = rawPath.startsWith('/') ? rawPath : `/${rawPath}`
  return { path, params: match(path) ?? {}, query: new URLSearchParams(q === -1 ? '' : hash.slice(q + 1)) }
}

function entryState(): EntryState | null {
  const s = window.history.state as Partial<EntryState> | null
  return s && typeof s.notulaKey === 'string' && typeof s.notulaIndex === 'number'
    ? { notulaKey: s.notulaKey, notulaIndex: s.notulaIndex }
    : null
}

function newKey(): string {
  return crypto.randomUUID().slice(0, 8)
}

/** Gives the current entry a key if it has none (first load, or a hash set from outside). */
function ensureEntryState(): void {
  if (entryState()) return
  window.history.replaceState({ ...(window.history.state ?? {}), notulaKey: newKey(), notulaIndex: 0 }, '')
}

function refresh(): void {
  const h = readHash()
  if (h === currentHash) return
  currentHash = h
  snapshot = parse(h)
  for (const l of listeners) l()
}

window.addEventListener('popstate', () => {
  lastKind = 'pop'
})
window.addEventListener('hashchange', () => {
  ensureEntryState()
  refresh()
})
ensureEntryState()
refresh()

/** Navigates to a path such as `/meeting/<id>?opened_from=homescreen_document`. */
export function navigate(to: string, opts?: { replace?: boolean }): void {
  const target = `#${to.startsWith('/') ? to : `/${to}`}`
  if (window.location.hash === target) return
  const current = entryState()
  if (opts?.replace) {
    lastKind = 'replace'
    window.history.replaceState({ notulaKey: newKey(), notulaIndex: current?.notulaIndex ?? 0 }, '', target)
  } else {
    lastKind = 'push'
    window.history.pushState({ notulaKey: newKey(), notulaIndex: (current?.notulaIndex ?? 0) + 1 }, '', target)
  }
  refresh()
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

function getSnapshot(): Route {
  return snapshot
}

export function useRoute(): Route {
  return useSyncExternalStore(subscribe, getSnapshot)
}

/** The current route outside React (event handlers, listeners). */
export function currentRoute(): Route {
  return snapshot
}

/** The current history entry's key (stable across Back/Forward). */
export function currentEntryKey(): string {
  return entryState()?.notulaKey ?? `hash:${currentHash}`
}

/** How the current entry was reached. */
export function lastNavigationKind(): NavKind {
  return lastKind
}

// ---------- Settings ----------

export function isSettingsPath(path: string): boolean {
  return path === '/settings' || path.startsWith('/settings/')
}

/**
 * Opens a Settings page. From another Settings page it replaces the entry, so the
 * back stack never piles up; from anywhere else it pushes one entry.
 */
export function navigateToSettings(section: SettingsSection | string): void {
  navigate(`/settings/${section}`, { replace: isSettingsPath(currentRoute().path) })
}

/** Back from Settings: to the page before Settings, or home when Settings was the first page. */
export function leaveSettings(): void {
  if ((entryState()?.notulaIndex ?? 0) > 0) window.history.back()
  else navigate('/', { replace: true })
}
