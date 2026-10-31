// SPDX-License-Identifier: Apache-2.0
// The data export writer (high risk: it writes user data outside the app). Every
// write refuses a path outside `root`, a direct child folder main created for this export.
//
// - `root` must be an existing directory named `Notula export <YYYY-MM-DD HH.mm>` (optionally
//   ` (n)`), reached without a symbolic link; every file is created inside it with `wx`
//   (never overwriting), and nothing is ever deleted except this call's own `.partial` file.
// - Notes: YAML front-matter, then the "Copy enhanced notes" header (`# title`, the
//   `date · attendees` line) and the body built DOM-free from the stored markdown
//   projections, links keeping their targets. Transcripts: `transcriptCopyText` ("Copy
//   transcript"); a source note's, and every Markdown export transcript, are timed
//   (`[mm:ss] Label: text`, export format 2, sources/export-md.ts).
// - Format 2 also marks each body section in the front-matter (`notula_sections`) and adds the
//   note's `source` block. Superseded transcript sessions are left out.
// - Export notes as Markdown (`format: 'markdown'`, root `Notula Markdown export <…>`): the
//   note's Notula folders as sub-folders, `<name>.md` with flat source properties and the
//   stamped body (`notes_md_stamped`), and a sibling `<name>.transcript.md`.
// - `index.csv`: RFC 4180, UTF-8 with a BOM, CRLF, a `'` before a cell that starts with
//   `= + - @`.
// - `database/`: the encrypted copy is a voice-free copy (it keeps the key; the voices are cleared
//   in a scratch file under `<userData>/tmp` first, so no page of a vector reaches the export
//   folder), plus the key file and `Local State`; the decrypted copy is that voice-free copy,
//   attached (it inherits the key), stripped of the agreement and voice-provenance tables,
//   rekeyed to no key and checked (the SQLite3MultipleCiphers build has no `sqlcipher_export`).
//   Speaker profiles: no copy carries a voice; agreement records travel only in the encrypted one.
// - Counts may be logged; titles and content never are.

import {
  appendFileSync,
  constants as fsConstants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'
import { transcriptCopyText } from '@shared/lib/transcript-text'
import { DATA_EXPORT, type DataExportFormat } from '@shared/types/data-export'
import type { Note, NotePerson } from '@shared/types/notes'
import type { Panel } from '@shared/types/panels'
import type { NoteSourceView } from '@shared/types/sources'
import type { TranscriptChunk } from '@shared/types/transcript'
import {
  chunkPositions,
  markdownNoteName,
  sectionLines,
  sourceBlockLines,
  sourcePropertyLines,
  timedTranscriptText,
  type ExportSection,
  type ExportSession
} from '../sources/export-md'
import type { ExportNoteRef } from './api'
import { getSettingsRaw } from './kv-repo'
import { getNote, listNotes } from './notes-repo'
import { listPanels } from './panels-repo'
import { DB_FILE, KEY_FILE } from './protocol'
import { getNoteSourceView } from './sources-repo'
import { getTranscript } from './transcript-repo'
import { listTrash } from './trash-repo'
import { invalid, StoreError, type Db, type StoreCtx } from './store'

/** The folder name main gives an export (`Notula Markdown export …` for Export notes as Markdown). */
export const EXPORT_DIR_NAME = /^Notula (?:Markdown )?export \d{4}-\d{2}-\d{2} \d{2}\.\d{2}(?: \(\d{1,4}\))?$/
/** A Markdown export folder name part: at most this many characters. */
const FOLDER_PART_MAX = 50
/**
 * A Markdown export note's relative path budget, `.transcript.md` included: Explorer,
 * sync tools and Markdown apps on some setups fail past 260 characters with the chosen parent. Folder
 * parts are capped first (the same for every note in a folder); the name takes what is left.
 */
const MARKDOWN_PATH_MAX = 180
const LOCAL_STATE_FILE = 'Local State'
const DELETED_CHUNK_TEXT = '[DELETED]'
/** The header's separator: no-break space, middle dot, no-break space. */
const HEADER_SEPARATOR = ' · '
const RESERVED_WINDOWS = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

// ---------- paths ----------

/** The export root, checked: an existing real directory with main's export name. */
function assertRoot(root: unknown): string {
  if (typeof root !== 'string' || !isAbsolute(root)) throw invalid('export root must be an absolute path')
  const r = resolve(root)
  if (!EXPORT_DIR_NAME.test(basename(r))) throw invalid('refusing to write outside a Notula export folder')
  let st: import('node:fs').Stats
  try {
    st = lstatSync(r)
  } catch {
    throw invalid('the export folder does not exist')
  }
  if (!st.isDirectory() || st.isSymbolicLink()) throw invalid('the export folder is not a plain folder')
  if (realpathSync.native(r) !== join(realpathSync.native(dirname(r)), basename(r))) {
    throw invalid('refusing to write through a linked folder')
  }
  return r
}

/** `root` + a relative path, refused when it would land outside `root`. */
function inside(root: string, rel: string): string {
  const full = resolve(root, rel)
  const back = relative(root, full)
  if (back === '' || back.startsWith('..') || isAbsolute(back)) throw invalid('refusing a path outside the export folder')
  return full
}

function ensureDir(root: string, rel: string): string {
  const dir = inside(root, rel)
  mkdirSync(dir, { recursive: true })
  return dir
}

/** Creates the file; fails when it exists (never overwrites). */
function writeNew(root: string, rel: string, data: string | Uint8Array): void {
  writeFileSync(inside(root, rel), data, { flag: 'wx' })
}

/** File names: invalid characters → `-`, trailing dots and spaces trimmed, reserved names get `_`. */
export function sanitizeBaseName(raw: string, max: number = DATA_EXPORT.baseNameMax): string {
  // eslint-disable-next-line no-control-regex
  let name = raw.replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '-').replace(/\s+/g, ' ').trim()
  const chars = Array.from(name)
  if (chars.length > max) name = chars.slice(0, max).join('')
  name = name.replace(/[. ]+$/, '')
  if (name === '') name = 'Untitled'
  // `_` after the reserved stem (`Aux_. notes`), so a second pass changes nothing.
  if (RESERVED_WINDOWS.test(name)) name = name.replace(/^(con|prn|aux|nul|com[1-9]|lpt[1-9])/i, '$1_')
  return name
}

