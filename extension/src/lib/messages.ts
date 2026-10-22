// SPDX-License-Identifier: Apache-2.0
// Messages inside the extension: content scripts ⇄ service worker ⇄ popup and options. Content
// scripts run next to pages we don't control, so the service worker rebuilds every one of their
// messages with `parseContentMessage` before using it, and caps their sizes.

import type {
  ExtAdapter,
  ExtCue,
  ExtFieldConfidence,
  ExtOutlineItem,
  ExtPage
} from '../../../src/shared/types/extension-protocol'
import { bool, clean, int, isObj, num, numOrNull, oneOf, str, strOrNull, type Obj } from './check'

// ---------- content script → service worker ----------

export interface FrameMedia {
  /** Seconds; while an ad shows, the last content position. */
  current_time: number
  duration: number | null
  rate: number
  paused: boolean
  ended: boolean
  live: boolean
  muted: boolean
  /** Epoch ms of the last play; ties between frames go to the latest. */
  started_at: number
  /** On-screen area in CSS px², for picking the main frame. */
  area: number
}

export type FrameEvent = 'play' | 'pause' | 'seek' | 'rate' | 'ended' | 'tick' | 'change' | 'gone' | 'load'

export interface FrameReport {
  k: 'report'
  event: FrameEvent
  url: string
  title: string
  canonical_url: string | null
  adapter: ExtAdapter
  /** The adapter's canonical key for what plays, when it knows one. */
  video: string | null
  media: FrameMedia | null
  ad: boolean
  session: { title: string | null; artist: string | null; album: string | null } | null
}

export type PageFields = Omit<ExtPage, 'type' | 'tab'>

export interface PageReport {
  k: 'page'
  video: string | null
  page: PageFields
}

export interface CaptionsTrack {
  video: string
  lang: string
  kind: 'manual' | 'asr'
  source: 'player' | 'replay' | 'texttrack' | 'dom'
  cues: ExtCue[]
}

export interface CaptionsReport extends CaptionsTrack {
  k: 'captions'
}

export interface ChaptersReport {
  k: 'chapters'
  video: string
  items: { start: number; title: string }[]
  source: 'player' | 'description'
}

/** A field the adapter couldn't find (counted as `adapter-miss:<site>:<field>`). */
export interface MissReport {
  k: 'miss'
  field: string
}

export type ContentMessage = FrameReport | PageReport | CaptionsReport | ChaptersReport | MissReport

// ---------- service worker → content script (replies) ----------

export type ContentRequest =
  | { k: 'snapshot' }
  | { k: 'outline' }
  | { k: 'captions'; video: string; langs: string[]; replay: boolean }
  | { k: 'transcript' }

export type CaptionsReply =
  | { status: 'ok'; track: CaptionsTrack }
  | { status: 'unavailable'; reason: 'token-required' | 'no-track' | 'policy' | 'failed' }

/** The content script's answer to `transcript`. */
export type TranscriptRead = { status: 'ok'; track: CaptionsTrack } | { status: 'none' | 'failed' }

/** What the popup gets back. */
export type TranscriptReply = { status: 'ok'; count: number } | { status: 'none' | 'failed' }

// ---------- popup / options → service worker ----------

export type PopupRequest =
  | { k: 'popup:state'; tabId: number | null }
  | { k: 'popup:mark' }
  | { k: 'popup:accept' }
  | { k: 'popup:connect' }
  | { k: 'popup:site-pending'; origin: string; tabId: number | null }
  | { k: 'popup:site-on'; origin: string; tabId: number | null }
  | { k: 'popup:site-off'; origin: string }
  | { k: 'popup:link-tab'; tabId: number }
  | { k: 'popup:transcript'; tabId: number }

/** What the popup shows (the bridge state, as the popup names it). */
export type PopupConnection =
  | 'setup'
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'off-in-notula'
  | 'not-running'
  | 'host-missing'
  | 'host-forbidden'
  | 'host-failed'
  | 'app-outdated'
  | 'extension-outdated'

export interface PopupState {
  connection: PopupConnection
  appVersion: string | null
  /** The tab's site and what the extension does there. */
  site: { origin: string | null; access: 'youtube' | 'on' | 'linked' | 'off' | 'unsupported' }
  adapter: ExtAdapter | null
  playing: boolean
  incognitoPaused: boolean
  captionsHint: boolean
  canReadTranscript: boolean
  lastMark: { ok: boolean; position: string | null; reason: string | null; at: number } | null
  transcript: { count: number; sent: boolean; at: number } | null
}

