// SPDX-License-Identifier: Apache-2.0
// Identification of a playback.
//
// Stage `local` runs before the offer and uses local signals only: the tab strip, the address
// bar, a filtered temp copy of the browser History (when `sources.readHistory` is on), then the
// title-and-site fallback. Stage `lookup` runs after Take notes, Continue, the Link dialog or
// backfill, with `sources.onlineLookups` on and egress allowed: yt-dlp search, oEmbed, enrichment.
// Logs carry step names and counts only.
//
// - History: only for a window known to be normal (never InPrivate/Incognito or unknown), and
//   only the playing window's profile (its title's profile name mapped through the browser's
//   `Local State`, or the only profile listed; otherwise skipped, never `Default` by guess).
//   Copied into `<userData>/tmp/source-history/`, queried for YouTube and course-host rows of
//   the last 24 h (`url`, `title`, `visit_time` as text), then deleted. The folder is swept at
//   startup. Retried every 1 s for 15 s while no row matches (rows land 0–3 s late), on the same
//   copy unless the source's size or mtime changed. A locked or unreadable copy skips History
//   for 60 s.
// - Network: every oEmbed fetch goes through the egress layer (`source-lookup`); every yt-dlp run
//   goes through `runYtDlp`, which checks egress before spawning. After 3 failed lookups in
//   10 min, oEmbed pauses for 30 min. Results are cached by canonical key or URL.
// - The pure rules (matching, verification, parsing, drafts) are in `src/main/media/match.ts`.

import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { cleanTitle, parseSourceUrl, titleKey, type ParsedSourceUrl } from '@shared/lib/source-key'
import type { BrowserId, IdentifyStep, Playback, SourceDraft, SourceEnrichment } from '@shared/types/sources'
import { SOURCES_LIMITS } from '@shared/types/sources'
import type { MainContext } from '../context'
import { log } from '../log'
import { mediaReader } from '../media/host'
import { isVideoSite } from '../media/lines'
import { locateTab } from '../media/locate'
import {
  draftFromUrl,
  guessDraft,
  historyHosts,
  matchHistory,
  parseOEmbed,
  parsePlaylist,
  parseSearch,
  parseVideoMeta,
  profileDirFor,
  queryHistoryRows,
  sameName,
  verifySearchHit,
  type HistoryMatch,
  type HistoryRow,
  type SearchHit,
  type VideoMeta
} from '../media/match'
import { egressFetch } from '../net/egress'
import { egressBlocked } from '../privacy'
import { runYtDlp } from './tools'

export interface IdentifyOptions {
  stage: 'local' | 'lookup'
  /** `lookup`: the draft from the local stage, to verify and enrich. */
  draft?: SourceDraft | null
  signal?: AbortSignal
}

export interface Identification {
  draft: SourceDraft
  /** In the order they ran. */
  steps: IdentifyStep[]
  /** `lookup` only. */
  enrichment: SourceEnrichment | null
}

const HISTORY_WINDOW_MS = 24 * 60 * 60_000
const HISTORY_RETRY_MS = 1_000
const HISTORY_RETRY_FOR_MS = 15_000
const HISTORY_LOCKED_SKIP_MS = 60_000
const HISTORY_ROW_LIMIT = 2_000
const LOCAL_STATE_MAX_BYTES = 8 * 1024 * 1024
const OEMBED_TIMEOUT_MS = 8_000
const OEMBED_MAX_BYTES = 64 * 1024
const CACHE_TTL_MS = 24 * 60 * 60_000
const SEARCH_CACHE_TTL_MS = 60 * 60_000
const CACHE_MAX = 200
const LOOKUP_FAILURES_TO_PAUSE = 3
const LOOKUP_FAILURE_WINDOW_MS = 10 * 60_000
const LOOKUP_PAUSE_MS = 30 * 60_000
const PLAYLIST_MAX_ITEMS = SOURCES_LIMITS.catalogItems

/** Each browser's `User Data` folder under `%LOCALAPPDATA%`. */
const USER_DATA: Readonly<Record<BrowserId, string[]>> = {
  edge: ['Microsoft', 'Edge', 'User Data'],
  chrome: ['Google', 'Chrome', 'User Data'],
  brave: ['BraveSoftware', 'Brave-Browser', 'User Data']
}

