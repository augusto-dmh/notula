// SPDX-License-Identifier: Apache-2.0
// The streaming view: only complete lines
// (everything up to the last newline), rendered from markdown a line at a time. Lines
// the model wrote are tagged AI-generated; lines that match the user's own notes are
// not, so the user's words stand out (ai_line_map).

import { memo, type JSX, type ReactNode } from 'react'
import type { GeneratedLine } from '@shared/types/panels'

type Block =
  | { kind: 'heading'; level: 1 | 2 | 3; text: string; raw: string }
  | { kind: 'item'; depth: number; marker: 'bullet' | 'number' | 'task'; number?: string; checked?: boolean; text: string; raw: string }
  | { kind: 'paragraph'; text: string; raw: string }

const HEADING = /^(#{1,6})\s+(.*)$/
const TASK = /^([-*+])\s+\[([ xX])\]\s+(.*)$/
const BULLET = /^([-*+])\s+(.*)$/
const NUMBER = /^(\d+)[.)]\s+(.*)$/

function parseLine(line: string): Block | null {
  const raw = line.trim()
  if (!raw) return null
  const indent = line.length - line.trimStart().length
  const depth = Math.min(4, Math.floor(indent / 2))
  let m = HEADING.exec(raw)
  if (m) return { kind: 'heading', level: Math.min(3, (m[1] as string).length) as 1 | 2 | 3, text: m[2] ?? '', raw }
  m = TASK.exec(raw)
  if (m) return { kind: 'item', depth, marker: 'task', checked: m[2] !== ' ', text: m[3] ?? '', raw }
  m = BULLET.exec(raw)
  if (m) return { kind: 'item', depth, marker: 'bullet', text: m[2] ?? '', raw }
  m = NUMBER.exec(raw)
  if (m) return { kind: 'item', depth, marker: 'number', number: m[1], text: m[2] ?? '', raw }
  return { kind: 'paragraph', text: raw, raw }
}

const INLINE = /(\*\*[^*]+\*\*|__[^_]+__|\*[^*\s][^*]*\*|_[^_\s][^_]*_|`[^`]+`|\[[^\]]+\]\([^)\s]+\))/g

/** Bold, italic, code and link text; link targets are not followed while streaming. */
function inline(text: string): ReactNode[] {
  const out: ReactNode[] = []
  let at = 0
  let key = 0
  for (const m of text.matchAll(INLINE)) {
    if (m.index > at) out.push(text.slice(at, m.index))
    const t = m[0]
    if (t.startsWith('**') || t.startsWith('__')) out.push(<strong key={key++}>{t.slice(2, -2)}</strong>)
    else if (t.startsWith('`')) out.push(<code key={key++}>{t.slice(1, -1)}</code>)
    else if (t.startsWith('[')) out.push(<span key={key++} className="enh-stream__link">{t.slice(1, t.indexOf(']'))}</span>)
    else out.push(<em key={key++}>{t.slice(1, -1)}</em>)
    at = m.index + t.length
  }
  if (at < text.length) out.push(text.slice(at))
  return out
}

function StreamingNotesImpl({ text, lines }: { text: string; lines: GeneratedLine[] | null }): JSX.Element {
  const complete = text.slice(0, text.lastIndexOf('\n') + 1)
  const userLines = new Set((lines ?? []).filter((l) => l.matches && l.matches.length > 0).map((l) => l.text))
  const tagged = lines !== null
  const blocks = complete
    .split('\n')
    .map(parseLine)
    .filter((b): b is Block => b !== null)

  return (
    <div className="enh-stream" aria-live="polite">
      {blocks.map((b, i) => {
        const ai = tagged && !userLines.has(b.raw)
        const cls = ai ? ' enh-line--ai' : ''
        if (b.kind === 'heading') {
          const H = `h${b.level}` as 'h1' | 'h2' | 'h3'
          return (
            <H key={i} className={`enh-stream__heading${cls}`}>
              {inline(b.text)}
            </H>
          )
        }
        if (b.kind === 'item') {
          return (
            <div
              key={i}
              className={`enh-stream__item enh-stream__item--${b.marker}${cls}`}
              style={{ ['--depth' as string]: b.depth }}
              data-number={b.number}
            >
              {b.marker === 'task' ? <span className={`enh-stream__box${b.checked ? ' is-checked' : ''}`} aria-hidden="true" /> : null}
              <span>{inline(b.text)}</span>
            </div>
          )
        }
        return (
          <p key={i} className={`enh-stream__para${cls}`}>
            {inline(b.text)}
          </p>
        )
      })}
    </div>
  )
}

export const StreamingNotes = memo(StreamingNotesImpl)
