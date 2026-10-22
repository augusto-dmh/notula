// SPDX-License-Identifier: Apache-2.0
// One item → what its note gets. Pure: the files come in as text with their
// times, and nothing here touches the disk, storage or Electron.
//
// - plain / obsidian: front-matter, title (front-matter, a first-line H1, the file name), body
//   rewritten for the notes schema, an optional paired transcript.
// - study-lesson: `Transcription.md` (title, date, transcript or placeholder links),
//   `Summary.md` (a `Summary` panel unless empty or `No Content`), `Hyperlinks.md` (the body and
//   the labelled candidates).
// - notula-export: the export's front-matter, `## My notes` as the body and each recognised
//   panel section as a panel, headings moved back up; the transcript file it names. Format 2
//   (`notula_export_version: 2`) is split exactly by its `notula_sections` lines, and its source
//   (the standard export's `source:` block, or the Markdown export's flat `source_url`, `series`
//   and `lesson`) becomes the item's `source` candidate and series and lesson hints.
// - transcript-copy: a transcript with an empty body.

import type { DocumentTag, NotePerson } from '@shared/types/notes'
import { IMPORT_LIMITS, type CandidateLink, type ImportDateOrigin, type ImportFormat, type ImportTitleOrigin } from '@shared/types/imports-markdown'
import { dateFromFileName, parseDateText } from './dates'
import { fmGet, fmString, fmStrings, splitFrontMatter, type FrontMatter, type YamlValue } from './frontmatter'
import { classifyLink, finishCandidates, noteShareApp, urlsIn } from './links'
import { atxHeading, LINE_MAX, plainText, rewriteMarkdown, unshiftHeadings } from './rewrite'
import { parseTranscript, type ParsedTranscript } from './transcript'

/** A file as read by the scan: decoded text and its times. */
export interface SourceFile {
  rel: string
  name: string
  text: string
  size: number
  mtimeMs: number
  /** 0 when the OS doesn't record it. */
  birthtimeMs: number
  /** Invalid UTF-8 was replaced. */
  lossy: boolean
}

export interface ParseContext {
  dayFirst: boolean
  /** Lower-cased template titles known to this Notula, plus `summary`. */
  panelTitles: Set<string>
  /** A Notula export's `index.csv`: note id → `has_summary`. Null when absent. */
  exportSummaries: Map<string, boolean> | null
}

export interface ParsedItem {
  format: ImportFormat
  title: string
  titleOrigin: ImportTitleOrigin
  createdAt: Date
  dateOrigin: ImportDateOrigin
  updatedAt: Date
  notesMd: string
  panels: { title: string; markdown: string }[]
  transcript: ParsedTranscript | null
  candidates: CandidateLink[]
  attendees: NotePerson[]
  tags: DocumentTag[]
  exportId: string | null
  /** A Notula export's Trash entry. */
  trashed: boolean
  /** Export folder names (top-level folders by name). */
  exportFolders: string[]
  warnings: string[]
  hints: { series: string | null; lessonFromTitle: number | null; lessonFromFolder: number | null }
  /** Stored on the item: original title, dates found, unmapped properties, tags, links… */
  meta: Record<string, unknown>
}

const FM_DATE_KEYS = ['date', 'created', 'created_at', 'creation date', 'meeting_date']
const FM_UPDATED_KEYS = ['updated', 'modified', 'updated_at']
const FM_SOURCE_KEYS = ['source', 'source_url', 'url', 'link', 'video', 'youtube']
const FM_SERIES_KEYS = ['course', 'series', 'playlist']
const FM_PEOPLE_KEYS = ['attendees', 'participants', 'people']
const FM_KNOWN = new Set([
  'title',
  'aliases',
  'alias',
  ...FM_DATE_KEYS,
  ...FM_UPDATED_KEYS,
  'tags',
  'tag',
  ...FM_SOURCE_KEYS,
  ...FM_SERIES_KEYS,
  ...FM_PEOPLE_KEYS
])
const TITLE_LESSON = /\b(?:aula|lesson|class|lecture|episódio|episodio|episode|ep\.?|parte|part)\s*#?\s*(\d{1,4})\b/i
const LABEL_LINE = /^(?:[-*]\s+)?([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ ]{0,28}?)\s*(?::|\s[-–]\s)\s*<?(https?:\/\/\S+?)>?\s*$/
const HYPERLINK_LINE = /^([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ ]{0,28}?)\s+[-–]\s+<?(https?:\/\/\S+?)>?\s*$/

