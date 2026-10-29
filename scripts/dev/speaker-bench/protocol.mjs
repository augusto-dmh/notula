// SPDX-License-Identifier: Apache-2.0
// The open-set protocol and the plans the app's replay feed runs:
// ~30 % of the people held out as never enrolled, each other person enrolled from their first
// k meetings (k ≤ 3) through the real naming path, everything later tested.

import { rng, shuffle } from './stats.mjs'

export const BENCH_VERSION = 1

/** The held-out people: about `share` of everyone but the user, at least one when three or more. */
export function heldOutPeople(manifest, { seed = 1, share = 0.3 } = {}) {
  const others = manifest.people.filter((p) => !p.self).map((p) => p.id)
  const n = others.length >= 3 ? Math.max(1, Math.round(others.length * share)) : 0
  return shuffle(others, rng(seed)).slice(0, n).sort()
}

/** Who each meeting enrolls: labelled, not held out, and still under `k` enrollment meetings. */
export function schedule(meetings, { k = 1, heldOut = [] } = {}) {
  const count = new Map()
  const enrolledIn = {}
  const out = meetings.map((m) => {
    const speakers = [...new Set(m.labels.map((l) => l.person))].filter((p) => p !== 'unknown' && p !== 'other')
    const enroll = speakers.filter((p) => !heldOut.includes(p) && (count.get(p) ?? 0) < k)
    for (const p of enroll) {
      count.set(p, (count.get(p) ?? 0) + 1)
      ;(enrolledIn[p] ??= []).push(m.id)
    }
    return { meeting: m, enroll }
  })
  return { meetings: out, enrolledIn }
}

/** The scratch profile's settings for a bench run: every speaker layer on, the notice seen. */
export function benchSettings(manifest) {
  const self = manifest.people.find((p) => p.self)
  return {
    'transcription.diarization': true,
    'speakers.voices': true,
    'speakers.selfVoice': !!self,
    'speakers.selfPassive': false,
    'speakers.appNames': true,
    'speakers.noticeSeen': true,
    'attribution.zoom': true,
    'attribution.teams': true,
    'attribution.meet': true,
    'speakerNames.suggestions': true,
    'audio.keepRecordings': false,
    'profile.name': self?.name ?? 'Bench User',
    'profile.email': self?.email ?? 'bench-user@bench.invalid'
  }
}

/** A meeting as the feed takes it. */
export function feedMeeting(m, overrides = {}) {
  return {
    id: m.id,
    title: m.title,
    language: m.language,
    audio: m.audio.map((a) => ({ channel: a.channel, path: a.path, offsetMs: a.offsetMs ?? 0 })),
    attendees: m.attendees,
    uia: m.uia ? { app: m.uia.app, path: m.uia.path } : null,
    labels: m.labels,
    ...overrides
  }
}

export function basePlan({ runId, resultsPath, dry, manifest, people, settings, secret = null, mockProvider, enrolled = {}, feedStarts = {}, steps }) {
  return {
    version: 1,
    runId,
    resultsPath,
    dry,
    settings,
    secret,
    mockProvider,
    people: people ?? manifest.people.map(({ id, name, email, self }) => ({ id, name, email, ...(self ? { self: true } : {}) })),
    enrolled,
    feedStarts,
    steps
  }
}
