// SPDX-License-Identifier: Apache-2.0
// Courses in main: recognition of playing lessons, and the IPC to add, change and remove a
// course, the Add course sheet's candidates, the course list and page, the lesson picker and
// Refresh from playlist. It pushes `sources:courses-changed`. Undo, Link this note, Open lesson,
// seek and export belong to other parts.
//
// - Recognition: every eligible playback (Sources' rule: accumulated play time and duration) gets
//   its signals S1–S7 gathered and `recognize()`d once, and again when its title changes. S5 reads
//   History for granted hosts only (identify.ts). S7, the window read, runs only when the matched
//   or candidate course has `windowRead` on, once per playback plus once per title change. The
//   result is kept with the playback (`courseRecognition`, `onCourseRecognized`) for the automatic
//   start to act on. Each `exact` recognition records the title it saw as a learned title (20 per
//   course, oldest dropped, never a generic one). Lesson rules 2 and 3 fill the item's key from a
//   lesson URL when one is known.
// - Add course: a new series or an existing one with no app or site yet; its behavior and match;
//   with the switch on, its hosts join `sources.historyHosts` and the window read turns on;
//   the lesson list from the vault (vault-list.ts), pasted text (the catalog grammar), the
//   playlist, or later. Turning the switch off, or removing the course, takes its hosts out of the
//   grant unless another course still uses them.
// - The Add course sheet's one-time host lookup, for a Chrome app with no host, is shown for the
//   user to confirm and kept only if the course is added.
// Nothing runs while Sources is off or off Windows. Logs: counts, states, rules and confidences,
// never titles, URLs, hosts or app names.

import { ipcMain } from 'electron'
import { notulaError } from '@shared/errors'
import type { InvokeChannel, InvokeRes, PushChannel } from '@shared/ipc'
import { hostIs, normalizeHost, parseSourceUrl } from '@shared/lib/source-key'
import type {
  AddCourseRequest,
  AppMapping,
  CatalogImportResult,
  CourseBehavior,
  CourseCandidates,
  CourseLessonListInput,
  CourseListItem,
  CourseMatch,
  CourseMatchApp,
  CoursePatch,
  CourseProposal,
  LessonReadSite,
  MediaSession,
  NoteSource,
  Playback,
  Recognition,
  SeriesKind,
  SeriesListItem,
  SetLessonRequest,
  SourceProvider,
  SourceSeries
} from '@shared/types/sources'
import { GUESS_KEY_PREFIX, SOURCES_LIMITS } from '@shared/types/sources'
import { randomUUID } from 'node:crypto'
import type { MainContext } from '../context'
import { log } from '../log'
import { lessonRead, windowTitle } from '../media'
import { mapApp } from '../media/apps'
import { locateTab } from '../media/locate'
import { egressBlocked } from '../privacy'
import { id, object } from '../notes/validate'
import { parseCatalog } from './catalog'
import { courseHistory, fetchPlaylist, findAppAddress } from './identify'
import {
  channelKey,
  cleanWindowTitle,
  courseUrl,
  finishedItems,
  genericNames,
  isGenericTitle,
  learnTitles,
  recognize,
  type RecognizableCourse,
  type Signals
} from './recognize'
import { catalogFilePath, fillCatalog, fillFromPlaylist } from './series'
import { readVaultCourse, vaultFolderOf } from './vault-list'

// ---------- recognition, as the automatic start sees it ----------

export interface CourseRecognized {
  playbackId: string
  playback: Playback
  recognition: Recognition
  /** The playback was just added to Courses from the sheet: start without the wait. */
  immediate: boolean
}

type RecognizedListener = (e: CourseRecognized) => void
const recognizedListeners = new Set<RecognizedListener>()
const recognitions = new Map<string, Recognition>()

/** The latest recognition of a present playback, or null (not eligible yet, or none ran). */
export function courseRecognition(playbackId: string): Recognition | null {
  return recognitions.get(playbackId) ?? null
}

/** Each recognition, as it is made: at eligibility, on a title change, and when Courses change. */
export function onCourseRecognized(l: RecognizedListener): () => void {
  recognizedListeners.add(l)
  return () => recognizedListeners.delete(l)
}

// ---------- validation ----------

const bad = (what: string): Error => notulaError('invalid-input', what)

const SERIES_KINDS: readonly SeriesKind[] = ['course', 'playlist', 'channel', 'custom']
const PROVIDERS: readonly SourceProvider[] = ['youtube', 'circle', 'udemy', 'coursera', 'hotmart', 'kiwify', 'memberkit', 'vimeo', 'web']
const MAX_TITLE = 500
const MAX_TEXT = 2 * 1024 * 1024
const MAX_KEY = 2_048
const MAX_ITEMS = 50
const HOST = /^[a-z0-9.-]{1,253}$/

function str(v: unknown, what: string, max: number): string {
  if (typeof v !== 'string' || v.length > max) throw bad(`${what} is not valid`)
  return v
}

function strList(v: unknown, what: string, max: number, each: number): string[] {
  if (!Array.isArray(v) || v.length > max) throw bad(`${what} is not valid`)
  return v.map((x) => str(x, what, each))
}

function courseTitle(v: unknown): string {
  const t = str(v, 'title', 10_000).replace(/\s+/g, ' ').trim()
  if (!t) throw bad('Enter a course name.')
  if (t.length > MAX_TITLE) throw bad('Use up to 500 characters for the course name.')
  return t
}

