// SPDX-License-Identifier: Apache-2.0
// Items, folders and preview statuses. Pure: the scan's files,
// the storage matches and the existing folders and notes come in as data.
//
// Detection (`auto`, first match wins): a Notula export note (front-matter with
// `notula_export_version` and `id`); a study lesson folder (holding `Transcription.md`,
// `Summary.md` or `Hyperlinks.md`, named `<n>-<slug>` or `<slug>`); a transcript paired with a
// note by name (`<base> - Transcript`, `<base> (transcript)`, `<base>.transcript`); a lone
// transcript; Obsidian (front-matter, `[[…]]`, or `.obsidian/` at the root); plain Markdown.
// When a study lesson is found (or the preset is `study-vault`) the study skip list applies.
//
// Statuses, the first rule that matches: 1 already imported (same key and hash, note live),
// 2 in Trash, 3 new but "Deleted after an earlier import", 4 changed since the last import,
// 5 a Notula export id already here, 6 duplicate (same hash in this preview or from another
// path), 7 new. Changed files are never updated in place: ticking one imports a new note.

import { randomUUID } from 'node:crypto'
import type {
  CandidateLink,
  ImportDateOrigin,
  ImportFolderMode,
  ImportFormat,
  ImportOptions,
  ImportPreset,
  ImportPreview,
  ImportPreviewRow,
  ImportRowStatus,
  ImportTitleOrigin
} from '@shared/types/imports-markdown'
import type { ImportMatches } from '../storage/api'
import {
  exportTranscriptPath,
  isNotulaExport,
  parseExportIndex,
  parseMarkdownNote,
  parseNotulaExport,
  parseStudyLesson,
  parseTranscriptItem,
  type ParseContext,
  type ParsedItem,
  type SourceFile
} from './formats'
import { splitFrontMatter } from './frontmatter'
import { atxHeading } from './rewrite'
import { itemHash, type ScannedFile, type ScanResult } from './scan'
import { looksLikeTranscript } from './transcript'

export const PLAN_COPY = {
  notLesson: 'Not part of the study notes',
  courseReadme: 'Course overview, not a lesson',
  curriculum: 'Course outline: import it as a catalog after Find sources',
  sessions: 'Study sessions aren’t lessons',
  lessonOther: 'Not part of a lesson',
  exportPart: 'Part of a Notula export',
  exportTrash: 'In Trash in the export',
  txt: 'Not a Markdown file',
  alreadyImported: 'Already imported',
  restore: 'Restore it from Trash',
  purged: 'Deleted after an earlier import',
  sameDate: 'A note with this title and date exists',
  existingFolder: (name: string) => `Adds to your existing folder ${name}`,
  flattened: (path: string) => `Flattened from ${path}`,
  dropped: (n: number) => `${n} transcript lines over the limit weren’t imported`,
  unreadable: 'Notula couldn’t read this file'
} as const

const STUDY_FILES: Record<string, 'transcription' | 'summary' | 'hyperlinks'> = {
  'transcription.md': 'transcription',
  'summary.md': 'summary',
  'hyperlinks.md': 'hyperlinks'
}
const SLUG = /^(?:\d+-)?[\p{L}\p{N}]+(?:[-_][\p{L}\p{N}]+)*$/u
/** The standard export's folder and Export notes as Markdown's (`EXPORT_DIR_NAME`). */
const EXPORT_ROOT = /^Notula (?:Markdown )?export \d{4}-\d{2}-\d{2} \d{2}\.\d{2}(?: \(\d{1,4}\))?$/
const EXPORT_TRANSCRIPT = /\.transcript\.md$/i
const PAIR_SUFFIX = /^(.*?)(?: - Transcript| \(transcript\)|\.transcript)\.(md|markdown|txt)$/i

/** Which files an item reads, by role; stored in the item's metadata so a run can read them again. */
export interface ItemSpec {
  format: ImportFormat
  files: { main?: string; transcript?: string; transcription?: string; summary?: string; hyperlinks?: string }
  lessonFolder?: string
  course?: string | null
  underVideos?: boolean
  /** A Notula export's root, relative (`''` = the import root). */
  exportRoot?: string | null
}

/** What the preview shows of a parsed item; the text itself isn't kept. */
export interface PreviewInfo {
  title: string
  titleOrigin: ImportTitleOrigin
  createdAt: string
  dateOrigin: ImportDateOrigin
  contents: ImportPreviewRow['contents']
  warnings: string[]
  exportId: string | null
  trashed: boolean
  exportFolders: string[]
  candidates: CandidateLink[]
  meta: Record<string, unknown>
}

