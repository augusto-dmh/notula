// SPDX-License-Identifier: Apache-2.0
// The draft button on summary lines.
//
// - A paragraph whose `actionItemId` is in the source's items gets an envelope (email) or
//   chat-bubble (Slack) button at its end, shown on hover, while the caret is in the line
//   and while the button has focus.
// - The line must still read as it did when main stamped it: the SHA-256 of `lineKey` of the
//   paragraph's text has to start with the item's stored fingerprint. Hashing is async, so a
//   text seen for the first time is hashed in the background and the lines are rebuilt when
//   the hash is ready. An edited line loses its button; undoing the edit brings it back.
// - Tab with the caret at the end of such a line moves focus to its button (elsewhere Tab
//   keeps its editing meaning). In a read-only summary the button is in the normal tab order.
// - Which items qualify, and the click, come from the action-items feature through
//   `setActionItemDrafts`, like the thumbs.

import { Extension } from '@tiptap/core'
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'
import { LINE_FINGERPRINT_LENGTH, lineKey } from '@shared/lib/action-line'
import type { ActionItemChannel } from '@shared/types/action-items'
import { ACTION_ITEM_ATTR } from './action-item-thumbs'

export interface DraftLine {
  channel: ActionItemChannel
  lineFingerprint: string
}

export interface DraftsSource {
  /** The items that may show a button, by id. */
  items: ReadonlyMap<string, DraftLine>
  onDraft(actionItemId: string): void
}

const LABELS: Record<ActionItemChannel, string> = {
  email: 'Write this email in chat',
  slack: 'Write this Slack message in chat'
}

const ICONS: Record<ActionItemChannel, string> = {
  email:
    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m4 7 8 6 8-6"/></svg>',
  slack:
    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 12a8 8 0 0 1-11.6 7.1L4 20l1-4.2A8 8 0 1 1 20 12z"/></svg>'
}

/** Cached hashes are dropped past this many texts. */
const HASH_CACHE_MAX = 500

let source: DraftsSource | null = null
const views = new Set<EditorView>()
const key = new PluginKey<DecorationSet>('notulaActionItemDrafts')
const hashes = new Map<string, string>()
const hashing = new Set<string>()

function refreshAll(): void {
  for (const v of views) v.dispatch(v.state.tr.setMeta(key, 'refresh'))
}

/** Set by the action-items feature while drafts are on; null removes every button. */
export function setActionItemDrafts(next: DraftsSource | null): void {
  source = next
  refreshAll()
}

function fingerprintOf(text: string): string | null {
  const k = lineKey(text)
  if (!k) return null
  const cached = hashes.get(k)
  if (cached !== undefined) return cached
  if (!hashing.has(k)) {
    hashing.add(k)
    void crypto.subtle
      .digest('SHA-256', new TextEncoder().encode(k))
      .then((digest) => {
        if (hashes.size >= HASH_CACHE_MAX) hashes.clear()
        const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
        hashes.set(k, hex.slice(0, LINE_FINGERPRINT_LENGTH))
        refreshAll()
      })
      .catch(() => undefined)
      .finally(() => hashing.delete(k))
  }
  return null
}

function draftButton(actionItemId: string, channel: ActionItemChannel): HTMLButtonElement {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = `ai-draft ai-draft--${channel}`
  b.dataset['actionItemId'] = actionItemId
  b.setAttribute('aria-label', LABELS[channel])
  b.title = LABELS[channel]
  b.innerHTML = ICONS[channel]
  b.addEventListener('mousedown', (e) => e.preventDefault())
  b.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    source?.onDraft(actionItemId)
  })
  return b
}

function build(state: EditorState): DecorationSet {
  const src = source
  if (!src || src.items.size === 0) return DecorationSet.empty
  const decorations: Decoration[] = []
  const caret = state.selection.$from
  state.doc.descendants((node, pos) => {
    if (node.type.name !== 'paragraph') return true
    const id = typeof node.attrs[ACTION_ITEM_ATTR] === 'string' ? (node.attrs[ACTION_ITEM_ATTR] as string) : null
    const line = id ? src.items.get(id) : undefined
    if (!id || !line || fingerprintOf(node.textContent) !== line.lineFingerprint) return false
    const withCaret = caret.pos > pos && caret.pos < pos + node.nodeSize
    decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: withCaret ? 'ai-draft-line is-caret' : 'ai-draft-line' }))
    decorations.push(
      Decoration.widget(pos + node.nodeSize - 1, () => draftButton(id, line.channel), {
        side: 2,
        ignoreSelection: true,
        stopEvent: () => true,
        key: `ai-draft-${id}-${line.channel}`
      })
    )
    return false
  })
  return DecorationSet.create(state.doc, decorations)
}

/** The button of the line the caret is at the end of, if it has one. */
function buttonAtCaret(view: EditorView): HTMLButtonElement | null {
  const { selection } = view.state
  const $from = selection.$from
  if (!selection.empty || $from.parent.type.name !== 'paragraph' || $from.parentOffset !== $from.parent.content.size) return null
  const id = $from.parent.attrs[ACTION_ITEM_ATTR]
  if (typeof id !== 'string') return null
  const block = view.nodeDOM($from.before())
  return block instanceof HTMLElement ? block.querySelector<HTMLButtonElement>(`.ai-draft[data-action-item-id="${CSS.escape(id)}"]`) : null
}

/** The panel editor's draft buttons. */
export const ActionItemDrafts = Extension.create({
  name: 'notulaActionItemDrafts',
  // Ahead of the notes keymap, which gives Tab its indent meaning.
  priority: 300,

  addKeyboardShortcuts() {
    return {
      Tab: ({ editor }) => {
        const button = buttonAtCaret(editor.view)
        if (!button) return false
        button.focus()
        return true
      }
    }
  },

  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key,
        state: {
          init: (_config, state) => build(state),
          apply: (tr, old, _oldState, newState) => (tr.docChanged || tr.selectionSet || tr.getMeta(key) === 'refresh' ? build(newState) : old)
        },
        props: { decorations: (state) => key.getState(state) },
        view: (view) => {
          views.add(view)
          return { destroy: () => views.delete(view) }
        }
      })
    ]
  }
})
