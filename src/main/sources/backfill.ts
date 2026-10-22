// SPDX-License-Identifier: Apache-2.0
// Find sources for older notes: `sources:backfill-preview`,
// `sources:backfill-apply`, `sources:backfill-undo`.
//
// - Candidates: own, non-trashed notes without a source whose title, links or text look like a
//   video or a lesson. A preview scoped by `noteIds` (the import done screen) reads that batch's
//   import candidates first.
// - Rows, in order: an import `source` candidate (`exact`, via `import`; several ask for a pick);
//   a known video or course URL in the note's text (`exact`); an import `series` candidate (the
//   series with a pending or guessed lesson); then the title. A YouTube-like title is searched
//   (lookups granted, egress allowed): `high` only when oEmbed's title and channel both match,
//   else `guess` (there's no duration to check); a hit shorter than an imported transcript's last
//   anchor is dropped. A course-like title gives a `guess` with its course as the series.
// - Lesson numbers from the title pattern or the import folder are `guessed`; when the two
//   disagree, the row asks.
// - Nothing changes until rows are ticked and applied. Apply links the source and its series (no
//   folder filing, no title change, like linking by hand). One Undo per batch unlinks the sources
//   it added that are still unchanged and unused (no watch spans, no stamped notes since).
// - Caps count only what the preview shows (rows with a proposal or choices) and the titles this
//   session hasn't searched yet; an unscoped preview reads the notes newest first, page by page,
//   and says when notes are left for the next one.
// - Previews and batches live in memory for this session. Logs carry counts and reasons only.

import { randomUUID } from 'node:crypto'
import { ipcMain } from 'electron'
import { notulaError } from '@shared/errors'
import type { InvokeChannel, InvokeRes } from '@shared/ipc'
import { cleanTitle, normalizeHost, parseSourceUrl, titleKey } from '@shared/lib/source-key'
import type { CandidateLink } from '@shared/types/imports-markdown'
import { noteShareApp } from '../imports-md/links'
import type { NoteListItem } from '@shared/types/notes'
import type { BackfillPreview, BackfillRow, CanonicalKey, NoteSource, SeriesHint, SourceDraft, SourceProvider } from '@shared/types/sources'
import type { MainContext } from '../context'
import { log } from '../log'
import { draftFromUrl, guessDraft } from '../media/match'
import { egressBlocked } from '../privacy'
import type { ImportCandidateRow } from '../storage/api'
import { seriesHintOf, type LessonFields } from './filing'
import { searchSources } from './identify'
import { resolveLesson } from './series'

/** Notes an unscoped preview reads per page (newest first), and the pages one preview reads at most. */
const SCAN_MAX = 2_000
const SCAN_PAGES = 10
/** A scoped preview's ids (an import batch's cap). */
const SCOPE_MAX = 5_000
/** Rows the preview shows (a proposal or choices); an unscoped preview keeps as many no-match rows at most. */
const ROWS_MAX = 500
const CHOICES_MAX = 5
/** Title searches per preview; the rest wait for the next preview (identification caches the earlier ones). */
const SEARCHES_MAX = 30
const SEARCH_BUDGET_MS = 120_000
const PREVIEW_TTL_MS = 30 * 60_000
const BATCHES_KEPT = 20
const SOURCE_PAGE = 1_000

