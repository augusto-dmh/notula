// SPDX-License-Identifier: Apache-2.0
// Video positions for stamps, transcript labels, citations and exports (content sources). Only
// these two helpers live here: the stamped Markdown is computed by the renderer next to the
// normal projection. Pure: no DOM, no Electron.

/** `mm:ss`, or `h:mm:ss` from one hour. Negative and non-finite values read as 0. */
export function formatPosition(ms: number): string {
  const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${String(m).padStart(2, '0')}:${ss}`
}

const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be', 'www.youtu.be'])
const VIMEO_HOSTS = new Set(['vimeo.com', 'www.vimeo.com', 'player.vimeo.com'])

/**
 * The source URL opened at `ms`: YouTube gets `t=<s>s` (replacing any `t` or `start`), Vimeo a
 * `#t=<s>s` fragment. Other providers have no reliable time parameter, so their URL is returned
 * unchanged, and so is anything that doesn't parse as a URL.
 */
export function positionLink(url: string, ms: number): string {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return url
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return url
  const seconds = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0
  const host = u.hostname.toLowerCase()
  if (YOUTUBE_HOSTS.has(host)) {
    u.searchParams.delete('start')
    u.searchParams.set('t', `${seconds}s`)
    return u.toString()
  }
  if (VIMEO_HOSTS.has(host)) {
    u.hash = `t=${seconds}s`
    return u.toString()
  }
  return url
}
