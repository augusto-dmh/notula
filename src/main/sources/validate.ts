// SPDX-License-Identifier: Apache-2.0
// Payload whitelisting for the `sources:*` handlers of the sources core. A renderer payload is
// rebuilt from known keys only; anything else rejects with `invalid-input`. `sources:update` takes
// the renderer's `NoteSourcePatch` fields only (storage also takes main-only fields).

import { notulaError } from '@shared/errors'
import type {
  LessonState,
  NoteSourcePatch,
  SeriesHint,
  SeriesKind,
  SourceConfidence,
  SourceDetectedVia,
  SourceDraft,
  SourceHint,
  SourceKind,
  SourceProvider
} from '@shared/types/sources'
import { id, object } from '../notes/validate'

const PROVIDERS: readonly SourceProvider[] = ['youtube', 'circle', 'udemy', 'coursera', 'hotmart', 'kiwify', 'memberkit', 'vimeo', 'web']
const KINDS: readonly SourceKind[] = ['video', 'live', 'lesson', 'other']
const CONFIDENCES: readonly SourceConfidence[] = ['exact', 'high', 'guess']
const DETECTED_VIA: readonly SourceDetectedVia[] = ['media-session', 'history', 'search', 'extension', 'manual', 'backfill', 'import']
const SERIES_KINDS: readonly SeriesKind[] = ['course', 'playlist', 'channel', 'custom']
const LESSON_STATES: readonly LessonState[] = ['numbered', 'guessed', 'pending']
const HINTS: readonly SourceHint[] = ['course-host', 'file-rule', 'same-as']

const MAX_KEY = 2_048
const MAX_URL = 4_096
const MAX_TITLE = 1_000
const MAX_NAME = 500
const MAX_LABEL = 200
const MAX_QUERY = 300
const MAX_LESSON = 100_000
const MAX_DURATION_MS = 7 * 24 * 60 * 60_000
/** The same cap as `notes_md` (storage enforces it too). */
const MAX_STAMPED = 4 * 1024 * 1024
const HINT_KEY = /^[^\s]{1,300}$/

const bad = (what: string): Error => notulaError('invalid-input', what)

function oneOf<T extends string>(v: unknown, list: readonly T[], what: string): T {
  if (typeof v !== 'string' || !(list as readonly string[]).includes(v)) throw bad(`${what} is not valid`)
  return v as T
}

function str(v: unknown, what: string, max: number, opts: { empty?: boolean } = {}): string {
  if (typeof v !== 'string') throw bad(`${what} must be a string`)
  const s = v.trim()
  if (!opts.empty && !s) throw bad(`${what} must not be empty`)
  if (s.length > max) throw bad(`${what} is too long`)
  return s
}

function strOrNull(v: unknown, what: string, max: number): string | null {
  if (v === null || v === undefined) return null
  const s = str(v, what, max, { empty: true })
  return s || null
}

function intOrNull(v: unknown, what: string, max: number): number | null {
  if (v === null || v === undefined) return null
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > max) throw bad(`${what} is not valid`)
  return v
}