const VIDEO_TAG = /^(v[ií]deo|video|youtube)$/i
const COURSE_TAG = /^(curso|course|aula|lesson|class)$/i
/** `Aula 12`, `Lesson 12`, `Class 12`, a leading `12.` or `#12`. */
const LESSON_PATTERNS = [/\b(?:aula|lesson|class)\s+(\d{1,4})\b/i, /^\s*(\d{1,4})\.\s/, /(?:^|\s)#(\d{1,4})\b/]

interface TitleFacts {
  video: boolean
  lessonLike: boolean
  /** The title without tags, site or channel parts. */
  title: string
  channel: string | null
  course: string | null
  lesson: number | null
}

interface PreviewState {
  rows: BackfillRow[]
  expiresAt: number
}

interface AppliedRow {
  noteId: string
  sourceId: string
  canonicalKey: CanonicalKey
  /** What the user can edit about the source; a stamped-projection save doesn't count. */
  fingerprint: string
}

/** `Aula 12` and the other patterns, as a lesson number. */
export function lessonFromTitle(title: string): number | null {
  for (const p of LESSON_PATTERNS) {
    const m = p.exec(title)
    if (m) {
      const n = Number(m[1])
      if (Number.isInteger(n) && n > 0) return n
    }
  }
  return null
}

/**
 * What a hand-typed title says: `[Vídeo] <title> - Youtube - <channel>`,
 * `[Curso] <course> - Aula <n> - <topic>`, `[<course>] - <module> - <class>`, a ` - YouTube` suffix.
 */
export function titleFacts(raw: string): TitleFacts {
  let t = raw.replace(/\s+/g, ' ').trim()
  let video = false
  let lessonLike = false
  let course: string | null = null
  // Leading tags: types ([Vídeo], [Curso], [Aula]) or a course name ([System Design]).
  for (let m = /^\[([^\]]{1,120})\]\s*(?:[-–—]\s*)?/.exec(t); m; m = /^\[([^\]]{1,120})\]\s*(?:[-–—]\s*)?/.exec(t)) {
    const tag = m[1]!.trim()
    if (VIDEO_TAG.test(tag)) video = true
    else if (COURSE_TAG.test(tag)) lessonLike = true
    else {
      course ??= tag
      lessonLike = true
    }
    t = t.slice(m[0].length)
  }
  let channel: string | null = null
  const yt = /\s+[-–—|]\s+you\s?tube(?:\s+[-–—]\s+(.+))?$/i.exec(t)
  if (yt) {
    video = true
    channel = yt[1]?.trim() || null
    t = t.slice(0, yt.index)
  }
  const lesson = lessonFromTitle(t)
  // `<course> - Aula <n> - <topic>`: the course comes first.
  const parts = t.split(/\s+[-–—]\s+/)
  if (lessonLike && !course && parts.length >= 2 && /^(aula|lesson|class)\b/i.test(parts[1]!)) course = parts[0]!.trim()
  if (lesson !== null && !video) lessonLike = true
  return { video, lessonLike, title: cleanTitle(t), channel, course, lesson }
}

function providerOfKey(key: CanonicalKey): SourceProvider {
  const p = key.split(':')[0]
  return p === 'youtube' || p === 'circle' || p === 'udemy' || p === 'coursera' ? p : 'web'
}

/** The lesson a number hint gives (`guessed`), or pending. */
function hintedLesson(n: number | null): SourceDraft['lesson'] {
  return n === null ? { number: null, label: null, state: 'pending' } : { number: n, label: null, state: 'guessed' }
}

function seriesFromCandidate(c: CandidateLink, title: string | null): SeriesHint | null {
  const key = c.canonicalKey
  if (!key) return null
  if (key.startsWith('youtube:playlist:')) return { kind: 'playlist', provider: 'youtube', canonicalKey: key, title, index: null, section: null }
  return { kind: 'course', provider: providerOfKey(key), canonicalKey: key, title, index: null, section: null }
}

/** A lesson-of-a-series guess for a note whose own URL is unknown (import `series` candidate, course title). */
function seriesGuess(noteTitle: string, series: SeriesHint, site: string | null, lesson: number | null): SourceDraft {
  const facts = guessDraft({ title: noteTitle, artist: null, durationMs: null, live: false }, site)
  return {
    ...facts,
    provider: series.provider,
    kind: series.kind === 'playlist' ? 'video' : 'lesson',
    detectedVia: 'backfill',
    series,
    lesson: hintedLesson(lesson)
  }
}

interface ImportHints {
  candidates: CandidateLink[]
  series: string | null
  lessonFromTitle: number | null
  lessonFromFolder: number | null
  lastAnchorMs: number | null
}

/** A stored import item's candidates and hints (the importer keeps hints and the last anchor in `meta`). */
function importHints(row: ImportCandidateRow): ImportHints {
  const h = (row.meta['hints'] ?? {}) as Record<string, unknown>
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null)
  return {
    candidates: Array.isArray(row.candidates) ? row.candidates : [],
    series: typeof h['series'] === 'string' && h['series'].trim() ? h['series'].trim() : null,
    lessonFromTitle: num(h['lessonFromTitle']),
    lessonFromFolder: num(h['lessonFromFolder']),
    lastAnchorMs: num(row.meta['lastAnchorMs'])
  }
}

/** Every http(s) URL in Markdown or text: link targets and bare URLs, each once. */
function urlsIn(text: string): string[] {
  const out = new Set<string>()
  const re = /https?:\/\/[^\s<>()[\]"'`]+/g
  for (let m = re.exec(text); m; m = re.exec(text)) out.add(m[0].replace(/[).,;:!?\]>*_]+$/, ''))
  return [...out]
}

