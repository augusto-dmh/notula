// SPDX-License-Identifier: Apache-2.0
// The palette's host: mounted once in App.
// Ctrl/⌘ + K and Ctrl/⌘ + / open it anywhere (again: close it), never over another
// dialog, and Ctrl/⌘ + K inside an editor with a selection stays with the editor;
// Ctrl/⌘ + F opens it on home only. Also hosts the folder dialogs and registers the
// search and folder commands.

import { useEffect, useSyncExternalStore, type JSX } from 'react'
import { IconSearch } from '../../app/icons'
import { currentRoute, useRoute } from '../../app/navigation'
import { isMac, isMod } from '../../app/platform'
import { closeSidebarOverlay } from '../../app/sidebar-state'
import { anotherModalOpen, FolderDialogsHost } from '../folders'
import { CommandPalette } from './CommandPalette'
import { useOrganizeCommands } from './commands'
import { getStoredSearch } from './store'
import './search.css'

type OpenState = { open: false } | { open: true; query: string; nonce: number }

const listeners = new Set<() => void>()
let state: OpenState = { open: false }
let nonce = 0

function set(next: OpenState): void {
  state = next
  for (const l of listeners) l()
}

/** Opens the palette; on `/search` it starts with the last submitted query. */
export function openPalette(opts?: { query?: string }): void {
  const query = opts?.query ?? (currentRoute().path === '/search' ? (getStoredSearch()?.query ?? '') : '')
  set({ open: true, query, nonce: ++nonce })
}

export function closePalette(): void {
  if (state.open) set({ open: false })
}

/** An editor (contenteditable) holds a non-empty selection: Ctrl/⌘ + K stays with it. */
function editorHasSelection(): boolean {
  const sel = window.getSelection()
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return false
  const node = sel.anchorNode
  const el = node instanceof HTMLElement ? node : node?.parentElement
  return !!el?.closest('[contenteditable="true"]')
}

function onHotkey(e: KeyboardEvent): void {
  if (!isMod(e) || e.altKey || e.shiftKey) return
  const key = e.key.toLowerCase()
  const slash = key === '/' || e.code === 'Slash'
  if (key === 'k' || slash) {
    if (state.open) {
      e.preventDefault()
      e.stopPropagation()
      closePalette()
      return
    }
    if (anotherModalOpen()) return
    if (key === 'k' && editorHasSelection()) return
    e.preventDefault()
    e.stopPropagation()
    openPalette()
  } else if (key === 'f') {
    if (state.open || currentRoute().path !== '/' || anotherModalOpen()) return
    e.preventDefault()
    e.stopPropagation()
    openPalette()
  }
}

export function PaletteHost(): JSX.Element {
  const s = useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => state
  )
  useOrganizeCommands()

  useEffect(() => {
    window.addEventListener('keydown', onHotkey, true)
    return () => window.removeEventListener('keydown', onHotkey, true)
  }, [])

  return (
    <>
      {s.open ? <CommandPalette key={s.nonce} initialQuery={s.query} onClose={closePalette} /> : null}
      <FolderDialogsHost />
    </>
  )
}

/** The sidebar "Search" item: opens the palette. Styled as the shell's sidebar items. */
export function SearchLink(): JSX.Element {
  const { path } = useRoute()
  return (
    <span className="n-tooltip n-tooltip--start sidebar-search" data-tooltip={`Search   ${isMac ? '⌘ K' : 'Ctrl K'}`}>
      <button
        type="button"
        className="app-sidebar__item"
        aria-current={path === '/search' ? 'page' : undefined}
        aria-label="Search"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          closeSidebarOverlay()
          openPalette()
        }}
      >
        <IconSearch size={16} />
        <span className="app-sidebar__label">Search</span>
      </button>
    </span>
  )
}
