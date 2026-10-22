// SPDX-License-Identifier: Apache-2.0
// Video-position stamps on typed paragraphs (content sources).
// - Attributes: `sourcePosition` (ms) and `sourceWall` (epoch ms) on paragraphs, list-item
//   paragraphs included, rendered as `data-source-position` / `data-source-wall`, notes schema
//   only, `keepOnSplit: false` (like `PasteAttributes`).
// - Stamping: the first character typed into an empty, unstamped paragraph stamps it with the
//   video position and the wall time. Typing never re-stamps; pasted or dropped paragraphs,
//   remote and undo changes are never stamped; no stamp without a position, during an ad, while
//   the feed holds stamping, or with `sources.stampPositions` off.
// - Re-stamp: a span the position store closes with a measured rate that differs from the one
//   the stamps used has its paragraphs recomputed from their wall times.
// - Chips: a stamped paragraph shows `[mm:ss]`; a click opens the source at that time.
// - `Ctrl+Alt+T` inserts a linked `[mm:ss]` at the caret; a mark (`sources:mark`) appends an
//   empty stamped paragraph at the end of the note.
// - The stamped Markdown: each stamped paragraph prefixed `[mm:ss](url&t=)`, through the one
//   serializer, saved with `sources:update` on the projection's 10 s schedule and when the editor
//   goes away.
// All of it acts only in the note page's notes editor of the note whose chip registered an
// active source (`features/sources/note/source-store.ts`).

import { Extension, type Editor } from '@tiptap/core'
import { isChangeOrigin } from '@tiptap/extension-collaboration'
import type { Node as PmNode } from '@tiptap/pm/model'
import { Plugin, PluginKey, TextSelection, type Transaction } from '@tiptap/pm/state'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'
import type { SourceMark } from '@shared/types/sources'
import { formatPosition, positionLink } from '@shared/lib/position'
import { debugLog } from '../app/platform'
import { showToast } from '../app/toast'
import {
  getActiveSource,
  onSpanCorrection,
  positionNow,
  startPositionFeed,
  subscribeActiveSource,
  trySources,
  type ActiveSource,
  type SpanCorrection
} from '../features/sources/note/source-store'
import { getPrefs, startPrefs } from '../features/settings/prefs-store'
import { htmlToMarkdown, renderFragment } from './markdown'
import { PASTE_TIMESTAMP } from './paste'

export const SOURCE_POSITION = 'sourcePosition'
export const SOURCE_WALL = 'sourceWall'

/** The projection save debounce, as the notes projection's. */
const STAMPED_DELAY_MS = 10_000

const KEY = new PluginKey<DecorationSet>('notulaSourcePosition')

function readNumber(el: HTMLElement, name: string): number | null {
  const raw = el.getAttribute(name)
  if (raw === null || raw.trim() === '') return null
  const v = Number(raw)
  return Number.isFinite(v) && v >= 0 ? Math.round(v) : null
}

