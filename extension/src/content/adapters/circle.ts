// SPDX-License-Identifier: Apache-2.0
// Circle lesson pages. Built from the page structure of a Circle course;
// still unverified on the real DOM.
//
// - Ids always come from the URL: `/c/<course-slug>/sections/<sectionId>/lessons/<lessonId>`.
// - Course title: `document.title` minus its last ` | <community>` part (keep a `[Curso]` prefix).
// - Section and lesson number: the sidebar's flat list, where a section is a title followed by a
//   "<k> aulas" count and lesson rows follow. Numbers are positions in that list, counted across
//   sections; nothing on the page shows them.
// - Lesson title: the large heading after the transcript button, skipping hidden templates; else
//   the current sidebar row's title.
// - Transcript: read when its panel is already open; otherwise only on the popup's button, which
//   clicks "Mostrar transcrição" once.
// Avoided on purpose: Tailwind classes and `base-ui-_r_*` / `_r_*_` ids, which change per render.

import type { ExtCue, ExtOutlineItem } from '../../../../src/shared/types/extension-protocol'
import { clean } from '../../lib/check'
import { CIRCLE_LESSON } from '../../lib/keys'
import { CAPS, type CaptionsReply, type PageFields, type TranscriptRead } from '../../lib/messages'
import { stampSeconds } from '../parse'
import { textTrackCues, visible, waitFor } from './common'
import type { Adapter, AdapterEnv, PageResult } from './types'

const COUNT = /^(\d+)\s+(aulas?|lessons?|lições|lecciones?|clases?)$/i
const DONE_SUFFIX = /\s+(Concluído|Concluida|Completed|Complete|Completado)$/i
const TRANSCRIPT_OPEN = /^(Mostrar transcrição|Show transcript|Mostrar transcripción)$/i
const TRANSCRIPT_CLOSE = /^(Ocultar transcrição|Hide transcript|Ocultar transcripción)$/i
const CUE = /^((?:\d{1,2}:)?\d{1,2}:\d{2})\s+([\s\S]+)$/
const TRANSCRIPT_WAIT_MS = 6_000

interface Row {
  el: Element
  title: string
  url: string | null
  section: string | null
  sectionIndex: number
  number: number
  interactive: boolean
}

function ids(): { slug: string; sectionId: string; lessonId: string } | null {
  const m = CIRCLE_LESSON.exec(location.pathname)
  return m ? { slug: m[1] ?? '', sectionId: m[2] ?? '', lessonId: m[3] ?? '' } : null
}

function ownText(el: Element): string {
  return clean(el.textContent, 400) ?? ''
}

/** The sidebar's flat list of section titles, counts and lesson rows, in page order. */
function sidebarRows(): Row[] {
  const sidebar = document.getElementById('circle-ai-left-sidebar-body')
  if (!sidebar) return []
  const counts = Array.from(sidebar.querySelectorAll('*')).filter(
    (el) => el.children.length === 0 && COUNT.test(ownText(el))
  )
  if (!counts.length) return []
  const list = commonList(counts)
  if (!list) return []
  // A section is a title then a "<k> aulas" count, as list items of their own, or
  // both inside one header item. Map each header item to its section title.
  const headers = new Map<Element, string | null>()
  for (const c of counts) {
    const item = itemOf(c, list)
    if (!item) continue
    const countText = ownText(c)
    if (ownText(item) === countText) {
      headers.set(item, null)
      const prev = item.previousElementSibling
      if (prev) headers.set(prev, clean(prev.textContent))
    } else {
      headers.set(item, clean(ownText(item).replace(countText, '')))
    }
  }
  const rows: Row[] = []
  let section: string | null = null
  let sectionIndex = 0
  for (const child of Array.from(list.children)) {
    if (headers.has(child)) {
      const t = headers.get(child)
      if (t) {
        section = t
        sectionIndex++
      }
      continue
    }
    const title = clean(ownText(child).replace(DONE_SUFFIX, ''))
    if (!title) continue
    const link = child instanceof HTMLAnchorElement ? child : child.querySelector<HTMLAnchorElement>('a[href*="/lessons/"]')
    rows.push({
      el: child,
      title,
      url: link?.href ?? null,
      section,
      sectionIndex,
      number: rows.length + 1,
      interactive: child.matches('a, button, [role="button"], [role="link"]') || !!child.querySelector('a, button')
    })
  }
  return rows.slice(0, CAPS.outline)
}

function itemOf(el: Element, list: Element): Element | null {
  let cur: Element | null = el
  while (cur && cur.parentElement !== list) cur = cur.parentElement
  return cur
}

/** The list the rows sit in: the closest element holding every count. */
function commonList(els: Element[]): Element | null {
  const first = els[0]
  if (!first) return null
  if (els.length === 1) {
    // One section: climb to the first ancestor with room for a title, the count and rows.
    let cur: Element = first
    while (cur.parentElement && cur.parentElement.children.length < 3) cur = cur.parentElement
    return cur.parentElement
  }
  let list: Element | null = first.parentElement
  while (list && !els.every((e) => list !== e && list?.contains(e))) list = list.parentElement
  return list
}

