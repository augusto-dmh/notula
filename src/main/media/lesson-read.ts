// SPDX-License-Identifier: Apache-2.0
// The window read, the parsing half. The reader walks a course window's page (one UI Automation
// fetch by handle) and sends its Text, Button, Group and Hyperlink nodes in document order as
// `[depth, type, name]`. The notula-media worker parses them here and passes on only the lesson
// fields; every other name is dropped there and never reaches main or a log. No Electron and
// type-only imports, so the dev check (scripts/dev/lesson-read-check.mjs) loads it directly.
//
// Readers match accessible names and tree structure, never CSS classes or generated ids:
// - Circle: the lesson heading is the Text right after the transcript button; the course is the
//   top bar's first Text, next to the previous and next lesson buttons; the sidebar is a flat
//   list of sections (a Text, then a Text `<k> aulas`), each followed by its lesson rows, a
//   Button each except the current lesson, which is a Group.
// - Hubla: the `breadcrumb` Group's links `<product> › <module> › <lesson>`, the Text
//   `<module> • Conteúdo <n>`, and the player Group `Video Player - <lesson>`.
// - Generic: exactly one player Group named `Video Player - <title>`.

import type { LessonRead, LessonReadSite } from '../../shared/types/sources'

export type ReadNodeType = 'Text' | 'Button' | 'Group' | 'Hyperlink'

export interface ReadNode {
  depth: number
  type: ReadNodeType
  name: string
}

const TYPES: ReadonlySet<string> = new Set<ReadNodeType>(['Text', 'Button', 'Group', 'Hyperlink'])
const MAX_NODES = 4_000
const MAX_FIELD = 200
const MAX_CRUMBS = 6

const TRANSCRIPT = /^(?:(?:mostrar|ocultar) transcrição|(?:show|hide) transcript)$/i
const PREV_LESSON = /^(?:aula anterior|previous lesson)$/i
const NEXT_LESSON = /^(?:próxim[oa] aula|proxim[oa] aula|next lesson)$/i
const SECTION_COUNT = /^\d+\s+(?:aulas?|lessons?)$/i
const PLAYER = /^video player\s*[-‐‑‒–—―]\s*(.+)$/i
const HUBLA_CONTENT = /^(.+?)\s*[•·]\s*conte[uú]do\s+(\d{1,4})$/i
const BREADCRUMB = /^breadcrumbs?$/i
const SEPARATOR = /^[\s›»>/|·•-]*$/

function clean(s: string): string {
  return s.normalize('NFC').replace(/\s+/g, ' ').trim()
}

function field(s: string | null | undefined): string | null {
  const c = s ? clean(s).slice(0, MAX_FIELD) : ''
  return c || null
}

/** The reader's `nodes` → nodes; null when there is no page (no Document in the window). */
export function nodesFromRecord(raw: unknown): ReadNode[] | null {
  if (!Array.isArray(raw)) return null
  const out: ReadNode[] = []
  for (const x of raw.slice(0, MAX_NODES)) {
    if (!Array.isArray(x) || x.length < 3) continue
    const [depth, type, name] = x as unknown[]
    if (typeof depth !== 'number' || !Number.isInteger(depth) || depth < 0 || typeof type !== 'string' || !TYPES.has(type) || typeof name !== 'string') continue
    out.push({ depth, type: type as ReadNodeType, name: clean(name.slice(0, 400)) })
  }
  return out
}

/** The index past the last descendant of `nodes[i]`. */
function subtreeEnd(nodes: readonly ReadNode[], i: number): number {
  const d = nodes[i]?.depth ?? 0
  let j = i + 1
  while (j < nodes.length && (nodes[j]?.depth ?? 0) > d) j++
  return j
}

function firstText(nodes: readonly ReadNode[], from: number, to: number, skip?: RegExp): number {
  for (let j = Math.max(0, from); j < Math.min(to, nodes.length); j++) {
    const n = nodes[j]
    if (n && n.type === 'Text' && n.name && !(skip && skip.test(n.name))) return j
  }
  return -1
}

/** A Group's label: its own name, else its first Text. */
function groupLabel(nodes: readonly ReadNode[], i: number): string | null {
  const n = nodes[i]
  if (!n) return null
  if (n.name) return field(n.name)
  const t = firstText(nodes, i + 1, subtreeEnd(nodes, i))
  return t >= 0 ? field(nodes[t]?.name) : null
}

function empty(r: LessonRead): boolean {
  return !r.heading && !r.course && !r.breadcrumb.length && !r.section && !r.item
}

// ---------- Circle ----------

function circleHeading(nodes: readonly ReadNode[]): string | null {
  const b = nodes.findIndex((n) => n.type === 'Button' && TRANSCRIPT.test(n.name))
  if (b < 0) return null
  const t = firstText(nodes, b + 1, b + 20, TRANSCRIPT)
  return t >= 0 ? field(nodes[t]?.name) : null
}

function circleCourse(nodes: readonly ReadNode[]): string | null {
  const prev = nodes.findIndex((n) => n.type === 'Button' && PREV_LESSON.test(n.name))
  const next = nodes.findIndex((n) => n.type === 'Button' && NEXT_LESSON.test(n.name))
  const found = [prev, next].filter((i) => i >= 0)
  if (!found.length) return null
  const lo = Math.min(...found)
  const hi = Math.max(...found)
  // The bar: the nodes around the two buttons that stay inside their shared container.
  let dc = Infinity
  for (let j = lo; j <= hi; j++) dc = Math.min(dc, nodes[j]?.depth ?? 0)
  let start = lo
  while (start > 0 && lo - start < 15 && (nodes[start - 1]?.depth ?? -1) >= dc) start--
  let end = hi
  while (end + 1 < nodes.length && end - hi < 15 && (nodes[end + 1]?.depth ?? -1) >= dc) end++
  const skip = /^(?:aula anterior|previous lesson|próxim[oa] aula|proxim[oa] aula|next lesson)$/i
  const t = firstText(nodes, start, end + 1, skip)
  return t >= 0 ? field(nodes[t]?.name) : null
}

