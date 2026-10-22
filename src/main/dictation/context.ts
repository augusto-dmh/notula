// SPDX-License-Identifier: Apache-2.0
// Screen context and keyterms for dictation.
//
// - Keyterms: the user's dictionary first, then screen terms; deduplicated without case;
//   terms over 50 characters skipped; at most 100 (40 from the screen).
// - Screen terms are weighted by source (selection 4, caret text 3, field label 3, window
//   title 2, nearby text 1); pattern matches (emails, @handles, ticket ids, paths, file
//   names, camelCase and snake_case identifiers) count double; mid-sentence capitalised
//   phrases of 3–50 characters count too, except UI and common words, weekdays and months.
//   The app's own name is excluded.
// - The context block stays under 2,400 characters. It is untrusted text: the formatter
//   uses it only as a spelling reference.

import { DICTATION_LIMITS as L } from '@shared/types/dictation'
import type { DeskContext } from './desk'
import type { Target } from './targets'

const STOP = new Set(
  (
    'the a an and or but if then this that these those it its is are was were be been i you he she we they me my your our their ' +
    'file edit view help window tools format insert share send save open close new search settings home back next cancel ok yes no ' +
    'reply forward delete archive inbox draft sent subject to cc bcc from untitled document page tab type message chat ' +
    'monday tuesday wednesday thursday friday saturday sunday january february march april may june july august september october november december ' +
    'today tomorrow yesterday hi hello thanks thank regards best dear'
  ).split(' ')
)

const PATTERNS: RegExp[] = [
  /[\w.+-]+@[\w-]+\.[\w.-]+/g, // emails
  /(?<![\w@])@[A-Za-z0-9_.-]{2,}/g, // @handles
  /\b[A-Z][A-Z0-9]{1,9}-\d{1,6}\b/g, // ticket ids
  /(?:[A-Za-z]:\\|~?\/)[\w./\\-]{2,}/g, // paths
  /\b[\w-]+\.(?:ts|tsx|js|jsx|py|rb|go|rs|java|kt|swift|md|json|yaml|yml|toml|csv|xlsx|docx|pdf|png|jpg|sql|html|css|sh|ps1)\b/g, // file names
  /\b[a-z]+(?:[A-Z][a-z0-9]+)+\b/g, // camelCase
  /\b[a-z0-9]+(?:_[a-z0-9]+)+\b/g // snake_case
]

function capitalisedPhrases(text: string): string[] {
  const out: string[] = []
  for (const sentence of text.split(/(?<=[.!?\n])\s+/)) {
    const words = sentence.split(/\s+/).filter(Boolean)
    let run: string[] = []
    const flush = (): void => {
      const phrase = run.join(' ').replace(/[^\p{L}\p{N}' -]+$/u, '')
      if (phrase.length >= 3 && phrase.length <= 50 && !run.every((w) => STOP.has(w.toLowerCase()))) out.push(phrase)
      run = []
    }
    words.forEach((w, i) => {
      const clean = w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
      if (i > 0 && /^\p{Lu}[\p{L}\p{N}'-]*$/u.test(clean) && !STOP.has(clean.toLowerCase())) run.push(clean)
      else flush()
    })
    flush()
  }
  return out
}

function screenTerms(ctx: DeskContext | null, target: Target): string[] {
  if (!ctx || ctx.result !== 'captured') return []
  const caret = `${ctx.before.slice(-300)} ${ctx.after.slice(0, 300)}`
  const nearby = `${ctx.before.slice(0, -300)} ${ctx.after.slice(300)}`
  const sources: [string, number][] = [
    [ctx.selection, 4],
    [caret, 3],
    [ctx.field?.name ?? '', 3],
    [ctx.title, 2],
    [nearby, 1]
  ]
  const score = new Map<string, { term: string; w: number }>()
  const add = (term: string, w: number): void => {
    const t = term.trim()
    if (t.length < 2 || t.length > L.keytermMaxChars) return
    const k = t.toLowerCase()
    if (k === target.app.toLowerCase()) return
    const prev = score.get(k)
    score.set(k, { term: prev?.term ?? t, w: (prev?.w ?? 0) + w })
  }
  for (const [text, w] of sources) {
    if (!text) continue
    for (const re of PATTERNS) for (const m of text.matchAll(re)) add(m[0], w * 2)
    for (const p of capitalisedPhrases(text)) add(p, w)
  }
  return [...score.values()]
    .sort((a, b) => b.w - a.w)
    .slice(0, L.screenKeytermsMax)
    .map((x) => x.term)
}

export function buildKeyterms(dictionary: readonly string[], ctx: DeskContext | null, target: Target): { keyterms: string[]; screen: string[] } {
  const screen = screenTerms(ctx, target)
  const seen = new Set<string>()
  const keyterms: string[] = []
  for (const t of [...dictionary, ...screen]) {
    const term = t.trim()
    if (!term || term.length > L.keytermMaxChars || seen.has(term.toLowerCase())) continue
    seen.add(term.toLowerCase())
    keyterms.push(term)
    if (keyterms.length >= L.keytermsMax) break
  }
  return { keyterms, screen }
}

const line = (label: string, v: string | null | undefined): string | null => (v ? `${label}: ${v.replace(/\s+/g, ' ').slice(0, 240)}` : null)

/** The context block under the 2,400-character budget, or '' when there is nothing. */
export function buildContextBlock(ctx: DeskContext | null, target: Target, screen: string[]): string {
  if (!ctx || ctx.result !== 'captured') return ''
  const parts: string[] = []
  let left = L.contextChars
  const take = (s: string | null): void => {
    if (!s || left <= 0) return
    const piece = s.slice(0, left)
    parts.push(piece)
    left -= piece.length + 1
  }
  take(line('App', target.app))
  take(line('Window', ctx.title))
  take(line('Site', target.site))
  take(line('Field', ctx.field?.name))
  if (ctx.selection) take(`Selected text: ${ctx.selection.slice(0, 2_000)}`)
  if (ctx.before) take(`Text before the cursor: ${ctx.before.slice(-Math.min(800, Math.max(0, left - 40)))}`)
  if (ctx.after) take(`Text after the cursor: ${ctx.after.slice(0, Math.min(400, Math.max(0, left - 40)))}`)
  if (screen.length) take(`Visible entities: ${screen.join(', ').slice(0, 320)}`)
  return parts.join('\n')
}