export interface FormedItem {
  id: string
  spec: ItemSpec | null
  relPath: string
  /** Directory parts for the mirror and single modes (study and export items map their own). */
  dirParts: string[]
  hash: string
  size: number
  info: PreviewInfo | null
  /** A skip that holds whatever the options say. */
  skip: { status: 'skipped' | 'unreadable'; reason: string } | null
  /** A study skip, lifted by "Also import other Markdown files". */
  studySkip: string | null
}

export interface Catalog {
  course: string
  relPath: string
}

export interface Formed {
  items: FormedItem[]
  studyVault: boolean
  catalogs: Catalog[]
}

export interface PlanEnv {
  dayFirst: boolean
  panelTitles: Set<string>
}

/** `C:/Notes/a.md` → case-folded on Windows. */
export function sourceKey(root: string, rel: string, platform: NodeJS.Platform = process.platform): string {
  const r = root.replace(/\\/g, '/').replace(/\/+$/, '')
  const key = `${r}/${rel}`
  return platform === 'win32' ? key.toLowerCase() : key
}

function dirOf(rel: string): string {
  const i = rel.lastIndexOf('/')
  return i < 0 ? '' : rel.slice(0, i)
}

function nameOf(rel: string): string {
  return rel.slice(rel.lastIndexOf('/') + 1)
}

function humanize(slug: string): string {
  const s = slug.replace(/[-_]+/g, ' ').trim()
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : slug
}

/** A parsed item → what the preview keeps. */
export function previewInfo(p: ParsedItem): PreviewInfo {
  const warnings = [...p.warnings]
  if (p.transcript?.dropped) warnings.push(PLAN_COPY.dropped(p.transcript.dropped))
  return {
    title: p.title,
    titleOrigin: p.titleOrigin,
    createdAt: p.createdAt.toISOString(),
    dateOrigin: p.dateOrigin,
    contents: {
      noteText: p.notesMd.trim() !== '',
      summaries: p.panels.length,
      transcript: p.transcript ? { lines: p.transcript.turns.length, timed: p.transcript.kind === 'timed' } : null,
      sources: p.candidates.filter((c) => c.role === 'source' || c.role === 'series').length,
      references: p.candidates.filter((c) => c.role === 'reference').length
    },
    warnings,
    exportId: p.exportId,
    trashed: p.trashed,
    exportFolders: p.exportFolders,
    candidates: p.candidates,
    meta: {
      ...p.meta,
      hints: p.hints,
      lastAnchorMs: p.transcript?.lastAnchorMs ?? null,
      dates: { used: p.createdAt.toISOString(), origin: p.dateOrigin }
    }
  }
}

/** Parses one item from its files (shared by the scan and the run, so both read the same note). */
export function parseSpec(spec: ItemSpec, files: Record<string, SourceFile | null>, ctx: ParseContext): ParsedItem {
  const get = (role: keyof ItemSpec['files']): SourceFile | null => (spec.files[role] ? (files[spec.files[role]!] ?? null) : null)
  switch (spec.format) {
    case 'study-lesson':
      return parseStudyLesson(
        { transcription: get('transcription'), summary: get('summary'), hyperlinks: get('hyperlinks') },
        spec.lessonFolder ?? '',
        spec.course ?? null,
        spec.underVideos === true,
        ctx
      )
    case 'notula-export':
      return parseNotulaExport(get('main')!, get('transcript'), ctx)
    case 'transcript-copy':
      return parseTranscriptItem(get('main')!, ctx)
    case 'plain':
    case 'obsidian':
      return parseMarkdownNote(get('main')!, get('transcript'), ctx, spec.format)
  }
}

/** The relative paths an item reads, in a fixed order. */
export function specFiles(spec: ItemSpec): string[] {
  return Object.values(spec.files).filter((x): x is string => typeof x === 'string').sort()
}

/**
 * The export root of an export note path: the nearest folder named like an export (the import
 * root counts when `rootIsExport`), else the folder holding `notes/`, else the note's folder. A
 * Markdown export nests notes in folders (`Courses/<course>/…`) and names transcripts from its
 * root, so the note's own folder is only the last resort.
 */