// ---------- validation ----------

const ADAPTERS: readonly ExtAdapter[] = ['youtube', 'circle', 'udemy', 'coursera', 'generic']
const EVENTS: readonly FrameEvent[] = ['play', 'pause', 'seek', 'rate', 'ended', 'tick', 'change', 'gone', 'load']
const CONF: readonly ExtFieldConfidence[] = ['page', 'heuristic']

export const CAPS = {
  url: 2_048,
  title: 300,
  meta: 200,
  key: 2_100,
  cues: 40_000,
  cueText: 1_000,
  outline: 2_000,
  chapters: 500
} as const

function media(v: unknown): FrameMedia | null | undefined {
  if (v === null) return null
  if (!isObj(v)) return undefined
  const current_time = num(v.current_time, 0, 1e7)
  const duration = numOrNull(v.duration, 0, 1e7)
  const rate = num(v.rate, 0, 16)
  const paused = bool(v.paused)
  const ended = bool(v.ended)
  const live = bool(v.live)
  const muted = bool(v.muted)
  const started_at = num(v.started_at, 0)
  const area = num(v.area, 0)
  if (
    current_time === undefined || duration === undefined || rate === undefined || paused === undefined ||
    ended === undefined || live === undefined || muted === undefined || started_at === undefined || area === undefined
  ) {
    return undefined
  }
  return { current_time, duration, rate, paused, ended, live, muted, started_at, area }
}

function session(v: unknown): FrameReport['session'] | undefined {
  if (v === null) return null
  if (!isObj(v)) return undefined
  const title = strOrNull(v.title, CAPS.meta)
  const artist = strOrNull(v.artist, CAPS.meta)
  const album = strOrNull(v.album, CAPS.meta)
  if (title === undefined || artist === undefined || album === undefined) return undefined
  return { title, artist, album }
}

function idTitle(v: unknown, withIndex: boolean): Obj | null | undefined {
  if (v === null || v === undefined) return null
  if (!isObj(v)) return undefined
  const out: Obj = {}
  for (const [k, val] of Object.entries(v)) {
    if (k === 'id' || k === 'title' || k === 'name' || k === 'url') {
      if (val !== null && typeof val !== 'string') return undefined
      out[k] = val === null ? null : clean(val as string, k === 'url' ? CAPS.url : CAPS.title)
    } else if (withIndex && (k === 'index' || k === 'count')) {
      const n = val === null ? null : int(val, 0, 100_000)
      if (n === undefined) return undefined
      out[k] = n
    }
  }
  return out
}

function pageFields(v: unknown): PageFields | undefined {
  if (!isObj(v)) return undefined
  const adapter = oneOf(v.adapter, ADAPTERS)
  if (!adapter) return undefined
  const course = idTitle(v.course, false)
  const section = idTitle(v.section, true)
  const lesson = idTitle(v.lesson, true)
  const playlist = idTitle(v.playlist, true)
  const channel = idTitle(v.channel, false)
  if (course === undefined || section === undefined || lesson === undefined || playlist === undefined || channel === undefined) {
    return undefined
  }
  const confidence: PageFields['confidence'] = {}
  if (isObj(v.confidence)) {
    for (const f of ['course', 'section', 'lesson', 'playlist', 'channel'] as const) {
      const c = oneOf(v.confidence[f], CONF)
      if (c) confidence[f] = c
    }
  }
  return {
    adapter,
    course: course && typeof course.id === 'string'
      ? { id: course.id, title: (course.title as string | null) ?? null, url: (course.url as string | null) ?? null }
      : null,
    section: section
      ? { id: (section.id as string | null) ?? null, title: (section.title as string | null) ?? null, index: (section.index as number | null) ?? null }
      : null,
    lesson: lesson
      ? {
          id: (lesson.id as string | null) ?? null,
          title: (lesson.title as string | null) ?? null,
          index: (lesson.index as number | null) ?? null,
          count: (lesson.count as number | null) ?? null
        }
      : null,
    playlist: playlist && typeof playlist.id === 'string'
      ? {
          id: playlist.id,
          title: (playlist.title as string | null) ?? null,
          index: (playlist.index as number | null) ?? null,
          count: (playlist.count as number | null) ?? null
        }
      : null,
    channel: channel ? { id: (channel.id as string | null) ?? null, name: (channel.name as string | null) ?? null } : null,
    confidence
  }
}

