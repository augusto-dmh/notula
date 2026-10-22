// SPDX-License-Identifier: Apache-2.0
// Per-view UI state that survives navigation, e.g. the home scroll position under
// the key `home`. Kept in memory and mirrored to
// sessionStorage so a renderer reload keeps it too. UI state only, never synced.

const PREFIX = 'notula.ui.'
const memory = new Map<string, unknown>()

export function saveViewState(key: string, value: unknown): void {
  memory.set(key, value)
  try {
    sessionStorage.setItem(PREFIX + key, JSON.stringify(value))
  } catch {
    // Storage can be unavailable; memory still works.
  }
}

export function readViewState<T>(key: string): T | null {
  if (memory.has(key)) return memory.get(key) as T
  try {
    const raw = sessionStorage.getItem(PREFIX + key)
    if (raw !== null) {
      const value = JSON.parse(raw) as T
      memory.set(key, value)
      return value
    }
  } catch {
    // Ignore unreadable state.
  }
  return null
}
