// SPDX-License-Identifier: Apache-2.0
// Keyboard rules of the notes schema.
// - Tab / Shift-Tab: inside lists, sink / lift the item. In paragraphs and headings,
//   add / remove one leading tab character on every selected block.
// - Backspace at the start of a heading turns it into a paragraph.

import { Extension, type Editor } from '@tiptap/core'

const TAB = '\t'
const TEXT_BLOCKS = new Set(['paragraph', 'heading'])

function inList(editor: Editor): 'listItem' | 'taskItem' | null {
  const { $from } = editor.state.selection
  for (let d = $from.depth; d > 0; d--) {
    const name = $from.node(d).type.name
    if (name === 'listItem' || name === 'taskItem') return name
  }
  return null
}

/** Positions (inside the block, before its first character) of the selected text blocks. */
function selectedBlockStarts(editor: Editor): { pos: number; text: string }[] {
  const { from, to } = editor.state.selection
  const out: { pos: number; text: string }[] = []
  editor.state.doc.nodesBetween(from, to, (node, pos) => {
    if (node.isTextblock) {
      if (TEXT_BLOCKS.has(node.type.name)) out.push({ pos: pos + 1, text: node.textContent })
      return false
    }
    return true
  })
  return out
}

/** Runs a list command that the schema may refuse; a refused step is not an error here. */
function tryListCommand(run: () => boolean): void {
  try {
    run()
  } catch {
    // e.g. TransformError "Invalid content for node …": the item stays where it is.
  }
}

function indent(editor: Editor): boolean {
  const list = inList(editor)
  if (list) {
    // Task items do not nest: `sinkListItem` would build an invalid step and
    // throw. Tab is still consumed, so focus stays in the editor.
    if (list === 'listItem') tryListCommand(() => editor.commands.sinkListItem(list))
    return true
  }
  const blocks = selectedBlockStarts(editor)
  if (blocks.length === 0) return false
  const { tr } = editor.state
  for (const b of blocks.reverse()) tr.insertText(TAB, b.pos)
  editor.view.dispatch(tr)
  return true
}

function outdent(editor: Editor): boolean {
  const list = inList(editor)
  if (list) {
    tryListCommand(() => editor.commands.liftListItem(list))
    return true
  }
  const blocks = selectedBlockStarts(editor).filter((b) => b.text.startsWith(TAB))
  if (blocks.length === 0) return true
  const { tr } = editor.state
  for (const b of blocks.reverse()) tr.delete(b.pos, b.pos + TAB.length)
  editor.view.dispatch(tr)
  return true
}

export const NotulaKeys = Extension.create({
  name: 'notulaKeys',
  // Ahead of the list keymaps (priority 100) so one rule decides Tab everywhere.
  priority: 200,

  addKeyboardShortcuts() {
    return {
      Tab: ({ editor }) => (editor.isEditable ? indent(editor) : false),
      'Shift-Tab': ({ editor }) => (editor.isEditable ? outdent(editor) : false),
      Backspace: ({ editor }) => {
        const { empty, $from } = editor.state.selection
        if (!empty || $from.parentOffset !== 0 || $from.parent.type.name !== 'heading') return false
        return editor.commands.setNode('paragraph')
      }
    }
  }
})
