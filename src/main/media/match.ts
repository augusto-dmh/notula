// SPDX-License-Identifier: Apache-2.0
// The pure half of identification: History rows → a match, yt-dlp output → search
// hits and enrichment, a playback + URL → a SourceDraft, a window profile → a History profile.
// No I/O and no Electron (the History query runs on a database the caller opened), so the dev
// harness (scripts/dev/media-replay.mjs) runs it on fixtures.
// `src/main/sources/identify.ts` does the reading, copying, spawning and fetching.

import type { DatabaseSync } from 'node:sqlite'
import { BUILTIN_COURSE_HOSTS, cleanTitle, guessKey, hostIs, parseSourceUrl, titleKey, type ParsedSourceUrl } from '@shared/lib/source-key'
import type { CaptionTrack, Playback, SeriesHint, SourceConfidence, SourceDetectedVia, SourceDraft, SourceEnrichment, SourceKind, SourceProvider } from '@shared/types/sources'

// ---------- History ----------

/** One History visit: Chromium's `visit_time` already converted to epoch ms. */
export interface HistoryRow {
  url: string
  title: string
  visitMs: number
}

/** Chromium time is microseconds since 1601-01-01 UTC; it overflows a JS number, so it is read as text. */
const EPOCH_DELTA_US = 11_644_473_600_000_000n

export function chromiumToMs(text: string): number | null {
  if (!/^\d{1,20}$/.test(text)) return null
  return Number((BigInt(text) - EPOCH_DELTA_US) / 1000n)
}

export function msToChromium(ms: number): bigint {
  return BigInt(Math.max(0, Math.floor(ms))) * 1000n + EPOCH_DELTA_US
}

/** Hosts read in History: YouTube, the built-in course hosts and the user's (lower-case). */
export function historyHosts(courseHosts: readonly string[]): string[] {
  const hosts = new Set<string>(['youtube.com', 'youtu.be', ...BUILTIN_COURSE_HOSTS])
  for (const h of courseHosts) if (/^[a-z0-9.-]{1,253}$/.test(h)) hosts.add(h.replace(/^www\./, ''))
  return [...hosts]
}

/** `LIKE` patterns for those hosts and their subdomains, http and https. */
export function historyLikePatterns(hosts: readonly string[]): string[] {
  const out: string[] = []
  for (const h of hosts) for (const scheme of ['https', 'http']) out.push(`${scheme}://${h}/%`, `${scheme}://%.${h}/%`)
  return out
}

/**
 * True when `url` is http(s) and its host is one of `hosts` or a subdomain. The History query
 * filters with it (as a SQL function) after the `LIKE` prefilter, whose `%` can span a path or
 * query, so rows of other hosts never reach memory.
 */
export function historyHostOk(url: string, hosts: readonly string[]): boolean {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return false
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false
  return hosts.some((h) => hostIs(u.hostname, h))
}

/**
 * Step 3's query on a History copy: rows of the History hosts only (a `LIKE` prefilter, then
 * `historyHostOk` as the SQL function `host_ok`), visited after `sinceMs`, newest first.
 * `visit_time` is read as text (it overflows a JS number). The caller opens and closes `db`.
 */
export function queryHistoryRows(db: Pick<DatabaseSync, 'function' | 'prepare'>, hosts: readonly string[], sinceMs: number, limit: number): HistoryRow[] {
  db.function('host_ok', { deterministic: true }, (u) => (typeof u === 'string' && historyHostOk(u, hosts) ? 1 : 0))
  const patterns = historyLikePatterns(hosts)
  const where = patterns.map(() => 'u.url LIKE ?').join(' OR ')
  const rows = db
    .prepare(
      `SELECT u.url AS url, u.title AS title, CAST(v.visit_time AS TEXT) AS vt
       FROM visits v JOIN urls u ON u.id = v.url
       WHERE v.visit_time > ? AND (${where}) AND host_ok(u.url) = 1
       ORDER BY v.visit_time DESC LIMIT ${Math.max(1, Math.floor(limit))}`
    )
    .all(msToChromium(sinceMs), ...patterns)
  const out: HistoryRow[] = []
  for (const r of rows) {
    const visitMs = typeof r['vt'] === 'string' ? chromiumToMs(r['vt']) : null
    if (typeof r['url'] === 'string' && visitMs !== null) out.push({ url: r['url'], title: typeof r['title'] === 'string' ? r['title'] : '', visitMs })
  }
  return out
}

/** Course providers (time correlation applies to these and the user's hosts). */
const COURSE_PROVIDERS: ReadonlySet<SourceProvider> = new Set(['circle', 'udemy', 'coursera', 'hotmart', 'kiwify', 'memberkit'])

