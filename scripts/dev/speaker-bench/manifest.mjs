// SPDX-License-Identifier: Apache-2.0
// The private manifest: paths and labels of your dataset, kept
// outside the repo. The bench refuses a manifest, an audio file or a label file inside the
// working tree, unless it is a fixture the bench composed into its own git-ignored folder.

import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

export const ROOT = resolve(import.meta.dirname, '..', '..', '..')
/** The git-ignored folder the bench writes into (fixtures, dry profiles, reports). */
export const BENCH_DIR = join(ROOT, '.speaker-bench')

function inside(parent, path) {
  const r = relative(parent, resolve(path))
  return r === '' || (!r.startsWith('..') && !isAbsolute(r))
}

/** Real data stays outside the repo; only the bench's own folder may hold composed fixtures. */
export function assertPrivatePath(path, what) {
  if (inside(ROOT, path) && !inside(BENCH_DIR, path)) throw new Error(`${what} must live outside the repo: ${path}`)
}

const CHANNELS = ['mic', 'system']
const APPS = ['zoom', 'teams', 'meet']

/**
 * Reads and checks a manifest. Paths may be relative to the manifest's folder. Labels are
 * inline spans, or a file (`labels`: "labels/m01.json", as `export-labels` writes it).
 */
export function loadManifest(path, { allowRepo = false } = {}) {
  if (!allowRepo) assertPrivatePath(path, 'The manifest')
  const base = dirname(resolve(path))
  const at = (p) => (isAbsolute(p) ? p : join(base, p))
  const m = JSON.parse(readFileSync(path, 'utf8'))
  if (m.version !== 1) throw new Error('manifest.version must be 1')
  if (!Array.isArray(m.people) || !Array.isArray(m.meetings)) throw new Error('manifest.people and manifest.meetings must be lists')
  const ids = new Set()
  for (const p of m.people) {
    if (typeof p.id !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(p.id)) throw new Error(`person id ${p.id} must be a short pseudonym`)
    if (ids.has(p.id)) throw new Error(`person ${p.id} appears twice`)
    ids.add(p.id)
    if (typeof p.name !== 'string' || !p.name.trim()) throw new Error(`person ${p.id} needs a name`)
    p.email = (typeof p.email === 'string' && p.email.trim() ? p.email : `${p.id}@bench.invalid`).trim().toLowerCase()
  }
  if (m.people.filter((p) => p.self).length > 1) throw new Error('at most one person is the user (self)')
  const meetingIds = new Set()
  for (const x of m.meetings) {
    if (typeof x.id !== 'string' || meetingIds.has(x.id)) throw new Error(`meeting id ${x.id} is missing or repeated`)
    meetingIds.add(x.id)
    if (typeof x.language !== 'string') throw new Error(`meeting ${x.id} needs a language (pt-BR, en, multi)`)
    x.title = typeof x.title === 'string' && x.title.trim() ? x.title : `Bench ${x.id}`
    if (!Array.isArray(x.audio) || !x.audio.length || x.audio.length > 2) throw new Error(`meeting ${x.id} needs one or two audio files`)
    for (const a of x.audio) {
      if (!CHANNELS.includes(a.channel)) throw new Error(`meeting ${x.id}: audio channel must be mic or system`)
      a.path = at(a.path)
      a.offsetMs = Number(a.offsetMs ?? 0)
      if (!allowRepo) assertPrivatePath(a.path, `Audio of ${x.id}`)
      if (!existsSync(a.path)) throw new Error(`meeting ${x.id}: ${a.path} not found`)
    }
    if (new Set(x.audio.map((a) => a.channel)).size !== x.audio.length) throw new Error(`meeting ${x.id}: one file per channel`)
    x.attendees = Array.isArray(x.attendees) ? x.attendees : []
    for (const a of x.attendees) if (!ids.has(a)) throw new Error(`meeting ${x.id}: attendee ${a} is not a person`)
    if (x.uia) {
      if (!APPS.includes(x.uia.app)) throw new Error(`meeting ${x.id}: uia.app must be zoom, teams or meet`)
      x.uia.path = at(x.uia.path)
      if (!allowRepo) assertPrivatePath(x.uia.path, `The UIA stream of ${x.id}`)
    } else x.uia = null
    // `export-labels` writes labels/<meeting>.json next to the manifest; it is used when no labels are given.
    if (x.labels === undefined && existsSync(join(base, 'labels', `${x.id}.json`))) x.labels = `labels/${x.id}.json`
    if (typeof x.labels === 'string') {
      const file = at(x.labels)
      x.labels = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).spans : []
    }
    x.labels = Array.isArray(x.labels) ? x.labels : []
    for (const l of x.labels) {
      if (!CHANNELS.includes(l.channel) || !(l.endMs > l.startMs)) throw new Error(`meeting ${x.id}: a label span is malformed`)
      if (l.person !== 'unknown' && l.person !== 'other' && !ids.has(l.person)) throw new Error(`meeting ${x.id}: label person ${l.person} is not a person`)
    }
  }
  m.meetings.sort((a, b) => String(a.date ?? '').localeCompare(String(b.date ?? '')) || a.id.localeCompare(b.id))
  m.models = Array.isArray(m.models) ? m.models.map((x) => ({ ...x, path: at(x.path) })) : []
  if (m.stress?.sources) for (const s of m.stress.sources) if (Array.isArray(s.files)) s.files = s.files.map(at)
  m.dir = base
  return m
}

/** The cluster's label: the person (or `unknown`, `other`) holding ≥ 50 % of its word time on that channel, else null. */
export function labelOf(segments, channel, labels) {
  const held = new Map()
  let total = 0
  for (const [s, e] of segments) {
    total += e - s
    for (const l of labels) {
      if (l.channel !== channel) continue
      const o = Math.min(e, l.endMs) - Math.max(s, l.startMs)
      if (o > 0) held.set(l.person, (held.get(l.person) ?? 0) + o)
    }
  }
  const best = [...held].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]
  return best && total > 0 && best[1] * 2 >= total ? best[0] : null
}

/** A label for someone outside the manifest's people. */
export const isOutsider = (label) => label === 'unknown' || label === 'other'
