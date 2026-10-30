// SPDX-License-Identifier: Apache-2.0
// Speaker profiles, the people: persisted
// people, merging, deleting, the self row, the job's known people, the person page's view and the
// match rows. Worker-safe: no Electron imports. No vector is read here except to count samples.

import { randomUUID } from 'node:crypto'
import type { IsoTime } from '@shared/types/common'
import {
  SPEAKER_PROFILE_LIMITS,
  type SpeakerAgreementInfo,
  type SpeakerMatchKind,
  type SpeakerMatchRow,
  type SpeakerMergePreview,
  type SpeakerPendingMeeting,
  type SpeakerPersonView,
  type SpeakerPersonVoiceState
} from '@shared/types/speakers'
import type { KnownSpeakerPerson, SpeakerPersonRow } from './api'
import { getSpeakerAgreement, settleActiveAgreements, withdrawalAfterActive } from './speaker-agreements-repo'
import { capAndRecomputeAll, checkpointVoice, forgetPersonRows, livePerson, secureWrite } from './speaker-voice-repo'
import { nowIso, parseJson } from './rows'
import { inTransaction, invalid, notFound, StoreError, type StoreCtx } from './store'

type Row = Record<string, unknown>

const L = SPEAKER_PROFILE_LIMITS
const DAY_MS = 86_400_000
const MAX_NAME = 200
const MAX_EMAIL = 320
const KINDS: readonly SpeakerMatchKind[] = ['auto_app', 'auto_voice', 'confirmed']
/** The name of the self row while `profile.name` is empty. */
const SELF_FALLBACK = 'Me'

const PERSON_SELECT = `SELECT p.*, EXISTS (SELECT 1 FROM speaker_exemplars e WHERE e.person_id = p.id) AS has_voice FROM speaker_people p`

function toPerson(r: Row): SpeakerPersonRow {
  return {
    id: String(r['id']),
    displayName: String(r['display_name'] ?? ''),
    email: typeof r['email'] === 'string' && r['email'] ? r['email'] : null,
    isSelf: r['is_self'] === 1,
    autoRecognize: r['auto_recognize'] !== 0,
    mergedInto: typeof r['merged_into'] === 'string' && r['merged_into'] ? r['merged_into'] : null,
    lastMatchedAt: typeof r['last_matched_at'] === 'string' ? r['last_matched_at'] : null,
    skippedSamples: Number(r['skipped_samples'] ?? 0),
    createdAt: String(r['created_at']),
    updatedAt: String(r['updated_at']),
    hasVoice: r['has_voice'] === 1
  }
}

function personId(v: unknown): string {
  if (typeof v !== 'string' || !v || v.length > 200) throw invalid('personId is required')
  return v
}

function displayNameOf(v: unknown): string {
  if (typeof v !== 'string') throw invalid('a name is required')
  const name = v.replace(/\s+/g, ' ').trim()
  if (!name || name.length > MAX_NAME) throw invalid('a name is required')
  return name
}

/** Lower-cased and trimmed; null for none. Refuses anything that isn't an address. */
function emailOf(v: unknown): string | null {
  if (v === undefined || v === null || v === '') return null
  if (typeof v !== 'string') throw invalid('email is invalid')
  const e = v.trim().toLowerCase()
  if (!e) return null
  if (e.length > MAX_EMAIL || !/^[^\s@]+@[^\s@]+$/.test(e)) throw invalid('email is invalid')
  return e
}

function readPerson(s: StoreCtx, id: string): SpeakerPersonRow | null {
  const r = s.db.prepare(`${PERSON_SELECT} WHERE p.id = ? AND p.owner_id = ?`).get(id, s.identity.ownerId) as Row | undefined
  return r ? toPerson(r) : null
}

function requirePerson(s: StoreCtx, id: string): SpeakerPersonRow {
  const p = readPerson(s, id)
  if (!p) throw notFound('person', id)
  return p
}

/** The unmerged person holding this email, if any. */
function holderOf(s: StoreCtx, email: string): SpeakerPersonRow | null {
  const r = s.db
    .prepare(`${PERSON_SELECT} WHERE p.owner_id = ? AND p.email = ? ORDER BY p.merged_into IS NOT NULL LIMIT 1`)
    .get(s.identity.ownerId, email) as Row | undefined
  return r ? toPerson(r) : null
}

