// SPDX-License-Identifier: Apache-2.0
// The one markdown serializer: the clipboard's
// plain flavor, the `notes_md` / `content_markdown` projections and the editor
// markdown that summary and chat inputs read all come from here, so they never
// diverge. It converts HTML (the schema's own rendering, or a copied slice) to markdown.
//
// Its rules, applied everywhere alike:
// - An element the rules do not name keeps its inner text with no markers
//   (underline, mark, mention); a line break becomes a line break; images and
//   tables still emit nothing. Content is never silently dropped.
// - A paragraph or list item whose text starts like a markdown block (`- `,
//   `1. `, `# `, `> `, `---`) gets that marker escaped, so a typed literal never reads
//   back as a nested list.
// - Every nested list of an item is kept, not only the first.
// - Inline code (the panel schema's code mark) is written as a code span, so the
//   copied text and the `content_markdown` round trip keep `AGENTS.md` as it was.

import { DOMSerializer, type Fragment, type Node as PmNode, type Schema } from '@tiptap/pm/model'

/**
 * Text that starts a paragraph the way markdown starts a block (`- `, `+ `, `* `, `# `,
 * `> `, `1. ` or a `---` rule) would parse back as a list, heading, quote or rule.
 */
const LEADING_BLOCK_MARKER = /^(?:[-+*>]|#{1,6}|\d{1,9}[.)])(?=[ \t]|$)|^-{3,}[ \t]*$/

export function escapeLeadingMarker(text: string): string {
  return text.replace(LEADING_BLOCK_MARKER, (m) => (/^\d/.test(m) ? m.replace(/[.)]$/, '\\$&') : `\\${m}`))
}

/** Elements that emit nothing at all (images and tables still emit nothing). */
const DROPPED = new Set(['head', 'script', 'style', 'img', 'picture', 'svg', 'video', 'audio', 'iframe', 'table', 'input', 'template'])
/** Unknown block containers: their content and a blank line (never lost). */
const BLOCKISH = new Set(['blockquote', 'pre', 'section', 'article', 'header', 'footer', 'figure', 'figcaption', 'li', 'dl', 'dt', 'dd'])

/** A code span fenced by a backtick run the text does not contain. */
function codeSpan(text: string): string {
  if (!text) return ''
  let fence = '`'
  while (text.includes(fence)) fence += '`'
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : ''
  return `${fence}${pad}${text}${pad}${fence}`
}

function inline(el: ParentNode): string {
  let out = ''
  for (const child of Array.from(el.childNodes)) out += convert(child)
  return out
}

function convert(node: Node): string {
  if (node.nodeType === 3) return (node.nodeValue ?? '').replace(/\r?\n/g, '')
  if (node.nodeType !== 1) return ''
  const el = node as Element
  const tag = el.localName.toLowerCase()
  if (DROPPED.has(tag)) return ''
  switch (tag) {
    case 'html':
    case 'body':
      return inline(el)
    case 'p': {
      if ((el.textContent ?? '').trim() === '') return ''
      return `${escapeLeadingMarker(inline(el))}\n\n`
    }
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6':
      return `${'#'.repeat(Number(tag[1]))} ${inline(el)}\n\n`
    case 'hr':
      return '---\n\n'
    case 'strong':
    case 'b':
      return `**${inline(el)}**`
    case 'em':
    case 'i':
      return `_${inline(el)}_`
    case 's':
    case 'strike':
    case 'del':
      return `~~${inline(el)}~~`
    case 'a':
      return `[${inline(el)}](${el.getAttribute('href') ?? ''})`
    case 'code':
      return codeSpan(el.textContent ?? '')
    case 'span':
      return inline(el)
    case 'div': {
      const content = inline(el)
      return content ? `${content}\n\n` : ''
    }
    case 'ul':
    case 'ol':
      return list(el, 0)
    case 'br':
      return '\n'
    default: {
      if (BLOCKISH.has(tag)) {
        const content = inline(el)
        return content.trim() ? `${content.replace(/\n+$/, '')}\n\n` : ''
      }
      // Underline, mark, kbd, sub, sup, … keep their text without markers.
      return inline(el)
    }
  }
}

function isList(el: Element): boolean {
  const tag = el.localName.toLowerCase()
  return tag === 'ul' || tag === 'ol'
}

