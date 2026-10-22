// SPDX-License-Identifier: Apache-2.0
// Chat answers as markdown: the `marked`
// lexer's tokens rendered as React elements. Raw HTML renders as text and TeX stays as
// written, so no sanitizer is needed. Citations (step 49) render as numbered chips at
// the end of their response line, numbered across the whole message.

import { Fragment, useMemo, type JSX, type ReactNode } from 'react'
import { Lexer, type Token, type Tokens } from 'marked'
import type { ChatCitation } from '@shared/types/chat'

const MARK_OPEN = ''
const MARK_CLOSE = ''
const MARK = /(\d+)/g
const SAFE_LINK = /^(https?:|mailto:)/i

export interface CitationRendering {
  /** The chip number of a citation (numbered across the whole message). */
  number(c: ChatCitation): number
  title(c: ChatCitation): string
  onOpen(c: ChatCitation): void
}

interface Props {
  markdown: string
  citations?: ChatCitation[] | undefined
  /** The message-wide index of the markdown's first line. */
  lineOffset?: number
  cite?: CitationRendering | undefined
}

/** Puts a marker at the end of every line that has citations (outside code fences). */
function withMarkers(markdown: string, lines: ReadonlySet<number>): string {
  if (lines.size === 0) return markdown
  let fenced = false
  return markdown
    .split('\n')
    .map((line, i) => {
      if (/^\s*(```|~~~)/.test(line)) {
        fenced = !fenced
        return line
      }
      if (fenced || !lines.has(i) || !line.trim()) return line
      const marker = `${MARK_OPEN}${i}${MARK_CLOSE}`
      const row = /^(\s*\|.*?)(\s*\|\s*)$/.exec(line)
      return row ? `${row[1]}${marker}${row[2]}` : `${line.trimEnd()}${marker}`
    })
    .join('\n')
}

function defaultNumbering(citations: ChatCitation[]): CitationRendering {
  const keys: string[] = []
  const keyOf = (c: ChatCitation): string => `${c.meeting_id}|${c.source_kind}|${c.source_quote ?? ''}`
  for (const c of citations) if (!keys.includes(keyOf(c))) keys.push(keyOf(c))
  return { number: (c) => keys.indexOf(keyOf(c)) + 1, title: () => '', onOpen: () => undefined }
}

export function MarkdownView({ markdown, citations, lineOffset = 0, cite }: Props): JSX.Element {
  const tokens = useMemo(() => {
    const lines = new Set((citations ?? []).map((c) => c.answer_line - lineOffset))
    try {
      return Lexer.lex(withMarkers(markdown, lines), { gfm: true, breaks: false })
    } catch {
      return [{ type: 'paragraph', raw: markdown, text: markdown, tokens: [{ type: 'text', raw: markdown, text: markdown }] }] as Token[]
    }
  }, [markdown, citations, lineOffset])
  const ctx: RenderCtx = {
    citations: citations ?? [],
    lineOffset,
    cite: cite ?? defaultNumbering(citations ?? [])
  }
  return <div className="chat-md">{blocks(tokens, ctx)}</div>
}

interface RenderCtx {
  citations: ChatCitation[]
  lineOffset: number
  cite: CitationRendering
}

function chips(line: number, ctx: RenderCtx, key: string): ReactNode {
  const list = ctx.citations.filter((c) => c.answer_line === ctx.lineOffset + line)
  const seen = new Set<number>()
  const out: ReactNode[] = []
  for (const c of list) {
    const n = ctx.cite.number(c)
    if (seen.has(n)) continue
    seen.add(n)
    const title = ctx.cite.title(c)
    out.push(
      <button
        key={`${key}-${n}`}
        type="button"
        className={`chat-cite${c.source_kind === 'transcript' ? ' chat-cite--transcript' : ''}`}
        title={title || undefined}
        aria-label={title ? `Source ${n}: ${title}` : `Source ${n}`}
        onClick={(e) => {
          e.preventDefault()
          ctx.cite.onOpen(c)
        }}
      >
        {n}
      </button>
    )
  }
  return out.length ? <span className="chat-cites">{out}</span> : null
}

function text(value: string, ctx: RenderCtx, key: string): ReactNode {
  if (!value.includes(MARK_OPEN)) return value
  const out: ReactNode[] = []
  let last = 0
  for (const m of value.matchAll(MARK)) {
    const at = m.index ?? 0
    if (at > last) out.push(value.slice(last, at))
    out.push(<Fragment key={`${key}-m${at}`}>{chips(Number(m[1]), ctx, `${key}-${at}`)}</Fragment>)
    last = at + m[0].length
  }
  if (last < value.length) out.push(value.slice(last))
  return out
}

/** A marker that ended up inside code is removed rather than shown. */
function plain(value: string): string {
  return value.replace(MARK, '')
}

function inline(tokens: Token[] | undefined, ctx: RenderCtx, key: string): ReactNode[] {
  return (tokens ?? []).map((t, i) => {
    const k = `${key}.${i}`
    switch (t.type) {
      case 'text': {
        const tt = t as Tokens.Text
        return tt.tokens?.length ? <Fragment key={k}>{inline(tt.tokens, ctx, k)}</Fragment> : <Fragment key={k}>{text(tt.text, ctx, k)}</Fragment>
      }
      case 'escape':
        return <Fragment key={k}>{(t as Tokens.Escape).text}</Fragment>
      case 'checkbox':
        // The list item draws its own checkbox.
        return null
      case 'strong':
        return <strong key={k}>{inline((t as Tokens.Strong).tokens, ctx, k)}</strong>
      case 'em':
        return <em key={k}>{inline((t as Tokens.Em).tokens, ctx, k)}</em>
      case 'del':
        return <del key={k}>{inline((t as Tokens.Del).tokens, ctx, k)}</del>
      case 'codespan':
        return <code key={k}>{plain((t as Tokens.Codespan).text)}</code>
      case 'br':
        return <br key={k} />
      case 'link': {
        const l = t as Tokens.Link
        const children = inline(l.tokens, ctx, k)
        return SAFE_LINK.test(l.href) ? (
          <a key={k} href={l.href} target="_blank" rel="noreferrer noopener" title={l.title ?? undefined}>
            {children}
          </a>
        ) : (
          <Fragment key={k}>{children}</Fragment>
        )
      }
      case 'image': {
        const img = t as Tokens.Image
        return <span key={k} className="chat-md__image">{img.text ? `[${img.text}]` : '[image]'}</span>
      }
      case 'html':
        return <Fragment key={k}>{text((t as Tokens.HTML).text, ctx, k)}</Fragment>
      default:
        return <Fragment key={k}>{text('text' in t && typeof t.text === 'string' ? t.text : t.raw, ctx, k)}</Fragment>
    }
  })
}

function blocks(tokens: Token[], ctx: RenderCtx, key = 'b'): ReactNode[] {
  return tokens.map((t, i) => {
    const k = `${key}.${i}`
    switch (t.type) {
      case 'space':
      case 'def':
      case 'checkbox':
        return null
      case 'heading': {
        const h = t as Tokens.Heading
        const level = Math.min(6, Math.max(3, h.depth + 2))
        const Tag = `h${level}` as 'h3'
        return <Tag key={k}>{inline(h.tokens, ctx, k)}</Tag>
      }
      case 'paragraph':
        return <p key={k}>{inline((t as Tokens.Paragraph).tokens, ctx, k)}</p>
      case 'text': {
        const tt = t as Tokens.Text
        return <p key={k}>{tt.tokens ? inline(tt.tokens, ctx, k) : text(tt.text, ctx, k)}</p>
      }
      case 'blockquote':
        return <blockquote key={k}>{blocks((t as Tokens.Blockquote).tokens, ctx, k)}</blockquote>
      case 'hr':
        return <hr key={k} />
      case 'code': {
        const c = t as Tokens.Code
        return (
          <pre key={k} className="chat-md__code">
            <code>{plain(c.text)}</code>
          </pre>
        )
      }
      case 'list': {
        const l = t as Tokens.List
        const items = l.items.map((it, j) => (
          <li key={`${k}.${j}`} className={it.task ? 'chat-md__task' : undefined}>
            {it.task ? <input type="checkbox" checked={!!it.checked} readOnly tabIndex={-1} aria-hidden="true" /> : null}
            {listItem(it, ctx, `${k}.${j}`)}
          </li>
        ))
        return l.ordered ? (
          <ol key={k} start={typeof l.start === 'number' && l.start !== 1 ? l.start : undefined}>
            {items}
          </ol>
        ) : (
          <ul key={k}>{items}</ul>
        )
      }
      case 'table': {
        const tb = t as Tokens.Table
        return (
          <div key={k} className="chat-md__table">
            <table>
              <thead>
                <tr>
                  {tb.header.map((c, j) => (
                    <th key={j} style={tb.align[j] ? { textAlign: tb.align[j] ?? undefined } : undefined}>
                      {inline(c.tokens, ctx, `${k}.h${j}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {tb.rows.map((row, r) => (
                  <tr key={r}>
                    {row.map((c, j) => (
                      <td key={j} style={tb.align[j] ? { textAlign: tb.align[j] ?? undefined } : undefined}>
                        {inline(c.tokens, ctx, `${k}.${r}.${j}`)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      }
      case 'html':
        return <p key={k}>{text((t as Tokens.HTML).text, ctx, k)}</p>
      default:
        return <p key={k}>{text(t.raw, ctx, k)}</p>
    }
  })
}

/** A tight item's text tokens render inline; a loose item's blocks render as blocks. */
function listItem(it: Tokens.ListItem, ctx: RenderCtx, key: string): ReactNode {
  if (it.loose) return blocks(it.tokens, ctx, key)
  return it.tokens.map((t, i) => {
    const k = `${key}.${i}`
    if (t.type === 'text') {
      const tt = t as Tokens.Text
      return <Fragment key={k}>{tt.tokens ? inline(tt.tokens, ctx, k) : text(tt.text, ctx, k)}</Fragment>
    }
    return <Fragment key={k}>{blocks([t], ctx, k)}</Fragment>
  })
}
