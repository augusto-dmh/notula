// SPDX-License-Identifier: Apache-2.0
// WebVTT caption files as transcript cues. Pure, no imports: `captions.ts` uses it,
// and a dev run can feed it a real caption file.
//
// YouTube's automatic tracks roll: each cue shows the line before it again and adds one, and a
// 10 ms cue holds the line alone. A line equal to one of the last few emitted is dropped, so each
// spoken line appears once, at the cue that introduced it. Lines are then grouped into chunks of
// about a sentence, at most 15 s or 320 characters.

export interface Cue {
  startMs: number
  endMs: number
  text: string
}

const MAX_CUES = 50_000
/** Chunk grouping: a sentence end closes a chunk after this long; nothing grows past the cap. */
const CHUNK_SOFT_MS = 4_000
const CHUNK_MAX_MS = 15_000
const CHUNK_MAX_CHARS = 320
const CHUNK_GAP_MS = 2_500
/** Rolling auto-captions repeat a line within this many emitted lines. */
const ROLLING_WINDOW = 3
const SENTENCE_END = /[.!?…]["'”’)\]]?$/

const TIMING = /^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{3})\s+-->\s+(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{3})/

function ms(h: string | undefined, m: string, s: string, f: string): number {
  return ((Number(h ?? 0) * 60 + Number(m)) * 60 + Number(s)) * 1000 + Number(f)
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', lrm: '', rlm: '' }

export function cueText(line: string): string {
  return line
    .replace(/<[^>]*>/g, '')
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (all, e: string) => {
      if (e[0] === '#') {
        const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
        return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ''
      }
      return ENTITIES[e.toLowerCase()] ?? all
    })
    .replace(/\s+/g, ' ')
    .trim()
}

/** Every cue of a WebVTT file, each line kept apart (rolling captions are collapsed later). */
export function parseVtt(text: string): { startMs: number; endMs: number; lines: string[] }[] {
  const out: { startMs: number; endMs: number; lines: string[] }[] = []
  const blocks = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split(/\n{2,}/)
  for (const block of blocks) {
    const rows = block.split('\n')
    const at = rows.findIndex((r) => TIMING.test(r))
    if (at < 0) continue // header, NOTE, STYLE, REGION
    const m = TIMING.exec(rows[at] as string) as RegExpExecArray
    const startMs = ms(m[1], m[2] as string, m[3] as string, m[4] as string)
    const endMs = ms(m[5], m[6] as string, m[7] as string, m[8] as string)
    const lines = rows
      .slice(at + 1)
      .map(cueText)
      .filter(Boolean)
    if (lines.length) out.push({ startMs, endMs: Math.max(startMs, endMs), lines })
    if (out.length >= MAX_CUES) break
  }
  return out.sort((a, b) => a.startMs - b.startMs)
}

/**
 * One cue per new line. YouTube's automatic tracks show two lines, the older one repeated from
 * the cue before, and add a 10 ms cue holding the line alone; a line equal to one of the last
 * few emitted is dropped, so each spoken line appears once, at the cue that introduced it.
 */
export function collapseRolling(cues: { startMs: number; endMs: number; lines: string[] }[], rolling = true): Cue[] {
  // A manual track doesn't roll: only a line repeated back to back is a duplicate there.
  const window = rolling ? ROLLING_WINDOW : 1
  const out: Cue[] = []
  const recent: string[] = []
  for (const c of cues) {
    for (const line of c.lines) {
      const key = line.toLowerCase()
      if (recent.includes(key)) continue
      recent.push(key)
      if (recent.length > window) recent.shift()
      out.push({ startMs: c.startMs, endMs: c.endMs, text: line })
    }
  }
  // A rolling line stays on screen into the next one: it ends where the next begins.
  for (let i = 0; i < out.length - 1; i++) {
    const cur = out[i] as Cue
    const next = out[i + 1] as Cue
    if (next.startMs > cur.startMs && cur.endMs > next.startMs) cur.endMs = next.startMs
  }
  return out
}

/** Lines grouped into chunks of about a sentence, never longer than 15 s or 320 characters. */
export function groupCues(cues: Cue[]): Cue[] {
  const out: Cue[] = []
  let cur: Cue | null = null
  for (const c of cues) {
    if (cur) {
      const span = c.endMs - cur.startMs
      const gap = c.startMs - cur.endMs
      const closeAtSentence = SENTENCE_END.test(cur.text) && cur.endMs - cur.startMs >= CHUNK_SOFT_MS
      if (gap > CHUNK_GAP_MS || span > CHUNK_MAX_MS || cur.text.length + c.text.length + 1 > CHUNK_MAX_CHARS || closeAtSentence) {
        out.push(cur)
        cur = null
      }
    }
    if (!cur) cur = { ...c }
    else {
      cur.text = `${cur.text} ${c.text}`
      cur.endMs = Math.max(cur.endMs, c.endMs)
    }
  }
  if (cur) out.push(cur)
  return out
}

/** VTT text → transcript chunks' cues. `rolling`: an automatic track. */
export function cuesFromVtt(text: string, rolling = true): Cue[] {
  return groupCues(collapseRolling(parseVtt(text), rolling))
}