// ---------- people ----------

/** Idempotent: one `is_self` row per owner, named after `profile.name` ("Me" while empty). */
export function ensureSelfPerson(s: StoreCtx, displayName: string | null): SpeakerPersonRow {
  const name = (typeof displayName === 'string' ? displayName.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME) : '') || SELF_FALLBACK
  const existing = s.db.prepare(`SELECT id, display_name FROM speaker_people WHERE owner_id = ? AND is_self = 1`).get(s.identity.ownerId) as Row | undefined
  if (existing) {
    const id = String(existing['id'])
    if (existing['display_name'] !== name) {
      inTransaction(s.db, () => s.db.prepare(`UPDATE speaker_people SET display_name = ?, updated_at = ? WHERE id = ?`).run(name, nowIso(), id))
      s.touch('speaker_people', id)
    }
    return requirePerson(s, id)
  }
  const id = randomUUID()
  const now = nowIso()
  inTransaction(s.db, () =>
    s.db
      .prepare(
        `INSERT INTO speaker_people (id, workspace_id, owner_id, display_name, email, is_self, created_at, updated_at)
         VALUES (?, ?, ?, ?, NULL, 1, ?, ?)`
      )
      .run(id, s.identity.workspaceId, s.identity.ownerId, name, now, now)
  )
  s.touch('speaker_people', id)
  s.log('info', 'speakers:self-person-created')
  return requirePerson(s, id)
}

export function getSpeakerPerson(s: StoreCtx, id: string, opts?: { resolveMerged?: boolean }): SpeakerPersonRow | null {
  const pid = personId(id)
  if (opts?.resolveMerged) {
    const live = livePerson(s, pid)
    return live ? readPerson(s, live.id) : null
  }
  return readPerson(s, pid)
}

/** Follows a merge to the surviving person. */
export function findSpeakerPersonByEmail(s: StoreCtx, email: string): SpeakerPersonRow | null {
  const e = emailOf(email)
  if (!e) return null
  const holder = holderOf(s, e)
  if (!holder) return null
  return holder.mergedInto ? getSpeakerPerson(s, holder.id, { resolveMerged: true }) : holder
}

/** Unmerged people; by name or email with `query`; most recently matched first. */
export function listSpeakerPeople(s: StoreCtx, q: { query?: string; ids?: string[]; limit: number }): SpeakerPersonRow[] {
  const limit = Math.max(1, Math.min(500, Math.floor(Number(q?.limit) || 50)))
  const query = typeof q?.query === 'string' ? q.query.trim().toLowerCase().slice(0, 200) : ''
  const ids = Array.isArray(q?.ids) ? q.ids.filter((i): i is string => typeof i === 'string') : null
  const rows = s.db
    .prepare(
      `${PERSON_SELECT}
       WHERE p.owner_id = @owner AND p.merged_into IS NULL
         AND (@q = '' OR instr(lower(p.display_name), @q) > 0 OR instr(coalesce(p.email, ''), @q) > 0)
         AND (@all = 1 OR p.id IN (SELECT value FROM json_each(@ids)))
       ORDER BY p.last_matched_at IS NULL, p.last_matched_at DESC, p.updated_at DESC, p.rid DESC
       LIMIT @limit`
    )
    .all({ owner: s.identity.ownerId, q: query, all: ids ? 0 : 1, ids: JSON.stringify(ids ?? []), limit }) as Row[]
  return rows.map(toPerson)
}

/** `invalid-input` when the email is taken (UNIQUE per owner). */
export function createSpeakerPerson(s: StoreCtx, p: { displayName: string; email: string | null }): SpeakerPersonRow {
  const name = displayNameOf(p?.displayName)
  const email = emailOf(p.email)
  if (email && holderOf(s, email)) throw invalid('another person already has this email')
  const id = randomUUID()
  const now = nowIso()
  inTransaction(s.db, () =>
    s.db
      .prepare(
        `INSERT INTO speaker_people (id, workspace_id, owner_id, display_name, email, is_self, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?)`
      )
      .run(id, s.identity.workspaceId, s.identity.ownerId, name, email, now, now)
  )
  s.touch('speaker_people', id)
  return requirePerson(s, id)
}

