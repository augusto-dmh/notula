// SPDX-License-Identifier: Apache-2.0
// The bounded YAML subset of front-matter (no YAML dependency). Pure: no Node, no
// Electron, so the dev harness loads it as is.
//
// Read: plain, single- and double-quoted scalars (double-quoted as JSON, which is what Notula's
// export writes), `true`/`false`/`null`/`~`, numbers, flow lists `[a, "b"]`, block lists, two
// levels of nested maps (format 2's `source:` block holds `series:` and `lesson:` maps), and
// lists of one-level maps (the export's attendees, tags and `notula_sections`). Anything
// else (block scalars, deeper nesting, anchors) is left out of `data`, and its key is listed in
// `unread` with the raw text kept for the item's metadata.
//
// Bounded: flow values nest at most `FLOW_DEPTH` deep (deeper reads as unread, never a stack
// overflow), every pattern is linear, and a `__proto__` key is never assigned.

import { IMPORT_LIMITS } from '@shared/types/imports-markdown'

/** Flow lists and maps nested deeper than this aren't read. */
const FLOW_DEPTH = 4
/** A key that would replace an object's prototype when assigned. */
const UNSAFE_KEY = '__proto__'

export type YamlValue = string | number | boolean | null | YamlValue[] | { [k: string]: YamlValue }

export interface FrontMatter {
  /** Keys as written (case kept); look-ups go through `fmGet`. */
  data: Record<string, YamlValue>
  /** Keys whose values weren't read. */
  unread: string[]
  raw: string
}

export interface FrontMatterSplit {
  /** Null when the text has no front-matter (or it is over 64 KB: `tooLarge`). */
  fm: FrontMatter | null
  tooLarge: boolean
  body: string
}

/** `---` on the first line, closed by `---` or `...` on its own line. */
export function splitFrontMatter(text: string): FrontMatterSplit {
  if (!/^---[ \t]*\r?\n/.test(text)) return { fm: null, tooLarge: false, body: text }
  const close = /\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/g
  close.lastIndex = 3
  const m = close.exec(text)
  if (!m) return { fm: null, tooLarge: false, body: text }
  const raw = text.slice(text.indexOf('\n') + 1, m.index)
  const body = text.slice(m.index + m[0].length)
  if (raw.length > IMPORT_LIMITS.frontMatterBytes) return { fm: null, tooLarge: true, body }
  return { fm: parseYamlSubset(raw), tooLarge: false, body }
}

/** Case-insensitive key look-up. */
export function fmGet(fm: FrontMatter | null, ...keys: string[]): YamlValue | undefined {
  if (!fm) return undefined
  for (const want of keys) {
    for (const [k, v] of Object.entries(fm.data)) if (k.trim().toLowerCase() === want) return v
  }
  return undefined
}

export function fmString(v: YamlValue | undefined): string | null {
  if (typeof v === 'string') return v.trim() || null
  if (typeof v === 'number') return String(v)
  return null
}

export function fmStrings(v: YamlValue | undefined): string[] {
  if (v === undefined || v === null) return []
  if (Array.isArray(v)) return v.flatMap((x) => (typeof x === 'string' || typeof x === 'number' ? [String(x).trim()] : [])).filter(Boolean)
  if (typeof v === 'string') return v.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean)
  return []
}

interface Line {
  indent: number
  text: string
}

function stripComment(s: string): string {
  // ` #` starts a comment outside quotes.
  let q: string | null = null
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!
    if (q) {
      if (c === '\\' && q === '"') i++
      else if (c === q) q = null
    } else if (c === '"' || c === "'") q = c
    else if (c === '#' && (i === 0 || /\s/.test(s[i - 1]!))) return s.slice(0, i).trimEnd()
  }
  return s
}

