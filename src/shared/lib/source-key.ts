// SPDX-License-Identifier: Apache-2.0
// Recognising a source from its URL, and canonical keys. Shared by
// identification, the Link dialog's URL field, backfill and the Markdown importer, so every
// surface computes the same key. Pure: no network, no Electron, no DOM, and type-only imports,
// so the dev harness (scripts/dev/media-replay.mjs) loads it directly.
//
// Keys: `youtube:<videoId>` · `circle:<host>:<lessonId>` · `udemy:<courseSlug>:<lectureId>` ·
// `coursera:<courseSlug>:<itemId>` · `url:<normalized URL>` (Vimeo, the producer-hosted course
// sites, anything else) · `title:<site>:<normalized title>` (a guess, no URL).

import type { CanonicalKey, SeriesHint, SourceKind, SourceProvider } from '../types/sources'

export interface ParsedSourceUrl {
  provider: SourceProvider
  kind: SourceKind
  canonicalKey: CanonicalKey
  /** The URL without tracking parameters, as stored. */
  url: string
  host: string
  /** `list=PL…` (mixes `RD…` skipped), or a course root. */
  series: SeriesHint | null
  /** A `t=` start offset. */
  startMs: number | null
  /** `/shorts/` URLs are never candidates. */
  short: boolean
}

const YT_ID = /^[\w-]{11}$/
const YT_HOSTS = new Set(['youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtube-nocookie.com'])
/** Personal or generated lists that are not a series: mixes, Watch later, Liked videos. */
const YT_NOT_SERIES = /^(RD|WL$|LL$|LM$)/
const CIRCLE_LESSON = /^\/c\/([^/]+)\/sections\/(\d+)\/lessons\/(\d+)\/?$/
const UDEMY_LECTURE = /^\/course\/([^/]+)\/learn\/lecture\/(\d+)\/?$/
const COURSERA_LECTURE = /^\/learn\/([^/]+)\/lecture\/([^/]+)(?:\/|$)/
const VIMEO_ID = /^\/(?:video\/)?(\d{3,12})(?:\/|$)/

/**
 * The course hosts History step 3 reads besides YouTube: the known course
 * providers' hosts. The user's `sources.courseHosts` add to these.
 */
export const BUILTIN_COURSE_HOSTS: readonly string[] = [
  // Circle's own host; communities on their own domains are added by the user.
  'circle.so',
  'udemy.com',
  'coursera.org',
  'hotmart.com',
  'kiwify.com.br',
  'kiwify.com',
  'memberkit.com.br'
]

/** Query parameters that only track; dropped from stored URLs. */
const TRACKING = /^(utm_\w+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|igshid|si|pp|feature|ab_channel|ref|ref_src|referrer|_ga|_gl|spm)$/i

/** `www.` dropped, lower-case. */
export function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/^www\./, '').replace(/\.$/, '')
}

/** True for `host` itself or one of its subdomains. */
export function hostIs(host: string, domain: string): boolean {
  const h = normalizeHost(host)
  return h === domain || h.endsWith(`.${domain}`)
}

/** `t=90`, `t=90s`, `t=1m30s`, `t=1h2m3s`, `start=90` → ms. */
function parseStart(raw: string | null): number | null {
  if (!raw) return null
  if (/^\d+(\.\d+)?$/.test(raw)) return Math.round(Number(raw) * 1000)
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(raw)
  if (!m || (!m[1] && !m[2] && !m[3])) return null
  return ((Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)) * 60 + Number(m[3] ?? 0)) * 1000
}

