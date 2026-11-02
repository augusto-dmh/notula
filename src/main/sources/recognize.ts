// SPDX-License-Identifier: Apache-2.0
// Recognition: which course in Courses a playback belongs to, and which lesson of it. A pure
// function from local signals to a `Recognition`, next to the media state machine; it reads
// nothing and stores nothing. Only courses in Courses are matched; everything else falls to the
// Sources card. `scripts/dev/course-recognize.mjs` loads it through Node's type stripping, so it
// uses erasable TypeScript only.
//
// The course, first rule that holds:
//   1 a lesson URL (S6, then S5) whose course key is a course's key, or whose lesson key is in a
//     course's list → `exact`;
//   2 the window read (S7) names the course, or its module and lesson title match an item of
//     exactly one course linked to the app → `exact`;
//   3 the session title (S2) equals an item's title in exactly one course linked to the app (the
//     Hubla player reports the lesson title) → `exact`;
//   4 the session or window title equals a course's learned title, and no lesson URL or window
//     read points to another course → `title`;
//   5 the app belongs to exactly one course, and no URL, window read or learned title points
//     elsewhere → `app`;
//   6 several courses fit → `ambiguous`; 7 nothing fits → `none`.
// The lesson, within the course: 1 the URL's key or URL is in the list; 2 the window read (title,
// with the module when the list has sections; Circle's position within its section; or a list by
// module); 3 one keyless item within ±2 s of the duration; 4 title equality; then a window read or
// a session title naming a lesson that isn't in the list gives `pending` with that title as its
// label; 5 the item after the newest finished lesson (`guessed`); 6 `pending`.
// A generic title (the bare app or site name) is never learned or matched.
//
// `lesson.label`: the item's section for an item of the list (as `note_sources.lesson_label`),
// the named title for a lesson the list is missing, else null. `signals` lists the signals present
// and the rules that decided (`course:3`, `lesson:4`), for the harness and logs (no text).

import { hostIs, normalizeHost, parseSourceUrl } from '@shared/lib/source-key'
import type { AppMapping, CanonicalKey, CatalogItem, LessonRead, Recognition, SourceSeries } from '@shared/types/sources'
import { SOURCES_LIMITS } from '@shared/types/sources'
import { matchTitle } from './titles'

/** The signals of one playback (S1–S7). Each is null when unknown or not read. */
export interface Signals {
  /** S1: the app id and its mapping (course apps); null for a browser window. */
  app: { appUserModelId: string; mapping: AppMapping | null } | null
  /** S2: the session's title and artist. */
  session: { title: string; artist: string | null }
  /** S3: the course app's window title, or the browser tab's name. */
  windowTitle: string | null
  /** S4: duration and position; `durationMs` null for a live playback. */
  timing: { durationMs: number | null; positionMs: number | null; live: boolean }
  /** S5: the newest lesson-URL visit in History, for a granted host. */
  history: { url: string; canonicalKey: CanonicalKey | null } | null
  /** S6: the playing tab's address bar (browsers only). */
  addressBar: { url: string; canonicalKey: CanonicalKey | null } | null
  /** S7: the window read, for a course whose switch is on. */
  windowRead: LessonRead | null
}

/** A course as recognition sees it: the series, its lesson list, and its finished lessons. */
export interface RecognizableCourse {
  series: SourceSeries
  catalog: CatalogItem[]
  /** Catalog item ids of finished lessons, newest finish first (lesson rule 5). */
  finishedItemIds: string[]
}

/** Duration rule tolerance. */
const DURATION_TOLERANCE_MS = 2_000
const CIRCLE_ROOT = /^\/c\/([^/]+)\/?$/
const HUBLA_AREA = /^\/m\/([^/]+)(?:\/p\/([^/]+))?(?:\/|$)/
/** Edge names a playing app window `<page title> - Audio playing`; browsers add their own name. */
const WINDOW_SUFFIXES = [/\s+-\s+Audio playing$/i, /\s+and \d+ more pages?$/i, /\s+-\s+(?:Microsoft​?\s*Edge|Google Chrome|Brave)$/i]

// ---------- URLs ----------

/** A URL as recognition reads it: its lesson key, its course keys, and whether it is a lesson. */
export interface CourseUrl {
  url: string
  canonicalKey: CanonicalKey
  host: string
  /** Lower-case course keys (`circle:<host>:course:<slug>`, `hubla:<host>:m:<id>`, `youtube:playlist:<id>`, `youtube:channel:<name>`). */
  courseKeys: string[]
  /** A lesson page, not a course root. */
  lesson: boolean
}

