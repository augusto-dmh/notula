// SPDX-License-Identifier: Apache-2.0
// Passages for note chat: locating a passage in
// the editor's plain text, highlighting it, and replacing text on the editor's
// markdown. A replacement re-parses only the top-level blocks it touches, so every
// other block keeps its marks, mentions and attributes.

import type { Editor, JSONContent } from '@tiptap/core'
import type { Node as PmNode } from '@tiptap/pm/model'
import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { blockMarkdown } from './markdown'
import { parseMarkdown, type EditorKind } from './schema'

/** The read-only pause after the old passage goes, then after the new one lands. */
export const EDIT_DELETE_PAUSE_MS = 200
export const EDIT_INSERT_PAUSE_MS = 300
/** The scroll margin above a passage. */
const SCROLL_MARGIN_PX = 100
/** A replaced highlight fades out for this long. */
const FADE_MS = 700

// ---------- the plain-text map ----------

interface PlainMap {
  text: string
  /** The document position of each character of `text` (separators map to the block end). */
  pos: number[]
}

/** The editor's plain text, one line per text block, with each character's position. */
function plainMap(doc: PmNode): PlainMap {
  let text = ''
  const pos: number[] = []
  doc.descendants((node, at) => {
    if (!node.isTextblock) return true
    if (text !== '') {
      text += '\n'
      pos.push(at)
    }
    node.forEach((child, offset) => {
      const start = at + 1 + offset
      if (child.isText) {
        const t = child.text ?? ''
        for (let i = 0; i < t.length; i++) pos.push(start + i)
        text += t
      } else {
        // An inline atom (a mention) reads as its text and maps to itself.
        const t = child.attrs['label'] ? `@${String(child.attrs['label'])}` : ''
        for (let i = 0; i < t.length; i++) pos.push(start)
        text += t
      }
    })
    return false
  })
  return { text, pos }
}

