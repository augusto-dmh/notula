// SPDX-License-Identifier: Apache-2.0
// Keyword limits.

export const MAX_KEYWORDS = 100
/** Deepgram keeps key terms while the running cost stays within this budget. */
export const DEEPGRAM_KEYTERM_BUDGET = 400

/** Trimmed, non-empty, de-duplicated, at most 100, in order. */
export function cleanKeywords(terms: readonly string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of terms) {
    if (typeof raw !== 'string') continue
    const t = raw.trim()
    if (!t || seen.has(t)) continue
    seen.add(t)
    out.push(t)
    if (out.length >= MAX_KEYWORDS) break
  }
  return out
}

/** Each term costs the larger of 5 × its word count and half its length, rounded up. */
export function deepgramKeytermCost(term: string): number {
  const words = term.split(/\s+/).filter(Boolean).length
  return Math.max(5 * words, Math.ceil(term.length / 2))
}

/** Terms kept in order while the running cost stays ≤ 400. */
export function deepgramKeyterms(terms: readonly string[]): string[] {
  const out: string[] = []
  let cost = 0
  for (const t of cleanKeywords(terms)) {
    const c = deepgramKeytermCost(t)
    if (cost + c > DEEPGRAM_KEYTERM_BUDGET) break
    cost += c
    out.push(t)
  }
  return out
}