/** A YouTube channel's course key, from the session artist (YouTube reports the channel). */
export function channelKey(name: string): string {
  return `youtube:channel:${name.replace(/\s+/g, ' ').trim().toLowerCase()}`
}

/** Null for anything that isn't an http(s) URL. `artist` gives a YouTube video its channel key. */
export function courseUrl(raw: string, artist: string | null = null): CourseUrl | null {
  const p = parseSourceUrl(raw)
  if (!p) return null
  const keys: string[] = []
  let lesson = p.kind === 'lesson'
  let path = ''
  try {
    path = new URL(p.url).pathname
  } catch {
    path = ''
  }
  if (p.provider === 'youtube') {
    if (p.series) keys.push(p.series.canonicalKey)
    if (artist?.trim()) keys.push(channelKey(artist))
    lesson = !p.short
  } else if (p.series) {
    keys.push(p.series.canonicalKey)
  } else if (hostIs(p.host, 'hub.la')) {
    const m = HUBLA_AREA.exec(path)
    if (m) keys.push(`hubla:${p.host}:m:${m[1]}`)
    lesson = !!m?.[2]
  } else if (p.provider === 'web') {
    const root = CIRCLE_ROOT.exec(path)
    if (root) {
      keys.push(`circle:${p.host}:course:${root[1]}`)
      lesson = false
    } else {
      lesson = path.split('/').filter(Boolean).length >= 2
    }
  }
  return { url: p.url, canonicalKey: p.canonicalKey, host: p.host, courseKeys: keys.map((k) => k.toLowerCase()), lesson }
}

/** A course's keys: its match keys and the series' own key, lower-case. */
function keysOf(c: RecognizableCourse): Set<string> {
  const out = new Set<string>([c.series.canonical_key.toLowerCase()])
  for (const k of c.series.match?.keys ?? []) out.add(k.toLowerCase())
  return out
}

/** A course key without its last part: `circle:<host>:course`, `youtube:playlist`. */
function family(key: string): string {
  const i = key.lastIndexOf(':')
  return i > 0 ? key.slice(0, i) : key
}

function itemOfUrl(c: RecognizableCourse, u: CourseUrl): CatalogItem | null {
  return c.catalog.find((it) => (it.canonical_key !== null && it.canonical_key === u.canonicalKey) || (it.url !== null && it.url === u.url)) ?? null
}

/** Rule 1: the URL's lesson is in the list, or its course key is the course's. */
function urlNames(c: RecognizableCourse, u: CourseUrl): boolean {
  if (itemOfUrl(c, u)) return true
  const keys = keysOf(c)
  return u.courseKeys.some((k) => keys.has(k))
}

function hostOf(c: RecognizableCourse, host: string): boolean {
  return (c.series.match?.hosts ?? []).some((h) => hostIs(host, normalizeHost(h)))
}

// ---------- titles ----------

const norm = (t: string | null | undefined): string => (t ? matchTitle(t) : '')

/** `example.com` → `example`, `examplecom`; `app.hub.la` → `hub`, `hubla` (a site's bare name). */
function hostNames(host: string): string[] {
  const labels = normalizeHost(host)
    .split('.')
    .filter((l) => l && l !== 'www' && l !== 'app')
  if (labels.length < 2) return labels
  return [labels.slice(0, -1).join(''), labels.join('')]
}

/** The bare names a title may not be: the app's name and the sites'. */
export function genericNames(signals: Pick<Signals, 'app' | 'history' | 'addressBar'>, extra: readonly (string | null)[] = []): Set<string> {
  const out = new Set<string>()
  const add = (s: string | null | undefined): void => {
    const n = norm(s)
    if (n) out.add(n)
  }
  const m = signals.app?.mapping
  add(m?.name)
  for (const host of [m?.host, signals.history ? courseUrl(signals.history.url)?.host : null, signals.addressBar ? courseUrl(signals.addressBar.url)?.host : null, ...extra]) {
    if (!host) continue
    add(host)
    for (const n of hostNames(host)) out.add(n)
  }
  return out
}

/** A generic title: empty, or the bare app or site name (`Hubla`, `Example Community`). Never learned or matched. */
export function isGenericTitle(title: string | null | undefined, generic: ReadonlySet<string>): boolean {
  const n = norm(title)
  return !n || generic.has(n) || generic.has(n.replace(/\s+/g, ''))
}