let historySkipUntil = 0
let lookupPausedUntil = 0
const lookupFailures: number[] = []
/** Same-title History alternatives by playback id, for oEmbed's channel check after Take notes. */
const alternatives = new Map<string, ParsedSourceUrl[]>()
const metaCache = new Map<string, { at: number; meta: VideoMeta }>()
const oembedCache = new Map<string, { at: number; value: { title: string | null; channel: string | null } | 'not-found' }>()
const searchCache = new Map<string, { at: number; hits: SearchHit[] }>()

function cacheGet<V>(m: Map<string, { at: number } & V>, key: string, ttl: number): ({ at: number } & V) | null {
  const e = m.get(key)
  if (!e) return null
  if (Date.now() - e.at > ttl) {
    m.delete(key)
    return null
  }
  return e
}

function cacheSet<V>(m: Map<string, V>, key: string, value: V): void {
  m.delete(key)
  m.set(key, value)
  while (m.size > CACHE_MAX) {
    const oldest = m.keys().next().value
    if (oldest === undefined) break
    m.delete(oldest)
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve()
      return
    }
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(t)
      resolve()
    })
  })
}

// ---------- History (step 3) ----------

function historyTempDir(ctx: Pick<MainContext, 'userDataPath'>): string {
  return join(ctx.userDataPath, 'tmp', 'source-history')
}

/** Removes History copies a crash left behind. Runs at every startup. */
export async function sweepHistoryCopies(ctx: Pick<MainContext, 'userDataPath'>): Promise<void> {
  try {
    await rm(historyTempDir(ctx), { recursive: true, force: true })
  } catch (err) {
    log('warn', 'sources:history-sweep-failed', { code: (err as NodeJS.ErrnoException).code ?? null })
  }
}

function userDataDir(browser: BrowserId): string | null {
  const base = process.env['LOCALAPPDATA']
  return base ? join(base, ...USER_DATA[browser]) : null
}

/**
 * The window's profile folder: its name mapped through `Local State`, or the only profile listed.
 * Null when it can't be mapped: History is then skipped, never read from another profile.
 */
async function profileDir(root: string, profileName: string | null): Promise<string | null> {
  try {
    const p = join(root, 'Local State')
    if ((await stat(p)).size > LOCAL_STATE_MAX_BYTES) return null
    return profileDirFor(JSON.parse(await readFile(p, 'utf8')), profileName)
  } catch {
    return null
  }
}

const HISTORY_EXTRAS = ['-journal', '-wal'] as const

/** Size and mtime of the History file and its journal/WAL: a copy is made again only when they change. */
async function historySignature(source: string): Promise<string> {
  const parts: string[] = []
  for (const ext of ['', ...HISTORY_EXTRAS]) {
    try {
      const st = await stat(source + ext)
      parts.push(`${st.size}:${st.mtimeMs}`)
    } catch {
      parts.push('-')
    }
  }
  return parts.join('|')
}

async function removeHistoryCopy(base: string): Promise<void> {
  for (const ext of ['', ...HISTORY_EXTRAS, '-shm']) await rm(base + ext, { force: true }).catch(() => undefined)
}

interface HistoryCopy {
  /** The matching rows; null when History can't be read now. */
  rows: () => Promise<HistoryRow[] | null>
  copies: () => number
  dispose: () => Promise<void>
}

/**
 * One temp copy of a profile's History for one playback's History step. `rows()` copies again
 * only when the source's size or mtime changed since the last copy, else re-queries the copy it
 * has. `dispose()` deletes it. The copy is opened read-write on purpose: a copied hot journal is
 * then rolled back into the copy (never the live file), which gives a consistent snapshot; a
 * read-only open would refuse such a copy.
 */
function historyCopy(ctx: MainContext, source: string, hosts: readonly string[]): HistoryCopy {
  const dir = historyTempDir(ctx)
  let base: string | null = null
  let signature: string | null = null
  let copies = 0
  return {
    copies: () => copies,
    async rows() {
      try {
        const now = await historySignature(source)
        if (base === null || now !== signature) {
          if (base !== null) await removeHistoryCopy(base)
          base = join(dir, `h-${randomUUID()}`)
          signature = null
          await mkdir(dir, { recursive: true })
          await copyFile(source, base)
          for (const ext of HISTORY_EXTRAS) if (existsSync(source + ext)) await copyFile(source + ext, base + ext).catch(() => undefined)
          signature = now
          copies++
        }
        return await queryHistory(base, hosts)
      } catch (err) {
        // Locked, being written, or not a database: skip History for a while; never read the live file.
        historySkipUntil = Date.now() + HISTORY_LOCKED_SKIP_MS
        const code = (err as { code?: unknown }).code
        log('warn', 'sources:history-unreadable', { code: typeof code === 'string' ? code : null })
        return null
      }
    },
    async dispose() {
      if (base !== null) await removeHistoryCopy(base)
      base = null
    }
  }
}