/** The URL with tracking parameters, the fragment and a trailing slash removed; params sorted. */
function normalizeUrl(u: URL): string {
  const params = [...u.searchParams.entries()].filter(([k]) => !TRACKING.test(k)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  const q = new URLSearchParams(params).toString()
  const path = u.pathname.length > 1 ? u.pathname.replace(/\/+$/, '') : ''
  return `https://${normalizeHost(u.hostname)}${u.port ? `:${u.port}` : ''}${path}${q ? `?${q}` : ''}`
}

function toUrl(raw: string): URL | null {
  const s = raw.trim()
  if (!s || s.length > 4096) return null
  // The address bar may drop the scheme (`youtube.com/watch?v=…`).
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : /^[\w-]+(\.[\w-]+)+(:\d+)?(\/|$)/.test(s) ? `https://${s}` : s
  try {
    const u = new URL(withScheme)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : null
  } catch {
    return null
  }
}

function youtube(u: URL, host: string): ParsedSourceUrl | null {
  let id: string | null = null
  let short = false
  let live = false
  if (host === 'youtu.be') {
    id = u.pathname.split('/')[1] ?? null
  } else {
    const parts = u.pathname.split('/').filter(Boolean)
    if (parts[0] === 'watch') id = u.searchParams.get('v')
    else if (parts[0] === 'shorts') {
      id = parts[1] ?? null
      short = true
    } else if (parts[0] === 'live') {
      id = parts[1] ?? null
      live = true
    } else if (parts[0] === 'embed' || parts[0] === 'v') id = parts[1] ?? null
  }
  if (!id || !YT_ID.test(id)) return null
  const list = u.searchParams.get('list')
  const rawIndex = Number(u.searchParams.get('index'))
  const index = Number.isInteger(rawIndex) && rawIndex > 0 ? rawIndex : null
  const series: SeriesHint | null =
    list && /^[\w-]{2,64}$/.test(list) && !YT_NOT_SERIES.test(list)
      ? { kind: 'playlist', provider: 'youtube', canonicalKey: `youtube:playlist:${list}`, title: null, index, section: null }
      : null
  const url = short
    ? `https://www.youtube.com/shorts/${id}`
    : `https://www.youtube.com/watch?v=${id}${series ? `&list=${list}${index ? `&index=${index}` : ''}` : ''}`
  return {
    provider: 'youtube',
    kind: live ? 'live' : 'video',
    canonicalKey: `youtube:${id}`,
    url,
    host: 'youtube.com',
    series,
    startMs: parseStart(u.searchParams.get('t') ?? u.searchParams.get('start')),
    short
  }
}

function course(
  provider: SourceProvider,
  key: CanonicalKey,
  url: string,
  host: string,
  seriesKey: CanonicalKey | null
): ParsedSourceUrl {
  return {
    provider,
    kind: 'lesson',
    canonicalKey: key,
    url,
    host,
    series: seriesKey ? { kind: 'course', provider, canonicalKey: seriesKey, title: null, index: null, section: null } : null,
    startMs: null,
    short: false
  }
}

/**
 * Null for anything that isn't an http(s) URL. Circle communities run on their own domains, so
 * the lesson path shape alone marks a Circle lesson, on any host.
 */
export function parseSourceUrl(url: string): ParsedSourceUrl | null {
  const u = toUrl(url)
  if (!u) return null
  const host = normalizeHost(u.hostname)
  if (host === 'youtu.be' || YT_HOSTS.has(host)) {
    // A YouTube page that names no video (a channel's `/@name/live`, its home page with the
    // trailer, search) is not a source: as a `url:` key it would stand for every stream of that
    // channel and skip the lookups.
    return youtube(u, host)
  }
  const path = u.pathname
  const circle = CIRCLE_LESSON.exec(path)
  if (circle) {
    const [, slug, section, lesson] = circle
    const page = `https://${host}/c/${slug}/sections/${section}/lessons/${lesson}`
    return course('circle', `circle:${host}:${lesson}`, page, host, `circle:${host}:course:${slug}`)
  }
  if (hostIs(host, 'udemy.com')) {
    const m = UDEMY_LECTURE.exec(path)
    if (m) {
      const [, slug, lecture] = m
      return course('udemy', `udemy:${slug}:${lecture}`, `https://${host}/course/${slug}/learn/lecture/${lecture}`, host, `udemy:course:${slug}`)
    }
  }
  if (hostIs(host, 'coursera.org')) {
    const m = COURSERA_LECTURE.exec(path)
    if (m) {
      const [, slug, item] = m
      return course('coursera', `coursera:${slug}:${item}`, `https://${host}/learn/${slug}/lecture/${item}`, host, `coursera:course:${slug}`)
    }
  }
  const norm = normalizeUrl(u)
  // Producer-hosted course sites: recognised by host only (no ids in the URL).
  for (const [domain, provider] of [
    ['hotmart.com', 'hotmart'],
    ['kiwify.com.br', 'kiwify'],
    ['kiwify.com', 'kiwify'],
    ['memberkit.com.br', 'memberkit']
  ] as const) {
    if (hostIs(host, domain)) return course(provider, `url:${norm}`, norm, host, null)
  }
  if (hostIs(host, 'vimeo.com')) {
    const m = VIMEO_ID.exec(path)
    if (m) {
      const page = `https://vimeo.com/${m[1]}`
      return { provider: 'vimeo', kind: 'video', canonicalKey: `url:${page}`, url: page, host: 'vimeo.com', series: null, startMs: null, short: false }
    }
  }
  return { provider: 'web', kind: 'other', canonicalKey: `url:${norm}`, url: norm, host, series: null, startMs: null, short: false }
}

/**
 * A playback or page title without a leading `(N) ` notification count and, when given, the
 * site suffix (` - YouTube`, ` | <community>`), whitespace collapsed.
 */
export function cleanTitle(title: string, siteLabel?: string | null): string {
  let t = title.replace(/\s+/g, ' ').trim().replace(/^\(\d+\+?\)\s+/, '')
  if (siteLabel) {
    const esc = siteLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    t = t.replace(new RegExp(`\\s+[-|–—]\\s+${esc}$`, 'i'), '')
  }
  return t.trim()
}

/** Case-folded `cleanTitle`, for comparing titles. */
export function titleKey(title: string, siteLabel?: string | null): string {
  return cleanTitle(title, siteLabel).normalize('NFC').toLowerCase()
}

/**
 * A guess key for a playback without a URL: `title:<site>:<normalized title>` (strip a leading
 * `(N) ` and the site suffix, case-fold, collapse spaces).
 */
export function guessKey(site: string, title: string): CanonicalKey {
  const s = normalizeHost(site.trim()) || 'unknown'
  return `title:${s}:${titleKey(title, site)}`
}
