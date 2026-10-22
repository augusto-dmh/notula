// SPDX-License-Identifier: Apache-2.0
// mammoth's HTML → markdown (mammoth's own markdown output is deprecated, and
// no DOM or turndown is added). mammoth writes a small, fixed vocabulary: headings,
// paragraphs, lists, tables, bold, italic, links, line breaks and images. Everything
// else keeps only its text. Runs in notula-convert.

interface El {
  tag: string
  attrs: Record<string, string>
  children: Node[]
}
type Node = El | string

const VOID = new Set(['br', 'img', 'hr', 'col', 'meta', 'link', 'input'])
const TOKEN = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|([^<]+|<)/g
const ATTR = /([^\s=>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g
const ENTITY = /&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi

function decode(s: string): string {
  return s.replace(ENTITY, (_m, e: string) => {
    const k = e.toLowerCase()
    if (k === 'amp') return '&'
    if (k === 'lt') return '<'
    if (k === 'gt') return '>'
    if (k === 'quot') return '"'
    if (k === 'apos') return "'"
    if (k === 'nbsp') return ' '
    const code = k.startsWith('#x') ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10)
    return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ''
  })
}

function parse(html: string): El {
  const root: El = { tag: 'root', attrs: {}, children: [] }
  const stack: El[] = [root]
  for (const m of html.matchAll(TOKEN)) {
    const top = stack[stack.length - 1] as El
    if (m[0].startsWith('<!--')) continue
    if (m[5] !== undefined) {
      top.children.push(decode(m[5]))
      continue
    }
    const tag = (m[2] ?? '').toLowerCase()
    if (m[1] === '/') {
      const at = stack.map((e) => e.tag).lastIndexOf(tag)
      if (at > 0) stack.length = at
      continue
    }
    const attrs: Record<string, string> = {}
    for (const a of (m[3] ?? '').matchAll(ATTR)) attrs[(a[1] ?? '').toLowerCase()] = decode(a[2] ?? a[3] ?? a[4] ?? '')
    const el: El = { tag, attrs, children: [] }
    top.children.push(el)
    if (!VOID.has(tag) && m[4] !== '/') stack.push(el)
  }
  return root
}

/** Inline markdown of a node's children: whitespace collapsed, marks kept. */
function inline(nodes: Node[]): string {
  let out = ''
  for (const n of nodes) {
    if (typeof n === 'string') {
      out += n.replace(/\s+/g, ' ').replace(/([\\`*_[\]])/g, '\\$1')
      continue
    }
    const inner = inline(n.children)
    switch (n.tag) {
      case 'strong':
      case 'b':
        out += inner.trim() ? `**${inner.trim()}**` : inner
        break
      case 'em':
      case 'i':
        out += inner.trim() ? `*${inner.trim()}*` : inner
        break
      case 's':
      case 'del':
      case 'strike':
        out += inner.trim() ? `~~${inner.trim()}~~` : inner
        break
      case 'a': {
        const href = n.attrs['href'] ?? ''
        const target = href.replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/\s/g, '%20')
        out += /^(https?:|mailto:)/i.test(href) && inner.trim() ? `[${inner.trim()}](${target})` : inner
        break
      }
      case 'br':
        out += '  \n'
        break
      case 'img':
        out += n.attrs['alt'] ? `[image: ${n.attrs['alt']}]` : ''
        break
      default:
        out += inner
    }
  }
  return out
}

function cellText(el: El): string {
  return blocks(el.children, 0)
    .join(' ')
    .replace(/\s*\n+\s*/g, ' ')
    .replace(/\|/g, '\\|')
    .trim()
}

function table(el: El): string {
  const rows: string[][] = []
  const walk = (n: El): void => {
    for (const c of n.children) {
      if (typeof c === 'string') continue
      if (c.tag === 'tr') rows.push(c.children.filter((x): x is El => typeof x !== 'string' && (x.tag === 'td' || x.tag === 'th')).map(cellText))
      else walk(c)
    }
  }
  walk(el)
  if (rows.length === 0) return ''
  const width = Math.max(...rows.map((r) => r.length), 1)
  const line = (r: string[]): string => `| ${Array.from({ length: width }, (_, i) => r[i] ?? '').join(' | ')} |`
  return [line(rows[0] as string[]), `| ${Array.from({ length: width }, () => '---').join(' | ')} |`, ...rows.slice(1).map(line)].join('\n')
}

function list(el: El, depth: number): string {
  const ordered = el.tag === 'ol'
  let i = 0
  const lines: string[] = []
  for (const c of el.children) {
    if (typeof c === 'string' || c.tag !== 'li') continue
    i++
    const marker = ordered ? `${i}.` : '-'
    const nested: string[] = []
    const own: Node[] = []
    for (const x of c.children) {
      if (typeof x !== 'string' && (x.tag === 'ul' || x.tag === 'ol')) nested.push(list(x, depth + 1))
      else own.push(x)
    }
    const text = blocks(own, depth).join(' ').replace(/\s*\n+\s*/g, ' ').trim()
    lines.push(`${'  '.repeat(depth)}${marker} ${text}`)
    lines.push(...nested.filter(Boolean))
  }
  return lines.join('\n')
}

/** Block-level markdown, one entry per block. */
function blocks(nodes: Node[], depth: number): string[] {
  const out: string[] = []
  let run: Node[] = []
  const flush = (): void => {
    const t = inline(run).trim()
    if (t) out.push(t)
    run = []
  }
  for (const n of nodes) {
    if (typeof n === 'string') {
      run.push(n)
      continue
    }
    const heading = /^h([1-6])$/.exec(n.tag)
    if (heading) {
      flush()
      const t = inline(n.children).trim()
      if (t) out.push(`${'#'.repeat(Number(heading[1]))} ${t}`)
    } else if (n.tag === 'p' || n.tag === 'div' || n.tag === 'blockquote') {
      flush()
      const t = inline(n.children).trim()
      if (t) out.push(n.tag === 'blockquote' ? t.split('\n').map((l) => `> ${l}`).join('\n') : t)
    } else if (n.tag === 'ul' || n.tag === 'ol') {
      flush()
      const t = list(n, depth)
      if (t) out.push(t)
    } else if (n.tag === 'table') {
      flush()
      const t = table(n)
      if (t) out.push(t)
    } else if (n.tag === 'hr') {
      flush()
      out.push('---')
    } else {
      run.push(n)
    }
  }
  flush()
  return out
}

export function htmlToMarkdown(html: string): string {
  return blocks(parse(html).children, 0).join('\n\n').trim()
}
