// SPDX-License-Identifier: Apache-2.0
// Renderer state for note templates:
// - every visible template (`templates:list`, refreshed on `templates:changed`), with
//   optimistic local edits while the editor autosaves;
// - favourites and usage, which are preferences (`templates.favoriteIds`,
//   `templates.usage`);
// - the temporary template per note, app-wide and mirrored to main;
// - each open note's notes-editor handle, registered by the template chip, so the
//   gallery and the notes menu can insert headings.

import { useSyncExternalStore } from 'react'
import { parseError } from '@shared/errors'
import {
  TEMPLATE_USAGE_DEDUP_MS,
  TEMPLATE_USAGE_MAX,
  type NoteTemplate
} from '@shared/types/templates'
import { debugLog } from '../../app/platform'
import type { EditorHandle } from '../../editor/types'
import { getPrefs, setPrefs, subscribePrefs } from '../settings/prefs-store'

type Listener = () => void

function emitter(): { listeners: Set<Listener>; emit(): void; subscribe(l: Listener): () => void } {
  const listeners = new Set<Listener>()
  return {
    listeners,
    emit: () => {
      for (const l of listeners) l()
    },
    subscribe: (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    }
  }
}

// ---------- the list ----------

export interface TemplatesSnapshot {
  templates: NoteTemplate[]
  loading: boolean
}

const listEvents = emitter()
let snapshot: TemplatesSnapshot = { templates: [], loading: true }
/** Local edits not yet confirmed by a save, by id: they win over a refresh. */
const localEdits = new Map<string, NoteTemplate>()
let started = false
let loadSeq = 0

function merged(list: NoteTemplate[]): NoteTemplate[] {
  return list.map((t) => localEdits.get(t.id) ?? t)
}

export async function refreshTemplates(): Promise<NoteTemplate[]> {
  const seq = ++loadSeq
  try {
    const list = await window.notula.templates.list()
    if (seq === loadSeq) {
      snapshot = { templates: merged(list), loading: false }
      listEvents.emit()
    }
  } catch (err) {
    debugLog('templates-load-failed', { err: parseError(err) })
    if (seq === loadSeq && snapshot.loading) {
      snapshot = { templates: [], loading: false }
      listEvents.emit()
    }
  }
  return snapshot.templates
}

function start(): void {
  if (started) return
  started = true
  window.notula.templates.onChanged(() => void refreshTemplates())
  void refreshTemplates()
}

function subscribeList(l: Listener): () => void {
  start()
  return listEvents.subscribe(l)
}

export function useTemplates(): TemplatesSnapshot {
  return useSyncExternalStore(subscribeList, () => snapshot)
}

export function currentTemplates(): NoteTemplate[] {
  start()
  return snapshot.templates
}

export function templateById(id: string | null | undefined): NoteTemplate | null {
  if (!id) return null
  return snapshot.templates.find((t) => t.id === id) ?? null
}

/** Shows an edit at once; the autosave confirms it. */
export function putLocalTemplate(t: NoteTemplate, opts: { pending: boolean }): void {
  if (opts.pending) localEdits.set(t.id, t)
  else localEdits.delete(t.id)
  const exists = snapshot.templates.some((x) => x.id === t.id)
  const templates = exists ? snapshot.templates.map((x) => (x.id === t.id ? t : x)) : [t, ...snapshot.templates]
  snapshot = { ...snapshot, templates }
  listEvents.emit()
}

export function removeLocalTemplate(id: string): void {
  localEdits.delete(id)
  snapshot = { ...snapshot, templates: snapshot.templates.filter((t) => t.id !== id) }
  listEvents.emit()
}

// ---------- favourites and usage (preferences) ----------

function subscribePrefsList(l: Listener): () => void {
  return subscribePrefs(l)
}

const EMPTY_IDS: string[] = []
const EMPTY_USAGE: Record<string, string[]> = {}

export function useFavoriteIds(): string[] {
  return useSyncExternalStore(subscribePrefsList, () => getPrefs()?.['templates.favoriteIds'] ?? EMPTY_IDS)
}

export function useTemplateUsage(): Record<string, string[]> {
  return useSyncExternalStore(subscribePrefsList, () => getPrefs()?.['templates.usage'] ?? EMPTY_USAGE)
}

export function favoriteIds(): string[] {
  return getPrefs()?.['templates.favoriteIds'] ?? []
}

export function setFavorite(id: string, on: boolean): void {
  const ids = favoriteIds().filter((x) => x !== id)
  setPrefs({ 'templates.favoriteIds': on ? [...ids, id] : ids })
}

/** The newest 10 uses per template; a use within 5 s of the last is ignored. */
export function recordTemplateUse(id: string, now = Date.now()): void {
  const usage = getPrefs()?.['templates.usage'] ?? {}
  const uses = usage[id] ?? []
  const last = uses.length ? Math.max(...uses.map((u) => Date.parse(u)).filter(Number.isFinite)) : NaN
  if (Number.isFinite(last) && now - last < TEMPLATE_USAGE_DEDUP_MS) return
  const next = [new Date(now).toISOString(), ...uses].sort((a, b) => b.localeCompare(a)).slice(0, TEMPLATE_USAGE_MAX)
  setPrefs({ 'templates.usage': { ...usage, [id]: next } })
}

// ---------- the temporary template per note ----------

const tempEvents = emitter()
const temporary = new Map<string, string>()

export function temporaryTemplateId(noteId: string): string | null {
  return temporary.get(noteId) ?? null
}

export function setTemporaryTemplate(noteId: string, templateId: string | null): void {
  if ((temporary.get(noteId) ?? null) === templateId) return
  if (templateId) temporary.set(noteId, templateId)
  else temporary.delete(noteId)
  window.notula.templates.setNoteTemplate({ noteId, templateId })
  tempEvents.emit()
}

export function useTemporaryTemplateId(noteId: string): string | null {
  return useSyncExternalStore(tempEvents.subscribe, () => temporary.get(noteId) ?? null)
}

// ---------- notes editors (registered by the chip) ----------

/**
 * True while Notula itself rewrites the template headings: a template without named
 * sections removes the old headings and inserts none, which must not read as "the
 * user deleted every heading".
 */
let applyingHeadings = 0

export function withHeadingsApplying(fn: () => void): void {
  applyingHeadings++
  try {
    fn()
  } finally {
    applyingHeadings--
  }
}

export function isApplyingHeadings(): boolean {
  return applyingHeadings > 0
}

const editors = new Map<string, EditorHandle>()

export function registerNotesEditor(noteId: string, editor: EditorHandle | null): () => void {
  if (!editor) return () => {}
  editors.set(noteId, editor)
  return () => {
    if (editors.get(noteId) === editor) editors.delete(noteId)
  }
}

export function notesEditorFor(noteId: string): EditorHandle | null {
  return editors.get(noteId) ?? null
}