/** The query on a copy (`queryHistoryRows`), the last 24 h. */
async function queryHistory(path: string, hosts: readonly string[]): Promise<HistoryRow[]> {
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(path, { timeout: 1_000 })
  try {
    return queryHistoryRows(db, hosts, Date.now() - HISTORY_WINDOW_MS, HISTORY_ROW_LIMIT)
  } finally {
    db.close()
  }
}

async function historyStep(
  ctx: MainContext,
  playback: Playback,
  site: string | null,
  profileName: string | null,
  signal?: AbortSignal
): Promise<HistoryMatch | null> {
  if (Date.now() < historySkipUntil) return null
  const root = userDataDir(playback.browser)
  if (!root) return null
  const dir = await profileDir(root, profileName)
  if (!dir) {
    log('info', 'sources:history', { mapped: false, skipped: 'profile-unknown' })
    return null
  }
  const source = join(root, dir, 'History')
  if (!existsSync(source)) return null
  const courseHosts = await ctx.settings.get('sources.courseHosts')
  const hosts = historyHosts(courseHosts)
  const seenAtMs = playback.seenAt ?? Date.now() - playback.playedMs
  const until = Date.now() + HISTORY_RETRY_FOR_MS
  const t0 = Date.now()
  const copy = historyCopy(ctx, source, hosts)
  let attempts = 0
  try {
    for (;;) {
      attempts++
      const rows = await copy.rows()
      if (!rows) return null
      const m = matchHistory(rows, { title: playback.title, site, seenAtMs, courseHosts })
      if (m) {
        log('info', 'sources:history', { rows: rows.length, attempts, copies: copy.copies(), how: m.how, ids: 1 + m.alternatives.length, mapped: true, ms: Date.now() - t0 })
        return m
      }
      if (Date.now() + HISTORY_RETRY_MS > until || signal?.aborted) {
        log('info', 'sources:history', { rows: rows.length, attempts, copies: copy.copies(), how: null, ids: 0, mapped: true, ms: Date.now() - t0 })
        return null
      }
      await sleep(HISTORY_RETRY_MS, signal)
    }
  } finally {
    await copy.dispose()
  }
}

// ---------- network lookups (steps 5–7) ----------

function lookupFailed(): void {
  const now = Date.now()
  lookupFailures.push(now)
  while (lookupFailures.length && now - (lookupFailures[0] ?? 0) > LOOKUP_FAILURE_WINDOW_MS) lookupFailures.shift()
  if (lookupFailures.length >= LOOKUP_FAILURES_TO_PAUSE) {
    lookupPausedUntil = now + LOOKUP_PAUSE_MS
    lookupFailures.length = 0
    log('warn', 'sources:lookups-paused', { minutes: LOOKUP_PAUSE_MS / 60_000 })
  }
}

/** Lookups granted, the Labs switch on, egress allowed. */
async function lookupsAllowed(ctx: MainContext): Promise<boolean> {
  if (process.platform !== 'win32') return false
  if (!(await ctx.settings.get('sources.enabled')) || !(await ctx.settings.get('sources.onlineLookups'))) return false
  return !(await egressBlocked(ctx, { kind: 'source-lookup' }))
}

function oembedEndpoint(parsed: ParsedSourceUrl): string | null {
  if (parsed.provider === 'youtube') return `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(parsed.url)}`
  if (parsed.provider === 'vimeo') return `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(parsed.url)}`
  return null
}

