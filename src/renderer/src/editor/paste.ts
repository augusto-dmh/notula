// SPDX-License-Identifier: Apache-2.0
// Paste rules.
// - Plain-text markdown is parsed into rich content (not for Mod-Shift-V, which
//   pastes as plain text).
// - In the notes editor every pasted top-level paragraph is tagged
//   `do-not-annotate` with a paste timestamp, and an empty paragraph goes before
//   the first one when the paste starts with whole blocks.
// - Pasted or dropped images are ignored here; the attachments feature handles them.

import { Extension, type JSONContent } from '@tiptap/core'
import { Fragment, Slice, type Node as PmNode } from '@tiptap/pm/model'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { sanitizeLinks } from './links'

export const DO_NOT_ANNOTATE = 'do-not-annotate'
export const PASTE_TIMESTAMP = 'paste-timestamp'

/** The two paste attributes on paragraphs; they render as data attributes. */
export const PasteAttributes = Extension.create({
  name: 'notulaPasteAttributes',

  addGlobalAttributes() {
    return [
      {
        types: ['paragraph'],
        attributes: {
          [DO_NOT_ANNOTATE]: {
            default: null,
            keepOnSplit: false,
            parseHTML: (el) => (el.getAttribute('data-do-not-annotate') === 'true' ? true : null),
            renderHTML: (attrs) => (attrs[DO_NOT_ANNOTATE] ? { 'data-do-not-annotate': 'true' } : {})
          },
          [PASTE_TIMESTAMP]: {
            default: null,
            keepOnSplit: false,
            parseHTML: (el) => {
              const v = Number(el.getAttribute('data-paste-timestamp'))
              return Number.isFinite(v) && v > 0 ? v : null
            },
            renderHTML: (attrs) =>
              attrs[PASTE_TIMESTAMP] ? { 'data-paste-timestamp': String(attrs[PASTE_TIMESTAMP]) } : {}
          }
        }
      }
    ]
  }
})

const MARKDOWN_HINT =
  /(^|\n)\s{0,3}(#{1,6}\s|[-*+]\s|\d+[.)]\s|- \[[ xX]\]\s|>\s|```|---\s*$)|\*\*[^*\n]+\*\*|__[^_\n]+__|\[[^\]\n]+\]\([^)\s]+\)/

function looksLikeMarkdown(text: string): boolean {
  return MARKDOWN_HINT.test(text)
}

function hasImageFiles(data: DataTransfer | null): boolean {
  if (!data) return false
  return Array.from(data.files).some((f) => f.type.startsWith('image/'))
}

function tagSlice(slice: Slice, at: number): Slice {
  const nodes: PmNode[] = []
  let tagged = false
  slice.content.forEach((node, _offset, index) => {
    if (node.type.name === 'paragraph') {
      tagged = true
      // An open-start paragraph merges into the one at the caret and keeps that one's attributes.
      const mergesIntoCaret = index === 0 && slice.openStart > 0
      nodes.push(mergesIntoCaret ? node : node.type.create({ ...node.attrs, [DO_NOT_ANNOTATE]: true, [PASTE_TIMESTAMP]: at }, node.content, node.marks))
    } else {
      nodes.push(node)
    }
  })
  if (!tagged) return slice
  const first = nodes[0]
  if (slice.openStart === 0 && first?.type.name === 'paragraph') {
    const empty = first.type.createAndFill()
    if (empty) nodes.unshift(empty)
  }
  return new Slice(Fragment.fromArray(nodes), slice.openStart, slice.openEnd)
}

function tagJson(doc: JSONContent, at: number): JSONContent {
  const content = (doc.content ?? []).map((n) =>
    n.type === 'paragraph' ? { ...n, attrs: { ...(n.attrs ?? {}), [DO_NOT_ANNOTATE]: true, [PASTE_TIMESTAMP]: at } } : n
  )
  return { ...doc, content }
}

export interface PasteOptions {
  /** Tag pasted paragraphs (the notes editor only). */
  annotate: boolean
}

interface PasteStorage {
  plainNext: boolean
}

export const NotulaPaste = Extension.create<PasteOptions, PasteStorage>({
  name: 'notulaPaste',

  addOptions() {
    return { annotate: false }
  },

  addStorage() {
    return { plainNext: false }
  },

  addKeyboardShortcuts() {
    return {
      // Let the browser paste; remember that this one is plain text.
      'Mod-Shift-v': () => {
        this.storage.plainNext = true
        setTimeout(() => (this.storage.plainNext = false), 500)
        return false
      }
    }
  },

  addProseMirrorPlugins() {
    const editor = this.editor
    const options = this.options
    const storage = this.storage
    return [
      new Plugin({
        key: new PluginKey('notulaPaste'),
        props: {
          handlePaste: (view, event) => {
            const data = event.clipboardData
            const text = data?.getData('text/plain') ?? ''
            const html = data?.getData('text/html') ?? ''
            if (hasImageFiles(data) && text === '' && html === '') return true
            const plain = storage.plainNext
            storage.plainNext = false
            if (plain || html !== '' || text === '' || !editor.markdown || !looksLikeMarkdown(text)) return false
            if (view.state.selection.$from.parent.type.spec.code) return false
            let parsed = sanitizeLinks(editor.markdown.parse(text))
            if (options.annotate) parsed = tagJson(parsed, Date.now())
            return editor.commands.insertContent(parsed.content ?? [])
          },
          handleDrop: (_view, event) => hasImageFiles((event as DragEvent).dataTransfer),
          transformPasted: (slice) => (options.annotate ? tagSlice(slice, Date.now()) : slice)
        }
      })
    ]
  }
})
