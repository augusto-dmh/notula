// SPDX-License-Identifier: Apache-2.0
// The palette's query rules: the parsed query, entity match
// strength (exact, word, partial; a quoted single word matches whole words only) and
// highlighting of every case-insensitive occurrence of the term.

import type { JSX } from 'react'

export type Strength = 'exact' | 'word' | 'partial'

export const STRENGTH_RANK: Record<Strength, number> = { exact: 0, word: 1, partial: 2 }

export interface ParsedQuery {
  /** Trimmed. */
  text: string
  lower: string
  /** Longer than 2 characters, starting and ending with `"`. */
  phrase: string | null
  /** What to highlight: the phrase, else the text. */
  term: string
}

export function parseQuery(raw: string): ParsedQuery {
  const text = raw.trim()
  const phrase = text.length > 2 && text.startsWith('"') && text.endsWith('"') ? text.slice(1, -1) : null
  return { text, lower: text.toLowerCase(), phrase, term: phrase ?? text }
}

/** The query as the "Search" row shows it: without its quotes. */
export function displayQuery(q: ParsedQuery): string {
  return q.phrase ?? q.text
}

const WORD = /[\p{L}\p{M}\p{N}_]/u

function charBefore(s: string, i: number): string {
  if (i <= 0) return ''
  const cp = s.codePointAt(i - 1) ?? 0
  // A low surrogate: step back over the pair.
  if (cp >= 0xdc00 && cp <= 0xdfff && i >= 2) return String.fromCodePoint(s.codePointAt(i - 2) ?? 0)
  return String.fromCodePoint(cp)
}

function charAt(s: string, i: number): string {
  if (i >= s.length) return ''
  return String.fromCodePoint(s.codePointAt(i) ?? 0)
}

/** `needle` occurs in `hay` with no word character on either side. Both lower-cased. */
export function hasWholeWord(hay: string, needle: string): boolean {
  if (!needle) return false
  for (let from = 0; ; ) {
    const i = hay.indexOf(needle, from)
    if (i < 0) return false
    if (!WORD.test(charBefore(hay, i)) && !WORD.test(charAt(hay, i + needle.length))) return true
    from = i + 1
  }
}

/**
 * How a query matches text. An empty query matches everything (as "partial"). Unquoted: a substring.
 * Quoted: a single word matches as a whole word; a phrase with spaces as a substring.
 */
export function matchStrength(field: string | null | undefined, q: ParsedQuery): Strength | null {
  if (!q.text) return 'partial'
  const f = (field ?? '').trim().toLowerCase()
  if (!f) return null
  let needle: string
  if (q.phrase !== null) {
    needle = q.phrase.trim().toLowerCase()
    if (!needle) return null
    const ok = /\s/.test(needle) ? f.includes(needle) : hasWholeWord(f, needle)
    if (!ok) return null
  } else {
    needle = q.lower
    if (!f.includes(needle)) return null
  }
  if (f === needle) return 'exact'
  const words = needle.split(/\s+/).filter(Boolean)
  return words.length > 0 && words.every((w) => hasWholeWord(f, w)) ? 'word' : 'partial'
}

/** The best strength over several fields (a label and its keywords). */
export function bestStrength(fields: readonly (string | null | undefined)[], q: ParsedQuery): Strength | null {
  let best: Strength | null = null
  for (const f of fields) {
    const s = matchStrength(f, q)
    if (s && (!best || STRENGTH_RANK[s] < STRENGTH_RANK[best])) best = s
  }
  return best
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Every case-insensitive occurrence of `term` in `text`, marked. */
export function Highlight({ text, term }: { text: string; term: string | null | undefined }): JSX.Element {
  if (!term || !text) return <>{text}</>
  const re = new RegExp(escapeRegExp(term), 'giu')
  const parts: (string | JSX.Element)[] = []
  let last = 0
  let n = 0
  for (const m of text.matchAll(re)) {
    const i = m.index ?? 0
    if (m[0].length === 0) break
    if (i > last) parts.push(text.slice(last, i))
    parts.push(
      <mark key={n++} className="search-mark">
        {m[0]}
      </mark>
    )
    last = i + m[0].length
  }
  if (parts.length === 0) return <>{text}</>
  if (last < text.length) parts.push(text.slice(last))
  return <>{parts}</>
}
