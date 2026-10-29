// SPDX-License-Identifier: Apache-2.0
// Speaker profiles, the voice data: exemplars and
// their voice spaces, the 14-day cluster store, negatives, pending requests, Forget and the sweeps.
// Worker-safe: no Electron imports.
//
// Biometric data. Vectors are Float32 BLOBs, L2-normalized, and never logged (counts and codes
// only). Every write that deletes or rewrites a vector runs with `secure_delete` on, and is
// followed by a TRUNCATE checkpoint, so no old page image outlives it in the file or the WAL.
//
// - A centroid is the L2-normalized weighted mean of its space's current exemplars, recomputed in
//   full on every change. Vectors of different model ids are never compared or blended:
//   every query is per model.
// - The cap (16 per person × channel × model): a new exemplar replaces the existing one closest to
//   the centroid; after a merge the closest one is removed until the space fits.
// - The agreement guard lives here: no exemplar for a non-self person without an active agreement.

import { randomUUID } from 'node:crypto'
import type { AudioSource, IsoTime } from '@shared/types/common'
import { SPEAKER_PROFILE_LIMITS, type SpeakerChannel, type SpeakerSampleRow, type SpeakerSampleVia } from '@shared/types/speakers'
import type {
  AddSpeakerExemplarResult,
  NewSpeakerClusterVector,
  NewSpeakerExemplar,
  NewSpeakerPending,
  SpeakerClusterVectorRow,
  SpeakerNegativeRow,
  SpeakerPendingRow,
  SpeakerVoiceDeleted,
  SpeakerVoiceSpaceRow
} from './api'
import { stampActiveAgreements } from './speaker-agreements-repo'
import { clearDroppedPendingFlags } from './speaker-names-repo'
import { nowIso } from './rows'
import { inTransaction, invalid, notFound, type StoreCtx } from './store'

type Row = Record<string, unknown>

const L = SPEAKER_PROFILE_LIMITS
const DAY_MS = 86_400_000
const CHANNELS: readonly SpeakerChannel[] = ['mic', 'system']
const SOURCES: readonly AudioSource[] = ['microphone', 'system']
const VIAS: readonly SpeakerSampleVia[] = ['agreement', 'confirm', 'rename', 'sheet', 'sample', 'passive', 'legacy']
const MAX_ID = 200
const MAX_LABEL = 40

// ---------- vectors ----------

/** A Float32 vector from a caller: finite, at most 1,024 dims, L2-normalized on the way in. */
export function checkVector(v: unknown): Float32Array {
  let arr: Float32Array
  if (v instanceof Float32Array) arr = new Float32Array(v)
  else if (Array.isArray(v)) arr = Float32Array.from(v as number[])
  else if (ArrayBuffer.isView(v) && v.byteLength % 4 === 0) arr = new Float32Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength))
  else throw invalid('vector must be a Float32Array')
  if (arr.length === 0 || arr.length > L.exemplarMaxDims) throw invalid('vector has the wrong dimension')
  let sum = 0
  for (const x of arr) {
    if (!Number.isFinite(x)) throw invalid('vector holds a non-finite number')
    sum += x * x
  }
  const norm = Math.sqrt(sum)
  if (!(norm > 0) || !Number.isFinite(norm)) throw invalid('vector is zero')
  for (let i = 0; i < arr.length; i++) arr[i] = arr[i]! / norm
  return arr
}

export function vectorBlob(v: Float32Array): Buffer {
  return Buffer.from(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength))
}

export function blobVector(b: unknown): Float32Array {
  if (!(b instanceof Uint8Array) || b.byteLength % 4 !== 0) return new Float32Array(0)
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength))
}

function dot(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length)
  let s = 0
  for (let i = 0; i < n; i++) s += a[i]! * b[i]!
  return s
}

/** The L2-normalized weighted mean. Null for an empty set. */
export function weightedCentroid(items: { vector: Float32Array; weight: number }[]): Float32Array | null {
  if (!items.length) return null
  const dims = items[0]!.vector.length
  const sum = new Float64Array(dims)
  let total = 0
  for (const it of items) {
    if (it.vector.length !== dims) continue
    total += it.weight
    for (let i = 0; i < dims; i++) sum[i]! += it.weight * it.vector[i]!
  }
  if (!(total > 0)) return null
  let norm = 0
  for (let i = 0; i < dims; i++) norm += (sum[i]! / total) ** 2
  norm = Math.sqrt(norm)
  if (!(norm > 0)) return null
  const out = new Float32Array(dims)
  for (let i = 0; i < dims; i++) out[i] = sum[i]! / total / norm
  return out
}

/** The vector length (in floats) already stored for this model, or null when none is. */
function modelDims(s: StoreCtx, modelId: string): number | null {
  const r = (s.db
    .prepare(`SELECT length(vector) AS n FROM speaker_exemplars WHERE owner_id = ? AND model_id = ? LIMIT 1`)
    .get(s.identity.ownerId, modelId) ??
    s.db
      .prepare(`SELECT length(vector) AS n FROM speaker_cluster_vectors WHERE owner_id = ? AND model_id = ? LIMIT 1`)
      .get(s.identity.ownerId, modelId)) as { n: number } | undefined
  return r ? r.n / 4 : null
}

function checkDims(s: StoreCtx, modelId: string, v: Float32Array): void {
  const dims = modelDims(s, modelId)
  if (dims !== null && dims !== v.length) throw invalid("vector doesn't match the model's dimension")
}

// ---------- secure deletes ----------

/**
 * One transaction with `secure_delete` on: a deleted or rewritten vector's old cell and freed
 * pages are zeroed. Run `checkpointVoice` after it when a vector went.
 */
export function secureWrite<T>(s: StoreCtx, fn: () => T): T {
  const before = s.db.pragma('secure_delete', { simple: true }) as number
  s.db.pragma('secure_delete = ON')
  try {
    return inTransaction(s.db, fn)
  } finally {
    s.db.pragma(`secure_delete = ${before === 2 ? 'FAST' : before ? 'ON' : 'OFF'}`)
  }
}