function behaviorOf(v: unknown, partial: boolean): Partial<CourseBehavior> {
  const b = object(v, 'behavior')
  const out: Partial<CourseBehavior> = {}
  if (b['onPlay'] !== undefined || !partial) {
    if (b['onPlay'] !== 'record' && b['onPlay'] !== 'ask') throw bad('behavior.onPlay is not valid')
    out.onPlay = b['onPlay']
  }
  if (b['onEnd'] !== undefined || !partial) {
    if (b['onEnd'] !== 'notes' && b['onEnd'] !== 'button') throw bad('behavior.onEnd is not valid')
    out.onEnd = b['onEnd']
  }
  return out
}

function appsOf(v: unknown): CourseMatchApp[] {
  if (!Array.isArray(v) || v.length > 10) throw bad('match.apps is not valid')
  return v.map((x) => {
    const a = object(x, 'match.apps')
    const browser = a['browser']
    if (browser !== 'chrome' && browser !== 'edge' && browser !== 'brave') throw bad('match.apps is not valid')
    const nullable = (k: string): string | null => (a[k] === null || a[k] === undefined ? null : str(a[k], 'match.apps', 300))
    return { browser, appUserModelId: str(a['appUserModelId'], 'match.apps', 300), profile: nullable('profile'), appId: nullable('appId') }
  })
}

function matchOf(v: unknown, partial: boolean): Partial<CourseMatch> {
  const m = object(v, 'match')
  const out: Partial<CourseMatch> = {}
  if (m['apps'] !== undefined || !partial) out.apps = appsOf(m['apps'])
  if (m['hosts'] !== undefined || !partial) {
    out.hosts = [...new Set(strList(m['hosts'], 'match.hosts', MAX_ITEMS, 253).map((h) => normalizeHost(h.trim())))]
    if (out.hosts.some((h) => !HOST.test(h))) throw bad('match.hosts is not valid')
  }
  if (m['titles'] !== undefined || !partial) out.titles = strList(m['titles'], 'match.titles', SOURCES_LIMITS.learnedTitles * 2, 1_000).slice(-SOURCES_LIMITS.learnedTitles)
  if (m['keys'] !== undefined || !partial) out.keys = [...new Set(strList(m['keys'], 'match.keys', MAX_ITEMS, MAX_KEY).map((k) => k.toLowerCase()))]
  if (m['windowRead'] !== undefined || !partial) {
    if (typeof m['windowRead'] !== 'boolean') throw bad('match.windowRead must be a boolean')
    out.windowRead = m['windowRead']
  }
  return out
}

function lessonListOf(v: unknown): CourseLessonListInput {
  const l = object(v, 'lessonList')
  switch (l['kind']) {
    case 'vault':
      return { kind: 'vault', handle: str(l['handle'], 'lessonList.handle', 100) }
    case 'paste':
      return { kind: 'paste', text: str(l['text'], 'lessonList.text', MAX_TEXT) }
    case 'playlist':
      return { kind: 'playlist' }
    case 'later':
      return { kind: 'later' }
    default:
      throw bad('lessonList.kind is not valid')
  }
}

function addRequest(v: unknown): AddCourseRequest {
  const r = object(v, 'request')
  const seriesId = r['seriesId'] === null || r['seriesId'] === undefined ? null : id(r['seriesId'], 'seriesId')
  let draft: AddCourseRequest['draft'] = null
  if (r['draft'] !== null && r['draft'] !== undefined) {
    const d = object(r['draft'], 'draft')
    if (!SERIES_KINDS.includes(d['kind'] as SeriesKind)) throw bad('draft.kind is not valid')
    if (!PROVIDERS.includes(d['provider'] as SourceProvider)) throw bad('draft.provider is not valid')
    const key = str(d['canonicalKey'], 'draft.canonicalKey', MAX_KEY).trim()
    if (!key || key.startsWith(GUESS_KEY_PREFIX)) throw bad('draft.canonicalKey is not valid')
    draft = { kind: d['kind'] as SeriesKind, provider: d['provider'] as SourceProvider, canonicalKey: key }
  }
  if (!seriesId && !draft) throw bad('seriesId or draft is required')
  if (typeof r['captions'] !== 'boolean') throw bad('captions must be a boolean')
  return {
    seriesId,
    draft,
    title: courseTitle(r['title']),
    behavior: behaviorOf(r['behavior'], false) as CourseBehavior,
    match: matchOf(r['match'], false) as CourseMatch,
    lessonList: lessonListOf(r['lessonList']),
    captions: r['captions'],
    playbackId: r['playbackId'] === null || r['playbackId'] === undefined ? null : str(r['playbackId'], 'playbackId', 300)
  }
}

function updateRequest(v: unknown): { seriesId: string; patch: CoursePatch } {
  const r = object(v, 'request')
  const seriesId = id(r['seriesId'], 'seriesId')
  const p = object(r['patch'], 'patch')
  const patch: CoursePatch = {}
  if (p['title'] !== undefined) patch.title = courseTitle(p['title'])
  if (p['behavior'] !== undefined) patch.behavior = behaviorOf(p['behavior'], true)
  if (p['match'] !== undefined) patch.match = matchOf(p['match'], true)
  if (Object.keys(patch).length === 0) throw bad('Nothing to change')
  return { seriesId, patch }
}

