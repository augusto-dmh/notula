// SPDX-License-Identifier: Apache-2.0
// Catalog grammar, lesson-number guesses and catalog matching. Pure: no Electron,
// no storage. `scripts/dev/catalog-parse.mjs` loads it through Node's type stripping, so it uses
// erasable TypeScript only.
//
// Grammar (pasted text or a Markdown file), one line at a time:
// - `#` / `##` headings are sections (deeper headings too); a heading names the items below it;
// - an item line is an optional list marker (`-`, `*`, `+`, `- [ ]`), an optional number
//   (`12.`, `12)`, `12 -`, `Aula 12`, `Lesson 12`, `Class 12`), the title, an optional duration
//   (`(mm:ss)`, `(h:mm:ss)`, a bare `hh:mm:ss` anywhere, or a bare `mm:ss` at the end) and an
//   optional URL anywhere (bare, `<…>`, or a Markdown link `[title](url)`);
// - blank lines are ignored; rules, fences, quotes, tables and lines without a letter or a digit
//   are skipped and counted;
// - at most 2,000 items.
// Numbers: when no item line carries one, the catalog order numbers the items 1…n. When the
// numbers repeat (numbering restarts in each section), the order numbers them too.

import { parseSourceUrl } from '@shared/lib/source-key'
import type { CanonicalKey, CatalogItem, LessonOrigin, LessonState, NoteSource, SourceDraft } from '@shared/types/sources'
import { SOURCES_LIMITS } from '@shared/types/sources'
import type { LessonNumberUpdate } from '../storage/api'
import { matchTitle } from './titles'

/** A parsed item, before it is stored (`NewCatalogItem` columns). */
export interface ParsedCatalogItem {
  number: number | null
  section: string | null
  title: string
  url: string | null
  canonical_key: CanonicalKey | null
  duration_ms: number | null
}

export interface ParsedCatalog {
  items: ParsedCatalogItem[]
  /** Sections with at least one item. */
  sections: number
  skippedLines: number
  /** The order numbered the items (no numbers, or repeated numbers). */
  renumbered: boolean
  /** More than the limit: nothing is imported. */
  overLimit: boolean
}

const MAX_TITLE = 1_000
const MAX_SECTION = 300
const MAX_LINE = 4_000
/** Lesson numbers a catalog or a title may carry. */
const MAX_NUMBER = 100_000

const LESSON_WORD = '(?:aula|lesson|lição|licao|class|clase|lecture|aula\\s+n[º°o.]?)'
const URL_RE = /<?(https?:\/\/[^\s<>"]+)>?/i
const MD_LINK = /\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/i
const PAREN_DURATION = /[([]\s*(\d{1,3}):([0-5]\d)(?::([0-5]\d))?\s*(?:min)?\s*[)\]]/
const BARE_HMS = /(?:^|\s)(\d{1,2}):([0-5]\d):([0-5]\d)(?=\s|$)/
const TRAILING_MS = /(?:^|\s)(\d{1,3}):([0-5]\d)\s*$/
const LIST_MARKER = /^(?:[-*+•]\s+(?:\[[ xX]\]\s+)?)/
const NUM_DOT = /^(\d{1,5})\s*[.)](?:\s+|$)/
const NUM_DASH = /^(\d{1,5})\s*[-–—:|]\s*/
const NUM_WORD = new RegExp(`^${LESSON_WORD}\\s*(\\d{1,5})\\b\\s*[-–—:.|)]?\\s*`, 'iu')
const SEPARATORS = /^[\s\-–—:|·•.,]+|[\s\-–—:|·•,]+$/g

function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max).trimEnd() : s
}

function toMs(h: number, m: number, s: number): number {
  return ((h * 60 + m) * 60 + s) * 1_000
}

