// SPDX-License-Identifier: Apache-2.0
// The theme controller. It sets
// `data-theme="light" | "dark"` on <html> (`system` follows prefers-color-scheme) and
// sends `app:set-theme` at startup and on every change, so main sets the native
// theme and the window background. No restart is needed.

import type { ThemeSetting } from '@shared/types/settings'
import { getPrefs, startPrefs, subscribePrefs } from './prefs-store'

let started = false
let lastSent = ''

function resolve(theme: ThemeSetting, darkQuery: MediaQueryList): 'light' | 'dark' {
  if (theme === 'system') return darkQuery.matches ? 'dark' : 'light'
  return theme
}

/** Starts once, app-wide. Safe to call again. */
export function startThemeController(): void {
  if (started) return
  started = true
  startPrefs()
  const darkQuery = window.matchMedia('(prefers-color-scheme: dark)')

  function apply(): void {
    const prefs = getPrefs()
    if (!prefs) return
    const theme = prefs['ui.theme']
    const resolved = resolve(theme, darkQuery)
    document.documentElement.dataset['theme'] = resolved
    const key = `${theme}:${resolved}`
    if (key === lastSent) return
    lastSent = key
    window.notula.app.setTheme({ theme, resolved })
  }

  subscribePrefs(apply)
  darkQuery.addEventListener('change', apply)
  apply()
}
