// SPDX-License-Identifier: Apache-2.0
// Transcript files. Pure. The header grammar is shared by the study vault, Notula's own
// transcript export and a transcript copy: optional `Meeting Title:`, `Date:` and
// `Meeting participants:` lines, a blank line, `Transcript:` or `Transcript (<origin>):`, then
// the body. Body forms:
// - timed: paragraphs that start `[mm:ss]` or `[h:mm:ss]`; a line with no anchor joins the
//   previous paragraph. One chunk per paragraph, ending at the next one (or 30 s later). When
//   every paragraph reads `[mm:ss] Label: text` (Notula's export format 2), the label is the
//   speaker; a caption file, where only some lines hold a colon, keeps its text whole;
// - untimed turns: `<Label>: <text>` lines, one chunk per line, 1 s apart; the session is
//   flagged untimed so its times are hidden;
// - placeholder: the known phrases, or a body under 20 characters: no transcript, and its links
//   become candidates.
// Speakers: `Me` → microphone, `Them` → system, any other label → system with that name.

import type { AudioSource } from '@shared/types/common'
import { IMPORT_LIMITS } from '@shared/types/imports-markdown'

const HEADER = /^(Meeting Title|Date|Meeting participants):[ \t]*(.*)$/
const TRANSCRIPT_LINE = /^Transcript(?:\s*\((.*)\))?\s*:\s*$/
const ANCHOR = /^\[(?:(\d{1,2}):)?(\d{1,3}):(\d{2})\]\s*(.*)$/
const TURN = /^([^:\n]{1,60}?):\s+(\S.*)$/
const PLACEHOLDERS = [/^Verbatim transcript is not available/i, /^No [\p{L}\d .-]{1,30} note exists/iu]

export interface ParsedTurn {
  source: AudioSource
  speaker: string | null
  /** Offset from the anchor. */
  startMs: number
  endMs: number
  text: string
}

export interface ParsedTranscript {
  title: string | null
  date: string | null
  /** The text inside `Transcript (…)`. */
  origin: string | null
  /** BCP-47-ish code from the origin (`en-orig` → `en`), else `und`. */
  language: string
  kind: 'timed' | 'untimed' | 'placeholder'
  turns: ParsedTurn[]
  /** Turns over the 20,000 limit that were dropped. */
  dropped: number
  /** The body as written, for a placeholder's links. */
  body: string
  /** The last anchor of a timed transcript. */
  lastAnchorMs: number | null
}

/** True when the first non-empty lines follow the transcript header grammar. */
export function looksLikeTranscript(text: string): boolean {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/)
  let seen = 0
  for (const line of lines) {
    const t = line.trim()
    if (!t) continue
    if (TRANSCRIPT_LINE.test(t)) return true
    if (!HEADER.test(t) || ++seen > 3) return false
  }
  return false
}

function languageOf(origin: string | null): string {
  if (!origin) return 'und'
  for (const part of origin.split(',')) {
    const m = /^([a-z]{2})(?:-[A-Za-z]{2,4})?(?:-orig)?$/.exec(part.trim())
    if (m) return m[1]!
  }
  return 'und'
}

function speakerOf(label: string): { source: AudioSource; speaker: string | null } {
  const l = label.trim()
  if (l === 'Me') return { source: 'microphone', speaker: null }
  if (l === 'Them') return { source: 'system', speaker: null }
  return { source: 'system', speaker: l }
}

/** Parses a transcript file's text (or a study lesson's `Transcription.md`). */
export function parseTranscript(text: string): ParsedTranscript {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/)
  let title: string | null = null
  let date: string | null = null
  let origin: string | null = null
  let i = 0
  let foundMarker = false
  // The header: up to the `Transcript…:` line within the first lines.
  for (let j = 0; j < Math.min(lines.length, 12); j++) {
    const t = lines[j]!.trim()
    if (!t) continue
    const marker = TRANSCRIPT_LINE.exec(t)
    if (marker) {
      origin = marker[1]?.trim() || null
      i = j + 1
      foundMarker = true
      break
    }
    const h = HEADER.exec(t)
    if (!h) break
    if (h[1] === 'Meeting Title') title = h[2]!.trim() || null
    else if (h[1] === 'Date') date = h[2]!.trim() || null
  }
  const bodyLines = foundMarker ? lines.slice(i) : lines
  const body = bodyLines.join('\n').trim()
  const base: Omit<ParsedTranscript, 'kind' | 'turns' | 'dropped' | 'lastAnchorMs'> = { title, date, origin, language: languageOf(origin), body }
  const nonEmpty = bodyLines.map((l) => l.trim()).filter(Boolean)

  if (body.length < 20 || PLACEHOLDERS.some((p) => p.test(nonEmpty[0] ?? ''))) {
    return { ...base, kind: 'placeholder', turns: [], dropped: 0, lastAnchorMs: null }
  }

  // Timed: the first content line carries an anchor.
  if (ANCHOR.test(nonEmpty[0] ?? '')) {
    const paras: { at: number; text: string }[] = []
    for (const l of nonEmpty) {
      const m = ANCHOR.exec(l)
      if (m) paras.push({ at: ((Number(m[1] ?? 0) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000, text: m[4]!.trim() })
      else if (paras.length) paras[paras.length - 1]!.text += ` ${l}`
    }
    const labelled = paras.filter((p) => p.text).map((p) => TURN.exec(p.text))
    const speakers = labelled.length > 0 && labelled.every((m) => m !== null && !/https?:\/\//.test(m[1]!))
    const turns: ParsedTurn[] = []
    for (let k = 0, n = 0; k < paras.length; k++) {
      const p = paras[k]!
      const next = paras[k + 1]
      const end = next && next.at > p.at ? next.at : p.at + 30_000
      if (!p.text) continue
      const m = speakers ? labelled[n] : null
      n++
      if (m) turns.push({ ...speakerOf(m[1]!), startMs: p.at, endMs: end, text: m[2]!.trim() })
      else turns.push({ source: 'system', speaker: null, startMs: p.at, endMs: end, text: p.text })
    }
    const kept = turns.slice(0, IMPORT_LIMITS.chunksPerNote)
    return {
      ...base,
      kind: 'timed',
      turns: kept,
      dropped: turns.length - kept.length,
      lastAnchorMs: paras.length ? paras[paras.length - 1]!.at : null
    }
  }

  // Untimed turns: `Label: text`; a line without a label continues the previous turn.
  const turns: ParsedTurn[] = []
  for (const l of nonEmpty) {
    const m = TURN.exec(l)
    if (m && !/https?:\/\//.test(m[1]!)) {
      const who = speakerOf(m[1]!)
      turns.push({ ...who, startMs: 0, endMs: 0, text: m[2]!.trim() })
    } else if (turns.length) {
      turns[turns.length - 1]!.text += ` ${l}`
    } else {
      turns.push({ source: 'system', speaker: null, startMs: 0, endMs: 0, text: l })
    }
  }
  const kept = turns.slice(0, IMPORT_LIMITS.chunksPerNote).map((t, k) => ({ ...t, startMs: k * 1000, endMs: k * 1000 + 1000 }))
  return { ...base, kind: 'untimed', turns: kept, dropped: turns.length - kept.length, lastAnchorMs: null }
}