export function updateSpeakerPerson(
  s: StoreCtx,
  id: string,
  patch: { displayName?: string; autoRecognize?: boolean; lastMatchedAt?: IsoTime }
): SpeakerPersonRow {
  const pid = personId(id)
  requirePerson(s, pid)
  const sets: string[] = []
  const params: Record<string, unknown> = { id: pid, now: nowIso() }
  if (patch?.displayName !== undefined) {
    sets.push('display_name = @name')
    params['name'] = displayNameOf(patch.displayName)
  }
  if (patch?.autoRecognize !== undefined) {
    if (typeof patch.autoRecognize !== 'boolean') throw invalid('autoRecognize must be a boolean')
    sets.push('auto_recognize = @auto')
    params['auto'] = patch.autoRecognize ? 1 : 0
  }
  if (patch?.lastMatchedAt !== undefined) {
    const t = Date.parse(String(patch.lastMatchedAt))
    if (!Number.isFinite(t)) throw invalid('lastMatchedAt must be an ISO time')
    // Only ever forward: an older match never shortens the 12 months.
    sets.push(`last_matched_at = CASE WHEN last_matched_at IS NULL OR last_matched_at < @matched THEN @matched ELSE last_matched_at END`)
    params['matched'] = new Date(t).toISOString()
  }
  if (sets.length) {
    inTransaction(s.db, () => s.db.prepare(`UPDATE speaker_people SET ${sets.join(', ')}, updated_at = @now WHERE id = @id`).run(params))
    s.touch('speaker_people', pid)
  }
  return requirePerson(s, pid)
}

export function linkSpeakerPersonEmail(s: StoreCtx, id: string, email: string): { ok: true } | { taken: { personId: string; name: string } } {
  const pid = personId(id)
  const person = requirePerson(s, pid)
  if (person.mergedInto) throw invalid('this person was merged into another')
  const e = emailOf(email)
  if (!e) throw invalid('email is invalid')
  const holder = holderOf(s, e)
  if (holder && holder.id !== pid) {
    const live = holder.mergedInto ? (getSpeakerPerson(s, holder.id, { resolveMerged: true }) ?? holder) : holder
    if (live.id !== pid) return { taken: { personId: live.id, name: live.displayName } }
  }
  inTransaction(s.db, () => {
    // A merged row that still holds the address gives it up to the person it lives on in.
    if (holder && holder.id !== pid) s.db.prepare(`UPDATE speaker_people SET email = NULL WHERE id = ?`).run(holder.id)
    s.db.prepare(`UPDATE speaker_people SET email = ?, updated_at = ? WHERE id = ?`).run(e, nowIso(), pid)
  })
  s.touch('speaker_people', pid)
  return { ok: true }
}

// ---------- merge ----------

function mergePair(s: StoreCtx, q: { fromId: string; intoId: string }): { from: SpeakerPersonRow; into: SpeakerPersonRow } {
  const fromId = personId(q?.fromId)
  const intoId = personId(q.intoId)
  if (fromId === intoId) throw invalid('a person cannot be merged into itself')
  const from = requirePerson(s, fromId)
  const into = requirePerson(s, intoId)
  if (from.mergedInto || into.mergedInto) throw invalid('this person was already merged')
  if (from.isSelf) throw invalid('the user cannot be merged into someone else')
  // The user's voice is mic-only and needs no agreement: someone else's samples,
  // record or request never move into it.
  if (into.isSelf && hasVoiceRows(s, from.id)) throw invalid("Forget this person's voice and remove the agreement record first.")
  return { from, into }
}

/** Exemplars, any agreement record (active or revoked) or a pending request. */
function hasVoiceRows(s: StoreCtx, pid: string): boolean {
  const r = s.db
    .prepare(
      `SELECT EXISTS (SELECT 1 FROM speaker_exemplars WHERE person_id = @p)
           OR EXISTS (SELECT 1 FROM speaker_agreements WHERE person_id = @p)
           OR EXISTS (SELECT 1 FROM speaker_pending WHERE person_id = @p) AS b`
    )
    .get({ p: pid }) as { b: number }
  return r.b === 1
}

function samplesRemoved(s: StoreCtx, fromId: string, intoId: string): number {
  const rows = s.db
    .prepare(
      `SELECT model_id, channel, count(*) AS n FROM speaker_exemplars WHERE person_id IN (?, ?)
       GROUP BY model_id, channel`
    )
    .all(fromId, intoId) as { n: number }[]
  return rows.reduce((sum, r) => sum + Math.max(0, r.n - L.exemplarCap), 0)
}

