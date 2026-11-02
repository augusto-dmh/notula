// SPDX-License-Identifier: Apache-2.0
// A lesson list from a study-vault course folder (`courses/<course>/`), read only, never written.
//
// - Each `<n>-<slug>/` folder is item n. Its title is `Transcription.md`'s `Meeting Title:` text
//   after the last ` - Aula <n> - `, else after the last ` - `, else the whole text; with no such
//   line, the slug. Its URL is `Hyperlinks.md`'s `Class - <url>` line when that is a lesson URL,
//   not a course root.
// - An outline the importer recognizes (`CURRICULUM.md`) wins for order and titles; the folders
//   add their URLs by number, and the numbers the outline lacks follow it.
// - Numbers repeated in the vault (two `28-…` folders) are kept as they are and counted, for
//   Needs a lesson.
// The parsing half is pure and erasable TypeScript: `scripts/dev/catalog-parse.mjs` runs it on
// fixtures. Logs carry counts only.

import { randomUUID } from 'node:crypto'
import { open, readdir, readFile, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { ParsedCatalog, ParsedCatalogItem } from './catalog'
import { parseCatalog } from './catalog'
import { courseUrl } from './recognize'

/** One lesson folder as read from disk (the files' heads; null when missing). */
export interface VaultFolder {
  name: string
  transcription: string | null
  hyperlinks: string | null
}

export interface VaultList {
  items: ParsedCatalogItem[]
  /** Numbers two or more folders share (kept as they are). */
  repeated: number[]
  /** An outline gave the order and titles. */
  outline: boolean
}

const LESSON_FOLDER = /^(\d{1,5})-(.+)$/
const MEETING_TITLE = /^[ \t>*_-]*(?:\*\*|__)?Meeting Title(?:\*\*|__)?\s*:(?:\*\*|__)?[ \t]*(.+?)[ \t]*$/im
const CLASS_LINE = /^[ \t>*_-]*(?:\*\*|__)?Class(?:\*\*|__)?[ \t]*[-–—:][ \t]*(.+?)[ \t]*$/gim
const OUTLINE = /^curriculum\.md$/i
const MAX_TITLE = 1_000
/** Only a file's head is read: the title and the links sit at its top. */
const HEAD_BYTES = 64 * 1024
const MAX_FOLDERS = 2_000
/** The same cap as a catalog file. */
const MAX_OUTLINE_BYTES = 2 * 1024 * 1024

/** The lesson title in a `Meeting Title:` line, or null without one. */
export function meetingTitle(text: string, n: number): string | null {
  const m = MEETING_TITLE.exec(text)
  const raw = m?.[1]?.replace(/\*\*|__/g, '').trim()
  if (!raw) return null
  const aula = new RegExp(`\\s-\\s(?:aula|lesson|class)\\s*0*${n}\\s-\\s`, 'gi')
  let cut = -1
  for (let a = aula.exec(raw); a; a = aula.exec(raw)) cut = a.index + a[0].length
  if (cut < 0) {
    const dash = raw.lastIndexOf(' - ')
    if (dash >= 0) cut = dash + 3
  }
  const title = (cut >= 0 ? raw.slice(cut) : raw).trim()
  return title ? title.slice(0, MAX_TITLE) : null
}

/** `Hyperlinks.md`'s `Class - <url>` link when it is a lesson URL, not a course root. */
export function classUrl(text: string): string | null {
  CLASS_LINE.lastIndex = 0
  for (let m = CLASS_LINE.exec(text); m; m = CLASS_LINE.exec(text)) {
    const body = m[1] ?? ''
    const link = /\]\((https?:\/\/[^)\s]+)\)/i.exec(body)?.[1] ?? /<?(https?:\/\/[^\s<>]+)>?/i.exec(body)?.[1]
    const u = link ? courseUrl(link.replace(/[.,;]+$/, '')) : null
    if (u?.lesson) return u.url
  }
  return null
}

/** `event-sourcing-basics` → `Event sourcing basics`. */
export function slugTitle(slug: string): string {
  const t = slug.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim()
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : slug
}

/** The lesson list of a course folder's lesson folders, and its outline when there is one. */
export function vaultList(folders: readonly VaultFolder[], outline: string | null): VaultList {
  const rows: (ParsedCatalogItem & { order: number })[] = []
  for (const f of folders) {
    const m = LESSON_FOLDER.exec(f.name)
    if (!m) continue
    const n = Number(m[1])
    const title = (f.transcription ? meetingTitle(f.transcription, n) : null) ?? slugTitle(m[2] ?? '')
    const url = f.hyperlinks ? classUrl(f.hyperlinks) : null
    const parsed = url ? courseUrl(url) : null
    rows.push({ number: n, section: null, title, url, canonical_key: parsed?.canonicalKey ?? null, duration_ms: null, order: rows.length })
  }
  rows.sort((a, b) => (a.number ?? 0) - (b.number ?? 0) || a.order - b.order)
  const counts = new Map<number, number>()
  for (const r of rows) counts.set(r.number ?? 0, (counts.get(r.number ?? 0) ?? 0) + 1)
  const repeated = [...counts].filter(([, c]) => c > 1).map(([n]) => n)
  const strip = ({ order: _order, ...it }: ParsedCatalogItem & { order: number }): ParsedCatalogItem => it

  const parsedOutline: ParsedCatalog | null = outline ? parseCatalog(outline) : null
  if (!parsedOutline || parsedOutline.items.length === 0) return { items: rows.map(strip), repeated, outline: false }

  // The outline's order and titles; the folders' URLs by number; the rest after it.
  const byNumber = new Map<number, (typeof rows)[number]>()
  for (const r of rows) if (r.number !== null && !byNumber.has(r.number)) byNumber.set(r.number, r)
  const used = new Set<number>()
  const items: ParsedCatalogItem[] = parsedOutline.items.map((it) => {
    const f = it.number !== null ? byNumber.get(it.number) : undefined
    if (f && it.number !== null) used.add(it.number)
    return f && !it.url ? { ...it, url: f.url, canonical_key: f.canonical_key } : it
  })
  for (const r of rows) if (r.number === null || !used.has(r.number)) items.push(strip(r))
  return { items, repeated, outline: true }
}

