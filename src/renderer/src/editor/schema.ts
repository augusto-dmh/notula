// SPDX-License-Identifier: Apache-2.0
// The editor schema per surface and its markdown dialect
// (bullet `-`, tight lists, html on, linkify off, no soft line breaks).

import { Extension, getSchema, type Extensions, type JSONContent, type MarkdownToken } from '@tiptap/core'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import Mention from '@tiptap/extension-mention'
import Typography from '@tiptap/extension-typography'
import { MarkdownManager } from '@tiptap/markdown'
import type { Schema } from '@tiptap/pm/model'
import StarterKit from '@tiptap/starter-kit'
import { ActionItemAttribute } from './action-item-thumbs'
import { isAllowedLink, LINK_ATTRIBUTES, sanitizeLinks, shouldAutoLink } from './links'
import { docToMarkdown } from './markdown'
import type { MenuStore, MentionItem } from './menus'
import { PasteAttributes } from './paste'
import { SourcePosition } from './source-position'

export type EditorKind = 'notes' | 'panel'

/** The mention node's name. */
export const MENTION_NODE = 'mention'

export const MARKED_OPTIONS = { gfm: true, breaks: false } as const

export interface MentionSource {
  store: MenuStore<MentionItem>
  items(query: string): Promise<MentionItem[]>
}

const NotulaMention = Mention.extend({
  name: MENTION_NODE,

  addAttributes() {
    return {
      ...this.parent?.(),
      nodeUid: {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute('data-node-key'),
        renderHTML: (attrs: Record<string, unknown>) => (attrs['nodeUid'] ? { 'data-node-key': String(attrs['nodeUid']) } : {})
      }
    }
  },

  parseHTML() {
    return [
      ...(this.parent?.() ?? []),
      {
        // `mailto:` anchors whose text starts with `@` are mentions.
        tag: 'a[href^="mailto:"]',
        priority: 101,
        getAttrs: (el: HTMLElement) => {
          const text = el.textContent ?? ''
          if (!text.startsWith('@')) return false
          const email = (el.getAttribute('href') ?? '').slice('mailto:'.length)
          return { id: email || text.slice(1), label: text.slice(1) }
        }
      }
    ]
  }
})

/** The attribute that marks a heading inserted from a template. */
export const TEMPLATE_HEADING_ATTR = 'templateHeading'

/** Template headings carry a marker so they can be found and removed again. */
const TemplateHeadingAttribute = Extension.create({
  name: 'notulaTemplateHeading',

  addGlobalAttributes() {
    return [
      {
        types: ['heading'],
        attributes: {
          [TEMPLATE_HEADING_ATTR]: {
            default: null,
            keepOnSplit: false,
            parseHTML: (el) => (el.getAttribute('data-section-heading') === 'true' ? true : null),
            renderHTML: (attrs) => (attrs[TEMPLATE_HEADING_ATTR] ? { 'data-section-heading': 'true' } : {})
          }
        }
      }
    ]
  }
})

/**
 * The notes schema has no code mark, and marked's `codespan` token has no
 * `tokens`, so without a handler TipTap's parser drops a span like `AGENTS.md` whole.
 * In the notes schema it becomes plain text.
 */
const CodespanText = Extension.create({
  name: 'notulaCodespanText',
  markdownTokenName: 'codespan',
  parseMarkdown: (token: MarkdownToken) => ({ type: 'text', text: token.text ?? '' })
})

/**
 * No schema has a code block, so a fenced or indented block keeps its
 * lines as plain paragraphs instead of being dropped.
 */
const CodeBlockText = Extension.create({
  name: 'notulaCodeBlockText',
  markdownTokenName: 'code',
  parseMarkdown: (token: MarkdownToken) =>
    String(token.text ?? '')
      .split(/\r?\n/)
      .filter((line) => line.trim() !== '')
      .map((line) => ({ type: 'paragraph', content: [{ type: 'text', text: line }] }))
})

/**
 * Schema-defining extensions. The editor adds collaboration, menus and behaviour on top.
 * Markdown is written by markdown.ts (the one serializer); TipTap's markdown is used to parse.
 */