function stampOf(node: PmNode): number | null {
  const v = node.attrs[SOURCE_POSITION] as unknown
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function wallOf(node: PmNode): number | null {
  const v = node.attrs[SOURCE_WALL] as unknown
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** The active source when this editor is the note page's notes editor of that note. */
function binding(view: EditorView | null): ActiveSource | null {
  const a = getActiveSource()
  if (!a || !view) return null
  try {
    return view.dom.closest('.note-column') ? a : null
  } catch {
    return null
  }
}

function stampingOn(): boolean {
  const prefs = getPrefs()
  // Until the first read, the defaults apply (stamping on); the chip only binds while enabled.
  return prefs ? prefs['sources.enabled'] && prefs['sources.stampPositions'] : true
}

/** Typed changes: not remote, undo, paste, drop, or this plugin's own corrections. */
function typed(tr: Transaction): boolean {
  if (!tr.docChanged || isChangeOrigin(tr) || tr.getMeta(KEY) !== undefined) return false
  if (tr.getMeta('paste') || tr.getMeta('addToHistory') === false) return false
  const ui = tr.getMeta('uiEvent') as unknown
  return ui !== 'paste' && ui !== 'drop'
}

/** The ranges typed changes inserted, in the final document's positions. */
function typedRanges(trs: readonly Transaction[]): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = []
  for (const tr of trs) {
    const keep = typed(tr)
    for (const map of tr.mapping.maps) {
      for (const r of out) {
        r.from = map.map(r.from, -1)
        r.to = map.map(r.to, 1)
      }
      if (keep) map.forEach((_os, _oe, from, to) => out.push({ from, to }))
    }
  }
  return out.filter((r) => r.to > r.from)
}

/** The stamped Markdown through the one serializer: `[mm:ss](url&t=) text` per stamped paragraph. */
export function stampedMarkdown(doc: PmNode, url: string | null): string {
  const host = renderFragment(doc.type.schema, doc.content)
  for (const p of Array.from(host.querySelectorAll<HTMLElement>('p[data-source-position]'))) {
    if ((p.textContent ?? '').trim() === '') continue
    const ms = readNumber(p, 'data-source-position')
    if (ms === null) continue
    const label = formatPosition(ms)
    let prefix: Node
    if (url) {
      const a = document.createElement('a')
      a.setAttribute('href', positionLink(url, ms))
      a.textContent = label
      prefix = a
    } else {
      prefix = document.createTextNode(`[${label}]`)
    }
    p.insertBefore(document.createTextNode(' '), p.firstChild)
    p.insertBefore(prefix, p.firstChild)
  }
  return htmlToMarkdown(host)
}

function openAt(url: string, ms: number): void {
  window.open(positionLink(url, ms), '_blank', 'noopener')
}

function chip(ms: number, url: string | null): HTMLElement {
  const label = formatPosition(ms)
  if (!url) {
    const span = document.createElement('span')
    span.className = 'ne-stamp ne-stamp--static'
    span.contentEditable = 'false'
    span.textContent = label
    span.setAttribute('aria-label', `Video position ${label}`)
    return span
  }
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'ne-stamp'
  button.contentEditable = 'false'
  button.textContent = label
  button.title = `Open the video at ${label}`
  button.setAttribute('aria-label', `Open the video at ${label}`)
  // Keep the caret where it is.
  button.addEventListener('mousedown', (e) => e.preventDefault())
  button.addEventListener('click', (e) => {
    e.preventDefault()
    openAt(url, ms)
  })
  return button
}

function buildDecorations(doc: PmNode, a: ActiveSource | null): DecorationSet {
  if (!a) return DecorationSet.empty
  const decos: Decoration[] = []
  doc.descendants((node, pos) => {
    if (node.type.name !== 'paragraph') return true
    const ms = stampOf(node)
    if (ms !== null) {
      decos.push(
        Decoration.widget(pos + 1, () => chip(ms, a.url), {
          side: -1,
          ignoreSelection: true,
          key: `stamp:${ms}:${a.url ?? ''}`,
          stopEvent: () => true
        })
      )
    }
    return false
  })
  return DecorationSet.create(doc, decos)
}

/** Recomputes a closed span's stamps with its measured rate. */
function restamp(view: EditorView, c: SpanCorrection): void {
  const a = binding(view)
  if (!a || a.noteId !== c.noteId || !view.editable) return
  const tr = view.state.tr
  view.state.doc.descendants((node, pos) => {
    if (node.type.name !== 'paragraph') return true
    const wall = wallOf(node)
    if (wall !== null && wall >= c.wallStart && wall <= c.wallEnd) {
      const next = Math.max(0, Math.round(c.posStart + (wall - c.wallStart) * c.rate))
      if (next !== stampOf(node)) tr.setNodeMarkup(pos, undefined, { ...node.attrs, [SOURCE_POSITION]: next })
    }
    return false
  })
  if (!tr.docChanged) return
  tr.setMeta(KEY, 'restamp').setMeta('addToHistory', false)
  view.dispatch(tr)
}

/** A mark: an empty paragraph stamped at the marked position, at the end of the note. */
function appendMark(view: EditorView, m: SourceMark): void {
  const a = binding(view)
  if (!a || a.noteId !== m.noteId || !view.editable) return
  const { state } = view
  const paragraph = state.schema.nodes['paragraph']
  if (!paragraph) return
  const attrs = { [SOURCE_POSITION]: Math.max(0, Math.round(m.positionMs)), [SOURCE_WALL]: m.wallMs }
  const tr = state.tr
  const last = state.doc.lastChild
  let at: number
  if (last && last.type === paragraph && last.content.size === 0 && stampOf(last) === null) {
    at = state.doc.content.size - last.nodeSize
    tr.setNodeMarkup(at, undefined, { ...last.attrs, ...attrs })
  } else {
    at = state.doc.content.size
    tr.insert(at, paragraph.create(attrs))
  }
  tr.setSelection(TextSelection.create(tr.doc, at + 1)).scrollIntoView()
  tr.setMeta(KEY, 'mark')
  view.dispatch(tr)
}

/** `Ctrl+Alt+T`: a linked `[mm:ss]` at the caret. */
function insertTimestamp(editor: Editor): boolean {
  if (!editor.isEditable) return false
  const a = binding(editor.view)
  if (!a) return false
  const now = positionNow(a.noteId, a.canonicalKey)
  if (!now) {
    showToast({ id: 'source-no-position', title: 'No video position yet', description: 'Play the video, then insert the timestamp.' })
    return true
  }
  const text = `[${formatPosition(now.positionMs)}]`
  const marks = a.url ? [{ type: 'link', attrs: { href: positionLink(a.url, now.positionMs) } }] : []
  return editor
    .chain()
    .focus()
    .insertContent([
      { type: 'text', text, marks },
      { type: 'text', text: ' ' }
    ])
    .run()
}

interface StampedStorage {
  dirty: boolean
  timer: ReturnType<typeof setTimeout> | null
  /** The note and URL the pending projection belongs to, captured when it went dirty. */
  target: ActiveSource | null
  /** The last stamped Markdown saved (or loaded) per note. */
  saved: Map<string, string>
  /** The last save in flight, so a flush can wait for it. */
  pending: Promise<unknown> | null
  off: (() => void) | null
}

/** Every mounted editor's flush of its pending stamped projection for a note. */
const stampedFlushers = new Set<(noteId: string) => Promise<void>>()

/**
 * Writes a note's pending stamped projection now and waits for it, so a reader in main sees the
 * text as typed: Generate reads `notes_md_stamped`. Resolves at once without one.
 */
export async function flushStampedProjection(noteId: string): Promise<void> {
  await Promise.all([...stampedFlushers].map((flush) => flush(noteId)))
}

function saveStamped(storage: StampedStorage, noteId: string, md: string): void {
  if (storage.saved.get(noteId) === md) return
  storage.saved.set(noteId, md)
  storage.pending = trySources('sources:stamped-save-failed', () =>
    window.notula.sources.update({ noteId, patch: { notes_md_stamped: md } })
  )
}

function flushStamped(editor: Editor, storage: StampedStorage): void {
  if (storage.timer) {
    clearTimeout(storage.timer)
    storage.timer = null
  }
  const target = storage.target
  if (!storage.dirty || !target) return
  storage.dirty = false
  try {
    saveStamped(storage, target.noteId, stampedMarkdown(editor.state.doc, target.url))
  } catch (err) {
    debugLog('sources:stamped-projection-failed', { err: String(err) })
  }
}

export const SourcePosition = Extension.create<Record<string, never>, StampedStorage>({
  name: 'notulaSourcePosition',

  addGlobalAttributes() {
    return [
      {
        types: ['paragraph'],
        attributes: {
          [SOURCE_POSITION]: {
            default: null,
            keepOnSplit: false,
            parseHTML: (el) => readNumber(el, 'data-source-position'),
            renderHTML: (attrs) =>
              typeof attrs[SOURCE_POSITION] === 'number' ? { 'data-source-position': String(attrs[SOURCE_POSITION]) } : {}
          },
          [SOURCE_WALL]: {
            default: null,
            keepOnSplit: false,
            parseHTML: (el) => readNumber(el, 'data-source-wall'),
            renderHTML: (attrs) => (typeof attrs[SOURCE_WALL] === 'number' ? { 'data-source-wall': String(attrs[SOURCE_WALL]) } : {})
          }
        }
      }
    ]
  },

  addStorage() {
    return { dirty: false, timer: null, target: null, saved: new Map<string, string>(), pending: null, off: null }
  },

  addKeyboardShortcuts() {
    return {
      'Mod-Alt-t': () => insertTimestamp(this.editor)
    }
  },

  addProseMirrorPlugins() {
    const editor = this.editor
    const storage = this.storage
    return [
      new Plugin<DecorationSet>({
        key: KEY,
        state: {
          init: () => DecorationSet.empty,
          apply: (tr, set, _old, state) => {
            if (tr.getMeta(KEY) === 'refresh' || tr.docChanged) {
              return buildDecorations(state.doc, binding(editor.view))
            }
            return set
          }
        },
        props: {
          decorations: (state) => KEY.getState(state) ?? DecorationSet.empty
        },
        appendTransaction: (trs, _oldState, newState) => {
          if (!trs.some((tr) => tr.docChanged)) return null
          try {
            if (!editor.isEditable) return null
          } catch {
            // Not mounted yet: nothing is typed before the view exists.
            return null
          }
          const a = binding(editor.view)
          if (!a || !stampingOn()) return null
          const ranges = typedRanges(trs)
          if (ranges.length === 0) return null
          const targets = new Map<number, PmNode>()
          for (const r of ranges) {
            newState.doc.nodesBetween(r.from, r.to, (node, pos) => {
              if (node.type.name !== 'paragraph') return true
              const start = pos + 1
              const end = start + node.content.size
              // The whole paragraph is what was just typed: its first character.
              if (stampOf(node) === null && node.attrs[PASTE_TIMESTAMP] == null && node.content.size > 0 && r.from <= start && r.to >= end) {
                targets.set(pos, node)
              }
              return false
            })
          }
          if (targets.size === 0) return null
          const now = positionNow(a.noteId, a.canonicalKey)
          if (!now) return null
          const tr = newState.tr
          for (const [pos, node] of targets) {
            tr.setNodeMarkup(pos, undefined, { ...node.attrs, [SOURCE_POSITION]: now.positionMs, [SOURCE_WALL]: now.wallMs })
          }
          return tr.setMeta(KEY, 'stamp')
        },
        view: (view) => {
          startPrefs()
          startPositionFeed()
          let alive = true
          const refresh = (): void => {
            if (!alive) return
            try {
              view.dispatch(view.state.tr.setMeta(KEY, 'refresh'))
            } catch {
              // The view went away between the event and this dispatch.
            }
            // A newly bound note: bring its stored stamped projection up to date.
            const a = binding(view)
            if (a && view.editable) {
              if (storage.target && storage.target.noteId !== a.noteId) flushStamped(editor, storage)
              if (a.stamped !== null && !storage.saved.has(a.noteId)) storage.saved.set(a.noteId, a.stamped)
              storage.target = a
              storage.dirty = true
              flushStamped(editor, storage)
            }
          }
          const offActive = subscribeActiveSource(refresh)
          const offCorrection = onSpanCorrection((c) => restamp(view, c))
          const offMark = window.notula.sources.onMark((m) => appendMark(view, m))
          const t = setTimeout(refresh, 0)
          return {
            destroy: () => {
              alive = false
              clearTimeout(t)
              offActive()
              offCorrection()
              offMark()
            }
          }
        }
      })
    ]
  },

  onCreate() {
    const editor = this.editor
    const storage = this.storage
    const onHide = (): void => {
      if (document.visibilityState === 'hidden') flushStamped(editor, storage)
    }
    const onPageHide = (): void => flushStamped(editor, storage)
    const flusher = async (noteId: string): Promise<void> => {
      if (storage.target?.noteId === noteId) flushStamped(editor, storage)
      await storage.pending
    }
    window.addEventListener('pagehide', onPageHide)
    document.addEventListener('visibilitychange', onHide)
    stampedFlushers.add(flusher)
    storage.off = () => {
      window.removeEventListener('pagehide', onPageHide)
      document.removeEventListener('visibilitychange', onHide)
      stampedFlushers.delete(flusher)
    }
  },

  onUpdate({ transaction }) {
    if (isChangeOrigin(transaction)) return
    const a = binding(this.editor.view)
    if (!a) return
    const storage = this.storage
    if (storage.target && storage.target.noteId !== a.noteId) flushStamped(this.editor, storage)
    storage.target = a
    storage.dirty = true
    storage.timer ??= setTimeout(() => flushStamped(this.editor, storage), STAMPED_DELAY_MS)
  },

  onDestroy() {
    flushStamped(this.editor, this.storage)
    this.storage.off?.()
    this.storage.off = null
  }
})