/** A scalar, or undefined when it isn't one this subset reads. */
function scalar(raw: string, depth = 0): YamlValue | undefined {
  const s = raw.trim()
  if (s === '' || s === '~' || s === 'null' || s === 'Null' || s === 'NULL') return null
  if (s.startsWith('"')) {
    if (!s.endsWith('"') || s.length < 2) return undefined
    try {
      return JSON.parse(s) as string
    } catch {
      // YAML escapes JSON lacks (`\x41`, `\e`…): keep the text between the quotes.
      return s.slice(1, -1)
    }
  }
  if (s.startsWith("'")) {
    if (!s.endsWith("'") || s.length < 2) return undefined
    return s.slice(1, -1).replace(/''/g, "'")
  }
  if (s.startsWith('[')) return depth < FLOW_DEPTH ? flowList(s, depth + 1) : undefined
  if (s.startsWith('{')) return depth < FLOW_DEPTH ? flowMap(s, depth + 1) : undefined
  if (/^[|>][+-]?\d*$/.test(s) || s.startsWith('&') || s.startsWith('*') || s.startsWith('!')) return undefined
  if (s === 'true' || s === 'True' || s === 'TRUE') return true
  if (s === 'false' || s === 'False' || s === 'FALSE') return false
  if (/^[-+]?\d+(\.\d+)?$/.test(s) && s.length < 16) return Number(s)
  return s
}

/** Splits `a, "b, c", d` at top-level commas. */
function splitFlow(inner: string): string[] | null {
  const parts: string[] = []
  let depth = 0
  let q: string | null = null
  let cur = ''
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]!
    if (q) {
      cur += c
      if (c === '\\' && q === '"' && i + 1 < inner.length) cur += inner[++i]!
      else if (c === q) q = null
      continue
    }
    if (c === '"' || c === "'") q = c
    else if (c === '[' || c === '{') depth++
    else if (c === ']' || c === '}') depth--
    if (c === ',' && depth === 0) {
      parts.push(cur)
      cur = ''
    } else cur += c
  }
  if (q || depth !== 0) return null
  if (cur.trim() !== '') parts.push(cur)
  return parts
}

function flowList(s: string, depth: number): YamlValue[] | undefined {
  if (!s.endsWith(']')) return undefined
  const parts = splitFlow(s.slice(1, -1))
  if (!parts) return undefined
  const out: YamlValue[] = []
  for (const p of parts) {
    const v = scalar(p, depth)
    if (v === undefined || (typeof v === 'object' && v !== null)) return undefined
    out.push(v)
  }
  return out
}

function flowMap(s: string, depth: number): { [k: string]: YamlValue } | undefined {
  if (!s.endsWith('}')) return undefined
  const parts = splitFlow(s.slice(1, -1))
  if (!parts) return undefined
  const out: { [k: string]: YamlValue } = {}
  for (const p of parts) {
    const kv = keyValue(p.trim())
    if (!kv) return undefined
    const v = scalar(kv.value, depth)
    if (v === undefined || (typeof v === 'object' && v !== null)) return undefined
    if (kv.key !== UNSAFE_KEY) out[kv.key] = v
  }
  return out
}