export function parseCues(v: unknown): ExtCue[] | undefined {
  if (!Array.isArray(v) || v.length > CAPS.cues) return undefined
  const out: ExtCue[] = []
  for (const c of v) {
    if (!isObj(c)) return undefined
    const s = int(c.s, 0, 1e10)
    const e = int(c.e, 0, 1e10)
    const t = str(c.t, CAPS.cueText)
    if (s === undefined || e === undefined || t === undefined) return undefined
    out.push({ s, e: Math.max(s, e), t })
  }
  return out
}

export function parseTrack(v: Obj): CaptionsTrack | undefined {
  const video = str(v.video, CAPS.key)
  const lang = str(v.lang, 35)
  const kind = oneOf(v.kind, ['manual', 'asr'] as const)
  const source = oneOf(v.source, ['player', 'replay', 'texttrack', 'dom'] as const)
  const cues = parseCues(v.cues)
  if (!video || !lang || !kind || !source || !cues) return undefined
  return { video, lang, kind, source, cues }
}

/** Rebuilds a content script's message from known keys; undefined when anything is off. */
export function parseContentMessage(v: unknown): ContentMessage | undefined {
  if (!isObj(v)) return undefined
  switch (v.k) {
    case 'report': {
      const event = oneOf(v.event, EVENTS)
      const url = str(v.url, CAPS.url)
      const title = str(v.title, CAPS.title)
      const canonical_url = strOrNull(v.canonical_url, CAPS.url)
      const adapter = oneOf(v.adapter, ADAPTERS)
      const video = strOrNull(v.video, CAPS.key)
      const m = media(v.media)
      const ad = bool(v.ad)
      const s = session(v.session)
      if (
        !event || url === undefined || title === undefined || canonical_url === undefined || !adapter ||
        video === undefined || m === undefined || ad === undefined || s === undefined
      ) {
        return undefined
      }
      return { k: 'report', event, url, title, canonical_url, adapter, video, media: m, ad, session: s }
    }
    case 'page': {
      const video = strOrNull(v.video, CAPS.key)
      const page = pageFields(v.page)
      if (video === undefined || !page) return undefined
      return { k: 'page', video, page }
    }
    case 'captions': {
      const track = parseTrack(v)
      return track ? { k: 'captions', ...track } : undefined
    }
    case 'chapters': {
      const video = str(v.video, CAPS.key)
      const source = oneOf(v.source, ['player', 'description'] as const)
      if (!video || !source || !Array.isArray(v.items) || v.items.length > CAPS.chapters) return undefined
      const items: { start: number; title: string }[] = []
      for (const it of v.items) {
        if (!isObj(it)) return undefined
        const start = num(it.start, 0, 1e7)
        const title = str(it.title, CAPS.title)
        if (start === undefined || title === undefined) return undefined
        items.push({ start, title })
      }
      return { k: 'chapters', video, items, source }
    }
    case 'miss': {
      const field = str(v.field, 40)
      return field && /^[a-z-]+$/.test(field) ? { k: 'miss', field } : undefined
    }
    default:
      return undefined
  }
}

export function parseOutline(v: unknown): ExtOutlineItem[] | undefined {
  if (!Array.isArray(v)) return undefined
  const out: ExtOutlineItem[] = []
  for (const it of v.slice(0, CAPS.outline)) {
    if (!isObj(it)) return undefined
    const number = numOrNull(it.number, 0, 100_000)
    const section = strOrNull(it.section, CAPS.title)
    const title = str(it.title, CAPS.title)
    const url = strOrNull(it.url, CAPS.url)
    const duration = numOrNull(it.duration, 0, 1e7)
    if (number === undefined || section === undefined || title === undefined || url === undefined || duration === undefined) {
      return undefined
    }
    out.push({ number, section, title, url, duration })
  }
  return out
}

export function parseCaptionsReply(v: unknown): CaptionsReply | undefined {
  if (!isObj(v)) return undefined
  if (v.status === 'ok' && isObj(v.track)) {
    const track = parseTrack(v.track)
    return track ? { status: 'ok', track } : undefined
  }
  if (v.status === 'unavailable') {
    const reason = oneOf(v.reason, ['token-required', 'no-track', 'policy', 'failed'] as const)
    return reason ? { status: 'unavailable', reason } : undefined
  }
  return undefined
}
