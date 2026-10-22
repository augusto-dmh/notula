// SPDX-License-Identifier: Apache-2.0
// Tip state on the renderer side.
// - The host gate: tips render only while NuxHost is mounted. NuxHost lives in the main window's
//   App, inside the onboarding and device-lock gates, so no tip ever shows during onboarding,
//   while Notula is locked, or in a secondary window.
// - One tip at a time: each eligible tip claims a slot; the highest-priority claim is visible.
// - Dismissals are optimistic: the tip hides at once, and main's `nux.dismissed` follows.

import { useSyncExternalStore } from 'react'
import type { NuxTipId } from '@shared/types/nux'

let hosts = 0
let claims: string[] = []
const dismissedHere = new Set<string>()
let version = 0
const listeners = new Set<() => void>()

function emit(): void {
  version++
  for (const l of listeners) l()
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function useNuxVersion(): number {
  return useSyncExternalStore(subscribe, () => version)
}

export function mountHost(): () => void {
  hosts++
  emit()
  return () => {
    hosts--
    emit()
  }
}

export const hostMounted = (): boolean => hosts > 0

/** When several tips could show, the earlier one here wins (setup before discovery). */
const PRIORITY = ['calendar-error', 'retention-first-purge', 'live-transcript', 'ai-setup', 'demo-meeting', 'recipes', 'slash-menu', 'folder-empty', 'labs']
const rank = (id: string): number => {
  const i = PRIORITY.indexOf(id.split(':')[0] ?? id)
  return i === -1 ? PRIORITY.length : i
}

export function claim(id: string): void {
  if (claims.includes(id)) return
  claims = [...claims, id].sort((a, b) => rank(a) - rank(b))
  emit()
}

export function release(id: string): void {
  if (!claims.includes(id)) return
  claims = claims.filter((c) => c !== id)
  emit()
}

export const visibleTip = (): string | null => claims[0] ?? null

export function dismissedLocally(id: string): boolean {
  return dismissedHere.has(id)
}

export function dismissTip(id: NuxTipId | string): void {
  if (!dismissedHere.has(id)) {
    dismissedHere.add(id)
    release(id)
    emit()
  }
  window.notula.nux.dismiss({ id })
}

/** After "Reset tips": forget the optimistic dismissals too. */
export function clearLocalDismissals(): void {
  dismissedHere.clear()
  emit()
}
