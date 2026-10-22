// SPDX-License-Identifier: Apache-2.0
// Canonical keys for the `video` field of captions, chapters and the adapters:
// `youtube:<videoId>`, `circle:<host>:<lessonId>`, `udemy:<courseSlug>:<lectureId>`,
// `coursera:<courseSlug>:<itemId>`, else `url:<normalized URL>`. Notula recomputes the key from
// `media.url` on its side; this copy only labels what the extension sends.

import type { ExtAdapter } from '../../../src/shared/types/extension-protocol'

const YT_HOSTS = new Set(['www.youtube.com', 'youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be', 'www.youtube-nocookie.com'])
const YT_ID = /^[A-Za-z0-9_-]{11}$/

export const CIRCLE_LESSON = /^\/c\/([^/]+)\/sections\/(\d+)\/lessons\/(\d+)\/?$/
export const UDEMY_LECTURE = /^\/course\/([^/]+)\/learn\/lecture\/(\d+)\/?$/
export const COURSERA_LECTURE = /^\/learn\/([^/]+)\/lecture\/([^/]+)(?:\/[^/]*)?\/?$/

const TRACKING = /^(utm_|fbclid$|gclid$|mc_cid$|mc_eid$|si$|feature$|pp$|ab_channel$)/

function safeUrl(url: string): URL | null {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' || u.protocol === 'http:' ? u : null
  } catch {
    return null
  }
}

export function youtubeVideoId(url: string): string | null {
  const u = safeUrl(url)
  if (!u || !YT_HOSTS.has(u.hostname)) return null
  if (u.hostname === 'youtu.be') {
    const id = u.pathname.slice(1).split('/')[0] ?? ''
    return YT_ID.test(id) ? id : null
  }
  const v = u.searchParams.get('v')
  if (u.pathname === '/watch' && v && YT_ID.test(v)) return v
  const m = /^\/(?:shorts|live|embed)\/([A-Za-z0-9_-]{11})(?:[/?]|$)/.exec(u.pathname)
  return m?.[1] ?? null
}

export function isYouTube(url: string): boolean {
  const u = safeUrl(url)
  return !!u && YT_HOSTS.has(u.hostname)
}

/** The adapter for a top-frame URL. */
export function adapterFor(url: string): ExtAdapter {
  const u = safeUrl(url)
  if (!u) return 'generic'
  if (YT_HOSTS.has(u.hostname)) return 'youtube'
  if (CIRCLE_LESSON.test(u.pathname)) return 'circle'
  if (/(^|\.)udemy\.com$/.test(u.hostname) && UDEMY_LECTURE.test(u.pathname)) return 'udemy'
  if (/(^|\.)coursera\.org$/.test(u.hostname) && COURSERA_LECTURE.test(u.pathname)) return 'coursera'
  return 'generic'
}

/** The URL without its fragment, tracking parameters or trailing slash. */
export function normalizeUrl(url: string): string | null {
  const u = safeUrl(url)
  if (!u) return null
  u.hash = ''
  u.hostname = u.hostname.toLowerCase()
  for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k)
  u.searchParams.sort()
  if (u.pathname.length > 1 && u.pathname.endsWith('/')) u.pathname = u.pathname.slice(0, -1)
  return u.toString()
}

export function canonicalKey(url: string): string | null {
  const yt = youtubeVideoId(url)
  if (yt) return `youtube:${yt}`
  const u = safeUrl(url)
  if (!u) return null
  const host = u.hostname.toLowerCase()
  const circle = CIRCLE_LESSON.exec(u.pathname)
  if (circle) return `circle:${host}:${circle[3]}`
  const udemy = /(^|\.)udemy\.com$/.test(host) ? UDEMY_LECTURE.exec(u.pathname) : null
  if (udemy) return `udemy:${udemy[1]}:${udemy[2]}`
  const coursera = /(^|\.)coursera\.org$/.test(host) ? COURSERA_LECTURE.exec(u.pathname) : null
  if (coursera) return `coursera:${coursera[1]}:${coursera[2]}`
  const n = normalizeUrl(url)
  return n ? `url:${n}` : null
}

/** `youtube.com`, `courses.example.com`: the host without `www.` or `m.`. */
export function siteOf(url: string): string | null {
  const u = safeUrl(url)
  if (!u) return null
  return u.hostname.toLowerCase().replace(/^(www|m)\./, '')
}
