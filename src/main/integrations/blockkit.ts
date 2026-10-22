// SPDX-License-Identifier: Apache-2.0
// Markdown → Slack Block Kit. DOM-free,
// so manual sends (the composer's markdown) and folder auto-post (the summary panel's
// stored markdown) build the same message.

import { marked, type Token, type Tokens } from 'marked'

type Style = { bold?: true; italic?: true; code?: true; strike?: true }
type RichElement = { type: 'text'; text: string; style?: Style } | { type: 'link'; url: string; text: string; style?: Style }
type RichSection = { type: 'rich_text_section'; elements: RichElement[] }
type RichChild =
  | RichSection
  | { type: 'rich_text_list'; style: 'bullet' | 'ordered'; indent: number; offset?: number; elements: RichSection[] }
  | { type: 'rich_text_quote'; elements: RichElement[] }
  | { type: 'rich_text_preformatted'; elements: RichElement[] }

export type SlackBlock =
  | { type: 'section'; text: { type: 'mrkdwn'; text: string } }
  | { type: 'header'; text: { type: 'plain_text'; text: string } }
  | { type: 'divider' }
  | { type: 'rich_text'; elements: RichChild[] }
  | { type: 'context'; elements: { type: 'mrkdwn'; text: string }[] }

export const SECTION_LIMIT = 3_000
export const HEADER_LIMIT = 150
export const MESSAGE_BLOCKS = 50

/** D-SL-a: `&`, `<` and `>` in user text. */
export function escapeMrkdwn(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, '')
}

/** Trimmed inner text in markers, whitespace outside; whitespace-only unchanged. */
function wrap(marker: string, inner: string): string {
  if (!inner.trim()) return inner
  const lead = /^\s*/.exec(inner)?.[0] ?? ''
  const trail = /\s*$/.exec(inner)?.[0] ?? ''
  return `${lead}${marker}${inner.trim()}${marker}${trail}`
}

function decode(s: string): string {
  return s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
}

function safeUrl(href: string): string | null {
  return /^(https?:|mailto:)/i.test(href.trim()) ? href.trim() : null
}

/** Inline tokens as `mrkdwn` (paragraph sections). */
function mrkdwn(tokens: Token[] | undefined): string {
  let out = ''
  for (const t of tokens ?? []) {
    switch (t.type) {
      case 'strong':
        out += wrap('*', mrkdwn((t as Tokens.Strong).tokens))
        break
      case 'em':
        out += wrap('_', mrkdwn((t as Tokens.Em).tokens))
        break
      case 'codespan':
        out += wrap('`', escapeMrkdwn(decode((t as Tokens.Codespan).text)))
        break
      case 'del':
        out += mrkdwn((t as Tokens.Del).tokens)
        break
      case 'link': {
        const l = t as Tokens.Link
        const text = plain(l.tokens).replace(/[|>]/g, ' ')
        const url = safeUrl(l.href)
        out += url ? `<${url.replace(/[|>]/g, encodeURIComponent)}|${escapeMrkdwn(text)}>` : escapeMrkdwn(text)
        break
      }
      case 'image':
        out += '[image]'
        break
      case 'br':
        out += '\n'
        break
      case 'html':
        out += escapeMrkdwn(stripTags((t as Tokens.HTML).text))
        break
      default:
        if ('tokens' in t && Array.isArray(t.tokens)) out += mrkdwn(t.tokens)
        else if ('text' in t && typeof t.text === 'string') out += escapeMrkdwn(decode(t.text))
    }
  }
  return out
}

/** Inline tokens flattened to plain text. */
function plain(tokens: Token[] | undefined): string {
  let out = ''
  for (const t of tokens ?? []) {
    if (t.type === 'image') out += '[image]'
    else if (t.type === 'br') out += '\n'
    else if (t.type === 'html') out += stripTags((t as Tokens.HTML).text)
    else if ('tokens' in t && Array.isArray(t.tokens)) out += plain(t.tokens)
    else if ('text' in t && typeof t.text === 'string') out += decode(t.text)
  }
  return out
}

/** Inline tokens as rich-text elements (list items, quotes, headings 2–6). */
function rich(tokens: Token[] | undefined, style: Style = {}): RichElement[] {
  const out: RichElement[] = []
  const st = (): Style | undefined => (Object.keys(style).length ? { ...style } : undefined)
  for (const t of tokens ?? []) {
    switch (t.type) {
      case 'strong':
        out.push(...rich((t as Tokens.Strong).tokens, { ...style, bold: true }))
        break
      case 'em':
        out.push(...rich((t as Tokens.Em).tokens, { ...style, italic: true }))
        break
      case 'del':
        out.push(...rich((t as Tokens.Del).tokens, { ...style, strike: true }))
        break
      case 'codespan':
        out.push({ type: 'text', text: decode((t as Tokens.Codespan).text), style: { ...style, code: true } })
        break
      case 'link': {
        const l = t as Tokens.Link
        const url = safeUrl(l.href)
        const text = plain(l.tokens)
        const s = st()
        out.push(url ? { type: 'link', url, text, ...(s ? { style: s } : {}) } : { type: 'text', text, ...(s ? { style: s } : {}) })
        break
      }
      default: {
        const text = t.type === 'image' ? '[image]' : t.type === 'br' ? '\n' : plain([t])
        if (!text) break
        const s = st()
        out.push({ type: 'text', text, ...(s ? { style: s } : {}) })
      }
    }
  }
  return out.filter((e) => e.text !== '')
}

function splitText(text: string, limit: number): string[] {
  const parts: string[] = []
  let rest = text
  while (rest.length > limit) {
    const cut = rest.lastIndexOf(' ', limit) > limit / 2 ? rest.lastIndexOf(' ', limit) : Math.max(rest.lastIndexOf('\n', limit), 0) || limit
    parts.push(rest.slice(0, cut).trimEnd())
    rest = rest.slice(cut).trimStart()
  }
  if (rest) parts.push(rest)
  return parts
}

