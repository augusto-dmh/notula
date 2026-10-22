// SPDX-License-Identifier: Apache-2.0
// Toasts (`showToast`). A tiny external store; the
// Toaster component in App renders it. A toast with an `id` replaces the live one
// with the same id instead of stacking.

import { useSyncExternalStore } from 'react'

export interface Toast {
  id?: string
  title: string
  description?: string
  kind?: 'info' | 'success' | 'error'
  action?: { label: string; onClick(): void }
  durationMs?: number
}

export interface LiveToast extends Toast {
  id: string
  /** Changes on every show, so a replaced toast restarts its timer. */
  version: number
}

const MAX_VISIBLE = 4
const listeners = new Set<() => void>()
let toasts: readonly LiveToast[] = []
let version = 0

function emit(): void {
  for (const l of listeners) l()
}

export function showToast(t: Toast): void {
  const id = t.id ?? `toast-${crypto.randomUUID()}`
  const live: LiveToast = { ...t, id, version: ++version }
  const rest = toasts.filter((x) => x.id !== id)
  toasts = [...rest, live].slice(-MAX_VISIBLE)
  emit()
}

export function dismissToast(id: string): void {
  const next = toasts.filter((x) => x.id !== id)
  if (next.length === toasts.length) return
  toasts = next
  emit()
}

/** How long a toast stays when it sets no duration. */
export function defaultDuration(t: Toast): number {
  if (t.durationMs !== undefined) return t.durationMs
  if (t.action) return 8_000
  return t.kind === 'error' ? 7_000 : 5_000
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function useToasts(): readonly LiveToast[] {
  return useSyncExternalStore(subscribe, () => toasts)
}