/** `key: value` (the key may be quoted); null when the line isn't a mapping entry. */
function keyValue(text: string): { key: string; value: string } | null {
  const quoted = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*')\s*:(?:\s+|$)(.*)$/.exec(text)
  if (quoted) {
    const k = scalar(quoted[1]!)
    return typeof k === 'string' ? { key: k, value: quoted[2] ?? '' } : null
  }
  // The key runs to the first `:`, which must end the line or be followed by a space. By hand:
  // a lazy key before `\s*:` is quadratic on a long line of spaces.
  const colon = text.indexOf(':')
  if (colon <= 0 || /[#\s]/.test(text[0]!)) return null
  const after = text.slice(colon + 1)
  if (after !== '' && !/^\s/.test(after)) return null
  return { key: text.slice(0, colon).trim(), value: after.trimStart() }
}

export function parseYamlSubset(src: string): FrontMatter {
  const lines: Line[] = []
  for (const rawLine of src.split(/\r?\n/)) {
    if (/^\s*(#.*)?$/.test(rawLine)) continue
    if (rawLine.includes('\t') && /^\s*\t/.test(rawLine)) {
      lines.push({ indent: -1, text: rawLine })
      continue
    }
    const indent = rawLine.length - rawLine.trimStart().length
    lines.push({ indent, text: stripComment(rawLine.trim()) })
  }
  const data: Record<string, YamlValue> = {}
  const unread: string[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    if (line.indent !== 0) {
      // A stray indented line belongs to nothing: skip it.
      i++
      continue
    }
    const kv = keyValue(line.text)
    i++
    if (!kv) continue
    if (kv.key === UNSAFE_KEY) {
      while (i < lines.length && (lines[i]!.indent > 0 || lines[i]!.indent === -1 || (lines[i]!.indent === 0 && lines[i]!.text.startsWith('- ')))) i++
      unread.push(kv.key)
      continue
    }
    // The block under this key: every following line with a deeper indent (or a `- ` at 0).
    const block: Line[] = []
    while (i < lines.length && (lines[i]!.indent > 0 || lines[i]!.indent === -1 || (lines[i]!.indent === 0 && lines[i]!.text.startsWith('- ')))) {
      block.push(lines[i]!)
      i++
    }
    const value = kv.value.trim()
    if (value !== '') {
      const v = block.length ? undefined : scalar(value)
      if (v === undefined) unread.push(kv.key)
      else data[kv.key] = v
      continue
    }
    if (!block.length) {
      data[kv.key] = null
      continue
    }
    const v = blockValue(block)
    if (v === undefined) unread.push(kv.key)
    else data[kv.key] = v
  }
  return { data, unread, raw: src }
}

/** A block list (of scalars or one-level maps) or a map (`nested`: one level, else two). */
function blockValue(block: Line[], nested = false): YamlValue | undefined {
  if (block.some((l) => l.indent === -1)) return undefined
  const base = block[0]!.indent
  if (block[0]!.text.startsWith('- ') || block[0]!.text === '-') {
    const out: YamlValue[] = []
    let j = 0
    while (j < block.length) {
      const l = block[j]!
      if (l.indent !== base || !(l.text.startsWith('- ') || l.text === '-')) return undefined
      const first = l.text.slice(1).trim()
      j++
      const kv = keyValue(first)
      if (kv && !/^["'[{]/.test(first)) {
        // A list item that is a map: `- name: x` then `  email: y`.
        const map: { [k: string]: YamlValue } = {}
        const v = scalar(kv.value)
        if (v === undefined || (typeof v === 'object' && v !== null)) return undefined
        if (kv.key !== UNSAFE_KEY) map[kv.key] = v
        while (j < block.length && block[j]!.indent > base) {
          const more = keyValue(block[j]!.text)
          if (!more) return undefined
          const mv = scalar(more.value)
          if (mv === undefined || (typeof mv === 'object' && mv !== null)) return undefined
          if (more.key !== UNSAFE_KEY) map[more.key] = mv
          j++
        }
        out.push(map)
      } else {
        if (j < block.length && block[j]!.indent > base) return undefined
        const v = scalar(first)
        if (v === undefined || (typeof v === 'object' && v !== null && !Array.isArray(v))) return undefined
        out.push(v)
      }
    }
    return out
  }
  const map: { [k: string]: YamlValue } = {}
  for (let j = 0; j < block.length; j++) {
    const l = block[j]!
    if (l.indent !== base) return undefined
    const kv = keyValue(l.text)
    if (!kv) return undefined
    // `key:` with deeper lines under it: a nested map, one level more.
    const sub: Line[] = []
    while (j + 1 < block.length && block[j + 1]!.indent > base) sub.push(block[++j]!)
    let v: YamlValue | undefined
    if (sub.length) {
      if (nested || kv.value.trim() !== '' || sub[0]!.text.startsWith('-')) return undefined
      v = blockValue(sub, true)
    } else {
      v = scalar(kv.value)
      if (typeof v === 'object' && v !== null && !Array.isArray(v)) return undefined
    }
    if (v === undefined) return undefined
    if (kv.key !== UNSAFE_KEY) map[kv.key] = v
  }
  return map
}