// ---------- reading a folder ----------

async function head(path: string): Promise<string | null> {
  let fh: Awaited<ReturnType<typeof open>> | null = null
  try {
    fh = await open(path, 'r')
    const buf = Buffer.alloc(HEAD_BYTES)
    const { bytesRead } = await fh.read(buf, 0, HEAD_BYTES, 0)
    return buf.subarray(0, bytesRead).toString('utf8')
  } catch {
    return null
  } finally {
    await fh?.close().catch(() => undefined)
  }
}

/** Reads one course folder (read only) into its lesson list. */
export async function readVaultCourse(folder: string): Promise<VaultList> {
  const entries = await readdir(folder, { withFileTypes: true })
  const folders: VaultFolder[] = []
  let outline: string | null = null
  for (const e of entries) {
    if (e.isFile() && OUTLINE.test(e.name)) {
      const info = await stat(join(folder, e.name)).catch(() => null)
      if (info && info.size <= MAX_OUTLINE_BYTES) outline = await readFile(join(folder, e.name), 'utf8').catch(() => null)
      continue
    }
    if (!e.isDirectory() || !LESSON_FOLDER.test(e.name) || folders.length >= MAX_FOLDERS) continue
    const dir = join(folder, e.name)
    const files = await readdir(dir).catch(() => [] as string[])
    const find = (name: string): string | null => files.find((f) => f.toLowerCase() === name) ?? null
    const t = find('transcription.md')
    const h = find('hyperlinks.md')
    folders.push({ name: e.name, transcription: t ? await head(join(dir, t)) : null, hyperlinks: h ? await head(join(dir, h)) : null })
  }
  return vaultList(folders, outline)
}

// ---------- handles ----------

/** Course folders main handed out, by handle. */
const vaultFolders = new Map<string, string>()

/** A handle `sources:add-course` accepts as `{kind: 'vault', handle}` for this course folder. */
export function vaultFolderHandle(path: string): string {
  for (const [h, p] of vaultFolders) if (p === path) return h
  const handle = randomUUID()
  vaultFolders.set(handle, path)
  return handle
}

/**
 * The course folder of a handle: one `vaultFolderHandle` gave, or the importer's outline file
 * handle (`catalogFileHandle`, the done screen's Add as course), whose folder it is.
 */
export function vaultFolderOf(handle: string, catalogFile: (handle: string) => string | null): string | null {
  const folder = vaultFolders.get(handle)
  if (folder) return folder
  const file = catalogFile(handle)
  return file && OUTLINE.test(basename(file)) ? dirname(file) : null
}

// ---------- the Add course sheet's vault picker ----------

/** A course folder the picker offers. `folder` is its handle, for `{kind: 'vault', handle}`. */
export interface VaultCourse {
  folder: string
  title: string
  items: number
  urls: number
}

/** At most this many course folders are read for one listing. */
const MAX_COURSES = 200

async function hasLessonFolders(dir: string): Promise<boolean> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  return entries.some((e) => (e.isDirectory() && LESSON_FOLDER.test(e.name)) || (e.isFile() && OUTLINE.test(e.name)))
}

/**
 * The course folders under a picked folder: the folder itself when it is one, else its
 * `courses/` folder's children (a study vault's root), else its own children. Folders without
 * lessons are left out. Read only.
 */
export async function listVaultCourses(picked: string): Promise<VaultCourse[]> {
  let dirs: string[]
  if (await hasLessonFolders(picked)) {
    dirs = [picked]
  } else {
    const entries = await readdir(picked, { withFileTypes: true })
    const courses = entries.find((e) => e.isDirectory() && e.name.toLowerCase() === 'courses')
    const parent = courses ? join(picked, courses.name) : picked
    const children = courses ? await readdir(parent, { withFileTypes: true }) : entries
    dirs = children
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => join(parent, e.name))
      .sort((a, b) => basename(a).localeCompare(basename(b)))
      .slice(0, MAX_COURSES)
  }
  const out: VaultCourse[] = []
  for (const dir of dirs) {
    const v = await readVaultCourse(dir).catch(() => null)
    if (!v || v.items.length === 0) continue
    out.push({ folder: vaultFolderHandle(dir), title: slugTitle(basename(dir)), items: v.items.length, urls: v.items.filter((it) => it.url).length })
  }
  return out
}