/** S3 without the browser's own decorations, and without the app's name at its start. */
export function cleanWindowTitle(raw: string | null, appName: string | null): string | null {
  if (!raw) return null
  let t = raw.replace(/\s+/g, ' ').trim()
  for (let i = 0; i < 3; i++) for (const re of WINDOW_SUFFIXES) t = t.replace(re, '').trim()
  const name = appName?.trim()
  if (name && t.toLowerCase().startsWith(`${name.toLowerCase()} - `)) t = t.slice(name.length + 3).trim()
  return t || null
}

/** A page title of the app (`<page> | <app>`, `<app> - <page>`), not a lesson's own name. */
function isPageTitle(title: string, appName: string | null): boolean {
  const name = appName?.trim().toLowerCase()
  if (!name) return false
  const t = title.trim().toLowerCase()
  return t.endsWith(` | ${name}`) || t.endsWith(` - ${name}`) || t.startsWith(`${name} - `) || t.startsWith(`${name} | `)
}

function learned(c: RecognizableCourse): Set<string> {
  return new Set((c.series.match?.titles ?? []).map(norm).filter(Boolean))
}

// ---------- the window read ----------

/** The read's module or section: its own field, else the breadcrumb's second-to-last part. */
function moduleOf(read: LessonRead): string | null {
  if (read.section?.trim()) return read.section
  return read.breadcrumb.length >= 2 ? (read.breadcrumb[read.breadcrumb.length - 2] ?? null) : null
}

function headingOf(read: LessonRead): string | null {
  return read.heading?.trim() || read.breadcrumb.at(-1)?.trim() || null
}

/**
 * Lesson rule 2: the heading equals one item's title (in the read's section when the list has
 * sections); else Circle's item marker, the n-th item of that section; else a list by module,
 * whose one item is titled as the read's module.
 */
export function itemFromRead(read: LessonRead, catalog: readonly CatalogItem[]): CatalogItem | null {
  const sections = catalog.some((it) => it.section)
  const mod = norm(moduleOf(read))
  const heading = norm(headingOf(read))
  if (heading) {
    let equal = catalog.filter((it) => norm(it.title) === heading)
    if (sections && mod) equal = equal.filter((it) => norm(it.section) === mod)
    else if (sections && equal.length > 1) equal = []
    if (equal.length === 1) return equal[0] as CatalogItem
  }
  const index = read.item?.index
  if (sections && mod && typeof index === 'number' && index >= 1) {
    const inSection = catalog.filter((it) => norm(it.section) === mod)
    const it = inSection[index - 1]
    if (it) return it
  }
  if (mod) {
    const byModule = catalog.filter((it) => norm(it.title) === mod)
    if (byModule.length === 1) return byModule[0] as CatalogItem
  }
  return null
}

/** Course rule 2: the read names the course (its title or a learned title), or matches one of its items. */
function readNames(c: RecognizableCourse, read: LessonRead): 'course' | 'item' | null {
  const named = norm(read.course) || norm(read.breadcrumb.length >= 3 ? read.breadcrumb[0] : null)
  if (named && (norm(c.series.title) === named || learned(c).has(named))) return 'course'
  return itemFromRead(read, c.catalog) ? 'item' : null
}

// ---------- recognize ----------

type Lesson = Recognition['lesson']

const PENDING: Lesson = { itemId: null, number: null, label: null, state: 'pending', origin: null }

function numbered(it: CatalogItem): Lesson {
  return { itemId: it.id, number: it.number, label: it.section, state: 'numbered', origin: 'catalog' }
}

interface Context {
  urls: { u: CourseUrl; signal: 'S5' | 'S6' }[]
  read: LessonRead | null
  session: string
  /** S2 and S3, generic ones dropped, normalized. */
  titles: string[]
  appName: string | null
  generic: ReadonlySet<string>
}