function setLessonRequest(v: unknown): SetLessonRequest {
  const r = object(v, 'request')
  return {
    noteId: id(r['noteId'], 'noteId'),
    itemId: r['itemId'] === null ? null : id(r['itemId'], 'itemId'),
    seriesId: r['seriesId'] === null || r['seriesId'] === undefined ? null : id(r['seriesId'], 'seriesId')
  }
}

function candidatesRequest(v: unknown): { playbackId: string | null; url: string | null } {
  const r = v === undefined || v === null ? {} : object(v, 'request')
  return {
    playbackId: r['playbackId'] === null || r['playbackId'] === undefined ? null : str(r['playbackId'], 'playbackId', 300),
    url: r['url'] === null || r['url'] === undefined ? null : str(r['url'], 'url', 4_096).trim() || null
  }
}

// ---------- helpers ----------

/** Playback states past Sources' eligibility (20 s played, long enough). */
const ELIGIBLE = new Set<Playback['state']>(['candidate', 'identified', 'offered', 'noted', 'skipped'])
/** Recognition reads the course list at most this often while nothing changes. */
const COURSES_TTL_MS = 10_000

const EMPTY_MATCH: CourseMatch = { apps: [], hosts: [], titles: [], keys: [], windowRead: false }

/** A course with no app and no site yet (added from the vault): the sheet offers to link it. */
function unlinked(s: Pick<SourceSeries, 'match'>): boolean {
  return !s.match || (s.match.apps.length === 0 && s.match.hosts.length === 0 && s.match.keys.length === 0)
}

/** The hosts the History grant covers for a course: its sites, except YouTube (the global question). */
function grantHosts(match: CourseMatch | null): string[] {
  if (!match?.windowRead) return []
  return match.hosts.filter((h) => !hostIs(h, 'youtube.com') && !hostIs(h, 'youtu.be'))
}

function readSite(hosts: readonly string[], provider: SourceProvider): LessonReadSite {
  if (provider === 'circle') return 'circle'
  if (hosts.some((h) => hostIs(h, 'hub.la'))) return 'hubla'
  if (hosts.some((h) => hostIs(h, 'circle.so'))) return 'circle'
  return 'generic'
}

// ---------- registration ----------

