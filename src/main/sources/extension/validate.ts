// SPDX-License-Identifier: Apache-2.0
// Strict reading of every line the relay forwards. Each known
// message is rebuilt from its known fields with types, lengths and ranges checked; anything else is
// refused. Unknown fields are dropped and unknown types are counted by the caller.
// Nothing here logs content.

import { EXT_LIMITS, EXT_MESSAGE_TYPES, type ExtAdapter, type ExtAuth, type ExtCue, type ExtFieldConfidence, type ExtToNotula } from '@shared/types/extension-protocol'

type Obj = Record<string, unknown>

const TAB_MAX = 64
const URL_MAX = 2_048
const TITLE_MAX = 500
const ID_MAX = 200
const VIDEO_MAX = 2_100
const CUE_TEXT_MAX = 2_000
const CUES_MAX = 20_000
const OUTLINE_MAX = 2_000
const CHAPTERS_MAX = 500
const EVENT_MAX = 120
/** Positions and durations above a week are nonsense. */
const SECONDS_MAX = 7 * 24 * 3600

const ADAPTERS: readonly ExtAdapter[] = ['youtube', 'circle', 'udemy', 'coursera', 'generic']
const CONFIDENCE: readonly ExtFieldConfidence[] = ['page', 'heuristic']
const ORIGIN = /^chrome-extension:\/\/[a-p]{32}\/$/

export type ParsedLine = { ok: true; msg: ExtToNotula } | { ok: false; reason: 'json' | 'unknown' | 'invalid' }

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined)

function str(v: unknown, max: number, allowEmpty = false): string | undefined {
  if (typeof v !== 'string' || v.length > max || (!allowEmpty && v.length === 0)) return undefined
  // No control characters (a tab key or a title never carries them).
  return /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v) ? undefined : v
}

/** null stays null; a bad value is undefined (refused). */
function strOrNull(v: unknown, max: number): string | null | undefined {
  return v === null ? null : str(v, max, true)
}

function num(v: unknown, min: number, max: number): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : undefined
}

function numOrNull(v: unknown, min: number, max: number): number | null | undefined {
  return v === null ? null : num(v, min, max)
}

function int(v: unknown, min: number, max: number): number | undefined {
  const n = num(v, min, max)
  return n !== undefined && Number.isInteger(n) ? n : undefined
}

function intOrNull(v: unknown, min: number, max: number): number | null | undefined {
  return v === null ? null : int(v, min, max)
}

function oneOf<T extends string>(v: unknown, list: readonly T[]): T | undefined {
  return typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : undefined
}

function httpUrl(v: unknown): string | undefined {
  const s = str(v, URL_MAX)
  if (!s) return undefined
  try {
    const u = new URL(s)
    return u.protocol === 'https:' || u.protocol === 'http:' ? s : undefined
  } catch {
    return undefined
  }
}

function httpUrlOrNull(v: unknown): string | null | undefined {
  return v === null ? null : httpUrl(v)
}

const some = (...vs: unknown[]): boolean => vs.some((v) => v === undefined)

// ---------- auth (the relay's first line) ----------

export function parseAuth(v: unknown): ExtAuth | null {
  if (!isObj(v) || v.type !== 'auth') return null
  const token = str(v.token, 200)
  const origin = str(v.origin, 80)
  const host_version = str(v.host_version, 40)
  if (!token || !origin || !host_version || !ORIGIN.test(origin)) return null
  return { type: 'auth', token, origin, host_version }
}

// ---------- the messages ----------