// ---------- note facts ----------

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** A date-only start is the event's calendar date, never shifted through UTC. */
function localDate(value: string | undefined): Date | null {
  if (!value) return null
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim())
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}

function displayDate(note: Pick<Note, 'linked_event' | 'created_at'>): Date | null {
  const start = note.linked_event?.start
  return localDate(start?.dateTime) ?? localDate(start?.date) ?? localDate(note.created_at)
}

/** `meeting_date`: the event start (date-only kept as the calendar date), else the creation time. */
function meetingDate(note: Pick<Note, 'linked_event' | 'created_at'>): string {
  const start = note.linked_event?.start
  if (start?.dateTime) {
    const d = new Date(start.dateTime)
    if (!Number.isNaN(d.getTime())) return d.toISOString()
  }
  if (start?.date && /^\d{4}-\d{2}-\d{2}$/.test(start.date)) return start.date
  return note.created_at
}

function attendeesOf(note: Note): { name: string; email: string }[] {
  const people: NotePerson[] = note.people?.attendees ?? []
  const list =
    people.length > 0
      ? people.map((p) => ({ name: p.name?.trim() ?? '', email: p.email?.trim() ?? '' }))
      : (note.linked_event?.attendees ?? []).map((a) => ({ name: a.displayName?.trim() ?? '', email: a.email?.trim() ?? '' }))
  const seen = new Set<string>()
  return list.filter((p) => {
    if (!p.name && !p.email) return false
    const k = p.email.toLowerCase() || `name:${p.name}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

function folderNames(s: StoreCtx, noteId: string): string[] {
  return (
    s.db
      .prepare(
        `SELECT f.title FROM folder_notes fn JOIN folders f ON f.id = fn.folder_id
         WHERE fn.note_id = ? ORDER BY f.title COLLATE NOCASE, f.id`
      )
      .all(noteId) as { title: string }[]
  ).map((r) => r.title || 'Untitled folder')
}

function attachmentNames(s: StoreCtx, noteId: string): string[] {
  return (
    s.db
      .prepare(
        `SELECT file_name FROM attachments
         WHERE parent_type = 'note' AND parent_id = ? AND deleted_at IS NULL ORDER BY created_at, id`
      )
      .all(noteId) as { file_name: string }[]
  ).map((r) => r.file_name)
}

function hasTranscriptRows(s: StoreCtx, noteId: string): boolean {
  return !!s.db
    .prepare(`SELECT 1 FROM transcript_chunks WHERE document_id = ? AND trim(text) != '' AND text != ? LIMIT 1`)
    .get(noteId, DELETED_CHUNK_TEXT)
}

function panelMarkdown(p: Panel): string {
  return (p.content_markdown ?? p.generated_content ?? '').trim()
}

// ---------- the markdown file ----------

const q = (v: string): string => JSON.stringify(v)

/** YAML front-matter: every string double-quoted (JSON strings are valid YAML scalars). */
function frontMatter(f: {
  note: Note
  attendees: { name: string; email: string }[]
  folders: string[]
  attachments: string[]
  transcript: string | null
  trashed: boolean
  source: NoteSourceView | null
  format: DataExportFormat
  sections: ExportSection[]
}): string {
  const { note } = f
  const lines = ['---', `id: ${q(note.id)}`, `title: ${q(note.title?.trim() || 'Untitled')}`]
  lines.push(`created_at: ${q(note.created_at)}`, `updated_at: ${q(note.updated_at)}`, `meeting_date: ${q(meetingDate(note))}`)
  const ev = note.linked_event
  if (ev) {
    lines.push('calendar_event:')
    lines.push(`  title: ${ev.summary ? q(ev.summary) : 'null'}`)
    lines.push(`  start: ${q(ev.start?.dateTime ?? ev.start?.date ?? '')}`)
    lines.push(`  end: ${q(ev.end?.dateTime ?? ev.end?.date ?? '')}`)
    lines.push(`  ical_uid: ${ev.iCalUID ? q(ev.iCalUID) : 'null'}`)
  }
  if (f.attendees.length === 0) lines.push('attendees: []')
  else {
    lines.push('attendees:')
    for (const a of f.attendees) lines.push(`  - name: ${a.name ? q(a.name) : 'null'}`, `    email: ${a.email ? q(a.email) : 'null'}`)
  }
  lines.push(f.folders.length === 0 ? 'folders: []' : 'folders:', ...f.folders.map((n) => `  - ${q(n)}`))
  const tags = note.tags.filter((t) => t && typeof t === 'object')
  if (tags.length === 0) lines.push('tags: []')
  else {
    lines.push('tags:')
    for (const t of tags) lines.push(`  - category: ${q(t.category)}`, `    value: ${t.value === null ? 'null' : q(t.value)}`)
  }
  lines.push(`created_via: ${q(note.created_via)}`)
  lines.push(`transcript: ${f.transcript ? q(f.transcript) : 'null'}`)
  lines.push(f.attachments.length === 0 ? 'attachments: []' : 'attachments:', ...f.attachments.map((n) => `  - ${q(n)}`))
  lines.push(`trashed: ${f.trashed ? 'true' : 'false'}`)
  lines.push(...(f.format === 'markdown' ? sourcePropertyLines(f.source) : sourceBlockLines(f.source)))
  lines.push(...sectionLines(f.sections), `notula_export_version: ${DATA_EXPORT.exportVersion}`, '---')
  return lines.join('\n')
}

/** Headings move one level down (h6 stays), outside code fences. */
function shiftHeadings(markdown: string): string {
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
      if (fence === null && /^#{1,5}\s/.test(line)) return `#${line}`
      return line
    })
    .join('\n')
}

