// SPDX-License-Identifier: Apache-2.0
// The user's naming paths: `speaker-names:accept`,
// `reject` (Skip), `not-person`, `ask-first`, `name-pending` and `undo`.
//
// - Every path but `undo` is refused with `busy` while the note's job runs and
//   with `stale` when the renderer's pass (or the identity key's) isn't the note's current one.
// - Only the word write happens at once, through the note's label-write queue, as a field
//   patch of `confirmed_spk` / `confirmed_pid` (or, for Not <name>, the removal of `auto_*`).
//   Nothing else ever writes `confirmed_spk`. The suggestion row changes in the same
//   queued turn, so Undo can put it back.
// - The rest waits for the 10 s Undo window (`undo.ts`): the sample, the cluster vector's
//   deletion, the end of a pending request, the relabel fan-out, the match row and
//   `last_matched_at`. A newer naming of the same cluster supersedes an older one's sample
//   and vector deletion.
// - Learning adds an exemplar only when all seven conditions hold: an explicit naming as
//   a person; Recognize voices on (Recognize my voice too for Me); an active agreement, or
//   self; Remember voice on; a stored cluster vector of the installed model; the whole speaker,
//   not Only this turn; and the far-from-profile check against the calibration's `farCosine`
//   (in the repo, with its agreement guard). The weight is min(1, cleanMs / 30 s). A person's first
//   exemplar therefore always follows an agreement: the consent sheet, or the pending offer.
// - Ask <name> first stores the request on the person (`speaker_pending`: the note, the
//   cluster's longest turn and its channel, never a vector) and only `pending: true` on the row;
//   the cluster vector stays unlinked. The offer re-resolves that span on that
//   channel, and refuses when the renderer's cluster isn't the one the span picks.
// No vector, score or name reaches a log: counts, scopes and codes only.

import { notulaError, type ErrorCode } from '@shared/errors'
import type { PushChannel } from '@shared/ipc'
import { identityPassId, sameSpeakerName, speakerIdentities, wordIdentityKeys, type SpeakerIdentity } from '@shared/lib/speakers'
import { SPEAKER_JOB_BUSY, SPEAKER_PROFILE_LIMITS, type SpeakerChannel, type SpeakerSampleVia } from '@shared/types/speakers'
import type { ProviderWord, SpeakerNameAccept, SpeakerNameAcceptResult, SpeakerNameSuggestion, TranscriptChunk } from '@shared/types/transcript'
import { speakerIdModelId } from '../asr/manifest'
import type { MainContext } from '../context'
import { expected } from '../ipc-expected'
import { log } from '../log'
import type { SpeakerPersonRow } from '../storage/api'
import { getTranscriptionManager } from '../transcription/manager'
import { getCalibration } from './calibration'
import { jobState } from './job'
import { currentPassId, labelQueue, type ChunkFieldPatch, type LabelWordFields } from './label-queue'
import { clusterForSpan, pendingSpanOf, type PendingSpan } from './pending-span'
import { pushSpeakerPeopleChanged } from './people-ipc'
import { requestRelabel } from './relabel'
import { deferUndoable } from './undo'

/** A negative's pass for a note without a pass (provider labels): it never meets a job. */
const NO_PASS = 'no-pass'
const MAX_TURN_CHUNKS = 5_000

type Row = Omit<SpeakerNameSuggestion, 'created_at'>
/** A row taken out by a queued write, for Undo (set inside the queue, read later). */
type Held = { row: { row: Row; index: number } | null }

function fail(code: ErrorCode, message: string): never {
  throw expected(notulaError(code, message))
}

function chunksOf(ctx: MainContext, noteId: string): Promise<TranscriptChunk[]> {
  return getTranscriptionManager(ctx).store.getTranscript(noteId)
}

function pushChanged(ctx: MainContext, noteId: string): void {
  for (const wc of ctx.windows.targets()) wc.send('speaker-names:changed' satisfies PushChannel, { noteId })
}

function channelOf(identity: SpeakerIdentity): SpeakerChannel {
  return identity.channel === 'microphone' ? 'mic' : 'system'
}

/** `r<N>`: the cluster label inside `r:<pass>:r<N>`. */
function clusterLabel(identityKey: string): string | null {
  return identityKey.startsWith('r:') ? identityKey.slice(identityKey.lastIndexOf(':') + 1) : null
}