/** The WAL checkpoint (TRUNCATE) after a vector delete: no old page image stays in the WAL. */
export function checkpointVoice(s: StoreCtx): void {
  try {
    s.db.pragma('wal_checkpoint(TRUNCATE)')
  } catch (err) {
    s.log('warn', 'speakers:checkpoint-failed', { err })
  }
}

// ---------- small checks ----------

function id(v: unknown, what: string): string {
  if (typeof v !== 'string' || !v || v.length > MAX_ID) throw invalid(`${what} is required`)
  return v
}

function optId(v: unknown, what: string): string | null {
  if (v === undefined || v === null || v === '') return null
  return id(v, what)
}

function count(v: unknown, what: string): number {
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0) throw invalid(`${what} must be a non-negative number`)
  return Math.round(n)
}

function optMs(v: unknown, what: string): number | null {
  if (v === undefined || v === null) return null
  return count(v, what)
}

function channelOf(v: unknown): SpeakerChannel {
  if (!CHANNELS.includes(v as SpeakerChannel)) throw invalid('channel must be mic or system')
  return v as SpeakerChannel
}

/** The person row behind an id, following `merged_into` to the surviving person. */
export function livePerson(s: StoreCtx, personId: string): { id: string; isSelf: boolean } | null {
  let current = personId
  for (let hops = 0; hops < 10; hops++) {
    const r = s.db
      .prepare(`SELECT id, is_self, merged_into FROM speaker_people WHERE id = ? AND owner_id = ?`)
      .get(current, s.identity.ownerId) as Row | undefined
    if (!r) return null
    if (typeof r['merged_into'] !== 'string' || !r['merged_into']) return { id: String(r['id']), isSelf: r['is_self'] === 1 }
    current = r['merged_into']
  }
  return null
}

function hasActiveAgreement(s: StoreCtx, personId: string): boolean {
  return !!s.db.prepare(`SELECT 1 FROM speaker_agreements WHERE person_id = ? AND owner_id = ? AND revoked_at IS NULL LIMIT 1`).get(personId, s.identity.ownerId)
}

/** `speakers.voices` as stored (off by default): cluster vectors exist only while it is on. */
function voicesOn(s: StoreCtx): boolean {
  const r = s.db.prepare(`SELECT value FROM settings WHERE owner_id = ? AND key = 'speakers.voices'`).get(s.identity.ownerId) as
    | { value: string }
    | undefined
  return r?.value === 'true'
}

/** The note still holds an unexpired cluster vector (the only thing a pending request can name). */
function noteHasVector(s: StoreCtx, noteId: string): boolean {
  return !!s.db.prepare(`SELECT 1 FROM speaker_cluster_vectors WHERE note_id = ? AND expires_at > ? LIMIT 1`).get(noteId, nowIso())
}

function liveNote(s: StoreCtx, noteId: string): boolean {
  return !!s.db
    .prepare(`SELECT 1 FROM documents WHERE id = ? AND owner_id = ? AND deleted_at IS NULL`)
    .get(noteId, s.identity.ownerId)
}

// ---------- voice spaces ----------

interface StoredExemplar {
  id: string
  vector: Float32Array
  weight: number
  cleanMs: number
}

function spaceExemplars(s: StoreCtx, personId: string, modelId: string, channel: SpeakerChannel): StoredExemplar[] {
  const rows = s.db
    .prepare(
      `SELECT id, vector, weight, clean_ms FROM speaker_exemplars
       WHERE person_id = ? AND model_id = ? AND channel = ? ORDER BY created_at, rid`
    )
    .all(personId, modelId, channel) as Row[]
  return rows.map((r) => ({ id: String(r['id']), vector: blobVector(r['vector']), weight: Number(r['weight']), cleanMs: Number(r['clean_ms'] ?? 0) }))
}

/**
 * Recomputes one space from its current exemplars, or deletes it when none is left.
 * `confirmations` counts the exemplars, each one a confirmation or an enrollment event.
 */
export function recomputeSpace(s: StoreCtx, personId: string, modelId: string, channel: SpeakerChannel): void {
  const list = spaceExemplars(s, personId, modelId, channel)
  const centroid = weightedCentroid(list)
  if (!centroid) {
    s.db.prepare(`DELETE FROM speaker_voice_spaces WHERE person_id = ? AND model_id = ? AND channel = ?`).run(personId, modelId, channel)
    return
  }
  s.db
    .prepare(
      `INSERT INTO speaker_voice_spaces (id, workspace_id, owner_id, person_id, model_id, channel, centroid, count, clean_ms, confirmations, updated_at)
       VALUES (@id, @ws, @owner, @person, @model, @channel, @centroid, @count, @cleanMs, @count, @now)
       ON CONFLICT (person_id, model_id, channel) DO UPDATE SET centroid = excluded.centroid, count = excluded.count,
         clean_ms = excluded.clean_ms, confirmations = excluded.confirmations, updated_at = excluded.updated_at`
    )
    .run({
      id: randomUUID(),
      ws: s.identity.workspaceId,
      owner: s.identity.ownerId,
      person: personId,
      model: modelId,
      channel,
      centroid: vectorBlob(centroid),
      count: list.length,
      cleanMs: list.reduce((n, e) => n + e.cleanMs, 0),
      now: nowIso()
    })
}

/** The existing exemplar closest to the current centroid (the one that adds the least). */
function closestToCentroid(list: StoredExemplar[]): StoredExemplar | null {
  const centroid = weightedCentroid(list)
  if (!centroid) return list[0] ?? null
  let best: StoredExemplar | null = null
  let bestScore = -Infinity
  for (const e of list) {
    const score = dot(e.vector, centroid)
    // Ties: the older one goes (the list is in creation order).
    if (score > bestScore) {
      best = e
      bestScore = score
    }
  }
  return best
}

