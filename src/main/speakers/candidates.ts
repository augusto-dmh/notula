// SPDX-License-Identifier: Apache-2.0
// The facts the post-meeting job, relabel and the bench's rerun decide from (speaker
// profiles): per cluster of one pass, its word time, confirmed share and meeting-app tiles,
// read from the chunks; and the note's candidates (attendees of the linked event, self,
// meeting-app names, known people). Main only: cluster vectors join here and never leave.

import { wordIdentityKeys } from '@shared/lib/speakers'
import type { AudioSource } from '@shared/types/common'
import type { Note } from '@shared/types/notes'
import type { SpeakerAutoSource, SpeakerCalibrationLanguage, SpeakerChannel } from '@shared/types/speakers'
import { SPEAKER_PROFILE_LIMITS } from '@shared/types/speakers'
import type { ProviderWord, TranscriptChunk } from '@shared/types/transcript'
import type { MainContext } from '../context'
import { recurringEventId } from '../folders/series'
import type { SpeakerPendingRow, SpeakerPersonRow } from '../storage/api'
import type { DecideCandidate, DecideCluster, DecideTile } from './decide'
import { foldName } from './decide/evidence'
import type { JobLlmCandidate } from './names'
import { clusterForSpan } from './pending-span'

const DAY_MS = 86_400_000
/** A participant name that looks like a meeting room (the enhance prompts' rule). */
const ROOM_NAME = /\b(room|boardroom|conference|huddle|meeting space)\b/i
/**
 * A tile whose stamped words fall on two clusters, the second holding at least this share of
 * them, is one device shared by several people: a room tile. A smaller second share is
 * the readers' lag at turn edges, which must not cost a real tile its name.
 */
const ROOM_SECOND_SHARE = 0.25

export function channelOf(source: AudioSource): SpeakerChannel {
  return source === 'microphone' ? 'mic' : 'system'
}

function wordMs(w: ProviderWord): number {
  return Math.max(1, w.e_ms - w.s_ms)
}

/** One cluster of a pass, as its words read now. */
export interface PassClusterStats {
  /** `r:<passId>:r<N>`. */
  key: string
  /** `r<N>`. */
  label: string
  source: AudioSource
  channel: SpeakerChannel
  /** Word time. */
  speechMs: number
  confirmedMs: number
  /** More than 50 % of its speech carries `confirmed_spk`: the pipeline leaves it alone. */
  confirmed: boolean
  /** The first `confirmed_spk` by word time, for `KNOWN SPEAKERS`. */
  confirmedName: string | null
  /** The `auto_*` already on its words (relabel only raises). */
  auto: { name: string; personId: string | null; src: SpeakerAutoSource | null } | null
  /** `att` name → stamped word time. */
  att: Map<string, number>
  stampedMs: number
  /** Epoch ms of its first and last word. */
  startMs: number
  endMs: number
}

/** The clusters of `passId` in the note's chunks, by identity key (the neighbour fill included). */
export function passClusters(chunks: readonly TranscriptChunk[], passId: string): Map<string, PassClusterStats> {
  const prefix = `r:${passId}:`
  const final = chunks.filter((c) => c.is_final)
  const keys = wordIdentityKeys(final)
  const out = new Map<string, PassClusterStats & { confirmedBy: Map<string, number> }>()
  for (const c of final) {
    const d = c.providerDetails
    const ks = keys.get(c.id)
    if (!d || !ks || d.mergeScopeId !== passId) continue
    d.words.forEach((w, i) => {
      const k = ks[i]
      if (!k || !k.startsWith(prefix)) return
      let s = out.get(k)
      if (!s) {
        s = {
          key: k,
          label: k.slice(prefix.length),
          source: c.source,
          channel: channelOf(c.source),
          speechMs: 0,
          confirmedMs: 0,
          confirmed: false,
          confirmedName: null,
          confirmedBy: new Map(),
          auto: null,
          att: new Map(),
          stampedMs: 0,
          startMs: Infinity,
          endMs: -Infinity
        }
        out.set(k, s)
      }
      const ms = wordMs(w)
      s.speechMs += ms
      s.startMs = Math.min(s.startMs, d.wallClockAnchorMs + w.s_ms)
      s.endMs = Math.max(s.endMs, d.wallClockAnchorMs + w.e_ms)
      const confirmed = w.confirmed_spk?.trim()
      if (confirmed) {
        s.confirmedMs += ms
        s.confirmedBy.set(confirmed, (s.confirmedBy.get(confirmed) ?? 0) + ms)
      }
      const auto = w.auto_spk?.trim()
      if (auto && !s.auto) s.auto = { name: auto, personId: w.auto_pid ?? null, src: w.auto_src ?? null }
      const att = c.source === 'system' ? w.att?.trim() : undefined
      if (att) {
        s.att.set(att, (s.att.get(att) ?? 0) + ms)
        s.stampedMs += ms
      }
    })
  }
  for (const s of out.values()) {
    s.confirmed = s.confirmedMs * 2 > s.speechMs
    s.confirmedName = [...s.confirmedBy].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
  }
  return new Map([...out].map(([k, { confirmedBy: _c, ...s }]) => [k, s]))
}