function hello(m: Obj): ExtToNotula | undefined {
  if (!Array.isArray(m.protocol) || m.protocol.length !== 2) return undefined
  const min = int(m.protocol[0], 0, 1_000)
  const max = int(m.protocol[1], 0, 1_000)
  if (min === undefined || max === undefined || min > max) return undefined
  if (!isObj(m.ext) || !isObj(m.browser)) return undefined
  const version = str(m.ext.version, 40)
  const store = oneOf(m.ext.store, ['cws', 'edge', 'dev'] as const)
  const brand = str(m.browser.brand, 40)
  const major = int(m.browser.major, 0, 10_000)
  if (!version || !/^\d+(\.\d+){0,3}$/.test(version) || !store || !brand || major === undefined) return undefined
  return { type: 'hello', protocol: [min, max], ext: { version, store }, browser: { brand, major } }
}

function media(m: Obj): ExtToNotula | undefined {
  const tab = str(m.tab, TAB_MAX)
  const frame = int(m.frame, 0, 1_000_000)
  const url = httpUrl(m.url)
  const canonical_url = httpUrlOrNull(m.canonical_url)
  const title = str(m.title, TITLE_MAX, true)
  const site = strOrNull(m.site, 255)
  const incognito = bool(m.incognito)
  const audible = bool(m.audible)
  const adapter = oneOf(m.adapter, ADAPTERS)
  const observed_at = int(m.observed_at, 0, 8.64e15)
  const seq = int(m.seq, 0, Number.MAX_SAFE_INTEGER)
  if (some(tab, frame, url, canonical_url, title, site, incognito, audible, adapter, observed_at, seq)) return undefined
  if (!isObj(m.media) || !isObj(m.ad)) return undefined
  const mm = m.media
  const current_time = num(mm.current_time, 0, SECONDS_MAX)
  const duration = numOrNull(mm.duration, 0, SECONDS_MAX)
  const rate = num(mm.rate, 0, 16)
  const paused = bool(mm.paused)
  const ended = bool(mm.ended)
  const live = bool(mm.live)
  const muted = bool(mm.muted)
  const showing = bool(m.ad.showing)
  if (some(current_time, duration, rate, paused, ended, live, muted, showing)) return undefined
  let session: { title: string | null; artist: string | null; album: string | null } | null = null
  if (m.session !== null && m.session !== undefined) {
    if (!isObj(m.session)) return undefined
    const st = strOrNull(m.session.title ?? null, TITLE_MAX)
    const sa = strOrNull(m.session.artist ?? null, TITLE_MAX)
    const sb = strOrNull(m.session.album ?? null, TITLE_MAX)
    if (some(st, sa, sb)) return undefined
    session = { title: st as string | null, artist: sa as string | null, album: sb as string | null }
  }
  return {
    type: 'media',
    tab: tab as string,
    frame: frame as number,
    url: url as string,
    canonical_url: canonical_url as string | null,
    title: title as string,
    site: site as string | null,
    incognito: incognito as boolean,
    audible: audible as boolean,
    media: {
      current_time: current_time as number,
      duration: duration as number | null,
      rate: rate as number,
      paused: paused as boolean,
      ended: ended as boolean,
      live: live as boolean,
      muted: muted as boolean
    },
    ad: { showing: showing as boolean },
    session,
    adapter: adapter as ExtAdapter,
    observed_at: observed_at as number,
    seq: seq as number
  }
}

function mediaGone(m: Obj): ExtToNotula | undefined {
  const tab = str(m.tab, TAB_MAX)
  const reason = oneOf(m.reason, ['closed', 'navigated', 'stopped'] as const)
  return tab && reason ? { type: 'media.gone', tab, reason } : undefined
}

function idTitle(v: unknown, idRequired: boolean): { id: string | null; title: string | null } | undefined {
  if (!isObj(v)) return undefined
  const id = idRequired ? str(v.id, ID_MAX) : strOrNull(v.id ?? null, ID_MAX)
  const title = strOrNull(v.title ?? null, TITLE_MAX)
  if (id === undefined || title === undefined) return undefined
  return { id, title }
}