/** A History row's title for comparing: YouTube's ` - YouTube` and a course site's ` | <site>` dropped. */
function rowTitleKey(row: HistoryRow, p: ParsedSourceUrl): string {
  if (p.provider === 'youtube') return titleKey(row.title, 'YouTube')
  return titleKey(row.title.replace(/\s+\|\s+[^|]+$/, ''))
}

export interface HistoryMatch {
  parsed: ParsedSourceUrl
  confidence: SourceConfidence
  how: 'title' | 'time'
  /** Other keys with the same title (oEmbed disambiguates by channel after Take notes). */
  alternatives: ParsedSourceUrl[]
}

/** How far before the playback was first seen a lesson visit may be. */
export const TIME_CORRELATION_MS = 120_000
/** And how far after (the page loads, then the player starts; clocks differ slightly). */
const TIME_CORRELATION_AFTER_MS = 5_000

/**
 * Step 3's rules on rows already filtered to the History hosts and the last 24 h, newest first:
 * - normalized title equal to the playback's: one distinct key = `exact`, several = `high` on
 *   the newest (the rest are alternatives);
 * - course hosts only, when no title matches and the site isn't a video site: the newest lesson
 *   visit within 120 s before the playback was first seen, at `high`.
 */
export function matchHistory(
  rows: readonly HistoryRow[],
  q: { title: string; site: string | null; seenAtMs: number; courseHosts: readonly string[] }
): HistoryMatch | null {
  const want = titleKey(q.title, q.site === 'youtube.com' ? 'YouTube' : null)
  if (!want) return null
  const parsedRows = rows.flatMap((r) => {
    const p = parseSourceUrl(r.url)
    if (!p || (p.provider === 'web' && !q.courseHosts.some((h) => hostIs(p.host, h)))) return []
    return [{ r, p }]
  })
  const byKey = new Map<string, ParsedSourceUrl>()
  for (const { r, p } of parsedRows) {
    if (rowTitleKey(r, p) === want && !byKey.has(p.canonicalKey)) byKey.set(p.canonicalKey, p)
  }
  const keys = [...byKey.values()]
  if (keys.length > 0) {
    return { parsed: keys[0] as ParsedSourceUrl, confidence: keys.length === 1 ? 'exact' : 'high', how: 'title', alternatives: keys.slice(1, 3) }
  }
  if (q.site === 'youtube.com' || q.site === 'vimeo.com') return null
  const from = q.seenAtMs - TIME_CORRELATION_MS
  const to = q.seenAtMs + TIME_CORRELATION_AFTER_MS
  for (const { r, p } of parsedRows) {
    const course = COURSE_PROVIDERS.has(p.provider) || (p.provider === 'web' && q.courseHosts.some((h) => hostIs(p.host, h)))
    if (!course || p.kind !== 'lesson' || r.visitMs < from || r.visitMs > to) continue
    if (q.site && q.site.includes('.') && !hostIs(p.host, q.site) && !hostIs(q.site, p.host)) continue
    return { parsed: p, confidence: 'high', how: 'time', alternatives: [] }
  }
  return null
}

/**
 * `Local State` → the profile folder whose name is the window's profile. With exactly one
 * profile listed, that one (the window can't be in another). Null otherwise: History is then not
 * read, never another profile's.
 */
export function profileDirFor(localState: unknown, profileName: string | null): string | null {
  if (!localState || typeof localState !== 'object') return null
  const cache = (localState as { profile?: { info_cache?: unknown } }).profile?.info_cache
  if (!cache || typeof cache !== 'object') return null
  const entries = Object.entries(cache as Record<string, unknown>)
  const valid = (dir: string): boolean => /^(Default|Profile \d{1,3})$/.test(dir)
  if (profileName) {
    const want = profileName.trim().toLowerCase()
    for (const [dir, info] of entries) {
      if (!valid(dir)) continue
      const name = info && typeof info === 'object' ? (info as { name?: unknown }).name : null
      if (typeof name === 'string' && name.trim().toLowerCase() === want) return dir
    }
  }
  const only = entries.length === 1 ? entries[0]?.[0] : undefined
  return only !== undefined && valid(only) ? only : null
}

// ---------- drafts ----------

const SITE_PROVIDERS: Readonly<Record<string, SourceProvider>> = {
  'youtube.com': 'youtube',
  'vimeo.com': 'vimeo',
  'udemy.com': 'udemy',
  'coursera.org': 'coursera',
  'hotmart.com': 'hotmart',
  'kiwify.com.br': 'kiwify',
  'memberkit.com.br': 'memberkit'
}