// ---------- the guards ----------

interface Target {
  chunks: TranscriptChunk[]
  identity: SpeakerIdentity
  /** The note's current pass; null without one. */
  passId: string | null
}

/**
 * `busy` while the job runs; `stale` when `passId` (if the request carries one) or the
 * identity key's pass isn't the note's current pass, or the identity no longer exists. A null
 * `passId` (a row written before speaker profiles) is checked by the key's own pass only.
 */
async function target(ctx: MainContext, noteId: string, identityKey: string, passId?: string | null): Promise<Target> {
  if (SPEAKER_JOB_BUSY.includes(jobState(noteId))) fail('busy', 'Notula is still naming the speakers of this note.')
  const chunks = await chunksOf(ctx, noteId)
  const current = currentPassId(chunks)
  if (typeof passId === 'string' && passId !== current) fail('stale', 'The speakers of this note changed. Try again.')
  const keyPass = identityPassId(identityKey)
  if (identityKey.startsWith('r:') && keyPass !== current) fail('stale', 'The speakers of this note changed. Try again.')
  const identity = speakerIdentities(chunks, { live: false }).identities.find((i) => i.key === identityKey)
  if (!identity) fail('stale', 'The speakers of this note changed. Try again.')
  return { chunks, identity, passId: current }
}

async function personOf(ctx: MainContext, personId: string): Promise<SpeakerPersonRow> {
  const p = await ctx.storage.getSpeakerPerson(personId, { resolveMerged: true })
  if (!p) fail('not-found', 'This person no longer exists.')
  return p
}

async function hasActiveAgreement(ctx: MainContext, personId: string): Promise<boolean> {
  const a = await ctx.storage.getSpeakerAgreement(personId)
  return !!a && !a.revokedAt
}

// ---------- queued writes ----------

interface WordChange {
  chunkId: string
  index: number
  /** The fields as they were, `null` for absent. */
  before: LabelWordFields
  /** The fields as written. */
  after: LabelWordFields
}

type WordPick = (word: ProviderWord, key: string | null, chunk: TranscriptChunk) => LabelWordFields | null

/**
 * One queued word write: `pick` returns the fields to set on a word, or null. The patch reads
 * the chunks inside the queue; when `passId` is no longer the note's pass, the write drops and
 * the caller answers `stale`. `commit` runs in the same queued turn (suggestion rows).
 */
async function writeWords(
  ctx: MainContext,
  noteId: string,
  kind: 'naming' | 'undo',
  passId: string | null,
  pick: WordPick,
  commit?: () => Promise<void>
): Promise<WordChange[]> {
  const changes: WordChange[] = []
  const r = await labelQueue(ctx).enqueue(noteId, {
    kind,
    ...(passId ? { passId } : {}),
    patch: (chunks) => {
      if (passId !== null && kind === 'naming' && currentPassId(chunks) !== passId) return null
      const keys = wordIdentityKeys(chunks)
      const patches: ChunkFieldPatch[] = []
      for (const c of chunks) {
        const d = c.providerDetails
        if (!d) continue
        const ks = keys.get(c.id)
        const words: NonNullable<ChunkFieldPatch['words']> = []
        d.words.forEach((w, index) => {
          const set = pick(w, ks?.[index] ?? null, c)
          if (!set) return
          const before: Record<string, unknown> = {}
          let differs = false
          for (const [k, v] of Object.entries(set)) {
            const was = (w as unknown as Record<string, unknown>)[k]
            before[k] = was === undefined ? null : was
            if ((was ?? null) !== (v ?? null)) differs = true
          }
          if (!differs) return
          words.push({ index, set })
          changes.push({ chunkId: c.id, index, before: before as LabelWordFields, after: set })
        })
        if (words.length) patches.push({ chunkId: c.id, words })
      }
      return patches
    },
    ...(commit ? { commit: () => commit() } : {})
  })
  if (r.status !== 'written') fail('stale', 'The speakers of this note changed. Try again.')
  return changes
}