/** Known video and lesson URLs in a note's text (never notes-app share links, Shorts or plain pages, unless a course host). */
function sourceUrls(text: string, courseHosts: readonly string[]): SourceDraft[] {
  const byKey = new Map<string, SourceDraft>()
  for (const url of urlsIn(text)) {
    const parsed = parseSourceUrl(url)
    if (!parsed || parsed.short || noteShareApp(parsed.host)) continue
    if (parsed.provider === 'web' && !courseHosts.some((h) => parsed.host === h || parsed.host.endsWith(`.${h}`))) continue
    if (byKey.has(parsed.canonicalKey)) continue
    byKey.set(parsed.canonicalKey, draftFromUrl(parsed, { title: '', artist: null, durationMs: null, live: false }, 'exact', 'backfill', parsed.host))
  }
  return [...byKey.values()]
}

/**
 * A draft for a URL candidate, titled from the note. A course the URL names without a title takes
 * the import's course name (else the title's), not the host.
 */
function titled(d: SourceDraft, noteTitle: string, facts: TitleFacts, lesson: number | null, course: string | null = null): SourceDraft {
  const title = d.title || facts.title || cleanTitle(noteTitle) || noteTitle
  const channel = d.channel ?? facts.channel
  const hint = d.series ?? seriesHintOf({ ...d, channel })
  const named = hint && hint.kind === 'course' && !hint.title?.trim() && course?.trim() ? { ...hint, title: course.trim() } : hint
  const withChannel = { ...d, title, channel, series: named }
  if (withChannel.lesson === null && lesson !== null && (d.kind === 'lesson' || withChannel.series?.kind === 'course')) return { ...withChannel, lesson: hintedLesson(lesson) }
  return withChannel
}

function rowOf(noteId: string, noteTitle: string | null, reason: BackfillRow['reason'], drafts: SourceDraft[]): BackfillRow {
  const choices = drafts.length > 1 ? drafts.slice(0, CHOICES_MAX) : []
  const proposal = drafts.length === 1 ? drafts[0]! : null
  const confidence = proposal?.confidence ?? choices[0]?.confidence ?? null
  return {
    id: randomUUID(),
    noteId,
    noteTitle,
    proposal,
    choices,
    confidence,
    reason,
    ticked: proposal !== null && (proposal.confidence === 'exact' || proposal.confidence === 'high')
  }
}

/** Title and folder lesson numbers that disagree: the row asks (one draft per number). */
function lessonChoices(d: SourceDraft, a: number | null, b: number | null): SourceDraft[] {
  if (a === null || b === null || a === b || d.lesson?.state === 'numbered') return [d]
  return [
    { ...d, lesson: hintedLesson(a) },
    { ...d, lesson: hintedLesson(b) }
  ]
}