function meetingsMoved(s: StoreCtx, fromId: string): number {
  return (s.db.prepare(`SELECT count(DISTINCT note_id) AS n FROM speaker_matches WHERE person_id = ?`).get(fromId) as { n: number }).n
}

export function previewSpeakerMerge(s: StoreCtx, q: { fromId: string; intoId: string }): SpeakerMergePreview {
  const { from, into } = mergePair(s, q)
  const withdrawnAt = withdrawalAfterActive(s, [from.id, into.id])
  return {
    samplesRemoved: withdrawnAt ? 0 : samplesRemoved(s, from.id, into.id),
    agreementsMoved: (s.db.prepare(`SELECT count(*) AS n FROM speaker_agreements WHERE person_id = ?`).get(from.id) as { n: number }).n,
    meetingsMoved: meetingsMoved(s, from.id),
    ...(withdrawnAt ? { withdrawnAt } : {})
  }
}

/**
 * Moves exemplars, voice spaces, negatives, matches, pending requests and agreements to `intoId`,
 * then re-applies the cap and recomputes every centroid. A withdrawal made after the surviving
 * active record governs: the voice is forgotten and that record stamped `withdrawn`. The merged row keeps `merged_into`; an
 * email it held moves to the survivor when that one has none. No undo (the cap makes it lossy).
 */
export function mergeSpeakerPeople(s: StoreCtx, q: { fromId: string; intoId: string }): SpeakerMergePreview {
  const { from, into } = mergePair(s, q)
  const preview = previewSpeakerMerge(s, q)
  const now = nowIso()
  let removed = 0
  const guesses = new Set<string>()
  secureWrite(s, () => {
    s.db.prepare(`UPDATE speaker_exemplars SET person_id = @into WHERE person_id = @from`).run({ from: from.id, into: into.id })
    // Spaces are derived: the survivor's are recomputed from the moved exemplars below.
    s.db.prepare(`DELETE FROM speaker_voice_spaces WHERE person_id = ?`).run(from.id)
    // A pairing or a match the survivor already has keeps the survivor's row.
    s.db.prepare(`UPDATE OR IGNORE speaker_negatives SET person_id = @into WHERE person_id = @from`).run({ from: from.id, into: into.id })
    s.db.prepare(`DELETE FROM speaker_negatives WHERE person_id = ?`).run(from.id)
    s.db
      .prepare(
        `UPDATE speaker_matches SET at = max(at, (SELECT m.at FROM speaker_matches m WHERE m.person_id = @from
           AND m.note_id = speaker_matches.note_id AND m.kind = speaker_matches.kind))
         WHERE person_id = @into AND EXISTS (SELECT 1 FROM speaker_matches m WHERE m.person_id = @from
           AND m.note_id = speaker_matches.note_id AND m.kind = speaker_matches.kind)`
      )
      .run({ from: from.id, into: into.id })
    s.db.prepare(`UPDATE OR IGNORE speaker_matches SET person_id = @into WHERE person_id = @from`).run({ from: from.id, into: into.id })
    s.db.prepare(`DELETE FROM speaker_matches WHERE person_id = ?`).run(from.id)
    s.db.prepare(`UPDATE speaker_pending SET person_id = @into WHERE person_id = @from`).run({ from: from.id, into: into.id })
    s.db.prepare(`UPDATE speaker_agreements SET person_id = @into WHERE person_id = @from`).run({ from: from.id, into: into.id })
    settleActiveAgreements(s, into.id, now)
    if (preview.withdrawnAt) forgetPersonRows(s, into.id, 'withdrawn', now, guesses)
    removed = capAndRecomputeAll(s, into.id)
    const moveEmail = !into.email && !!from.email
    s.db
      .prepare(
        `UPDATE speaker_people SET merged_into = @into, updated_at = @now ${moveEmail ? ', email = NULL' : ''} WHERE id = @from`
      )
      .run({ from: from.id, into: into.id, now })
    s.db
      .prepare(
        `UPDATE speaker_people SET updated_at = @now, skipped_samples = skipped_samples + @skipped,
           last_matched_at = CASE WHEN @matched IS NOT NULL AND (last_matched_at IS NULL OR last_matched_at < @matched) THEN @matched ELSE last_matched_at END
           ${moveEmail ? ', email = @email' : ''}
         WHERE id = @into`
      )
      .run({ into: into.id, now, skipped: from.skippedSamples, matched: preview.withdrawnAt ? null : from.lastMatchedAt, ...(moveEmail ? { email: from.email } : {}) })
  })
  checkpointVoice(s)
  for (const t of ['speaker_people', 'speaker_exemplars', 'speaker_voice_spaces', 'speaker_negatives', 'speaker_matches', 'speaker_pending', 'speaker_agreements']) {
    s.touch(t, from.id, into.id)
  }
  if (guesses.size) s.touch('speaker_guesses', ...guesses)
  s.log('info', 'speakers:people-merged', {
    samplesRemoved: removed,
    agreementsMoved: preview.agreementsMoved,
    meetingsMoved: preview.meetingsMoved,
    withdrawn: !!preview.withdrawnAt
  })
  return { ...preview, samplesRemoved: removed }
}