/** Undo of a word write: each word goes back to its earlier fields while it still holds what was written. */
async function revertWords(ctx: MainContext, noteId: string, changes: readonly WordChange[], commit?: () => Promise<void>): Promise<void> {
  const byWord = new Map(changes.map((c) => [`${c.chunkId}:${c.index}`, c]))
  await labelQueue(ctx).enqueue(noteId, {
    kind: 'undo',
    patch: (chunks) => {
      const patches: ChunkFieldPatch[] = []
      for (const c of chunks) {
        const words: NonNullable<ChunkFieldPatch['words']> = []
        c.providerDetails?.words.forEach((w, index) => {
          const ch = byWord.get(`${c.id}:${index}`)
          if (!ch) return
          const now = w as unknown as Record<string, unknown>
          const intact = Object.entries(ch.after).every(([k, v]) => (now[k] ?? null) === (v ?? null))
          if (intact) words.push({ index, set: ch.before })
        })
        if (words.length) patches.push({ chunkId: c.id, words })
      }
      return patches
    },
    ...(commit ? { commit: () => commit() } : {})
  })
}

/** Takes one suggestion row out (inside a queued turn); resolves with it for Undo. */
async function takeRow(ctx: MainContext, noteId: string, identityKey: string): Promise<{ row: Row; index: number } | null> {
  const rows = await ctx.storage.listSpeakerNameSuggestions(noteId)
  const index = rows.findIndex((r) => r.identityKey === identityKey)
  if (index < 0) return null
  await ctx.storage.deleteSpeakerNameSuggestion(noteId, identityKey)
  const { created_at: _c, ...row } = rows[index] as SpeakerNameSuggestion
  return { row, index }
}

/** Puts a row back where it was (Undo), or replaces the one now there. */
async function restoreRow(ctx: MainContext, noteId: string, saved: { row: Row; index: number } | null, dropKey?: string): Promise<void> {
  const rows: Row[] = (await ctx.storage.listSpeakerNameSuggestions(noteId))
    .map(({ created_at: _c, ...r }) => r)
    .filter((r) => r.identityKey !== saved?.row.identityKey && r.identityKey !== dropKey)
  if (saved) rows.splice(Math.min(saved.index, rows.length), 0, saved.row)
  await ctx.storage.replaceSpeakerNameSuggestions(noteId, rows)
}

// ---------- the cluster's span, for pending requests ----------

/** The cluster holding most of the span's word time on its channel in the note's current pass (the job's rule). */
function identityForSpan(chunks: readonly TranscriptChunk[], span: PendingSpan): string | null {
  const pass = currentPassId(chunks)
  return pass ? clusterForSpan(chunks, pass, span) : null
}

/** Pending requests of the note whose span resolves to this cluster now. */
async function pendingFor(ctx: MainContext, noteId: string, chunks: readonly TranscriptChunk[], identityKey: string, personId?: string): Promise<string[]> {
  const rows = await ctx.storage.listSpeakerPending({ noteId, ...(personId ? { personId } : {}) })
  return rows.filter((p) => identityForSpan(chunks, p) === identityKey).map((p) => p.id)
}

/** The cluster's stored vector of the installed model, if any. */
async function clusterVector(ctx: MainContext, noteId: string, passId: string | null, identity: SpeakerIdentity): Promise<{ cleanMs: number; vector: Float32Array; modelId: string } | null> {
  const label = clusterLabel(identity.key)
  if (!passId || !label) return null
  const modelId = speakerIdModelId()
  const rows = await ctx.storage.listSpeakerClusterVectors({ noteId, passId, modelId })
  const v = rows.find((r) => r.label === label && r.source === identity.channel)
  return v ? { cleanMs: v.cleanMs, vector: v.vector, modelId } : null
}

// ---------- supersession ----------

/** The open deferred namings and Skips per cluster, by sequence number. */
const openByCluster = new Map<string, Set<number>>()
let seq = 0

/**
 * Registers a deferred naming or Skip of a cluster. `superseded()` is true while a newer one of
 * the same cluster is still open: its words win, so this one's sample and vector deletion give
 * way. `release()` ends this one (applied or undone).
 */
function claim(noteId: string, identityKey: string): { superseded(): boolean; release(): void } {
  const key = `${noteId}|${identityKey}`
  const mine = ++seq
  const set = openByCluster.get(key) ?? new Set<number>()
  set.add(mine)
  openByCluster.set(key, set)
  return {
    superseded: () => [...(openByCluster.get(key) ?? [])].some((n) => n > mine),
    release: () => {
      const s = openByCluster.get(key)
      s?.delete(mine)
      if (s && !s.size) openByCluster.delete(key)
    }
  }
}