/** The current row of the sidebar: its section, position in the section, and title. */
function circleItem(nodes: readonly ReadNode[]): { section: string | null; item: LessonRead['item'] } {
  const headers: { at: number; title: string | null }[] = []
  for (let j = 1; j < nodes.length; j++) {
    const n = nodes[j]
    if (!n || n.type !== 'Text' || !SECTION_COUNT.test(n.name)) continue
    const t = nodes[j - 1]
    headers.push({ at: j, title: t && t.type === 'Text' ? field(t.name) : null })
  }
  for (let h = 0; h < headers.length; h++) {
    const header = headers[h]
    if (!header) continue
    const from = header.at + 1
    const to = (headers[h + 1]?.at ?? nodes.length + 1) - 1
    // The rows sit at the depth of the section's lesson buttons (a single current row: its Group).
    let rowDepth = -1
    for (let j = from; j < to && rowDepth < 0; j++) if (nodes[j]?.type === 'Button') rowDepth = nodes[j]?.depth ?? -1
    if (rowDepth < 0) for (let j = from; j < to && rowDepth < 0; j++) if (nodes[j]?.type === 'Group') rowDepth = nodes[j]?.depth ?? -1
    if (rowDepth < 0) continue
    let index = 0
    for (let j = from; j < to; j++) {
      const n = nodes[j]
      if (!n || n.depth !== rowDepth || (n.type !== 'Button' && n.type !== 'Group')) continue
      index++
      if (n.type === 'Group') return { section: header.title, item: { label: groupLabel(nodes, j), index } }
    }
  }
  return { section: null, item: null }
}

function readCircle(nodes: readonly ReadNode[]): LessonRead {
  const { section, item } = circleItem(nodes)
  return { heading: circleHeading(nodes), course: circleCourse(nodes), breadcrumb: [], section, item }
}

// ---------- Hubla ----------

function breadcrumb(nodes: readonly ReadNode[]): string[] {
  const g = nodes.findIndex((n) => n.type === 'Group' && BREADCRUMB.test(n.name))
  if (g < 0) return []
  const end = subtreeEnd(nodes, g)
  const out: string[] = []
  let j = g + 1
  while (j < end && out.length < MAX_CRUMBS) {
    const n = nodes[j]
    if (!n) break
    if (n.type === 'Hyperlink') {
      const label = field(n.name) ?? groupLabel(nodes, j)
      if (label && out.at(-1) !== label) out.push(label)
      j = subtreeEnd(nodes, j)
      continue
    }
    if (n.type === 'Text' && n.name && !SEPARATOR.test(n.name)) {
      const label = field(n.name)
      if (label && out.at(-1) !== label) out.push(label)
    }
    j++
  }
  return out
}

function playerTitles(nodes: readonly ReadNode[]): string[] {
  const out = new Set<string>()
  for (const n of nodes) {
    if (n.type !== 'Group') continue
    const m = PLAYER.exec(n.name)
    const t = m ? field(m[1]) : null
    if (t) out.add(t)
  }
  return [...out]
}

function readHubla(nodes: readonly ReadNode[]): LessonRead {
  const crumbs = breadcrumb(nodes)
  let section: string | null = null
  let index: number | null = null
  for (const n of nodes) {
    if (n.type !== 'Text') continue
    const m = HUBLA_CONTENT.exec(n.name)
    if (!m) continue
    section = field(m[1])
    index = Number(m[2])
    break
  }
  const heading = playerTitles(nodes)[0] ?? (crumbs.length >= 2 ? (crumbs.at(-1) ?? null) : null)
  return {
    heading,
    course: crumbs.length >= 2 ? (crumbs[0] ?? null) : null,
    breadcrumb: crumbs,
    section: section ?? (crumbs.length >= 3 ? (crumbs[1] ?? null) : null),
    item: index !== null ? { label: heading, index } : null
  }
}

// ---------- generic ----------

function readGeneric(nodes: readonly ReadNode[]): LessonRead {
  const titles = playerTitles(nodes)
  return { heading: titles.length === 1 ? (titles[0] ?? null) : null, course: null, breadcrumb: [], section: null, item: null }
}

/** A first read under this many nodes may be a page Chromium is still building. */
const SPARSE_NODES = 20
/** A first read this large is the whole page: a second one won't find what the parser didn't. */
const FULL_NODES = 400

/**
 * After the first read: read once more when the page may still be building (no page yet, few
 * nodes, or no heading among what was found), not when it already gave a heading or was a
 * full page with nothing the site's parser knows.
 */
export function readAgain(nodes: readonly ReadNode[] | null, read: LessonRead | null): boolean {
  if (!nodes) return true
  if (read) return !read.heading || nodes.length < SPARSE_NODES
  return nodes.length < FULL_NODES
}

/** The lesson fields a site's page shows; null when it shows none (a sparse or unknown page). */
export function parseLessonRead(site: LessonReadSite, nodes: readonly ReadNode[]): LessonRead | null {
  const r = site === 'circle' ? readCircle(nodes) : site === 'hubla' ? readHubla(nodes) : readGeneric(nodes)
  return empty(r) ? null : r
}