// ---------- helpers ----------

function fileTime(files: SourceFile[]): Date {
  let best = Number.POSITIVE_INFINITY
  for (const f of files) {
    const t = f.birthtimeMs > 0 ? f.birthtimeMs : f.mtimeMs
    if (t > 0 && t < best) best = t
  }
  return new Date(Number.isFinite(best) ? best : Date.now())
}

function latestMtime(files: SourceFile[]): number {
  return Math.max(0, ...files.map((f) => f.mtimeMs)) || Date.now()
}

function humanize(slug: string): string {
  const s = slug.replace(/^\d+-/, '').replace(/[-_]+/g, ' ').trim()
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : slug
}

function stripExt(name: string): string {
  return name.replace(/\.(md|markdown|txt)$/i, '')
}

/** At most 300 code points; the rest moves to the body's first line. */
function capTitle(title: string): { title: string; rest: string | null } {
  const chars = Array.from(title.replace(/\s+/g, ' ').trim())
  if (chars.length <= IMPORT_LIMITS.titleCodePoints) return { title: chars.join(''), rest: null }
  return { title: chars.slice(0, IMPORT_LIMITS.titleCodePoints).join('').trim(), rest: chars.slice(IMPORT_LIMITS.titleCodePoints).join('').trim() }
}

/** `local@domain.tld`, checked by hand (the one-pattern form backtracks on a long domain). */
function isEmail(s: string): boolean {
  if (!/^[^@\s]+@[^@\s]+$/.test(s)) return false
  const domain = s.slice(s.indexOf('@') + 1)
  const dot = domain.indexOf('.', 1)
  return dot >= 1 && dot <= domain.length - 2
}

function person(raw: YamlValue): NotePerson | null {
  if (typeof raw === 'string') {
    const t = raw.trim()
    // `Name <email>`: the email holds no `<`, so it follows the last one.
    const lt = t.endsWith('>') ? t.lastIndexOf('<') : -1
    const email = lt >= 0 ? t.slice(lt + 1, -1) : ''
    if (lt >= 0 && /^[^<>@\s]+@[^<>\s]+$/.test(email)) {
      const name = t.slice(0, lt).trim()
      return name ? { name, email: email.trim() } : { email: email.trim() }
    }
    if (isEmail(t)) return { email: t }
    return t ? { name: t } : null
  }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const name = typeof raw['name'] === 'string' ? raw['name'].trim() : ''
    const email = typeof raw['email'] === 'string' ? raw['email'].trim() : ''
    if (!name && !email) return null
    return { ...(name ? { name } : {}), ...(email ? { email } : {}) }
  }
  return null
}

function people(v: YamlValue | undefined): NotePerson[] {
  if (v === undefined || v === null) return []
  const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,;]/) : []
  const out: NotePerson[] = []
  for (const x of list.slice(0, 500)) {
    const p = person(x)
    if (p) out.push(p)
  }
  return out
}

function lessonFromTitle(title: string): number | null {
  const m = TITLE_LESSON.exec(title)
  return m ? Number(m[1]) : null
}

/** Candidate links of a run of Markdown: labelled lines first, then every other URL. */
function bodyCandidates(markdown: string, mode: 'body' | 'hyperlinks'): CandidateLink[] {
  const out: CandidateLink[] = []
  for (const line of markdown.split(/\r?\n/)) {
    if (line.length > LINE_MAX) continue
    const m = (mode === 'hyperlinks' ? HYPERLINK_LINE : LABEL_LINE).exec(line.trim())
    if (!m) continue
    if (mode === 'hyperlinks' && /^\s/.test(line)) continue
    const c = classifyLink(m[2]!, m[1]!.trim(), true)
    if (c) out.push(c)
  }
  for (const { url } of urlsIn(markdown)) {
    const c = classifyLink(url, null, false)
    if (c) out.push(c)
  }
  return out
}