/** Removes the closest-to-centroid exemplar until the space fits the cap; returns the ids removed. */
export function applyCap(s: StoreCtx, personId: string, modelId: string, channel: SpeakerChannel, room = 0): string[] {
  const list = spaceExemplars(s, personId, modelId, channel)
  const removed: string[] = []
  const del = s.db.prepare(`DELETE FROM speaker_exemplars WHERE id = ?`)
  while (list.length > L.exemplarCap - room) {
    const victim = closestToCentroid(list)
    if (!victim) break
    del.run(victim.id)
    removed.push(victim.id)
    list.splice(list.indexOf(victim), 1)
  }
  return removed
}

/** Every (model, channel) space a person has exemplars or a space in. */
function spacesOf(s: StoreCtx, personId: string): { modelId: string; channel: SpeakerChannel }[] {
  const rows = s.db
    .prepare(
      `SELECT model_id, channel FROM speaker_exemplars WHERE person_id = @p
       UNION SELECT model_id, channel FROM speaker_voice_spaces WHERE person_id = @p`
    )
    .all({ p: personId }) as Row[]
  return rows.map((r) => ({ modelId: String(r['model_id']), channel: r['channel'] === 'system' ? 'system' : 'mic' }))
}

/** After exemplars moved to `personId` (a merge): the cap per space, then every centroid. Returns the count removed. */
export function capAndRecomputeAll(s: StoreCtx, personId: string): number {
  let removed = 0
  for (const sp of spacesOf(s, personId)) {
    removed += applyCap(s, personId, sp.modelId, sp.channel).length
    recomputeSpace(s, personId, sp.modelId, sp.channel)
  }
  return removed
}

// ---------- exemplars ----------

interface ExemplarInsert {
  personId: string
  modelId: string
  channel: SpeakerChannel
  vector: Float32Array
  cleanMs: number
  weight: number
  sourceNoteId: string | null
  sourcePassId: string | null
  sourceLabel: string | null
  spanStartMs: number | null
  spanEndMs: number | null
  via: SpeakerSampleVia
}

/** Inserts one exemplar inside the caller's secure transaction, making room under the cap first. */
export function insertExemplar(s: StoreCtx, e: ExemplarInsert): { id: string; replacedId: string | null } {
  const [replacedId = null] = applyCap(s, e.personId, e.modelId, e.channel, 1)
  const newId = randomUUID()
  const now = nowIso()
  s.db
    .prepare(
      `INSERT INTO speaker_exemplars (id, workspace_id, owner_id, person_id, model_id, channel, vector, clean_ms, weight,
         source_note_id, source_pass_id, source_label, span_start_ms, span_end_ms, confirmed_via, confirmed_at, created_at)
       VALUES (@id, @ws, @owner, @person, @model, @channel, @vector, @cleanMs, @weight,
         @note, @pass, @label, @start, @end, @via, @now, @now)`
    )
    .run({
      id: newId,
      ws: s.identity.workspaceId,
      owner: s.identity.ownerId,
      person: e.personId,
      model: e.modelId,
      channel: e.channel,
      vector: vectorBlob(e.vector),
      cleanMs: e.cleanMs,
      weight: e.weight,
      note: e.sourceNoteId,
      pass: e.sourcePassId,
      label: e.sourceLabel,
      start: e.spanStartMs,
      end: e.spanEndMs,
      via: e.via,
      now
    })
  recomputeSpace(s, e.personId, e.modelId, e.channel)
  return { id: newId, replacedId }
}

/**
 * The agreement guard, the far-from-profile check and the cap, then the exact
 * centroid. A first exemplar of a new model id also clears the person's exemplars of any older
 * model (re-enrollment).
 */
export function addSpeakerExemplar(s: StoreCtx, raw: NewSpeakerExemplar): AddSpeakerExemplarResult {
  if (!raw || typeof raw !== 'object') throw invalid('exemplar is required')
  const modelId = id(raw.modelId, 'modelId')
  const channel = channelOf(raw.channel)
  const vector = checkVector(raw.vector)
  const cleanMs = count(raw.cleanMs, 'cleanMs')
  const weight = Number(raw.weight)
  if (!Number.isFinite(weight) || weight <= 0 || weight > 1) throw invalid('weight must be in (0, 1]')
  if (!VIAS.includes(raw.via) || raw.via === 'legacy') throw invalid('unknown confirmation kind')
  const far = raw.farCosine === null || raw.farCosine === undefined ? null : Number(raw.farCosine)
  if (far !== null && (!Number.isFinite(far) || far < -1 || far > 1)) throw invalid('farCosine must be a cosine')
  const spanStartMs = optMs(raw.spanStartMs, 'spanStartMs')
  const spanEndMs = optMs(raw.spanEndMs, 'spanEndMs')
  const insert = {
    modelId,
    channel,
    vector,
    cleanMs,
    weight,
    sourceNoteId: optId(raw.sourceNoteId, 'sourceNoteId'),
    sourcePassId: optId(raw.sourcePassId, 'sourcePassId'),
    sourceLabel: optId(raw.sourceLabel, 'sourceLabel'),
    spanStartMs,
    spanEndMs,
    via: raw.via
  }
  checkDims(s, modelId, vector)

  const person = livePerson(s, id(raw.personId, 'personId'))
  if (!person) throw notFound('person', String(raw.personId))
  if (person.isSelf && channel !== 'mic') throw invalid('the user has mic samples only')
  if (!person.isSelf && !hasActiveAgreement(s, person.id)) {
    s.log('warn', 'speakers:exemplar-refused', { code: 'no-agreement' })
    return { status: 'refused-no-agreement' }
  }
  if (far !== null) {
    const list = spaceExemplars(s, person.id, modelId, channel)
    const centroid = list.length >= L.farCheckMinExemplars ? weightedCentroid(list) : null
    if (centroid && dot(vector, centroid) < far) {
      inTransaction(s.db, () =>
        s.db.prepare(`UPDATE speaker_people SET skipped_samples = skipped_samples + 1, updated_at = ? WHERE id = ?`).run(nowIso(), person.id)
      )
      s.touch('speaker_people', person.id)
      s.log('info', 'speakers:exemplar-skipped', { code: 'far-from-profile' })
      return { status: 'skipped-far' }
    }
  }
  let olderModels = 0
  const r = secureWrite(s, () => {
    const added = insertExemplar(s, { ...insert, personId: person.id })
    // Never blended across model ids: the older model's samples go once a new one exists.
    olderModels = s.db.prepare(`DELETE FROM speaker_exemplars WHERE person_id = ? AND model_id <> ?`).run(person.id, modelId).changes
    s.db.prepare(`DELETE FROM speaker_voice_spaces WHERE person_id = ? AND model_id <> ?`).run(person.id, modelId)
    return added
  })
  if (r.replacedId || olderModels) checkpointVoice(s)
  s.touch('speaker_exemplars', person.id)
  s.touch('speaker_voice_spaces', person.id)
  s.log('info', 'speakers:exemplar-added', { replaced: r.replacedId ? 1 : 0, olderModels })
  return { status: 'added', id: r.id, replacedId: r.replacedId }
}

