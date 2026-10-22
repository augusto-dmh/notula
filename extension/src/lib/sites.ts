// SPDX-License-Identifier: Apache-2.0
// Which sites the reader runs on. YouTube is granted at install. Any other
// https site is turned on per origin with Enable on this site. A member-area site also asks for
// the video player origins its lessons are often embedded from. Those player origins are
// unverified until measured.

import type { ExtAdapter } from '../../../src/shared/types/extension-protocol'

/** Player iframes of member areas (Hotmart, Kiwify, Memberkit and others), unverified. */
export const PLAYER_ORIGIN_PATTERNS = [
  'https://player.vimeo.com/*',
  'https://*.tv.pandavideo.com.br/*',
  'https://player.hotmart.com/*'
] as const

/** `https://host` for an https page URL, else null (only https sites can be turned on). */
export function originOf(url: string | undefined): string | null {
  if (!url) return null
  try {
    const u = new URL(url)
    return u.protocol === 'https:' && u.hostname ? `https://${u.hostname.toLowerCase()}` : null
  } catch {
    return null
  }
}

export function hostOf(origin: string): string {
  return origin.replace(/^https:\/\//, '')
}

export function isYouTubeOrigin(origin: string): boolean {
  return origin === 'https://www.youtube.com' || origin === 'https://m.youtube.com'
}

/**
 * Only the generic reader's sites embed third-party players. Circle, Udemy and Coursera play in
 * the page itself (a Circle lesson has no iframe).
 */
export function needsPlayers(adapter: ExtAdapter | null): boolean {
  return adapter === null || adapter === 'generic'
}

/** The content-script registration id for a site. Ids may not start with `_`. */
export function scriptIdFor(origin: string): string {
  return `site:${hostOf(origin)}`
}