/**
 * Delete person: only with no voice, no agreement record and no pending request. Its
 * negatives and match rows go with it (cascade); names on words stay as text.
 */
export function deleteSpeakerPerson(s: StoreCtx, id: string): void {
  const p = requirePerson(s, personId(id))
  if (p.isSelf) throw invalid('the user cannot be deleted')
  // Ids on words resolve through a merged row: it goes only with its survivor, which takes
  // the rows merged into it along, so none comes back as a person of its own.
  if (p.mergedInto) throw invalid('this person was merged into another')
  if (hasVoiceRows(s, p.id)) throw new StoreError('invalid-input', 'Forget the voice and remove the agreement record first.')
  inTransaction(s.db, () =>
    s.db
      .prepare(
        `WITH RECURSIVE chain (id) AS (SELECT @p UNION SELECT q.id FROM speaker_people q JOIN chain c ON q.merged_into = c.id)
         DELETE FROM speaker_people WHERE owner_id = @owner AND id IN (SELECT id FROM chain)`
      )
      .run({ p: p.id, owner: s.identity.ownerId })
  )
  s.touch('speaker_people', p.id)
  s.touch('speaker_negatives', p.id)
  s.touch('speaker_matches', p.id)
}

// ---------- the job's candidates ----------

/**
 * Matched since `since`, plus the people of the series and those named or ruled out (Not <name>)
 * in the note, so a meeting-app name maps back to the person a negative holds; at most `limit`.
 */
export function knownSpeakerPeople(
  s: StoreCtx,
  q: { noteId: string; since: IsoTime; recurringEventId: string | null; limit: number }
): KnownSpeakerPerson[] {
  if (typeof q?.noteId !== 'string' || !q.noteId) throw invalid('noteId is required')
  const since = Date.parse(String(q.since))
  if (!Number.isFinite(since)) throw invalid('since must be an ISO time')
  const limit = Math.max(1, Math.min(L.knownPeopleMax, Math.floor(Number(q.limit) || L.knownPeopleMax)))
  const rec = typeof q.recurringEventId === 'string' && q.recurringEventId ? q.recurringEventId : null
  const rows = s.db
    .prepare(
      `SELECT p.id, p.display_name, p.email, p.is_self,
         (SELECT max(m.at) FROM speaker_matches m WHERE m.person_id = p.id) AS last_at,
         (@rec IS NOT NULL AND EXISTS (SELECT 1 FROM speaker_matches m JOIN documents d ON d.id = m.note_id
            WHERE m.person_id = p.id AND d.deleted_at IS NULL AND json_valid(d.linked_event)
              AND json_extract(d.linked_event, '$.recurringEventId') = @rec)) AS same_series,
         (EXISTS (SELECT 1 FROM speaker_matches m WHERE m.person_id = p.id AND m.note_id = @note)
           OR EXISTS (SELECT 1 FROM speaker_negatives n WHERE n.person_id = p.id AND n.note_id = @note)) AS in_note
       FROM speaker_people p
       WHERE p.owner_id = @owner AND p.merged_into IS NULL
       ORDER BY last_at IS NULL, last_at DESC, p.rid`
    )
    .all({ owner: s.identity.ownerId, rec, note: q.noteId }) as Row[]
  const sinceIso = new Date(since).toISOString()
  return rows
    .filter((r) => (typeof r['last_at'] === 'string' && r['last_at'] >= sinceIso) || r['same_series'] === 1 || r['in_note'] === 1)
    .slice(0, limit)
    .map((r) => ({
      personId: String(r['id']),
      name: String(r['display_name']),
      email: typeof r['email'] === 'string' && r['email'] ? r['email'] : null,
      isSelf: r['is_self'] === 1,
      lastAt: typeof r['last_at'] === 'string' ? r['last_at'] : null,
      sameSeries: r['same_series'] === 1,
      inNote: r['in_note'] === 1
    }))
}