function frontMatterCandidates(fm: FrontMatter | null): CandidateLink[] {
  const out: CandidateLink[] = []
  for (const key of FM_SOURCE_KEYS) {
    for (const url of fmStrings(fmGet(fm, key))) {
      if (!/^https?:\/\//i.test(url)) continue
      const c = classifyLink(url, key, true)
      if (c) out.push(c.role === 'reference' ? { ...c, role: 'source' } : c)
    }
  }
  return out
}

function dateOf(text: string | null, ctx: ParseContext, refMs: number): Date | null {
  return text ? parseDateText(text, { refMs, dayFirst: ctx.dayFirst }) : null
}

/** A `Date:` line within the first 10 lines. */
function dateLine(text: string): string | null {
  const lines = text.split(/\r?\n/).slice(0, 10)
  for (const l of lines) {
    const m = /^Date:\s*(.+)$/.exec(l.trim())
    if (m) return m[1]!.trim()
  }
  return null
}

function emptyHints(): ParsedItem['hints'] {
  return { series: null, lessonFromTitle: null, lessonFromFolder: null }
}

// ---------- plain and Obsidian ----------

export function parseMarkdownNote(file: SourceFile, pair: SourceFile | null, ctx: ParseContext, format: 'plain' | 'obsidian'): ParsedItem {
  const warnings: string[] = []
  const meta: Record<string, unknown> = {}
  const split = splitFrontMatter(file.text.replace(/^﻿/, ''))
  const fm = split.fm
  if (split.tooLarge) warnings.push('Properties over 64 KB weren’t read')
  if (fm?.unread.length) {
    warnings.push('Some properties weren’t read')
    meta['unreadProperties'] = fm.unread
    meta['rawProperties'] = fm.raw.slice(0, 16_384)
  }
  const refMs = latestMtime([file])

  // Title.
  let body = split.body
  let title: string | null = fmString(fmGet(fm, 'title'))
  let titleOrigin: ImportTitleOrigin = 'front-matter'
  if (!title) {
    const lines = body.split(/\r?\n/)
    const first = lines.findIndex((l) => l.trim() !== '')
    const head = first >= 0 && lines[first]!.startsWith('#') ? atxHeading(lines[first]!) : null
    const h1 = head && head.level === 1 && head.text ? head : null
    if (h1) {
      title = h1.text.trim()
      titleOrigin = 'heading'
      lines.splice(first, 1)
      body = lines.join('\n')
    }
  }
  if (!title) {
    title = stripExt(file.name)
    titleOrigin = 'file-name'
  }
  const aliases = fmStrings(fmGet(fm, 'aliases', 'alias'))
  if (aliases.length) meta['aliases'] = aliases

  // Date.
  let createdAt: Date | null = null
  let dateOrigin: ImportDateOrigin = 'front-matter'
  for (const k of FM_DATE_KEYS) {
    createdAt = dateOf(fmString(fmGet(fm, k)), ctx, refMs)
    if (createdAt) break
  }
  if (!createdAt) {
    createdAt = dateOf(dateLine(body), ctx, refMs)
    dateOrigin = 'date-line'
  }
  if (!createdAt) {
    createdAt = dateFromFileName(file.name)
    dateOrigin = 'file-name'
  }
  if (!createdAt) {
    createdAt = fileTime([file])
    dateOrigin = 'file-time'
  }
  let updatedAt: Date | null = null
  for (const k of FM_UPDATED_KEYS) {
    updatedAt = dateOf(fmString(fmGet(fm, k)), ctx, refMs)
    if (updatedAt) break
  }

  // Body.
  const rw = rewriteMarkdown(body, { obsidian: format === 'obsidian' })
  let notesMd = rw.markdown
  const fmTags = fmStrings(fmGet(fm, 'tags', 'tag')).map((t) => t.replace(/^#/, ''))
  const allTags = [...new Set([...fmTags, ...rw.tags])]
  const fmOnly = fmTags.filter((t) => !rw.tags.includes(t))
  if (fmOnly.length) notesMd = `${notesMd}${notesMd ? '\n\n' : ''}Tags: ${fmOnly.map((t) => `#${t}`).join(' ')}`
  if (allTags.length) meta['tags'] = allTags
  if (rw.wikilinks.length) meta['wikilinks'] = rw.wikilinks
  if (rw.embeddedNotes.length) meta['embeddedNotes'] = rw.embeddedNotes
  if (rw.attachments.length) {
    meta['attachments'] = rw.attachments
    warnings.push('Attachments aren’t imported yet')
  }

  // Properties not mapped.
  if (fm) {
    const unmapped = Object.keys(fm.data).filter((k) => !FM_KNOWN.has(k.trim().toLowerCase()))
    if (unmapped.length) {
      warnings.push(`Not imported: ${unmapped.slice(0, 10).join(', ')}${unmapped.length > 10 ? '…' : ''}`)
      const props: Record<string, YamlValue> = {}
      for (const k of unmapped) props[k] = fm.data[k]!
      meta['properties'] = props
    }
  }

  // Transcript pair.
  let transcript: ParsedTranscript | null = null
  if (pair) {
    transcript = parseTranscript(pair.text)
    if (transcript.kind === 'placeholder') transcript = null
  }

  const capped = capTitle(title)
  if (capped.rest) notesMd = `${capped.rest}\n\n${notesMd}`
  const series = fmString(fmGet(fm, ...FM_SERIES_KEYS))
  const candidates = finishCandidates([...frontMatterCandidates(fm), ...bodyCandidates(split.body, 'body')])
  meta['title'] = capped.title
  return {
    format,
    title: capped.title,
    titleOrigin,
    createdAt,
    dateOrigin,
    updatedAt: updatedAt ?? new Date(Math.max(file.mtimeMs, pair?.mtimeMs ?? 0) || createdAt.getTime()),
    notesMd,
    panels: [],
    transcript,
    candidates,
    attendees: people(fmGet(fm, ...FM_PEOPLE_KEYS)),
    tags: [],
    exportId: null,
    trashed: false,
    exportFolders: [],
    warnings: file.lossy || pair?.lossy ? [...warnings, 'Some characters couldn’t be read'] : warnings,
    hints: { series, lessonFromTitle: lessonFromTitle(capped.title), lessonFromFolder: null },
    meta
  }
}

// ---------- an exporting app's title prefix ----------

/** The notes app a share link belongs to (`notes.<app>.<tld>`), else null. */
function appOfUrl(url: string): string | null {
  try {
    return noteShareApp(new URL(url).hostname)
  } catch {
    return null
  }
}

/** Every notes app whose share links appear in a text. */
function noteAppsIn(text: string): Set<string> {
  const apps = new Set<string>()
  for (const { url } of urlsIn(text)) {
    const app = appOfUrl(url)
    if (app) apps.add(app)
  }
  return apps
}

/**
 * Drops a leading `<App> - ` an export put before the real title: when the rest starts with a
 * `[tag]` (the study vault's `[Curso]`, `[Vídeo]`), or when the item links to that app's share pages.
 */
function stripAppPrefix(title: string, apps: ReadonlySet<string>): string {
  const m = /^(\p{L}[\p{L}\d]{0,29}) - /u.exec(title)
  if (!m) return title
  const rest = title.slice(m[0].length)
  return rest.startsWith('[') || apps.has(m[1]!.toLowerCase()) ? rest : title
}

// ---------- transcript copy ----------

export function parseTranscriptItem(file: SourceFile, ctx: ParseContext): ParsedItem {
  const t = parseTranscript(file.text)
  const refMs = latestMtime([file])
  let createdAt = dateOf(t.date, ctx, refMs)
  let dateOrigin: ImportDateOrigin = 'date-line'
  if (!createdAt) {
    createdAt = dateFromFileName(file.name)
    dateOrigin = 'file-name'
  }
  if (!createdAt) {
    createdAt = fileTime([file])
    dateOrigin = 'file-time'
  }
  const capped = capTitle((t.title ? stripAppPrefix(t.title, noteAppsIn(file.text)) : '') || stripExt(file.name))
  const candidates = t.kind === 'placeholder' ? finishCandidates(bodyCandidates(t.body, 'body')) : []
  return {
    format: 'transcript-copy',
    title: capped.title,
    titleOrigin: t.title ? 'header-line' : 'file-name',
    createdAt,
    dateOrigin,
    updatedAt: new Date(file.mtimeMs || createdAt.getTime()),
    notesMd: capped.rest ?? '',
    panels: [],
    transcript: t.kind === 'placeholder' ? null : t,
    candidates,
    attendees: [],
    tags: [],
    exportId: null,
    trashed: false,
    exportFolders: [],
    warnings: file.lossy ? ['Some characters couldn’t be read'] : [],
    hints: { ...emptyHints(), lessonFromTitle: lessonFromTitle(capped.title) },
    meta: { title: capped.title, transcriptOrigin: t.origin }
  }
}

// ---------- study lesson ----------

export interface StudyFiles {
  transcription: SourceFile | null
  summary: SourceFile | null
  hyperlinks: SourceFile | null
}

/** `folder` is the lesson folder's name; `course` the course's display name; `underVideos` skips the folder number. */
export function parseStudyLesson(files: StudyFiles, folder: string, course: string | null, underVideos: boolean, ctx: ParseContext): ParsedItem {
  const all = [files.transcription, files.summary, files.hyperlinks].filter((f): f is SourceFile => f !== null)
  const refMs = latestMtime(all)
  const warnings: string[] = []
  const meta: Record<string, unknown> = {}

  // Transcription.md
  const t = files.transcription ? parseTranscript(files.transcription.text) : null
  const transcript = t && t.kind !== 'placeholder' ? t : null
  if (t?.origin) meta['transcriptOrigin'] = t.origin

  // Summary.md: an optional date line, then the panel unless empty or `No Content`.
  let summaryDate: string | null = null
  let summaryTitle: string | null = null
  const panels: ParsedItem['panels'] = []
  if (files.summary) {
    const lines = files.summary.text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n')
    const first = lines.findIndex((l) => l.trim() !== '')
    if (first >= 0) {
      const l = lines[first]!.trim()
      const isDate = /^unknown\b/i.test(l) || (parseDateText(l, { refMs, dayFirst: ctx.dayFirst }) !== null && !/^#/.test(l))
      if (isDate) {
        summaryDate = /^unknown\b/i.test(l) ? null : l
        lines.splice(first, 1)
      }
    }
    const rest = lines.join('\n').trim()
    // `No Content`, alone or followed only by italic notes (`_…_`), gives no panel.
    const meaningful = rest
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !/^_.*_$/.test(l) && !/^\*[^*].*\*$/.test(l))
    const noContent = rest === '' || (meaningful.length === 1 && meaningful[0] === 'No Content') || meaningful.length === 0
    if (!noContent) {
      let h: { level: number; text: string } | null = null
      for (const l of rest.split('\n')) {
        h = l.startsWith('#') ? atxHeading(l) : null
        if (h?.text) break
        h = null
      }
      summaryTitle = h ? h.text.trim() : null
      const rw = rewriteMarkdown(rest, { obsidian: false, panel: true })
      if (rw.markdown) panels.push({ title: 'Summary', markdown: rw.markdown })
    }
  }

  // Hyperlinks.md: the body and the labelled candidates.
  let notesMd = ''
  const candidates: CandidateLink[] = []
  if (files.hyperlinks) {
    const text = files.hyperlinks.text.replace(/^﻿/, '')
    notesMd = rewriteMarkdown(text, { obsidian: false }).markdown
    candidates.push(...bodyCandidates(text, 'hyperlinks'))
  }
  if (t?.kind === 'placeholder') candidates.push(...bodyCandidates(t.body, 'body'))

  // Title: `Meeting Title:` (without an exporting app's `<App> - ` prefix), the summary's first heading, the folder.
  const apps = new Set(candidates.flatMap((c) => (c.role === 'plain' ? [appOfUrl(c.url)] : [])).filter((a): a is string => a !== null))
  let title = (t?.title ? stripAppPrefix(t.title, apps).trim() : '') || null
  let titleOrigin: ImportTitleOrigin = 'header-line'
  if (!title && summaryTitle) {
    title = summaryTitle
    titleOrigin = 'summary-heading'
  }
  if (!title) {
    title = humanize(folder)
    titleOrigin = 'folder'
  }

  // Date: `Date:`, the summary's date line, the files' times.
  let createdAt = dateOf(t?.date ?? null, ctx, refMs)
  let dateOrigin: ImportDateOrigin = 'date-line'
  if (!createdAt) {
    createdAt = dateOf(summaryDate, ctx, refMs)
    dateOrigin = 'summary-date'
  }
  if (!createdAt) {
    createdAt = fileTime(all)
    dateOrigin = 'file-time'
  }

  const capped = capTitle(title)
  if (capped.rest) notesMd = `${capped.rest}\n\n${notesMd}`
  const folderNumber = /^(\d+)-/.exec(folder)
  meta['title'] = capped.title
  meta['lessonFolder'] = folder
  if (all.some((f) => f.lossy)) warnings.push('Some characters couldn’t be read')
  return {
    format: 'study-lesson',
    title: capped.title,
    titleOrigin,
    createdAt,
    dateOrigin,
    updatedAt: new Date(refMs),
    notesMd: notesMd.trim(),
    panels,
    transcript,
    candidates: finishCandidates(candidates),
    attendees: [],
    tags: [],
    exportId: null,
    trashed: false,
    exportFolders: [],
    warnings,
    hints: {
      series: underVideos ? null : course,
      lessonFromTitle: lessonFromTitle(capped.title),
      lessonFromFolder: !underVideos && folderNumber ? Number(folderNumber[1]) : null
    },
    meta
  }
}

// ---------- Notula export ----------

const TAG_CATEGORIES = new Set(['meeting_kind', 'is_sensitive'])
/** The newest export format this importer reads in full (`DATA_EXPORT.exportVersion`). */
const EXPORT_VERSION_READ = 2

interface ExportSectionRef {
  kind: 'notes' | 'panel'
  title: string
  /** The `## ` heading's line in the whole file, 1-based. */
  line: number
}

/** Format 2's `notula_sections`, or null when absent or malformed. */
function exportSectionRefs(v: YamlValue | undefined): ExportSectionRef[] | null {
  if (!Array.isArray(v)) return null
  const out: ExportSectionRef[] = []
  for (const s of v) {
    if (!s || typeof s !== 'object' || Array.isArray(s)) return null
    const kind = s['kind']
    const title = s['title']
    const line = s['line']
    if ((kind !== 'notes' && kind !== 'panel') || typeof title !== 'string' || typeof line !== 'number' || !Number.isInteger(line) || line < 1) return null
    if (out.length && line <= out[out.length - 1]!.line) return null
    out.push({ kind, title, line })
  }
  return out
}

/**
 * The body split by `notula_sections`: `offset` is the number of file lines before the body.
 * Null when any listed line isn't its `## <title>` heading (the file was edited): the caller
 * falls back to the title heuristic.
 */
function splitBySections(lines: string[], refs: ExportSectionRef[], offset: number): { notes: string[]; panels: { title: string; lines: string[] }[] } | null {
  const at = refs.map((r) => r.line - 1 - offset)
  for (let k = 0; k < refs.length; k++) {
    const i = at[k]!
    if (i < 0 || i >= lines.length || lines[i]!.trimEnd() !== `## ${refs[k]!.title}`.trimEnd()) return null
  }
  const notes: string[] = []
  const panels: { title: string; lines: string[] }[] = []
  for (let k = 0; k < refs.length; k++) {
    const part = lines.slice(at[k]! + 1, k + 1 < refs.length ? at[k + 1]! : lines.length)
    if (refs[k]!.kind === 'notes') notes.push(...part)
    else panels.push({ title: refs[k]!.title.trim() || 'Summary', lines: part })
  }
  return { notes, panels }
}

/** A map value of the front-matter, or null. */
function fmMap(v: YamlValue | undefined): { [k: string]: YamlValue } | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? v : null
}

/**
 * Format 2's source: the standard export's `source:` block (url, series title, lesson number),
 * else the Markdown export's flat `source_url`, `series` and `lesson`.
 */
function exportSourceOf(fm: FrontMatter | null): { candidates: CandidateLink[]; series: string | null; lesson: number | null } {
  const block = fmMap(fmGet(fm, 'source'))
  const url = fmString(block?.['url']) ?? fmString(fmGet(fm, 'source_url'))
  const series = fmString(fmMap(block?.['series'])?.['title']) ?? (block ? null : fmString(fmGet(fm, 'series')))
  const rawLesson = block ? fmMap(block['lesson'])?.['number'] : fmGet(fm, 'lesson')
  const lesson = typeof rawLesson === 'number' && Number.isInteger(rawLesson) && rawLesson > 0 ? rawLesson : null
  const c = url && /^https?:\/\//i.test(url) ? classifyLink(url, 'source', true) : null
  return { candidates: c ? [c.role === 'reference' ? { ...c, role: 'source' } : c] : [], series, lesson }
}

/** The export's `index.csv` → id → `has_summary`. */
export function parseExportIndex(text: string): Map<string, boolean> {
  const rows = parseCsv(text.replace(/^﻿/, ''))
  const out = new Map<string, boolean>()
  const head = rows[0]?.map((h) => h.trim()) ?? []
  const idCol = head.indexOf('id')
  const sumCol = head.indexOf('has_summary')
  if (idCol < 0 || sumCol < 0) return out
  for (const r of rows.slice(1)) {
    const id = r[idCol]?.trim()
    if (id) out.set(id.toLowerCase(), r[sumCol]?.trim() === 'true')
  }
  return out
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let q = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"'
          i++
        } else q = false
      } else cell += c
    } else if (c === '"') q = true
    else if (c === ',') {
      row.push(cell)
      cell = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else cell += c
  }
  if (cell !== '' || row.length) {
    row.push(cell)
    rows.push(row)
  }
  return rows
}