/** Markdown reduced to plain text: block markers, emphasis, link targets and escapes removed. */
export function markdownToPlain(md: string): string {
  return md
    .split(/\r?\n/)
    .map((raw) =>
      raw
        .replace(/^\s*([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/, '')
        .replace(/^\s*#{1,6}\s+/, '')
        .replace(/^\s*>\s?/, '')
        .replace(/^\s*([-*_]\s*){3,}$/, '')
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/(\*\*|__|~~)/g, '')
        .replace(/(^|[^\w])[*_](?=\S)/g, '$1')
        .replace(/(\S)[*_](?=[^\w]|$)/g, '$1')
        .replace(/\\([\\`*_{}[\]()#+\-.!>~|])/g, '$1')
    )
    .join('\n')
}

/**
 * The text reduced to plain text and split into non-empty lines; the
 * passage runs from the first occurrence of its first line to the end of the first
 * occurrence (from there) of its last line. Null when either is missing.
 */
export function locatePassage(doc: PmNode, text: string): { from: number; to: number } | null {
  const lines = markdownToPlain(text)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
  const first = lines[0]
  const last = lines[lines.length - 1]
  if (!first || !last) return null
  const map = plainMap(doc)
  const a = map.text.indexOf(first)
  if (a === -1) return null
  const b = map.text.indexOf(last, a)
  if (b === -1) return null
  const end = b + last.length - 1
  const from = map.pos[a]
  const to = map.pos[end]
  if (from === undefined || to === undefined) return null
  return { from, to: to + 1 }
}

// ---------- decorations ----------

interface PassageState {
  highlight: { from: number; to: number } | null
  fading: { from: number; to: number }[]
  inserted: { from: number; to: number } | null
  decorations: DecorationSet
}

type PassageMeta =
  | { highlight: { from: number; to: number } | null }
  | { inserted: { from: number; to: number } | null }
  | { unfade: true }

export const passageKey = new PluginKey<PassageState>('notulaPassages')

function build(doc: PmNode, s: Omit<PassageState, 'decorations'>): DecorationSet {
  const decos: Decoration[] = []
  const size = doc.content.size
  const add = (r: { from: number; to: number }, cls: string): void => {
    const from = Math.max(0, Math.min(r.from, size))
    const to = Math.max(from, Math.min(r.to, size))
    if (to > from) decos.push(Decoration.inline(from, to, { class: cls }))
  }
  for (const f of s.fading) add(f, 'ne-passage ne-passage--fading')
  if (s.highlight) add(s.highlight, 'ne-passage')
  if (s.inserted) add(s.inserted, 'ne-edit-inserted')
  return DecorationSet.create(doc, decos)
}

function mapRange(tr: Transaction, r: { from: number; to: number } | null): { from: number; to: number } | null {
  if (!r) return null
  const from = tr.mapping.map(r.from, 1)
  const to = tr.mapping.map(r.to, -1)
  return to > from ? { from, to } : null
}

export function passagePlugin(): Plugin<PassageState> {
  return new Plugin<PassageState>({
    key: passageKey,
    state: {
      init: (_config, state) => ({ highlight: null, fading: [], inserted: null, decorations: DecorationSet.create(state.doc, []) }),
      apply: (tr, prev, _old, state: EditorState) => {
        const meta = tr.getMeta(passageKey) as PassageMeta | undefined
        let next = {
          highlight: tr.docChanged ? mapRange(tr, prev.highlight) : prev.highlight,
          fading: tr.docChanged ? prev.fading.map((f) => mapRange(tr, f)).filter((f) => f !== null) : prev.fading,
          inserted: tr.docChanged ? mapRange(tr, prev.inserted) : prev.inserted
        }
        if (meta && 'highlight' in meta) {
          next = { ...next, fading: next.highlight ? [...next.fading, next.highlight] : next.fading, highlight: meta.highlight }
        } else if (meta && 'inserted' in meta) {
          next = { ...next, inserted: meta.inserted }
        } else if (meta && 'unfade' in meta) {
          next = { ...next, fading: [] }
        }
        if (!meta && !tr.docChanged) return prev
        return { ...next, decorations: build(state.doc, next) }
      }
    },
    props: {
      decorations: (state) => passageKey.getState(state)?.decorations ?? null
    }
  })
}

function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const o = getComputedStyle(p).overflowY
    if ((o === 'auto' || o === 'scroll') && p.scrollHeight > p.clientHeight) return p
  }
  return null
}

/** Scrolls smoothly so `pos` sits 100 px below the top, only when it is off screen. */
function scrollToPos(editor: Editor, pos: number): void {
  const sp = scrollParent(editor.view.dom)
  if (!sp) return
  const coords = editor.view.coordsAtPos(pos)
  const box = sp.getBoundingClientRect()
  if (coords.top >= box.top && coords.bottom <= box.bottom) return
  sp.scrollTo({ top: sp.scrollTop + coords.top - box.top - SCROLL_MARGIN_PX, behavior: 'smooth' })
}

const fadeTimers = new WeakMap<Editor, ReturnType<typeof setTimeout>>()

/** Highlights a passage (null clears it); the previous highlight fades out. */
export function highlightPassage(editor: Editor, text: string | null, opts?: { scroll?: boolean }): void {
  if (editor.isDestroyed) return
  const range = text ? locatePassage(editor.state.doc, text) : null
  editor.view.dispatch(editor.state.tr.setMeta(passageKey, { highlight: range } satisfies PassageMeta).setMeta('addToHistory', false))
  const prev = fadeTimers.get(editor)
  if (prev) clearTimeout(prev)
  fadeTimers.set(
    editor,
    setTimeout(() => {
      if (!editor.isDestroyed) editor.view.dispatch(editor.state.tr.setMeta(passageKey, { unfade: true } satisfies PassageMeta))
    }, FADE_MS)
  )
  if (range && opts?.scroll) scrollToPos(editor, range.from)
}

// ---------- replacing on markdown ----------

interface BlockPlan {
  /** Top-level block indexes [first, last] the replacement touches. */
  first: number
  last: number
  /** Their markdown with the old passage removed, and with the new text in its place. */
  without: string
  after: string
  /** The whole document's new markdown (the fallback, set directly). */
  markdown: string
}

/**
 * The first occurrence of `oldText` in the editor's markdown, as the run of top-level
 * blocks it touches and their markdown with the replacement applied. Null when absent.
 */
function planReplacement(doc: PmNode, oldText: string, newText: string): BlockPlan | null {
  if (oldText === '') return null
  const blocks = blockMarkdown(doc)
  const full = blocks.join('')
  const markdown = full.trim()
  const at = markdown.indexOf(oldText)
  if (at === -1) return null
  const start = at + (full.length - full.trimStart().length)
  const end = start + oldText.length
  let offset = 0
  let first = -1
  let last = -1
  blocks.forEach((md, i) => {
    const s = offset
    const e = offset + md.length
    offset = e
    if (md.length === 0) return
    if (first === -1 && start < e) first = i
    if (first !== -1 && s < end) last = i
  })
  if (first === -1 || last === -1) return null
  const segStart = blocks.slice(0, first).join('').length
  const before = blocks.slice(first, last + 1).join('')
  const rel = start - segStart
  const head = before.slice(0, rel)
  const tail = before.slice(rel + oldText.length)
  return {
    first,
    last,
    without: head + tail,
    after: head + newText + tail,
    markdown: markdown.slice(0, at) + newText + markdown.slice(at + oldText.length)
  }
}

/** Document positions [from, to) of top-level blocks first..last. */
function blockRange(doc: PmNode, first: number, last: number): { from: number; to: number } {
  let from = 0
  let to = 0
  doc.forEach((node, offset, index) => {
    if (index === first) from = offset
    if (index === last) to = offset + node.nodeSize
  })
  return { from, to }
}

/** A list item emptied by an edit (`- `) parses without its required paragraph; give it one. */
function repairItems(node: JSONContent): JSONContent {
  const content = node.content?.map(repairItems)
  if ((node.type === 'listItem' || node.type === 'taskItem') && content?.[0]?.type !== 'paragraph') {
    return { ...node, content: [{ type: 'paragraph' }, ...(content ?? [])] }
  }
  return content ? { ...node, content } : node
}

/**
 * `markdown` as a checked document of the editor's own schema instance: nodes of
 * another instance (even an identical one) do not fit and would be dropped on insert.
 */
function parseBlocks(editor: Editor, kind: EditorKind, markdown: string): PmNode {
  const doc = editor.schema.nodeFromJSON(repairItems(parseMarkdown(kind, markdown)))
  doc.check()
  return doc
}

/**
 * Replaces [from, to) with `markdown` parsed as blocks; returns the new blocks' range.
 * The blocks' markdown ends with the blank-line separator to the next block, which the
 * parser would turn into one more empty paragraph on every edit and undo: it goes.
 */
function replaceBlocks(editor: Editor, kind: EditorKind, range: { from: number; to: number }, markdown: string): { from: number; to: number } {
  const body = markdown.replace(/\s+$/, '')
  const parsed = body.trim() ? parseBlocks(editor, kind, body) : null
  const nodes: PmNode[] = []
  parsed?.forEach((n) => nodes.push(n))
  const whole = range.from === 0 && range.to === editor.state.doc.content.size
  if (nodes.length === 0 && whole) {
    const empty = editor.schema.nodes['paragraph']?.createAndFill()
    if (empty) nodes.push(empty)
  }
  const tr = editor.state.tr.replaceWith(range.from, range.to, nodes)
  editor.view.dispatch(tr)
  const size = nodes.reduce((n, node) => n + node.nodeSize, 0)
  return { from: range.from, to: range.from + size }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * The first occurrence of `oldText` in the markdown becomes `newText`.
 * Animated: read-only, delete the old passage, 200 ms, insert the new one, 300 ms,
 * clear the marks. If the animation fails, the new markdown is set directly.
 * Resolves false when the passage is gone.
 */
export async function replacePassage(
  editor: Editor,
  kind: EditorKind,
  oldText: string,
  newText: string,
  opts: { animate?: boolean; setEditable(editable: boolean): void; restoreEditable(): void }
): Promise<boolean> {
  if (editor.isDestroyed) return false
  const plan = planReplacement(editor.state.doc, oldText, newText)
  if (!plan) return false
  const range = blockRange(editor.state.doc, plan.first, plan.last)
  if (!opts.animate) {
    replaceBlocks(editor, kind, range, plan.after)
    return true
  }
  opts.setEditable(false)
  try {
    highlightPassage(editor, null)
    const gap = deleteOldPassage(editor, kind, oldText, range, plan.without)
    await sleep(EDIT_DELETE_PAUSE_MS)
    if (editor.isDestroyed) return true
    const landed = replaceBlocks(editor, kind, gap, plan.after)
    const inserted = (newText.trim() ? locateWithin(editor.state.doc, newText, landed) : null) ?? landed
    editor.view.dispatch(editor.state.tr.setMeta(passageKey, { inserted } satisfies PassageMeta).setMeta('addToHistory', false))
    await sleep(EDIT_INSERT_PAUSE_MS)
    if (!editor.isDestroyed) {
      editor.view.dispatch(editor.state.tr.setMeta(passageKey, { inserted: null } satisfies PassageMeta).setMeta('addToHistory', false))
    }
    return true
  } catch (err) {
    console.error('[notula] edit-animation-failed', err)
    if (editor.isDestroyed) return false
    editor.commands.setContent(repairItems(parseMarkdown(kind, plan.markdown)))
    return true
  } finally {
    opts.restoreEditable()
  }
}

/**
 * The animation's first step: the old passage leaves. Its located text is deleted in
 * place when it lies inside the planned blocks; otherwise those blocks are re-parsed
 * without it. Returns the planned blocks' range afterwards.
 */
function deleteOldPassage(
  editor: Editor,
  kind: EditorKind,
  oldText: string,
  range: { from: number; to: number },
  without: string
): { from: number; to: number } {
  const passage = locatePassage(editor.state.doc, oldText)
  if (!passage || passage.from < range.from || passage.to > range.to) return replaceBlocks(editor, kind, range, without)
  const tr = editor.state.tr.delete(passage.from, passage.to)
  editor.view.dispatch(tr)
  return { from: tr.mapping.map(range.from, -1), to: tr.mapping.map(range.to, 1) }
}

/** `locatePassage` limited to a range of the document. */
function locateWithin(doc: PmNode, text: string, range: { from: number; to: number }): { from: number; to: number } | null {
  const r = locatePassage(doc, text)
  return r && r.from >= range.from && r.to <= range.to ? r : null
}