export function registerCourses(ctx: MainContext): void {
  const { storage, bus } = ctx
  const active = async (): Promise<boolean> => process.platform === 'win32' && (await ctx.settings.get('sources.enabled'))
  const requireActive = async (): Promise<void> => {
    if (!(await active())) throw bad('Sources is off')
  }

  const pushChanged = (seriesIds: string[]): void => {
    for (const wc of ctx.windows.targets()) wc.send('sources:courses-changed' satisfies PushChannel, { seriesIds })
  }

  // ---------- the History grant (serialized: a list setting is read-modify-write) ----------

  let grantQueue: Promise<unknown> = Promise.resolve()
  /** Recomputes `sources.historyHosts`: `add` joins, `drop` leaves unless another course (with its switch on) still uses it. */
  function updateGrant(add: readonly string[], drop: readonly string[], exceptSeriesId: string): Promise<void> {
    const run = grantQueue.then(async () => {
      if (add.length === 0 && drop.length === 0) return
      const current = await ctx.settings.get('sources.historyHosts')
      const inUse = new Set<string>()
      if (drop.length) for (const c of await storage.listCourses()) if (c.id !== exceptSeriesId) for (const h of grantHosts(c.match)) inUse.add(h)
      const next = current.filter((h) => !drop.includes(h) || inUse.has(h) || add.includes(h))
      for (const h of add) if (!next.includes(h)) next.push(h)
      if (next.length > SOURCES_LIMITS.historyHosts) throw bad(`History can be read for up to ${SOURCES_LIMITS.historyHosts} sites. Remove a course you no longer watch, then try again.`)
      if (next.length === current.length && next.every((h, i) => h === current[i])) return
      await ctx.settings.set('sources.historyHosts', next)
      log('info', 'sources:history-grant', { hosts: next.length, added: add.length, dropped: current.length - next.length + add.filter((h) => !current.includes(h)).length })
    })
    grantQueue = run.catch(() => undefined)
    return run
  }

  // ---------- where a course plays ----------

  const appNames = new Map<string, string | null>()
  async function appName(appUserModelId: string): Promise<string | null> {
    if (appNames.has(appUserModelId)) return appNames.get(appUserModelId) ?? null
    const m = await mapApp(appUserModelId).catch(() => null)
    const name = m?.state === 'mapped' ? m.name : null
    if (m?.state === 'mapped') appNames.set(appUserModelId, name)
    return name
  }

  async function playsIn(s: Pick<SourceSeries, 'provider' | 'match'>): Promise<string | null> {
    const app = s.match?.apps[0]
    if (app) {
      const name = await appName(app.appUserModelId)
      if (name) return `${name} app`
    }
    if (s.provider === 'youtube') return 'YouTube'
    return s.match?.hosts[0] ?? (app ? 'Course app' : null)
  }

  const toItem = async (row: SeriesListItem): Promise<CourseListItem> => ({ ...row, playsIn: await playsIn(row) })

  async function courseItem(seriesId: string): Promise<CourseListItem> {
    const row = (await storage.listCourses()).find((c) => c.id === seriesId) ?? (await storage.listSeries()).find((c) => c.id === seriesId)
    if (!row) throw notulaError('not-found', 'No such course')
    return toItem(row)
  }

  // ---------- lesson lists ----------

  async function fillLessonList(series: SourceSeries, list: CourseLessonListInput, playback: Playback | null): Promise<void> {
    switch (list.kind) {
      case 'later':
        return
      case 'vault': {
        const folder = vaultFolderOf(list.handle, catalogFilePath)
        if (!folder) throw bad('That folder is no longer available. Choose it again.')
        const v = await readVaultCourse(folder).catch(() => null)
        if (!v) throw bad('Couldn’t read that folder. Check that it still exists, then choose it again.')
        if (v.items.length === 0) throw bad('No lessons found in that folder. Choose a course folder with numbered lesson folders.')
        const r = await fillCatalog(ctx, series.id, v.items.slice(0, SOURCES_LIMITS.catalogItems), { origin: 'vault' })
        log('info', 'sources:vault-list', { items: v.items.length, withUrl: v.items.filter((i) => i.url).length, repeated: v.repeated.length, outline: v.outline, numbered: r.numbered })
        return
      }
      case 'paste': {
        const parsed = parseCatalog(list.text)
        if (parsed.overLimit) throw bad(`A lesson list can have up to ${SOURCES_LIMITS.catalogItems.toLocaleString('en-US')} lessons. Split the list and paste the part you need.`)
        if (parsed.items.length === 0) throw bad('No lessons found. Put one lesson per line, with an optional number, duration and link.')
        const r = await fillCatalog(ctx, series.id, parsed.items, { origin: 'import' })
        log('info', 'sources:catalog-imported', { items: parsed.items.length, sections: parsed.sections, skipped: parsed.skippedLines, numbered: r.numbered })
        return
      }
      case 'playlist': {
        const listId = series.canonical_key.startsWith('youtube:playlist:') ? series.canonical_key.slice('youtube:playlist:'.length) : null
        if (!listId || series.kind !== 'playlist') return
        const json = await fetchPlaylist(ctx, listId, SOURCES_LIMITS.playlistAutoFill)
        const r = json ? await fillFromPlaylist(ctx, series, json) : { filled: false as const, reason: 'unreadable' as const }
        log('info', 'sources:playlist-fill', { filled: r.filled, reason: r.filled ? null : r.reason, playing: playback !== null })
        return
      }
    }
  }

  // ---------- recognition ----------

  interface Watch {
    playback: Playback
    /** The title recognition last ran for. */
    title: string | null
    signals: Signals | null
    /** The window read ran for this title. */
    read: boolean
    running: boolean
  }

  const watches = new Map<string, Watch>()
  /** Playbacks just added to Courses from the sheet: their next recognition says `immediate`. */
  const immediate = new Set<string>()
  let sessions: MediaSession[] = []
  let cache: { at: number; courses: RecognizableCourse[] } | null = null

  async function loadCourses(): Promise<RecognizableCourse[]> {
    if (cache && Date.now() - cache.at < COURSES_TTL_MS) return cache.courses
    const rows = await storage.listCourses()
    const courses: RecognizableCourse[] = []
    for (const series of rows) {
      if (!series.registered_at) continue
      const [catalog, detail] = await Promise.all([storage.listCatalog(series.id), storage.getSeriesDetail(series.id)])
      courses.push({ series, catalog, finishedItemIds: finishedItems(detail?.lessons ?? []) })
    }
    cache = { at: Date.now(), courses }
    return courses
  }

  const invalidate = (): void => {
    cache = null
  }

  function sessionOf(p: Playback): MediaSession | null {
    if (p.app) return sessions.find((s) => s.app?.appUserModelId === p.app?.appUserModelId || s.appId === p.app?.appUserModelId) ?? null
    return sessions.find((s) => !s.app && s.browser === p.browser && s.title === p.title) ?? null
  }

  async function mappingOf(p: Playback, session: MediaSession | null): Promise<AppMapping | null> {
    if (!p.app) return null
    if (session?.app) return session.app
    return mapApp(p.app.appUserModelId).catch(() => null)
  }

  /** S1–S6 for a playback; S7 is read after a first pass names the course or its candidates. */
  async function gather(p: Playback): Promise<{ signals: Signals; hwnd: string | null }> {
    const session = sessionOf(p)
    const hwnd = session?.hwnd ?? null
    const mapping = await mappingOf(p, session)
    const title = hwnd ? await windowTitle(hwnd).catch(() => null) : null
    let address = p.url
    let history: Signals['history'] = null
    const seenAt = p.seenAt ?? Date.now() - p.playedMs
    if (p.app) {
      // A course app reads the History of the profile it maps to; an unmapped one reads none.
      if (mapping?.state === 'mapped' && mapping.profile) history = await courseHistory(ctx, { browser: mapping.browser, dir: mapping.profile, name: null }, seenAt)
    } else if (!address) {
      const tab = await locateTab(p.browser, p.title, true).catch(() => null)
      address = tab?.url ?? null
      if (!address && tab && tab.privateWindow === false) history = await courseHistory(ctx, { browser: p.browser, dir: null, name: tab.profileName }, seenAt)
    }
    const parsed = address ? parseSourceUrl(address) : null
    return {
      hwnd,
      signals: {
        app: p.app ? { appUserModelId: p.app.appUserModelId, mapping } : null,
        session: { title: p.title, artist: p.artist },
        windowTitle: title,
        timing: { durationMs: p.durationMs, positionMs: p.positionMs, live: p.live },
        history,
        addressBar: parsed ? { url: parsed.url, canonicalKey: parsed.canonicalKey } : null,
        windowRead: null
      }
    }
  }

  function publish(w: Watch, rec: Recognition, immediate: boolean): void {
    recognitions.set(w.playback.id, rec)
    for (const l of recognizedListeners) {
      try {
        l({ playbackId: w.playback.id, playback: w.playback, recognition: rec, immediate })
      } catch (err) {
        log('warn', 'sources:recognized-listener-failed', { err })
      }
    }
  }

  /** After an `exact` recognition: the title it saw is learned; lesson rules 2–3 fill the item's key from a known URL. */
  async function learn(rec: Recognition, signals: Signals, courses: readonly RecognizableCourse[]): Promise<void> {
    const course = courses.find((c) => c.series.id === rec.courseId)
    if (!course?.series.match) return
    if (rec.confidence === 'exact') {
      const titles = learnTitles(signals, course)
      if (titles) {
        await storage.updateCourse(course.series.id, { match: { ...course.series.match, titles } })
        invalidate()
        log('info', 'sources:title-learned', { titles: titles.length })
      }
    }
    const filled = rec.signals.includes('lesson:2') || rec.signals.includes('lesson:3')
    const url = signals.addressBar ?? signals.history
    if (filled && rec.lesson.itemId && url?.canonicalKey) {
      const item = course.catalog.find((it) => it.id === rec.lesson.itemId)
      if (item && !item.canonical_key) {
        await storage.rememberLessonKey(item.id, url.canonicalKey, url.url)
        invalidate()
      }
    }
  }

  async function run(w: Watch): Promise<void> {
    if (w.running) return
    w.running = true
    const title = w.playback.title
    // Claimed for this title: a failure isn't retried until the title changes.
    w.title = title
    try {
      const courses = await loadCourses()
      if (courses.length === 0) return
      const { signals, hwnd } = await gather(w.playback)
      let rec = recognize(signals, courses)
      // S7: only for a course (or candidates) whose switch is on; once per title.
      const ids = rec.courseId ? [rec.courseId] : (rec.candidates ?? [])
      const scope = ids.length
        ? courses.filter((c) => ids.includes(c.series.id))
        : courses.filter((c) => !!signals.app && (c.series.match?.apps ?? []).some((a) => a.appUserModelId === signals.app?.appUserModelId))
      const reader = scope.find((c) => c.series.match?.windowRead)
      let readState: 'none' | 'read' | 'skipped' = 'none'
      if (reader && hwnd && !w.read) {
        w.read = true
        const r = await lessonRead(hwnd, readSite(reader.series.match?.hosts ?? [], reader.series.provider)).catch(() => 'skipped' as const)
        readState = r === 'skipped' ? 'skipped' : 'read'
        if (r !== 'skipped') {
          signals.windowRead = r
          rec = recognize(signals, courses)
        }
      }
      // Gone, or a new title arrived meanwhile: that title runs on its own.
      if (watches.get(w.playback.id) !== w || w.playback.title !== title) return
      w.signals = signals
      log('info', 'sources:recognized', { confidence: rec.confidence, lesson: rec.lesson.state, rules: rec.signals.filter((s) => s.includes(':')), signals: rec.signals.filter((s) => !s.includes(':')).length, windowRead: readState })
      publish(w, rec, immediate.delete(w.playback.id))
      await learn(rec, signals, courses)
    } catch (err) {
      log('warn', 'sources:recognize-failed', { name: err instanceof Error ? err.name : 'error' })
    } finally {
      w.running = false
      // A title that changed while this ran.
      if (watches.get(w.playback.id) === w && w.title !== w.playback.title && ELIGIBLE.has(w.playback.state)) void run(w)
    }
  }

  /** Courses changed: present playbacks are recognized again from the signals they had (no new reads). */
  async function refresh(immediateFor: string | null): Promise<void> {
    invalidate()
    if (immediateFor && watches.has(immediateFor)) immediate.add(immediateFor)
    const courses = await loadCourses()
    for (const w of watches.values()) {
      if (w.running) continue
      if (!w.signals) {
        // Never gathered (no course to match then): gather now.
        if (w.title !== null && ELIGIBLE.has(w.playback.state)) {
          w.title = null
          void run(w)
        }
        continue
      }
      const rec = recognize(w.signals, courses)
      publish(w, rec, immediate.delete(w.playback.id))
    }
  }

  async function onSnapshot(provider: Playback['provider'], playbacks: Playback[]): Promise<void> {
    if (!(await active())) {
      watches.clear()
      recognitions.clear()
      return
    }
    const present = new Set<string>()
    for (const p of playbacks) {
      if (p.state === 'ended') continue
      present.add(p.id)
      let w = watches.get(p.id)
      if (!w) {
        w = { playback: p, title: null, signals: null, read: false, running: false }
        watches.set(p.id, w)
      }
      if (w.playback.title !== p.title) {
        // A new title: recognized again, and the window read may run once more.
        w.read = false
        w.signals = null
        recognitions.delete(p.id)
      }
      w.playback = p
      // InPrivate windows are never recognized; a course app has none.
      const normal = !!p.app || p.privateWindow === false
      if (ELIGIBLE.has(p.state) && normal && !p.ad && w.title !== p.title) void run(w)
    }
    for (const [pid, w] of [...watches]) {
      if (w.playback.provider !== provider || present.has(pid)) continue
      watches.delete(pid)
      recognitions.delete(pid)
      immediate.delete(pid)
    }
  }

  bus.on('media:sessions', (e) => {
    sessions = e.sessions
  })
  bus.on('sources:playback', ({ provider, playbacks }) => {
    void onSnapshot(provider, playbacks).catch((err: unknown) => log('warn', 'sources:recognize-snapshot-failed', { err }))
  })
  storage.onChange((change) => {
    if (change.tables.some((t) => t === 'source_series' || t === 'series_catalog_items' || t === 'note_sources' || t === 'source_spans')) invalidate()
  })

  // ---------- the Add course sheet ----------

  async function proposalFor(p: Playback | null, link: string | null): Promise<CourseProposal | null> {
    const session = p ? sessionOf(p) : null
    const mapping = p ? await mappingOf(p, session) : null
    const w = p ? watches.get(p.id) : undefined
    const known = link ?? p?.url ?? w?.signals?.addressBar?.url ?? w?.signals?.history?.url ?? null
    let parsed = known ? parseSourceUrl(known) : null
    let cu = known ? courseUrl(known, p?.artist ?? null) : null
    // A Chrome app's id carries no host: look once, in that profile's last 2 minutes, by the page title.
    let foundHost: string | null = null
    if (!cu && mapping?.state === 'mapped' && mapping.browser === 'chrome' && !mapping.host && mapping.profile && session?.hwnd) {
      const page = cleanWindowTitle(await windowTitle(session.hwnd).catch(() => null), mapping.name)
      const address = page ? await findAppAddress(ctx, mapping.profile, page) : null
      if (address) {
        parsed = parseSourceUrl(address)
        cu = courseUrl(address, null)
        foundHost = cu?.host ?? null
      }
    }
    if (!p && !parsed) return null
    const artist = p?.artist?.trim() || null
    const appTitle = mapping?.name?.trim() || null
    let kind: SeriesKind = 'course'
    let provider: SourceProvider = parsed?.provider === 'web' && cu?.courseKeys.some((k) => k.startsWith('circle:')) ? 'circle' : (parsed?.provider ?? 'web')
    let canonicalKey: string
    let title: string
    const sessionTitle = p?.title.replace(/\s+/g, ' ').trim() ?? ''
    if (parsed?.provider === 'youtube') {
      if (parsed.series) {
        kind = 'playlist'
        canonicalKey = parsed.series.canonicalKey
        title = parsed.series.title ?? sessionTitle
      } else if (artist) {
        kind = 'channel'
        canonicalKey = channelKey(artist)
        title = artist
      } else {
        return null
      }
    } else {
      const circleKey = cu?.courseKeys.find((k) => k.startsWith('circle:'))
      canonicalKey = parsed?.series?.canonicalKey ?? circleKey ?? `course:${randomUUID()}`
      if (circleKey) provider = 'circle'
      // A Circle space: the page title without ` | <community>`; an app's own name otherwise.
      const suffix = appTitle ? ` | ${appTitle}`.toLowerCase() : null
      if (suffix && sessionTitle.toLowerCase().endsWith(suffix)) title = sessionTitle.slice(0, -suffix.length).trim()
      else title = appTitle ?? sessionTitle
    }
    if (!title) title = cu?.host ?? 'Untitled course'
    const generic = p ? genericNames({ app: p.app ? { appUserModelId: p.app.appUserModelId, mapping } : null, history: null, addressBar: null }, [cu?.host ?? null]) : new Set<string>()
    const learned = p && !isGenericTitle(sessionTitle, generic) ? [sessionTitle] : []
    const hosts = [...new Set([cu?.host, mapping?.host].filter((h): h is string => !!h).map(normalizeHost))]
    const match: CourseMatch = {
      apps: mapping && p?.app ? [{ browser: mapping.browser, appUserModelId: p.app.appUserModelId, profile: mapping.profile, appId: mapping.appId }] : [],
      hosts,
      titles: learned,
      keys: cu?.courseKeys ?? [],
      windowRead: provider !== 'youtube'
    }
    return {
      title: title.slice(0, MAX_TITLE),
      kind,
      provider,
      canonicalKey,
      match,
      playsIn: appTitle ? `${appTitle} app` : provider === 'youtube' ? 'YouTube' : (hosts[0] ?? null),
      foundHost,
      windowReadOffered: provider !== 'youtube',
      lessonListOptions: ['vault', 'paste', ...(kind === 'playlist' ? (['playlist'] as const) : []), 'later']
    }
  }

  async function candidates(raw: unknown): Promise<CourseCandidates> {
    const { playbackId, url } = candidatesRequest(raw)
    const courses = await storage.listCourses()
    const open = await Promise.all(courses.filter((c) => c.registered_at && unlinked(c)).map(toItem))
    const playback = playbackId ? (watches.get(playbackId)?.playback ?? null) : null
    if (playbackId && !playback) log('info', 'sources:course-candidates', { playback: 'gone' })
    const proposal = playback || url ? await proposalFor(playback, url) : null
    log('info', 'sources:course-candidates', { unlinked: open.length, proposal: proposal !== null, found: proposal?.foundHost != null })
    return { unlinked: open, proposal }
  }

  // ---------- add, change, remove ----------

  async function addCourse(raw: unknown): Promise<CourseListItem> {
    await requireActive()
    const r = addRequest(raw)
    let series: SourceSeries
    if (r.seriesId) {
      const s = await storage.getSeries(r.seriesId)
      if (!s) throw notulaError('not-found', 'No such series')
      if (s.registered_at && !unlinked(s)) throw bad('This course is already in Courses.')
      series = s
    } else {
      const d = r.draft as NonNullable<AddCourseRequest['draft']>
      series = (await storage.upsertSeries({ kind: d.kind, provider: d.provider, canonical_key: d.canonicalKey, title: r.title })).series
    }
    if (series.title !== r.title) series = await storage.updateSeries(series.id, { title: r.title })
    // Linking a course added from the vault keeps what it had and adds the playback's app and site.
    const prior = series.registered_at ? (series.match ?? EMPTY_MATCH) : EMPTY_MATCH
    const generic = genericNames({ app: null, history: null, addressBar: null }, r.match.hosts)
    const match: CourseMatch = {
      apps: [...prior.apps, ...r.match.apps.filter((a) => !prior.apps.some((b) => b.appUserModelId === a.appUserModelId))],
      hosts: [...new Set([...prior.hosts, ...r.match.hosts])],
      titles: [...new Set([...prior.titles, ...r.match.titles.filter((t) => !isGenericTitle(t, generic))])].slice(-SOURCES_LIMITS.learnedTitles),
      keys: [...new Set([...prior.keys, ...r.match.keys])],
      windowRead: r.match.windowRead
    }
    await updateGrant(grantHosts(match), [], series.id)
    series = series.registered_at ? await storage.updateCourse(series.id, { behavior: r.behavior, match }) : await storage.registerCourse(series.id, r.behavior, match)
    if (r.captions && series.provider === 'youtube') await ctx.settings.set('sources.onlineLookups', true)
    const playback = r.playbackId ? (watches.get(r.playbackId)?.playback ?? null) : null
    await fillLessonList(series, r.lessonList, playback)
    log('info', 'sources:course-added', { kind: series.kind, apps: match.apps.length, hosts: match.hosts.length, windowRead: match.windowRead, list: r.lessonList.kind, linked: r.seriesId !== null })
    pushChanged([series.id])
    void refresh(r.playbackId).catch((err: unknown) => log('warn', 'sources:recognize-refresh-failed', { err }))
    return courseItem(series.id)
  }

  async function updateCourse(raw: unknown): Promise<CourseListItem> {
    await requireActive()
    const { seriesId, patch } = updateRequest(raw)
    const series = await storage.getSeries(seriesId)
    if (!series?.registered_at || !series.match) throw notulaError('not-found', 'No such course')
    if (patch.title !== undefined && patch.title !== series.title) await storage.updateSeries(seriesId, { title: patch.title })
    if (patch.behavior || patch.match) {
      const match: CourseMatch = { ...series.match, ...patch.match }
      if (patch.match?.titles) match.titles = patch.match.titles.slice(-SOURCES_LIMITS.learnedTitles)
      const before = grantHosts(series.match)
      const after = grantHosts(match)
      await updateGrant(
        after.filter((h) => !before.includes(h)),
        before.filter((h) => !after.includes(h)),
        seriesId
      )
      await storage.updateCourse(seriesId, { ...(patch.behavior ? { behavior: patch.behavior } : {}), ...(patch.match ? { match } : {}) })
    }
    log('info', 'sources:course-updated', { title: patch.title !== undefined, behavior: !!patch.behavior, match: patch.match ? Object.keys(patch.match).length : 0 })
    pushChanged([seriesId])
    void refresh(null).catch((err: unknown) => log('warn', 'sources:recognize-refresh-failed', { err }))
    return courseItem(seriesId)
  }

  async function removeCourse(raw: unknown): Promise<void> {
    await requireActive()
    const seriesId = id(object(raw, 'request')['seriesId'], 'seriesId')
    const series = await storage.getSeries(seriesId)
    if (!series?.registered_at) throw notulaError('not-found', 'No such course')
    await storage.unregisterCourse(seriesId)
    await updateGrant([], grantHosts(series.match), seriesId)
    log('info', 'sources:course-removed', {})
    pushChanged([seriesId])
    void refresh(null).catch((err: unknown) => log('warn', 'sources:recognize-refresh-failed', { err }))
  }

  // ---------- the lesson picker ----------

  async function setLesson(raw: unknown): Promise<NoteSource> {
    await requireActive()
    const r = setLessonRequest(raw)
    const source = await storage.getNoteSource(r.noteId)
    if (!source) throw notulaError('not-found', 'This note has no source')
    const from = source.series_id ? await storage.getSeries(source.series_id) : null
    let next: NoteSource
    if (r.seriesId && r.seriesId !== source.series_id) {
      // Another course…: the note moves to that course's folder.
      const to = await storage.getSeries(r.seriesId)
      if (!to) throw notulaError('not-found', 'No such course')
      // A lesson sets the series from its item; with none, the note joins the course unnumbered.
      next = r.itemId
        ? await storage.setLessonForNote(r.noteId, r.itemId, 'manual')
        : await storage.updateNoteSource(r.noteId, { series_id: to.id, lesson_number: null, lesson_label: null, lesson_state: 'pending', lesson_origin: null })
      if (from?.folder_id) await storage.removeNoteFromFolder(from.folder_id, r.noteId).catch(() => undefined)
      if (to.folder_id) await storage.addNotesToFolder(to.folder_id, [r.noteId], 'manual').catch(() => undefined)
    } else if (r.itemId === null) {
      // Not a lesson of this course: course and lesson leave the source; the note goes to Home.
      next = await storage.setLessonForNote(r.noteId, null, 'manual')
      if (from?.folder_id) await storage.removeNoteFromFolder(from.folder_id, r.noteId).catch(() => undefined)
    } else {
      next = await storage.setLessonForNote(r.noteId, r.itemId, 'manual')
    }
    // The note follows the lesson's title while its title is still the generated one.
    if (r.itemId) {
      const seriesId = next.series_id
      const item = seriesId ? (await storage.listCatalog(seriesId)).find((it) => it.id === r.itemId) : undefined
      const note = await storage.getNote(r.noteId)
      if (item && note && (note.title ?? '') === (source.generated_title ?? '') && item.title !== note.title) {
        await storage.updateNote(r.noteId, { title: item.title })
        next = await storage.updateNoteSource(r.noteId, { generated_title: item.title })
      }
      // A pick is remembered: the note's lesson URL goes into the item, so it matches by URL next time.
      if (item && source.url && !source.canonical_key.startsWith(GUESS_KEY_PREFIX)) await storage.rememberLessonKey(item.id, source.canonical_key, source.url)
    }
    log('info', 'sources:lesson-set', { cleared: r.itemId === null, moved: !!r.seriesId && r.seriesId !== source.series_id, remembered: !!r.itemId && !!source.url })
    invalidate()
    const ids = [from?.id, next.series_id].filter((x): x is string => !!x)
    if (ids.length) pushChanged([...new Set(ids)])
    return next
  }

  // ---------- Refresh from playlist ----------

  async function refreshCatalog(raw: unknown): Promise<CatalogImportResult> {
    await requireActive()
    const seriesId = id(object(raw, 'request')['seriesId'], 'seriesId')
    const series = await storage.getSeries(seriesId)
    if (!series) throw notulaError('not-found', 'No such course')
    if (series.kind !== 'playlist' || !series.canonical_key.startsWith('youtube:playlist:')) throw bad('Only a playlist’s lesson list can be refreshed.')
    if (series.catalog_origin !== null && series.catalog_origin !== 'playlist') throw bad('This lesson list was added by you, so it isn’t refreshed from the playlist.')
    if (await egressBlocked(ctx, { kind: 'source-lookup' })) throw bad('Couldn’t refresh the lesson list. Local-only mode is on.')
    if (!(await ctx.settings.get('sources.onlineLookups'))) throw bad('Couldn’t refresh the lesson list. Turn on online lookups in Settings ▸ Sources.')
    const json = await fetchPlaylist(ctx, series.canonical_key.slice('youtube:playlist:'.length), SOURCES_LIMITS.playlistAutoFill)
    if (!json) throw bad('Couldn’t read the playlist. Check your connection, then try again.')
    const r = await fillFromPlaylist(ctx, series, json, { refresh: true })
    if (!r.filled) {
      if (r.reason === 'too-long') throw bad(`This playlist has more than ${SOURCES_LIMITS.playlistAutoFill} videos. Paste the list instead.`)
      throw bad('Couldn’t refresh the lesson list from this playlist.')
    }
    pushChanged([seriesId])
    invalidate()
    return { items: r.items, sections: 0, numbered: r.numbered, skippedLines: 0, dryRun: false }
  }

  // ---------- IPC ----------

  ipcMain.handle('sources:add-course' satisfies InvokeChannel, (_e, req: unknown): Promise<InvokeRes<'sources:add-course'>> => addCourse(req))

  ipcMain.handle('sources:update-course' satisfies InvokeChannel, (_e, req: unknown): Promise<InvokeRes<'sources:update-course'>> => updateCourse(req))

  ipcMain.handle('sources:remove-course' satisfies InvokeChannel, (_e, req: unknown): Promise<InvokeRes<'sources:remove-course'>> => removeCourse(req))

  ipcMain.handle('sources:course-candidates' satisfies InvokeChannel, async (_e, req: unknown): Promise<InvokeRes<'sources:course-candidates'>> => {
    if (!(await active())) return { unlinked: [], proposal: null }
    return candidates(req)
  })

  ipcMain.handle('sources:list-courses' satisfies InvokeChannel, async (): Promise<InvokeRes<'sources:list-courses'>> => {
    if (!(await active())) return []
    return Promise.all((await storage.listCourses()).map(toItem))
  })

  ipcMain.handle('sources:get-course' satisfies InvokeChannel, async (_e, req: unknown): Promise<InvokeRes<'sources:get-course'>> => {
    const seriesId = id(object(req, 'request')['seriesId'], 'seriesId')
    if (!(await active())) return null
    const view = await storage.getCourseView(seriesId)
    return view ? { ...view, playsIn: await playsIn(view.detail.series) } : null
  })

  ipcMain.handle('sources:set-lesson' satisfies InvokeChannel, (_e, req: unknown): Promise<InvokeRes<'sources:set-lesson'>> => setLesson(req))

  ipcMain.handle('sources:refresh-catalog' satisfies InvokeChannel, (_e, req: unknown): Promise<InvokeRes<'sources:refresh-catalog'>> => refreshCatalog(req))
}
