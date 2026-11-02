// SPDX-License-Identifier: Apache-2.0
// Content sources in the data export. Pure: no Electron,
// no Node built-ins and no storage access, so the storage worker's export writer
// (storage/export-repo.ts) uses it directly, and so does the interface's Copy as Markdown.
//
// - Export format 2 (`notula_export_version: 2`), read back exactly by the importer:
//   - `notula_sections` in the front-matter lists each body section (`notes` = My notes, `panel`
//     = an enhanced-notes panel, with its title) and the 1-based line of its `## ` heading, so a
//     user's own level-1 heading named like a template is never taken for a panel;
//   - a source note's transcript is timed: `[mm:ss] Label: text`, one line per turn, at its
//     video positions. Other notes keep the exact "Copy transcript" text in the standard export
//     (unchanged); the Markdown export times them too, as offsets from their first line.
//   A version-1 reader still reads a version-2 file: the new keys are extra front-matter.
// - The standard export's front-matter gains a `source` block (null without one). A course's
//   series (in Courses now, or once) adds its behavior and match there: they belong to the series.
//   The Markdown
//   export uses flat properties instead (`source_url`, `source_kind`, `source_title`, `channel`,
//   `series`, `lesson`, `duration`, `watched`), which Markdown apps that read front-matter can sort and group.
// - Markdown export layout: the note's Notula folders (two levels), one `<name>.md` per note and a
//   sibling `<name>.transcript.md`. A lesson's name starts with its number (`12 - <title>`).
// - Export lessons (`sources:export-series`, seek.ts): that layout for one course, in a new folder
//   `<Course> <date>`. Copy as Markdown: the flat properties, My notes stamped, the sections.

import { formatPosition } from '@shared/lib/position'
import { speakerTurns } from '@shared/lib/speakers'
import { transcriptCopyText } from '@shared/lib/transcript-text'
import type { Note } from '@shared/types/notes'
import type { NoteSourceView, SourceSeries } from '@shared/types/sources'
import type { TranscriptChunk } from '@shared/types/transcript'

/** A body section of an exported note. */
export interface ExportSection {
  kind: 'notes' | 'panel'
  title: string
  /** The heading's line in the whole file, 1-based. Filled once the front-matter's length is known. */
  line: number
}

/** A session's timing facts, for chunk positions. */
export interface ExportSession {
  id: string
  provider: string
  model: string | null
  started_at: string
}

const q = (v: string): string => JSON.stringify(v)
const qn = (v: string | null | undefined): string => (v === null || v === undefined ? 'null' : q(v))
const num = (v: number | null | undefined): string => (v === null || v === undefined || !Number.isFinite(v) ? 'null' : String(v))

/** `notula_sections` front-matter lines (a fixed number of lines per section). */
export function sectionLines(sections: ExportSection[]): string[] {
  if (sections.length === 0) return ['notula_sections: []']
  const out = ['notula_sections:']
  for (const s of sections) out.push(`  - kind: ${q(s.kind)}`, `    title: ${q(s.title)}`, `    line: ${s.line}`)
  return out
}

/** The standard export's `source` block (in its front-matter); `series` is the full row, for a course's fields. */
export function sourceBlockLines(v: NoteSourceView | null, series: SourceSeries | null = null): string[] {
  if (!v) return ['source: null']
  const s = v.source
  const out = [
    'source:',
    `  kind: ${q(s.kind)}`,
    `  provider: ${q(s.provider)}`,
    `  url: ${qn(s.url)}`,
    `  title: ${q(s.title)}`,
    `  channel: ${qn(s.channel)}`,
    `  duration_ms: ${num(s.duration_ms)}`,
    `  live: ${s.live ? 'true' : 'false'}`
  ]
  if (v.series) {
    out.push('  series:', `    id: ${q(v.series.id)}`, `    kind: ${q(v.series.kind)}`, `    title: ${q(v.series.title)}`)
    if (series?.id === v.series.id && (series.registered_at !== null || series.match !== null)) {
      const list = (xs: string[]): string => `[${xs.map(q).join(', ')}]`
      const m = series.match
      out.push(
        `    registered_at: ${qn(series.registered_at)}`,
        `    on_play: ${q(series.on_play)}`,
        `    on_end: ${q(series.on_end)}`,
        `    sites: ${list(m?.hosts ?? [])}`,
        `    apps: ${list((m?.apps ?? []).map((a) => a.appUserModelId))}`,
        `    titles: ${list(m?.titles ?? [])}`,
        `    keys: ${list(m?.keys ?? [])}`,
        `    window_read: ${m?.windowRead ? 'true' : 'false'}`,
        `    catalog_origin: ${qn(series.catalog_origin)}`
      )
    }
  } else out.push('  series: null')
  out.push(
    '  lesson:',
    `    number: ${num(s.lesson_number)}`,
    `    label: ${qn(s.lesson_label)}`,
    `    state: ${q(s.lesson_state)}`,
    `  confidence: ${q(s.confidence)}`,
    `  watched_percent: ${num(v.watched.percent)}`
  )
  return out
}

/** The Markdown export's flat source properties (empty without a source). */
export function sourcePropertyLines(v: NoteSourceView | null): string[] {
  if (!v) return []
  const s = v.source
  return [
    `source_url: ${qn(s.url)}`,
    `source_kind: ${q(s.kind)}`,
    `source_title: ${q(s.title)}`,
    `channel: ${qn(s.channel)}`,
    `series: ${qn(v.series?.title ?? null)}`,
    `lesson: ${num(s.lesson_number)}`,
    `duration: ${s.duration_ms !== null && !s.live ? q(formatPosition(s.duration_ms)) : 'null'}`,
    `watched: ${num(v.watched.percent)}`
  ]
}

