// SPDX-License-Identifier: Apache-2.0
// Regenerate: a fresh generation into a new panel,
// which becomes the one shown; the old panel is kept. Edited notes regenerated with
// the same template ask first. Clicks are ignored while the note is
// generating.

import { parseError } from '@shared/errors'
import { DEFAULT_TEMPLATE_SLUG } from '@shared/types/enhance'
import type { Panel } from '@shared/types/panels'
import { normalizeMarkdown } from '../../editor'
import { flushStampedProjection } from '../../editor/source-position'
import { debugLog, isOwnNote } from '../../app/platform'
import { showToast } from '../../app/toast'
import { currentPanels, isNoteGenerating, refreshPanels } from './store'
import './enhance.css'

/** The note editor's live markdown, registered by GenerateButton for its note. */
const notesMarkdown = new Map<string, () => string>()

export function registerNotesMarkdown(noteId: string, get: () => string): () => void {
  notesMarkdown.set(noteId, get)
  return () => {
    if (notesMarkdown.get(noteId) === get) notesMarkdown.delete(noteId)
  }
}

export function liveNotesMarkdown(noteId: string): string | undefined {
  try {
    const md = notesMarkdown.get(noteId)?.()
    return md && md.trim() ? md : undefined
  } catch {
    return undefined
  }
}

/**
 * Edited when both the current and the generated markdown exist and differ
 * after the editor's markdown round trip. Both sides are normalized: an untouched
 * panel still holds the raw generated text until its first edit.
 */
export function isEdited(panel: Panel): boolean {
  const current = panel.content_markdown
  const original = panel.generated_content
  if (!current || !original) return false
  try {
    return normalizeMarkdown(original) !== normalizeMarkdown(current)
  } catch {
    return original.trim() !== current.trim()
  }
}

function sameTemplate(panel: Panel, slug: string | undefined): boolean {
  return !slug || (panel.template_key ?? '').toLowerCase() === slug.toLowerCase()
}

let confirming = false

/** The regenerate confirmation, as a native <dialog>. Resolves true on Continue. */
export function confirmRegenerate(): Promise<boolean> {
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog')
    dialog.className = 'enh-dialog'
    dialog.setAttribute('aria-labelledby', 'enh-dialog-title')
    dialog.setAttribute('aria-describedby', 'enh-dialog-body')

    const title = document.createElement('h2')
    title.id = 'enh-dialog-title'
    title.className = 'enh-dialog__title'
    title.textContent = 'Regenerate notes?'
    const body = document.createElement('p')
    body.id = 'enh-dialog-body'
    body.className = 'enh-dialog__body'
    body.textContent = "You’ve edited these enhanced notes. Regenerating replaces those edits with a new version from your notes and the transcript."
    const actions = document.createElement('div')
    actions.className = 'enh-dialog__actions'
    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.className = 'n-btn'
    cancel.textContent = 'Cancel'
    const ok = document.createElement('button')
    ok.type = 'button'
    ok.className = 'n-btn enh-btn--danger'
    ok.textContent = 'Continue'
    actions.append(cancel, ok)
    dialog.append(title, body, actions)

    let settled = false
    const finish = (result: boolean): void => {
      if (settled) return
      settled = true
      if (dialog.open) dialog.close()
      dialog.remove()
      resolve(result)
    }
    cancel.addEventListener('click', () => finish(false))
    ok.addEventListener('click', () => finish(true))
    dialog.addEventListener('cancel', () => finish(false))
    dialog.addEventListener('close', () => finish(false))
    // A click on the backdrop lands on the dialog element itself.
    dialog.addEventListener('mousedown', (e) => {
      if (e.target === dialog) finish(false)
    })
    document.body.append(dialog)
    dialog.showModal()
    cancel.focus()
  })
}

/**
 * Regenerates with `templateSlug` (default: the current panel's template, else the
 * default template). `panel` is the panel on screen, which the edit-confirm protects.
 */
export async function regenerateWith(noteId: string, opts: { panel?: Panel | null; templateSlug?: string }): Promise<void> {
  if (isNoteGenerating(noteId) || confirming) return
  const panel = opts.panel ?? null
  const slug = opts.templateSlug ?? panel?.template_key ?? DEFAULT_TEMPLATE_SLUG
  if (panel && sameTemplate(panel, opts.templateSlug) && isEdited(panel)) {
    confirming = true
    try {
      if (!(await confirmRegenerate())) return
    } finally {
      confirming = false
    }
  }
  debugLog('summary-regenerate', { noteId, panelId: panel?.id ?? null, templateSlug: slug })
  const md = liveNotesMarkdown(noteId)
  try {
    // A source note's stamped notes as typed, not as of the last debounced save.
    await flushStampedProjection(noteId)
    const { panelId } = await window.notula.enhance.generate({ noteId, templateSlug: slug, ...(md ? { notesMarkdown: md } : {}) })
    debugLog('summary-tab-added', { noteId, panelId, templateSlug: slug })
  } catch (err) {
    const e = parseError(err)
    showToast({ kind: 'error', title: 'Couldn’t regenerate notes', description: e.message })
  }
}

/** The public entry point (Shift+Mod+G, toasts): regenerate the given or latest panel. */
export function regenerate(noteId: string, panelId?: string): void {
  void (async () => {
    if (isNoteGenerating(noteId)) return
    const note = await window.notula.notes.get({ id: noteId }).catch(() => null)
    if (!note || !isOwnNote(note)) return
    let panels = currentPanels(noteId)
    if (panels.length === 0) panels = await refreshPanels(noteId)
    const panel = (panelId ? panels.find((p) => p.id === panelId) : panels[0]) ?? panels[0] ?? null
    if (!panel) {
      // Nothing to regenerate yet: a first generation, if there is a transcript.
      const chunks = await window.notula.transcript.get({ noteId }).catch(() => [])
      if (!chunks.some((c) => c.text.trim())) return
    }
    await regenerateWith(noteId, { panel })
  })()
}