function currentRow(rows: Row[], lessonId: string, heading: string | null): Row | null {
  const byUrl = rows.find((r) => r.url && new RegExp(`/lessons/${lessonId}(?:[/?#]|$)`).test(r.url))
  if (byUrl) return byUrl
  // The current lesson is the one row that isn't a button or link.
  const quiet = rows.filter((r) => !r.interactive)
  if (quiet.length === 1 && rows.length > 1) return quiet[0] ?? null
  if (heading) return rows.find((r) => r.title === heading) ?? null
  return null
}

function lessonHeading(): string | null {
  const button = transcriptButton()
  const scope = document.getElementById('circle-ai-workspace-body') ?? document.body
  // The large heading right after the transcript button, outside the player.
  const candidates = Array.from(scope.querySelectorAll('h1, h2, [class*="heading-2xl"]')).filter(
    (el) => visible(el) && !el.closest('#circle-ai-left-sidebar-body') && clean(el.textContent)
  )
  if (button) {
    const after = candidates.find((el) => button.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)
    if (after) return clean(after.textContent)
  }
  return clean(candidates[0]?.textContent ?? null)
}

function courseTitle(): string | null {
  const t = clean(document.title)
  if (!t) return null
  const i = t.lastIndexOf(' | ')
  return i > 0 ? clean(t.slice(0, i)) : t
}

function transcriptButton(): HTMLElement | null {
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('button, [role="button"]'))) {
    const name = clean(el.getAttribute('aria-label') ?? el.textContent)
    if (name && (TRANSCRIPT_OPEN.test(name) || TRANSCRIPT_CLOSE.test(name))) return el
  }
  return null
}

/** Cues from an open transcript panel: buttons named "mm:ss <text>". */
function readCues(): ExtCue[] {
  const starts: { s: number; t: string }[] = []
  for (const el of Array.from(document.querySelectorAll('button, [role="button"]'))) {
    if (el.closest('#circle-ai-left-sidebar-body')) continue
    const m = CUE.exec(clean(el.textContent, CAPS.cueText + 12) ?? '')
    if (!m) continue
    const s = stampSeconds(m[1] ?? '')
    const t = clean(m[2] ?? null, CAPS.cueText)
    if (s === null || !t) continue
    starts.push({ s: s * 1_000, t })
    if (starts.length >= CAPS.cues) break
  }
  // Only start times are shown; a cue ends where the next starts.
  return starts.map((c, i) => ({ s: c.s, e: Math.max(c.s, starts[i + 1]?.s ?? c.s), t: c.t }))
}

function track(video: string, cues: ExtCue[]): CaptionsReply {
  return {
    status: 'ok',
    track: { video, lang: (document.documentElement.lang || 'und').slice(0, 35), kind: 'asr', source: 'dom', cues }
  }
}

export function circleAdapter(env: AdapterEnv): Adapter {
  const key = (): string | null => {
    const i = ids()
    return i ? `circle:${location.hostname.toLowerCase()}:${i.lessonId}` : null
  }
  return {
    id: 'circle',
    video: key,
    ad: () => false,
    page(): PageResult | null {
      const i = ids()
      if (!i) return null
      const misses: string[] = []
      const heading = lessonHeading()
      const rows = sidebarRows()
      const current = currentRow(rows, i.lessonId, heading)
      const title = heading ?? current?.title ?? null
      const course = courseTitle()
      if (!heading) misses.push('lesson-title')
      if (!rows.length) misses.push('outline')
      if (!current) misses.push('lesson-number')
      if (!course) misses.push('course')
      const page: PageFields = {
        adapter: 'circle',
        course: { id: i.slug, title: course, url: `${location.origin}/c/${i.slug}` },
        section: {
          id: i.sectionId,
          title: current?.section ?? null,
          index: current && current.sectionIndex > 0 ? current.sectionIndex : null
        },
        lesson: { id: i.lessonId, title, index: current?.number ?? null, count: rows.length || null },
        playlist: null,
        channel: null,
        confidence: { course: 'page', section: 'page', lesson: 'page' }
      }
      return { page, misses }
    },
    outline(): ExtOutlineItem[] {
      return sidebarRows().map((r) => ({ number: r.number, section: r.section, title: r.title, url: r.url, duration: null }))
    },
    async captions(video, langs): Promise<CaptionsReply> {
      // Read the transcript only if it's already open; never click for Notula.
      const cues = readCues()
      if (cues.length) return track(video, cues)
      return textTrackCues(env.media(), video, langs)
    },
    async transcript(): Promise<TranscriptRead> {
      const video = key()
      if (!video) return { status: 'none' }
      let cues = readCues()
      if (!cues.length) {
        const button = transcriptButton()
        if (!button) return { status: 'none' }
        const name = clean(button.getAttribute('aria-label') ?? button.textContent) ?? ''
        // The user asked for it in the popup: one click on the page's own button.
        if (TRANSCRIPT_OPEN.test(name)) button.click()
        cues = (await waitFor(() => {
          const c = readCues()
          return c.length ? c : null
        }, TRANSCRIPT_WAIT_MS)) ?? []
      }
      if (!cues.length) return { status: 'failed' }
      const r = track(video, cues)
      return r.status === 'ok' ? { status: 'ok', track: r.track } : { status: 'failed' }
    }
  }
}
