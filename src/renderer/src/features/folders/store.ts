// SPDX-License-Identifier: Apache-2.0
// The renderer mirror of `folders:list`. Loaded once, then refreshed on
// `folders:changed` and on note changes (a trashed, restored or purged note changes the
// membership map without touching a folder table).

import { useSyncExternalStore } from 'react'
import { parseError } from '@shared/errors'
import type { Folder, FoldersState } from '@shared/types/folders'
import { debugLog } from '../../app/platform'

export interface FoldersView {
  folders: Folder[]
  byId: ReadonlyMap<string, Folder>
  membership: Readonly<Record<string, string[]>>
  rules: FoldersState['rules']
  /** Folder ids per note id. */
  foldersOfNote: ReadonlyMap<string, string[]>
}

type Snapshot = { status: 'loading' } | { status: 'error' } | { status: 'ready'; view: FoldersView }

const listeners = new Set<() => void>()
let snapshot: Snapshot = { status: 'loading' }
let started = false
let seq = 0
/** Completed loads (success or failure), so a page can wait for one newer than itself. */
let loads = 0
let timer: ReturnType<typeof setTimeout> | null = null
let waiters: (() => void)[] = []

function emit(): void {
  for (const l of listeners) l()
}

function settle(): void {
  loads++
  const done = waiters
  waiters = []
  for (const w of done) w()
}

function toView(state: FoldersState): FoldersView {
  const byId = new Map(state.folders.map((f) => [f.id, f]))
  const foldersOfNote = new Map<string, string[]>()
  for (const [folderId, noteIds] of Object.entries(state.membership)) {
    for (const noteId of noteIds) {
      const list = foldersOfNote.get(noteId)
      if (list) list.push(folderId)
      else foldersOfNote.set(noteId, [folderId])
    }
  }
  return { folders: state.folders, byId, membership: state.membership, rules: state.rules, foldersOfNote }
}

function load(): void {
  const id = ++seq
  window.notula.folders
    .list()
    .then((state) => {
      if (id !== seq) return
      snapshot = { status: 'ready', view: toView(state) }
      settle()
      emit()
    })
    .catch((err: unknown) => {
      if (id !== seq) return
      debugLog('folders:list-failed', { err: parseError(err) })
      settle()
      if (snapshot.status !== 'ready') snapshot = { status: 'error' }
      emit()
    })
}

function scheduleLoad(ms: number): void {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    load()
  }, ms)
}

function start(): void {
  if (started) return
  started = true
  window.notula.folders.onChanged(() => scheduleLoad(30))
  window.notula.notes.onChanged((c) => {
    if (c.tables.includes('documents')) scheduleLoad(250)
  })
  window.notula.storage.onStatusChanged((s) => {
    if (s.state === 'ready') scheduleLoad(0)
  })
  load()
}

function subscribe(cb: () => void): () => void {
  start()
  listeners.add(cb)
  return () => listeners.delete(cb)
}

/** The folders, or null until the first load (and after a failed first load). */
export function useFolders(): FoldersView | null {
  const s = useSyncExternalStore(subscribe, () => snapshot)
  return s.status === 'ready' ? s.view : null
}

/** How many loads have completed; a page compares it with the count when it mounted. */
export function useFoldersLoads(): number {
  useSyncExternalStore(subscribe, () => snapshot)
  return loads
}

export function foldersLoads(): number {
  return loads
}

/** Outside React (command providers, handlers). */
export function getFolders(): FoldersView | null {
  start()
  return snapshot.status === 'ready' ? snapshot.view : null
}

/**
 * Loads now (a write's push follows anyway) and resolves once a load that started after
 * this call has completed.
 */
export function refreshFolders(): Promise<void> {
  start()
  if (timer) clearTimeout(timer)
  timer = null
  const done = new Promise<void>((resolve) => waiters.push(resolve))
  load()
  return done
}