/** Pending requests resolved to this pass's clusters: cluster key → person ids. */
export function pendingByCluster(chunks: readonly TranscriptChunk[], passId: string, rows: readonly SpeakerPendingRow[]): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const r of rows) {
    const k = clusterForSpan(chunks, passId, r)
    if (k) out.set(k, [...(out.get(k) ?? []), r.personId])
  }
  return out
}

/**
 * Every tile stamped on the pass's system clusters, with its kind (room tiles flagged).
 * `flagged.byShare` counts the tiles only the second-cluster share rule made rooms (for the bench's platform replays).
 */
export function tileKinds(stats: Iterable<PassClusterStats>, userName: string, flagged?: { byShare: number }): Map<string, DecideTile['kind']> {
  const byTile = new Map<string, number[]>()
  for (const s of stats) for (const [name, ms] of s.att) byTile.set(name, [...(byTile.get(name) ?? []), ms])
  const me = foldName(userName)
  const out = new Map<string, DecideTile['kind']>()
  for (const [name, parts] of byTile) {
    const sorted = [...parts].sort((a, b) => b - a)
    const total = sorted.reduce((a, b) => a + b, 0)
    let kind: DecideTile['kind'] = 'individual'
    // The readers already drop the user's own tile; a name equal to the profile name is kept out too.
    if (me && foldName(name) === me) kind = 'self'
    else if (ROOM_NAME.test(name)) kind = 'room'
    else if (total > 0 && (sorted[1] ?? 0) / total >= ROOM_SECOND_SHARE) {
      kind = 'room'
      if (flagged) flagged.byShare++
    }
    out.set(name, kind)
  }
  return out
}

/** The cluster as `decide` takes it. `cleanMs` and `vector` come from the pass or the 14-day store. */
export function decideCluster(
  s: PassClusterStats,
  kinds: ReadonlyMap<string, DecideTile['kind']>,
  language: SpeakerCalibrationLanguage,
  voice: { cleanMs: number; vector: Float32Array | null }
): DecideCluster {
  const tiles: DecideTile[] =
    s.channel === 'system' && s.stampedMs > 0
      ? [...s.att].map(([name, ms]) => ({ participantId: name, name, share: ms / s.stampedMs, kind: kinds.get(name) ?? 'individual' }))
      : []
  return {
    key: s.key,
    label: s.label,
    channel: s.channel,
    language,
    speechMs: s.speechMs,
    cleanMs: voice.cleanMs,
    vector: voice.vector,
    tiles,
    coverage: s.channel === 'system' && s.speechMs > 0 ? s.stampedMs / s.speechMs : 0
  }
}

/**
 * A cluster's language (for its calibration condition): the session's language when it is a fixed one, else
 * the language most of the note's words were detected in, else `other`.
 */