export function providerOfSite(site: string | null): SourceProvider {
  if (!site) return 'web'
  for (const [domain, provider] of Object.entries(SITE_PROVIDERS)) if (hostIs(site, domain)) return provider
  return 'web'
}

/** A YouTube video with no playlist or course belongs to its channel's series. */
function channelSeries(provider: SourceProvider, channel: string | null): SeriesHint | null {
  if (provider !== 'youtube' || !channel) return null
  return { kind: 'channel', provider, canonicalKey: `youtube:channel:${channel.trim().toLowerCase()}`, title: channel.trim(), index: null, section: null }
}

/** A draft from a recognised URL and the playback that played it. */
export function draftFromUrl(
  parsed: ParsedSourceUrl,
  playback: Pick<Playback, 'title' | 'artist' | 'durationMs' | 'live'>,
  confidence: SourceConfidence,
  detectedVia: SourceDetectedVia,
  site: string | null
): SourceDraft {
  const live = playback.live || parsed.kind === 'live'
  const kind: SourceKind = live ? 'live' : parsed.kind
  const index = parsed.series?.kind === 'playlist' ? parsed.series.index : null
  return {
    canonicalKey: parsed.canonicalKey,
    provider: parsed.provider,
    kind,
    url: parsed.url,
    title: cleanTitle(playback.title),
    channel: playback.artist,
    durationMs: live ? null : playback.durationMs,
    live,
    confidence,
    detectedVia,
    site: parsed.host || site,
    series: parsed.series ?? channelSeries(parsed.provider, playback.artist),
    lesson: index ? { number: index, label: null, state: 'numbered' } : parsed.kind === 'lesson' ? { number: null, label: null, state: 'pending' } : null
  }
}

/** Step 4: title and site only. */
export function guessDraft(playback: Pick<Playback, 'title' | 'artist' | 'durationMs' | 'live'>, site: string | null): SourceDraft {
  const provider = providerOfSite(site)
  const course = COURSE_PROVIDERS.has(provider)
  return {
    canonicalKey: guessKey(site ?? 'unknown', cleanTitle(playback.title)),
    provider,
    kind: playback.live ? 'live' : course ? 'lesson' : 'video',
    url: null,
    title: cleanTitle(playback.title),
    channel: playback.artist,
    durationMs: playback.live ? null : playback.durationMs,
    live: playback.live,
    confidence: 'guess',
    detectedVia: 'media-session',
    site,
    series: channelSeries(provider, playback.artist),
    lesson: course ? { number: null, label: null, state: 'pending' } : null
  }
}

// ---------- yt-dlp output ----------