function sections(text: string): SlackBlock[] {
  if (!text.trim()) return []
  return splitText(text, SECTION_LIMIT).map((t) => ({ type: 'section', text: { type: 'mrkdwn', text: t } }))
}

/** D-SL-c: every item's paragraphs and nested lists are kept, numbering continues across nesting. */
function listChildren(list: Tokens.List, depth: number, out: RichChild[]): void {
  const style = list.ordered ? 'ordered' : 'bullet'
  let index = Number(list.start || 1) - 1
  for (const item of list.items) {
    const elements: RichElement[] = []
    if (item.task) elements.push({ type: 'text', text: item.checked ? '☑ ' : '☐ ' })
    const nested: Tokens.List[] = []
    for (const t of item.tokens) {
      if (t.type === 'list') nested.push(t as Tokens.List)
      else if (t.type === 'text' || t.type === 'paragraph') {
        if (elements.length && !(item.task && elements.length === 1)) elements.push({ type: 'text', text: '\n' })
        const tt = t as Tokens.Text
        elements.push(...(tt.tokens ? rich(tt.tokens) : [{ type: 'text' as const, text: decode(tt.text) }]))
      } else if (t.type === 'code') {
        elements.push({ type: 'text', text: `\n${(t as Tokens.Code).text}`, style: { code: true } })
      } else if (t.type !== 'space' && t.type !== 'checkbox') {
        const text = plain([t])
        if (text) elements.push({ type: 'text', text: `\n${text}` })
      }
    }
    const section: RichSection = { type: 'rich_text_section', elements: elements.length ? elements : [{ type: 'text', text: ' ' }] }
    const last = out[out.length - 1]
    if (last && last.type === 'rich_text_list' && last.style === style && last.indent === depth) last.elements.push(section)
    else out.push({ type: 'rich_text_list', style, indent: depth, ...(style === 'ordered' && index > 0 ? { offset: index } : {}), elements: [section] })
    index++
    for (const n of nested) listChildren(n, Math.min(depth + 1, 8), out)
  }
}

function blocksOf(tokens: Token[]): SlackBlock[] {
  const out: SlackBlock[] = []
  for (const t of tokens) {
    switch (t.type) {
      case 'paragraph':
        out.push(...sections(mrkdwn((t as Tokens.Paragraph).tokens)))
        break
      case 'heading': {
        const h = t as Tokens.Heading
        const text = plain(h.tokens).trim()
        if (!text) break
        if (h.depth === 1) {
          out.push({ type: 'header', text: { type: 'plain_text', text: text.length > HEADER_LIMIT ? `${text.slice(0, HEADER_LIMIT - 1)}…` : text } })
        } else {
          out.push({ type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text, style: { bold: true } }] }] })
        }
        break
      }
      case 'list': {
        const children: RichChild[] = []
        listChildren(t as Tokens.List, 0, children)
        if (children.length) out.push({ type: 'rich_text', elements: children })
        break
      }
      case 'blockquote': {
        const q = t as Tokens.Blockquote
        const elements: RichElement[] = []
        for (const c of q.tokens) {
          if (c.type === 'space') continue
          if (elements.length) elements.push({ type: 'text', text: '\n' })
          elements.push(...('tokens' in c && Array.isArray(c.tokens) && c.type !== 'list' ? rich(c.tokens) : [{ type: 'text' as const, text: plain([c]) || ('raw' in c ? String(c.raw).trim() : '') }]))
        }
        if (elements.some((e) => e.text.trim())) out.push({ type: 'rich_text', elements: [{ type: 'rich_text_quote', elements }] })
        break
      }
      case 'code': {
        const text = (t as Tokens.Code).text
        if (text.trim()) out.push({ type: 'rich_text', elements: [{ type: 'rich_text_preformatted', elements: [{ type: 'text', text }] }] })
        break
      }
      case 'hr':
        out.push({ type: 'divider' })
        break
      case 'table':
        out.push(...sections('[table]'))
        break
      case 'html':
        out.push(...sections(escapeMrkdwn(stripTags((t as Tokens.HTML).text)).trim()))
        break
      case 'space':
        break
      default:
        // Bare text at block level is dropped; anything else with text is kept as a paragraph (D-SL-c).
        if (t.type !== 'text' && 'text' in t && typeof t.text === 'string') out.push(...sections(escapeMrkdwn(t.text)))
    }
  }
  return out
}

export function markdownToBlocks(md: string): SlackBlock[] {
  return blocksOf(marked.lexer(md, { gfm: true }))
}

export interface SlackMessage {
  text: string
  blocks: SlackBlock[]
}

/**
 * D-SL-d/e: the body blocks, then a `context` block `*<title>* · <date>` on the last
 * message; at most 50 blocks a message, continuations titled "(continued)".
 */
export function buildMessages(md: string, title: string, date: string): SlackMessage[] {
  const body = markdownToBlocks(md)
  const context: SlackBlock = { type: 'context', elements: [{ type: 'mrkdwn', text: `*${escapeMrkdwn(title)}* · ${escapeMrkdwn(date)}` }] }
  const all = [...body, context]
  const chunks: SlackBlock[][] = []
  for (let i = 0; i < all.length; i += MESSAGE_BLOCKS) chunks.push(all.slice(i, i + MESSAGE_BLOCKS))
  const fallback = `Notula notes: ${title}`.slice(0, 4_000)
  return chunks.map((blocks, i) => ({ text: i === 0 ? fallback : `${fallback} (continued)`.slice(0, 4_000), blocks }))
}
