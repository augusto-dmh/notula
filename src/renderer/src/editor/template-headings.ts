// SPDX-License-Identifier: Apache-2.0
// Template headings in the user's notes:
// earlier inserted headings go first, each with up to two empty paragraphs after it;
// then each non-empty heading (trimmed) goes in at the top as a marked level-1 heading
// with two empty paragraphs after it; a template without named sections inserts one
// empty paragraph; the cursor lands after the first heading.

import type { Editor } from '@tiptap/core'
import type { Node as PmNode } from '@tiptap/pm/model'
import { TextSelection } from '@tiptap/pm/state'
import { TEMPLATE_HEADING_ATTR } from './schema'

const EMPTY_AFTER = 2

function isTemplateHeading(node: PmNode): boolean {
  return node.type.name === 'heading' && node.attrs[TEMPLATE_HEADING_ATTR] === true
}

function isEmptyParagraph(node: PmNode): boolean {
  return node.type.name === 'paragraph' && node.content.size === 0
}

export function hasTemplateHeadings(doc: PmNode): boolean {
  let found = false
  doc.forEach((node) => {
    if (!found && isTemplateHeading(node)) found = true
  })
  return found
}

export function applyTemplateHeadings(editor: Editor, headings: string[] | null): void {
  if (editor.isDestroyed) return
  const { state, schema } = editor
  const doc = state.doc
  const paragraph = schema.nodes['paragraph']
  const heading = schema.nodes['heading']
  if (!paragraph || !heading) return

  const removals: { from: number; to: number }[] = []
  let removedBlocks = 0
  doc.forEach((node, offset, index) => {
    if (!isTemplateHeading(node)) return
    let to = offset + node.nodeSize
    removedBlocks++
    for (let k = index + 1, n = 0; n < EMPTY_AFTER && k < doc.childCount; k++, n++) {
      const next = doc.child(k)
      if (!isEmptyParagraph(next)) break
      to += next.nodeSize
      removedBlocks++
    }
    removals.push({ from: offset, to })
  })

  const tr = state.tr
  const names = headings === null ? null : headings.map((h) => h.trim()).filter((h) => h !== '')
  // A document is never left without a block.
  if (removedBlocks === doc.childCount && names === null) tr.insert(doc.content.size, paragraph.create())
  for (const r of [...removals].reverse()) tr.delete(r.from, r.to)

  if (names !== null) {
    const nodes =
      names.length === 0
        ? [paragraph.create()]
        : names.flatMap((name) => [
            heading.create({ level: 1, [TEMPLATE_HEADING_ATTR]: true }, schema.text(name)),
            paragraph.create(),
            paragraph.create()
          ])
    tr.insert(0, nodes)
    const first = nodes[0] as PmNode
    const cursor = names.length === 0 ? 1 : first.nodeSize + 1
    tr.setSelection(TextSelection.create(tr.doc, Math.min(cursor, tr.doc.content.size)))
    tr.scrollIntoView()
  }
  if (!tr.docChanged) return
  editor.view.dispatch(tr)
  if (names !== null) editor.view.focus()
}
