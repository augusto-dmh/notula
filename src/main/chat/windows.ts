// SPDX-License-Identifier: Apache-2.0
// Transcript windows: the
// speaker-labelled transcript split into windows of about 1,500 characters that never
// split a turn (a turn longer than a window is split between sentences). Window n of
// a note is cited as `[<noteId>-<n>]`.

import type { SpeakerTurn } from '@shared/lib/speakers'
import { CHAT_LIMITS } from '@shared/types/chat'
import { countTerms, queryTerms } from './text'

export interface WindowLine {
  label: string
  text: string
}

export interface TranscriptWindow {
  /** 1-based. */
  n: number
  start: string
  end: string
  lines: WindowLine[]
}

const MINUTE_MS = 60_000
const LIVE_RECENT_MS = 10 * MINUTE_MS
const KEEP_FIRST = 2
const KEEP_LAST = 4

/** Sentences of a text, keeping their end punctuation. */
export function sentences(text: string): string[] {
  return (text.match(/[^.!?…]+(?:[.!?…]+["'”’)\]]*|$)/gu) ?? [text]).map((s) => s.trim()).filter(Boolean)
}

/** Pieces of at most `size` characters, split between sentences where possible. */
function pieces(text: string, size: number): string[] {
  if (text.length <= size) return [text]
  const out: string[] = []
  let cur = ''
  for (const s of sentences(text)) {
    if (cur && cur.length + 1 + s.length > size) {
      out.push(cur)
      cur = ''
    }
    if (s.length > size) {
      for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size))
      continue
    }
    cur = cur ? `${cur} ${s}` : s
  }
  if (cur) out.push(cur)
  return out
}

export function transcriptWindows(turns: SpeakerTurn[], size: number = CHAT_LIMITS.transcriptWindowChars): TranscriptWindow[] {
  const out: TranscriptWindow[] = []
  let cur: TranscriptWindow | null = null
  let chars = 0
  for (const turn of turns) {
    const text = turn.text.trim()
    if (!text) continue
    for (const piece of pieces(text, size)) {
      const len = turn.label.length + 2 + piece.length + 1
      if (cur && chars + len > size) {
        out.push(cur)
        cur = null
      }
      if (!cur) {
        cur = { n: out.length + 1, start: turn.startTimestamp, end: turn.endTimestamp, lines: [] }
        chars = 0
      }
      cur.lines.push({ label: turn.label, text: piece })
      cur.end = turn.endTimestamp
      chars += len
    }
  }
  if (cur) out.push(cur)
  return out
}

function clock(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
}

export function windowKey(noteId: string, n: number): string {
  return `${noteId}-${n}`
}

export function renderWindow(noteId: string, w: TranscriptWindow): string {
  const time = clock(w.start)
  return [`[${windowKey(noteId, w.n)}]${time ? ` ${time}` : ''}`, ...w.lines.map((l) => `${l.label}: ${l.text}`)].join('\n')
}

/** The "[… N minutes not included …]" line for the time between two instants. */
function gapLine(from: string, to: string): string {
  const ms = Date.parse(to) - Date.parse(from)
  const minutes = Number.isFinite(ms) ? Math.max(1, Math.round(ms / MINUTE_MS)) : 1
  return `[… ${minutes} minute${minutes === 1 ? '' : 's'} not included …]`
}

/**
 * The windows that fit `budget` characters, in time order, with a gap line for each
 * run left out. Everything when it all fits; otherwise the first 2 and the last 4
 * (live: every window of the last 10 minutes), then the rest ranked by how many of
 * the question's terms they hold, ties to the later window.
 */
export function fitTranscript(
  noteId: string,
  windows: TranscriptWindow[],
  budget: number,
  opts: { question: string; live: boolean }
): { text: string; included: TranscriptWindow[]; complete: boolean } {
  if (windows.length === 0 || budget <= 0) return { text: '', included: [], complete: windows.length === 0 }
  const rendered = windows.map((w) => renderWindow(noteId, w))
  const total = rendered.reduce((n, r) => n + r.length + 2, 0)
  if (total <= budget) return { text: rendered.join('\n\n'), included: windows, complete: true }

  const keep = new Set<number>()
  for (let i = 0; i < Math.min(KEEP_FIRST, windows.length); i++) keep.add(i)
  if (opts.live) {
    const lastEnd = Date.parse(windows[windows.length - 1]?.end ?? '')
    windows.forEach((w, i) => {
      if (Number.isFinite(lastEnd) && Date.parse(w.end) >= lastEnd - LIVE_RECENT_MS) keep.add(i)
    })
  } else {
    for (let i = Math.max(0, windows.length - KEEP_LAST); i < windows.length; i++) keep.add(i)
  }
  const terms = queryTerms(opts.question)
  const chosen = new Set<number>()
  let used = 0
  const take = (i: number): boolean => {
    const cost = (rendered[i]?.length ?? 0) + 40
    if (used + cost > budget) return false
    used += cost
    chosen.add(i)
    return true
  }
  // The kept windows go first, latest first when even they don't all fit.
  for (const i of [...keep].sort((a, b) => b - a)) take(i)
  const rest = windows
    .map((w, i) => ({ i, score: countTerms(w.lines.map((l) => l.text).join(' '), terms) }))
    .filter((r) => !chosen.has(r.i))
    .sort((a, b) => b.score - a.score || b.i - a.i)
  for (const r of rest) take(r.i)

  const order = [...chosen].sort((a, b) => a - b)
  const parts: string[] = []
  order.forEach((i, k) => {
    const prev = order[k - 1]
    const w = windows[i] as TranscriptWindow
    if (k === 0 && i > 0) parts.push(gapLine((windows[0] as TranscriptWindow).start, w.start))
    if (prev !== undefined && i > prev + 1) parts.push(gapLine((windows[prev] as TranscriptWindow).end, w.start))
    parts.push(rendered[i] as string)
  })
  const lastChosen = order[order.length - 1]
  if (lastChosen !== undefined && lastChosen < windows.length - 1) {
    parts.push(gapLine((windows[lastChosen] as TranscriptWindow).end, (windows[windows.length - 1] as TranscriptWindow).end))
  }
  return { text: parts.join('\n\n'), included: order.map((i) => windows[i] as TranscriptWindow), complete: false }
}

/**
 * The quote for a transcript citation: the sentence of
 * the window that best matches the cited line; the window's first sentence otherwise.
 */
export function quoteFor(w: TranscriptWindow, line: string): string | null {
  const terms = queryTerms(line)
  let best: string | null = null
  let bestScore = -1
  for (const l of w.lines) {
    for (const s of sentences(l.text)) {
      const score = countTerms(s, terms)
      if (score > bestScore) {
        best = s
        bestScore = score
      }
    }
  }
  return best ? best.slice(0, 300) : null
}
