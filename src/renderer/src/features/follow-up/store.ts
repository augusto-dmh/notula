// SPDX-License-Identifier: Apache-2.0
// Follow-up drafts in the renderer: which note's
// composer is open, and the suggested list the home section and the note rows read.

import { useEffect, useState, useSyncExternalStore } from 'react'
import type { FollowUpDraft } from '@shared/types/follow-up'

// ---------- the open composer ----------

const listeners = new Set<() => void>()
let openNote: string | null = null

export function setComposerNote(noteId: string | null): void {
  openNote = noteId
  for (const l of listeners) l()
}

export function useComposerNote(): string | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => openNote
  )
}

// ---------- suggested drafts ----------

const suggestedListeners = new Set<() => void>()
let suggested: readonly FollowUpDraft[] = []
let started = false
let timer: ReturnType<typeof setTimeout> | null = null

function emitSuggested(): void {
  for (const l of suggestedListeners) l()
}

export function refreshSuggested(): void {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    window.notula.followUp
      .listSuggested()
      .then((list) => {
        suggested = list
        emitSuggested()
      })
      .catch(() => undefined)
  }, 80)
}

function start(): void {
  if (started) return
  started = true
  refreshSuggested()
  window.notula.followUp.onResult(() => refreshSuggested())
  window.notula.followUp.onError(() => refreshSuggested())
  window.notula.followUp.onProgress(() => refreshSuggested())
  window.notula.prefs.onChanged(() => refreshSuggested())
  window.notula.notes.onChanged((c) => {
    if (c.tables.includes('documents')) refreshSuggested()
  })
}

export function useSuggestedFollowUps(): readonly FollowUpDraft[] {
  useEffect(start, [])
  return useSyncExternalStore(
    (cb) => {
      suggestedListeners.add(cb)
      return () => suggestedListeners.delete(cb)
    },
    () => suggested
  )
}

/** Removes a draft from the list at once (Dismiss), restoring it on failure. */
export function hideSuggested(id: string): () => void {
  const before = suggested
  suggested = suggested.filter((d) => d.id !== id)
  emitSuggested()
  return () => {
    suggested = before
    emitSuggested()
  }
}

/** The note ids with a ready, untouched draft: the home rows' "Follow-up email suggested" icon. */
export function useSuggestedNoteIds(): ReadonlySet<string> {
  const list = useSuggestedFollowUps()
  const [ids, setIds] = useState<ReadonlySet<string>>(new Set())
  useEffect(() => {
    setIds(new Set(list.filter((d) => d.status === 'completed' && d.outcome === null).map((d) => d.document_id)))
  }, [list])
  return ids
}