export function noteLanguage(sessionLanguage: string | null, chunks: readonly TranscriptChunk[]): SpeakerCalibrationLanguage {
  const of = (tag: string): SpeakerCalibrationLanguage | null => {
    const t = tag.trim().toLowerCase()
    if (t.startsWith('pt')) return 'pt'
    if (t.startsWith('en')) return 'en'
    return t && t !== 'multi' && t !== 'auto' ? 'other' : null
  }
  const fixed = sessionLanguage ? of(sessionLanguage) : null
  if (fixed) return fixed
  const counts = new Map<SpeakerCalibrationLanguage, number>()
  for (const c of chunks) {
    for (const w of c.providerDetails?.words ?? []) {
      const l = w.lang ? of(w.lang) : null
      if (l) counts.set(l, (counts.get(l) ?? 0) + 1)
    }
  }
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'other'
}

/** The linked event's attendees minus the user and calendar resources. */
export function attendeesOf(note: Pick<Note, 'linked_event'>, profileEmail: string, myEmails: readonly string[]): { name: string; email: string }[] {
  const mine = new Set([profileEmail.trim().toLowerCase(), ...myEmails.map((e) => e.toLowerCase())].filter(Boolean))
  const seen = new Set<string>()
  const out: { name: string; email: string }[] = []
  for (const a of note.linked_event?.attendees ?? []) {
    if (!a || typeof a.email !== 'string' || a.self || a.resource) continue
    const email = a.email.trim().toLowerCase()
    if (!email || mine.has(email) || seen.has(email)) continue
    seen.add(email)
    out.push({ name: a.displayName?.trim() ?? '', email })
  }
  return out
}

export interface NoteCandidates {
  candidates: DecideCandidate[]
  /** The LLM step's `CANDIDATES:` (attendees, unmapped meeting-app names, at most 10 known people without emails). */
  llm: JobLlmCandidate[]
  /** `c<n>` → `DecideCandidate.id`. */
  llmIds: Map<string, string>
  self: SpeakerPersonRow
  attendeeCount: number
  hasLinkedEvent: boolean
  userName: string
}

/**
 * The note's candidates. `tiles` are the individual tiles stamped on the pass: each maps
 * to an attendee or known person by a unique case- and accent-insensitive name match, or stays
 * a plain name with no person. `withVoice` loads the agreement state each voice row needs.
 */
