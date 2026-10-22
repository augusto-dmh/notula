// SPDX-License-Identifier: Apache-2.0
// Citations. Every
// context item carries a key the model cites: `[<noteId>]` for a note or its summary,
// `[<noteId>-<n>]` for transcript window n. After completion each line's keys become
// that line's citations, the keys leave the text, and a key that matches nothing the
// model was given is dropped. Quotes come from the local transcript windows, so there
// is no citation service.

import type { ChatCitation, ChatOutput } from '@shared/types/chat'
import { quoteFor, type TranscriptWindow } from './windows'

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
/** One bracket with one or more keys (`[a]`, `[a-3]`, `[a, b-2]`). */
const BRACKET = new RegExp(`\\s?\\[\\s*(${UUID}(?:-\\d+)?(?:\\s*[,;]\\s*${UUID}(?:-\\d+)?)*)\\s*\\]`, 'gi')
const KEY = new RegExp(`(${UUID})(?:-(\\d+))?`, 'gi')

/** What the model was shown: notes by id, and transcript windows by `<noteId>-<n>`. */
export class CitationIndex {
  readonly notes = new Map<string, string>()
  readonly windows = new Map<string, TranscriptWindow>()

  addNote(id: string, title: string): void {
    this.notes.set(id.toLowerCase(), title)
  }

  addWindows(noteId: string, windows: readonly TranscriptWindow[]): void {
    for (const w of windows) this.windows.set(`${noteId.toLowerCase()}-${w.n}`, w)
  }

  has(noteId: string): boolean {
    return this.notes.has(noteId.toLowerCase())
  }
}

/** Removes every citation key and tidies the spacing it leaves (copy and display). */
export function stripCitationKeys(text: string): string {
  return text.replace(BRACKET, '').replace(/[ \t]+([.,;:!?])/g, '$1').replace(/[ \t]{2,}/g, ' ')
}

/**
 * A text output as `cited_text`, its lines numbered from `lineOffset`. Lines
 * inside fenced code keep their text untouched.
 */
export function citeText(
  text: string,
  index: CitationIndex,
  messageId: string,
  lineOffset: number
): { output: ChatOutput; lines: number; citedNoteIds: string[] } {
  const cited = new Set<string>()
  let fenced = false
  const answer_lines = text.split('\n').map((line, i) => {
    const citations: ChatCitation[] = []
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced
    let answer = line
    if (!fenced) {
      const seen = new Set<string>()
      for (const bracket of line.matchAll(BRACKET)) {
        for (const m of (bracket[1] ?? '').matchAll(KEY)) {
          const noteId = (m[1] ?? '').toLowerCase()
          const n = m[2]
          const key = n ? `${noteId}-${n}` : noteId
          if (seen.has(key)) continue
          if (n) {
            const w = index.windows.get(key)
            if (!w) continue
            seen.add(key)
            citations.push({
              message_id: messageId,
              meeting_id: noteId,
              brief_id: null,
              answer_line: lineOffset + i,
              source_kind: 'transcript',
              source_quote: quoteFor(w, stripCitationKeys(line))
            })
          } else {
            if (!index.has(noteId)) continue
            seen.add(key)
            citations.push({
              message_id: messageId,
              meeting_id: noteId,
              brief_id: null,
              answer_line: lineOffset + i,
              source_kind: 'summary',
              source_quote: null
            })
          }
          cited.add(noteId)
        }
      }
      answer = stripCitationKeys(line)
    }
    return { line_text: answer, citations, line_index: lineOffset + i }
  })
  return {
    output: { type: 'cited_text', plain_text: answer_lines.map((l) => l.line_text).join('\n'), answer_lines },
    lines: answer_lines.length,
    citedNoteIds: [...cited]
  }
}