function lessonOf(c: RecognizableCourse, signals: Signals, x: Context, used: string[]): Lesson {
  // 1. The URL's lesson is in the list.
  for (const { u } of x.urls) {
    const it = itemOfUrl(c, u)
    if (it) {
      used.push('lesson:1')
      return numbered(it)
    }
  }
  // 2. The window read.
  if (x.read) {
    const it = itemFromRead(x.read, c.catalog)
    if (it) {
      used.push('lesson:2')
      return numbered(it)
    }
  }
  // 3. One keyless item within ±2 s of the duration.
  const d = signals.timing.durationMs
  if (d !== null && !signals.timing.live) {
    const near = c.catalog.filter((it) => !it.canonical_key && it.duration_ms !== null && Math.abs(it.duration_ms - d) <= DURATION_TOLERANCE_MS)
    if (near.length === 1) {
      used.push('lesson:3')
      return numbered(near[0] as CatalogItem)
    }
  }
  // 4. Title equality.
  for (const t of x.titles) {
    const equal = c.catalog.filter((it) => norm(it.title) === t)
    if (equal.length === 1) {
      used.push('lesson:4')
      return numbered(equal[0] as CatalogItem)
    }
  }
  // A lesson the list is missing: the window read's heading, or a session title that names one.
  const heading = x.read ? headingOf(x.read) : null
  if (heading && !isGenericTitle(heading, x.generic)) {
    used.push('lesson:named')
    return { ...PENDING, label: heading }
  }
  const s = x.session
  if (s && !isGenericTitle(s, x.generic) && !isPageTitle(s, x.appName) && !learned(c).has(norm(s)) && norm(s) !== norm(c.series.title)) {
    used.push('lesson:named')
    return { ...PENDING, label: s }
  }
  // 5. The item after the newest finished lesson.
  const last = c.finishedItemIds[0]
  const at = last ? c.catalog.findIndex((it) => it.id === last) : -1
  const next = at >= 0 ? c.catalog[at + 1] : undefined
  if (next) {
    used.push('lesson:5')
    return { itemId: next.id, number: next.number, label: next.section, state: 'guessed', origin: null }
  }
  used.push('lesson:6')
  return PENDING
}

export function recognize(signals: Signals, courses: readonly RecognizableCourse[]): Recognition {
  const used: string[] = []
  if (signals.app) used.push('S1')
  if (signals.session.title.trim()) used.push('S2')
  if (signals.windowTitle) used.push('S3')
  if (signals.timing.durationMs !== null || signals.timing.positionMs !== null) used.push('S4')
  if (signals.history) used.push('S5')
  if (signals.addressBar) used.push('S6')
  if (signals.windowRead) used.push('S7')

  const live = courses.filter((c) => c.series.registered_at !== null)
  const appName = signals.app?.mapping?.name ?? null
  const generic = genericNames(signals)
  const session = signals.session.title.replace(/\s+/g, ' ').trim()
  const win = cleanWindowTitle(signals.windowTitle, appName)
  const titles = [...new Set([session, win].filter((t): t is string => !!t && !isGenericTitle(t, generic)).map(norm))]
  const urls: Context['urls'] = []
  for (const [raw, signal] of [
    [signals.addressBar, 'S6'],
    [signals.history, 'S5']
  ] as const) {
    const u = raw ? courseUrl(raw.url, signals.session.artist) : null
    if (u) urls.push({ u: raw?.canonicalKey ? { ...u, canonicalKey: raw.canonicalKey } : u, signal })
  }
  const read = signals.windowRead
  const x: Context = { urls, read, session, titles, appName, generic }

  const done = (c: RecognizableCourse, confidence: Recognition['confidence'], rule: number): Recognition => {
    used.push(`course:${rule}`)
    return { courseId: c.series.id, confidence, lesson: lessonOf(c, signals, x, used), signals: used }
  }
  const several = (cs: readonly RecognizableCourse[]): Recognition => {
    used.push('course:6')
    return { courseId: null, confidence: 'ambiguous', lesson: PENDING, signals: used, candidates: cs.slice(0, SOURCES_LIMITS.courseCandidates).map((c) => c.series.id) }
  }

  // The courses this playback's app (or, in a browser, its URL's site) belongs to.
  const app = signals.app
  const linked = app
    ? live.filter((c) =>
        (c.series.match?.apps ?? []).some(
          (a) => a.appUserModelId === app.appUserModelId || (!!app.mapping?.appId && a.appId === app.mapping.appId && a.browser === app.mapping.browser)
        )
      )
    : live.filter((c) => urls.some(({ u }) => hostOf(c, u.host)))
  let fit: RecognizableCourse[] = []

  // 1. A lesson URL.
  for (const { u } of urls) {
    const cs = live.filter((c) => urlNames(c, u))
    if (cs.length === 1) return done(cs[0] as RecognizableCourse, 'exact', 1)
    if (cs.length > 1 && fit.length === 0) fit = cs
  }
  // 2. The window read.
  if (read) {
    const scope = linked.length ? linked : live
    const byName = scope.filter((c) => readNames(c, read) === 'course')
    if (byName.length === 1) return done(byName[0] as RecognizableCourse, 'exact', 2)
    const byItem = scope.filter((c) => readNames(c, read) !== null)
    if (byItem.length === 1) return done(byItem[0] as RecognizableCourse, 'exact', 2)
    if (byItem.length > 1 && fit.length === 0) fit = byItem
  }
  // 3. The session title is an item's title in exactly one course of the app.
  if (session && !isGenericTitle(session, generic)) {
    const s = norm(session)
    const cs = linked.filter((c) => c.catalog.some((it) => norm(it.title) === s))
    if (cs.length === 1) return done(cs[0] as RecognizableCourse, 'exact', 3)
  }

  // What points elsewhere: a lesson URL or a window read naming another course.
  const urlElsewhere = (c: RecognizableCourse): boolean =>
    urls.some(({ u }) => {
      if (!u.lesson && u.courseKeys.length === 0) return false
      if (urlNames(c, u)) return false
      if (live.some((o) => o !== c && urlNames(o, u))) return true
      // A course key of the same kind as the course's own (another Circle space, playlist, channel).
      const families = new Set([...keysOf(c)].map(family))
      if (u.courseKeys.some((k) => families.has(family(k)))) return true
      const hosts = c.series.match?.hosts ?? []
      return hosts.length > 0 && !hostOf(c, u.host)
    })
  const readElsewhere = (c: RecognizableCourse): boolean => !!read && readNames(c, read) === null && live.some((o) => o !== c && readNames(o, read) !== null)
  const titleElsewhere = (c: RecognizableCourse): boolean => titles.some((t) => !learned(c).has(t) && live.some((o) => o !== c && learned(o).has(t)))

  // 4. A learned title.
  if (titles.length) {
    const cs = live.filter((c) => titles.some((t) => learned(c).has(t)) && !urlElsewhere(c) && !readElsewhere(c))
    if (cs.length === 1) return done(cs[0] as RecognizableCourse, 'title', 4)
    if (cs.length > 1 && fit.length === 0) fit = cs
  }
  // 5. The app's one course.
  const free = linked.filter((c) => !urlElsewhere(c) && !readElsewhere(c) && !titleElsewhere(c))
  if (linked.length === 1 && free.length === 1) return done(free[0] as RecognizableCourse, 'app', 5)
  // 6. Several fit.
  if (free.length > 1) return several(free)
  if (fit.length > 1) return several(fit)
  used.push('course:7')
  return { courseId: null, confidence: 'none', lesson: PENDING, signals: used }
}

