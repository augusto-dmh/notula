// SPDX-License-Identifier: Apache-2.0
// Links → source candidates. Pure. Every http(s) URL in an item is kept with a role:
// - `source`: labelled as the item's source (a front-matter source key, `Video`, a lesson URL
//   under `Lesson` or `Class`, the `- Lesson:` lines of a placeholder transcript);
// - `series`: a course root (`/c/<course>`) or a playlist, labelled or not;
// - `reference`: anything else, including unlabelled video links in the text;
// - `plain`: share links of a notes app (`notes.<app>.<tld>`), always (never a source, never fetched).
// Keys come from the shared parser (`parseSourceUrl`), so every surface computes the same key.
// Nothing is fetched.

import { normalizeHost, parseSourceUrl } from '@shared/lib/source-key'
import { IMPORT_LIMITS, type CandidateLink, type CandidateRole } from '@shared/types/imports-markdown'

const COURSE_ROOT = /^\/c\/([^/]+)\/?$/
const SOURCE_LABELS = new Set(['video', 'lesson', 'class', 'aula', 'source', 'source_url', 'url', 'link', 'youtube'])
/** Longer URLs aren't candidates (and never reach the URL parser). */
const URL_MAX = 4_096
const TRAILING = new Set([...').,;:!?]>'])

/** Trailing punctuation dropped by hand: `/[…]+$/` is quadratic on a long run of it. */
export function trimTrailingPunctuation(url: string): string {
  let end = url.length
  while (end > 0 && TRAILING.has(url[end - 1]!)) end--
  return url.slice(0, end)
}

const NOTE_SHARE_HOST = /^notes\.([a-z0-9-]{1,40})\.[a-z]{2,24}$/

/** The app name of a notes app's share host (`notes.<app>.<tld>`), else null. */
export function noteShareApp(host: string): string | null {
  return NOTE_SHARE_HOST.exec(normalizeHost(host))?.[1] ?? null
}

/** True for a notes app's own share links (note and chat pages), which are never sources. */
export function isNoteShareLink(url: string): boolean {
  try {
    return noteShareApp(new URL(url).hostname) !== null
  } catch {
    return false
  }
}

function seriesOf(u: URL, host: string): CandidateLink['canonicalKey'] {
  const root = COURSE_ROOT.exec(u.pathname)
  if (root) return `circle:${host}:course:${root[1]}`
  if ((host === 'youtube.com' || host === 'm.youtube.com') && u.pathname.replace(/\/+$/, '') === '/playlist') {
    const list = u.searchParams.get('list')
    if (list && /^[\w-]{2,64}$/.test(list) && !/^(RD|WL$|LL$|LM$)/.test(list)) return `youtube:playlist:${list}`
  }
  return null
}

/**
 * One URL with its label (`Video`, `Lesson`, a front-matter key, or null for a body link) and
 * whether a label or key marks it as the item's source. Null for anything that isn't http(s).
 */
export function classifyLink(rawUrl: string, label: string | null, labelled: boolean): CandidateLink | null {
  const url = trimTrailingPunctuation(rawUrl.trim())
  if (url.length > URL_MAX) return null
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  const host = normalizeHost(u.hostname)
  if (noteShareApp(host)) return { url, role: 'plain', label, canonicalKey: null, startMs: null }
  const series = seriesOf(u, host)
  if (series) return { url, role: 'series', label, canonicalKey: series, startMs: null }
  const parsed = parseSourceUrl(url)
  if (!parsed) return null
  const isSource = labelled && SOURCE_LABELS.has((label ?? '').trim().toLowerCase()) && !parsed.short
  let role: CandidateRole = 'reference'
  if (isSource) role = 'source'
  return { url: parsed.url, role, label, canonicalKey: parsed.canonicalKey, startMs: parsed.startMs }
}

/** Every http(s) URL in a run of Markdown: link targets, autolinks and bare URLs. */
export function urlsIn(markdown: string): { url: string; text: string | null }[] {
  const out: { url: string; text: string | null }[] = []
  const seen = new Set<string>()
  const add = (url: string, text: string | null): void => {
    const u = trimTrailingPunctuation(url)
    if (u.length > URL_MAX || seen.has(u)) return
    seen.add(u)
    out.push({ url: u, text })
  }
  // Linear: neither class runs past the next `[` or the end of the line.
  const linked = /\[([^\][\n]{0,1000})\]\((https?:\/\/[^)\s]{1,4096})(?:\s+"[^"\n]{0,500}")?\)/g
  for (let m = linked.exec(markdown); m; m = linked.exec(markdown)) add(m[2]!, m[1] || null)
  const bare = /<?(https?:\/\/[^\s<>()[\]"'`]+)>?/g
  for (let m = bare.exec(markdown); m; m = bare.exec(markdown)) add(m[1]!, null)
  return out
}

/** Deduplicated by URL and role, the strongest role first; at most 200. */
export function finishCandidates(list: CandidateLink[]): CandidateLink[] {
  const rank: Record<CandidateRole, number> = { source: 0, series: 1, reference: 2, plain: 3 }
  const byUrl = new Map<string, CandidateLink>()
  for (const c of list) {
    const key = c.canonicalKey ?? c.url
    const had = byUrl.get(key)
    if (!had || rank[c.role] < rank[had.role]) byUrl.set(key, had && had.label && !c.label ? { ...c, label: had.label } : c)
  }
  return [...byUrl.values()].sort((a, b) => rank[a.role] - rank[b.role]).slice(0, IMPORT_LIMITS.candidatesPerItem)
}
