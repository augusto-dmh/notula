// SPDX-License-Identifier: Apache-2.0
// The outliner's keys: Enter, Tab, Shift-Tab, Backspace, Mod-ArrowUp,
// Mod-ArrowDown, Shift-Mod-Enter, the four marks and the `[ ]` / `[]` task rule. ArrowUp and
// ArrowDown keep the browser's own line movement (which keeps the horizontal position).
// Mod-Enter (dispatch to a hosted agent) is not built and does nothing.

import { baseKeymap, toggleMark } from '@tiptap/pm/commands'
import { history, redo, undo } from '@tiptap/pm/history'
import { InputRule, inputRules } from '@tiptap/pm/inputrules'
import { keymap } from '@tiptap/pm/keymap'
import { Fragment, type Node as PMNode, type ResolvedPos } from '@tiptap/pm/model'
import { Plugin, TextSelection, type Command, type EditorState, type Transaction } from '@tiptap/pm/state'
import { newId, schema, type BulletAttrs } from './schema'

const { bullet, bulletContent } = schema.nodes

/** The depth of the bullet that holds `$pos` (its line is one deeper), or -1. */
function bulletDepth($pos: ResolvedPos): number {
  for (let d = $pos.depth; d > 0; d--) if ($pos.node(d).type === bullet) return d
  return -1
}

/** Index of the first bullet among a parent's children (a bullet's first child is its line). */
function firstBulletIndex(parent: PMNode): number {
  return parent.type === bullet ? 1 : 0
}

/** Position of child `i` of the node whose content starts at `start`. */
function childPos(parent: PMNode, start: number, i: number): number {
  let pos = start
  for (let k = 0; k < i; k++) pos += parent.child(k).nodeSize
  return pos
}

/** The selected sibling bullets: the one at the selection start through the one at its end, on one level. */
function selectedSiblings(state: EditorState): { depth: number; parentDepth: number; from: number; to: number } | null {
  const { $from, $to } = state.selection
  const depth = bulletDepth($from)
  if (depth < 0) return null
  const parentDepth = depth - 1
  const from = $from.index(parentDepth)
  let to = from
  if ($to.depth >= depth && $to.start(parentDepth) === $from.start(parentDepth)) to = Math.max(from, $to.index(parentDepth))
  return { depth, parentDepth, from, to }
}

function keepSelection(tr: Transaction, state: EditorState, oldStart: number, newStart: number): void {
  const { anchor, head } = state.selection
  const map = (p: number): number => Math.max(0, Math.min(tr.doc.content.size, newStart + (p - oldStart)))
  tr.setSelection(TextSelection.create(tr.doc, map(anchor), map(head)))
}

// ---------- Enter ----------

/** The text after the caret moves into a new sibling right after this bullet; the caret follows. */
export const splitBullet: Command = (state, dispatch) => {
  const { $from, empty } = state.selection
  if ($from.parent.type !== bulletContent) return false
  if (!dispatch) return true
  let tr = state.tr
  if (!empty) tr = tr.deleteSelection()
  const $pos = tr.selection.$from
  const depth = bulletDepth($pos)
  if (depth < 0) return false
  const current = $pos.node(depth)
  const after = $pos.parent.content.cut($pos.parentOffset)
  const bulletEnd = $pos.after(depth)
  tr.delete($pos.pos, $pos.end())
  const attrs: Partial<BulletAttrs> = { id: newId(), isTask: (current.attrs as BulletAttrs).isTask }
  const created = bullet.create(attrs, bulletContent.create(null, after))
  const insertAt = tr.mapping.map(bulletEnd)
  tr.insert(insertAt, created)
  tr.setSelection(TextSelection.create(tr.doc, insertAt + 2))
  dispatch(tr.scrollIntoView())
  return true
}

// ---------- Tab / Shift-Tab ----------

/** The selected bullets become children of the previous sibling (nothing when there is none). */
export const indent: Command = (state, dispatch) => {
  const sel = selectedSiblings(state)
  if (!sel) return false
  const { $from } = state.selection
  const parent = $from.node(sel.parentDepth)
  if (sel.from - 1 < firstBulletIndex(parent)) return true
  if (!dispatch) return true
  const start = $from.start(sel.parentDepth)
  const prevPos = childPos(parent, start, sel.from - 1)
  const prev = parent.child(sel.from - 1)
  const blockStart = childPos(parent, start, sel.from)
  const blockEnd = childPos(parent, start, sel.to + 1)
  const moved = parent.content.cut(blockStart - start, blockEnd - start)
  const tr = state.tr
  tr.delete(blockStart, blockEnd)
  // The previous sibling ends before the block, so its position is unchanged by the delete.
  const insertAt = prevPos + prev.nodeSize - 1
  tr.insert(insertAt, moved)
  if ((prev.attrs as BulletAttrs).collapsed) tr.setNodeMarkup(prevPos, undefined, { ...prev.attrs, collapsed: false })
  keepSelection(tr, state, blockStart, insertAt)
  dispatch(tr.scrollIntoView())
  return true
}

