// SPDX-License-Identifier: Apache-2.0
// Caption and chapter parsing. Caption bodies come from the player's own requests, a replay,
// or a page's text tracks. Order: YouTube `json3`, then `srv3`/`srv1` XML, then WebVTT; rolling
// duplicates (auto captions repeat the previous line) are dropped. All times end up in ms.

import type { ExtCue } from '../../../src/shared/types/extension-protocol'
import { CAPS } from '../lib/messages'

function push(out: ExtCue[], s: number, e: number, raw: string): void {
  const t = raw.replace(/\s+/g, ' ').trim().slice(0, CAPS.cueText)
  if (!t || out.length >= CAPS.cues) return
  const prev = out[out.length - 1]
  if (prev && prev.t === t) {
    // The same line again: extend it instead of repeating it.
    prev.e = Math.max(prev.e, Math.round(e))
    return
  }
  // A rolling line that starts with the previous one keeps only what is new.
  const fresh = prev && t.startsWith(prev.t + ' ') && s - prev.s < 10_000 ? t.slice(prev.t.length + 1) : t
  out.push({ s: Math.max(0, Math.round(s)), e: Math.max(Math.round(s), Math.round(e)), t: fresh })
}

function parseJson3(body: string): ExtCue[] | null {
  let data: unknown
  try {
    data = JSON.parse(body)
  } catch {
    return null
  }
  if (typeof data !== 'object' || data === null || !Array.isArray((data as { events?: unknown }).events)) return null
  const out: ExtCue[] = []
  for (const ev of (data as { events: unknown[] }).events) {
    if (typeof ev !== 'object' || ev === null) continue
    const { tStartMs, dDurationMs, segs } = ev as { tStartMs?: unknown; dDurationMs?: unknown; segs?: unknown }
    if (typeof tStartMs !== 'number' || !Array.isArray(segs)) continue
    const text = segs.map((sg) => (typeof sg === 'object' && sg && typeof (sg as { utf8?: unknown }).utf8 === 'string' ? (sg as { utf8: string }).utf8 : '')).join('')
    push(out, tStartMs, tStartMs + (typeof dDurationMs === 'number' ? dDurationMs : 0), text)
  }
  return out
}

function parseXml(body: string): ExtCue[] | null {
  if (!/^\s*<\?xml|^\s*<(timedtext|transcript)/.test(body)) return null
  const doc = new DOMParser().parseFromString(body, 'text/xml')
  if (doc.querySelector('parsererror')) return null
  const out: ExtCue[] = []
  // srv3: <p t="ms" d="ms">…</p>
  for (const p of Array.from(doc.getElementsByTagName('p'))) {
    const t = Number(p.getAttribute('t'))
    const d = Number(p.getAttribute('d') ?? 0)
    if (Number.isFinite(t)) push(out, t, t + (Number.isFinite(d) ? d : 0), p.textContent ?? '')
  }
  if (out.length) return out
  // srv1: <text start="s" dur="s">…</text>
  for (const el of Array.from(doc.getElementsByTagName('text'))) {
    const s = Number(el.getAttribute('start'))
    const d = Number(el.getAttribute('dur') ?? 0)
    if (Number.isFinite(s)) push(out, s * 1_000, (s + (Number.isFinite(d) ? d : 0)) * 1_000, decode(el.textContent ?? ''))
  }
  return out
}

/** srv1 text is often entity-encoded twice; an inert HTML parse decodes the second level. */
function decode(s: string): string {
  if (!s.includes('&')) return s
  return new DOMParser().parseFromString(s, 'text/html').documentElement.textContent ?? s
}

const VTT_TIME = /(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{3})/

function vttMs(s: string): number | null {
  const m = VTT_TIME.exec(s)
  if (!m) return null
  return ((Number(m[1] ?? 0) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1_000 + Number(m[4])
}

function parseVtt(body: string): ExtCue[] | null {
  if (!/^﻿?WEBVTT/.test(body)) return null
  const out: ExtCue[] = []
  for (const block of body.replace(/\r/g, '').split(/\n{2,}/)) {
    const lines = block.split('\n')
    const i = lines.findIndex((l) => l.includes('-->'))
    if (i < 0) continue
    const [a, b] = (lines[i] ?? '').split('-->')
    const s = vttMs(a ?? '')
    const e = vttMs(b ?? '')
    if (s === null || e === null) continue
    const text = lines.slice(i + 1).map((l) => l.replace(/<[^>]+>/g, '')).filter(Boolean)
    // Auto captions show the previous line above the new one; keep the new one only.
    const prev = out[out.length - 1]
    const kept = text.length > 1 && prev && text[0]?.trim() === prev.t ? text.slice(1) : text
    push(out, s, e, kept.join(' '))
  }
  return out
}

/** Parses any caption body the player or a page gives; null when the format isn't known. */
export function parseCaptions(body: string): ExtCue[] | null {
  const b = body.trimStart()
  if (!b) return null
  if (b.startsWith('{')) return parseJson3(b)
  if (b.startsWith('<')) return parseXml(b)
  return parseVtt(b)
}

/** `h:mm:ss`, `mm:ss` or `m:ss` to seconds. */
export function stampSeconds(s: string): number | null {
  const m = /^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})$/.exec(s.trim())
  if (!m) return null
  return Number(m[1] ?? 0) * 3_600 + Number(m[2]) * 60 + Number(m[3])
}

/**
 * Chapters from a video description, with YouTube's rules: the first at 0:00, at
 * least 3, ascending, each at least 10 s long. Null when the description doesn't qualify.
 */
export function chaptersFromDescription(text: string): { start: number; title: string }[] | null {
  const items: { start: number; title: string }[] = []
  for (const line of text.split('\n')) {
    const m = /^\s*[([]?((?:\d{1,2}:)?\d{1,2}:\d{2})[)\]]?\s*[-–—:|]?\s*(.+?)\s*$/.exec(line)
    if (!m) continue
    const start = stampSeconds(m[1] ?? '')
    const title = (m[2] ?? '').slice(0, CAPS.title)
    if (start === null || !title) continue
    items.push({ start, title })
  }
  if (items.length < 3 || items[0]?.start !== 0) return null
  for (let i = 1; i < items.length; i++) {
    if ((items[i]?.start ?? 0) - (items[i - 1]?.start ?? 0) < 10) return null
  }
  return items.slice(0, CAPS.chapters)
}