// ---------- the vector kept for the consent sheet ----------

/** How long a named cluster's vector waits for the consent sheet after Remember voice without a record. */
const AGREEMENT_HOLD_MS = 30 * 60_000
/** The newest hold per cluster. */
const holds = new Map<string, number>()
let holdSeq = 0

/**
 * Remember voice for a person with no record keeps the named cluster's vector for the naming
 * the sheet sends once it records. A cancelled sheet sends the naming again with Remember voice
 * off, which deletes it. This hold is the backstop for a sheet that never answers: when it
 * ends, or at quit, the vector goes unless a newer hold or an open naming of the cluster decides it.
 */
function holdForAgreement(ctx: MainContext, noteId: string, passId: string, identityKey: string, label: string): void {
  const key = `${noteId}|${identityKey}`
  const mine = ++holdSeq
  holds.set(key, mine)
  deferUndoable(
    {
      apply: async () => {
        if (holds.get(key) !== mine) return
        holds.delete(key)
        if (openByCluster.has(key)) return
        const n = await ctx.storage.deleteSpeakerClusterVectors({ noteId, passId, labels: [label] })
        log('info', 'speakers:agreement-hold-ended', { noteId, deleted: n })
      },
      revert: () => Promise.resolve()
    },
    AGREEMENT_HOLD_MS
  )
}

// ---------- accept ----------

export interface AcceptOptions {
  /** `agreement` for the pending offer; otherwise from the request. */
  via?: SpeakerSampleVia
  /** Pending requests this naming ends. */
  pendingIds?: string[]
}

/** Who the request names: a person (found or created), or nobody (a free-text name). */
async function personFor(ctx: MainContext, req: SpeakerNameAccept, name: string): Promise<SpeakerPersonRow | null> {
  if (req.self) return ctx.storage.ensureSelfPerson((await ctx.settings.get('profile.name')).trim() || null)
  if (req.personId) return personOf(ctx, req.personId)
  if (req.email) {
    const email = req.email.trim().toLowerCase()
    const found = await ctx.storage.findSpeakerPersonByEmail(email)
    if (found) return found
    try {
      return await ctx.storage.createSpeakerPerson({ displayName: name, email })
    } catch (err) {
      const again = await ctx.storage.findSpeakerPersonByEmail(email)
      if (again) return again
      throw err
    }
  }
  if (req.newName) return ctx.storage.createSpeakerPerson({ displayName: req.newName.trim(), email: null })
  return null
}

export async function acceptName(ctx: MainContext, req: SpeakerNameAccept, opts: AcceptOptions = {}): Promise<SpeakerNameAcceptResult> {
  const name = req.name.trim()
  const t = await target(ctx, req.noteId, req.identityKey, req.passId)
  const person = await personFor(ctx, req, name)
  const pid = person?.id ?? null
  const turn = req.scope === 'turn' ? new Set(req.turnChunkIds ?? []) : null
  const held: Held = { row: null }
  const changes = await writeWords(
    ctx,
    req.noteId,
    'naming',
    t.passId,
    (_w, key, chunk) => (key === req.identityKey && (!turn || turn.has(chunk.id)) ? { confirmed_spk: name, confirmed_pid: pid } : null),
    turn
      ? undefined
      : async () => {
          held.row = await takeRow(ctx, req.noteId, req.identityKey)
        }
  )
  const chunksNamed = new Set(changes.map((c) => c.chunkId)).size
  pushChanged(ctx, req.noteId)

  const agreed = person ? person.isSelf || (await hasActiveAgreement(ctx, person.id)) : false
  const needsAgreement = !!person && !person.isSelf && req.remember && !turn && !agreed
  log('info', 'speaker-name-suggestion-accepted', {
    noteId: req.noteId,
    chunks: chunksNamed,
    scope: req.scope,
    person: person ? (person.isSelf ? 'self' : 'person') : 'none',
    remember: req.remember,
    needsAgreement,
    edited: req.edited === true,
    chosenFromList: req.chosenFromList === true
  })
  if (!changes.length && !held.row && !person && !opts.pendingIds?.length) return { chunksNamed: 0, undoToken: null, needsAgreement }

  const slot = turn ? null : claim(req.noteId, req.identityKey)
  const undoToken = deferUndoable({
    apply: async () => {
      const superseded = slot?.superseded() ?? false
      slot?.release()
      await afterNaming(ctx, {
        noteId: req.noteId,
        identity: t.identity,
        passId: t.passId,
        person,
        // Condition 4, and condition 3 as it stood when the user named (re-checked at apply).
        learn: !turn && req.remember && agreed,
        via: opts.via ?? (req.edited ? 'rename' : 'confirm'),
        clusterEffects: !turn && !superseded,
        // The consent sheet may still follow: the vector stays for the naming that records it.
        keepVector: needsAgreement,
        pendingIds: opts.pendingIds ?? []
      })
    },
    revert: async () => {
      slot?.release()
      await revertWords(ctx, req.noteId, changes, held.row ? () => restoreRow(ctx, req.noteId, held.row) : undefined)
      pushChanged(ctx, req.noteId)
      log('info', 'speaker-names:naming-undone', { noteId: req.noteId, chunks: chunksNamed })
    }
  })
  return { chunksNamed, undoToken, needsAgreement }
}

