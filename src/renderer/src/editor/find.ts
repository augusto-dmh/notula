// SPDX-License-Identifier: Apache-2.0
// Find in the editor. A plugin holds the query and the
// current match and draws decorations; the FindBar component drives it.
// Matching is case-insensitive within each text block; inline atoms break a match.

import { Extension } from '@tiptap/core'
import type { Node as PmNode } from '@tiptap/pm/model'
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'

export interface FindMatch {
  from: number
  to: number
}

export interface FindState {
  query: string
  matches: FindMatch[]
  current: number
  decorations: DecorationSet
}

type FindMeta = { query: string } | { current: number }

export const findKey = new PluginKey<FindState>('notulaFind')

const ATOM = '￼'

function search(doc: PmNode, query: string): FindMatch[] {
  if (query === '') return []
  const needle = query.toLowerCase()
  const out: FindMatch[] = []
  doc.descendants((block, blockPos) => {
    if (!block.isTextblock) return true
    let text = ''
    const positions: number[] = []
    block.forEach((child, offset) => {
      const start = blockPos + 1 + offset
      if (child.isText && child.text) {
        for (let i = 0; i < child.text.length; i++) positions.push(start + i)
        text += child.text
      } else {
        positions.push(start)
        text += ATOM
      }
    })
    const hay = text.toLowerCase()
    let i = hay.indexOf(needle)
    while (i !== -1) {
      const from = positions[i]
      const last = positions[i + needle.length - 1]
      if (from !== undefined && last !== undefined) out.push({ from, to: last + 1 })
      i = hay.indexOf(needle, i + Math.max(needle.length, 1))
    }
    return false
  })
  return out
}

function decorate(doc: PmNode, matches: FindMatch[], current: number): DecorationSet {
  if (matches.length === 0) return DecorationSet.empty
  return DecorationSet.create(
    doc,
    matches.map((m, i) =>
      Decoration.inline(m.from, m.to, { class: i === current ? 'ne-find-match ne-find-current' : 'ne-find-match' })
    )
  )
}

function build(doc: PmNode, query: string, current: number): FindState {
  const matches = search(doc, query)
  const clamped = matches.length === 0 ? -1 : Math.min(Math.max(current, 0), matches.length - 1)
  return { query, matches, current: clamped, decorations: decorate(doc, matches, clamped) }
}

export const FindExtension = Extension.create({
  name: 'notulaFind',

  addProseMirrorPlugins() {
    return [
      new Plugin<FindState>({
        key: findKey,
        state: {
          init: () => ({ query: '', matches: [], current: -1, decorations: DecorationSet.empty }),
          apply: (tr, prev) => {
            const meta = tr.getMeta(findKey) as FindMeta | undefined
            if (meta && 'query' in meta) return build(tr.doc, meta.query, 0)
            if (meta && 'current' in meta) {
              return { ...prev, current: meta.current, decorations: decorate(tr.doc, prev.matches, meta.current) }
            }
            if (tr.docChanged && prev.query !== '') return build(tr.doc, prev.query, prev.current)
            return prev
          }
        },
        props: {
          decorations: (state) => findKey.getState(state)?.decorations ?? DecorationSet.empty
        }
      })
    ]
  }
})

export function getFindState(state: EditorState): FindState | undefined {
  return findKey.getState(state)
}

export function setFindQuery(tr: Transaction, query: string): Transaction {
  return tr.setMeta(findKey, { query } satisfies FindMeta)
}

/** Moves to match `index` (wrapping), selects it and scrolls it into view. */
export function gotoMatch(state: EditorState, dispatch: (tr: Transaction) => void, index: number): void {
  const fs = findKey.getState(state)
  if (!fs || fs.matches.length === 0) return
  const n = fs.matches.length
  const current = ((index % n) + n) % n
  const m = fs.matches[current] as FindMatch
  const tr = state.tr
    .setMeta(findKey, { current } satisfies FindMeta)
    .setSelection(TextSelection.create(state.doc, m.from, m.to))
    .scrollIntoView()
  tr.setMeta('addToHistory', false)
  dispatch(tr)
}