/** The "Copy enhanced notes" header (en-GB `Thu, 15 Oct 26`; attendees by name, else email). */
function headerLines(note: Note): string[] {
  const d = displayDate(note)
  const date = d ? new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: '2-digit', month: 'short', year: '2-digit' }).format(d) : ''
  const attendees = (note.people?.attendees ?? []).map((a) => a.name?.trim() || a.email?.trim() || '').filter((a) => a !== '')
  const out: string[] = []
  const title = note.title?.trim()
  if (title) out.push(`# ${title}`, '')
  out.push([date, attendees.join(', ')].filter((p) => p !== '').join(HEADER_SEPARATOR))
  return out
}

/**
 * The note file. `notula_sections` gives each section heading's line: the front-matter's length
 * depends only on how many sections there are, so it is measured first.
 */
function noteMarkdown(note: Note, panels: Panel[], meta: Omit<Parameters<typeof frontMatter>[0], 'sections'>, body: string): string {
  const lines = ['', ...headerLines(note)]
  const sections: { kind: ExportSection['kind']; title: string; at: number }[] = []
  const add = (kind: ExportSection['kind'], title: string, markdown: string): void => {
    lines.push('')
    sections.push({ kind, title, at: lines.length })
    lines.push(`## ${title}`, '', ...shiftHeadings(markdown).split('\n'))
  }
  const mine = body.trim()
  if (mine) add('notes', 'My notes', mine)
  for (const p of panels) {
    const text = panelMarkdown(p)
    if (text) add('panel', p.title.trim() || 'Summary', text)
  }
  const fmLength = frontMatter({ ...meta, sections: sections.map((x) => ({ kind: x.kind, title: x.title, line: 0 })) }).split('\n').length
  const fm = frontMatter({ ...meta, sections: sections.map((x) => ({ kind: x.kind, title: x.title, line: fmLength + x.at + 1 })) })
  return `${fm}\n${lines.join('\n')}\n`
}