/** The selected bullets move out one level, right after their parent. */
export const outdent: Command = (state, dispatch) => {
  const sel = selectedSiblings(state)
  if (!sel) return false
  const { $from } = state.selection
  if (sel.parentDepth < 1) return true
  if (!dispatch) return true
  const parent = $from.node(sel.parentDepth)
  const start = $from.start(sel.parentDepth)
  const parentEnd = $from.after(sel.parentDepth)
  const blockStart = childPos(parent, start, sel.from)
  const blockEnd = childPos(parent, start, sel.to + 1)
  const moved = parent.content.cut(blockStart - start, blockEnd - start)
  const tr = state.tr
  tr.delete(blockStart, blockEnd)
  const insertAt = parentEnd - (blockEnd - blockStart)
  tr.insert(insertAt, moved)
  keepSelection(tr, state, blockStart, insertAt)
  dispatch(tr.scrollIntoView())
  return true
}

// ---------- Backspace / Delete ----------

/** The visually previous bullet of the bullet at `pos` (depth `depth`): the last visible line above it. */
function previousLine(doc: PMNode, pos: number): { pos: number; node: PMNode; isParent: boolean } | null {
  const $pos = doc.resolve(pos)
  const depth = $pos.depth + 1
  const parentDepth = depth - 1
  const parent = $pos.node(parentDepth)
  const index = $pos.index(parentDepth)
  if (index - 1 >= firstBulletIndex(parent)) {
    let p = childPos(parent, $pos.start(parentDepth), index - 1)
    let node = parent.child(index - 1)
    // Descend to the last visible descendant.
    while (!(node.attrs as BulletAttrs).collapsed && node.childCount > 1) {
      const last = node.childCount - 1
      p = childPos(node, p + 1, last)
      node = node.child(last)
    }
    return { pos: p, node, isParent: false }
  }
  if (parentDepth >= 1) return { pos: $pos.before(parentDepth), node: parent, isParent: true }
  return null
}

/** Backspace at a line start: the bullet at `pos` merges into the previous line; its children follow. */
function mergeIntoPrevious(state: EditorState, pos: number): Transaction | null {
  const b = state.doc.nodeAt(pos)
  if (!b || b.type !== bullet) return null
  const target = previousLine(state.doc, pos)
  if (!target) return null
  const text = b.child(0).content
  const kids = b.content.cut(b.child(0).nodeSize)
  const tr = state.tr
  tr.delete(pos, pos + b.nodeSize)
  const tPos = tr.mapping.map(target.pos)
  const t = tr.doc.nodeAt(tPos)
  if (!t) return null
  const lineEnd = tPos + 1 + t.child(0).nodeSize - 1
  tr.insert(lineEnd, text)
  if (kids.size > 0) {
    // Under the parent the children keep the bullet's place; under a previous line they follow it.
    const at = target.isParent ? tr.mapping.map(pos) : tPos + tr.doc.nodeAt(tPos)!.nodeSize - 1
    tr.insert(at, kids)
  }
  const after = tr.doc.nodeAt(tPos)!
  if ((after.attrs as BulletAttrs).collapsed) tr.setNodeMarkup(tPos, undefined, { ...after.attrs, collapsed: false })
  tr.setSelection(TextSelection.create(tr.doc, lineEnd))
  return tr
}

export const backspaceAtStart: Command = (state, dispatch) => {
  const { $from, empty } = state.selection
  if (!empty || $from.parent.type !== bulletContent || $from.parentOffset !== 0) return false
  const depth = bulletDepth($from)
  const tr = mergeIntoPrevious(state, $from.before(depth))
  // At the very start of the day nothing happens (no join into nowhere).
  if (!tr) return true
  if (dispatch) dispatch(tr.scrollIntoView())
  return true
}

/** The next visible line after the bullet at depth `depth` of `$pos`. */
function nextLinePos($pos: ResolvedPos, depth: number): number | null {
  const node = $pos.node(depth)
  const bPos = $pos.before(depth)
  if (!(node.attrs as BulletAttrs).collapsed && node.childCount > 1) return bPos + 1 + node.child(0).nodeSize
  for (let d = depth; d >= 1; d--) {
    const after = $pos.after(d)
    const parent = $pos.node(d - 1)
    const index = $pos.index(d - 1)
    if (index + 1 < parent.childCount) return after
  }
  return null
}

/** Delete at the end of a line pulls the next line up into it (the mirror of Backspace). */
export const deleteAtEnd: Command = (state, dispatch) => {
  const { $from, empty } = state.selection
  if (!empty || $from.parent.type !== bulletContent || $from.parentOffset !== $from.parent.content.size) return false
  const depth = bulletDepth($from)
  const next = nextLinePos($from, depth)
  if (next === null) return true
  const tr = mergeIntoPrevious(state, next)
  if (!tr) return true
  if (dispatch) dispatch(tr.scrollIntoView())
  return true
}

