// SPDX-License-Identifier: Apache-2.0
// The plain-text transcript copy. Pure: no Electron and
// no Node built-ins.
//
// Header lines, each only if it exists, one per line: `Meeting Title: <title>`,
// `Date: <short month> <day>` (US English; the event's start date-time, else its start
// date, else the note's creation), and `Meeting participants: <names>` (the creator,
// then the attendees, deduplicated by email). Then a blank line, `Transcript:` and a
// line break, then one `Label: text` line per turn. With no header lines the text
// starts with `Transcript:` and a line break.

import type { Note, NotePerson } from '../types/notes'
import type { TranscriptChunk } from '../types/transcript'
import { displayName } from './people'
import { speakerTurns } from './speakers'

/** A date-only start is the calendar date in local time, with no UTC shift. */
function headerDate(note: Pick<Note, 'linked_event' | 'created_at'>): string | null {
  const start = note.linked_event?.start
  let d: Date
  if (start?.dateTime) d = new Date(start.dateTime)
  else if (start?.date && /^\d{4}-\d{2}-\d{2}$/.test(start.date)) {
    const [y, m, day] = start.date.split('-').map(Number) as [number, number, number]
    d = new Date(y, m - 1, day)
  } else d = new Date(note.created_at)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function participants(note: Pick<Note, 'people'>): string[] {
  const people = [note.people?.creator, ...(note.people?.attendees ?? [])].filter((p): p is NotePerson => !!p)
  const seen = new Set<string>()
  const names: string[] = []
  for (const p of people) {
    const email = p.email?.trim().toLowerCase()
    if (email) {
      if (seen.has(email)) continue
      seen.add(email)
    }
    if (!email && !p.name?.trim()) continue
    // The participant name rule is the shared one: the name, else one built
    // from the email's local part, else `Unknown`.
    names.push(displayName(p))
  }
  return names
}

export function transcriptCopyText(input: {
  note: Pick<Note, 'title' | 'linked_event' | 'people' | 'created_at'>
  chunks: TranscriptChunk[]
  wordLevel: boolean
}): string {
  const { note } = input
  const head: string[] = []
  const title = note.title?.trim()
  if (title) head.push(`Meeting Title: ${title}`)
  const date = headerDate(note)
  if (date) head.push(`Date: ${date}`)
  const people = participants(note)
  if (people.length) head.push(`Meeting participants: ${people.join(', ')}`)
  const lines = speakerTurns(input.chunks, { wordLevel: input.wordLevel, live: false }).map((t) => `${t.label}: ${t.text}`)
  const body = `Transcript:\n${lines.join('\n')}`
  return head.length ? `${head.join('\n')}\n\n${body}` : body
}
