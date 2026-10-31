// SPDX-License-Identifier: Apache-2.0
// The pure half of word learning: a field reading as words, where the paste sits in it, whether a
// later reading is still the same field, the word diff and the learning candidates. No imports,
// so scripts/dev/learn-check.ts runs it directly; the rules' numbers come from the caller.
//
// - A reading is the text within a window of the caret. A window edge that cut the text drops
//   its edge word, which may be half a word.
// - A later reading is the same field when at least half the words around the paste are still
//   in it. Around a paste shorter than 4 words, the caller's window check is all there is.
// - Candidates: changed spans inside the pasted words, at most `spanWords` words on either side
//   and `spanChars` characters on the typed side. A span equal after normalising is skipped, and
//   so is a new form already known. A one-word change to another plain lowercase word that
//   doesn't look like a respelling (more than 2 in 5 letters differ) is a rewording, not
//   learned. Forms with capitals rank first; at most `max` are kept.

export interface Reading {
  before: string
  selection: string
  after: string
  /** The window cut the text before or after the caret. */
  cutBefore: boolean
  cutAfter: boolean
}

export interface Candidate {
  from: string
  to: string
}

export interface CandidateRules {
  spanWords: number
  spanChars: number
  max: number
  /** Normalised ids of the live and removed terms. */
  known: ReadonlySet<string>
  normalise: (term: string) => string
  valid: (term: string) => boolean
}

/** Whitespace-separated tokens. */
export const wordsOf = (text: string): string[] => text.split(/\s+/).filter(Boolean)

/** A token compared without case or surrounding punctuation. */
export const bare = (w: string): string => w.normalize('NFC').toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')

const strip = (w: string): string => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')

/** The reading's words, without a word the window may have cut in half. */
export function readingWords(r: Reading): string[] {
  const before = wordsOf(r.before)
  const after = wordsOf(r.after)
  // A cut edge word is only whole when the window ended on a space.
  if (r.cutBefore && before.length && !/^\s/.test(r.before)) before.shift()
  if (r.cutAfter && after.length && !/\s$/.test(r.after)) after.pop()
  // The caret can sit inside a word: join the halves across it.
  return joinAt(joinAt(before, r.before, wordsOf(r.selection), r.selection), `${r.before}${r.selection}`, after, r.after)
}

function joinAt(left: string[], leftText: string, right: string[], rightText: string): string[] {
  if (left.length && right.length && /\S$/.test(leftText) && /^\S/.test(rightText)) return [...left.slice(0, -1), left[left.length - 1]! + right[0]!, ...right.slice(1)]
  return [...left, ...right]
}

/** Every start index where `needle` occurs in `hay` (bare comparison). */
export function occurrences(hay: readonly string[], needle: readonly string[]): number[] {
  const out: number[] = []
  if (!needle.length) return out
  const h = hay.map(bare)
  const n = needle.map(bare)
  for (let i = 0; i + n.length <= h.length; i++) if (n.every((w, j) => h[i + j] === w)) out.push(i)
  return out
}

/** Where the pasted words sit in a reading ([start, end) word indexes): the last copy. */
export function pastedRange(words: readonly string[], pasted: readonly string[]): [number, number] | null {
  const at = occurrences(words, pasted)
  const start = at[at.length - 1]
  return start === undefined ? null : [start, start + pasted.length]
}

/** Two copies of the pasted words, the second starting within `gapWords` words of the first one's end. */
export function findDuplicate(
  text: readonly string[],
  pasted: readonly string[],
  copiesBefore: number,
  gapWords: number
): { pastedWords: number; wordGap: number } | null {
  // A single word is too common to tell a duplicate paste from a repeat.
  if (pasted.length < 2) return null
  const at = occurrences(text, pasted)
  if (at.length < copiesBefore + 2) return null
  for (let k = 1; k < at.length; k++) {
    const gap = at[k]! - (at[k - 1]! + pasted.length)
    if (gap >= 0 && gap <= gapWords) return { pastedWords: pasted.length, wordGap: gap }
  }
  return null
}

/** The later reading still shows the words around the paste (8 on each side and the paste). */
export function sameField(baseline: readonly string[], pasted: [number, number], words: readonly string[]): boolean {
  const around = baseline.slice(Math.max(0, pasted[0] - 8), pasted[1] + 8).map(bare)
  if (around.length < 4) return true
  const now = new Set(words.map(bare))
  return around.filter((w) => now.has(w)).length * 2 >= around.length
}

/** Changed spans between two word lists (longest common subsequence). */
export function wordDiff(a: readonly string[], b: readonly string[]): { a: [number, number]; b: [number, number] }[] {
  const n = a.length
  const m = b.length
  // Readings are windows of the field, so the table stays small (≤ ~800 × 800).
  const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!)
  const spans: { a: [number, number]; b: [number, number] }[] = []
  let i = 0
  let j = 0
  let open: { a: number; b: number } | null = null
  const close = (): void => {
    if (open && (open.a < i || open.b < j)) spans.push({ a: [open.a, i], b: [open.b, j] })
    open = null
  }
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      close()
      i++
      j++
    } else {
      open ??= { a: i, b: j }
      if (j < m && (i >= n || dp[i]![j + 1]! >= dp[i + 1]![j]!)) j++
      else i++
    }
  }
  close()
  return spans
}

/** Edit distance between two short strings. */
function distance(x: string, y: string): number {
  let row = Array.from({ length: y.length + 1 }, (_, k) => k)
  for (let i = 1; i <= x.length; i++) {
    const next = [i]
    for (let k = 1; k <= y.length; k++) next[k] = Math.min(row[k]! + 1, next[k - 1]! + 1, row[k - 1]! + (x[i - 1] === y[k - 1] ? 0 : 1))
    row = next
  }
  return row[y.length]!
}

/** A one-word change to a plain lowercase word that isn't a respelling of the typed one. */
function rewording(fromWords: readonly string[], toWords: readonly string[], to: string): boolean {
  if (fromWords.length !== 1 || toWords.length !== 1 || /[\p{Lu}\p{N}]/u.test(to)) return false
  const x = bare(fromWords[0]!)
  const y = bare(to)
  return distance(x, y) > Math.max(1, Math.floor(Math.max(x.length, y.length) * 0.4))
}

/** Learning candidates from the watched edit, capitalised forms first. */
export function candidates(before: readonly string[], after: readonly string[], pasted: [number, number], rules: CandidateRules): Candidate[] {
  const out: Candidate[] = []
  const seen = new Set<string>()
  for (const span of wordDiff(before, after)) {
    if (span.a[0] < pasted[0] || span.a[1] > pasted[1]) continue
    const fromWords = before.slice(span.a[0], span.a[1])
    const toWords = after.slice(span.b[0], span.b[1])
    if (!fromWords.length || !toWords.length) continue
    if (fromWords.length > rules.spanWords || toWords.length > rules.spanWords) continue
    if (fromWords.join(' ').length > rules.spanChars) continue
    const from = fromWords.map(strip).join(' ').trim()
    const to = toWords.map(strip).join(' ').trim()
    if (!rules.valid(to)) continue
    const id = rules.normalise(to)
    if (rules.normalise(from) === id || rules.known.has(id) || seen.has(id)) continue
    if (rewording(fromWords, toWords, to)) continue
    seen.add(id)
    out.push({ from, to })
  }
  return out.sort((x, y) => Number(/\p{Lu}/u.test(y.to)) - Number(/\p{Lu}/u.test(x.to))).slice(0, rules.max)
}