export function registerBackfill(ctx: MainContext): void {
  const previews = new Map<string, PreviewState>()
  const batches = new Map<string, AppliedRow[]>()
  /** Titles searched this session: identification caches their lookups, so a later preview doesn't count them. */
  const searched = new Set<string>()

  async function requireActive(): Promise<void> {
    if (process.platform !== 'win32' || !(await ctx.settings.get('sources.enabled'))) throw notulaError('invalid-input', 'Sources is off')
  }

  const idList = (v: unknown, what: string, max: number): string[] => {
    if (!Array.isArray(v) || v.length > max || v.some((x) => typeof x !== 'string' || !x || x.length > 200)) {
      throw notulaError('invalid-input', `${what} must list up to ${max} ids`)
    }
    return [...new Set(v as string[])]
  }

  function sweep(): void {
    const now = Date.now()
    for (const [id, p] of previews) if (p.expiresAt <= now) previews.delete(id)
  }

  /** Note ids among `ids` that already have a source. */
  async function linked(ids: string[]): Promise<Set<string>> {
    const out = new Set<string>()
    for (let i = 0; i < ids.length; i += SOURCE_PAGE) {
      for (const s of await ctx.storage.listNoteSources({ noteIds: ids.slice(i, i + SOURCE_PAGE) })) out.add(s.note_id)
    }
    return out
  }

  async function preview(raw: unknown): Promise<BackfillPreview> {
    await requireActive()
    const req = (raw ?? {}) as { noteIds?: unknown }
    const scoped = req.noteIds !== undefined && req.noteIds !== null
    const scope = scoped ? idList(req.noteIds, 'noteIds', SCOPE_MAX) : null
    const settings = await ctx.settings.getAll()
    const courseHosts = settings['sources.courseHosts'].map((h) => normalizeHost(h))
    const lookups = settings['sources.onlineLookups'] && !(await egressBlocked(ctx, { kind: 'source-lookup' }))
    let lookupsSkipped = false
    let searches = 0
    let searchesLeft = 0
    const searchStarted = Date.now()
    const rows: BackfillRow[] = []
    const counts: Record<BackfillRow['reason'], number> = { 'url-in-note': 0, 'import-candidate': 0, 'import-series': 0, 'title-search': 0, 'no-match': 0 }
    let visible = 0
    let hidden = 0
    let scanned = 0
    let more = false

    const consider = async (n: NoteListItem, imp: ImportHints | null): Promise<void> => {
      const noteTitle = n.title?.trim() || null
      const facts = titleFacts(noteTitle ?? '')
      const lessonHint = imp?.lessonFromTitle ?? facts.lesson ?? imp?.lessonFromFolder ?? null
      const push = (reason: BackfillRow['reason'], drafts: SourceDraft[]): void => {
        counts[reason]++
        if (drafts.length) visible++
        // A scoped preview lists every note (the done screen counts the misses); an unscoped one keeps a bounded few.
        else if (!scoped && ++hidden > ROWS_MAX) return
        rows.push(rowOf(n.id, noteTitle, reason, drafts))
      }
      const withLessons = (drafts: SourceDraft[]): SourceDraft[] =>
        drafts.length === 1 && imp ? lessonChoices(drafts[0]!, imp.lessonFromTitle ?? facts.lesson, imp.lessonFromFolder) : drafts

      // 1. The importer's own source link(s): exact, no lookup.
      const sources = (imp?.candidates ?? []).filter((c) => c.role === 'source')
      const fromImport = sources
        .map((c) => (c.url ? parseSourceUrl(c.url) : null))
        .filter((p): p is NonNullable<typeof p> => !!p && !p.short)
        .map((p) => titled(draftFromUrl(p, { title: '', artist: null, durationMs: null, live: false }, 'exact', 'import', p.host), noteTitle ?? '', facts, lessonHint, imp?.series ?? facts.course))
      if (fromImport.length) {
        push('import-candidate', withLessons(dedupe(fromImport)))
        return
      }
      // 2. A known video or lesson URL in the note's text. An imported note uses its labelled links only.
      if (!imp) {
        const note = await ctx.storage.getNote(n.id).catch(() => null)
        if (!note || note.deleted_at) return
        const found = sourceUrls(`${note.notes_md ?? ''}\n${note.notes_text ?? ''}`, courseHosts).map((d) => titled(d, noteTitle ?? '', facts, lessonHint))
        if (found.length) {
          push('url-in-note', found)
          return
        }
      }
      // 3. The importer's series link: the series, the lesson pending or guessed.
      const seriesLink = (imp?.candidates ?? []).find((c) => c.role === 'series' && c.canonicalKey)
      const series = seriesLink ? seriesFromCandidate(seriesLink, imp?.series ?? facts.course) : null
      if (series && seriesLink) {
        const site = (() => {
          try {
            return normalizeHost(new URL(seriesLink.url).hostname)
          } catch {
            return null
          }
        })()
        push('import-series', withLessons([seriesGuess(facts.title || noteTitle || '', series, site, lessonHint)]))
        return
      }
      // 4. The title.
      if (facts.video) {
        if (!lookups) {
          lookupsSkipped = true
          push('no-match', [])
          return
        }
        // A title searched earlier this session is answered from identification's cache: it doesn't count.
        const searchKey = `${facts.title}\u0000${facts.channel ?? ''}`
        const fresh = !searched.has(searchKey)
        if (fresh && (searches >= SEARCHES_MAX || Date.now() - searchStarted > SEARCH_BUDGET_MS)) {
          searchesLeft++
          push('no-match', [])
          return
        }
        if (fresh) {
          searches++
          searched.add(searchKey)
        }
        const hits = await searchSources(ctx, facts.title, { channel: facts.channel, durationMs: null }).catch(() => [] as SourceDraft[])
        // An imported transcript's last anchor is a lower bound for the video's length.
        const fits = hits.filter((h) => !(imp?.lastAnchorMs != null && h.durationMs !== null && h.durationMs < imp.lastAnchorMs))
        const best = fits.find((h) => h.confidence === 'high') ?? fits[0]
        if (best) push('title-search', [{ ...best, detectedVia: 'backfill', confidence: best.confidence === 'high' ? 'high' : 'guess' }])
        else push('no-match', [])
        return
      }
      if (facts.lessonLike && (facts.course || imp?.series)) {
        const name = (imp?.series ?? facts.course)!.trim()
        const hint: SeriesHint = { kind: 'course', provider: 'web', canonicalKey: `title:course:${titleKey(name)}`, title: name, index: null, section: null }
        push('title-search', withLessons([seriesGuess(facts.title || noteTitle || '', hint, null, lessonHint)]))
        return
      }
      // A scoped preview lists every note of the batch, so the done screen can say what was missed.
      if (scoped || facts.lessonLike) push('no-match', [])
    }

    /** One page of notes; true when the preview filled up before the page ended. */
    const page = async (notes: NoteListItem[]): Promise<boolean> => {
      const has = await linked(notes.map((n) => n.id))
      const open = notes.filter((n) => !has.has(n.id))
      const imports = new Map<string, ImportHints>()
      for (let i = 0; i < open.length; i += SCOPE_MAX) {
        for (const r of await ctx.storage.getImportCandidates(open.slice(i, i + SCOPE_MAX).map((n) => n.id))) imports.set(r.noteId, importHints(r))
      }
      for (const n of open) {
        if (visible >= ROWS_MAX) return true
        scanned++
        await consider(n, imports.get(n.id) ?? null)
      }
      return false
    }

    if (scope) await page((await ctx.storage.queryNotes({ ids: scope })).filter((n) => !n.is_shared))
    else {
      // Newest first, page by page: `to` is inclusive, so a page's last second is read again and deduplicated.
      const seen = new Set<string>()
      let to: string | undefined
      for (let p = 0; ; p++) {
        const batch = await ctx.storage.queryNotes({ order: 'newest', limit: SCAN_MAX, ...(to ? { to } : {}) })
        const fresh = batch.filter((n) => !seen.has(n.id))
        for (const n of fresh) seen.add(n.id)
        if (await page(fresh.filter((n) => !n.is_shared))) {
          more = true
          break
        }
        if (batch.length < SCAN_MAX || fresh.length === 0) break
        if (p + 1 >= SCAN_PAGES) {
          more = true
          break
        }
        to = new Date(batch[batch.length - 1]!.sort_epoch * 1000).toISOString()
      }
    }

    sweep()
    const previewId = randomUUID()
    previews.set(previewId, { rows, expiresAt: Date.now() + PREVIEW_TTL_MS })
    log('info', 'sources:backfill-preview', { scoped, scanned, rows: rows.length, visible, ...counts, searches, searchesLeft, lookupsSkipped, more })
    return { previewId, rows, lookupsSkipped, ...(searchesLeft ? { searchesLeft } : {}), ...(more ? { moreLeft: true } : {}) }
  }

  async function apply(raw: unknown): Promise<InvokeRes<'sources:backfill-apply'>> {
    await requireActive()
    const req = (raw ?? {}) as { previewId?: unknown; rowIds?: unknown; choices?: unknown }
    if (typeof req.previewId !== 'string') throw notulaError('invalid-input', 'previewId is required')
    const state = previews.get(req.previewId)
    if (!state || state.expiresAt <= Date.now()) throw notulaError('not-found', 'This preview has expired. Find sources again.')
    const rowIds = idList(req.rowIds, 'rowIds', ROWS_MAX)
    const choices = req.choices && typeof req.choices === 'object' && !Array.isArray(req.choices) ? (req.choices as Record<string, unknown>) : {}
    const byId = new Map(state.rows.map((r) => [r.id, r]))
    const applied: AppliedRow[] = []
    let skipped = 0
    for (const rowId of rowIds) {
      const row = byId.get(rowId)
      if (!row) {
        skipped++
        continue
      }
      const pick = choices[rowId]
      const draft = typeof pick === 'number' && Number.isInteger(pick) ? row.choices[pick] : (row.proposal ?? undefined)
      if (!draft) {
        skipped++
        continue
      }
      try {
        const note = await ctx.storage.getNote(row.noteId)
        // Linked meanwhile (by hand, a card, an earlier apply): never replaced here.
        if (!note || note.deleted_at || (await ctx.storage.getNoteSource(row.noteId))) {
          skipped++
          continue
        }
        const source = await linkDraft(row.noteId, draft)
        applied.push({ noteId: row.noteId, sourceId: source.id, canonicalKey: source.canonical_key, fingerprint: fingerprint(source) })
      } catch (err) {
        skipped++
        log('warn', 'sources:backfill-row-failed', { err })
      }
    }
    previews.delete(req.previewId)
    const batchId = randomUUID()
    if (applied.length) {
      batches.set(batchId, applied)
      while (batches.size > BATCHES_KEPT) {
        const oldest = batches.keys().next().value
        if (oldest === undefined) break
        batches.delete(oldest)
      }
    }
    log('info', 'sources:backfill-applied', { applied: applied.length, skipped })
    return { batchId, applied: applied.length }
  }

  /** The source row of a draft, with its series and lesson (the series catalog wins over a guessed number). */
  async function linkDraft(noteId: string, draft: SourceDraft) {
    const hint = seriesHintOf(draft)
    let seriesId: string | null = null
    let lesson: LessonFields = draft.lesson
      ? { lesson_number: draft.lesson.number, lesson_label: draft.lesson.label, lesson_state: draft.lesson.state, lesson_origin: null }
      : { lesson_number: null, lesson_label: null, lesson_state: 'pending', lesson_origin: null }
    if (hint) {
      const title = hint.title?.trim() || (hint.kind === 'channel' ? draft.channel?.trim() : null) || draft.site || 'Untitled series'
      let { series } = await ctx.storage.upsertSeries({ kind: hint.kind, provider: hint.provider, canonical_key: hint.canonicalKey, title })
      // A series an earlier link named after the site takes the course's name.
      if (hint.title?.trim() && series.kind !== 'channel' && series.title !== hint.title.trim() && (series.title === draft.site || series.title === 'Untitled series')) {
        series = await ctx.storage.updateSeries(series.id, { title: hint.title.trim() })
      }
      seriesId = series.id
      if (series.kind !== 'channel') {
        const r = await resolveLesson(ctx, series.id, draft).catch(() => null)
        if (r && (r.state === 'numbered' || lesson.lesson_number === null)) {
          lesson = { lesson_number: r.number, lesson_label: r.label, lesson_state: r.state, lesson_origin: r.origin }
        }
      }
    }
    return ctx.storage.createNoteSource({
      note_id: noteId,
      kind: draft.kind,
      provider: draft.provider,
      canonical_key: draft.canonicalKey,
      url: draft.url,
      title: draft.title,
      channel: draft.channel,
      duration_ms: draft.durationMs,
      live: draft.live,
      series_id: seriesId,
      ...lesson,
      confidence: draft.confidence,
      detected_via: draft.detectedVia === 'import' ? 'import' : 'backfill',
      generated_title: null
    })
  }

  async function undo(raw: unknown): Promise<InvokeRes<'sources:backfill-undo'>> {
    const batchId = (raw as { batchId?: unknown } | null)?.batchId
    if (typeof batchId !== 'string' || !batchId) throw notulaError('invalid-input', 'batchId is required')
    const rows = batches.get(batchId)
    if (!rows) throw notulaError('not-found', 'This batch was already undone, or it’s from an earlier session.')
    batches.delete(batchId)
    let reverted = 0
    for (const r of rows) {
      const cur = await ctx.storage.getNoteSource(r.noteId).catch(() => null)
      // Only a source this batch added and nobody changed since.
      if (!cur || cur.id !== r.sourceId || cur.canonical_key !== r.canonicalKey || fingerprint(cur) !== r.fingerprint) continue
      // Nor one in use since: unlinking deletes its watch spans and stamped notes.
      if (cur.notes_md_stamped !== null) continue
      if ((await ctx.storage.listSourceSpans(r.noteId).catch(() => [{}])).length > 0) continue
      if (await ctx.storage.deleteNoteSource(r.noteId).catch(() => false)) reverted++
    }
    log('info', 'sources:backfill-undone', { reverted, kept: rows.length - reverted })
    return { reverted }
  }

  ipcMain.handle('sources:backfill-preview' satisfies InvokeChannel, (_e, req: unknown): Promise<InvokeRes<'sources:backfill-preview'>> => preview(req))
  ipcMain.handle('sources:backfill-apply' satisfies InvokeChannel, (_e, req: unknown) => apply(req))
  ipcMain.handle('sources:backfill-undo' satisfies InvokeChannel, (_e, req: unknown) => undo(req))
}

function fingerprint(s: NoteSource): string {
  return JSON.stringify([s.url, s.title, s.channel, s.series_id, s.lesson_number, s.lesson_label])
}

function dedupe(drafts: SourceDraft[]): SourceDraft[] {
  const seen = new Set<string>()
  return drafts.filter((d) => (seen.has(d.canonicalKey) ? false : (seen.add(d.canonicalKey), true)))
}
