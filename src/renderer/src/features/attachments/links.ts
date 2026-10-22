// SPDX-License-Identifier: Apache-2.0
// Links from the meeting invite: extraction from the
// event description and their labels. No favicon is ever fetched.

import { CONFERENCE_DOMAINS } from '@shared/lib/conference'
import { ATTACHED_LINK_SKIP_HOSTS } from '@shared/types/attachments'
import type { AttachedLink, CalendarEvent } from '@shared/types/notes'

export interface LinkSuggestion {
  url: string
  label: string
}

/** Second-level labels that make the registrable domain three labels long (co.uk, com.au, …). */
const SECOND_LEVEL = new Set(['co', 'com', 'net', 'org', 'gov', 'edu', 'ac', 'ne', 'or', 'go'])
const TEXT_URL = /https?:\/\/[^\s<>()[\]{}"'`]+/gi
const TRAILING = /[.,;:!?]+$/
const HEX_TAIL = /^[0-9a-f]{12,}$/i

function hostOf(url: URL): string {
  return url.hostname.toLowerCase().replace(/^www\./, '')
}

function isConferenceLink(url: string): boolean {
  const lower = url.toLowerCase()
  return CONFERENCE_DOMAINS.some((d) => lower.includes(d.domain))
}

/** The registrable domain's first label, capitalized: `docs.google.com` → `Google`. */
export function siteName(host: string): string {
  const labels = host.split('.').filter(Boolean)
  if (labels.length < 2) return capitalize(host)
  const sld = labels[labels.length - 2] as string
  const tld = labels[labels.length - 1] as string
  const registrable = SECOND_LEVEL.has(sld) && tld.length === 2 && labels.length >= 3 ? labels[labels.length - 3] : sld
  return capitalize(registrable ?? host)
}

function capitalize(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s
}

/** The last path segment that yields a label, or null. */
function pathLabel(url: URL): string | null {
  const segments = url.pathname.split('/').filter(Boolean).reverse()
  for (const segment of segments) {
    let text: string
    try {
      text = decodeURIComponent(segment)
    } catch {
      text = segment
    }
    let words = text.replace(/[+-]/g, ' ').split(/\s+/).filter(Boolean)
    let droppedHex = false
    const last = words[words.length - 1]
    if (last && HEX_TAIL.test(last)) {
      words = words.slice(0, -1)
      droppedHex = true
    }
    if (words.length === 0 || words.some((w) => w.length >= 16)) continue
    if (words.length < 2 && !droppedHex) continue
    return capitalize(words.join(' '))
  }
  return null
}

export function linkLabel(rawUrl: string, anchorText: string | null): string {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return rawUrl
  }
  const host = hostOf(url)
  const site = siteName(host)
  const text = anchorText?.replace(/\s+/g, ' ').trim() ?? ''
  if (text && !rawUrl.toLowerCase().includes(text.toLowerCase()) && !/^https?:\/\//i.test(text)) return `${site} - ${text}`
  const path = pathLabel(url)
  return path ? `${site} - ${path}` : host
}

/** Https links from the description (anchors and bare URLs), no join links, no skip hosts, first one wins. */
export function extractInviteLinks(event: CalendarEvent | null): LinkSuggestion[] {
  const description = event?.['description']
  if (typeof description !== 'string' || !description.trim()) return []
  const doc = new DOMParser().parseFromString(description, 'text/html')
  const found: { url: string; text: string | null }[] = []
  const walk = (node: Node): void => {
    if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as Element
      if (el.tagName === 'A') {
        const href = el.getAttribute('href')
        if (href) found.push({ url: href.trim(), text: el.textContent })
        return
      }
      if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE') return
    } else if (node.nodeType === Node.TEXT_NODE) {
      for (const m of (node.textContent ?? '').matchAll(TEXT_URL)) found.push({ url: m[0].replace(TRAILING, ''), text: null })
      return
    }
    node.childNodes.forEach(walk)
  }
  walk(doc.body)
  const out: LinkSuggestion[] = []
  const seen = new Set<string>()
  for (const f of found) {
    let url: URL
    try {
      url = new URL(f.url)
    } catch {
      continue
    }
    if (url.protocol !== 'https:') continue
    const href = url.toString()
    if (isConferenceLink(href)) continue
    if ((ATTACHED_LINK_SKIP_HOSTS as readonly string[]).includes(hostOf(url))) continue
    if (seen.has(href)) continue
    seen.add(href)
    out.push({ url: href, label: linkLabel(href, f.text) })
  }
  return out
}

/** The extracted links not already saved (added or dismissed). */
export function suggestionsFor(event: CalendarEvent | null, saved: AttachedLink[]): LinkSuggestion[] {
  const known = new Set(saved.map((l) => l.url))
  return extractInviteLinks(event).filter((l) => !known.has(l.url))
}