/** Reads one item line; null when it isn't one. */
function parseItemLine(raw: string): Omit<ParsedCatalogItem, 'section'> | null {
  let line = raw.replace(LIST_MARKER, '').trim()
  let url: string | null = null
  let linkText: string | null = null

  const md = MD_LINK.exec(line)
  if (md) {
    url = md[2] ?? null
    linkText = (md[1] ?? '').trim()
    // The link text is the title only when nothing else on the line is (`[Watch](…)` is a label).
    line = `${line.slice(0, md.index)} ${line.slice(md.index + md[0].length)}`
  } else {
    const u = URL_RE.exec(line)
    if (u) {
      url = (u[1] ?? '').replace(/[.,;:!?)\]]+$/, '')
      line = `${line.slice(0, u.index)} ${line.slice(u.index + u[0].length)}`
    }
  }
  line = line.replace(/\s+/g, ' ').trim()

  let durationMs: number | null = null
  const paren = PAREN_DURATION.exec(line)
  if (paren) {
    const a = Number(paren[1])
    const b = Number(paren[2])
    durationMs = paren[3] !== undefined ? toMs(a, b, Number(paren[3])) : toMs(0, a, b)
    line = `${line.slice(0, paren.index)} ${line.slice(paren.index + paren[0].length)}`.trim()
  } else {
    const hms = BARE_HMS.exec(line)
    if (hms) {
      durationMs = toMs(Number(hms[1]), Number(hms[2]), Number(hms[3]))
      line = `${line.slice(0, hms.index)} ${line.slice(hms.index + hms[0].length)}`.trim()
    } else {
      const ms = TRAILING_MS.exec(line)
      if (ms) {
        durationMs = toMs(0, Number(ms[1]), Number(ms[2]))
        line = line.slice(0, ms.index).trim()
      }
    }
  }

  let number: number | null = null
  const n = NUM_WORD.exec(line) ?? NUM_DOT.exec(line) ?? NUM_DASH.exec(line)
  if (n) {
    const v = Number(n[1])
    if (Number.isInteger(v) && v <= MAX_NUMBER) {
      number = v
      line = line.slice(n[0].length)
    }
  }

  let title = line.replace(SEPARATORS, '').replace(/\s+/g, ' ').trim()
  if (!title && linkText) title = linkText
  if (!title && url) title = url
  if (!title) return null
  if (!/[\p{L}\p{N}]/u.test(title) && !url) return null

  const parsed = url ? parseSourceUrl(url) : null
  return {
    number,
    title: clip(title, MAX_TITLE),
    url: parsed?.url ?? url,
    canonical_key: parsed?.canonicalKey ?? null,
    duration_ms: durationMs
  }
}

