// SPDX-License-Identifier: Apache-2.0
// The scratchpad outline: a document of `bullet` nodes, each one
// `bulletContent` line followed by child bullets. Every bullet attribute is kept, mirrored as a
// `data-*` HTML attribute, so imported outlines round-trip. Marks: bold, italic, code, strike.

import { Schema, type Node as PMNode } from '@tiptap/pm/model'

export const BULLET_ATTRS = {
  id: null as string | null,
  collapsed: false,
  completed: false,
  origin: 'human' as 'human' | 'ai',
  generatedText: null as string | null,
  generatedBlock: null as string | null,
  aiContext: null as string | null,
  isTask: false,
  description: null as string | null,
  dispatchThreadId: null as string | null
}

export type BulletAttrs = typeof BULLET_ATTRS

const DATA_NAMES: Record<keyof BulletAttrs, string> = {
  id: 'data-id',
  collapsed: 'data-collapsed',
  completed: 'data-completed',
  origin: 'data-origin',
  generatedText: 'data-ai-text',
  generatedBlock: 'data-ai-block',
  aiContext: 'data-ai-source',
  isTask: 'data-todo',
  description: 'data-description',
  dispatchThreadId: 'data-thread-ref'
}

const BOOLEAN_ATTRS = new Set<keyof BulletAttrs>(['collapsed', 'completed', 'isTask'])

export function bulletDataAttrs(attrs: BulletAttrs): Record<string, string> {
  const out: Record<string, string> = { 'data-bullet': '' }
  for (const key of Object.keys(DATA_NAMES) as (keyof BulletAttrs)[]) {
    const v = attrs[key]
    if (v === null || v === undefined) continue
    out[DATA_NAMES[key]] = String(v)
  }
  return out
}

function readDataAttrs(el: HTMLElement): Partial<BulletAttrs> {
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(DATA_NAMES) as (keyof BulletAttrs)[]) {
    const raw = el.getAttribute(DATA_NAMES[key])
    if (raw === null) continue
    out[key] = BOOLEAN_ATTRS.has(key) ? raw === 'true' : raw
  }
  return out as Partial<BulletAttrs>
}

export const schema = new Schema({
  nodes: {
    doc: { content: 'bullet+' },
    bullet: {
      content: 'bulletContent bullet*',
      defining: true,
      attrs: Object.fromEntries(Object.entries(BULLET_ATTRS).map(([k, v]) => [k, { default: v }])),
      parseDOM: [{ tag: 'div[data-bullet]', getAttrs: (el) => readDataAttrs(el as HTMLElement) }],
      toDOM: (node) => ['div', bulletDataAttrs(node.attrs as BulletAttrs), 0]
    },
    bulletContent: {
      content: 'text*',
      marks: '_',
      parseDOM: [{ tag: 'div.sp-line' }],
      toDOM: () => ['div', { class: 'sp-line' }, 0]
    },
    text: {}
  },
  marks: {
    bold: { parseDOM: [{ tag: 'strong' }, { tag: 'b' }], toDOM: () => ['strong', 0] },
    italic: { parseDOM: [{ tag: 'em' }, { tag: 'i' }], toDOM: () => ['em', 0] },
    code: { parseDOM: [{ tag: 'code' }], toDOM: () => ['code', 0] },
    strike: { parseDOM: [{ tag: 's' }, { tag: 'del' }], toDOM: () => ['s', 0] }
  }
})

export function newId(): string {
  return crypto.randomUUID()
}

/** A day with no stored content starts as one empty bullet. */
export function emptyDay(): PMNode {
  return schema.node('doc', null, [schema.node('bullet', { id: newId() }, [schema.node('bulletContent')])])
}

/** The stored JSON as a document; anything unreadable is one empty bullet. */
export function dayFromJson(json: unknown): { doc: PMNode; readable: boolean } {
  if (json === null || json === undefined) return { doc: emptyDay(), readable: true }
  try {
    const doc = schema.nodeFromJSON(json)
    doc.check()
    return { doc, readable: true }
  } catch {
    return { doc: emptyDay(), readable: false }
  }
}
