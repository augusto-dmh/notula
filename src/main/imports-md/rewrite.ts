// SPDX-License-Identifier: Apache-2.0
// Markdown rewritten for the notes schema, so the renderer's seed parse
// loses nothing silently, plus the plain-text projection search uses before the first open.
// Pure, line by line, code fences left alone (the parser already keeps code as plain text).
//
// - Headings: levels 1–2 kept (1–3 in a summary panel); deeper ones become a bold paragraph.
// - Blockquotes lose their `>` markers; an Obsidian callout `> [!type] Title` becomes a bold
//   `Title` (or `Type`) followed by its lines.
// - Tables: one paragraph per row, cells joined by ` · `; the separator row is dropped.
// - Images: an http(s) image is a link with its alt text, any other `[image: <alt or name>]`.
// - Links to anything but http, https, mailto and tel become their text.
// - HTML elements are reduced to their text; HTML comments are dropped.
// - Footnote definitions move to the end under a `Notes` paragraph.
// - Obsidian: `[[T|A]]` → `A`, `[[T]]` → `T`, `![[x.png]]` → `[embedded: x.png]`,
//   `![[Note]]` → `[embedded note: Note]`, `%%…%%` dropped, `==x==` → `x`, block ids dropped,
//   inline `#tags` collected and left in place.
//
// Every pattern is linear in its input (no class runs past the next `[` or the end of the line,
// and the classes are bounded), and a line over `LINE_MAX` is kept as written, so one odd file
// (a pasted log, a minified blob) can never hold the main process.

export interface RewriteOpts {
  obsidian: boolean
  /** A summary panel keeps headings 1–3. */
  panel?: boolean
}

