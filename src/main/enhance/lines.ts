// SPDX-License-Identifier: Apache-2.0
// Line provenance (`ai_line_map`): an output line with no trimmed,
// case-insensitive match among the user's note lines is AI-generated. A matched
// line carries the note lines it matched in `matches`. Markdown markers (headings,
// bullets, task boxes, emphasis) are ignored on both sides.

import type { GeneratedLine } from '@shared/types/panels'

function normalize(line: string): string {
  return line
    .trim()
    .replace(/^#{1,6}\s+/, '')
    .replace(/^(?:[-*+]|\d+[.)])\s+/, '')
    .replace(/^\[[ xX]\]\s+/, '')
    .replace(/[*_`~]/g, '')
    .replace(/[.:;,!?]+$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/** Note lines by their normalized text. */
export function noteLineIndex(notes: string): Map<string, string[]> {
  const index = new Map<string, string[]>()
  for (const raw of notes.split('\n')) {
    const key = normalize(raw)
    if (!key) continue
    const list = index.get(key) ?? []
    list.push(raw.trim())
    index.set(key, list)
  }
  return index
}

/** One entry per non-empty output line, in order. */
export function generatedLines(output: string, notes: Map<string, string[]>): GeneratedLine[] {
  const lines: GeneratedLine[] = []
  for (const raw of output.split('\n')) {
    const text = raw.trim()
    if (!text) continue
    const matches = notes.get(normalize(text))
    lines.push(matches ? { text, matches } : { text })
  }
  return lines
}