interface AfterNaming {
  noteId: string
  identity: SpeakerIdentity
  passId: string | null
  person: SpeakerPersonRow | null
  learn: boolean
  via: SpeakerSampleVia
  /** The whole speaker was named, and no newer naming of it is open: the sample, the vector and the requests. */
  clusterEffects: boolean
  keepVector: boolean
  pendingIds: string[]
}

/** The deferred effects of a naming, when its Undo window closes or at quit. */
async function afterNaming(ctx: MainContext, a: AfterNaming): Promise<void> {
  let added = false
  if (a.clusterEffects) {
    added = a.person ? await learn(ctx, a) : false
    // On confirm the cluster vector goes, folded or not, and naming ends the cluster's requests.
    const label = clusterLabel(a.identity.key)
    if (a.passId && label && !a.keepVector) await ctx.storage.deleteSpeakerClusterVectors({ noteId: a.noteId, passId: a.passId, labels: [label] })
    else if (a.passId && label) holdForAgreement(ctx, a.noteId, a.passId, a.identity.key, label)
    const chunks = await chunksOf(ctx, a.noteId)
    const ended = [...new Set([...a.pendingIds, ...(await pendingFor(ctx, a.noteId, chunks, a.identity.key))])]
    if (ended.length) await ctx.storage.deleteSpeakerPending(ended)
  }
  if (a.person) {
    // The meetings where the person was named.
    await ctx.storage.recordSpeakerMatches([{ noteId: a.noteId, personId: a.person.id, kind: 'confirmed' }])
    // A confirmation is a match only on a channel where the person has exemplars.
    if (a.clusterEffects) {
      const channel = channelOf(a.identity)
      const spaces = await ctx.storage.speakerVoiceGallery({ modelId: speakerIdModelId(), personIds: [a.person.id] })
      if (spaces.some((s) => s.channel === channel && s.count > 0)) {
        await ctx.storage.updateSpeakerPerson(a.person.id, { lastMatchedAt: new Date().toISOString() })
      }
    }
    pushSpeakerPeopleChanged(ctx, a.person.id)
  }
  if (added && a.person) void requestRelabel(ctx, a.person.id).catch((err: unknown) => log('warn', 'speakers:relabel-failed', { err }))
}

