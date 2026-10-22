// SPDX-License-Identifier: Apache-2.0
// Search in the renderer: the `/search` page, the sidebar "Search" item and the command
// palette (its registry is app/commands.ts).

import { createElement, type JSX } from 'react'
import { openPalette, PaletteHost, SearchLink } from './PaletteHost'
import { SearchPageView } from './SearchPage'

/** `/search`. */
export function SearchPage(): JSX.Element {
  return createElement(SearchPageView)
}

/** The sidebar "Search" item: opens the palette. */
export function SidebarSearchLink(): JSX.Element | null {
  return createElement(SearchLink)
}

/** Mounted once in App (main window), beside the other hosts. */
export function CommandPaletteHost(): JSX.Element | null {
  return createElement(PaletteHost)
}

/** Opens the palette, optionally with a query. */
export function openCommandPalette(opts?: { query?: string }): void {
  openPalette(opts)
}