/** Parses a pasted catalog or a Markdown file. */
export function parseCatalog(text: string): ParsedCatalog {
  const items: ParsedCatalogItem[] = []
  const sectionsWithItems = new Set<string>()
  let section: string | null = null
  let skipped = 0
  let fenced = false
  let overLimit = false

  const lines = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n')
  // Front matter: a leading `---` block.
  let start = 0
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---')
    if (end > 0) {
      skipped += end + 1
      start = end + 1
    }
  }

  for (let i = start; i < lines.length; i++) {
    const line = (lines[i] ?? '').trim()
    if (!line) continue
    if (/^(```|~~~)/.test(line)) {
      fenced = !fenced
      skipped++
      continue
    }
    if (fenced || line.length > MAX_LINE) {
      skipped++
      continue
    }
    const h = /^#{1,6}\s+(.*)$/.exec(line)
    if (h) {
      const name = (h[1] ?? '').replace(/\s+#+\s*$/, '').trim()
      section = name ? clip(name, MAX_SECTION) : null
      continue
    }
    // Rules, quotes and table rows aren't lessons.
    if (/^([-*_])(\s*\1){2,}$/.test(line) || line.startsWith('>') || /^\|.*\|$/.test(line)) {
      skipped++
      continue
    }
    const item = parseItemLine(line)
    if (!item) {
      skipped++
      continue
    }
    if (items.length >= SOURCES_LIMITS.catalogItems) {
      overLimit = true
      break
    }
    items.push({ ...item, section })
    if (section) sectionsWithItems.add(section)
  }

  // Numbers: the order numbers a catalog without them, or one whose numbers repeat.
  const numbered = items.filter((it) => it.number !== null)
  const unique = new Set(numbered.map((it) => it.number)).size === numbered.length
  let renumbered = false
  if (items.length > 0 && (numbered.length === 0 || !unique)) {
    items.forEach((it, i) => (it.number = i + 1))
    renumbered = true
  }

  return { items, sections: sectionsWithItems.size, skippedLines: skipped, renumbered, overLimit }
}

// ---------- title patterns ----------

const GUESS_WORD = new RegExp(`(?:^|[^\\p{L}])${LESSON_WORD}\\s*(\\d{1,5})(?!\\d|:\\d)`, 'iu')
const GUESS_LEAD_DOT = /^\s*(\d{1,5})\.\s+\S/
const GUESS_HASH = /(?:^|\s)#(\d{1,5})\b/

/** `Aula <n>`, `Lesson <n>`, `Class <n>`, a leading `<n>.`, `#<n>`: a guessed lesson number. */
export function guessLessonNumber(title: string): number | null {
  const m = GUESS_WORD.exec(title) ?? GUESS_LEAD_DOT.exec(title) ?? GUESS_HASH.exec(title)
  if (!m) return null
  const n = Number(m[1])
  return Number.isInteger(n) && n > 0 && n <= MAX_NUMBER ? n : null
}

// ---------- matching ----------

/** A title shorter than this (normalized) only matches exactly, never as a suffix. */
const MIN_SUFFIX_MATCH = 12

type Matchable = Pick<CatalogItem, 'number' | 'section' | 'title' | 'url' | 'canonical_key'>

/**
 * The catalog item of a source: by canonical key, then by URL, then by normalized title (equal,
 * else the one item whose title ends the source's title, e.g. `[Course] … - Aula 28 - <item>`).
 * Ambiguous title matches give null.
 */
export function matchCatalogItem<T extends Matchable>(
  items: readonly T[],
  source: { canonicalKey: CanonicalKey | null; url: string | null; title: string }
): T | null {
  const key = source.canonicalKey && !source.canonicalKey.startsWith('title:') ? source.canonicalKey : null
  if (key) {
    const byKey = items.find((it) => it.canonical_key === key)
    if (byKey) return byKey
  }
  if (source.url) {
    const byUrl = items.find((it) => it.url === source.url)
    if (byUrl) return byUrl
  }
  const t = matchTitle(source.title)
  if (!t) return null
  const equal = items.filter((it) => matchTitle(it.title) === t)
  if (equal.length === 1) return equal[0] as T
  if (equal.length > 1) return null
  let best: T | null = null
  let bestLen = 0
  let tie = false
  for (const it of items) {
    const itemTitle = matchTitle(it.title)
    if (itemTitle.length < MIN_SUFFIX_MATCH) continue
    if (t.endsWith(` ${itemTitle}`) || (t.length >= MIN_SUFFIX_MATCH && itemTitle.endsWith(` ${t}`))) {
      const len = Math.min(itemTitle.length, t.length)
      if (len > bestLen) {
        best = it
        bestLen = len
        tie = false
      } else if (len === bestLen) tie = true
    }
  }
  return tie ? null : best
}

/**
 * A new note's lesson (`resolveLesson`): a catalog match wins over the draft's own number. Without
 * one, a number the playlist or the extension gave stands (null = keep the draft's), and so does
 * the draft's own guess; otherwise the title patterns guess, else `pending`.
 */
export function draftLesson(
  items: readonly Matchable[],
  draft: Pick<SourceDraft, 'canonicalKey' | 'url' | 'title' | 'lesson'>
): { number: number | null; label: string | null; state: LessonState; origin: LessonOrigin | null } | null {
  const l = lessonFor(items, draft)
  if (l.fromCatalog) return { number: l.number, label: l.label, state: 'numbered', origin: 'catalog' }
  if (draft.lesson?.state === 'numbered' && draft.lesson.number !== null) return null
  if (l.state === 'pending' && draft.lesson?.state === 'guessed') return null
  return { number: l.number, label: l.label ?? draft.lesson?.label ?? null, state: l.state, origin: null }
}

/**
 * The lessons an imported catalog renumbers: `pending`, `guessed`, and numbers an earlier catalog
 * gave. Manual, playlist and extension numbers are left alone (storage refuses manual ones too).
 */
export function renumberRows(
  sources: readonly Pick<NoteSource, 'note_id' | 'canonical_key' | 'url' | 'title' | 'lesson_number' | 'lesson_label' | 'lesson_state' | 'lesson_origin'>[],
  items: readonly Matchable[]
): { unsettled: LessonNumberUpdate[]; fromCatalog: LessonNumberUpdate[] } {
  const unsettled: LessonNumberUpdate[] = []
  const fromCatalog: LessonNumberUpdate[] = []
  for (const s of sources) {
    if (s.lesson_origin === 'manual') continue
    const isUnsettled = s.lesson_state === 'pending' || s.lesson_state === 'guessed'
    const wasCatalog = s.lesson_state === 'numbered' && s.lesson_origin === 'catalog'
    if (!isUnsettled && !wasCatalog) continue
    const l = lessonFor(items, { canonicalKey: s.canonical_key, url: s.url, title: s.title })
    if (!l.fromCatalog) continue
    if (wasCatalog && s.lesson_number === l.number && s.lesson_label === l.label) continue
    const row: LessonNumberUpdate = { noteId: s.note_id, lesson_number: l.number, lesson_label: l.label, lesson_state: 'numbered', lesson_origin: 'catalog' }
    if (isUnsettled) unsettled.push(row)
    else fromCatalog.push(row)
  }
  return { unsettled, fromCatalog }
}

/** The lesson a catalog gives a source, or a guess from its title, else pending. */
export function lessonFor(
  items: readonly Matchable[],
  source: Pick<SourceDraft, 'canonicalKey' | 'url' | 'title'>
): { number: number | null; label: string | null; state: LessonState; fromCatalog: boolean } {
  const item = items.length ? matchCatalogItem(items, { canonicalKey: source.canonicalKey, url: source.url, title: source.title }) : null
  if (item && item.number !== null) return { number: item.number, label: item.section, state: 'numbered', fromCatalog: true }
  const guess = guessLessonNumber(source.title)
  if (guess !== null) return { number: guess, label: item?.section ?? null, state: 'guessed', fromCatalog: false }
  return { number: null, label: item?.section ?? null, state: 'pending', fromCatalog: false }
}