// ---------- the person page ----------

/** Case- and accent-insensitive. */
export function nameKey(name: string): string {
  return name.normalize('NFD').replace(/\p{Diacritic}/gu, '').replace(/\s+/g, ' ').trim().toLowerCase()
}

function agreementInfo(s: StoreCtx, pid: string): SpeakerAgreementInfo | null {
  const a = getSpeakerAgreement(s, pid)
  if (!a) return null
  const info: SpeakerAgreementInfo = {
    method: a.method,
    attestedAt: a.attestedAt,
    noticeVersion: a.noticeVersion,
    language: a.noticeLanguage,
    hasEvidence: !!a.evidenceText
  }
  if (a.revokedAt) info.revokedAt = a.revokedAt
  if (a.revokedVia) info.revokedVia = a.revokedVia
  return info
}

/**
 * "Link to <email>" for an email-less person confirmed in a note whose single attendee of the same
 * display name carries an address; "Merge with" when someone else already holds it.
 */
function mergeOffer(s: StoreCtx, p: SpeakerPersonRow): SpeakerPersonView['mergeOffer'] {
  if (p.email || p.isSelf) return undefined
  const key = nameKey(p.displayName)
  const notes = s.db
    .prepare(
      `SELECT d.linked_event FROM speaker_matches m JOIN documents d ON d.id = m.note_id
       WHERE m.person_id = ? AND m.kind = 'confirmed' AND d.deleted_at IS NULL ORDER BY m.at DESC LIMIT 20`
    )
    .all(p.id) as Row[]
  for (const n of notes) {
    const ev = parseJson<{ attendees?: { email?: unknown; displayName?: unknown; self?: unknown; resource?: unknown }[] } | null>(n['linked_event'], null)
    const hits = (Array.isArray(ev?.attendees) ? ev.attendees : []).filter(
      (a) => a && !a.self && !a.resource && typeof a.email === 'string' && typeof a.displayName === 'string' && nameKey(a.displayName) === key
    )
    if (hits.length !== 1) continue
    const email = String(hits[0]!.email).trim().toLowerCase()
    const holder = holderOf(s, email)
    const live = holder?.mergedInto ? getSpeakerPerson(s, holder.id, { resolveMerged: true }) : holder
    return live && live.id !== p.id ? { email, intoPersonId: live.id } : { email }
  }
  return undefined
}

