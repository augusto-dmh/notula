// SPDX-License-Identifier: Apache-2.0
// Watching a field after a paste (Windows only for now): every 500 ms for up to 30 s the desk
// helper reads the text within 2,000 characters of the caret (`field`). Watching stops on Return
// or Tab (the key hook's `commit`), at the next dictation, when the field is gone, or at 30 s.
//
// - The field is followed by what stays put while the user edits: the foreground window (its
//   process and handle), and the words around the paste (./edits.ts `sameField`). Clicks and
//   selections inside it change neither.
// - A read that fails, times out (1.5 s), finds no focused text or finds another window or field
//   is a miss. Misses are tolerated for 2.5 s; after that the field is gone.
// - The edit is usable for word learning when the text changed since the first reading that shows
//   the paste, and the last reading is settled: on Return or Tab, at most 1.5 s old; otherwise
//   equal to the reading before it, so a word half typed when the user moved on isn't learned.
// - Duplicate paste (screen context on): when the field holds the pasted words twice more than it did before the
//   paste, and the second copy starts within 3 words of the first one's end, watching stops with
//   `duplicated`. The field is never edited.
// Nothing read here leaves the device; only counts and the reason a read missed are logged.

import { DICTATION_LIMITS as L } from '@shared/types/dictation'
import type { Desk, DeskContext } from './desk'
import { findDuplicate, occurrences, pastedRange, readingWords, sameField, wordsOf } from './edits'

export type ObserveOutcome = 'committed' | 'timeout' | 'next-dictation' | 'field-gone' | 'duplicated' | 'stopped'

/** Why a read didn't count. */
export type ObserveMiss = 'no-reply' | 'error' | 'no-focus' | 'secure' | 'no-text' | 'wide-selection' | 'other-window' | 'other-field'

export interface Observation {
  outcome: ObserveOutcome
  /** The first reading that shows the paste and the last one, as word lists. */
  before: string[] | null
  after: string[] | null
  /** Where the pasted words sit in `before` ([start, end) word indexes), when found. */
  pasted: [number, number] | null
  /** The edit can be learned from (changed and settled). */
  usable: boolean
  duplicate: { pastedWords: number; wordGap: number } | null
  /** For the log: counts and reasons only. */
  diag: { reads: number; misses: number; lastMiss: ObserveMiss | null; slowestMs: number; baseline: boolean; changed: boolean; settled: boolean }
}

const READ_MS = 1_500
const MISS_MS = 2_500

const fieldText = (c: DeskContext): string => `${c.before}${c.selection}${c.after}`
const same = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((w, i) => w === b[i])

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

  /** `prior` is the field read before the paste; `pasted` the delivered text; `duplicates` checks for a duplicate paste. */
  async watch(pasted: string, prior: DeskContext | null, duplicates: boolean): Promise<Observation> {
    const pastedWords = wordsOf(pasted)
    const copiesBefore = prior?.result === 'captured' ? occurrences(wordsOf(fieldText(prior)), pastedWords).length : 0
    const startedAt = Date.now()
    let first: string[] | null = null
    let range: [number, number] | null = null
    let previous: string[] | null = null
    let last: string[] | null = null
    let lastAt = 0
    let window: string | null = null
    let missSince: number | null = null
    let lastMiss: ObserveMiss | null = null
    let reads = 0
    let misses = 0
    let slowestMs = 0

    const result = (outcome: ObserveOutcome, duplicate: Observation['duplicate'] = null): Observation => {
      const changed = !!first && !!last && !same(first, last)
      const settled = outcome === 'committed' ? Date.now() - lastAt <= L.observeFreshMs : !!previous && !!last && same(previous, last)
      const learnable = outcome === 'committed' || outcome === 'timeout' || outcome === 'field-gone' || outcome === 'next-dictation'
      return {
        outcome,
        before: first,
        after: last,
        pasted: range,
        usable: learnable && changed && settled,
        duplicate,
        diag: { reads, misses, lastMiss, slowestMs, baseline: !!first, changed, settled }
      }
    }
    const miss = (why: ObserveMiss): boolean => {
      misses++
      lastMiss = why
      missSince ??= Date.now()
      return Date.now() - missSince >= MISS_MS
    }

    for (;;) {
      if (this.stopWith) return result(this.stopWith)
      if (Date.now() - startedAt >= L.observeMaxMs) return result('timeout')
      const t0 = Date.now()
      const r = await this.desk.field(READ_MS)
      reads++
      slowestMs = Math.max(slowestMs, Date.now() - t0)
      if (this.stopWith) return result(this.stopWith)
      let gone = false
      if (typeof r === 'string') gone = miss(r)
      else if (r.result !== 'read') gone = miss(r.result)
      else if (window !== null && window !== `${r.pid}:${r.window}`) gone = miss('other-window')
      else {
        window ??= `${r.pid}:${r.window}`
        const words = readingWords(r)
        if (!first) {
          // The first reading that shows the paste landed is the baseline.
          if (occurrences(words, pastedWords).length > copiesBefore) {
            first = words
            range = pastedRange(words, pastedWords)
            last = words
            lastAt = Date.now()
          }
          missSince = null
        } else if (range && !sameField(first, range, words)) gone = miss('other-field')
        else {
          missSince = null
          previous = last
          last = words
          lastAt = Date.now()
        }
        const dup = duplicates && !gone && last === words ? findDuplicate(words, pastedWords, copiesBefore, L.duplicateGapWords) : null
        if (dup) return result('duplicated', dup)
      }
      if (gone) return result('field-gone')
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
