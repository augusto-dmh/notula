// SPDX-License-Identifier: Apache-2.0
// The main window's sidebar state.
//
// - Open/closed and the width are the `ui.sidebar` preference, shared by the notes
//   and the Settings lists (width 200–420).
// - In a narrow window (below 900 px, or when the page would get less than 600 px) the
//   sidebar auto-collapses: it is hidden, the toggle opens it over the page, and it
//   closes again after a pick, on Escape or on a click outside.
// - Mod+S toggles it.

import { useSyncExternalStore } from 'react'
import { DEFAULT_SETTINGS } from '@shared/types/settings'
import { getPrefs, setPrefs, subscribePrefs } from '../features/settings/prefs-store'

export const SIDEBAR_MIN = 200
export const SIDEBAR_MAX = 420
const NARROW_BELOW = 900
const MIN_PAGE_WIDTH = 600

export interface SidebarView {
  /** The window is narrow: the sidebar never docks. */
  narrow: boolean
  /** Docked beside the page. */
  docked: boolean
  /** Open over the page (narrow windows only). */
  overlay: boolean
  width: number
}

const listeners = new Set<() => void>()
let overlayOpen = false
let snapshot: SidebarView = compute()

function stored(): { open: boolean; width: number } {
  return getPrefs()?.['ui.sidebar'] ?? DEFAULT_SETTINGS['ui.sidebar']
}

export function clampWidth(w: number): number {
  return Math.round(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, w)))
}

function compute(): SidebarView {
  const pref = stored()
  const width = clampWidth(pref.width)
  const narrow = window.innerWidth < NARROW_BELOW || window.innerWidth - width < MIN_PAGE_WIDTH
  return { narrow, docked: !narrow && pref.open, overlay: narrow && overlayOpen, width }
}

function update(): void {
  const next = compute()
  if (
    next.narrow === snapshot.narrow &&
    next.docked === snapshot.docked &&
    next.overlay === snapshot.overlay &&
    next.width === snapshot.width
  ) {
    return
  }
  snapshot = next
  for (const l of listeners) l()
}

window.addEventListener('resize', () => {
  const wasNarrow = snapshot.narrow
  if (wasNarrow !== compute().narrow) overlayOpen = false
  update()
})
subscribePrefs(update)

export function useSidebar(): SidebarView {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => snapshot
  )
}

/** The toggle button and Mod+S. */
export function toggleSidebar(): void {
  if (snapshot.narrow) {
    overlayOpen = !overlayOpen
    update()
    return
  }
  setPrefs({ 'ui.sidebar': { ...stored(), open: !snapshot.docked } })
}

/** After a pick in an auto-collapsed sidebar, and on Escape or a click outside. */
export function closeSidebarOverlay(): void {
  if (!overlayOpen) return
  overlayOpen = false
  update()
}

/** Saves a dragged sidebar width, clamped to its limits. */
export function saveSidebarWidth(width: number): void {
  setPrefs({ 'ui.sidebar': { open: true, width: clampWidth(width) } })
}