/** The seven conditions, then the repo's guard, far-from-profile check and cap. True when a sample was added. */
async function learn(ctx: MainContext, a: AfterNaming): Promise<boolean> {
  const person = a.person as SpeakerPersonRow
  const skip = (code: string): false => {
    log('info', 'speakers:learn-skipped', { code })
    return false
  }
  if (!a.learn) return skip(person.isSelf ? 'remember-off' : 'remember-off-or-no-agreement')
  const settings = await ctx.settings.getAll()
  if (!settings['speakers.voices']) return skip('voices-off')
  if (person.isSelf && !settings['speakers.selfVoice']) return skip('self-voice-off')
  const channel = channelOf(a.identity)
  if (person.isSelf && channel !== 'mic') return skip('self-not-mic')
  // The agreement may have been withdrawn inside the window.
  if (!person.isSelf && !(await hasActiveAgreement(ctx, person.id))) return skip('no-agreement')
  // The words must still name this person: a later rename or Undo wins.
  const now = speakerIdentities(await chunksOf(ctx, a.noteId), { live: false }).identities.find((i) => i.key === a.identity.key)
  if (!now || now.state !== 'confirmed' || now.personId !== person.id) return skip('renamed')
  const vec = await clusterVector(ctx, a.noteId, a.passId, a.identity)
  if (!vec) return skip('no-vector')
  const calibration = getCalibration(ctx).file
  if (!calibration) return skip('no-calibration')
  const weight = Math.min(1, vec.cleanMs / SPEAKER_PROFILE_LIMITS.exemplarWeightFullMs)
  if (!(weight > 0)) return skip('no-clean-speech')
  const r = await ctx.storage.addSpeakerExemplar({
    personId: person.id,
    modelId: vec.modelId,
    channel,
    vector: vec.vector,
    cleanMs: vec.cleanMs,
    weight,
    sourceNoteId: a.noteId,
    sourcePassId: a.passId,
    sourceLabel: clusterLabel(a.identity.key),
    spanStartMs: Math.round(a.identity.startMs),
    spanEndMs: Math.round(a.identity.endMs),
    via: a.via,
    farCosine: calibration.farCosine[channel]
  })
  log('info', 'speakers:learned', { status: r.status, via: a.via, channel })
  return r.status === 'added'
}

// ---------- Skip, Not <name>, Ask first, the pending offer ----------

/** Skip (the who's-who sheet only): the row goes now, the cluster vector when the window closes. */
export async function skipSpeaker(ctx: MainContext, noteId: string, identityKey: string): Promise<{ undoToken: string | null }> {
  const t = await target(ctx, noteId, identityKey)
  const held: Held = { row: null }
  await writeWords(ctx, noteId, 'naming', t.passId, () => null, async () => {
    held.row = await takeRow(ctx, noteId, identityKey)
  })
  pushChanged(ctx, noteId)
  log('info', 'speaker-name-suggestion-rejected', { noteId })
  const slot = claim(noteId, identityKey)
  const undoToken = deferUndoable({
    apply: async () => {
      const superseded = slot.superseded()
      slot.release()
      if (superseded) return
      // On reject the vector goes; a request on it can never fire.
      const label = clusterLabel(identityKey)
      if (t.passId && label) await ctx.storage.deleteSpeakerClusterVectors({ noteId, passId: t.passId, labels: [label] })
      const ended = await pendingFor(ctx, noteId, await chunksOf(ctx, noteId), identityKey)
      if (ended.length) await ctx.storage.deleteSpeakerPending(ended)
      log('info', 'speakers:skip-applied', { noteId, pending: ended.length })
    },
    revert: async () => {
      slot.release()
      await labelQueue(ctx).enqueue(noteId, { kind: 'undo', patch: () => [], commit: () => restoreRow(ctx, noteId, held.row) })
      pushChanged(ctx, noteId)
    }
  })
  return { undoToken }
}

/**
 * Not <name>, also the card's ×: a negative for that pairing; the machine name or the
 * suggestion clears and the cluster stays open. No vector is touched.
 */