export function listSpeakerSamples(s: StoreCtx, personId: string): SpeakerSampleRow[] {
  const rows = s.db
    .prepare(
      `SELECT e.id, e.channel, e.created_at, e.source_note_id, e.clean_ms, e.confirmed_via, d.id AS note_id, d.title
       FROM speaker_exemplars e
       LEFT JOIN documents d ON d.id = e.source_note_id AND d.deleted_at IS NULL
       WHERE e.person_id = ? AND e.owner_id = ?
       ORDER BY e.created_at DESC, e.rid DESC`
    )
    .all(id(personId, 'personId'), s.identity.ownerId) as Row[]
  return rows.map((r) => {
    const out: SpeakerSampleRow = {
      sampleId: String(r['id']),
      channel: r['channel'] === 'system' ? 'system' : 'mic',
      createdAt: String(r['created_at']),
      cleanMs: Number(r['clean_ms'] ?? 0),
      via: VIAS.includes(r['confirmed_via'] as SpeakerSampleVia) ? (r['confirmed_via'] as SpeakerSampleVia) : 'confirm'
    }
    if (typeof r['note_id'] === 'string') {
      out.noteId = r['note_id']
      out.noteTitle = typeof r['title'] === 'string' ? r['title'] : ''
    }
    return out
  })
}

/** Remove sample (Manage samples): the exact centroid follows. */
export function removeSpeakerExemplar(s: StoreCtx, exemplarId: string): { personId: string } | null {
  const r = s.db
    .prepare(`SELECT person_id, model_id, channel FROM speaker_exemplars WHERE id = ? AND owner_id = ?`)
    .get(id(exemplarId, 'sampleId'), s.identity.ownerId) as Row | undefined
  if (!r) return null
  const personId = String(r['person_id'])
  secureWrite(s, () => {
    s.db.prepare(`DELETE FROM speaker_exemplars WHERE id = ?`).run(exemplarId)
    recomputeSpace(s, personId, String(r['model_id']), r['channel'] === 'system' ? 'system' : 'mic')
  })
  checkpointVoice(s)
  s.touch('speaker_exemplars', personId)
  s.touch('speaker_voice_spaces', personId)
  s.log('info', 'speakers:exemplar-removed', { rows: 1 })
  return { personId }
}

/** The matching gallery of one model: unmerged people's spaces with their exemplars. */
export function speakerVoiceGallery(s: StoreCtx, q: { modelId: string; personIds?: string[] }): SpeakerVoiceSpaceRow[] {
  const modelId = id(q?.modelId, 'modelId')
  const filter = Array.isArray(q.personIds) ? q.personIds.filter((p): p is string => typeof p === 'string') : null
  const rows = s.db
    .prepare(
      `SELECT v.person_id, v.channel, v.centroid, v.count, v.clean_ms, v.confirmations
       FROM speaker_voice_spaces v JOIN speaker_people p ON p.id = v.person_id
       WHERE v.owner_id = @owner AND v.model_id = @model AND p.merged_into IS NULL
         AND (@all = 1 OR v.person_id IN (SELECT value FROM json_each(@ids)))
       ORDER BY v.person_id, v.channel`
    )
    .all({ owner: s.identity.ownerId, model: modelId, all: filter ? 0 : 1, ids: JSON.stringify(filter ?? []) }) as Row[]
  return rows.map((r) => {
    const personId = String(r['person_id'])
    const channel: SpeakerChannel = r['channel'] === 'system' ? 'system' : 'mic'
    return {
      personId,
      modelId,
      channel,
      centroid: blobVector(r['centroid']),
      count: Number(r['count'] ?? 0),
      cleanMs: Number(r['clean_ms'] ?? 0),
      confirmations: Number(r['confirmations'] ?? 0),
      exemplars: spaceExemplars(s, personId, modelId, channel).map((e) => ({ id: e.id, vector: e.vector, weight: e.weight }))
    }
  })
}

// ---------- cluster vectors (the 14-day store) ----------

function toClusterVector(r: Row): SpeakerClusterVectorRow {
  return {
    noteId: String(r['note_id']),
    passId: String(r['pass_id']),
    source: r['source'] === 'system' ? 'system' : 'microphone',
    label: String(r['label']),
    modelId: String(r['model_id']),
    vector: blobVector(r['vector']),
    speechMs: Number(r['speech_ms'] ?? 0),
    cleanMs: Number(r['clean_ms'] ?? 0),
    createdAt: String(r['created_at']),
    expiresAt: String(r['expires_at'])
  }
}

/**
 * Rows of a note in Trash (or gone) are skipped: a trashed note keeps no vectors. With
 * `speakers.voices` off every row is skipped, read in the same transaction, so a job that read
 * "on" before the switch went off stores nothing.
 */