// ---------- learned titles ----------

/**
 * The course's learned titles after an `exact` recognition: the session title, else the window
 * title, unless generic or already an item's title (rules 3 and 4 find those). Oldest dropped
 * past the limit. Null = nothing to change.
 */
export function learnTitles(signals: Signals, course: RecognizableCourse): string[] | null {
  const appName = signals.app?.mapping?.name ?? null
  const generic = genericNames(signals)
  const t = [signals.session.title.replace(/\s+/g, ' ').trim(), cleanWindowTitle(signals.windowTitle, appName)].find((s) => !!s && !isGenericTitle(s, generic))
  if (!t) return null
  const n = norm(t)
  const have = course.series.match?.titles ?? []
  if (have.some((h) => norm(h) === n) || course.catalog.some((it) => norm(it.title) === n)) return null
  return [...have, t].slice(-SOURCES_LIMITS.learnedTitles)
}

/** Lesson rule 5's input: catalog item ids of finished lessons, newest finish first. */
export function finishedItems(lessons: readonly { catalogItemId: string | null; finished: boolean; lastWatchedAt: string | null }[]): string[] {
  return lessons
    .filter((l): l is { catalogItemId: string; finished: boolean; lastWatchedAt: string | null } => l.finished && l.catalogItemId !== null)
    .sort((a, b) => (b.lastWatchedAt ?? '').localeCompare(a.lastWatchedAt ?? ''))
    .map((l) => l.catalogItemId)
}

/**
 * S5's rule on rows already limited to granted hosts: the newest lesson-URL visit from 120 s
 * before to 5 s after the playback was first seen.
 */
export function pickLessonVisit(rows: readonly { url: string; visitMs: number }[], seenAtMs: number): { url: string; canonicalKey: CanonicalKey } | null {
  let best: { url: string; canonicalKey: CanonicalKey; at: number } | null = null
  for (const r of rows) {
    if (r.visitMs < seenAtMs - 120_000 || r.visitMs > seenAtMs + 5_000) continue
    const u = courseUrl(r.url)
    if (!u?.lesson) continue
    if (!best || r.visitMs > best.at) best = { url: u.url, canonicalKey: u.canonicalKey, at: r.visitMs }
  }
  return best ? { url: best.url, canonicalKey: best.canonicalKey } : null
}
