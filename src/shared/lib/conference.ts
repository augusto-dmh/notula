// SPDX-License-Identifier: Apache-2.0
// Conference links of calendar events. One shared module for the renderer, the tray and
// the reminder scheduler.
// The Zoom app check stays in main (`calendar:join`).

import type { CalendarEvent } from '../types/notes'

export interface ConferenceLink {
  url: string
  /** The normalized provider name. */
  provider: string
  /** `zoom`, `meet`, `teams`, or the lower-cased provider name. */
  type: string
  iconUri: string | null
}

/** The 11 provider domains, in table order (the first match wins). */
export const CONFERENCE_DOMAINS: readonly { domain: string; provider: string }[] = [
  { domain: 'teams.microsoft.com', provider: 'Microsoft Teams' },
  { domain: 'zoom.us', provider: 'Zoom' },
  { domain: 'zoomgov.com', provider: 'Zoom' },
  { domain: 'zoom.com', provider: 'Zoom' },
  { domain: 'meet.google.com', provider: 'Google Meet' },
  { domain: 'pexip.me', provider: 'Pexip' },
  { domain: 'calendly.com/events', provider: 'Calendly' },
  { domain: 'app.cal.com/video', provider: 'Cal.com' },
  { domain: 'webex.com', provider: 'Webex' },
  { domain: 'riverside.com', provider: 'Riverside' }
]

/** Links to these files are never join links. */
const IGNORED_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.tiff', '.webp', '.svg', '.ico', '.pdf', '.zip', '.txt']

/** http(s) links in text: cut before spaces, brackets and quotes. */
const TEXT_URL = /https?:\/\/(?:www\.)?[^\s<>()[\]{}"'`]+/gi
const TRAILING_PUNCTUATION = /[.,;:!?]+$/
/** A Zoom link needs `/my/`, or a `/j/`, `/s/` or `/w/` path with 9–11 digits. */
const ZOOM_MEETING_PATH = /^\/(?:j|s|w)\/\d{9,11}(?:\/|$)/
const SAFELINKS = 'safelinks.protection.outlook.com'
const EMAIL = /^[^\s@:]+@[^\s@:]+\.[^\s@:]+$/

/** Any name containing "zoom", "google meet", "teams" or "microsoft" takes the canonical name. */
export function normalizeProviderName(name: string): string {
  const n = name.trim()
  const lower = n.toLowerCase()
  if (lower.includes('zoom')) return 'Zoom'
  if (lower.includes('google meet')) return 'Google Meet'
  if (lower.includes('teams') || lower.includes('microsoft')) return 'Microsoft Teams'
  return n
}

/** The provider of the first table domain that occurs anywhere in the URL (case-insensitive). */
function providerOf(url: string): string | null {
  const lower = url.toLowerCase()
  return CONFERENCE_DOMAINS.find((d) => lower.includes(d.domain))?.provider ?? null
}

/** True when a text mentions one of the 11 provider domains (Coming up's personal filter). */
export function mentionsConferenceDomain(text: string | null | undefined): boolean {
  if (!text) return false
  const lower = text.toLowerCase()
  return CONFERENCE_DOMAINS.some((d) => lower.includes(d.domain))
}

function typeOf(provider: string): string {
  if (provider === 'Zoom') return 'zoom'
  if (provider === 'Google Meet') return 'meet'
  if (provider === 'Microsoft Teams') return 'teams'
  return provider.toLowerCase()
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname
  } catch {
    return ''
  }
}

/** The first qualifying http(s) link in a text, with its provider. */
function linkInText(text: unknown): { url: string; provider: string } | null {
  if (typeof text !== 'string' || !text) return null
  for (const match of text.matchAll(TEXT_URL)) {
    const url = match[0].replace(TRAILING_PUNCTUATION, '')
    const lower = url.toLowerCase()
    if (IGNORED_EXTENSIONS.some((ext) => lower.endsWith(ext) || pathOf(url).toLowerCase().endsWith(ext))) continue
    const provider = providerOf(url)
    if (!provider) continue
    if (provider === 'Zoom' && !lower.includes('/my/') && !ZOOM_MEETING_PATH.test(pathOf(url))) continue
    return { url, provider }
  }
  return null
}

interface EntryPoint {
  entryPointType?: unknown
  uri?: unknown
}