/**
 * Each chunk's position in ms (the Local API's rule): its mapped video position, else its offset
 * into a video-captions or timed-import session. Chunks without one are left out.
 */
export function chunkPositions(chunks: TranscriptChunk[], sessions: ExportSession[]): Map<string, number> {
  const offsetFrom = new Map<string, number>()
  for (const s of sessions) {
    const started = Date.parse(s.started_at)
    const timed = s.provider === 'captions' || (s.provider === 'import' && s.model === 'timed')
    if (timed && !Number.isNaN(started)) offsetFrom.set(s.id, started)
  }
  const out = new Map<string, number>()
  for (const c of chunks) {
    const pos = c.providerDetails?.sourcePositionMs
    if (typeof pos === 'number' && Number.isFinite(pos)) {
      out.set(c.id, Math.max(0, Math.round(pos)))
      continue
    }
    const started = offsetFrom.get(c.transcription_session_id)
    const at = Date.parse(c.start_timestamp)
    if (started !== undefined && !Number.isNaN(at)) out.set(c.id, Math.max(0, at - started))
  }
  return out
}

/** A timed transcript line spans about this much video (the prompts' media lines). */
const LINE_MS = 15_000

/**
 * The timed transcript text: the copy's header lines (title, date, participants), `Transcript:`,
 * then `[mm:ss] Label: text` per turn, a turn cut about every 15 s of video. A turn's time is
 * its first chunk's position when known, else its offset from the transcript's first turn.
 */
export function timedTranscriptText(input: {
  note: Pick<Note, 'title' | 'linked_event' | 'people' | 'created_at'>
  chunks: TranscriptChunk[]
  wordLevel: boolean
  positions: Map<string, number>
}): string {
  const head = transcriptCopyText({ note: input.note, chunks: [], wordLevel: input.wordLevel })
  // A line runs about 15 s of video, as in the prompts: one speaker's captions are otherwise a
  // single turn (a 64 KB line at [00:00] for a one-hour video).
  const sorted = [...input.chunks].sort((a, b) => (a.start_timestamp < b.start_timestamp ? -1 : a.start_timestamp > b.start_timestamp ? 1 : a.id < b.id ? -1 : 1))
  const groups: TranscriptChunk[][] = []
  let group: TranscriptChunk[] = []
  let groupStart: number | null = null
  for (const c of sorted) {
    const pos = input.positions.get(c.id)
    if (pos !== undefined && (groupStart === null || pos - groupStart >= LINE_MS || pos < groupStart)) {
      if (group.length) groups.push(group)
      group = []
      groupStart = pos
    }
    group.push(c)
  }
  if (group.length) groups.push(group)
  const turns = groups.flatMap((g) => speakerTurns(g, { wordLevel: input.wordLevel, live: false }))
  const first = turns.length ? Date.parse(turns[0]!.startTimestamp) : 0
  const lines = turns.map((t) => {
    const known = t.chunkIds.map((id) => input.positions.get(id)).find((p) => p !== undefined)
    const ms = known ?? Math.max(0, Date.parse(t.startTimestamp) - first)
    return `[${formatPosition(ms)}] ${t.label}: ${t.text}`
  })
  return `${head}${lines.join('\n')}`
}

/** A Markdown export note's name: `<n> - <title>` for a numbered lesson, else `<date> <title>`. */
export function markdownNoteName(title: string, date: string, lesson: number | null): string {
  return lesson !== null ? `${lesson} - ${title}` : `${date} ${title}`.trim()
}

// ---------- Export lessons and Copy as Markdown (Courses) ----------

const FOLDER_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i
const COURSE_FOLDER_MAX = 80

/** Export lessons' folder: `<Course> <YYYY-MM-DD>`, safe on Windows; `n` ≥ 2 adds ` (n)`. */
export function courseExportFolderName(course: string, at: Date, n = 1): string {
  let name = course
    .replace(/[\u0000-\u001f<>:"/\|?*]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, COURSE_FOLDER_MAX)
    .replace(/[. ]+$/, '')
  if (!name || FOLDER_RESERVED.test(name)) name = name ? `${name} course` : 'Course'
  const date = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`
  return `${name} ${date}${n > 1 ? ` (${n})` : ''}`
}

/** Headings move one level down (h6 stays), outside code fences. */
function lowerHeadings(markdown: string): string {
  let fence: string | null = null
  return markdown
    .split(/\r?\n/)
    .map((line) => {
      const f = /^\s*(```+|~~~+)/.exec(line)
      if (f) {
        if (fence === null) fence = f[1]![0]!
        else if (f[1]![0] === fence) fence = null
        return line
      }
      return fence === null && /^#{1,5}\s/.test(line) ? `#${line}` : line
    })
    .join('\n')
}

/**
 * Copy as Markdown on a source note: the Markdown export's flat source properties as
 * front-matter, `# title`, then My notes (the stamped projection) and each lesson-notes section
 * as `## <title>`. No transcript. Pure, so the interface builds it from what it already has.
 */
export function copyAsMarkdownText(input: {
  title: string
  view: NoteSourceView
  /** The note's own Markdown, used when there is no stamped projection. */
  notesMarkdown: string
  sections: { title: string; markdown: string }[]
}): string {
  const lines = ['---', ...sourcePropertyLines(input.view), '---', '']
  const title = input.title.trim()
  if (title) lines.push(`# ${title}`, '')
  const add = (heading: string, markdown: string): void => {
    const body = markdown.trim()
    if (body) lines.push(`## ${heading}`, '', lowerHeadings(body), '')
  }
  add('My notes', input.view.source.notes_md_stamped?.trim() || input.notesMarkdown)
  for (const s of input.sections) add(s.title.trim() || 'Summary', s.markdown)
  return `${lines.join('\n').trimEnd()}\n`
}