/** http(s) only. */
export function urlOrNull(v: unknown, what = 'url'): string | null {
  const s = strOrNull(v, what, MAX_URL)
  if (s === null) return null
  let u: URL
  try {
    u = new URL(s)
  } catch {
    throw bad(`${what} is not a URL`)
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw bad(`${what} must be http(s)`)
  return s
}

function seriesHint(v: unknown): SeriesHint | null {
  if (v === null || v === undefined) return null
  const r = object(v, 'series')
  return {
    kind: oneOf(r['kind'], SERIES_KINDS, 'series.kind'),
    provider: oneOf(r['provider'], PROVIDERS, 'series.provider'),
    canonicalKey: str(r['canonicalKey'], 'series.canonicalKey', MAX_KEY),
    title: strOrNull(r['title'], 'series.title', MAX_TITLE),
    index: intOrNull(r['index'], 'series.index', MAX_LESSON),
    section: strOrNull(r['section'], 'series.section', MAX_NAME)
  }
}

function lesson(v: unknown): SourceDraft['lesson'] {
  if (v === null || v === undefined) return null
  const r = object(v, 'lesson')
  return {
    number: intOrNull(r['number'], 'lesson.number', MAX_LESSON),
    label: strOrNull(r['label'], 'lesson.label', MAX_LABEL),
    state: oneOf(r['state'], LESSON_STATES, 'lesson.state')
  }
}

export function draft(v: unknown): SourceDraft {
  const r = object(v, 'draft')
  if (typeof r['live'] !== 'boolean') throw bad('draft.live must be a boolean')
  return {
    canonicalKey: str(r['canonicalKey'], 'draft.canonicalKey', MAX_KEY),
    provider: oneOf(r['provider'], PROVIDERS, 'draft.provider'),
    kind: oneOf(r['kind'], KINDS, 'draft.kind'),
    url: urlOrNull(r['url'], 'draft.url'),
    title: str(r['title'], 'draft.title', MAX_TITLE),
    channel: strOrNull(r['channel'], 'draft.channel', MAX_NAME),
    durationMs: intOrNull(r['durationMs'], 'draft.durationMs', MAX_DURATION_MS),
    live: r['live'],
    confidence: oneOf(r['confidence'], CONFIDENCES, 'draft.confidence'),
    detectedVia: oneOf(r['detectedVia'], DETECTED_VIA, 'draft.detectedVia'),
    site: strOrNull(r['site'], 'draft.site', MAX_NAME),
    series: seriesHint(r['series']),
    lesson: lesson(r['lesson'])
  }
}

export function noteIdRequest(v: unknown): { noteId: string } {
  return { noteId: id(object(v, 'request')['noteId'], 'noteId') }
}

export function createRequest(v: unknown): { draft: SourceDraft; mode: 'new' | 'continue'; noteId: string | null; playbackId: string | null } {
  const r = object(v, 'request')
  const mode = oneOf(r['mode'], ['new', 'continue'] as const, 'mode')
  const noteId = r['noteId'] === null || r['noteId'] === undefined ? null : id(r['noteId'], 'noteId')
  if (mode === 'continue' && !noteId) throw bad('Continue needs a note')
  const playbackId = strOrNull(r['playbackId'], 'playbackId', 200)
  return { draft: draft(r['draft']), mode, noteId, playbackId }
}

export function linkRequest(v: unknown): { noteId: string; draft: SourceDraft } {
  const r = object(v, 'request')
  return { noteId: id(r['noteId'], 'noteId'), draft: draft(r['draft']) }
}

/** The renderer-writable fields only; `undefined` keeps a field, `null` clears it. */
export function patchRequest(v: unknown): { noteId: string; patch: NoteSourcePatch } {
  const r = object(v, 'request')
  const p = object(r['patch'], 'patch')
  const patch: NoteSourcePatch = {}
  if (p['title'] !== undefined) patch.title = str(p['title'], 'title', MAX_TITLE)
  if (p['channel'] !== undefined) patch.channel = strOrNull(p['channel'], 'channel', MAX_NAME)
  if (p['url'] !== undefined) patch.url = urlOrNull(p['url'])
  if (p['series_id'] !== undefined) patch.series_id = p['series_id'] === null ? null : id(p['series_id'], 'series_id')
  if (p['lesson_number'] !== undefined) patch.lesson_number = intOrNull(p['lesson_number'], 'lesson_number', MAX_LESSON)
  if (p['lesson_label'] !== undefined) patch.lesson_label = strOrNull(p['lesson_label'], 'lesson_label', MAX_LABEL)
  if (p['notes_md_stamped'] !== undefined) {
    const s = p['notes_md_stamped']
    if (s !== null && typeof s !== 'string') throw bad('notes_md_stamped must be a string')
    if (typeof s === 'string' && s.length > MAX_STAMPED) throw bad('notes_md_stamped is too long')
    patch.notes_md_stamped = s
  }
  return { noteId: id(r['noteId'], 'noteId'), patch }
}

export function searchRequest(v: unknown): { query: string } {
  return { query: str(object(v, 'request')['query'], 'query', MAX_QUERY) }
}

export function seriesIdRequest(v: unknown): { seriesId: string } {
  return { seriesId: id(object(v, 'request')['seriesId'], 'seriesId') }
}

export function grantRequest(v: unknown): { readHistory?: boolean; onlineLookups?: boolean } {
  const r = object(v, 'request')
  const out: { readHistory?: boolean; onlineLookups?: boolean } = {}
  for (const k of ['readHistory', 'onlineLookups'] as const) {
    if (r[k] === undefined) continue
    if (typeof r[k] !== 'boolean') throw bad(`${k} must be a boolean`)
    out[k] = r[k]
  }
  return out
}

export function hintRequest(v: unknown): { hint: SourceHint; key: string } {
  const r = object(v, 'request')
  const key = r['key']
  if (typeof key !== 'string' || !HINT_KEY.test(key)) throw bad('key is not valid')
  return { hint: oneOf(r['hint'], HINTS, 'hint'), key }
}