/** `speaker-people:get`. `modelId` is the installed extractor's id (null when missing). */
export function speakerPersonView(s: StoreCtx, q: { personId: string; modelId: string | null }): SpeakerPersonView | null {
  const p = getSpeakerPerson(s, personId(q?.personId), { resolveMerged: true })
  if (!p) return null
  const modelId = typeof q.modelId === 'string' && q.modelId ? q.modelId : null
  const ex = s.db
    .prepare(
      `SELECT count(*) AS n, min(created_at) AS first, sum(CASE WHEN model_id = @model THEN 1 ELSE 0 END) AS current
       FROM speaker_exemplars WHERE person_id = @p`
    )
    .get({ p: p.id, model: modelId }) as { n: number; first: string | null; current: number | null }
  const agreement = agreementInfo(s, p.id)
  const active = agreement && !agreement.revokedAt
  const pendingRows = s.db
    .prepare(
      `SELECT r.note_id, r.asked_at, d.title,
         EXISTS (SELECT 1 FROM speaker_cluster_vectors v WHERE v.note_id = r.note_id AND v.expires_at > @now
           AND (@model IS NULL OR v.model_id = @model)) AS has_vector
       FROM speaker_pending r JOIN documents d ON d.id = r.note_id
       WHERE r.person_id = @p AND d.deleted_at IS NULL ORDER BY r.asked_at, r.rid`
    )
    .all({ p: p.id, now: nowIso(), model: modelId }) as Row[]
  const seen = new Set<string>()
  const pending: SpeakerPendingMeeting[] = []
  for (const r of pendingRows) {
    const noteId = String(r['note_id'])
    if (seen.has(noteId)) continue
    seen.add(noteId)
    pending.push({ noteId, title: typeof r['title'] === 'string' ? r['title'] : '', askedAt: String(r['asked_at']), canName: !!active && r['has_vector'] === 1 })
  }
  const stale = ex.n > 0 && modelId !== null && !ex.current
  let state: SpeakerPersonVoiceState
  if (ex.n > 0) state = stale ? 'stale' : 'remembered'
  else if (active) state = 'consented'
  else if (pending.length) state = 'pending'
  else if (agreement?.revokedVia === 'expired') state = 'expired'
  else if (agreement?.revokedVia) state = 'forgotten'
  else state = 'none'
  const clock = p.lastMatchedAt ?? (active ? agreement.attestedAt : null) ?? ex.first
  const expiresAt = ex.n > 0 && clock ? new Date(Date.parse(clock) + L.voiceExpiryDays * DAY_MS).toISOString() : null
  // Recognized means named by voice: a naming by hand or from a meeting app doesn't count.
  const recognized = (s.db
    .prepare(
      `SELECT count(DISTINCT m.note_id) AS n FROM speaker_matches m JOIN documents d ON d.id = m.note_id
       WHERE m.person_id = ? AND m.kind = 'auto_voice' AND d.deleted_at IS NULL`
    )
    .get(p.id) as { n: number }).n
  const hasRecord = !!s.db.prepare(`SELECT 1 FROM speaker_agreements WHERE person_id = ? LIMIT 1`).get(p.id)
  const offer = mergeOffer(s, p)
  const view: SpeakerPersonView = {
    person: {
      personId: p.id,
      name: p.displayName,
      ...(p.email ? { email: p.email } : {}),
      isSelf: p.isSelf,
      autoRecognize: p.autoRecognize,
      ...(p.mergedInto ? { mergedInto: p.mergedInto } : {})
    },
    voice: {
      state,
      since: ex.n > 0 ? ex.first : null,
      recognizedCount: recognized,
      expiresAt,
      autoRecognize: p.autoRecognize,
      skippedSamples: p.skippedSamples,
      stale
    },
    agreement,
    pending,
    canDelete: !p.isSelf && ex.n === 0 && !hasRecord && pendingRows.length === 0
  }
  if (offer) view.mergeOffer = offer
  return view
}

/**
 * The counts of `speakers:get-status`: people (not the user) with a voice, and the user's own
 * samples; `movedFromLabs` from the marker migration 12 writes for a Labs user.
 */
export function speakerVoiceSummary(
  s: StoreCtx,
  q: { modelId: string | null }
): { peopleWithVoice: number; peopleWithAgreement: number; self: { present: boolean; sampleCount: number; updatedAt: IsoTime | null }; movedFromLabs: boolean } {
  const modelId = typeof q?.modelId === 'string' && q.modelId ? q.modelId : null
  const people = (s.db
    .prepare(
      `SELECT count(DISTINCT e.person_id) AS n FROM speaker_exemplars e JOIN speaker_people p ON p.id = e.person_id
       WHERE e.owner_id = ? AND p.is_self = 0 AND p.merged_into IS NULL`
    )
    .get(s.identity.ownerId) as { n: number }).n
  const agreed = (s.db
    .prepare(
      `SELECT count(DISTINCT a.person_id) AS n FROM speaker_agreements a JOIN speaker_people p ON p.id = a.person_id
       WHERE a.owner_id = ? AND a.revoked_at IS NULL AND p.merged_into IS NULL`
    )
    .get(s.identity.ownerId) as { n: number }).n
  const self = s.db
    .prepare(
      `SELECT count(*) AS n, max(e.created_at) AS at FROM speaker_exemplars e JOIN speaker_people p ON p.id = e.person_id
       WHERE e.owner_id = @owner AND p.is_self = 1 AND (@model IS NULL OR e.model_id = @model)`
    )
    .get({ owner: s.identity.ownerId, model: modelId }) as { n: number; at: string | null }
  const movedFromLabs = !!s.db.prepare(`SELECT 1 FROM meta WHERE key = 'speakers_moved_from_labs'`).get()
  return { peopleWithVoice: people, peopleWithAgreement: agreed, self: { present: self.n > 0, sampleCount: self.n, updatedAt: self.at }, movedFromLabs }
}