export async function notPerson(ctx: MainContext, noteId: string, identityKey: string, personId: string): Promise<{ undoToken: string | null }> {
  const t = await target(ctx, noteId, identityKey)
  const person = await personOf(ctx, personId)
  const isThem = (pid: string | undefined, name: string | undefined): boolean =>
    pid ? pid === person.id || pid === personId : !!name && sameSpeakerName(name, person.displayName)
  const held: Held & { added: boolean } = { row: null, added: false }
  const changes = await writeWords(
    ctx,
    noteId,
    'naming',
    t.passId,
    (w, key) => (key === identityKey && w.auto_spk !== undefined && isThem(w.auto_pid, w.auto_spk) ? { auto_spk: null, auto_pid: null, auto_src: null } : null),
    async () => {
      await ctx.storage.addSpeakerNegative({ noteId, passId: t.passId ?? NO_PASS, identityKey, personId: person.id })
      const rows = await ctx.storage.listSpeakerNameSuggestions(noteId)
      const index = rows.findIndex((r) => r.identityKey === identityKey)
      if (index >= 0) {
        const { created_at: _c, ...row } = rows[index] as SpeakerNameSuggestion
        held.row = { row, index }
        const candidates = row.candidates.filter((c) => !isThem(c.personId, c.name))
        const name = row.name && !isThem(undefined, row.name) ? row.name : (candidates[0]?.name ?? null)
        const band = candidates.length >= 2 && row.band === 'tie' ? 'tie' : candidates.length || name ? 'suggest' : 'none'
        await restoreRow(ctx, noteId, { row: { ...row, name, candidates, band }, index })
      } else if (t.identity.state === 'auto') {
        // A cleared auto name leaves an unnamed speaker, which gets its row.
        held.added = true
        await restoreRow(ctx, noteId, {
          row: {
            identityKey,
            label: t.identity.letterLabel ?? identityKey,
            name: null,
            evidenceTypes: [],
            channel: t.identity.channel,
            labelStream: t.identity.labelStream,
            transcriptExcerpts: [],
            position: rows.length,
            band: 'none',
            candidates: [],
            passId: t.passId,
            pending: false
          },
          index: rows.length
        })
      }
    }
  )
  pushChanged(ctx, noteId)
  log('info', 'speakers:not-person', { noteId, cleared: changes.length })
  const undoToken = deferUndoable({
    // Not <name> alone is no reject: nothing waits for the window.
    apply: () => Promise.resolve(),
    revert: async () => {
      await revertWords(ctx, noteId, changes, async () => {
        await ctx.storage.deleteSpeakerNegative({ noteId, identityKey, personId: person.id })
        if (held.row) await restoreRow(ctx, noteId, held.row)
        else if (held.added) await restoreRow(ctx, noteId, null, identityKey)
      })
      pushChanged(ctx, noteId)
    }
  })
  return { undoToken }
}

/**
 * Ask <name> first: a pending request on the person with the cluster's longest turn and
 * channel; the speaker stays unnamed and its vector stays unlinked. Only for a cluster with a
 * stored vector. Asking again for the same cluster adds no row.
 */
export async function askFirst(ctx: MainContext, noteId: string, identityKey: string, personId: string): Promise<{ ok: boolean }> {
  const t = await target(ctx, noteId, identityKey)
  const person = await personOf(ctx, personId)
  if (person.isSelf) fail('invalid-input', "The user's own voice needs no agreement.")
  if (t.identity.state === 'confirmed') fail('invalid-input', 'This speaker is already named.')
  if (!(await clusterVector(ctx, noteId, t.passId, t.identity))) fail('invalid-input', 'Notula has no voice sample of this speaker to keep.')
  // The span must pick this cluster back, or the offer would name another speaker (one who isn't the meeting's majority).
  const span = t.passId ? pendingSpanOf(t.chunks, t.passId, identityKey) : null
  if (!span) fail('invalid-input', "Notula can't tell this speaker's voice apart well enough to ask first.")
  if (!(await pendingFor(ctx, noteId, t.chunks, identityKey, person.id)).length) await ctx.storage.addSpeakerPending({ personId: person.id, noteId, ...span })
  await labelQueue(ctx).enqueue(noteId, {
    kind: 'naming',
    patch: () => [],
    commit: () => ctx.storage.patchSpeakerNameSuggestion(noteId, identityKey, { pending: true })
  })
  pushChanged(ctx, noteId)
  pushSpeakerPeopleChanged(ctx, person.id)
  log('info', 'speakers:ask-first', { noteId })
  return { ok: true }
}

/**
 * The "Name <name> in <meeting>" offer: re-resolves the person's requests in the
 * note to the current cluster by span and channel, then names it with Remember voice on, so its
 * vector becomes the first sample `via agreement`. The span decides: a renderer `identityKey`
 * the span doesn't pick, or a cluster on another channel than the request's, is `stale`.
 * A cluster named since, by the user or automatically, refuses the offer (`stale` for auto).
 * The naming ends the requests it answers and any that resolve to no cluster any more.
 */