export function schemaExtensions(kind: EditorKind, mention?: MentionSource): Extensions {
  return [
    StarterKit.configure({
      // Not in the notes schema.
      blockquote: false,
      // AI surfaces keep the model's inline code (`AGENTS.md`); the notes schema has none.
      code: kind === 'panel' ? {} : false,
      codeBlock: false,
      hardBreak: false,
      trailingNode: false,
      // The Yjs undo manager replaces history when the binding is on.
      undoRedo: false,
      heading: { levels: kind === 'notes' ? [1, 2] : [1, 2, 3] },
      link: {
        openOnClick: false,
        autolink: true,
        linkOnPaste: true,
        defaultProtocol: 'https',
        HTMLAttributes: { ...LINK_ATTRIBUTES },
        isAllowedUri: (url: string) => isAllowedLink(url),
        // `AGENTS.md` or `config.ts` is a filename, not a site on that TLD.
        shouldAutoLink
      }
    }),
    TaskList,
    TaskItem.configure({ nested: false }),
    Typography.configure({
      openDoubleQuote: false,
      closeDoubleQuote: false,
      openSingleQuote: false,
      closeSingleQuote: false
    }),
    NotulaMention.configure(
      mention
        ? {
            suggestion: {
              char: '@',
              items: ({ query }: { query: string }) => mention.items(query),
              render: mention.store.render
            }
          }
        : {}
    ),
    ...(kind === 'panel' ? [] : [CodespanText]),
    CodeBlockText,
    PasteAttributes,
    TemplateHeadingAttribute,
    // Summary paragraphs keep their action item id; typed note paragraphs, their video position.
    ...(kind === 'panel' ? [ActionItemAttribute] : [SourcePosition])
  ]
}

const schemas = new Map<EditorKind, Schema>()

export function schemaFor(kind: EditorKind): Schema {
  let s = schemas.get(kind)
  if (!s) {
    s = getSchema(schemaExtensions(kind))
    schemas.set(kind, s)
  }
  return s
}

let linkifyDisabled = false

/** GFM bare-URL autolinks off (linkify off). The shared marked instance is configured once. */
export function configureMarked(manager: MarkdownManager): void {
  if (linkifyDisabled) return
  linkifyDisabled = true
  manager.instance.use({ tokenizer: { url: () => undefined } })
}

const managers = new Map<EditorKind, MarkdownManager>()

export function markdownFor(kind: EditorKind): MarkdownManager {
  let m = managers.get(kind)
  if (!m) {
    m = new MarkdownManager({ extensions: schemaExtensions(kind), markedOptions: { ...MARKED_OPTIONS } })
    configureMarked(m)
    managers.set(kind, m)
  }
  return m
}

/**
 * markdown → doc → markdown with the panel schema and the one serializer, so
 * serializer normalization never reads as an edit.
 */
export function normalizeMarkdown(md: string): string {
  return docToMarkdown(schemaFor('panel').nodeFromJSON(parseMarkdown('panel', md)))
}

/** Markdown → ProseMirror JSON with the link rules applied. */
export function parseMarkdown(kind: EditorKind, md: string): JSONContent {
  return sanitizeLinks(markdownFor(kind).parse(md))
}

function hasContent(json: JSONContent): boolean {
  const blocks = json.content ?? []
  if (blocks.length === 0) return false
  if (blocks.length > 1) return true
  const only = blocks[0] as JSONContent
  return only.type !== 'paragraph' || (only.content?.length ?? 0) > 0
}

/**
 * The initial body for an empty room: the note's ProseMirror JSON
 * when it has content, else its markdown, else null (one empty paragraph).
 */
export function seedDocument(
  kind: EditorKind,
  seed: { json?: unknown; markdown?: string } | undefined
): JSONContent | null {
  if (!seed) return null
  const json = seed.json as JSONContent | null | undefined
  if (json && typeof json === 'object' && json.type === 'doc' && hasContent(json)) {
    try {
      schemaFor(kind).nodeFromJSON(json).check()
      return sanitizeLinks(json)
    } catch (err) {
      console.error('[notula] seed-json-invalid', err)
    }
  }
  const md = seed.markdown?.trim()
  if (md) {
    const parsed = parseMarkdown(kind, md)
    if (hasContent(parsed)) return parsed
  }
  return null
}
