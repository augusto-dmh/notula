// SPDX-License-Identifier: Apache-2.0
// Renderer state for enhanced notes, shared by every component of the note page:
// - panels per note (`panels:list`, refreshed on `notes:changed` and generation ends);
// - live generations by panel (`enhance:event`, re-attached with `enhance:get-active`);
// - the note record and its transcript chunk count.
// Each is a small external store read with useSyncExternalStore, one subscription per
// channel for the whole window.

import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { SUGGESTED_ACTIONS_SLUG, type EnhanceErrorCode, type EnhanceEvent } from '@shared/types/enhance'
import type { Note } from '@shared/types/notes'
import type { GeneratedLine, Panel } from '@shared/types/panels'
import { DELETED_CHUNK_MARKER } from '@shared/types/transcript'
import { debugLog } from '../../app/platform'

type Listener = () => void

/** A keyed external store with reference-counted loading. */
class Keyed<T> {
  private readonly values = new Map<string, T>()
  private readonly listeners = new Map<string, Set<Listener>>()

  constructor(
    private readonly initial: T,
    private readonly load: (key: string) => void
  ) {}

  get(key: string): T {
    return this.values.get(key) ?? this.initial
  }

  set(key: string, value: T): void {
    this.values.set(key, value)
    for (const l of this.listeners.get(key) ?? []) l()
  }

  subscribe(key: string, l: Listener): () => void {
    let set = this.listeners.get(key)
    if (!set) {
      set = new Set()
      this.listeners.set(key, set)
    }
    set.add(l)
    if (set.size === 1) this.load(key)
    return () => {
      set.delete(l)
      if (set.size === 0) this.listeners.delete(key)
    }
  }

  watched(key: string): boolean {
    return this.listeners.has(key)
  }

  keys(): string[] {
    return [...this.listeners.keys()]
  }
}

function useKeyed<T>(store: Keyed<T>, key: string): T {
  // A stable subscribe per key: a new one each render would unsubscribe and reload.
  const subscribe = useCallback((l: Listener) => store.subscribe(key, l), [store, key])
  return useSyncExternalStore(subscribe, () => store.get(key))
}

// ---------- panels ----------

export interface PanelsSnapshot {
  panels: Panel[]
  latest: Panel | null
  loading: boolean
}

const recency = (p: Panel): string => p.last_opened_at ?? p.created_at

/**
 * Live summary panels (not deleted, not
 * `recap-next-steps`), most recently viewed (else created) first.
 */
export function orderPanels(list: Panel[]): Panel[] {
  return list
    .filter((p) => !p.deleted_at && p.template_key !== SUGGESTED_ACTIONS_SLUG)
    .sort((a, b) => recency(b).localeCompare(recency(a)) || b.created_at.localeCompare(a.created_at))
}

const panelSeq = new Map<string, number>()
const panelsStore: Keyed<PanelsSnapshot> = new Keyed<PanelsSnapshot>({ panels: [], latest: null, loading: true }, (noteId) => {
  ensureSubscriptions()
  void refreshPanels(noteId)
})

export async function refreshPanels(noteId: string): Promise<Panel[]> {
  const seq = (panelSeq.get(noteId) ?? 0) + 1
  panelSeq.set(noteId, seq)
  try {
    const list = orderPanels(await window.notula.panels.list({ noteId }))
    if (panelSeq.get(noteId) === seq) panelsStore.set(noteId, { panels: list, latest: list[0] ?? null, loading: false })
    return list
  } catch (err) {
    debugLog('panels-load-failed', { noteId, err })
    if (panelSeq.get(noteId) === seq && panelsStore.get(noteId).loading) {
      panelsStore.set(noteId, { panels: [], latest: null, loading: false })
    }
    return panelsStore.get(noteId).panels
  }
}

export function usePanelsSnapshot(noteId: string): PanelsSnapshot {
  return useKeyed(panelsStore, noteId)
}

export function currentPanels(noteId: string): Panel[] {
  return panelsStore.get(noteId).panels
}

// ---------- live generations ----------

export interface Generation {
  noteId: string
  panelId: string
  status: 'generating' | 'done' | 'failed'
  text: string
  lines: GeneratedLine[] | null
  /** The final markdown, from the `ydoc` event. */
  final: string | null
  error: { code: EnhanceErrorCode; message: string } | null
}

const generations = new Map<string, Generation>()
const generationListeners = new Set<Listener>()
const eventListeners = new Set<(e: EnhanceEvent) => void>()
let generationsVersion = 0

function publishGenerations(): void {
  generationsVersion++
  for (const l of generationListeners) l()
}

function subscribeGenerations(l: Listener): () => void {
  ensureSubscriptions()
  generationListeners.add(l)
  return () => generationListeners.delete(l)
}