/** Title and channel of a URL; `not-found` for a removed or private video; null on a failure. */
async function oembed(ctx: MainContext, parsed: ParsedSourceUrl, signal?: AbortSignal): Promise<{ title: string | null; channel: string | null } | 'not-found' | null> {
  const endpoint = oembedEndpoint(parsed)
  if (!endpoint) return null
  const hit = cacheGet(oembedCache, parsed.url, CACHE_TTL_MS)
  if (hit) return hit.value
  if (Date.now() < lookupPausedUntil) return null
  const timeout = AbortSignal.timeout(OEMBED_TIMEOUT_MS)
  try {
    const res = await egressFetch(ctx, { kind: 'source-lookup' }, endpoint, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout }, 'sources:oembed')
    if (res.status === 401 || res.status === 403 || res.status === 404) {
      void res.body?.cancel().catch(() => undefined)
      cacheSet(oembedCache, parsed.url, { at: Date.now(), value: 'not-found' as const })
      return 'not-found'
    }
    if (!res.ok) {
      void res.body?.cancel().catch(() => undefined)
      lookupFailed()
      return null
    }
    const text = (await res.text()).slice(0, OEMBED_MAX_BYTES)
    const value = parseOEmbed(text)
    if (value) cacheSet(oembedCache, parsed.url, { at: Date.now(), value })
    return value
  } catch {
    if (!signal?.aborted) lookupFailed()
    return null
  }
}

async function ytSearch(ctx: MainContext, query: string, signal?: AbortSignal): Promise<SearchHit[] | null> {
  const q = query.replace(/\s+/g, ' ').trim().slice(0, 300)
  if (!q) return []
  const hit = cacheGet(searchCache, q.toLowerCase(), SEARCH_CACHE_TTL_MS)
  if (hit) return hit.hits
  const r = await runYtDlp(ctx, {
    purpose: 'search',
    args: ['-J', '--flat-playlist', '--no-warnings', `ytsearch${SOURCES_LIMITS.searchResults}:${q}`],
    signal
  })
  if (!r.ok) return null
  const hits = parseSearch(r.stdout)
  cacheSet(searchCache, q.toLowerCase(), { at: Date.now(), hits })
  return hits
}

async function ytMeta(ctx: MainContext, parsed: ParsedSourceUrl, signal?: AbortSignal): Promise<VideoMeta | null> {
  const hit = cacheGet(metaCache, parsed.canonicalKey, CACHE_TTL_MS)
  if (hit) return hit.meta
  const id = parsed.canonicalKey.slice('youtube:'.length)
  const r = await runYtDlp(ctx, {
    purpose: 'metadata',
    args: ['-J', '--no-playlist', '--skip-download', '--no-warnings', `https://www.youtube.com/watch?v=${id}`],
    signal
  })
  if (!r.ok) return null
  const meta = parseVideoMeta(r.stdout, new Date().toISOString())
  if (meta) cacheSet(metaCache, parsed.canonicalKey, { at: Date.now(), meta })
  return meta
}

async function ytPlaylist(ctx: MainContext, listId: string, videoId: string, signal?: AbortSignal): Promise<{ id: string; title: string | null; index: number | null } | null> {
  const r = await runYtDlp(ctx, {
    purpose: 'metadata',
    args: ['-J', '--flat-playlist', '--no-warnings', '--playlist-end', String(PLAYLIST_MAX_ITEMS), `https://www.youtube.com/playlist?list=${listId}`],
    signal
  })
  return r.ok ? parsePlaylist(r.stdout, videoId) : null
}

// ---------- the stages ----------

async function identifyLocal(ctx: MainContext, playback: Playback, signal?: AbortSignal): Promise<Identification | null> {
  const title = playback.title.trim()
  if (!title) return null
  const steps: IdentifyStep[] = []
  // Provider precedence: the extension's facts win.
  if (playback.provider === 'extension') {
    steps.push('extension')
    const parsed = playback.url ? parseSourceUrl(playback.url) : null
    return { draft: parsed ? draftFromUrl(parsed, playback, 'exact', 'extension', playback.site) : guessDraft(playback, playback.site), steps, enrichment: null }
  }
  // 1. Tab (and the window: InPrivate, profile, site). The window read at the debounce already
  // gave an address for this title, so the tab is read again only when it didn't.
  steps.push('tab')
  const tab = playback.provider === 'media-session' && !playback.url ? await locateTab(playback.browser, title, true) : null
  const site = tab?.site ?? playback.site
  const privateWindow = tab ? tab.privateWindow : playback.privateWindow
  // 2. Address bar of the playing tab, only when it is the selected one.
  const url = tab?.url ?? playback.url
  if (url) {
    steps.push('address-bar')
    const parsed = parseSourceUrl(url)
    if (parsed) return { draft: draftFromUrl(parsed, playback, 'exact', 'media-session', site), steps, enrichment: null }
  }
  // 3. History: only for a window known to be normal; an InPrivate or unknown window is never read.
  if (privateWindow === false && (await ctx.settings.get('sources.readHistory'))) {
    steps.push('history')
    const m = await historyStep(ctx, playback, site, tab?.profileName ?? null, signal)
    if (m) {
      if (m.alternatives.length) {
        alternatives.set(playback.id, m.alternatives)
        while (alternatives.size > 50) {
          const oldest = alternatives.keys().next().value
          if (oldest === undefined) break
          alternatives.delete(oldest)
        }
      }
      return { draft: draftFromUrl(m.parsed, playback, m.confidence, 'history', site), steps, enrichment: null }
    }
  }
  // 4. Title and site only.
  steps.push('fallback')
  return { draft: guessDraft(playback, site), steps, enrichment: null }
}

