// SPDX-License-Identifier: Apache-2.0
// Small text helpers for the chat engine: query terms, token estimates and cuts.

/** Tokens are estimated as characters ÷ 4. */
export const CHARS_PER_TOKEN = 4

export function tokensOf(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN)
}

export function charsOf(tokens: number): number {
  return Math.max(0, Math.floor(tokens * CHARS_PER_TOKEN))
}

/** The stop-word list for retrieval: function words and chat filler. */
const STOP_WORDS = new Set(
  `about above after again against all also and any are aren't because been before being below between both but can
  cannot could couldn't did didn't does doesn't doing don't down during each few for from further had hadn't has hasn't
  have haven't having her here hers herself him himself his how i'm i've into isn't its itself just let's more most
  mustn't myself nor not now off once only other ought our ours ourselves out over own same shan't she she'd she'll
  she's should shouldn't some such than that that's the their theirs them themselves then there there's these they
  they'd they'll they're they've this those through too under until very was wasn't we'd we'll we're we've were weren't
  what what's when when's where where's which while who who's whom why why's will with won't would wouldn't you you'd
  you'll you're you've your yours yourself yourselves yes yeah okay please thanks thank tell show give find get got
  know want need make made say said ask asked anything something everything nothing meeting meetings note notes chat
  summarize summary summarise recap list lists what's whats did does today yesterday week weeks month months year
  last next this that were any many much more less like just really there then them they`
    .split(/\s+/)
    .filter(Boolean)
)

/**
 * Retrieval terms from a question: words of 3+ code points, lower-cased, stop words
 * dropped, each once, at most `max`.
 */
export function queryTerms(text: string, max = 32): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu) ?? []) {
    const word = raw.replace(/[’']s$/u, '').replace(/['’_-]+$/u, '')
    if ([...word].length < 3 || STOP_WORDS.has(word) || seen.has(word)) continue
    seen.add(word)
    out.push(word)
    if (out.length >= max) break
  }
  return out
}

/** How many of `terms` occur in `text` (case-insensitive substring). */
export function countTerms(text: string, terms: readonly string[]): number {
  if (terms.length === 0) return 0
  const lower = text.toLowerCase()
  let n = 0
  for (const t of terms) if (lower.includes(t)) n++
  return n
}

/** The first `max` code points (never splits a surrogate pair). */
export function cutCodePoints(text: string, max: number): string {
  const cps = [...text]
  return cps.length <= max ? text : cps.slice(0, max).join('')
}

/**
 * Keeps the start of `text` within `max` characters, cut on a line boundary when one
 * is near, with a "[truncated]" marker. Returns the text unchanged when it fits.
 */
export function truncateLines(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false }
  const marker = '\n[truncated]'
  const room = Math.max(0, max - marker.length)
  let cut = text.slice(0, room)
  const nl = cut.lastIndexOf('\n')
  if (nl > room * 0.6) cut = cut.slice(0, nl)
  return { text: `${cut.trimEnd()}${marker}`, truncated: true }
}

/** Collapses runs of whitespace into one space. */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

const DAY_MS = 86_400_000

export function isoDate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** "Mon 12 Oct 2026" style dates for context headers (local time). */
export function shortDate(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
}

export function daysAgo(iso: string, now = Date.now()): number {
  const t = Date.parse(iso)
  return Number.isNaN(t) ? Infinity : (now - t) / DAY_MS
}