function onEnhanceEvent(e: EnhanceEvent): void {
  const prev = generations.get(e.panelId)
  switch (e.type) {
    case 'panel_id':
      generations.set(e.panelId, {
        noteId: e.noteId,
        panelId: e.panelId,
        status: 'generating',
        text: '',
        lines: null,
        final: null,
        error: null
      })
      void refreshPanels(e.noteId)
      break
    case 'completion':
      if (prev) generations.set(e.panelId, { ...prev, text: prev.text + e.delta })
      break
    case 'ai_line_map':
      if (prev) generations.set(e.panelId, { ...prev, lines: e.lines })
      break
    case 'ydoc':
      if (prev) generations.set(e.panelId, { ...prev, final: e.originalContent })
      break
    case 'error':
      if (prev) generations.set(e.panelId, { ...prev, error: { code: e.code, message: e.message } })
      break
    case 'done':
      if (prev) generations.set(e.panelId, { ...prev, status: e.ok ? 'done' : 'failed' })
      void refreshPanels(e.noteId)
      break
  }
  publishGenerations()
  for (const l of eventListeners) l(e)
}

/** Re-attaches to generations already running in main. */
async function attach(noteId: string): Promise<void> {
  try {
    for (const a of await window.notula.enhance.getActive({ noteId })) {
      const known = generations.get(a.panelId)
      if (known && known.status === 'generating' && known.text.length >= a.text.length) continue
      generations.set(a.panelId, {
        noteId,
        panelId: a.panelId,
        status: 'generating',
        text: a.text,
        lines: known?.lines ?? null,
        final: null,
        error: null
      })
    }
    publishGenerations()
  } catch (err) {
    debugLog('enhance-get-active-failed', { noteId, err })
  }
}

export function useGeneration(panelId: string): Generation | null {
  useSyncExternalStore(subscribeGenerations, () => generationsVersion)
  return generations.get(panelId) ?? null
}

export function isNoteGenerating(noteId: string): boolean {
  for (const g of generations.values()) if (g.noteId === noteId && g.status === 'generating') return true
  return false
}

/** True while any panel of the note is generating in this session; re-attaches on mount. */
export function useNoteGenerating(noteId: string): boolean {
  useEffect(() => {
    void attach(noteId)
  }, [noteId])
  useSyncExternalStore(subscribeGenerations, () => generationsVersion)
  return isNoteGenerating(noteId)
}

export function onGenerationEvent(cb: (e: EnhanceEvent) => void): () => void {
  ensureSubscriptions()
  eventListeners.add(cb)
  return () => eventListeners.delete(cb)
}

// ---------- the note ----------

const noteStore: Keyed<Note | null | undefined> = new Keyed<Note | null | undefined>(undefined, (noteId) => {
  ensureSubscriptions()
  void refreshNote(noteId)
})

async function refreshNote(noteId: string): Promise<void> {
  try {
    noteStore.set(noteId, await window.notula.notes.get({ id: noteId }))
  } catch (err) {
    debugLog('enhance-note-load-failed', { noteId, err })
  }
}

/** The note record; undefined while loading, null when it does not exist. */
export function useNote(noteId: string): Note | null | undefined {
  return useKeyed(noteStore, noteId)
}

// ---------- transcript chunk count ----------

/** Ids of the chunks with text, per watched note. */
const transcriptIds = new Map<string, Set<string>>()
const transcriptStore: Keyed<number> = new Keyed<number>(0, (noteId) => {
  ensureSubscriptions()
  void window.notula.transcript
    .get({ noteId })
    .then((chunks) => {
      const ids = new Set(chunks.filter(countable).map((c) => c.id))
      transcriptIds.set(noteId, ids)
      transcriptStore.set(noteId, ids.size)
    })
    .catch((err: unknown) => debugLog('enhance-transcript-load-failed', { noteId, err }))
})

function countable(c: { text: string }): boolean {
  return c.text !== DELETED_CHUNK_MARKER && c.text.trim().length > 0
}

/** Chunks with text: "has at least one transcript chunk". */
export function useTranscriptCount(noteId: string): number {
  return useKeyed(transcriptStore, noteId)
}

// ---------- one subscription per channel ----------

let subscribed = false

function ensureSubscriptions(): void {
  if (subscribed) return
  subscribed = true
  window.notula.enhance.onEvent(onEnhanceEvent)
  window.notula.notes.onChanged((c) => {
    for (const noteId of panelsStore.keys()) {
      if (c.tables.includes('note_panels') && c.ids.includes(noteId)) void refreshPanels(noteId)
    }
    for (const noteId of noteStore.keys()) {
      if (c.tables.includes('documents') && c.ids.includes(noteId)) void refreshNote(noteId)
    }
  })
  window.notula.transcript.onChanged((p) => {
    if (!transcriptStore.watched(p.noteId)) return
    let ids = transcriptIds.get(p.noteId)
    if (!ids) {
      ids = new Set()
      transcriptIds.set(p.noteId, ids)
    }
    for (const id of p.removedIds) ids.delete(id)
    for (const c of p.upserted) {
      if (countable(c)) ids.add(c.id)
      else ids.delete(c.id)
    }
    // Only a changed count re-renders: live transcription upserts many times a second.
    if (ids.size !== transcriptStore.get(p.noteId)) transcriptStore.set(p.noteId, ids.size)
  })
}