export async function namePending(ctx: MainContext, noteId: string, identityKey: string | null, personId: string): Promise<{ chunksNamed: number; undoToken: string | null }> {
  if (SPEAKER_JOB_BUSY.includes(jobState(noteId))) fail('busy', 'Notula is still naming the speakers of this note.')
  const person = await personOf(ctx, personId)
  if (!(await hasActiveAgreement(ctx, person.id))) fail('invalid-input', `Record the agreement first.`)
  const requests = await ctx.storage.listSpeakerPending({ personId: person.id, noteId })
  if (!requests.length) fail('not-found', 'There is no request waiting in this meeting.')
  const chunks = await chunksOf(ctx, noteId)
  const resolved = requests.map((p) => ({ p, key: identityForSpan(chunks, p) }))
  const pick = identityKey ? resolved.find((r) => r.key === identityKey) : resolved.find((r) => r.key)
  if (!pick?.key) fail('stale', 'The speakers of this note changed.')
  const key = pick.key
  // The offer stands only while that cluster is unnamed and still has its vector.
  const now = speakerIdentities(chunks, { live: false }).identities.find((i) => i.key === key)
  if (!now) fail('stale', 'The speakers of this note changed.')
  if (pick.p.source && now.channel !== pick.p.source) fail('stale', 'The speakers of this note changed.')
  if (now.state === 'confirmed') fail('invalid-input', 'This speaker is already named.')
  // Named automatically since the request (another person's tile, say): no longer "still unnamed".
  if (now.state === 'auto') fail('stale', 'This speaker was named since you asked.')
  const passId = currentPassId(chunks)
  if (!(await clusterVector(ctx, noteId, passId, now))) fail('invalid-input', 'Notula no longer has the voice sample of this speaker.')
  const r = await acceptName(
    ctx,
    { noteId, identityKey: key, name: person.displayName, edited: false, chosenFromList: true, personId: person.id, remember: true, scope: 'speaker', passId },
    { via: 'agreement', pendingIds: resolved.filter((r) => r.key === key || !r.key).map((r) => r.p.id) }
  )
  return { chunksNamed: r.chunksNamed, undoToken: r.undoToken }
}

// ---------- request validation ----------

function str(v: unknown, what: string, max: number): string {
  if (typeof v !== 'string' || !v.trim() || v.length > max) fail('invalid-input', `${what} is required.`)
  return v
}

/** The accept payload, checked: one way of naming at most, a scope, and Only this turn's chunks. */
export function acceptRequest(raw: unknown): SpeakerNameAccept {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const noteId = str(r['noteId'], 'noteId', 200)
  const identityKey = str(r['identityKey'], 'identityKey', 400)
  const name = str(r['name'], 'A speaker name', 200).trim()
  const personId = r['personId'] === undefined || r['personId'] === null ? undefined : str(r['personId'], 'personId', 200)
  const email = r['email'] === undefined || r['email'] === null ? undefined : str(r['email'], 'email', 320)
  const newName = r['newName'] === undefined || r['newName'] === null ? undefined : str(r['newName'], 'newName', 200)
  const self = r['self'] === true
  if ([personId, email, newName, self ? true : undefined].filter((x) => x !== undefined).length > 1) {
    fail('invalid-input', 'Name the speaker one way: a person, an email, a new name or Me.')
  }
  if (email !== undefined && !/^[^\s@]+@[^\s@]+$/.test(email.trim())) fail('invalid-input', 'email is not an email address.')
  const scope = r['scope'] === 'turn' ? 'turn' : r['scope'] === 'speaker' || r['scope'] === undefined ? 'speaker' : fail('invalid-input', 'scope must be speaker or turn.')
  let turnChunkIds: string[] | undefined
  if (scope === 'turn') {
    const ids = r['turnChunkIds']
    if (!Array.isArray(ids) || !ids.length || ids.length > MAX_TURN_CHUNKS || !ids.every((x) => typeof x === 'string' && x && x.length <= 200)) {
      fail('invalid-input', 'Only this turn needs the turn.')
    }
    turnChunkIds = ids as string[]
  }
  const passId = r['passId'] === null || r['passId'] === undefined ? null : str(r['passId'], 'passId', 200)
  return {
    noteId,
    identityKey,
    name,
    edited: r['edited'] === true,
    chosenFromList: r['chosenFromList'] === true,
    ...(personId ? { personId } : {}),
    ...(email ? { email } : {}),
    ...(newName ? { newName } : {}),
    ...(self ? { self } : {}),
    remember: r['remember'] === true,
    scope,
    ...(turnChunkIds ? { turnChunkIds } : {}),
    passId
  }
}