async function identifyLookup(ctx: MainContext, playback: Playback, local: SourceDraft, signal?: AbortSignal): Promise<Identification> {
  const steps: IdentifyStep[] = []
  if (!(await lookupsAllowed(ctx))) return { draft: local, steps, enrichment: null }
  let draft: SourceDraft = { ...local }
  const q = { channel: playback.artist ?? draft.channel, durationMs: playback.durationMs ?? draft.durationMs, live: playback.live || draft.live }

  // 5. Search: only without a URL, on a YouTube-like site.
  if (!draft.url && (draft.provider === 'youtube' || isVideoSite(draft.site) || draft.site === null)) {
    steps.push('search')
    const hits = await ytSearch(ctx, `${cleanTitle(playback.title || draft.title)} ${q.channel ?? ''}`, signal)
    for (const hit of hits ?? []) {
      const confidence = verifySearchHit(hit, q)
      const parsed = confidence ? parseSourceUrl(hit.url) : null
      if (!confidence || !parsed) continue
      draft = { ...draftFromUrl(parsed, { ...playback, title: playback.title || draft.title }, confidence, 'search', draft.site ?? 'youtube.com'), channel: hit.channel ?? q.channel }
      break
    }
  }

  // 6. Verify with oEmbed; several same-title History ids are told apart by channel.
  const parsed = draft.url ? parseSourceUrl(draft.url) : null
  if (parsed && oembedEndpoint(parsed)) {
    steps.push('verify')
    const alts = alternatives.get(playback.id) ?? []
    if (alts.length && q.channel) {
      const byChannel: ParsedSourceUrl[] = []
      for (const c of [parsed, ...alts]) {
        const o = await oembed(ctx, c, signal)
        if (o && o !== 'not-found' && sameName(o.channel, q.channel)) byChannel.push(c)
      }
      const only = byChannel.length === 1 ? byChannel[0] : undefined
      if (only && only.canonicalKey !== parsed.canonicalKey) draft = { ...draftFromUrl(only, playback, 'high', 'history', draft.site), channel: draft.channel }
    } else {
      const o = await oembed(ctx, parsed, signal)
      if (o && o !== 'not-found') {
        if (!draft.channel && o.channel) draft = { ...draft, channel: o.channel }
        // A link by URL carries the URL as its title until oEmbed names the video.
        if ((!draft.title || /^https?:\/\//i.test(draft.title)) && o.title) draft = { ...draft, title: o.title }
      }
    }
  }

  // 7. Enrich: YouTube metadata, and the playlist's title and position.
  let enrichment: SourceEnrichment | null = null
  const final = draft.url ? parseSourceUrl(draft.url) : null
  if (final && final.provider === 'youtube') {
    steps.push('enrich')
    const meta = await ytMeta(ctx, final, signal)
    if (meta) {
      enrichment = { ...meta.enrichment, chapters: [...meta.enrichment.chapters], captionTracks: [...meta.enrichment.captionTracks] }
      const live = draft.live || meta.live
      draft = {
        ...draft,
        live,
        kind: live ? 'live' : draft.kind,
        durationMs: live ? null : (draft.durationMs ?? meta.durationMs),
        channel: draft.channel ?? meta.channel
      }
    } else {
      enrichment = { state: 'failed', checkedAt: new Date().toISOString(), chapters: [], captionTracks: [], language: null, descriptionLinks: [], playlist: null }
    }
    const series = draft.series
    if (series?.kind === 'playlist') {
      const listId = series.canonicalKey.slice('youtube:playlist:'.length)
      const pl = await ytPlaylist(ctx, listId, final.canonicalKey.slice('youtube:'.length), signal)
      if (pl) {
        if (enrichment) enrichment = { ...enrichment, playlist: pl }
        const index = pl.index ?? series.index
        draft = {
          ...draft,
          series: { ...series, title: pl.title ?? series.title, index },
          lesson: index ? { number: index, label: null, state: 'numbered' } : draft.lesson
        }
      }
    }
  }
  return { draft, steps, enrichment }
}

/** Null = not identified (nothing to offer). */
export async function identify(ctx: MainContext, playback: Playback, opts: IdentifyOptions): Promise<Identification | null> {
  if (process.platform !== 'win32' || !(await ctx.settings.get('sources.enabled'))) return null
  const t0 = Date.now()
  let result: Identification | null
  try {
    if (opts.stage === 'local') {
      result = await identifyLocal(ctx, playback, opts.signal)
    } else {
      const local = opts.draft ?? (await identifyLocal(ctx, playback, opts.signal))?.draft ?? null
      result = local ? await identifyLookup(ctx, playback, local, opts.signal) : null
    }
  } catch (err) {
    log('warn', 'sources:identify-failed', { stage: opts.stage, name: err instanceof Error ? err.name : 'error' })
    return null
  }
  const last = result?.steps.at(-1)
  if (last) mediaReader.setLastStep(last)
  log('info', 'sources:identify', {
    stage: opts.stage,
    steps: result?.steps ?? [],
    confidence: result?.draft.confidence ?? null,
    enriched: result?.enrichment?.state ?? null,
    ms: Date.now() - t0
  })
  return result
}

/**
 * The Link dialog's Search by title and backfill: up to 3 drafts for a free-text title, with the
 * same acceptance rules. Empty when lookups aren't granted or egress is blocked.
 */
export async function searchSources(ctx: MainContext, query: string, opts: { channel?: string | null; durationMs?: number | null; signal?: AbortSignal } = {}): Promise<SourceDraft[]> {
  const q = query.replace(/\s+/g, ' ').trim().slice(0, 300)
  if (!q || !(await lookupsAllowed(ctx))) return []
  // A pasted URL: recognised at once, confirmed by oEmbed when the provider has one.
  const asUrl = /^https?:\/\//i.test(q) ? parseSourceUrl(q) : null
  if (asUrl) {
    const o = await oembed(ctx, asUrl, opts.signal)
    const facts = o && o !== 'not-found' ? o : { title: null, channel: null }
    const draft = draftFromUrl(asUrl, { title: facts.title ?? q, artist: facts.channel, durationMs: null, live: false }, 'exact', 'manual', asUrl.host)
    log('info', 'sources:search', { kind: 'url', results: 1 })
    return [draft]
  }
  const hits = await ytSearch(ctx, opts.channel ? `${q} ${opts.channel}` : q, opts.signal)
  const drafts: SourceDraft[] = []
  for (const hit of (hits ?? []).slice(0, SOURCES_LIMITS.searchResults)) {
    const parsed = parseSourceUrl(hit.url)
    if (!parsed) continue
    let confidence = opts.channel || opts.durationMs != null ? verifySearchHit(hit, { channel: opts.channel ?? null, durationMs: opts.durationMs ?? null, live: hit.live }) : null
    // yt-dlp may return machine-translated titles: oEmbed gives the original one.
    const o = await oembed(ctx, parsed, opts.signal)
    const facts = o && o !== 'not-found' ? o : null
    // Without a duration (backfill): `high` only when oEmbed's title and channel both match.
    if (!confidence && opts.channel && facts?.title && titleKey(facts.title) === titleKey(q) && sameName(facts.channel, opts.channel)) confidence = 'high'
    confidence ??= 'guess'
    drafts.push(
      draftFromUrl(parsed, { title: facts?.title ?? hit.title, artist: facts?.channel ?? hit.channel, durationMs: hit.durationMs, live: hit.live }, confidence, 'search', 'youtube.com')
    )
  }
  log('info', 'sources:search', { kind: 'title', results: drafts.length, failed: hits === null })
  return drafts
}