// ---------- matches ----------

/** One row per (note, person, kind), its time refreshed. A merged person's id resolves to the survivor. */
export function recordSpeakerMatches(s: StoreCtx, rows: { noteId: string; personId: string; kind: SpeakerMatchKind }[]): void {
  if (!Array.isArray(rows)) throw invalid('rows must be an array')
  if (rows.length > 500) throw invalid('too many match rows')
  const now = nowIso()
  const notes = new Set<string>()
  inTransaction(s.db, () => {
    const put = s.db.prepare(
      `INSERT INTO speaker_matches (id, workspace_id, owner_id, note_id, person_id, kind, at)
       VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (note_id, person_id, kind) DO UPDATE SET at = excluded.at`
    )
    const noteExists = s.db.prepare(`SELECT 1 FROM documents WHERE id = ? AND owner_id = ?`)
    for (const r of rows) {
      if (!r || !KINDS.includes(r.kind) || typeof r.noteId !== 'string' || !r.noteId) throw invalid('invalid match row')
      const person = livePerson(s, personId(r.personId))
      if (!person || !noteExists.get(r.noteId, s.identity.ownerId)) continue
      put.run(randomUUID(), s.identity.workspaceId, s.identity.ownerId, r.noteId, person.id, r.kind, now)
      notes.add(r.noteId)
    }
  })
  if (notes.size) s.touch('speaker_matches', ...notes)
}

export function listSpeakerMatches(s: StoreCtx, pid: string): SpeakerMatchRow[] {
  const live = livePerson(s, personId(pid))
  if (!live) return []
  const rows = s.db
    .prepare(
      `SELECT m.note_id, m.kind, d.title, d.created_at FROM speaker_matches m JOIN documents d ON d.id = m.note_id
       WHERE m.person_id = ? AND d.deleted_at IS NULL ORDER BY d.created_at DESC, m.kind`
    )
    .all(live.id) as Row[]
  return rows.map((r) => ({
    noteId: String(r['note_id']),
    title: typeof r['title'] === 'string' ? r['title'] : '',
    date: String(r['created_at']),
    kind: KINDS.includes(r['kind'] as SpeakerMatchKind) ? (r['kind'] as SpeakerMatchKind) : 'confirmed'
  }))
}

// ---------- the People list ----------

/** A persisted person as the People list joins it: by email, else as a `p:<id>` row. */
export interface ListedSpeakerPerson {
  personId: string
  name: string
  email: string | null
  isSelf: boolean
  hasVoice: boolean
  notes: number
  lastAt: IsoTime
}

export function speakerPeopleForList(s: StoreCtx): ListedSpeakerPerson[] {
  const rows = s.db
    .prepare(
      `SELECT p.id, p.display_name, p.email, p.is_self, p.updated_at, p.last_matched_at,
         EXISTS (SELECT 1 FROM speaker_exemplars e WHERE e.person_id = p.id) AS has_voice,
         (SELECT count(DISTINCT m.note_id) FROM speaker_matches m JOIN documents d ON d.id = m.note_id
            WHERE m.person_id = p.id AND d.deleted_at IS NULL) AS notes,
         (SELECT max(d.created_at) FROM speaker_matches m JOIN documents d ON d.id = m.note_id
            WHERE m.person_id = p.id AND d.deleted_at IS NULL) AS last_note
       FROM speaker_people p WHERE p.owner_id = ? AND p.merged_into IS NULL`
    )
    .all(s.identity.ownerId) as Row[]
  return rows.map((r) => ({
    personId: String(r['id']),
    name: String(r['display_name']),
    email: typeof r['email'] === 'string' && r['email'] ? r['email'] : null,
    isSelf: r['is_self'] === 1,
    hasVoice: r['has_voice'] === 1,
    notes: Number(r['notes'] ?? 0),
    lastAt: String(r['last_note'] ?? r['last_matched_at'] ?? r['updated_at'])
  }))
}