/** An item's paragraphs, in order, looking through wrappers (task items) but not into nested lists. */
function itemParagraphs(li: Element): Element[] {
  const out: Element[] = []
  const walk = (el: Element): void => {
    for (const child of Array.from(el.children)) {
      if (isList(child)) continue
      if (child.localName.toLowerCase() === 'p') out.push(child)
      else walk(child)
    }
  }
  walk(li)
  return out
}

/** An item's nested lists, in order, looking through wrappers but not into deeper lists. */
function nestedLists(li: Element): Element[] {
  const out: Element[] = []
  const walk = (el: Element): void => {
    for (const child of Array.from(el.children)) {
      if (isList(child)) out.push(child)
      else walk(child)
    }
  }
  walk(li)
  return out
}

/** An item's own inline text when it has no paragraph (an unwrapped clipboard item). */
function looseItemText(li: Element): string {
  let out = ''
  for (const child of Array.from(li.childNodes)) {
    if (child.nodeType === 1 && isList(child as Element)) continue
    if (child.nodeType === 1 && (child as Element).localName.toLowerCase() === 'label') continue
    out += convert(child)
  }
  return out
}

function isTaskItem(li: Element, listEl: Element): boolean {
  return li.getAttribute('data-type') === 'taskItem' || listEl.getAttribute('data-type') === 'taskList' || li.hasAttribute('data-checked')
}

function marker(li: Element, listEl: Element, index: number, start: number): string {
  if (isTaskItem(li, listEl)) return li.getAttribute('data-checked') === 'true' ? '- [x] ' : '- [ ] '
  if (listEl.localName.toLowerCase() === 'ol') {
    const value = li.getAttribute('value')
    const n = value !== null && /^-?\d+$/.test(value.trim()) ? Number(value) : start + index
    return `${n}. `
  }
  return '- '
}

/** Markers, the item's first paragraph, indented nested lists and the end-of-list rule. */
function list(listEl: Element, indent: number): string {
  const startAttr = Number.parseInt(listEl.getAttribute('start') ?? '', 10)
  const start = Number.isFinite(startAttr) ? startAttr : 1
  const pad = ' '.repeat(indent)
  let out = ''
  let index = 0
  for (const li of Array.from(listEl.children)) {
    if (li.localName.toLowerCase() !== 'li') continue
    const m = marker(li, listEl, index, start)
    const paragraphs = itemParagraphs(li)
    const first = paragraphs[0] ? inline(paragraphs[0]) : looseItemText(li)
    out += `${pad}${m}${escapeLeadingMarker(first.trim())}\n`
    const childPad = ' '.repeat(indent + m.length)
    for (const p of paragraphs.slice(1)) {
      const text = inline(p).trim()
      if (text) out += `${childPad}${text}\n`
    }
    for (const nested of nestedLists(li)) out += list(nested, indent + m.length)
    index++
  }
  return out.endsWith('\n\n\n') ? out.slice(0, -1) : `${out}\n`
}

/** HTML → markdown, untrimmed: the concatenation of each child's output. */
export function htmlToMarkdownRaw(root: ParentNode): string {
  return inline(root)
}

/** HTML → markdown, trimmed. */
export function htmlToMarkdown(root: ParentNode): string {
  return inline(root).trim()
}

/** The plain flavor's last step: every `[text](target)` becomes `text`. */
export function stripLinkTargets(markdown: string): string {
  return markdown.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
}

/** The schema's HTML for `content`, as a detached element (no live-editor decorations). */
export function renderFragment(schema: Schema, content: Fragment): HTMLElement {
  const host = document.createElement('div')
  host.appendChild(DOMSerializer.fromSchema(schema).serializeFragment(content))
  return host
}

/** A ProseMirror document's markdown through the one serializer. */
export function docToMarkdown(doc: PmNode): string {
  return htmlToMarkdown(renderFragment(doc.type.schema, doc.content))
}

/** One markdown string per top-level node; their concatenation, trimmed, is `docToMarkdown`. */
export function blockMarkdown(doc: PmNode): string[] {
  const serializer = DOMSerializer.fromSchema(doc.type.schema)
  const out: string[] = []
  doc.forEach((node) => {
    const host = document.createElement('div')
    host.appendChild(serializer.serializeNode(node))
    out.push(htmlToMarkdownRaw(host))
  })
  return out
}