export function saveSpeakerClusterVectors(s: StoreCtx, rows: NewSpeakerClusterVector[]): void {
  if (!Array.isArray(rows)) throw invalid('rows must be an array')
  if (rows.length > 500) throw invalid('too many cluster vectors')
  const clean = rows.map((r) => {
    if (!r || typeof r !== 'object') throw invalid('cluster vector is required')
    if (!SOURCES.includes(r.source)) throw invalid('source must be microphone or system')
    if (typeof r.label !== 'string' || !r.label || r.label.length > MAX_LABEL) throw invalid('label is required')
    return {
      noteId: id(r.noteId, 'noteId'),
      passId: id(r.passId, 'passId'),
      source: r.source,
      label: r.label,
      modelId: id(r.modelId, 'modelId'),
      vector: checkVector(r.vector),
      speechMs: count(r.speechMs, 'speechMs'),
      cleanMs: count(r.cleanMs, 'cleanMs')
    }
  })
  if (!clean.length) return
  const created = new Date()
  const expires = new Date(created.getTime() + L.clusterVectorDays * DAY_MS).toISOString()
  let replaced = 0
  let skipped = 0
  let off = false
  const notes = new Set<string>()
  secureWrite(s, () => {
    if (!voicesOn(s)) {
      off = true
      return
    }
    const exists = s.db.prepare(`SELECT 1 FROM speaker_cluster_vectors WHERE note_id = ? AND pass_id = ? AND label = ?`)
    const put = s.db.prepare(
      `INSERT INTO speaker_cluster_vectors (id, workspace_id, owner_id, note_id, pass_id, source, label, model_id, vector, speech_ms, clean_ms, created_at, expires_at)
       VALUES (@id, @ws, @owner, @note, @pass, @source, @label, @model, @vector, @speech, @clean, @created, @expires)
       ON CONFLICT (note_id, pass_id, label) DO UPDATE SET source = excluded.source, model_id = excluded.model_id,
         vector = excluded.vector, speech_ms = excluded.speech_ms, clean_ms = excluded.clean_ms,
         created_at = excluded.created_at, expires_at = excluded.expires_at`
    )
    for (const r of clean) {
      if (!liveNote(s, r.noteId)) {
        skipped++
        continue
      }
      checkDims(s, r.modelId, r.vector)
      if (exists.get(r.noteId, r.passId, r.label)) replaced++
      put.run({
        id: randomUUID(),
        ws: s.identity.workspaceId,
        owner: s.identity.ownerId,
        note: r.noteId,
        pass: r.passId,
        source: r.source,
        label: r.label,
        model: r.modelId,
        vector: vectorBlob(r.vector),
        speech: r.speechMs,
        clean: r.cleanMs,
        created: created.toISOString(),
        expires
      })
      notes.add(r.noteId)
    }
  })
  if (off) {
    s.log('info', 'speakers:cluster-vectors-refused', { code: 'voices-off', rows: clean.length })
    return
  }
  if (replaced) checkpointVoice(s)
  if (notes.size) s.touch('speaker_cluster_vectors', ...notes)
  s.log('info', 'speakers:cluster-vectors-saved', { rows: clean.length - skipped, replaced, skipped })
}

export function listSpeakerClusterVectors(s: StoreCtx, q: { noteId: string; passId?: string; modelId?: string }): SpeakerClusterVectorRow[] {
  const noteId = id(q?.noteId, 'noteId')
  const rows = s.db
    .prepare(
      `SELECT * FROM speaker_cluster_vectors
       WHERE owner_id = @owner AND note_id = @note AND expires_at > @now
         AND (@pass IS NULL OR pass_id = @pass) AND (@model IS NULL OR model_id = @model)
       ORDER BY pass_id, label`
    )
    .all({ owner: s.identity.ownerId, note: noteId, now: nowIso(), pass: optId(q.passId, 'passId'), model: optId(q.modelId, 'modelId') }) as Row[]
  return rows.map(toClusterVector)
}

export function notesWithSpeakerClusterVectors(s: StoreCtx, q: { modelId: string }): string[] {
  const rows = s.db
    .prepare(
      `SELECT DISTINCT v.note_id FROM speaker_cluster_vectors v JOIN documents d ON d.id = v.note_id
       WHERE v.owner_id = ? AND v.model_id = ? AND v.expires_at > ? AND d.deleted_at IS NULL
       ORDER BY v.note_id`
    )
    .all(s.identity.ownerId, id(q?.modelId, 'modelId'), nowIso()) as { note_id: string }[]
  return rows.map((r) => r.note_id)
}

/**
 * Drops the pending requests of these notes (or of every note) that hold no unexpired cluster
 * vector (a request lives as long as the vector it would name), and those notes'
 * `pending` flags. Inside the caller's transaction. Returns the requests dropped and the notes
 * whose suggestion rows changed.
 */
function dropOrphanPending(s: StoreCtx, noteIds: string[] | 'all', now: IsoTime = nowIso()): { pending: number; guesses: string[] } {
  if (noteIds !== 'all' && !noteIds.length) return { pending: 0, guesses: [] }
  const pending = s.db
    .prepare(
      `DELETE FROM speaker_pending WHERE owner_id = @owner AND (@all = 1 OR note_id IN (SELECT value FROM json_each(@ids)))
       AND NOT EXISTS (SELECT 1 FROM speaker_cluster_vectors v WHERE v.note_id = speaker_pending.note_id AND v.expires_at > @now)`
    )
    .run({ owner: s.identity.ownerId, all: noteIds === 'all' ? 1 : 0, ids: JSON.stringify(noteIds === 'all' ? [] : noteIds), now }).changes
  return { pending, guesses: clearDroppedPendingFlags(s, noteIds) }
}

/**
 * `{all}` (Recognize voices off) or a whole note also drops the pending requests left without a
 * vector. A pass or a set of labels (re-pass, confirm, Skip) leaves pending requests to the caller,
 * which re-maps or ends them.
 */
