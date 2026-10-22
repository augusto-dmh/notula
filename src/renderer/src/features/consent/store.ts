// SPDX-License-Identifier: Apache-2.0
// The renderer's view of each note's notice status (`consent:get-status`, `consent:status-changed`).

import { useEffect, useState } from 'react'
import type { ConsentStatus } from '@shared/types/consent'

const byNote = new Map<string, ConsentStatus | null>()
const listeners = new Set<() => void>()
let subscribed = false

function subscribe(): void {
  if (subscribed) return
  subscribed = true
  window.notula.consent.onStatusChanged((s) => {
    byNote.set(s.noteId, s)
    for (const l of listeners) l()
  })
}

export function refreshConsent(noteId: string): void {
  void window.notula.consent
    .getStatus({ noteId })
    .then((s) => {
      byNote.set(noteId, s)
      for (const l of listeners) l()
    })
    .catch(() => undefined)
}

export function useConsentStatus(noteId: string): ConsentStatus | null {
  const [, tick] = useState(0)
  useEffect(() => {
    subscribe()
    const l = (): void => tick((n) => n + 1)
    listeners.add(l)
    refreshConsent(noteId)
    return () => {
      listeners.delete(l)
    }
  }, [noteId])
  return byNote.get(noteId) ?? null
}

export function errorText(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message.replace(/^.*?(?:[a-z-]+): /, '') || fallback : fallback
}
