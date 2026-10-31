// SPDX-License-Identifier: Apache-2.0
// Screen context and keyterms for dictation.
//
// - Keyterms, in order: the user's name when Notula knows it; up to 30 dictionary terms, starred
//   first, then by (uses + 1) × 0.5^(days since last use or creation / 14); up to 10 people
//   from recent meetings; then screen terms (at most 40). Duplicates go ignoring case after
//   NFC; each term is 1–50 characters and at most 6 words; at most 100 in all.
// - After a dictation, every dictionary term found in the final text as a whole word, in any
//   case, gets one more use (`termsUsedIn`).
// - Screen terms are weighted by source (selection 4, caret text 3, field label 3, window
//   title 2, nearby text 1); pattern matches (emails, @handles, ticket ids, paths, file
//   names, camelCase and snake_case identifiers) count double; mid-sentence capitalised
//   phrases of 3–50 characters count too, except UI and common words, weekdays and months.
//   The app's own name is excluded.
// - The context block stays under 1,500 characters, the text nearest the caret first. It is
//   untrusted text: the formatter uses it only as a spelling reference.

import { DICTATION_LIMITS as L, DICTATION_TERM_LIMITS, type DictationTerm } from '@shared/types/dictation'
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

const DAY_MS = 86_400_000

/** Live terms, starred first, then by recent use: (uses + 1) × 0.5^(days / 14). */
export function rankTerms(terms: readonly DictationTerm[], now = Date.now()): DictationTerm[] {
  const score = (t: DictationTerm): number => {
    const since = Date.parse(t.last_used_at ?? t.created_at)
    const days = Number.isFinite(since) ? Math.max(0, (now - since) / DAY_MS) : 0
    return (t.use_count + 1) * 0.5 ** (days / L.usageHalfLifeDays)
  }
  return terms
    .filter((t) => t.deleted_at === null)
    .map((t) => ({ t, s: score(t) }))
    .sort((a, b) => Number(b.t.starred) - Number(a.t.starred) || b.s - a.s)
    .map((x) => x.t)
}

export interface KeytermSources {
  userName: string | null
  terms: readonly DictationTerm[]
  /** Names from the local attendees of recent meetings, most recent first. */
  people: readonly string[]
}

const fits = (t: string): boolean => t.length >= 1 && t.length <= DICTATION_TERM_LIMITS.maxChars && t.split(/\s+/).length <= DICTATION_TERM_LIMITS.maxWords

export function buildKeyterms(src: KeytermSources, ctx: DeskContext | null, target: Target): { keyterms: string[]; screen: string[] } {
  const screen = screenTerms(ctx, target)
  const seen = new Set<string>()
  const keyterms: string[] = []
  const take = (list: readonly string[], max: number): void => {
    let n = 0
    for (const raw of list) {
      if (n >= max || keyterms.length >= L.keytermsMax) return
      const term = raw.normalize('NFC').trim().replace(/\s+/g, ' ')
      const key = term.toLowerCase()
      if (!fits(term) || seen.has(key)) continue
      seen.add(key)
      keyterms.push(term)
      n++
    }
  }
  take(src.userName ? [src.userName] : [], 1)
  take(
    rankTerms(src.terms).map((t) => t.term),
    L.keytermsDictionary
  )
  take(src.people, L.keytermsPeople)
  take(screen, L.screenKeytermsMax)
  return { keyterms, screen }
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The live terms found in the text as whole words, in any case. */
export function termsUsedIn(text: string, terms: readonly DictationTerm[]): string[] {
  const t = text.normalize('NFC')
  return terms
    .filter((x) => x.deleted_at === null && new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRe(x.term)}(?![\\p{L}\\p{N}_])`, 'iu').test(t))
    .map((x) => x.id)
}

const line = (label: string, v: string | null | undefined): string | null => (v ? `${label}: ${v.replace(/\s+/g, ' ').slice(0, 120)}` : null)

/** Room for a line's label ("Text before the cursor: "). */
const LABEL_CHARS = 30

/** Runs of spaces as one, blank lines dropped: a long thread's layout costs the model time and says nothing. */
const squeeze = (s: string): string => s.replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n')

/**
 * The context block under the 1,500-character budget, or '' when there is nothing. The text
 * nearest the caret goes first: a long page (a mail thread) would otherwise push the model
 * past its budget.
 */
export function buildContextBlock(ctx: DeskContext | null, target: Target, screen: string[]): string {
  if (!ctx || ctx.result !== 'captured') return ''
  const head = [line('App', target.app), line('Window', ctx.title), line('Site', target.site), line('Field', ctx.field?.name)].filter(
    (x): x is string => !!x
  )
  let left = L.contextChars - head.reduce((n, h) => n + h.length + 1, 0)
  const selection = ctx.selection ? squeeze(ctx.selection).slice(0, Math.max(0, Math.min(400, Math.floor(left / 3)))) : ''
  left -= selection ? selection.length + LABEL_CHARS : 0
  const beforeAll = squeeze(ctx.before)
  const afterAll = squeeze(ctx.after)
  // Two thirds before the caret, the rest after; either side gives what it doesn't use to the other.
  const room = Math.max(0, left - (beforeAll ? LABEL_CHARS : 0) - (afterAll ? LABEL_CHARS : 0))
  let afterRoom = Math.min(afterAll.length, Math.floor(room / 3))
  const beforeRoom = Math.min(beforeAll.length, room - afterRoom)
  afterRoom = Math.min(afterAll.length, room - beforeRoom)
  const before = beforeRoom > 0 ? beforeAll.slice(-beforeRoom) : ''
  const after = afterRoom > 0 ? afterAll.slice(0, afterRoom) : ''
  left -= (before ? before.length + LABEL_CHARS : 0) + (after ? after.length + LABEL_CHARS : 0)
  const entities = screen.length && left > 60 ? screen.join(', ').slice(0, Math.min(200, left - LABEL_CHARS)) : ''
  const parts = [
    ...head,
    selection ? `Selected text: ${selection}` : null,
    before ? `Text before the cursor: ${before}` : null,
    after ? `Text after the cursor: ${after}` : null,
    entities ? `Visible entities: ${entities}` : null
  ].filter((x): x is string => !!x)
  return parts.join('\n').slice(0, L.contextChars)
}