export function deleteSpeakerClusterVectors(
  s: StoreCtx,
  q: { noteId: string; passId?: string; labels?: string[] } | { all: true }
): number {
  let n = 0
  let dropped: { pending: number; guesses: string[] } = { pending: 0, guesses: [] }
  let touched: string[] = []
  if ('all' in q && q.all === true) {
    secureWrite(s, () => {
      n = s.db.prepare(`DELETE FROM speaker_cluster_vectors WHERE owner_id = ?`).run(s.identity.ownerId).changes
      dropped = dropOrphanPending(s, 'all')
    })
  } else {
    const r = q as { noteId: string; passId?: string; labels?: string[] }
    const noteId = id(r?.noteId, 'noteId')
    const passId = optId(r.passId, 'passId')
    const labels = Array.isArray(r.labels) ? r.labels.filter((l): l is string => typeof l === 'string') : null
    if (labels && !passId) throw invalid('labels need a passId')
    secureWrite(s, () => {
      n = s.db
        .prepare(
          `DELETE FROM speaker_cluster_vectors WHERE owner_id = @owner AND note_id = @note
           AND (@pass IS NULL OR pass_id = @pass) AND (@all = 1 OR label IN (SELECT value FROM json_each(@labels)))`
        )
        .run({ owner: s.identity.ownerId, note: noteId, pass: passId, all: labels ? 0 : 1, labels: JSON.stringify(labels ?? []) }).changes
      if (!passId) dropped = dropOrphanPending(s, [noteId])
    })
    touched = [noteId]
  }
  if (n) checkpointVoice(s)
  if (n) s.touch('speaker_cluster_vectors', ...touched)
  if (dropped.pending) s.touch('speaker_pending', ...touched)
  if (dropped.guesses.length) s.touch('speaker_guesses', ...dropped.guesses)
  s.log('info', 'speakers:cluster-vectors-deleted', { rows: n, pending: dropped.pending })
  return n
}

/**
 * The note leaves (Trash, by any path that sets `deleted_at`): its cluster vectors and pending
 * requests, and its `pending` flags, inside the caller's secure transaction. Returns the
 * rows deleted; `guesses` is true when a suggestion row changed.
 */
export function deleteNoteVoiceRows(s: StoreCtx, noteId: string): { vectors: number; pending: number; guesses: boolean } {
  const vectors = s.db.prepare(`DELETE FROM speaker_cluster_vectors WHERE note_id = ?`).run(noteId).changes
  const pending = s.db.prepare(`DELETE FROM speaker_pending WHERE note_id = ?`).run(noteId).changes
  const guesses = pending > 0 && clearDroppedPendingFlags(s, [noteId]).length > 0
  return { vectors, pending, guesses }
}

// ---------- negatives ----------

export function addSpeakerNegative(s: StoreCtx, n: Omit<SpeakerNegativeRow, 'createdAt'>): void {
  const noteId = id(n?.noteId, 'noteId')
  const passId = id(n.passId, 'passId')
  const identityKey = id(n.identityKey, 'identityKey')
  const person = livePerson(s, id(n.personId, 'personId'))
  if (!person) throw notFound('person', n.personId)
  if (!liveNote(s, noteId)) throw notFound('note', noteId)
  inTransaction(s.db, () =>
    s.db
      .prepare(
        `INSERT INTO speaker_negatives (id, workspace_id, owner_id, note_id, pass_id, identity_key, person_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (note_id, identity_key, person_id) DO UPDATE SET pass_id = excluded.pass_id`
      )
      .run(randomUUID(), s.identity.workspaceId, s.identity.ownerId, noteId, passId, identityKey, person.id, nowIso())
  )
  s.touch('speaker_negatives', noteId)
}

export function deleteSpeakerNegative(s: StoreCtx, q: { noteId: string; identityKey: string; personId: string }): void {
  const person = livePerson(s, id(q?.personId, 'personId'))
  const n = s.db
    .prepare(`DELETE FROM speaker_negatives WHERE owner_id = ? AND note_id = ? AND identity_key = ? AND person_id = ?`)
    .run(s.identity.ownerId, id(q.noteId, 'noteId'), id(q.identityKey, 'identityKey'), person?.id ?? q.personId).changes
  if (n) s.touch('speaker_negatives', q.noteId)
}

export function listSpeakerNegatives(s: StoreCtx, noteId: string): SpeakerNegativeRow[] {
  const rows = s.db
    .prepare(`SELECT * FROM speaker_negatives WHERE owner_id = ? AND note_id = ? ORDER BY created_at, rid`)
    .all(s.identity.ownerId, id(noteId, 'noteId')) as Row[]
  return rows.map((r) => ({
    noteId: String(r['note_id']),
    passId: String(r['pass_id']),
    identityKey: String(r['identity_key']),
    personId: String(r['person_id']),
    createdAt: String(r['created_at'])
  }))
}

/** Re-pass: each old identity key moves to its successor under `passId`; `to: null` deletes it. */
export function remapSpeakerNegatives(s: StoreCtx, q: { noteId: string; passId: string; map: { from: string; to: string | null }[] }): void {
  const noteId = id(q?.noteId, 'noteId')
  const passId = id(q.passId, 'passId')
  if (!Array.isArray(q.map) || q.map.length > 500) throw invalid('map must be an array')
  const target = new Map(q.map.map((m) => [id(m?.from, 'from'), m.to === null ? null : id(m.to, 'to')] as const))
  inTransaction(s.db, () => {
    // Computed from the rows as read, so a chain (a → b, b → c) moves each row once; a pairing
    // that already exists under the new key keeps its older row.
    const rows = s.db
      .prepare(`SELECT * FROM speaker_negatives WHERE owner_id = ? AND note_id = ? ORDER BY created_at, rid`)
      .all(s.identity.ownerId, noteId) as Row[]
    const kept = new Map<string, Row>()
    for (const r of rows) {
      const key = String(r['identity_key'])
      const to = target.has(key) ? target.get(key) : key
      if (to === null || to === undefined) continue
      const moved = target.has(key) ? { ...r, identity_key: to, pass_id: passId } : r
      const k = `${to}
${String(r['person_id'])}`
      if (!kept.has(k)) kept.set(k, moved)
    }
    s.db.prepare(`DELETE FROM speaker_negatives WHERE owner_id = ? AND note_id = ?`).run(s.identity.ownerId, noteId)
    const put = s.db.prepare(
      `INSERT INTO speaker_negatives (id, workspace_id, owner_id, note_id, pass_id, identity_key, person_id, created_at)
       VALUES (@id, @workspace_id, @owner_id, @note_id, @pass_id, @identity_key, @person_id, @created_at)`
    )
    for (const r of kept.values()) {
      put.run({
        id: r['id'],
        workspace_id: r['workspace_id'],
        owner_id: r['owner_id'],
        note_id: r['note_id'],
        pass_id: r['pass_id'],
        identity_key: r['identity_key'],
        person_id: r['person_id'],
        created_at: r['created_at']
      })
    }
  })
  s.touch('speaker_negatives', noteId)
}