export interface SearchHit {
  id: string
  url: string
  title: string
  channel: string | null
  durationMs: number | null
  live: boolean
}

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function s(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

/** `yt-dlp -J --flat-playlist "ytsearchN:…"` → hits. */
export function parseSearch(json: string): SearchHit[] {
  let root: Record<string, unknown> | null
  try {
    root = obj(JSON.parse(json))
  } catch {
    return []
  }
  const entries = Array.isArray(root?.['entries']) ? (root['entries'] as unknown[]) : []
  const out: SearchHit[] = []
  for (const e of entries) {
    const o = obj(e)
    const id = s(o?.['id'])
    if (!o || !id || !/^[\w-]{11}$/.test(id)) continue
    const d = typeof o['duration'] === 'number' && Number.isFinite(o['duration']) ? Math.round(o['duration'] * 1000) : null
    out.push({
      id,
      url: `https://www.youtube.com/watch?v=${id}`,
      title: s(o['title']) ?? '',
      channel: s(o['channel']) ?? s(o['uploader']),
      durationMs: d,
      live: o['live_status'] === 'is_live' || o['live_status'] === 'is_upcoming'
    })
  }
  return out
}

export function sameName(a: string | null, b: string | null): boolean {
  return !!a && !!b && a.normalize('NFC').trim().toLowerCase() === b.normalize('NFC').trim().toLowerCase()
}

/** Duration tolerance of the search check. */
export const DURATION_TOLERANCE_MS = 2_000

/**
 * Step 5's acceptance: the hit's channel equals the artist and its duration is within ±2 s of
 * the playback's end → `high`. Live: channel only → `guess` (no duration to check).
 */
export function verifySearchHit(hit: SearchHit, q: { channel: string | null; durationMs: number | null; live: boolean }): SourceConfidence | null {
  if (!sameName(hit.channel, q.channel)) return null
  if (q.live) return 'guess'
  if (q.durationMs === null || hit.durationMs === null) return null
  return Math.abs(hit.durationMs - q.durationMs) <= DURATION_TOLERANCE_MS ? 'high' : null
}

/** Which of the hits match, for the Link dialog's rows. */
export function matchedFields(hit: SearchHit, q: { title?: string | null; channel?: string | null; durationMs?: number | null }): ('title' | 'channel' | 'duration')[] {
  const out: ('title' | 'channel' | 'duration')[] = []
  if (q.title && titleKey(hit.title) === titleKey(q.title)) out.push('title')
  if (q.channel && sameName(hit.channel, q.channel)) out.push('channel')
  if (q.durationMs != null && hit.durationMs != null && Math.abs(hit.durationMs - q.durationMs) <= DURATION_TOLERANCE_MS) out.push('duration')
  return out
}

export interface VideoMeta {
  title: string | null
  channel: string | null
  durationMs: number | null
  live: boolean
  enrichment: SourceEnrichment
}

const MAX_TRACKS = 40
const MAX_LINKS = 20
const MAX_CHAPTERS = 200

/** The video's own language: `en`, `pt-BR` → `pt`-family matching for auto captions. */
function baseLang(l: string): string {
  return l.toLowerCase().split(/[-_]/)[0] ?? ''
}

/**
 * `yt-dlp -J --no-playlist <url>` → duration, live, chapters, caption tracks (manual ones, and
 * auto ones only in the video's own language), description links.
 */
export function parseVideoMeta(json: string, checkedAt: string): VideoMeta | null {
  let o: Record<string, unknown> | null
  try {
    o = obj(JSON.parse(json))
  } catch {
    return null
  }
  if (!o) return null
  const language = s(o['language'])
  const tracks: CaptionTrack[] = []
  const subs = obj(o['subtitles'])
  if (subs) for (const lang of Object.keys(subs)) if (lang !== 'live_chat' && tracks.length < MAX_TRACKS) tracks.push({ lang, kind: 'manual', name: null, via: 'yt-dlp' })
  const auto = obj(o['automatic_captions'])
  if (auto && language) {
    const own = baseLang(language)
    for (const lang of Object.keys(auto)) {
      // `<lang>-orig` is the original track; plain `<lang>` may be a translation of it.
      if ((lang === `${language}-orig` || lang === language || baseLang(lang) === own) && tracks.length < MAX_TRACKS) {
        tracks.push({ lang, kind: 'asr', name: null, via: 'yt-dlp' })
      }
    }
  }
  const chapters = (Array.isArray(o['chapters']) ? (o['chapters'] as unknown[]) : []).flatMap((c) => {
    const x = obj(c)
    const start = x && typeof x['start_time'] === 'number' ? Math.round(x['start_time'] * 1000) : null
    return x && start !== null ? [{ startMs: start, title: (s(x['title']) ?? '').slice(0, 300) }] : []
  })
  const description = s(o['description']) ?? ''
  const links = [...new Set(description.match(/https?:\/\/[^\s<>"')\]]+/g) ?? [])].slice(0, MAX_LINKS)
  const live = o['is_live'] === true || o['live_status'] === 'is_live'
  const d = typeof o['duration'] === 'number' && Number.isFinite(o['duration']) ? Math.round(o['duration'] * 1000) : null
  return {
    title: s(o['title']),
    channel: s(o['channel']) ?? s(o['uploader']),
    durationMs: live ? null : d,
    live,
    enrichment: {
      state: 'done',
      checkedAt,
      chapters: chapters.slice(0, MAX_CHAPTERS),
      captionTracks: tracks,
      language,
      descriptionLinks: links,
      playlist: null
    }
  }
}

/** `yt-dlp --flat-playlist -J <playlist url>` → its title and the video's 1-based position. */
export function parsePlaylist(json: string, videoId: string): { id: string; title: string | null; index: number | null } | null {
  let o: Record<string, unknown> | null
  try {
    o = obj(JSON.parse(json))
  } catch {
    return null
  }
  const id = s(o?.['id'])
  if (!o || !id) return null
  const entries = Array.isArray(o['entries']) ? (o['entries'] as unknown[]) : []
  const i = entries.findIndex((e) => obj(e)?.['id'] === videoId)
  return { id, title: s(o['title']), index: i >= 0 ? i + 1 : null }
}

/** oEmbed's answer, reduced to what verification uses. */
export function parseOEmbed(json: string): { title: string | null; channel: string | null } | null {
  try {
    const o = obj(JSON.parse(json))
    return o ? { title: s(o['title']), channel: s(o['author_name']) } : null
  } catch {
    return null
  }
}