function page(m: Obj): ExtToNotula | undefined {
  const tab = str(m.tab, TAB_MAX)
  const adapter = oneOf(m.adapter, ADAPTERS)
  if (!tab || !adapter) return undefined
  const nullable = <T>(v: unknown, f: (o: unknown) => T | undefined): T | null | undefined => (v === null || v === undefined ? null : f(v))
  const course = nullable(m.course, (v) => {
    const it = idTitle(v, true)
    const url = isObj(v) ? httpUrlOrNull(v.url ?? null) : undefined
    return it && url !== undefined ? { id: it.id as string, title: it.title, url } : undefined
  })
  const section = nullable(m.section, (v) => {
    const it = idTitle(v, false)
    const index = isObj(v) ? intOrNull(v.index ?? null, 0, 100_000) : undefined
    return it && index !== undefined ? { ...it, index } : undefined
  })
  const lesson = nullable(m.lesson, (v) => {
    const it = idTitle(v, false)
    const index = isObj(v) ? intOrNull(v.index ?? null, 0, 100_000) : undefined
    const count = isObj(v) ? intOrNull(v.count ?? null, 0, 100_000) : undefined
    return it && index !== undefined && count !== undefined ? { ...it, index, count } : undefined
  })
  const playlist = nullable(m.playlist, (v) => {
    const it = idTitle(v, true)
    const index = isObj(v) ? intOrNull(v.index ?? null, 0, 100_000) : undefined
    const count = isObj(v) ? intOrNull(v.count ?? null, 0, 100_000) : undefined
    return it && index !== undefined && count !== undefined ? { id: it.id as string, title: it.title, index, count } : undefined
  })
  const channel = nullable(m.channel, (v) => {
    if (!isObj(v)) return undefined
    const id = strOrNull(v.id ?? null, ID_MAX)
    const name = strOrNull(v.name ?? null, TITLE_MAX)
    return id !== undefined && name !== undefined ? { id, name } : undefined
  })
  if (some(course, section, lesson, playlist, channel)) return undefined
  const confidence: Partial<Record<'course' | 'section' | 'lesson' | 'playlist' | 'channel', ExtFieldConfidence>> = {}
  if (m.confidence !== undefined && m.confidence !== null) {
    if (!isObj(m.confidence)) return undefined
    for (const k of ['course', 'section', 'lesson', 'playlist', 'channel'] as const) {
      const c = m.confidence[k]
      if (c === undefined) continue
      const ok = oneOf(c, CONFIDENCE)
      if (!ok) return undefined
      confidence[k] = ok
    }
  }
  return {
    type: 'page',
    tab,
    adapter,
    course: course ?? null,
    section: section ?? null,
    lesson: lesson ?? null,
    playlist: playlist ?? null,
    channel: channel ?? null,
    confidence
  }
}

function outline(m: Obj): ExtToNotula | undefined {
  const tab = str(m.tab, TAB_MAX)
  if (!tab || !Array.isArray(m.items) || m.items.length > OUTLINE_MAX) return undefined
  const items = []
  for (const it of m.items) {
    if (!isObj(it)) return undefined
    const number = intOrNull(it.number ?? null, 0, 100_000)
    const section = strOrNull(it.section ?? null, TITLE_MAX)
    const title = str(it.title, TITLE_MAX, true)
    const url = httpUrlOrNull(it.url ?? null)
    const duration = numOrNull(it.duration ?? null, 0, SECONDS_MAX)
    if (some(number, section, title, url, duration)) return undefined
    items.push({ number: number as number | null, section: section as string | null, title: title as string, url: url as string | null, duration: duration as number | null })
  }
  return { type: 'outline', tab, items }
}