/** The `video` entry point of `conferenceData`, with its provider name. */
function linkInConferenceData(event: CalendarEvent): { url: string; provider: string; iconUri: string | null } | null {
  const data = event['conferenceData'] as { entryPoints?: unknown; conferenceSolution?: { name?: unknown; iconUri?: unknown } } | undefined
  if (!data || typeof data !== 'object') return null
  const points = Array.isArray(data.entryPoints) ? (data.entryPoints as EntryPoint[]) : []
  const video = points.find((p) => p && p.entryPointType === 'video' && typeof p.uri === 'string' && p.uri.trim())
  if (!video) return null
  const url = (video.uri as string).trim()
  const solution = data.conferenceSolution
  const named = typeof solution?.name === 'string' && solution.name.trim() ? normalizeProviderName(solution.name) : null
  const provider = named ?? providerOf(url)
  if (!provider) return null
  const iconUri = typeof solution?.iconUri === 'string' && solution.iconUri ? solution.iconUri : null
  return { url, provider, iconUri }
}

/** The calendar id without Notula's `<kind>:<sourceId>:` prefix. */
function rawCalendarId(event: CalendarEvent): string | null {
  const id = event['calendarId']
  if (typeof id !== 'string' || !id) return null
  const m = /^(?:ics|google|microsoft):[^:]+:(.+)$/.exec(id)
  return m ? (m[1] ?? null) : id
}

/** The SafeLinks and Google Meet fixes. */
function fixLink(url: string, event: CalendarEvent, userEmail: string | null): string {
  let out = url
  if (out.toLowerCase().includes(SAFELINKS)) {
    out = out.replace(/&amp%3B/gi, '&').replace(/&amp;/gi, '&')
    try {
      const host = new URL(out).hostname.toLowerCase()
      if (host === SAFELINKS || host.endsWith(`.${SAFELINKS}`)) return out
    } catch {
      // Not parseable: the next rule may still apply.
    }
  }
  if (out.toLowerCase().includes('meet.google')) {
    const calendarId = rawCalendarId(event)
    const email = calendarId && EMAIL.test(calendarId) ? calendarId : userEmail?.trim() || null
    if (!email) return out
    try {
      const u = new URL(out)
      u.searchParams.set('authuser', email)
      return u.toString()
    } catch {
      return `${out}${out.includes('?') ? '&' : '?'}authuser=${encodeURIComponent(email)}`
    }
  }
  return out
}

/**
 * An ICS event's `URL` property lands in
 * `htmlLink`, and some feeds put the meeting link only there. It is checked last, with the
 * same provider and Zoom-path rules as text links.
 */
function linkInIcsUrl(event: CalendarEvent): { url: string; provider: string } | null {
  return typeof event.id === 'string' && event.id.startsWith('ics:') ? linkInText(event['htmlLink']) : null
}

/** The event's join link, with the SafeLinks and Meet `authuser` fixes. */
export function detectConferenceLink(event: CalendarEvent, userEmail: string | null): ConferenceLink | null {
  if (!event || typeof event !== 'object') return null
  const fromData = linkInConferenceData(event)
  const found =
    fromData ?? (() => {
      const text = linkInText(event['description']) ?? linkInText(event['location']) ?? linkInIcsUrl(event)
      return text ? { ...text, iconUri: null } : null
    })()
  if (!found) return null
  return {
    url: fixLink(found.url, event, userEmail),
    provider: found.provider,
    type: typeOf(found.provider),
    iconUri: found.iconUri
  }
}

/** `Join <provider>`, or `Join meeting` without a link. */
export function joinLabel(link: ConferenceLink | null): string {
  return link ? `Join ${link.provider}` : 'Join meeting'
}

/** A Zoom `/j/` link as a `zoommtg://` URL, or null when it is not one. */
export function zoomAppUrl(url: string): string | null {
  let u: URL
  try {
    u = new URL(url.trim())
  } catch {
    return null
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  const host = u.hostname.toLowerCase()
  if (host !== 'zoom.us' && !host.endsWith('.zoom.us')) return null
  const m = /^\/(?:j|s|w)\/(\d+)/.exec(u.pathname)
  if (!m) return null
  const params = new URLSearchParams()
  params.set('confno', m[1] as string)
  const pwd = u.searchParams.get('pwd') ?? u.searchParams.get('passcode')
  if (pwd) params.set('pwd', pwd)
  for (const [k, v] of u.searchParams) if (k !== 'pwd' && k !== 'passcode' && k !== 'confno') params.append(k, v)
  return `zoommtg://zoom.us/join?${params.toString()}`
}
