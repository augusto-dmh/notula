// SPDX-License-Identifier: Apache-2.0
// Page-reading helpers shared by the adapters: JSON-LD, breadcrumbs, title patterns,
// and caption cues from the page's own <track> files.

import type { ExtCue } from '../../../../src/shared/types/extension-protocol'
import { clean } from '../../lib/check'
import { CAPS, type CaptionsReply } from '../../lib/messages'

/** Every JSON-LD object on the page, flattened through `@graph`. */
export function jsonLd(): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  const visit = (v: unknown): void => {
    if (out.length > 50) return
    if (Array.isArray(v)) v.forEach(visit)
    else if (typeof v === 'object' && v !== null) {
      out.push(v as Record<string, unknown>)
      const graph = (v as Record<string, unknown>)['@graph']
      if (graph) visit(graph)
    }
  }
  for (const s of Array.from(document.querySelectorAll('script[type="application/ld+json"]')).slice(0, 20)) {
    try {
      visit(JSON.parse(s.textContent ?? ''))
    } catch {
      // A broken block on the page; skip it.
    }
  }
  return out
}

export function ldOfType(items: Record<string, unknown>[], ...types: string[]): Record<string, unknown> | null {
  return (
    items.find((it) => {
      const t = it['@type']
      return Array.isArray(t) ? t.some((x) => types.includes(String(x))) : types.includes(String(t))
    }) ?? null
  )
}

export function ldString(v: unknown): string | null {
  return typeof v === 'string' ? clean(v) : null
}

export interface Crumb {
  name: string
  url: string | null
}

/** Breadcrumbs from JSON-LD `BreadcrumbList`, else a breadcrumb `nav`. */
export function breadcrumbs(ld = jsonLd()): Crumb[] {
  const list = ldOfType(ld, 'BreadcrumbList')
  if (list && Array.isArray(list.itemListElement)) {
    const crumbs: Crumb[] = []
    for (const it of list.itemListElement as Record<string, unknown>[]) {
      const item = it.item
      const name = ldString(it.name) ?? (typeof item === 'object' && item ? ldString((item as Record<string, unknown>).name) : null)
      const url = typeof item === 'string' ? item : typeof item === 'object' && item ? ldString((item as Record<string, unknown>)['@id']) : null
      if (name) crumbs.push({ name, url })
    }
    if (crumbs.length) return crumbs
  }
  const nav = document.querySelector('nav[aria-label*="breadcrumb" i], [class*="breadcrumb" i]')
  if (!nav) return []
  return Array.from(nav.querySelectorAll('a, li > span, [aria-current="page"]'))
    .map((el) => ({ name: clean(el.textContent) ?? '', url: el instanceof HTMLAnchorElement ? el.href : null }))
    .filter((c) => c.name)
    .slice(0, 10)
}

export function metaContent(selector: string): string | null {
  return clean(document.querySelector<HTMLMetaElement>(selector)?.content ?? null)
}

export function canonicalUrl(): string | null {
  const href = document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href ?? null
  return href && /^https?:/.test(href) ? href.slice(0, CAPS.url) : null
}

/** `document.title` without a trailing ` | Site` or ` - Site` part. */
export function titleWithoutSite(): string | null {
  const t = clean(document.title)
  if (!t) return null
  const parts = t.split(/\s+[|–—-]\s+/)
  return parts.length > 1 ? clean(parts.slice(0, -1).join(' - ')) : t
}

/** A lesson number in a title or crumb: `Aula 3`, `Lesson 3`, `3.`, `3 -` (a heuristic). */
export function lessonNumber(text: string | null): number | null {
  if (!text) return null
  const m = /\b(?:aula|lesson|lecture|module|m[óo]dulo|class|video)\s*(\d{1,4})\b/i.exec(text) ?? /^\s*(\d{1,4})\s*[.)\-–:]\s+\S/.exec(text)
  const n = m ? Number(m[1]) : NaN
  return Number.isInteger(n) && n > 0 ? n : null
}

const TRACK_WAIT_MS = 3_000

/**
 * Cues from the media element's text tracks. A disabled track is switched to `hidden`
 * so it loads without showing, then put back. Cross-origin track files may load nothing.
 */
export async function textTrackCues(
  media: HTMLMediaElement | null,
  video: string,
  langs: string[]
): Promise<CaptionsReply> {
  if (!media) return { status: 'unavailable', reason: 'no-track' }
  const tracks = Array.from(media.textTracks).filter((t) => t.kind === 'subtitles' || t.kind === 'captions')
  if (!tracks.length) return { status: 'unavailable', reason: 'no-track' }
  const wanted = langs.map((l) => l.toLowerCase().split('-')[0])
  const track =
    tracks.find((t) => wanted.includes((t.language || '').toLowerCase().split('-')[0] ?? '')) ??
    (langs.length ? null : tracks[0]) ??
    null
  if (!track) return { status: 'unavailable', reason: 'no-track' }
  const before = track.mode
  if (before === 'disabled') track.mode = 'hidden'
  const started = Date.now()
  while ((!track.cues || track.cues.length === 0) && Date.now() - started < TRACK_WAIT_MS) {
    await new Promise((r) => setTimeout(r, 200))
  }
  const cues: ExtCue[] = []
  for (const c of Array.from(track.cues ?? [])) {
    const text = 'text' in c ? String((c as VTTCue).text).replace(/<[^>]+>/g, ' ') : ''
    const t = clean(text, CAPS.cueText)
    if (t && cues.length < CAPS.cues) cues.push({ s: Math.round(c.startTime * 1_000), e: Math.round(c.endTime * 1_000), t })
  }
  if (before === 'disabled') track.mode = 'disabled'
  if (!cues.length) return { status: 'unavailable', reason: 'failed' }
  return {
    status: 'ok',
    track: { video, lang: track.language || 'und', kind: 'manual', source: 'texttrack', cues }
  }
}

/** Waits for `test` to return something, checking every 200 ms. */
export async function waitFor<T>(test: () => T | null, ms: number): Promise<T | null> {
  const started = Date.now()
  for (;;) {
    const v = test()
    if (v) return v
    if (Date.now() - started > ms) return null
    await new Promise((r) => setTimeout(r, 200))
  }
}

/** Visible: laid out and not hidden by the page (skips hidden templates). */
export function visible(el: Element): boolean {
  if (!(el instanceof HTMLElement)) return true
  if (el.hidden || el.closest('[hidden], [aria-hidden="true"]')) return false
  return el.getClientRects().length > 0
}