// ---------- pending requests ----------

function toPending(r: Row): SpeakerPendingRow {
  return {
    id: String(r['id']),
    personId: String(r['person_id']),
    noteId: String(r['note_id']),
    startMs: Number(r['start_ms']),
    endMs: Number(r['end_ms']),
    source: SOURCES.includes(r['source'] as AudioSource) ? (r['source'] as AudioSource) : null,
    askedAt: String(r['asked_at'])
  }
}

/**
 * The request lives on the person: the note, the time span and the channel, never a vector. Refused
 * when the note holds no live cluster vector, since the offer could never fire.
 */
export function addSpeakerPending(s: StoreCtx, p: NewSpeakerPending): SpeakerPendingRow {
  const noteId = id(p?.noteId, 'noteId')
  const startMs = count(p.startMs, 'startMs')
  const endMs = count(p.endMs, 'endMs')
  if (endMs < startMs) throw invalid('endMs is before startMs')
  if (p.source !== undefined && p.source !== null && !SOURCES.includes(p.source)) throw invalid('source must be microphone or system')
  const source = p.source ?? null
  const person = livePerson(s, id(p.personId, 'personId'))
  if (!person) throw notFound('person', p.personId)
  if (person.isSelf) throw invalid("the user's own voice needs no agreement")
  if (!liveNote(s, noteId)) throw notFound('note', noteId)
  if (!noteHasVector(s, noteId)) throw invalid('the note holds no stored voice to ask about')
  const row: SpeakerPendingRow = { id: randomUUID(), personId: person.id, noteId, startMs, endMs, source, askedAt: nowIso() }
  inTransaction(s.db, () =>
    s.db
      .prepare(
        `INSERT INTO speaker_pending (id, workspace_id, owner_id, person_id, note_id, start_ms, end_ms, source, asked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(row.id, s.identity.workspaceId, s.identity.ownerId, row.personId, noteId, startMs, endMs, source, row.askedAt)
  )
  s.touch('speaker_pending', noteId, person.id)
  return row
}

export function listSpeakerPending(s: StoreCtx, q: { personId?: string; noteId?: string }): SpeakerPendingRow[] {
  const rows = s.db
    .prepare(
      `SELECT * FROM speaker_pending WHERE owner_id = @owner
         AND (@person IS NULL OR person_id = @person) AND (@note IS NULL OR note_id = @note)
       ORDER BY asked_at, rid`
    )
    .all({ owner: s.identity.ownerId, person: optId(q?.personId, 'personId'), note: optId(q?.noteId, 'noteId') }) as Row[]
  return rows.map(toPending)
}

export function deleteSpeakerPending(s: StoreCtx, ids: string[]): number {
  if (!Array.isArray(ids)) throw invalid('ids must be an array')
  const list = ids.filter((i): i is string => typeof i === 'string' && !!i)
  if (!list.length) return 0
  const r = inTransaction(s.db, () => {
    const rows = s.db
      .prepare(`DELETE FROM speaker_pending WHERE owner_id = ? AND id IN (SELECT value FROM json_each(?)) RETURNING note_id`)
      .all(s.identity.ownerId, JSON.stringify(list)) as { note_id: string }[]
    const notes = [...new Set(rows.map((x) => x.note_id))]
    return { n: rows.length, notes, guesses: clearDroppedPendingFlags(s, notes) }
  })
  if (r.n) s.touch('speaker_pending', ...r.notes)
  if (r.guesses.length) s.touch('speaker_guesses', ...r.guesses)
  return r.n
}

// ---------- Forget, Forget all, the sweeps ----------

function emptyDeleted(): SpeakerVoiceDeleted {
  return { exemplars: 0, spaces: 0, clusterVectors: 0, negatives: 0, pending: 0, agreementsStamped: 0 }
}

/**
 * Inside the caller's secure transaction: one person's voice; `last_matched_at` restarts with the
 * next voice. For the user, a legacy profile left by a failed first-start conversion goes too.
 * The notes whose `pending` flags were cleared are added to `guesses`.
 */
export function forgetPersonRows(
  s: StoreCtx,
  personId: string,
  via: 'forget' | 'withdrawn' | 'expired',
  now: IsoTime,
  guesses: Set<string>
): SpeakerVoiceDeleted {
  const out = emptyDeleted()
  out.exemplars = s.db.prepare(`DELETE FROM speaker_exemplars WHERE person_id = ?`).run(personId).changes
  out.spaces = s.db.prepare(`DELETE FROM speaker_voice_spaces WHERE person_id = ?`).run(personId).changes
  const pendingRows = s.db.prepare(`DELETE FROM speaker_pending WHERE person_id = ? RETURNING note_id`).all(personId) as { note_id: string }[]
  out.pending = pendingRows.length
  for (const n of clearDroppedPendingFlags(s, [...new Set(pendingRows.map((r) => r.note_id))])) guesses.add(n)
  out.agreementsStamped = stampActiveAgreements(s, [personId], via, now)
  s.db
    .prepare(`DELETE FROM voiceprints WHERE owner_id = ? AND EXISTS (SELECT 1 FROM speaker_people WHERE id = ? AND is_self = 1)`)
    .run(s.identity.ownerId, personId)
  s.db.prepare(`UPDATE speaker_people SET last_matched_at = NULL, updated_at = ? WHERE id = ?`).run(now, personId)
  return out
}

function touchVoice(s: StoreCtx, ...ids: string[]): void {
  for (const t of ['speaker_exemplars', 'speaker_voice_spaces', 'speaker_pending', 'speaker_agreements', 'speaker_people']) s.touch(t, ...ids)
}

/** Forget voice: exemplars, voice spaces and pending requests; the active agreement is stamped `via`. */
export function forgetSpeakerVoice(s: StoreCtx, q: { personId: string; via: 'forget' | 'withdrawn' | 'expired' }): SpeakerVoiceDeleted {
  if (q?.via !== 'forget' && q?.via !== 'withdrawn' && q?.via !== 'expired') throw invalid('via must be forget, withdrawn or expired')
  const person = livePerson(s, id(q.personId, 'personId'))
  if (!person) throw notFound('person', q.personId)
  const guesses = new Set<string>()
  const out = secureWrite(s, () => forgetPersonRows(s, person.id, q.via, nowIso(), guesses))
  checkpointVoice(s)
  touchVoice(s, person.id)
  if (person.isSelf) s.touch('voiceprints')
  if (guesses.size) s.touch('speaker_guesses', ...guesses)
  s.log('info', 'speakers:voice-forgotten', { ...out, via: q.via })
  return out
}

/**
 * Forget all: every exemplar, voice space, cluster vector, negative and pending request, and the
 * legacy self profile; active agreements are stamped `forget_all`. `keepSelf` (Recognize voices
 * off): the user's own exemplars, voice spaces and legacy profile stay.
 */
export function forgetAllSpeakerVoices(s: StoreCtx, q: { keepSelf: boolean }): SpeakerVoiceDeleted {
  const keepSelf = q?.keepSelf === true
  const owner = s.identity.ownerId
  let guesses: string[] = []
  const out = secureWrite(s, () => {
    const o = emptyDeleted()
    const notSelf = keepSelf ? `AND person_id NOT IN (SELECT id FROM speaker_people WHERE is_self = 1)` : ''
    o.exemplars = s.db.prepare(`DELETE FROM speaker_exemplars WHERE owner_id = ? ${notSelf}`).run(owner).changes
    o.spaces = s.db.prepare(`DELETE FROM speaker_voice_spaces WHERE owner_id = ? ${notSelf}`).run(owner).changes
    o.clusterVectors = s.db.prepare(`DELETE FROM speaker_cluster_vectors WHERE owner_id = ?`).run(owner).changes
    o.negatives = s.db.prepare(`DELETE FROM speaker_negatives WHERE owner_id = ?`).run(owner).changes
    o.pending = s.db.prepare(`DELETE FROM speaker_pending WHERE owner_id = ?`).run(owner).changes
    guesses = clearDroppedPendingFlags(s, 'all')
    o.agreementsStamped = stampActiveAgreements(s, 'all', 'forget_all', nowIso())
    if (!keepSelf) s.db.prepare(`DELETE FROM voiceprints WHERE owner_id = ?`).run(owner)
    s.db.prepare(`UPDATE speaker_people SET last_matched_at = NULL WHERE owner_id = ? ${keepSelf ? 'AND is_self = 0' : ''}`).run(owner)
    return o
  })
  checkpointVoice(s)
  touchVoice(s)
  s.touch('speaker_cluster_vectors')
  s.touch('speaker_negatives')
  if (!keepSelf) s.touch('voiceprints')
  if (guesses.length) s.touch('speaker_guesses', ...guesses)
  s.log('info', 'speakers:voices-forgotten-all', { ...out, keepSelf })
  return out
}

/**
 * The daily sweep: cluster vectors past `expires_at` (and, with `modelId`, every cluster vector
 * of another model; with `speakers.voices` off, every cluster vector), then every
 * pending request whose note holds no live vector, then the voice of every person
 * not matched for 365 days (stamped `expired`). A person's clock is `last_matched_at`, else the
 * active agreement's date, else the first exemplar's. A person with an active agreement and no
 * sample yet expires too, on the agreement's clock.
 */
export function sweepSpeakerData(s: StoreCtx, q: { now: IsoTime; modelId?: string }): { clusterVectors: number; peopleExpired: string[] } {
  const nowMs = Date.parse(String(q?.now))
  if (!Number.isFinite(nowMs)) throw invalid('now must be an ISO time')
  const now = new Date(nowMs).toISOString()
  const modelId = optId(q.modelId, 'modelId')
  const cutoff = new Date(nowMs - L.voiceExpiryDays * DAY_MS).toISOString()
  const owner = s.identity.ownerId
  const due = (
    s.db
      .prepare(
        `SELECT p.id, coalesce(p.last_matched_at,
           (SELECT max(a.attested_at) FROM speaker_agreements a WHERE a.person_id = p.id AND a.revoked_at IS NULL),
           (SELECT min(e.created_at) FROM speaker_exemplars e WHERE e.person_id = p.id)) AS clock
         FROM speaker_people p
         WHERE p.owner_id = ? AND (EXISTS (SELECT 1 FROM speaker_exemplars e WHERE e.person_id = p.id)
           OR EXISTS (SELECT 1 FROM speaker_agreements a WHERE a.person_id = p.id AND a.revoked_at IS NULL))`
      )
      .all(owner) as { id: string; clock: string | null }[]
  )
    .filter((r) => typeof r.clock === 'string' && r.clock <= cutoff)
    .map((r) => r.id)
  let vectors = 0
  let pending = 0
  let off = false
  const guesses = new Set<string>()
  secureWrite(s, () => {
    // Read in the transaction: a write that raced the off switch is caught here.
    off = !voicesOn(s)
    vectors = s.db
      .prepare(`DELETE FROM speaker_cluster_vectors WHERE owner_id = ? AND (? = 1 OR expires_at <= ? OR (? IS NOT NULL AND model_id <> ?))`)
      .run(owner, off ? 1 : 0, now, modelId, modelId).changes
    const dropped = dropOrphanPending(s, 'all', now)
    pending = dropped.pending
    for (const n of dropped.guesses) guesses.add(n)
    for (const personId of due) forgetPersonRows(s, personId, 'expired', now, guesses)
  })
  if (vectors || due.length) {
    checkpointVoice(s)
    s.touch('speaker_cluster_vectors')
    touchVoice(s, ...due)
  }
  if (pending) s.touch('speaker_pending')
  if (guesses.size) s.touch('speaker_guesses', ...guesses)
  s.log('info', 'speakers:swept', { clusterVectors: vectors, pending, peopleExpired: due.length, voicesOff: off })
  return { clusterVectors: vectors, peopleExpired: due }
}