function exportRootOf(rel: string, rootIsExport: boolean): string {
  const parts = rel.split('/')
  for (let i = parts.length - 1; i >= 1; i--) if (EXPORT_ROOT.test(parts[i - 1]!)) return parts.slice(0, i).join('/')
  if (rootIsExport) return ''
  const i = parts.lastIndexOf('notes')
  return i >= 0 ? parts.slice(0, i).join('/') : dirOf(rel)
}

export function formItems(scan: ScanResult, preset: ImportPreset, env: PlanEnv): Formed {
  const byRel = new Map<string, ScannedFile>(scan.files.map((f) => [f.rel, f]))
  const used = new Set<string>()
  const items: FormedItem[] = []
  const catalogs: Catalog[] = []
  const indexCache = new Map<string, Map<string, boolean> | null>()
  const ctxFor = (exportRoot: string | null): ParseContext => {
    if (exportRoot === null) return { dayFirst: env.dayFirst, panelTitles: env.panelTitles, exportSummaries: null }
    if (!indexCache.has(exportRoot)) {
      const idx = byRel.get(exportRoot ? `${exportRoot}/index.csv` : 'index.csv')
      indexCache.set(exportRoot, idx ? parseExportIndex(idx.text) : null)
    }
    return { dayFirst: env.dayFirst, panelTitles: env.panelTitles, exportSummaries: indexCache.get(exportRoot) ?? null }
  }

  const add = (spec: ItemSpec, relPath: string, dirParts: string[], ctx: ParseContext): void => {
    const files = specFiles(spec)
    for (const f of files) used.add(f)
    const read = files.map((f) => byRel.get(f)!).filter(Boolean)
    const fileMap: Record<string, SourceFile | null> = {}
    for (const f of read) fileMap[f.rel] = f
    let info: PreviewInfo | null = null
    let skip: FormedItem['skip'] = null
    try {
      info = previewInfo(parseSpec(spec, fileMap, ctx))
    } catch {
      skip = { status: 'unreadable', reason: 'Notula couldn’t read this file' }
    }
    items.push({
      id: randomUUID(),
      spec,
      relPath,
      dirParts,
      hash: itemHash(read),
      size: read.reduce((n, f) => n + f.size, 0),
      info,
      skip,
      studySkip: null
    })
  }

  /** One file that broke detection becomes an unreadable row; the scan goes on. */
  const unreadable = (f: ScannedFile): void => {
    used.add(f.rel)
    items.push({ ...skipped(f, PLAN_COPY.unreadable, []), skip: { status: 'unreadable', reason: PLAN_COPY.unreadable } })
  }
  const safely = <T>(f: ScannedFile, fn: () => T): T | typeof FAILED => {
    try {
      return fn()
    } catch {
      unreadable(f)
      return FAILED
    }
  }

  // 1. Notula export notes, and the transcripts they name.
  const exportRoots = new Set<string>()
  const exportNotes = new Set<string>()
  const rootIsExport = EXPORT_ROOT.test(nameOf(scan.root.replace(/\\/g, '/').replace(/\/+$/, '')))
  if (preset === 'auto' || preset === 'notula-export') {
    for (const f of scan.files) {
      if (!/\.(md|markdown)$/i.test(f.name)) continue
      const isExport = safely(f, () => isNotulaExport(f.text))
      if (isExport !== true) continue
      const root = exportRootOf(f.rel, rootIsExport)
      exportRoots.add(root)
      exportNotes.add(f.rel)
      const tPath = safely(f, () => exportTranscriptPath(f.text))
      if (tPath === FAILED) continue
      // From the export root; else beside the note (a Markdown export copied into another folder).
      const tRel = tPath ? (root ? `${root}/${tPath}` : tPath).replace(/\\/g, '/') : null
      const beside = tPath ? `${dirOf(f.rel) ? `${dirOf(f.rel)}/` : ''}${nameOf(tPath.replace(/\\/g, '/'))}` : null
      const spec: ItemSpec = { format: 'notula-export', files: { main: f.rel }, exportRoot: root }
      if (tRel && byRel.has(tRel) && !used.has(tRel)) spec.files.transcript = tRel
      else if (beside && EXPORT_TRANSCRIPT.test(beside) && byRel.has(beside) && !used.has(beside)) spec.files.transcript = beside
      add(spec, f.rel, [], ctxFor(root))
    }
    // Export folders by name, even with no note found yet.
    for (const d of scan.dirs) if (EXPORT_ROOT.test(nameOf(d))) exportRoots.add(d)
    if (rootIsExport) exportRoots.add('')
  }
  /** A Markdown export's `<name>.transcript.md` beside its note: part of the export, never a note of its own. */
  const exportTranscriptOf = (rel: string): boolean =>
    EXPORT_TRANSCRIPT.test(rel) && ['md', 'markdown'].some((ext) => exportNotes.has(`${rel.replace(EXPORT_TRANSCRIPT, '')}.${ext}`))
  const inExportRoot = (rel: string): string | null => {
    for (const r of exportRoots) if (r === '' || rel === r || rel.startsWith(`${r}/`)) return r
    return null
  }

  // 2. Study lessons: `courses/<course>/<lesson>/`, or `<course>/<lesson>/` and `<lesson>/` when the
  // root is `courses/` or a course. Never under `sessions/`, or the vault's `docs/` and `scripts/`.
  const lessonPlace = (dir: string): boolean => {
    const parts = dir ? dir.split('/') : []
    if (parts.some((p) => p.toLowerCase() === 'sessions')) return false
    const ci = parts.indexOf('courses')
    if (ci >= 0) return parts.length === ci + 3
    if (parts.length && /^(docs|scripts)$/i.test(parts[0]!)) return false
    return parts.length <= 2
  }
  const lessonDirs = new Map<string, Partial<Record<'transcription' | 'summary' | 'hyperlinks', string>>>()
  if (preset === 'auto' || preset === 'study-vault') {
    for (const f of scan.files) {
      const role = STUDY_FILES[f.name.toLowerCase()]
      if (!role || used.has(f.rel)) continue
      const dir = dirOf(f.rel)
      const folder = dir ? nameOf(dir) : nameOf(scan.root.replace(/\\/g, '/'))
      if (!SLUG.test(folder) || inExportRoot(f.rel) !== null || !lessonPlace(dir)) continue
      const entry = lessonDirs.get(dir) ?? {}
      entry[role] = f.rel
      lessonDirs.set(dir, entry)
    }
  }
  const studyVault = preset === 'study-vault' || lessonDirs.size > 0

  // The study layout: the base that holds the courses (`courses/`, or the root itself).
  const coursesBase = (rel: string): { base: string; course: string | null } => {
    const parts = rel.split('/')
    const ci = parts.indexOf('courses')
    if (ci >= 0) return { base: parts.slice(0, ci + 1).join('/'), course: parts[ci + 1] ?? null }
    return { base: '', course: null }
  }
  const courseName = (courseDir: string, slug: string): string => {
    const readme = byRel.get(courseDir ? `${courseDir}/README.md` : 'README.md')
    if (!readme) return humanize(slug)
    try {
      // The README's first level-one heading.
      for (const l of splitFrontMatter(readme.text).body.split(/\r?\n/)) {
        const h = l.startsWith('# ') || l.startsWith('#\t') ? atxHeading(l) : null
        if (h?.level === 1 && h.text) return h.text.trim()
      }
    } catch {
      // An unreadable README names nothing.
    }
    return humanize(slug)
  }
  const rootName = nameOf(scan.root.replace(/\\/g, '/').replace(/\/+$/, ''))

  for (const [dir, roles] of [...lessonDirs].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const lessonFolder = dir ? nameOf(dir) : rootName
    const parent = dirOf(dir)
    const courseSlug = dir ? (parent ? nameOf(parent) : rootName) : rootName
    const underVideos = courseSlug.toLowerCase() === 'videos'
    const course = underVideos ? 'Videos' : courseName(dir ? parent : '', courseSlug)
    const spec: ItemSpec = { format: 'study-lesson', files: { ...roles }, lessonFolder, course, underVideos }
    add(spec, dir || '.', [], ctxFor(null))
  }

  // Study skip list.
  const studyReason = (rel: string): string | null => {
    if (!studyVault) return null
    const { base, course } = coursesBase(rel)
    const parts = rel.split('/')
    const name = nameOf(rel)
    const lessonDir = dirOf(rel)
    if (lessonDirs.has(lessonDir)) return PLAN_COPY.lessonOther
    if (/^curriculum\.md$/i.test(name)) return PLAN_COPY.curriculum
    if (parts.includes('sessions')) return PLAN_COPY.sessions
    const top = base ? dirOf(base) : ''
    const relTop = top ? rel.slice(top.length + 1) : rel
    if (/^(dashboard|readme)\.md$/i.test(relTop) || /^(docs|scripts)\//i.test(relTop)) return PLAN_COPY.notLesson
    if (/^readme\.md$/i.test(name) && (course !== null && dirOf(rel) === `${base}/${course}`)) return PLAN_COPY.courseReadme
    if (/^readme\.md$/i.test(name) && !base && [...lessonDirs.keys()].some((d) => dirOf(d) === dirOf(rel))) return PLAN_COPY.courseReadme
    return null
  }

  // Catalogs (CURRICULUM.md) for the done screen, per course.
  if (studyVault) {
    for (const f of scan.files) {
      if (!/^curriculum\.md$/i.test(f.name)) continue
      const dir = dirOf(f.rel)
      const slug = dir ? nameOf(dir) : rootName
      catalogs.push({ course: courseName(dir, slug), relPath: f.rel })
    }
  }

  // 3–4. Transcripts paired by name, then lone transcripts.
  const pairs = new Map<string, string>()
  for (const f of scan.files) {
    if (used.has(f.rel)) continue
    const m = PAIR_SUFFIX.exec(f.name)
    if (!m) continue
    const dir = dirOf(f.rel)
    for (const ext of ['md', 'markdown']) {
      const note = dir ? `${dir}/${m[1]}.${ext}` : `${m[1]}.${ext}`
      if (byRel.has(note) && !used.has(note)) {
        pairs.set(note, f.rel)
        used.add(f.rel)
        break
      }
    }
  }

  // 5–6. Every other file.
  for (const f of scan.files) {
    if (used.has(f.rel)) continue
    const exportRoot = inExportRoot(f.rel)
    const dirParts = dirOf(f.rel) ? dirOf(f.rel).split('/') : []
    const isTxt = /\.txt$/i.test(f.name)
    if (exportRoot !== null && (dirOf(f.rel) === exportRoot || f.rel.startsWith(exportRoot ? `${exportRoot}/database/` : 'database/') || exportTranscriptOf(f.rel))) {
      items.push(skipped(f, PLAN_COPY.exportPart, dirParts))
      used.add(f.rel)
      continue
    }
    if (!/.(md|markdown|txt)$/i.test(f.name)) {
      items.push(skipped(f, PLAN_COPY.txt, dirParts))
      continue
    }
    const study = studyReason(f.rel)
    const transcriptLike = safely(f, () => looksLikeTranscript(f.text))
    if (transcriptLike === FAILED) continue
    if (transcriptLike && (!isTxt || exportRoot !== null)) {
      add({ format: 'transcript-copy', files: { main: f.rel } }, f.rel, dirParts, ctxFor(null))
      if (study) items[items.length - 1]!.studySkip = study
      continue
    }
    if (isTxt) {
      items.push(skipped(f, PLAN_COPY.txt, dirParts))
      continue
    }
    const fm = safely(f, () => splitFrontMatter(f.text))
    if (fm === FAILED) continue
    const format: ImportFormat =
      preset === 'plain' ? 'plain' : preset === 'obsidian' || fm.fm || fm.tooLarge || f.text.includes('[[') || scan.obsidian ? 'obsidian' : 'plain'
    const spec: ItemSpec = { format, files: { main: f.rel } }
    const pair = pairs.get(f.rel)
    if (pair) spec.files.transcript = pair
    add(spec, f.rel, studyDirParts(dirParts, studyVault, (slug, dir) => courseName(dir, slug)), ctxFor(null))
    if (study) items[items.length - 1]!.studySkip = study
  }

  for (const s of scan.skipped) items.push({ id: randomUUID(), spec: null, relPath: s.rel, dirParts: [], hash: '', size: 0, info: null, skip: { status: 'skipped', reason: s.reason }, studySkip: null })
  return { items, studyVault, catalogs }
}

/** In a study vault, other files mirror under their course's name, not under `courses/`. */
function studyDirParts(parts: string[], studyVault: boolean, name: (slug: string, dir: string) => string): string[] {
  if (!studyVault) return parts
  const ci = parts.indexOf('courses')
  if (ci < 0 || !parts[ci + 1]) return parts
  const slug = parts[ci + 1]!
  return [name(slug, parts.slice(0, ci + 2).join('/')), ...parts.slice(ci + 2)]
}

const FAILED = Symbol('failed')

function skipped(f: ScannedFile, reason: string, dirParts: string[]): FormedItem {
  return { id: randomUUID(), spec: null, relPath: f.rel, dirParts, hash: '', size: f.size, info: null, skip: { status: 'skipped', reason }, studySkip: null }
}

// ---------- folders ----------

export interface FolderLookup {
  /** Existing folders: id, title and parent. */
  folders: { id: string; title: string; parent_id: string | null }[]
}

export function findFolder(lookup: FolderLookup, title: string, parentId: string | null): { id: string; title: string } | null {
  const want = title.trim().toLowerCase()
  const f = lookup.folders.find((x) => x.parent_id === parentId && x.title.trim().toLowerCase() === want)
  return f ? { id: f.id, title: f.title } : null
}

/** The item's target folder paths (titles, at most two levels) and a flattened note. */
export function folderPaths(
  item: FormedItem,
  mode: ImportFolderMode,
  labels: { single: string; videos: string[] }
): { paths: string[][]; flattened: string | null } {
  if (mode === 'none' || !item.spec) return { paths: [], flattened: null }
  const spec = item.spec
  if (spec.format === 'study-lesson') {
    const course = spec.underVideos ? labels.videos : [spec.course ?? 'Imported']
    return { paths: [mode === 'single' ? [labels.single, course[course.length - 1]!] : course], flattened: null }
  }
  if (spec.format === 'notula-export') {
    if (mode === 'single') return { paths: [[labels.single]], flattened: null }
    return { paths: (item.info?.exportFolders ?? []).slice(0, 20).map((n) => [n]), flattened: null }
  }
  if (spec.exportRoot !== undefined && spec.exportRoot !== null) return { paths: mode === 'single' ? [[labels.single]] : [], flattened: null }
  const parts = item.dirParts
  if (mode === 'single') {
    return { paths: [[labels.single, ...parts.slice(0, 1)]], flattened: parts.length > 1 ? parts.join('/') : null }
  }
  if (!parts.length) return { paths: [], flattened: null }
  return { paths: [parts.slice(0, 2)], flattened: parts.length > 2 ? parts.join('/') : null }
}

/** True when every level of the path exists. */
export function pathExists(lookup: FolderLookup, path: string[]): boolean {
  let parent: string | null = null
  for (const title of path) {
    const f = findFolder(lookup, title, parent)
    if (!f) return false
    parent = f.id
  }
  return true
}

// ---------- statuses ----------

export interface StatusEnv {
  root: string
  matches: ImportMatches
  lookup: FolderLookup
  /** `title-lower|YYYY-MM-DD` of existing notes. */
  titleDates: Set<string>
  labels: { single: string; videos: string[] }
  platform?: NodeJS.Platform
}

export interface Row extends ImportPreviewRow {
  /** Internal: the target paths and the stored key. */
  paths: string[][]
  sourceKey: string
}

export function localDateKey(iso: string): string {
  const d = new Date(iso)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const FORMAT_RANK: Record<ImportRowStatus, number> = {
  new: 0,
  changed: 1,
  duplicate: 2,
  'in-trash': 3,
  'already-imported': 4,
  'already-in-notula': 5,
  skipped: 6,
  unreadable: 7
}

export function computeRows(formed: Formed, options: ImportOptions, env: StatusEnv): Row[] {
  const byKey = new Map<string, ImportMatches['items']>()
  for (const m of env.matches.items) {
    const list = byKey.get(m.source_key) ?? []
    list.push(m)
    byKey.set(m.source_key, list)
  }
  const exportState = new Map(env.matches.exportNotes.map((e) => [e.id.toLowerCase(), e.state]))
  const firstByHash = new Map<string, string>()
  const rows: Row[] = []

  for (const it of formed.items) {
    const key = sourceKey(env.root, it.relPath, env.platform)
    const base = {
      itemId: it.id,
      relPath: it.relPath,
      format: it.spec?.format ?? ('plain' as ImportFormat),
      title: it.info?.title ?? it.relPath.slice(it.relPath.lastIndexOf('/') + 1),
      titleOrigin: it.info?.titleOrigin ?? ('file-name' as ImportTitleOrigin),
      createdAt: it.info?.createdAt ?? new Date(0).toISOString(),
      dateOrigin: it.info?.dateOrigin ?? ('file-time' as ImportDateOrigin),
      contents: it.info?.contents ?? { noteText: false, summaries: 0, transcript: null, sources: 0, references: 0 },
      sourceKey: key
    }
    const skipRow = (status: 'skipped' | 'unreadable', reason: string): Row => ({
      ...base,
      folderPath: [],
      folderExists: false,
      paths: [],
      status,
      detail: reason,
      warnings: [],
      ticked: false,
      tickable: false
    })
    if (it.skip || !it.info || !it.spec) {
      rows.push(skipRow(it.skip?.status ?? 'unreadable', it.skip?.reason ?? 'Notula couldn’t read this file'))
      continue
    }
    if (it.studySkip && !options.includeOtherFiles) {
      rows.push(skipRow('skipped', it.studySkip))
      continue
    }
    if (it.info.trashed && options.trash === 'skip') {
      rows.push(skipRow('skipped', PLAN_COPY.exportTrash))
      continue
    }

    const warnings = [...it.info.warnings]
    const { paths, flattened } = folderPaths(it, options.folderMode, env.labels)
    if (flattened) warnings.push(PLAN_COPY.flattened(flattened))
    const exists = paths.length > 0 && paths.every((p) => pathExists(env.lookup, p))
    for (const p of paths) if (pathExists(env.lookup, p)) warnings.push(PLAN_COPY.existingFolder(p[p.length - 1]!))
    if (env.titleDates.has(`${it.info.title.trim().toLowerCase()}|${localDateKey(it.info.createdAt)}`)) warnings.push(PLAN_COPY.sameDate)

    let status: ImportRowStatus = 'new'
    let detail: string | null = null
    let ticked = true
    let tickable = true
    const earlier = byKey.get(key) ?? []
    const same = earlier.find((m) => m.content_hash === it.hash)
    const exportId = it.info.exportId
    if (same && same.note_state === 'live') {
      status = 'already-imported'
      detail = PLAN_COPY.alreadyImported
      ticked = false
      tickable = false
    } else if (same && same.note_state === 'trashed') {
      status = 'in-trash'
      detail = PLAN_COPY.restore
      ticked = false
    } else if (same && same.note_state === 'purged') {
      warnings.push(PLAN_COPY.purged)
      ticked = false
    } else if (earlier.length) {
      status = 'changed'
      ticked = false
    } else if (exportId && exportState.has(exportId)) {
      const st = exportState.get(exportId)!
      status = st === 'live' ? 'already-in-notula' : 'in-trash'
      detail = st === 'live' ? null : PLAN_COPY.restore
      ticked = false
      tickable = false
    } else {
      const other = firstByHash.get(it.hash)
      const elsewhere = env.matches.items.find((m) => m.content_hash === it.hash && m.source_key !== key && m.note_state !== 'purged')
      if (other || elsewhere) {
        status = 'duplicate'
        detail = other ?? elsewhere!.rel_path
        ticked = false
      }
    }
    if (status === 'new' && !firstByHash.has(it.hash)) firstByHash.set(it.hash, it.relPath)

    const folderPath = paths[0] ?? []
    rows.push({ ...base, folderPath, folderExists: exists, paths, status, detail, warnings, ticked, tickable })
  }

  return rows.sort((a, b) => {
    const fa = a.folderPath.join('/').toLowerCase()
    const fb = b.folderPath.join('/').toLowerCase()
    if (fa !== fb) return fa < fb ? -1 : 1
    if (FORMAT_RANK[a.status] !== FORMAT_RANK[b.status] && (a.status === 'skipped' || b.status === 'skipped')) return FORMAT_RANK[a.status] - FORMAT_RANK[b.status]
    return a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0
  })
}

export function summarize(rows: Row[], lookup: FolderLookup): ImportPreview['summary'] {
  const ticked = rows.filter((r) => r.ticked)
  const newPaths = new Set<string>()
  const oldPaths = new Set<string>()
  for (const r of ticked) {
    for (const p of r.paths) {
      for (let i = 1; i <= p.length; i++) {
        const sub = p.slice(0, i)
        const k = sub.join('\u0000').toLowerCase()
        if (pathExists(lookup, sub)) oldPaths.add(k)
        else newPaths.add(k)
      }
    }
  }
  return {
    notes: ticked.length,
    summaries: ticked.reduce((n, r) => n + r.contents.summaries, 0),
    transcripts: ticked.filter((r) => r.contents.transcript !== null).length,
    newFolders: newPaths.size,
    existingFolders: oldPaths.size,
    skipped: rows.filter((r) => r.status === 'skipped' || r.status === 'unreadable').length,
    alreadyInNotula: rows.filter((r) => r.status === 'already-imported' || r.status === 'already-in-notula').length
  }
}