// ---------- Mod-ArrowUp / Mod-ArrowDown ----------

function swap(dir: -1 | 1): Command {
  return (state, dispatch) => {
    const { $from } = state.selection
    const depth = bulletDepth($from)
    if (depth < 0) return false
    const parentDepth = depth - 1
    const parent = $from.node(parentDepth)
    const index = $from.index(parentDepth)
    const other = index + dir
    if (other < firstBulletIndex(parent) || other >= parent.childCount) return true
    if (!dispatch) return true
    const start = $from.start(parentDepth)
    const bPos = childPos(parent, start, index)
    const b = parent.child(index)
    const o = parent.child(other)
    const tr = state.tr
    if (dir === -1) {
      const oPos = childPos(parent, start, other)
      tr.replaceWith(oPos, bPos + b.nodeSize, Fragment.from([b, o]))
      keepSelection(tr, state, bPos, oPos)
    } else {
      tr.replaceWith(bPos, bPos + b.nodeSize + o.nodeSize, Fragment.from([o, b]))
      keepSelection(tr, state, bPos, bPos + o.nodeSize)
    }
    dispatch(tr.scrollIntoView())
    return true
  }
}

// ---------- Shift-Mod-Enter ----------

/** Completed toggles on the bullet and every descendant, and collapsed follows it (completing folds). */
export const toggleCompleted: Command = (state, dispatch) => {
  const { $from } = state.selection
  const depth = bulletDepth($from)
  if (depth < 0) return false
  if (!dispatch) return true
  const pos = $from.before(depth)
  const node = $from.node(depth)
  const next = !(node.attrs as BulletAttrs).completed
  const tr = state.tr
  const apply = (n: PMNode, p: number): void => {
    tr.setNodeMarkup(p, undefined, { ...n.attrs, completed: next, collapsed: next && n.childCount > 1 })
  }
  apply(node, pos)
  node.descendants((child, offset) => {
    if (child.type === bullet) apply(child, pos + 1 + offset)
    return child.type === bullet
  })
  dispatch(tr)
  return true
}

/** Toggles one bullet attribute at a position (the gutter's triangle and checkbox). */
export function toggleAttr(state: EditorState, pos: number, attr: 'collapsed' | 'completed'): Transaction | null {
  const node = state.doc.nodeAt(pos)
  if (!node || node.type !== bullet) return null
  return state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, [attr]: !(node.attrs as BulletAttrs)[attr] })
}

// ---------- the task input rule ----------

const taskRule = new InputRule(/^\[ ?\]$/, (state, _match, start, end) => {
  const $start = state.doc.resolve(start)
  if ($start.parent.type !== bulletContent || $start.parentOffset !== 0) return null
  const depth = bulletDepth($start)
  const pos = $start.before(depth)
  const node = state.doc.nodeAt(pos)
  if (!node) return null
  return state.tr.delete(start, end).setNodeMarkup(pos, undefined, { ...node.attrs, isTask: true })
})

// ---------- unique ids ----------

/** Re-issues a fresh id to any bullet whose id is missing or duplicated. */
const uniqueIds = new Plugin({
  appendTransaction(trs, _old, state) {
    if (!trs.some((t) => t.docChanged)) return null
    const seen = new Set<string>()
    let tr: Transaction | null = null
    state.doc.descendants((node, pos) => {
      if (node.type !== bullet) return false
      const id = (node.attrs as BulletAttrs).id
      if (!id || seen.has(id)) {
        tr ??= state.tr
        tr.setNodeMarkup(pos, undefined, { ...node.attrs, id: newId() })
      } else seen.add(id)
      return true
    })
    return tr
  }
})

export function outlinePlugins(): Plugin[] {
  const marks = schema.marks
  return [
    history(),
    inputRules({ rules: [taskRule] }),
    keymap({
      Enter: splitBullet,
      Tab: indent,
      'Shift-Tab': outdent,
      Backspace: backspaceAtStart,
      Delete: deleteAtEnd,
      'Mod-ArrowUp': swap(-1),
      'Mod-ArrowDown': swap(1),
      'Shift-Mod-Enter': toggleCompleted,
      // Dispatch is not built.
      'Mod-Enter': () => true,
      'Mod-b': toggleMark(marks.bold),
      'Mod-i': toggleMark(marks.italic),
      'Mod-e': toggleMark(marks.code),
      'Mod-Shift-x': toggleMark(marks.strike),
      'Mod-z': undo,
      'Mod-y': redo,
      'Shift-Mod-z': redo
    }),
    keymap(baseKeymap),
    uniqueIds
  ]
}