/** Sessions of a note, for chunk positions. */
function exportSessions(s: StoreCtx, noteId: string): ExportSession[] {
  return (s.db.prepare(`SELECT id, provider, model, started_at FROM transcription_sessions WHERE document_id = ?`).all(noteId) as Record<string, unknown>[]).map((r) => ({
    id: String(r['id']),
    provider: String(r['provider'] ?? ''),
    model: typeof r['model'] === 'string' ? r['model'] : null,
    started_at: String(r['started_at'] ?? '')
  }))
}

/** The note's transcript lines, without deleted lines or the sessions a switch to video captions hid. */
function exportChunks(s: StoreCtx, noteId: string, source: NoteSourceView | null): TranscriptChunk[] {
  const hidden = new Set(source?.source.superseded_session_ids ?? [])
  return getTranscript(s, noteId).filter((c) => c.text !== DELETED_CHUNK_TEXT && !hidden.has(c.transcription_session_id))
}

/** The Markdown export's folder for a note: its sub-folder when it has one, else a top-level folder, else the root. */
function markdownDir(s: StoreCtx, noteId: string): string {
  const rows = s.db
    .prepare(
      `SELECT f.title, p.title AS parent_title, f.parent_id FROM folder_notes fn JOIN folders f ON f.id = fn.folder_id
       LEFT JOIN folders p ON p.id = f.parent_id
       WHERE fn.note_id = ? ORDER BY (f.parent_id IS NULL), f.title COLLATE NOCASE, f.id`
    )
    .all(noteId) as { title: string | null; parent_title: string | null; parent_id: string | null }[]
  const r = rows[0]
  if (!r) return ''
  const part = (t: string | null): string => sanitizeBaseName(t?.trim() || 'Untitled folder', FOLDER_PART_MAX)
  return r.parent_id ? `${part(r.parent_title)}/${part(r.title)}` : part(r.title)
}

/** A `relDir` from the list, checked again: at most Trash plus two sanitized parts. */
function checkedDir(relDir: unknown, trashed: boolean): string {
  const dir = typeof relDir === 'string' ? relDir : ''
  const parts = dir ? dir.split('/') : []
  if (parts.length > 2 || parts.some((p) => !p || p !== sanitizeBaseName(p, FOLDER_PART_MAX))) throw invalid('bad folder name')
  return [...(trashed ? ['Trash'] : []), ...parts].join('/')
}

// ---------- the list ----------