export interface RewriteResult {
  markdown: string
  wikilinks: string[]
  /** `![[x.png]]` and `![x](local.png)`: not imported yet. */
  attachments: string[]
  embeddedNotes: string[]
  tags: string[]
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|heic|heif|tiff?|avif|pdf|mp4|mov|webm|mp3|m4a|wav|ogg|excalidraw)$/i
const SAFE_SCHEME = /^(https?:|mailto:|tel:)/i
const FENCE = /^\s{0,3}(`{3,}|~{3,})/
/** Longer lines are kept as written: no inline rewrite, no heading or table parse. */
export const LINE_MAX = 10_000

/** Drops every `open … close` pair on a line (an unclosed `open` stays), in one pass. */
function dropPaired(s: string, open: string, close: string): string {
  let a = s.indexOf(open)
  if (a < 0) return s
  let out = ''
  let i = 0
  while (a >= 0) {
    const b = s.indexOf(close, a + open.length)
    if (b < 0) break
    out += s.slice(i, a)
    i = b + close.length
    a = s.indexOf(open, i)
  }
  return out + s.slice(i)
}

/**
 * An ATX heading (`# Title`, up to three spaces of indent, closing `#`s dropped), or null. The
 * closing sequence is trimmed by hand: a lazy pattern before `\s*#*\s*$` is cubic on spaces.
 */
export function atxHeading(line: string): { level: number; text: string } | null {
  const m = /^\s{0,3}(#{1,6})\s+([\s\S]*)$/.exec(line)
  if (!m) return null
  let text = m[2]!.trimEnd()
  let end = text.length
  while (end > 0 && text.charCodeAt(end - 1) === 35) end--
  text = text.slice(0, end).trimEnd()
  return { level: m[1]!.length, text }
}

/** Applies `fn` to the parts of a line outside inline code spans. */
function outsideCode(line: string, fn: (s: string) => string): string {
  const parts = line.split(/(`+[^`]*`+)/)
  return parts.map((p, i) => (i % 2 === 1 ? p : fn(p))).join('')
}

function baseName(path: string): string {
  const clean = path.split(/[?#]/)[0] ?? path
  return clean.split(/[\\/]/).pop() || clean
}

function inline(s: string, opts: RewriteOpts, out: RewriteResult): string {
  let t = s
  // HTML comments on one line, then elements reduced to their text.
  t = dropPaired(t, '<!--', '-->')
  t = t.replace(/<br\s*\/?>/gi, ' ')
  t = t.replace(/<\/?[a-zA-Z][a-zA-Z0-9-]*(?:\s[^<>]*)?\/?>/g, '')
  if (opts.obsidian) {
    t = dropPaired(t, '%%', '%%')
    t = t.replace(/!\[\[([^\][|#\n]{1,500})(?:#[^\][|\n]{0,500})?(?:\|[^\][\n]{0,500})?\]\]/g, (_m, target: string) => {
      const name = target.trim()
      if (IMAGE_EXT.test(name) || /\.[a-z0-9]{2,5}$/i.test(name) && !/\.md$/i.test(name)) {
        out.attachments.push(name)
        return `[embedded: ${name}]`
      }
      const note = name.replace(/\.md$/i, '')
      out.embeddedNotes.push(note)
      return `[embedded note: ${note}]`
    })
    t = t.replace(/\[\[([^\][|\n]{1,500})(?:\|([^\][\n]{0,500}))?\]\]/g, (_m, target: string, alias: string | undefined) => {
      const tgt = target.trim()
      out.wikilinks.push(tgt)
      if (alias && alias.trim()) return alias.trim()
      const [page, heading] = tgt.split('#')
      return (page ?? '').trim() || (heading ?? '').trim() || tgt
    })
    t = t.replace(/==([^=\n]+)==/g, '$1')
    t = t.replace(/\s\^[A-Za-z0-9-]+\s*$/, '')
  }
  // Images.
  t = t.replace(/!\[([^\][\n]{0,1000})\]\(\s*<?([^)\s>]{1,2048})>?\s*(?:"[^"\n]{0,500}"\s*)?\)/g, (_m, alt: string, url: string) => {
    if (/^https?:/i.test(url)) return `[${alt.trim() || baseName(url)}](${url})`
    out.attachments.push(baseName(url))
    return `[image: ${alt.trim() || baseName(url)}]`
  })
  // Links to other schemes or relative targets become their text.
  t = t.replace(/(?<!!)\[([^\][\n]{0,1000})\]\(\s*<?([^)\s>]{0,2048})>?\s*(?:"[^"\n]{0,500}"\s*)?\)/g, (m, text: string, url: string) =>
    SAFE_SCHEME.test(url) ? m : text.trim() || ''
  )
  if (opts.obsidian) {
    for (const m of t.matchAll(/(?:^|[\s(])#([\p{L}\p{N}_/-]*[\p{L}_/-][\p{L}\p{N}_/-]*)/gu)) out.tags.push(m[1]!)
  }
  return t
}

function isTableRow(line: string): boolean {
  const t = line.trim()
  return t.includes('|') && (t.startsWith('|') || /\S\s*\|\s*\S/.test(t))
}

function isTableSeparator(line: string): boolean {
  // Trimmed first, so no two whitespace runs can trade characters.
  const t = line.trim()
  return t.length <= LINE_MAX && /^\|?\s*:?-+:?(?:\s*\|\s*:?-+:?)*\s*\|?$/.test(t)
}

function tableCells(line: string): string[] {
  let t = line.trim()
  if (t.startsWith('|')) t = t.slice(1)
  if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1)
  return t.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'))
}

export function rewriteMarkdown(src: string, opts: RewriteOpts): RewriteResult {
  const out: RewriteResult = { markdown: '', wikilinks: [], attachments: [], embeddedNotes: [], tags: [] }
  let text = src.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
  // Multi-line HTML and Obsidian comments outside fences are dropped up front.
  text = stripBlockComments(text, opts.obsidian)
  const lines = text.split('\n')
  const result: string[] = []
  const footnotes: string[] = []
  const maxHeading = opts.panel ? 3 : 2
  let fence: string | null = null
  let callout = false

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!
    const f = FENCE.exec(line)
    if (f) {
      const mark = f[1]!
      if (fence === null) fence = mark[0]!.repeat(3)
      else if (mark.startsWith(fence)) fence = null
      result.push(line)
      continue
    }
    if (fence !== null || line.length > LINE_MAX) {
      result.push(line)
      continue
    }

    // Tables: a row followed by a separator starts one.
    if (isTableRow(line) && i + 1 < lines.length && isTableSeparator(lines[i + 1]!)) {
      const rows: string[] = [line]
      let j = i + 2
      while (j < lines.length && isTableRow(lines[j]!) && lines[j]!.trim() !== '') rows.push(lines[j++]!)
      for (const r of rows) {
        const cells = tableCells(r).map((c) => outsideCode(c, (s) => inline(s, opts, out)))
        if (cells.some((c) => c !== '')) result.push(cells.join(' · '), '')
      }
      i = j - 1
      continue
    }

    // Footnote definitions.
    const fn = /^\[\^([^\]]+)\]:\s*(.*)$/.exec(line)
    if (fn) {
      let def = fn[2]!
      while (i + 1 < lines.length && /^\s{2,}\S/.test(lines[i + 1]!)) def += ` ${lines[++i]!.trim()}`
      footnotes.push(`\\[^${fn[1]}\\]: ${outsideCode(def, (s) => inline(s, opts, out))}`)
      continue
    }

    // Blockquotes and callouts.
    const quote = /^\s{0,3}((?:>\s?)+)([\s\S]*)$/.exec(line)
    if (quote) {
      const inner = quote[2]!
      const head = opts.obsidian ? /^\[!([A-Za-z-]+)\][+-]?\s*(.*)$/.exec(inner.trim()) : null
      if (head) {
        const title = head[2]!.trim() || head[1]!.charAt(0).toUpperCase() + head[1]!.slice(1).toLowerCase()
        if (result.length && result[result.length - 1] !== '') result.push('')
        result.push(`**${outsideCode(title, (s) => inline(s, opts, out))}**`, '')
        callout = true
        continue
      }
      line = inner
      if (line.trim() === '') {
        result.push('')
        continue
      }
    } else if (callout && line.trim() === '') {
      callout = false
    }

    // Headings.
    const h = atxHeading(line)
    if (h) {
      const level = h.level
      const body = outsideCode(h.text, (s) => inline(s, opts, out))
      if (level <= maxHeading) result.push(`${'#'.repeat(level)} ${body}`)
      else {
        if (result.length && result[result.length - 1] !== '') result.push('')
        result.push(body.trim() ? `**${body.trim()}**` : '', '')
      }
      continue
    }

    result.push(outsideCode(line, (s) => inline(s, opts, out)))
  }

  if (footnotes.length) {
    while (result.length && result[result.length - 1]!.trim() === '') result.pop()
    result.push('', '**Notes**', '')
    for (const fdef of footnotes) result.push(fdef, '')
  }
  out.markdown = result
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  out.tags = [...new Set(out.tags)]
  out.wikilinks = [...new Set(out.wikilinks)]
  return out
}

/** Drops `<!-- … -->` (and Obsidian `%% … %%`) blocks that span lines, outside code fences. */
function stripBlockComments(text: string, obsidian: boolean): string {
  const lines = text.split('\n')
  const kept: string[] = []
  let fence: string | null = null
  let inHtml = false
  let inObs = false
  for (const line of lines) {
    const f = FENCE.exec(line)
    if (!inHtml && !inObs && f) {
      const mark = f[1]!
      if (fence === null) fence = mark[0]!.repeat(3)
      else if (mark.startsWith(fence)) fence = null
      kept.push(line)
      continue
    }
    if (fence !== null) {
      kept.push(line)
      continue
    }
    let l = line
    if (inHtml) {
      const end = l.indexOf('-->')
      if (end < 0) continue
      l = l.slice(end + 3)
      inHtml = false
    }
    if (inObs) {
      const end = l.indexOf('%%')
      if (end < 0) continue
      l = l.slice(end + 2)
      inObs = false
    }
    l = dropPaired(l, '<!--', '-->')
    if (obsidian) l = dropPaired(l, '%%', '%%')
    const open = l.indexOf('<!--')
    if (open >= 0) {
      l = l.slice(0, open)
      inHtml = true
    } else if (obsidian && l.indexOf('%%') >= 0) {
      l = l.slice(0, l.indexOf('%%'))
      inObs = true
    }
    kept.push(l)
  }
  return kept.join('\n')
}

/**
 * The plain-text projection: Markdown markers stripped line by line. The editor replaces it with
 * its exact projection at the first open; this one only has to make search work before that.
 */
export function plainText(markdown: string): string {
  const lines: string[] = []
  for (const raw of markdown.split('\n')) {
    if (FENCE.test(raw)) continue
    if (raw.length > LINE_MAX) {
      lines.push(raw.trimEnd())
      continue
    }
    let l = raw
    l = l.replace(/^\s{0,3}#{1,6}\s+/, '')
    l = l.replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, '')
    l = l.replace(/!\[([^\][]*)\]\([^)]{0,2048}\)/g, '$1')
    l = l.replace(/\[([^\][]*)\]\([^)]{0,2048}\)/g, '$1')
    l = l.replace(/(\*\*|__|~~)(.+?)\1/g, '$2')
    l = l.replace(/(^|[^\w*])[*_]([^*_\n]+)[*_](?=[^\w*]|$)/g, '$1$2')
    l = l.replace(/`([^`]*)`/g, '$1')
    l = l.replace(/\\([\\`*_{}[\]()#+\-.!|])/g, '$1')
    lines.push(l.trimEnd())
  }
  return lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Headings moved one level back up (the export moved them down), outside code fences. */
export function unshiftHeadings(markdown: string): string {
  let fence: string | null = null
  return markdown
    .split('\n')
    .map((line) => {
      const f = FENCE.exec(line)
      if (f) {
        const mark = f[1]!
        if (fence === null) fence = mark[0]!.repeat(3)
        else if (mark.startsWith(fence)) fence = null
        return line
      }
      if (fence === null && /^#{2,6}\s/.test(line)) return line.slice(1)
      return line
    })
    .join('\n')
}
