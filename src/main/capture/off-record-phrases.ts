// SPDX-License-Identifier: Apache-2.0
// The off-the-record phrase list and its matcher. A phrase matches case-insensitively, with
// punctuation between its words and at most one filler word ("um", "uh", "er", "like") in each
// gap. A match is only a candidate: the user's LLM decides whether it was a real request.

/** Grouped by intent; written for Notula. */
const PHRASES: readonly string[] = [
  // leave the record
  'off the record',
  'keep that off the record',
  'keep this off the record',
  "don't put this on record",
  "don't put this on the record",
  "let's go off the record",
  // a private aside
  'just between us',
  'this is between the two of us',
  'between you and me',
  "this doesn't leave the room",
  "this stays in the room",
  // confidential
  'in confidence',
  'this part is confidential',
  'strictly confidential',
  'this is confidential',
  // stop capturing
  'stop the transcription',
  'stop transcribing',
  'pause the notes',
  'pause the transcription',
  'stop taking notes',
  'turn the recording off',
  'turn off the recording',
  'stop the recording',
  'can we pause the recording',
  'switch notula off',
  'turn notula off',
  // don't capture this
  "don't note this",
  "don't write this down",
  'leave this out of the notes',
  'keep this out of the notes',
  "please don't transcribe this",
  "don't transcribe this",
  'no notes for this part'
]

const FILLER = '(?:um|uh|er|like)'
/** Punctuation or space between two words. */
const GAP = `[\\s,.;:!?"“”‘’()\\-–—]+`

function wordPattern(word: string): string {
  return word
    .split('')
    .map((ch) => (ch === "'" ? "['’]" : ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('')
}

const MATCHERS: readonly { phrase: string; re: RegExp }[] = PHRASES.map((phrase) => {
  const words = phrase.split(' ').map(wordPattern)
  const body = words.join(`${GAP}(?:${FILLER}${GAP})?`)
  return { phrase, re: new RegExp(`(?<![\\w'’])${body}(?![\\w'’])`, 'gi') }
})

export interface PhraseMatch {
  phrase: string
  /** Where the match ends in the new line (exclusive). */
  end: number
  /** Where it starts in the new line; negative when it began in the previous line. */
  start: number
}

/** The previous final line's tail that counts, so a phrase split across two lines is found. */
export const PREFIX_CHARS = 160

/**
 * The earliest phrase that ends inside `line`, read after `prefix` (the end of the previous final
 * line from the same source). A match wholly inside the prefix does not count.
 */
export function findRequest(prefix: string, line: string): PhraseMatch | null {
  const tail = prefix.slice(-PREFIX_CHARS)
  const lead = tail ? `${tail} ` : ''
  const text = lead + line
  let best: PhraseMatch | null = null
  for (const { phrase, re } of MATCHERS) {
    re.lastIndex = 0
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const end = m.index + m[0].length - lead.length
      if (end > 0) {
        if (!best || end < best.end) best = { phrase, end, start: m.index - lead.length }
        break
      }
      // Wholly in the previous line: look again from the next character, for an overlapping match.
      re.lastIndex = m.index + 1
    }
  }
  return best
}
