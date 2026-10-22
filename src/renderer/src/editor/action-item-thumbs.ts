// SPDX-License-Identifier: Apache-2.0
// Thumbs on summary lines.
//
// - The panel schema keeps a paragraph attribute `actionItemId` (main writes it into the
//   summary room when it stores a note's action items).
// - A paragraph whose `actionItemId` is a known item, or a paragraph under an action
//   heading, shows a thumbs-up and a thumbs-down on hover, the newest direction
//   highlighted. Lines of one character, lines of only punctuation or symbols, and lines
//   with a link to a note get none.
// - The data and the click handler come from the action-items feature through
//   `setActionItemThumbs` (the editor props stay unchanged), so this module stays UI-agnostic.

import { Extension } from '@tiptap/core'
import type { Node as PmNode } from '@tiptap/pm/model'
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'

export const ACTION_ITEM_ATTR = 'actionItemId'

/** Headings that introduce action items, lower-cased. */
const ACTION_HEADINGS = new Set(['action items', 'actions', 'next steps', 'follow ups', 'to dos', 'todos'])

export type ThumbDirection = 'positive' | 'negative'

export interface ThumbClick {
  panelId: string
  actionItemId: string | null
  headingText: string | null
  itemText: string
  direction: ThumbDirection
  x: number
  y: number
}

export interface ThumbsSource {
  /** The newest feedback direction of each known item (null = none yet). */
  items: ReadonlyMap<string, ThumbDirection | null>
  unlinkedDirection(panelId: string, headingText: string, itemText: string): ThumbDirection | null
  onThumb(click: ThumbClick): void
}

let source: ThumbsSource | null = null
const views = new Set<EditorView>()
const key = new PluginKey<DecorationSet>('notulaActionItemThumbs')

/** Set by the action-items feature while thumbs are on; null turns them off everywhere. */
export function setActionItemThumbs(next: ThumbsSource | null): void {
  source = next
  for (const v of views) v.dispatch(v.state.tr.setMeta(key, 'refresh'))
}

/** Trim, lower-case, drop a trailing `:` or `：`, collapse runs of `-`, `_` and spaces. */
export function normalizeHeading(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[:：]+$/, '')
    .replace(/[-_\s]+/g, ' ')
    .trim()
}

function hasNoteLink(node: PmNode): boolean {
  let found = false
  node.descendants((child) => {
    for (const m of child.marks) {
      const href = String(m.attrs['href'] ?? '')
      if (m.type.name === 'link' && /^(notula:|meeting:|#\/meeting\/|\/meeting\/)/i.test(href)) found = true
    }
    return !found
  })
  return found
}

function eligibleText(node: PmNode): string | null {
  const text = node.textContent.trim()
  if (text.length <= 1 || !/[\p{L}\p{N}]/u.test(text) || hasNoteLink(node)) return null
  return text
}

function thumbButton(direction: ThumbDirection, active: boolean, onClick: (e: MouseEvent) => void): HTMLButtonElement {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = `ai-thumb ai-thumb--${direction === 'positive' ? 'up' : 'down'}${active ? ' is-active' : ''}`
  b.setAttribute('aria-label', direction === 'positive' ? 'Give positive action item feedback' : 'Give negative action item feedback')
  b.setAttribute('aria-pressed', active ? 'true' : 'false')
  b.tabIndex = -1
  b.innerHTML =
    direction === 'positive'
      ? '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 11v9H4.5a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1H7zm0 0 4-7.5a2 2 0 0 1 2.4 2.2L12.8 10H18a2 2 0 0 1 2 2.3l-1.1 6.2a2 2 0 0 1-2 1.5H7"/></svg>'
      : '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 13V4h2.5a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H17zm0 0-4 7.5a2 2 0 0 1-2.4-2.2l.6-4.3H6a2 2 0 0 1-2-2.3l1.1-6.2A2 2 0 0 1 7.1 4H17"/></svg>'
  b.addEventListener('mousedown', (e) => e.preventDefault())
  b.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    onClick(e)
  })
  return b
}

function build(state: EditorState, panelId: string): DecorationSet {
  const src = source
  if (!src) return DecorationSet.empty
  const decorations: Decoration[] = []
  let heading: string | null = null
  state.doc.descendants((node, pos) => {
    if (node.type.name === 'heading') {
      heading = node.textContent
      return false
    }
    if (node.type.name !== 'paragraph') return true
    const text = eligibleText(node)
    if (!text) return false
    const id = typeof node.attrs[ACTION_ITEM_ATTR] === 'string' ? (node.attrs[ACTION_ITEM_ATTR] as string) : null
    const linked = id !== null && src.items.has(id)
    const underHeading = heading !== null && ACTION_HEADINGS.has(normalizeHeading(heading))
    if (!linked && !underHeading) return false
    const headingText: string | null = linked ? null : heading
    const active = linked ? (src.items.get(id as string) ?? null) : src.unlinkedDirection(panelId, headingText as string, text)
    decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: 'ai-line' }))
    decorations.push(
      Decoration.widget(
        pos + node.nodeSize - 1,
        () => {
          const wrap = document.createElement('span')
          wrap.className = 'ai-thumbs'
          wrap.contentEditable = 'false'
          for (const direction of ['positive', 'negative'] as const) {
            wrap.appendChild(
              thumbButton(direction, active === direction, (e) =>
                source?.onThumb({ panelId, actionItemId: linked ? id : null, headingText, itemText: text, direction, x: e.clientX, y: e.clientY })
              )
            )
          }
          return wrap
        },
        { side: 1, ignoreSelection: true, stopEvent: () => true, key: `ai-${pos}-${linked ? id : 'u'}-${active ?? 'none'}` }
      )
    )
    return false
  })
  return DecorationSet.create(state.doc, decorations)
}

/** The panel editor's thumbs; `roomId` is `summary:<v>:<panelId>`. */
export const ActionItemThumbs = Extension.create<{ roomId: string }>({
  name: 'notulaActionItemThumbs',

  addOptions() {
    return { roomId: '' }
  },

  addProseMirrorPlugins() {
    const panelId = this.options.roomId.split(':')[2] ?? ''
    return [
      new Plugin<DecorationSet>({
        key,
        state: {
          init: (_config, state) => build(state, panelId),
          apply: (tr, old, _oldState, newState) => (tr.docChanged || tr.getMeta(key) === 'refresh' ? build(newState, panelId) : old)
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

/** The paragraph attribute the panel schema keeps (`data-todo-id` in HTML). */
export const ActionItemAttribute = Extension.create({
  name: 'notulaActionItemAttribute',

  addGlobalAttributes() {
    return [
      {
        types: ['paragraph'],
        attributes: {
          [ACTION_ITEM_ATTR]: {
            default: null,
            keepOnSplit: false,
            parseHTML: (el) => el.getAttribute('data-todo-id') || null,
            renderHTML: (attrs) => (attrs[ACTION_ITEM_ATTR] ? { 'data-todo-id': String(attrs[ACTION_ITEM_ATTR]) } : {})
          }
        }
      }
    ]
  }
})