/** The listable scope (and Trash when asked), with safe base names, unique per export. */
export function listExportNotes(s: StoreCtx, q2: { includeTrash: boolean; format?: DataExportFormat }): ExportNoteRef[] {
  const items: { id: string; trashed: boolean }[] = listNotes(s, { scope: 'own' }).items.map((n) => ({ id: n.id, trashed: false }))
  if (q2?.includeTrash === true) for (const t of listTrash(s)) items.push({ id: t.id, trashed: true })
  const used = new Set<string>()
  const refs: ExportNoteRef[] = []
  for (const item of items) {
    const note = getNote(s, item.id, { includeDeleted: true })
    if (!note) continue
    const d = displayDate(note)
    const date = d ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` : ''
    if (q2?.format === 'markdown') {
      // Readable names, unique per folder (a note's transcript sits beside it as `<name>.transcript.md`).
      const relDir = markdownDir(s, note.id)
      const lesson = getNoteSourceView(s, note.id)?.source.lesson_number ?? null
      const dirLength = (item.trashed ? 'Trash/'.length : 0) + (relDir ? relDir.length + 1 : 0)
      const nameMax = Math.min(DATA_EXPORT.baseNameMax - 5, MARKDOWN_PATH_MAX - dirLength - '.transcript.md'.length - ' (999)'.length)
      const name = sanitizeBaseName(markdownNoteName(note.title?.trim() || 'Untitled', date, lesson), nameMax)
      // Keyed by the folder on disk: a user folder named "Trash" shares it with trashed notes.
      const dirKey = `${[...(item.trashed ? ['Trash'] : []), ...(relDir ? [relDir] : [])].join('/').toLowerCase()}/`
      let base = name
      const taken = (b: string): boolean =>
        used.has(dirKey + b) || used.has(`${dirKey}${b}.transcript`) || (b.endsWith('.transcript') && used.has(dirKey + b.slice(0, -'.transcript'.length)))
      for (let n = 2; taken(base.toLowerCase()); n++) base = sanitizeBaseName(`${name} (${n})`)
      used.add(dirKey + base.toLowerCase())
      refs.push({ id: note.id, baseName: base, trashed: item.trashed, hasTranscript: hasTranscriptRows(s, note.id), relDir })
      continue
    }
    const suffix = ` (${note.id.slice(0, 8)})`
    const titlePart = sanitizeBaseName(`${date} ${note.title?.trim() || 'Untitled'}`, DATA_EXPORT.baseNameMax - suffix.length)
    let base = sanitizeBaseName(`${titlePart}${suffix}`)
    for (let n = 2; used.has(`${item.trashed}/${base.toLowerCase()}`); n++) base = sanitizeBaseName(`${titlePart}${suffix} (${n})`)
    used.add(`${item.trashed}/${base.toLowerCase()}`)
    refs.push({ id: note.id, baseName: base, trashed: item.trashed, hasTranscript: hasTranscriptRows(s, note.id) })
  }
  return refs
}

// ---------- notes and transcripts ----------

export function writeExportNotes(
  s: StoreCtx,
  q2: { root: string; notes: ExportNoteRef[]; markdown: boolean; transcripts: boolean; format?: DataExportFormat }
): { written: { id: string; notesFile: string | null; transcriptFile: string | null }[]; errors: { noteId: string; message: string }[] } {
  const format: DataExportFormat = q2?.format === 'markdown' ? 'markdown' : 'standard'
  const root = assertRoot(q2?.root)
  if (!Array.isArray(q2.notes) || q2.notes.length > DATA_EXPORT.batchNotes) throw invalid(`at most ${DATA_EXPORT.batchNotes} notes per call`)
  const wordLevel = getSettingsRaw(s)['transcription.diarization'] === true
  const written: { id: string; notesFile: string | null; transcriptFile: string | null }[] = []
  const errors: { noteId: string; message: string }[] = []
  for (const ref of q2.notes) {
    try {
      if (typeof ref?.id !== 'string' || typeof ref.baseName !== 'string') throw invalid('bad note reference')
      const base = sanitizeBaseName(ref.baseName)
      if (base !== ref.baseName) throw invalid('bad file name')
      const note = getNote(s, ref.id, { includeDeleted: true })
      if (!note) throw new StoreError('not-found', 'the note no longer exists')
      const sub = ref.trashed ? '/Trash' : ''
      const source = getNoteSourceView(s, note.id)
      // Standard: notes/ and transcripts/. Markdown: the note's folder, the transcript beside the note.
      const dir = format === 'markdown' ? checkedDir(ref.relDir, ref.trashed) : null
      const inDir = (name: string): string => (dir ? `${dir}/${name}` : name)

      let transcriptFile: string | null = null
      if (q2.transcripts && ref.hasTranscript) {
        const chunks = exportChunks(s, note.id, source)
        if (chunks.some((c) => c.text.trim() !== '')) {
          if (dir === null) ensureDir(root, `transcripts${sub}`)
          else if (dir) ensureDir(root, dir)
          transcriptFile = dir === null ? `transcripts${sub}/${base}.txt` : inDir(`${base}.transcript.md`)
          // A meeting's transcript stays exactly "Copy transcript"; a video's carries its times.
          const text =
            dir !== null || source
              ? timedTranscriptText({ note, chunks, wordLevel, positions: chunkPositions(chunks, exportSessions(s, note.id)) })
              : transcriptCopyText({ note, chunks, wordLevel })
          writeNew(root, transcriptFile, `${text}\n`)
        }
      }

      let notesFile: string | null = null
      if (q2.markdown) {
        if (dir === null) ensureDir(root, `notes${sub}`)
        else if (dir) ensureDir(root, dir)
        notesFile = dir === null ? `notes${sub}/${base}.md` : inDir(`${base}.md`)
        // The Markdown export's body carries the video times (`[mm:ss](url)`); the standard one is unchanged.
        const body = format === 'markdown' ? source?.source.notes_md_stamped?.trim() || note.notes_md || '' : note.notes_md || ''
        const md = noteMarkdown(
          note,
          listPanels(s, note.id),
          {
            note,
            attendees: attendeesOf(note),
            folders: folderNames(s, note.id),
            attachments: attachmentNames(s, note.id),
            transcript: transcriptFile,
            trashed: ref.trashed,
            source,
            format
          },
          body
        )
        writeNew(root, notesFile, md)
      }
      written.push({ id: note.id, notesFile, transcriptFile })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      errors.push({ noteId: typeof ref?.id === 'string' ? ref.id : '', message })
    }
  }
  s.log('info', 'export-notes-batch', { written: written.length, errors: errors.length })
  return { written, errors }
}

// ---------- index.csv ----------

function csvCell(value: string): string {
  const safe = /^[=+\-@]/.test(value) ? `'${value}` : value
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}

export function writeExportIndex(
  s: StoreCtx,
  q2: { root: string; rows: { id: string; notesFile: string | null; transcriptFile: string | null }[] }
): void {
  const root = assertRoot(q2?.root)
  if (!Array.isArray(q2.rows)) throw invalid('rows must be a list')
  const lines = [DATA_EXPORT.indexColumns.map(csvCell).join(',')]
  for (const row of q2.rows) {
    const note = typeof row?.id === 'string' ? getNote(s, row.id, { includeDeleted: true }) : null
    if (!note) continue
    const panels = listPanels(s, note.id)
    const cells = [
      note.id,
      note.title?.trim() || 'Untitled',
      meetingDate(note),
      note.created_at,
      note.updated_at,
      attendeesOf(note)
        .map((a) => (a.name && a.email ? `${a.name} <${a.email}>` : a.email ? `<${a.email}>` : a.name))
        .join('; '),
      folderNames(s, note.id).join('; '),
      String(panels.some((p) => panelMarkdown(p) !== '')),
      String(row.transcriptFile !== null || hasTranscriptRows(s, note.id)),
      String(note.deleted_at !== null),
      note.created_via,
      row.notesFile ?? '',
      row.transcriptFile ?? ''
    ]
    lines.push(cells.map(csvCell).join(','))
  }
  writeNew(root, 'index.csv', `﻿${lines.join('\r\n')}\r\n`)
  s.log('info', 'export-index-written', { rows: lines.length - 1 })
}

export function writeExportReadme(s: StoreCtx, q2: { root: string; text: string }): void {
  const root = assertRoot(q2?.root)
  if (typeof q2.text !== 'string' || q2.text.length > 200_000) throw invalid('bad README text')
  writeNew(root, 'README.txt', q2.text.replace(/\r?\n/g, '\r\n'))
}

// ---------- database copies ----------

/**
 * The tables no copy of the database carries rows of: voice samples,
 * centroids, the 14-day cluster vectors and the legacy self profile.
 */
export const BIOMETRIC_TABLES = ['speaker_exemplars', 'speaker_voice_spaces', 'speaker_cluster_vectors', 'voiceprints'] as const
/**
 * Also left out of the decrypted copy: the plaintext copy has no use for them, and the match rows
 * and requests would tell who has a remembered voice.
 */
const PLAINTEXT_DROPPED = ['speaker_agreements', 'speaker_negatives', 'speaker_matches', 'speaker_pending'] as const

const sqlPath = (p: string): string => p.split("'").join("''")

/** Deletes every row of these tables in an attached copy, where the table exists. */
function clearTables(db: Db, schema: string, tables: readonly string[]): void {
  const present = new Set(
    (db.prepare(`SELECT name FROM ${schema}.sqlite_master WHERE type = 'table'`).all() as { name: string }[]).map((r) => r.name)
  )
  for (const t of tables) if (present.has(t)) db.exec(`DELETE FROM ${schema}."${t}"`)
}

/**
 * An encrypted copy (same key) at `dest`, without voices. The voices are cleared in a scratch
 * copy in `scratchDir` (beside the live database, not in the export folder, which may be
 * removable or synced): `VACUUM INTO` it, the biometric tables emptied with `secure_delete` on
 * and the journal in memory, then `VACUUM ... INTO` `dest` from it, so no page of a vector, free
 * or not, ever reaches `dest`. The scratch file is removed either way.
 * Used by the encrypted export, the decrypted one and the pre-migration backup. The live database
 * is never touched. A restored pre-migration backup has no voice either, the Labs one included,
 * so Forget leaves no copy.
 */
export function writeCopyWithoutVoices(db: Db, dest: string, scratchDir: string): void {
  mkdirSync(scratchDir, { recursive: true })
  const scratch = join(scratchDir, `voice-free-${randomUUID()}.db`)
  try {
    db.exec(`VACUUM INTO '${sqlPath(scratch)}'`)
    db.exec(`ATTACH DATABASE '${sqlPath(scratch)}' AS voice_free_copy`)
    try {
      db.pragma('voice_free_copy.secure_delete = ON')
      db.pragma('voice_free_copy.journal_mode = MEMORY')
      clearTables(db, 'voice_free_copy', BIOMETRIC_TABLES)
      db.exec(`VACUUM voice_free_copy INTO '${sqlPath(dest)}'`)
    } finally {
      db.exec('DETACH DATABASE voice_free_copy')
    }
  } finally {
    removePartial(scratch)
  }
}

function removePartial(partial: string): void {
  for (const f of [partial, `${partial}-journal`, `${partial}-wal`, `${partial}-shm`]) {
    try {
      if (existsSync(f) && statSync(f).isFile()) rmSync(f)
    } catch {
      // left for the user; it is inside the export folder
    }
  }
}

function databaseReadme(kind: 'encrypted' | 'decrypted', files: string[]): string {
  const at = new Date().toISOString()
  if (kind === 'encrypted') {
    return [
      'Encrypted database copy',
      '',
      `Exported on ${at}. Files: ${files.join(', ')}.`,
      '',
      'These files are encrypted. notula.key holds the database key, and that key is itself protected by',
      "this computer's secure storage: on Windows through the \"Local State\" file (copied here), which",
      'Windows protects for the signed-in user; on macOS through the Keychain. So this copy opens only on',
      'this computer, signed in as the same user.',
      '',
      'To open it in Notula: quit Notula, then copy notula.db and notula.key into the "data" folder inside',
      'Notula\'s data folder, replacing what is there (delete notula.db-wal and notula.db-shm there, when',
      'present). On Windows, if Notula\'s data folder was reset or reinstalled since, also copy "Local',
      'State" into Notula\'s data folder (the folder that contains "data"), replacing that file.',
      '',
      'Remembered voices are not in this copy: they stay on this computer only. Voice agreement records are.',
      '',
      ''
    ].join('\r\n')
  }
  return [
    'Decrypted database copy',
    '',
    `Exported on ${at}. File: ${files.join(', ')}.`,
    '',
    'WARNING: notula-decrypted.db is NOT encrypted. It holds all your notes, transcripts and settings',
    'in plain form, and anyone who can open this file can read them with any SQLite browser. It holds',
    'no API keys in plain form: those stay encrypted with this computer\'s secure storage.',
    'Keep it somewhere safe, and delete it when you no longer need it.',
    '',
    ''
  ].join('\r\n')
}

export function writeDatabaseCopy(
  s: StoreCtx,
  q2: { root: string; kind: 'encrypted' | 'decrypted'; localStatePath: string }
): { files: string[] } {
  const root = assertRoot(q2?.root)
  if (q2.kind !== 'encrypted' && q2.kind !== 'decrypted') throw invalid('kind must be encrypted or decrypted')
  // The engine keeps `tmpDir` at `<userData>/tmp` beside `<userData>/data` (trash-repo's tmpDirFor).
  const userData = resolve(s.tmpDir, '..')
  const dataDir = join(userData, 'data')
  const dir = ensureDir(root, 'database')

  if (q2.kind === 'encrypted') {
    // Only Chromium's `Local State` beside the data folder, never another file.
    const localState = resolve(String(q2.localStatePath ?? ''))
    if (basename(localState) !== LOCAL_STATE_FILE || resolve(dirname(localState)) !== userData) {
      throw invalid('unexpected Local State path')
    }
    // A consistent copy with the same key and without voices; then the key file. The
    // worker runs one call at a time, so nothing writes while the copy is made.
    const copy = inside(root, `database/${DB_FILE}`)
    const partial = `${copy}.partial`
    if (existsSync(copy) || existsSync(partial)) throw invalid('a database copy already exists in this export')
    try {
      writeCopyWithoutVoices(s.db, partial, s.tmpDir)
      if (existsSync(copy)) throw new Error('a database copy appeared meanwhile')
      renameSync(partial, copy)
    } catch (err) {
      removePartial(partial)
      s.log('error', 'export-encrypted-copy-failed', { err })
      throw new StoreError('internal', `The encrypted copy could not be made: ${err instanceof Error ? err.message : String(err)}`)
    }
    const files: string[] = [DB_FILE]
    if (existsSync(join(dataDir, KEY_FILE))) {
      copyFileSync(join(dataDir, KEY_FILE), inside(root, `database/${KEY_FILE}`), fsConstants.COPYFILE_EXCL)
      files.push(KEY_FILE)
    }
    if (existsSync(localState)) {
      copyFileSync(localState, inside(root, `database/${LOCAL_STATE_FILE}`), fsConstants.COPYFILE_EXCL)
      files.push(LOCAL_STATE_FILE)
    }
    appendFileSync(join(dir, 'README.txt'), databaseReadme('encrypted', files))
    s.log('info', 'export-database-copied', { kind: 'encrypted', files: files.length })
    return { files: files.map((f) => `database/${f}`) }
  }

  const out = inside(root, 'database/notula-decrypted.db')
  const partial = `${out}.partial`
  if (existsSync(out) || existsSync(partial)) throw invalid('a decrypted copy already exists in this export')
  const sql = sqlPath
  let attached = false
  try {
    // 1. An encrypted, consistent copy (the WAL included) without voices.
    writeCopyWithoutVoices(s.db, partial, s.tmpDir)
    // 2. Attached without a KEY clause it opens with this connection's key; rekeying it to
    //    an empty key decrypts that copy in place. The live database is never touched.
    s.db.exec(`ATTACH DATABASE '${sql(partial)}' AS export_copy`)
    attached = true
    // Agreement records and voice provenance never leave as plaintext. Deleted while the
    // copy is still encrypted, so no plaintext page image of them reaches the rollback journal.
    s.db.pragma('export_copy.secure_delete = ON')
    clearTables(s.db, 'export_copy', [...BIOMETRIC_TABLES, ...PLAINTEXT_DROPPED])
    s.db.exec(`UPDATE export_copy.speaker_people SET skipped_samples = 0, last_matched_at = NULL`)
    s.db.pragma(`export_copy.rekey = ''`)
    s.db.pragma('export_copy.journal_mode = DELETE')
    s.db.exec('DETACH DATABASE export_copy')
    attached = false
    // 3. It must open as a plain SQLite file with no key.
    const check = new Database(partial, { readonly: true, fileMustExist: true })
    try {
      check.prepare('SELECT count(*) FROM sqlite_master').get()
      const ok = check.pragma('quick_check', { simple: true })
      if (ok !== 'ok') throw new Error(`quick_check: ${String(ok)}`)
    } finally {
      check.close()
    }
    if (existsSync(out)) throw new Error('a decrypted copy appeared meanwhile')
    renameSync(partial, out)
  } catch (err) {
    if (attached) {
      try {
        s.db.exec('DETACH DATABASE export_copy')
      } catch {
        // already detached
      }
    }
    removePartial(partial)
    s.log('error', 'export-decrypted-copy-failed', { err })
    throw new StoreError('internal', `The decrypted copy could not be made: ${err instanceof Error ? err.message : String(err)}`)
  }
  appendFileSync(join(dir, 'README.txt'), databaseReadme('decrypted', ['notula-decrypted.db']))
  s.log('info', 'export-database-copied', { kind: 'decrypted', files: 1 })
  return { files: ['database/notula-decrypted.db'] }
}