export async function noteCandidates(
  ctx: MainContext,
  note: Note,
  tiles: readonly string[],
  opts: { withVoice: boolean }
): Promise<NoteCandidates> {
  const settings = await ctx.settings.getAll()
  const userName = settings['profile.name'].trim()
  const myEmails = await ctx.calendar.myEmails().catch(() => [] as string[])
  const attendees = attendeesOf(note, settings['profile.email'], myEmails)
  const self = await ctx.storage.ensureSelfPerson(userName || null)
  const known = (
    await ctx.storage
      .knownSpeakerPeople({
        noteId: note.id,
        since: new Date(Date.now() - SPEAKER_PROFILE_LIMITS.knownPeopleDays * DAY_MS).toISOString(),
        recurringEventId: recurringEventId(note.linked_event),
        limit: SPEAKER_PROFILE_LIMITS.knownPeopleMax
      })
      .catch(() => [])
  ).filter((p) => !p.isSelf && p.personId !== self.id)

  const people = new Map<string, SpeakerPersonRow>()
  const attendeePeople = await Promise.all(
    attendees.map(async (a) => {
      const row = await ctx.storage.findSpeakerPersonByEmail(a.email).catch(() => null)
      const live = row?.mergedInto ? await ctx.storage.getSpeakerPerson(row.id, { resolveMerged: true }).catch(() => null) : row
      if (live) people.set(live.id, live)
      return live
    })
  )
  const knownIds = known.map((k) => k.personId).filter((id) => !people.has(id))
  if (knownIds.length) {
    for (const row of await ctx.storage.listSpeakerPeople({ ids: knownIds, limit: knownIds.length }).catch(() => [])) people.set(row.id, row)
  }

  const out: DecideCandidate[] = []
  const byId = new Map<string, DecideCandidate>()
  const add = (c: DecideCandidate): DecideCandidate => {
    const had = byId.get(c.id)
    if (had) {
      had.attendee ||= c.attendee
      had.known ||= c.known
      return had
    }
    byId.set(c.id, c)
    out.push(c)
    return c
  }
  const personCandidate = (row: SpeakerPersonRow, name: string, attendee: boolean, isKnown: boolean): DecideCandidate =>
    add({
      id: row.id,
      personId: row.id,
      name: row.displayName.trim() || name,
      isSelf: row.isSelf,
      attendee,
      known: isKnown,
      tileIds: [],
      stampedOnSystem: false,
      hasAgreement: row.isSelf,
      autoRecognize: row.autoRecognize
    })

  add({
    id: self.id,
    personId: self.id,
    name: self.displayName,
    isSelf: true,
    attendee: false,
    known: false,
    tileIds: [],
    stampedOnSystem: false,
    hasAgreement: true,
    autoRecognize: self.autoRecognize
  })
  const attendeeCandidates: { candidate: DecideCandidate; email: string; name: string }[] = []
  attendees.forEach((a, i) => {
    const row = attendeePeople[i]
    const name = row?.displayName.trim() || a.name
    // Nothing could be written on the words without a name.
    if (!name) return
    const candidate = row
      ? personCandidate(row, a.name, true, false)
      : add({
          id: `email:${a.email}`,
          personId: null,
          name,
          isSelf: false,
          attendee: true,
          known: false,
          tileIds: [],
          stampedOnSystem: false,
          hasAgreement: false,
          autoRecognize: false
        })
    attendeeCandidates.push({ candidate, email: a.email, name: a.name || name })
  })
  for (const k of known) {
    const row = people.get(k.personId)
    if (row && k.name.trim()) personCandidate(row, k.name, false, true)
  }

  // Meeting-app tiles: a unique name match with an attendee or a known person gives that person.
  const appOnly: string[] = []
  for (const tile of tiles) {
    const folded = foldName(tile)
    const matches = out.filter(
      (c) => !c.isSelf && (c.attendee || c.known) && (foldName(c.name) === folded || attendeeCandidates.some((a) => a.candidate === c && foldName(a.name) === folded))
    )
    const target =
      matches.length === 1
        ? (matches[0] as DecideCandidate)
        : add({
            id: `app:${tile}`,
            personId: null,
            name: tile,
            isSelf: false,
            attendee: false,
            known: false,
            tileIds: [],
            stampedOnSystem: false,
            hasAgreement: false,
            autoRecognize: false
          })
    if (matches.length !== 1) appOnly.push(tile)
    if (!target.tileIds.includes(tile)) target.tileIds.push(tile)
    target.stampedOnSystem = true
  }

  if (opts.withVoice) {
    await Promise.all(
      out
        .filter((c) => c.personId && !c.isSelf)
        .map(async (c) => {
          const a = await ctx.storage.getSpeakerAgreement(c.personId as string).catch(() => null)
          c.hasAgreement = !!a && a.revokedAt === null
        })
    )
  }

  // The LLM step's list: ids are ours, so a reply maps back without guessing.
  const llm: JobLlmCandidate[] = []
  const llmIds = new Map<string, string>()
  const offer = (c: Omit<JobLlmCandidate, 'id'>, decideId: string): void => {
    const id = `c${llm.length + 1}`
    llm.push({ id, ...c })
    llmIds.set(id, decideId)
  }
  for (const a of attendeeCandidates) {
    offer({ name: a.name, email: a.email, kind: 'attendee', ...(a.candidate.personId ? { personId: a.candidate.personId } : {}) }, a.candidate.id)
  }
  for (const tile of appOnly) offer({ name: tile, kind: 'app' }, `app:${tile}`)
  let toLlm = 0
  for (const k of known) {
    // Only those of the same series or already named here reach the provider, without emails.
    if (!(k.sameSeries || k.inNote) || !byId.has(k.personId) || toLlm >= SPEAKER_PROFILE_LIMITS.knownPeopleToLlm) continue
    toLlm++
    offer({ name: (byId.get(k.personId) as DecideCandidate).name, personId: k.personId, kind: 'known' }, k.personId)
  }

  return {
    candidates: out,
    llm,
    llmIds,
    self,
    attendeeCount: attendees.length,
    hasLinkedEvent: !!note.linked_event,
    userName
  }
}