/** True for a file whose front-matter marks a Notula export note. */
export function isNotulaExport(text: string): boolean {
  const { fm } = splitFrontMatter(text.replace(/^﻿/, ''))
  return !!fm && fmGet(fm, 'notula_export_version') !== undefined && !!fmString(fmGet(fm, 'id'))
}

/** The `transcript:` path of an export note, relative to the export root. */
export function exportTranscriptPath(text: string): string | null {
  const { fm } = splitFrontMatter(text.replace(/^﻿/, ''))
  return fmString(fmGet(fm, 'transcript'))
}

export function parseNotulaExport(file: SourceFile, transcriptFile: SourceFile | null, ctx: ParseContext): ParsedItem {
  const warnings: string[] = []
  const meta: Record<string, unknown> = {}
  const text = file.text.replace(/^﻿/, '')
  const { fm, body } = splitFrontMatter(text)
  const refMs = latestMtime([file])
  const version = Number(fmGet(fm, 'notula_export_version'))
  if (Number.isFinite(version) && version > EXPORT_VERSION_READ) warnings.push('Made by a newer Notula; some details may be missing')
  const id = fmString(fmGet(fm, 'id'))?.toLowerCase() ?? null

  const title = fmString(fmGet(fm, 'title')) ?? stripExt(file.name)
  const createdRaw = fmString(fmGet(fm, 'created_at'))
  const createdTime = createdRaw ? Date.parse(createdRaw) : Number.NaN
  let createdAt: Date | null = Number.isNaN(createdTime) ? null : new Date(createdTime)
  let dateOrigin: ImportDateOrigin = 'export'
  if (!createdAt) {
    createdAt = dateFromFileName(file.name)
    dateOrigin = 'file-name'
  }
  if (!createdAt) {
    createdAt = fileTime([file])
    dateOrigin = 'file-time'
  }
  const updatedRaw = fmString(fmGet(fm, 'updated_at'))
  const updatedTime = updatedRaw ? Date.parse(updatedRaw) : Number.NaN
  const meetingDate = fmString(fmGet(fm, 'meeting_date'))
  if (meetingDate) meta['meetingDate'] = meetingDate
  const cal = fmGet(fm, 'calendar_event')
  if (cal && typeof cal === 'object') {
    meta['calendarEvent'] = cal
    warnings.push('Calendar link not restored')
  }
  const attachments = fmStrings(fmGet(fm, 'attachments'))
  if (attachments.length) {
    meta['attachments'] = attachments
    warnings.push('Attachments aren’t in the export')
  }
  const tags: DocumentTag[] = []
  const rawTags = fmGet(fm, 'tags')
  if (Array.isArray(rawTags)) {
    for (const t of rawTags) {
      if (!t || typeof t !== 'object' || Array.isArray(t)) continue
      const category = typeof t['category'] === 'string' ? t['category'] : ''
      if (!TAG_CATEGORIES.has(category)) continue
      tags.push({
        category: category as DocumentTag['category'],
        value: typeof t['value'] === 'string' ? t['value'] : null,
        source: 'notula-local',
        updated_at: new Date().toISOString()
      })
    }
  }
  const folders = fmStrings(fmGet(fm, 'folders'))

  // Body split: format 2 by its `notula_sections` lines; otherwise drop `# title` and the
  // `date · attendees` line, then sections by heading.
  const lines = body.replace(/\r\n?/g, '\n').split('\n')
  const refs = version >= 2 ? exportSectionRefs(fmGet(fm, 'notula_sections')) : null
  let offset = 0
  for (let k = 0, end = text.length - body.length; k < end; k++) if (text.charCodeAt(k) === 10) offset++
  const exact = refs ? splitBySections(lines, refs, offset) : null
  let i = exact ? lines.length : 0
  while (i < lines.length && lines[i]!.trim() === '') i++
  if (i < lines.length && /^#\s/.test(lines[i]!)) {
    i++
    while (i < lines.length && lines[i]!.trim() === '') i++
  }
  if (i < lines.length && !/^##\s/.test(lines[i]!)) i++
  const sections: { heading: string | null; lines: string[] }[] = [{ heading: null, lines: [] }]
  let fence: string | null = null
  for (; i < lines.length; i++) {
    const l = lines[i]!
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(l)
    if (f) {
      if (fence === null) fence = f[1]![0]!.repeat(3)
      else if (f[1]!.startsWith(fence)) fence = null
    }
    const h = fence === null ? /^##\s+([\s\S]*)$/.exec(l) : null
    if (h) sections.push({ heading: h[1]!.trimEnd(), lines: [] })
    else sections[sections.length - 1]!.lines.push(l)
  }
  const hasSummary = id && ctx.exportSummaries ? ctx.exportSummaries.get(id) : undefined
  // Raw lines per part; headings move back up once the parts are settled.
  const notes: string[] = exact ? exact.notes : []
  const rawPanels: { title: string; lines: string[] }[] = exact ? exact.panels : []
  let inBody = false
  let splitByTitleOnly = false
  let keptKnownInBody = false
  for (const s of exact ? [] : sections) {
    if (s.heading === null) {
      notes.push(...s.lines)
      continue
    }
    if (s.heading === 'My notes' && !inBody && rawPanels.length === 0) {
      inBody = true
      continue
    }
    const known = ctx.panelTitles.has(s.heading.trim().toLowerCase())
    if (known && hasSummary !== false) {
      if (hasSummary === undefined) splitByTitleOnly = true
      rawPanels.push({ title: s.heading.trim(), lines: [...s.lines] })
      continue
    }
    if (known) keptKnownInBody = true
    const target = rawPanels.length ? rawPanels[rawPanels.length - 1]!.lines : notes
    target.push(`## ${s.heading}`, ...s.lines)
  }
  if (splitByTitleOnly || keptKnownInBody) warnings.push('Summary may be inside the note text')
  const notesMd = unshiftHeadings(notes.join('\n')).trim()
  const panels = rawPanels.map((p) => ({ title: p.title, markdown: unshiftHeadings(p.lines.join('\n')).trim() }))

  const transcript = transcriptFile ? parseTranscript(transcriptFile.text) : null
  const capped = capTitle(title)
  const source = exportSourceOf(fm)
  meta['title'] = capped.title
  if (folders.length) meta['exportFolders'] = folders
  if (source.candidates.length || source.series || source.lesson !== null) meta['exportSource'] = { series: source.series, lesson: source.lesson }
  return {
    format: 'notula-export',
    title: capped.title,
    titleOrigin: 'front-matter',
    createdAt,
    dateOrigin,
    updatedAt: Number.isNaN(updatedTime) ? new Date(file.mtimeMs || createdAt.getTime()) : new Date(updatedTime),
    notesMd: capped.rest ? `${capped.rest}\n\n${notesMd}` : notesMd,
    panels: panels.filter((p) => p.markdown !== ''),
    transcript: transcript && transcript.kind !== 'placeholder' ? transcript : null,
    candidates: finishCandidates([...source.candidates, ...bodyCandidates(notesMd, 'body')]),
    attendees: people(fmGet(fm, 'attendees')),
    tags,
    exportId: id,
    trashed: fmGet(fm, 'trashed') === true,
    exportFolders: folders,
    warnings,
    // The exported lesson number goes first: it was the note's own.
    hints: { ...emptyHints(), series: source.series, lessonFromTitle: source.lesson ?? lessonFromTitle(capped.title) },
    meta
  }
}

/** The plain-text projection of a parsed item's body. */
export function notesText(item: ParsedItem): string {
  return plainText(item.notesMd)
}