function captions(m: Obj): ExtToNotula | undefined {
  const tab = str(m.tab, TAB_MAX)
  const video = str(m.video, VIDEO_MAX)
  const lang = str(m.lang, 35)
  const kind = oneOf(m.kind, ['manual', 'asr'] as const)
  const source = oneOf(m.source, ['player', 'replay', 'texttrack', 'dom'] as const)
  const parts = int(m.parts, 1, EXT_LIMITS.captionsParts)
  // 1-based.
  const part = int(m.part, 1, EXT_LIMITS.captionsParts)
  if (!tab || !video || !lang || !/^[A-Za-z0-9_-]+$/.test(lang) || !kind || !source || parts === undefined || part === undefined || part > parts) return undefined
  if (!Array.isArray(m.cues) || m.cues.length > CUES_MAX) return undefined
  const cues: ExtCue[] = []
  for (const c of m.cues) {
    if (!isObj(c)) return undefined
    const s = num(c.s, 0, SECONDS_MAX * 1_000)
    const e = num(c.e, 0, SECONDS_MAX * 1_000)
    const t = str(c.t, CUE_TEXT_MAX, true)
    if (s === undefined || e === undefined || t === undefined) return undefined
    // Line breaks are fine in cue text; other control characters were refused by `str`.
    cues.push({ s, e: Math.max(s, e), t })
  }
  return { type: 'captions', tab, video, lang, kind, source, part, parts, cues }
}

function captionsUnavailable(m: Obj): ExtToNotula | undefined {
  const tab = str(m.tab, TAB_MAX)
  const video = str(m.video, VIDEO_MAX)
  const reason = oneOf(m.reason, ['token-required', 'no-track', 'policy', 'failed'] as const)
  return tab && video && reason ? { type: 'captions-unavailable', tab, video, reason } : undefined
}

function chapters(m: Obj): ExtToNotula | undefined {
  const tab = str(m.tab, TAB_MAX)
  const video = str(m.video, VIDEO_MAX)
  const source = oneOf(m.source, ['player', 'description'] as const)
  if (!tab || !video || !source || !Array.isArray(m.items) || m.items.length > CHAPTERS_MAX) return undefined
  const items = []
  for (const it of m.items) {
    if (!isObj(it)) return undefined
    const start = num(it.start, 0, SECONDS_MAX)
    const title = str(it.title, TITLE_MAX, true)
    if (start === undefined || title === undefined) return undefined
    items.push({ start, title })
  }
  return { type: 'chapters', tab, video, items, source }
}

function mark(m: Obj): ExtToNotula | undefined {
  const tab = m.tab === null ? null : str(m.tab, TAB_MAX)
  const current_time = numOrNull(m.current_time, 0, SECONDS_MAX)
  const observed_at = int(m.observed_at, 0, 8.64e15)
  if (tab === undefined || current_time === undefined || observed_at === undefined) return undefined
  return { type: 'mark', tab, current_time, observed_at }
}

function logMsg(m: Obj): ExtToNotula | undefined {
  const event = str(m.event, EVENT_MAX)
  const count = int(m.count, 0, 1_000_000_000)
  // Counts only: an event name is a short code, never text from a page.
  if (!event || !/^[a-z0-9:._-]+$/i.test(event) || count === undefined) return undefined
  return { type: 'log', event, count }
}

const BUILDERS: Partial<Record<ExtToNotula['type'], (m: Obj) => ExtToNotula | undefined>> = {
  hello,
  media,
  'media.gone': mediaGone,
  page,
  outline,
  captions,
  'captions-unavailable': captionsUnavailable,
  chapters,
  mark,
  log: logMsg
}

/** One pipe line after `auth`. */
export function parseLine(line: string): ParsedLine {
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    return { ok: false, reason: 'json' }
  }
  if (!isObj(raw) || typeof raw.type !== 'string') return { ok: false, reason: 'invalid' }
  const build = BUILDERS[raw.type as ExtToNotula['type']]
  if (!build) return { ok: false, reason: (EXT_MESSAGE_TYPES as readonly string[]).includes(raw.type) ? 'invalid' : 'unknown' }
  const msg = build(raw)
  return msg ? { ok: true, msg } : { ok: false, reason: 'invalid' }
}
