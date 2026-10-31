// SPDX-License-Identifier: Apache-2.0
// Watching a field after a paste (Windows only for now): every 500 ms for up to 30 s the desk
// helper re-reads the focused field. Watching stops on Return or Tab (the key hook's `commit`),
// at the next dictation, when the field disappears, or at 30 s.
//
// - The edit is usable for word learning only when watching stopped on Return or Tab, the last
//   reading is at most 1.5 s old, and the text changed since the first reading after the paste.
// - Duplicate paste: when the field holds the pasted words twice more than it did before the
//   paste, and the second copy starts within 3 words of the first one's end, watching stops with
//   `duplicated`. The field is never edited.
// Nothing read here leaves the device; only counts are logged.

import { DICTATION_LIMITS as L } from '@shared/types/dictation'
import type { DeskContext, Desk } from './desk'

export type ObserveOutcome = 'committed' | 'timeout' | 'next-dictation' | 'field-gone' | 'duplicated' | 'stopped'

export interface Observation {
  outcome: ObserveOutcome
  /** The first reading after the paste and the last one, as word lists. */
  before: string[] | null
  after: string[] | null
  /** Where the pasted words sit in `before` ([start, end) word indexes), when found. */
  pasted: [number, number] | null
  /** The edit can be learned from (committed, fresh, changed). */
  usable: boolean
  duplicate: { pastedWords: number; wordGap: number } | null
}

/** Whitespace-separated tokens. */
export const wordsOf = (text: string): string[] => text.split(/\s+/).filter(Boolean)

/** A token compared without case or surrounding punctuation. */
const bare = (w: string): string => w.normalize('NFC').toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')

const fieldText = (c: DeskContext): string => `${c.before}${c.selection}${c.after}`

/** Every start index where `needle` occurs in `hay` (bare comparison). */
function occurrences(hay: readonly string[], needle: readonly string[]): number[] {
  const out: number[] = []
  if (!needle.length) return out
  const h = hay.map(bare)
  const n = needle.map(bare)
  for (let i = 0; i + n.length <= h.length; i++) if (n.every((w, j) => h[i + j] === w)) out.push(i)
  return out
}

/** Two copies of the pasted words, the second starting within 3 words of the first one's end. */
export function findDuplicate(text: readonly string[], pasted: readonly string[], copiesBefore: number): { pastedWords: number; wordGap: number } | null {
  // A single word is too common to tell a duplicate paste from a repeat.
  if (pasted.length < 2) return null
  const at = occurrences(text, pasted)
  if (at.length < copiesBefore + 2) return null
  for (let k = 1; k < at.length; k++) {
    const gap = at[k]! - (at[k - 1]! + pasted.length)
    if (gap >= 0 && gap <= L.duplicateGapWords) return { pastedWords: pasted.length, wordGap: gap }
  }
  return null
}

export class PasteWatcher {
  private stopWith: ObserveOutcome | null = null
  private wake: (() => void) | null = null

  constructor(private readonly desk: Desk) {}

  /** Ends the watch at its next step. */
  stop(outcome: Extract<ObserveOutcome, 'committed' | 'next-dictation' | 'stopped'>): void {
    if (this.stopWith) return
    this.stopWith = outcome
    this.wake?.()
  }

  /** `prior` is the field read before the paste; `pasted` the delivered text. */
  async watch(pasted: string, prior: DeskContext | null): Promise<Observation> {
    const pastedWords = wordsOf(pasted)
    const copiesBefore = prior?.result === 'captured' ? occurrences(wordsOf(fieldText(prior)), pastedWords).length : 0
    const startedAt = Date.now()
    let first: string[] | null = null
    let last: string[] | null = null
    let lastAt = 0
    let identity: string | null = null
    const result = (outcome: ObserveOutcome, duplicate: Observation['duplicate'] = null): Observation => {
      const changed = !!first && !!last && first.join(' ') !== last.join(' ')
      const usable = outcome === 'committed' && changed && Date.now() - lastAt <= L.observeFreshMs
      let range: [number, number] | null = null
      if (first) {
        const at = occurrences(first, pastedWords)
        const start = at[at.length - 1]
        if (start !== undefined) range = [start, start + pastedWords.length]
      }
      return { outcome, before: first, after: last, pasted: range, usable, duplicate }
    }

    for (;;) {
      if (this.stopWith) return result(this.stopWith)
      if (Date.now() - startedAt >= L.observeMaxMs) return result('timeout')
      const c = await this.desk.context(L.contextMs)
      if (this.stopWith) return result(this.stopWith)
      if (c.result !== 'captured' || !c.field) return result('field-gone')
      const id = `${c.process}\u0000${c.field.name}\u0000${c.field.type}`
      if (identity === null) identity = id
      else if (identity !== id) return result('field-gone')
      const words = wordsOf(fieldText(c))
      // The first reading that shows the paste landed is the baseline.
      if (!first && occurrences(words, pastedWords).length > copiesBefore) first = words
      last = words
      lastAt = Date.now()
      const dup = findDuplicate(words, pastedWords, copiesBefore)
      if (dup) return result('duplicated', dup)
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, L.observeEveryMs)
        this.wake = () => {
          clearTimeout(t)
          resolve()
        }
      })
      this.wake = null
    }
  }
}
