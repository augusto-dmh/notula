// SPDX-License-Identifier: Apache-2.0
// The post-meeting job: one per note, after the note's diarization pass at stop and after a
// local import with Separate speakers on. It computes outside the note's label-write queue
// (diarize and embed, evidence, the LLM step, `decide`) and queues only its writes. A note
// without a pass has no job.
//
// Steps:
//   1. the pass (`asr/diarize.ts`), with the embed mode picked here: `all` with Recognize
//      voices on, `mic` with only Recognize my voice (those vectors stay in this job's memory
//      and are zeroed when it ends), else `none`. Its `merged_spk` patch is one queued write;
//      on a re-pass that same write strips every word's `auto_*` and the chunks' `named_pass`,
//      and its commit deletes the older passes' cluster vectors and suggestion rows and
//      re-maps negatives (by word overlap) and pending requests (by time span);
//   2. evidence and candidates (`candidates.ts`);
//   3. the LLM step (`suggestForJob`, 60 s, no `awaitSpeakerLabels`: waiting on itself would
//      deadlock);
//   4. `decide`;
//   5. one queued write: `auto_*` on the words of auto clusters and `named_pass` on the
//      pass's chunks; its commit writes the suggestion rows, the cluster vectors (only while
//      Recognize voices is on, unconfirmed clusters only), the match rows and
//      `last_matched_at` for voice evidence at suggest or above. Then `selfPassive`;
//   6. pushes (`transcript:changed` comes with the chunk write, then `speaker-names:changed`).
//
// Staleness: the write carries the pass id and the voice generation it read.
// A stale pass drops it; a stale generation recomputes once from step 2 with the same LLM
// reply, and a second stale result is dropped and logged as a code. A cluster that became
// confirmed after the compute is left untouched. Resume abandons the job with no write.
//
// Known gap: an exemplar added between this job's compute and its write
// isn't used here; the next naming or relabel catches it.
//
// No vector or score reaches a log or a push.

import { app, ipcMain } from 'electron'
import { notulaError } from '@shared/errors'
import type { InvokeChannel, InvokeReq, PushChannel } from '@shared/ipc'
import { speakerIdentities, wordIdentityKeys } from '@shared/lib/speakers'
import type { AudioSource } from '@shared/types/common'
import type { SpeakerAutoSource, SpeakerBand, SpeakerJobState, SpeakerJobStatus, SpeakerMatchKind } from '@shared/types/speakers'
import { SPEAKER_JOB_BUSY, SPEAKER_PROFILE_LIMITS } from '@shared/types/speakers'
import {
  SPEAKER_LABEL_THEM,
  SPEAKER_UNATTRIBUTED,
  type SpeakerEvidenceType,
  type SpeakerNameSuggestion,
  type TranscriptChunk
} from '@shared/types/transcript'
import { SPEAKER_LABELS_WAIT_MS, type DiarizeEmbedPlan, type DiarizePass } from '../asr/diarize'
import type { MainContext } from '../context'
import { log } from '../log'
import type { SpeakerClusterVectorRow } from '../storage/api'
import { getTranscriptionManager } from '../transcription/manager'
import { selfPassive } from '../voiceprint'
import { getCalibration } from './calibration'
import {
  decideCluster,
  noteCandidates,
  noteLanguage,
  passClusters,
  pendingByCluster,
  tileKinds,
  type NoteCandidates,
  type PassClusterStats
} from './candidates'
import { decide, type ClusterDecision, type DecideCluster, type DecideLlmMapping, type DecideVoiceSpace } from './decide'
import { foldName } from './decide/evidence'
import { labelQueue, currentPassId, type ChunkFieldPatch, type LabelWrite, type LabelWordFields } from './label-queue'
import { suggestForJob } from './names'
import { clusterForSpan } from './pending-span'
import { voiceGeneration } from './voice-gen'

/** A guard over `suggestForJob`'s own 60 s timeout. */
const LLM_GUARD_MS = SPEAKER_PROFILE_LIMITS.llmTimeoutMs + 5_000
const PLACEHOLDER = /^Speaker( [A-Z]+| \d+)?$/

interface JobRun {
  noteId: string
  state: SpeakerJobState
  reason?: string
  abandoned: boolean
  /** Holds the `speaker-id` model while the job runs. */
  release: (() => void) | null
  modelId: string | null
  /**
   * The pass embedded in mode `all` (Recognize voices on at the plan). With mode `mic` the
   * vectors live only in this job's memory, even if Recognize voices is turned on meanwhile.
   */
  storeVectors: boolean
}

/** The latest run per note (what `speakers:job-state` answers). */
const runs = new Map<string, JobRun>()
/** The run inside the note's pass right now (passes are serial per note). */
const active = new Map<string, JobRun>()
let jobCtx: MainContext | null = null

function push(ctx: MainContext, status: SpeakerJobStatus): void {
  for (const wc of ctx.windows.targets()) wc.send('speakers:job-changed' satisfies PushChannel, status)
}

function status(noteId: string): SpeakerJobStatus {
  const r = runs.get(noteId)
  if (!r) return { noteId, state: 'idle' }
  return r.state === 'failed' && r.reason ? { noteId, state: r.state, reason: r.reason } : { noteId, state: r.state }
}

function setState(ctx: MainContext, run: JobRun, state: SpeakerJobState, reason?: string): void {
  // A run that ended keeps its end state; abandoned ones end silently.
  if (!SPEAKER_JOB_BUSY.includes(run.state) && run.state !== 'idle') return
  run.state = state
  if (state === 'failed') run.reason = reason ?? 'unknown'
  log('info', 'speakers:job-state', { noteId: run.noteId, state, ...(state === 'failed' ? { reason: run.reason } : {}) })
  if (runs.get(run.noteId) === run) push(ctx, status(run.noteId))
}

function newRun(ctx: MainContext, noteId: string): JobRun {
  const run: JobRun = { noteId, state: 'idle', abandoned: false, release: null, modelId: null, storeVectors: false }
  runs.set(noteId, run)
  setState(ctx, run, 'queued')
  return run
}

export function capturing(ctx: MainContext, noteId: string): boolean {
  return ctx.capture.isCapturing() && ctx.capture.currentNoteId() === noteId
}

/** The note's job is queued, diarizing or deciding: its pills and the sheet stay closed. */
export function jobBusy(noteId: string): boolean {
  return SPEAKER_JOB_BUSY.includes(jobState(noteId))
}

function bounded<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | null = null
  return Promise.race([
    p,
    new Promise<T>((resolve) => {
      timer = setTimeout(() => resolve(fallback), ms)
    })
  ]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

/** Machine names are real names: never a letter, a number or a placeholder. */
function writableName(name: string | null): name is string {
  const n = name?.trim() ?? ''
  return !!n && !PLACEHOLDER.test(n) && n !== SPEAKER_LABEL_THEM && n !== SPEAKER_UNATTRIBUTED
}

/** Wires the job to the pass, resume and the pushes (`speakers:job-state`, `speakers:job-changed`). */
export function registerSpeakerJob(ctx: MainContext): void {
  jobCtx = ctx
  const manager = getTranscriptionManager(ctx)
  manager.diarizer.setJob({
    queued: (noteId) => {
      newRun(ctx, noteId)
    },
    plan: (noteId) => plan(ctx, noteId),
    run: (noteId, pass, reason) => runJob(ctx, noteId, pass, reason)
  })
  // Resume during the job abandons it with no write; the next stop runs it again.
  // Its worker stops too, so it doesn't diarize next to the live transcription.
  ctx.bus.on('capture:started', ({ noteId }) => {
    let abandoned = false
    for (const run of [runs.get(noteId), active.get(noteId)]) {
      if (!run || run.abandoned || !SPEAKER_JOB_BUSY.includes(run.state)) continue
      run.abandoned = true
      abandoned = true
      setState(ctx, run, 'abandoned')
    }
    if (abandoned) manager.diarizer.cancel(noteId)
  })
  ipcMain.handle('speakers:job-state' satisfies InvokeChannel, (_e, req: InvokeReq<'speakers:job-state'>): SpeakerJobStatus => {
    const noteId = typeof req?.noteId === 'string' ? req.noteId : ''
    if (!noteId) throw notulaError('invalid-input', 'noteId is required.')
    return status(noteId)
  })
}

/** The note's job state; `idle` when no job runs or ran. */
export function jobState(noteId: string): SpeakerJobState {
  return runs.get(noteId)?.state ?? 'idle'
}

/** Why a run ends with no pass: the note has no pass, so the no-pass LLM step runs. */
const PASS_FAILURES: readonly string[] = ['pass-failed', 'pass-error', 'model-missing']

/** No job, or a pass that produced nothing: the note takes the no-pass path. */
function noPass(noteId: string): boolean {
  const r = runs.get(noteId)
  return !r || r.state === 'idle' || (r.state === 'failed' && PASS_FAILURES.includes(r.reason ?? ''))
}

/**
 * Trigger 2, for a note whose job never wrote its current pass: while its temp audio
 * exists, runs the pass and the job again and resolves `ran` when the job ended. Resolves
 * `no-audio` (the caller takes the no-pass path) without audio, after a pass
 * that failed (it isn't re-run), and when the pass ran but produced nothing.
 */
export async function ensureJob(noteId: string): Promise<'ran' | 'no-audio'> {
  const ctx = jobCtx
  if (!ctx) return 'no-audio'
  const manager = getTranscriptionManager(ctx)
  if (jobBusy(noteId)) {
    await bounded(manager.diarizer.awaitPass(noteId), SPEAKER_LABELS_WAIT_MS, undefined)
    return !jobBusy(noteId) && noPass(noteId) ? 'no-audio' : 'ran'
  }
  const chunks = await manager.getTranscript(noteId)
  const passId = currentPassId(chunks)
  if (passId && chunks.some((c) => c.providerDetails?.mergeScopeId === passId && c.providerDetails.named_pass === passId)) return 'ran'
  if (runs.has(noteId) && noPass(noteId)) return 'no-audio'
  if (capturing(ctx, noteId) || !manager.diarizer.willRunPass(noteId)) return 'no-audio'
  manager.diarizer.noteStopped(noteId)
  await bounded(manager.diarizer.awaitPass(noteId), SPEAKER_LABELS_WAIT_MS, undefined)
  return !jobBusy(noteId) && noPass(noteId) ? 'no-audio' : 'ran'
}

// ---------- step 1: the pass ----------

async function plan(ctx: MainContext, noteId: string): Promise<DiarizeEmbedPlan> {
  const queued = runs.get(noteId)
  const run = queued && queued.state === 'queued' && !queued.abandoned ? queued : newRun(ctx, noteId)
  active.set(noteId, run)
  if (capturing(ctx, noteId)) run.abandoned = true
  setState(ctx, run, 'diarizing')
  const [voices, selfVoice] = await Promise.all([ctx.settings.get('speakers.voices'), ctx.settings.get('speakers.selfVoice')])
  const mode = voices ? 'all' : selfVoice ? 'mic' : 'none'
  const model = mode === 'none' ? null : getTranscriptionManager(ctx).models.speakerId()
  if (!model) return { mode: 'none', identification: null }
  run.release = getTranscriptionManager(ctx).models.use('speaker-id')
  run.modelId = model.modelId
  run.storeVectors = mode === 'all'
  return { mode, identification: model.file }
}

async function runJob(ctx: MainContext, noteId: string, pass: DiarizePass | null, reason?: string): Promise<void> {
  const queued = runs.get(noteId)
  const known = active.get(noteId) ?? (queued?.state === 'queued' ? queued : undefined)
  // No pass and no job queued for it: there never was a job.
  if (!known && !pass) return
  const run = known ?? newRun(ctx, noteId)
  try {
    if (!pass) {
      setState(ctx, run, 'failed', reason ?? 'pass-failed')
      return
    }
    if (run.abandoned) return
    const first = await labelQueue(ctx).enqueue(noteId, passWrite(ctx, run, pass))
    if (first.status !== 'written') {
      if (!run.abandoned) setState(ctx, run, 'failed', 'pass-write-dropped')
      return
    }
    setState(ctx, run, 'deciding')
    await decideAndWrite(ctx, run, pass)
  } catch (err) {
    log('warn', 'speakers:job-failed', { noteId, err })
    setState(ctx, run, 'failed', 'error')
  } finally {
    if (run.abandoned) setState(ctx, run, 'abandoned')
    else if (SPEAKER_JOB_BUSY.includes(run.state)) setState(ctx, run, 'failed', 'unfinished')
    if (active.get(noteId) === run) active.delete(noteId)
    run.release?.()
    run.release = null
    // The vectors live only in the job's memory (and the 14-day store when it saved them).
    for (const c of pass?.clusters.values() ?? []) c.vector?.fill(0)
  }
}

function hasPassFields(w: { merged_spk?: string; auto_spk?: string; auto_pid?: string; auto_src?: string }): boolean {
  return w.merged_spk !== undefined || w.auto_spk !== undefined || w.auto_pid !== undefined || w.auto_src !== undefined
}

/**
 * The pass's own write (item 2.1): `merged_spk` and `mergeScopeId` on the chunks it covers.
 * On a re-pass the same patch strips every word's `auto_*`, the old `merged_spk` and the
 * chunks' `named_pass`; `confirmed_*` and `att` are never touched.
 */
function passWrite(ctx: MainContext, run: JobRun, pass: DiarizePass): LabelWrite {
  const noteId = run.noteId
  // Old identity key → new key → shared word time: the re-map of negatives.
  const successors = new Map<string, Map<string, number>>()
  return {
    kind: 'diarization',
    passId: pass.passId,
    patch: (chunks) => {
      if (run.abandoned || capturing(ctx, noteId)) return null
      successors.clear()
      const before = wordIdentityKeys(chunks.filter((c) => c.is_final))
      const patches: ChunkFieldPatch[] = []
      for (const c of chunks) {
        const d = c.providerDetails
        if (!c.is_final || !d) continue
        const covered = pass.covers(c)
        const older = d.mergeScopeId !== undefined || d.named_pass !== undefined || d.words.some(hasPassFields)
        if (!covered && !older) continue
        const keys = before.get(c.id)
        const words = d.words.map((w, index) => {
          const label = covered ? pass.labelOf(c, index) : null
          const old = keys?.[index]
          if (label && old) {
            const to = `r:${pass.passId}:${label}`
            const m = successors.get(old) ?? new Map<string, number>()
            m.set(to, (m.get(to) ?? 0) + Math.max(1, w.e_ms - w.s_ms))
            successors.set(old, m)
          }
          const set: LabelWordFields = { merged_spk: label, auto_spk: null, auto_pid: null, auto_src: null }
          return { index, set }
        })
        patches.push({
          chunkId: c.id,
          words,
          details: covered ? { mergeScopeId: pass.passId, named_pass: null } : { mergeScopeId: null, named_pass: null }
        })
      }
      return patches
    },
    commit: () => repassCleanup(ctx, noteId, pass.passId, successors)
  }
}

/** Item 7: the older passes' cluster vectors and suggestion rows go; negatives and pending requests follow their clusters. */
async function repassCleanup(ctx: MainContext, noteId: string, passId: string, successors: Map<string, Map<string, number>>): Promise<void> {
  const s = ctx.storage
  const vectors = await s.listSpeakerClusterVectors({ noteId })
  const oldPasses = [...new Set(vectors.map((v) => v.passId))].filter((p) => p !== passId)
  for (const v of vectors) v.vector.fill(0)
  for (const p of oldPasses) await s.deleteSpeakerClusterVectors({ noteId, passId: p })
  const rows = (await s.listSpeakerNameSuggestions(noteId)).filter((r) => r.passId !== passId)
  for (const r of rows) await s.deleteSpeakerNameSuggestion(noteId, r.identityKey)
  // Each old cluster maps to the new cluster holding most of its words, else it is dropped.
  const negatives = (await s.listSpeakerNegatives(noteId)).filter((n) => n.passId !== passId)
  const map = [...new Set(negatives.map((n) => n.identityKey))].map((from) => {
    const best = [...(successors.get(from) ?? [])].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]
    return { from, to: best ? best[0] : null }
  })
  if (map.length) await s.remapSpeakerNegatives({ noteId, passId, map })
  // Pending requests hold a time span (epoch ms of the cluster's longest turn) and its channel:
  // one whose span holds no speech of the new pass on that channel has no successor and is
  // dropped.
  const pending = await s.listSpeakerPending({ noteId })
  let dropped = 0
  if (pending.length) {
    const chunks = await getTranscriptionManager(ctx).getTranscript(noteId)
    const gone = pending.filter((p) => clusterForSpan(chunks, passId, p) === null).map((p) => p.id)
    if (gone.length) dropped = await s.deleteSpeakerPending(gone)
  }
  if (oldPasses.length || rows.length || map.length || dropped) {
    log('info', 'speakers:repass', { noteId, passes: oldPasses.length, rows: rows.length, negatives: map.length, pendingDropped: dropped })
  }
}

// ---------- steps 2–4: evidence, the LLM step, decide ----------

/** An accepted LLM mapping as the job keeps it, so a recompute (or relabel) can map it again. */
export interface StoredLlm {
  clusterKey: string
  /** The `DecideCandidate.id` it named; null for a self-introduced new name. */
  candidateId: string | null
  personId: string | null
  name: string
  evidence: SpeakerEvidenceType[]
  selfIntroduced: boolean
  excerpts: string[]
}

/** A cluster's identification result: from the pass, or from the 14-day store. */
export interface ClusterVoice {
  source: AudioSource
  vector: Float32Array | null
  speechMs: number
  cleanMs: number
}

export interface DecisionInput {
  noteId: string
  passId: string
  chunks: readonly TranscriptChunk[]
  /** The installed extractor's id; null without it. */
  modelId: string | null
  /** By `r<N>`. */
  voice: ReadonlyMap<string, ClusterVoice>
  /** Clean speech by `r<N>` for clusters without a voice entry. */
  cleanMs?: ReadonlyMap<string, number>
  /** `call` runs the LLM step; a list reuses an earlier reply. */
  llm: 'call' | readonly StoredLlm[]
}

export interface Decision {
  noteId: string
  passId: string
  modelId: string | null
  stats: Map<string, PassClusterStats>
  decisions: Map<string, ClusterDecision>
  /** Visible clusters in letter order: key → letter label. */
  letters: Map<string, string>
  llm: StoredLlm[]
  /** Clusters a pending request resolves to. */
  pending: Set<string>
  voice: ReadonlyMap<string, ClusterVoice>
  candidates: NoteCandidates
}

/** Re-points stored mappings at this run's candidates (ids may shift between runs). */
function remapLlm(stored: readonly StoredLlm[], cands: NoteCandidates): StoredLlm[] {
  const out: StoredLlm[] = []
  for (const m of stored) {
    const byId = m.candidateId ? cands.candidates.find((c) => c.id === m.candidateId) : undefined
    const byPerson = !byId && m.personId ? cands.candidates.find((c) => c.personId === m.personId) : undefined
    const sameName = !byId && !byPerson ? cands.candidates.filter((c) => !c.isSelf && foldName(c.name) === foldName(m.name)) : []
    const target = byId ?? byPerson ?? (sameName.length === 1 ? sameName[0] : undefined)
    if (target) out.push({ ...m, candidateId: target.id, personId: target.personId })
    else if (m.selfIntroduced) out.push({ ...m, candidateId: null, personId: null })
  }
  return out
}

/** Steps 2–4 on the chunks as read (pure apart from storage reads and the LLM call). Null when the note is gone. */
export async function computeDecision(ctx: MainContext, input: DecisionInput): Promise<Decision | null> {
  const note = await ctx.storage.getNote(input.noteId)
  if (!note) return null
  const [voices, selfVoice, userName] = await Promise.all([
    ctx.settings.get('speakers.voices'),
    ctx.settings.get('speakers.selfVoice'),
    ctx.settings.get('profile.name')
  ])
  const final = input.chunks.filter((c) => c.is_final)
  const stats = passClusters(final, input.passId)
  const { identities } = speakerIdentities(final, { live: false })
  const byKey = new Map(identities.map((i) => [i.key, i]))
  const flagged = { byShare: 0 }
  const kinds = tileKinds(stats.values(), userName.trim(), flagged)
  // Counts only: how often the 25 % share rule (not the room-name pattern) costs a tile its name.
  if (flagged.byShare) log('info', 'speakers:room-tiles-by-share', { noteId: input.noteId, tiles: flagged.byShare })
  const tiles = [...kinds].filter(([, k]) => k === 'individual').map(([name]) => name)
  const cands = await noteCandidates(ctx, note, tiles, { withVoice: voices || selfVoice })
  const session = await ctx.storage.latestSession(input.noteId).catch(() => null)
  const language = noteLanguage(session?.language ?? null, final)

  // Confirmed (> 50 %) and suppressed clusters are left out; the owner (Me) stays in for self.
  const eligible = [...stats.values()].filter((s) => !s.confirmed && byKey.has(s.key) && !byKey.get(s.key)?.suppressed)
  const clusters: DecideCluster[] = eligible.map((s) => {
    const v = input.voice.get(s.label)
    return decideCluster(s, kinds, language, {
      cleanMs: v?.cleanMs ?? input.cleanMs?.get(s.label) ?? 0,
      vector: input.modelId ? (v?.vector ?? null) : null
    })
  })
  const letters = new Map<string, string>()
  for (const i of identities) if (i.letterLabel && stats.has(i.key)) letters.set(i.key, i.letterLabel)

  const pendingRows = await ctx.storage.listSpeakerPending({ noteId: input.noteId }).catch(() => [])
  const pendingMap = pendingByCluster(final, input.passId, pendingRows)
  // A pending cluster is never scored against the person it waits for.
  const negatives = [
    ...(await ctx.storage.listSpeakerNegatives(input.noteId).catch(() => []))
      .filter((n) => n.passId === input.passId)
      .map((n) => ({ clusterKey: n.identityKey, personId: n.personId })),
    ...[...pendingMap].flatMap(([clusterKey, people]) => people.map((personId) => ({ clusterKey, personId })))
  ]

  let gallery: DecideVoiceSpace[] = []
  const personIds = [...new Set(cands.candidates.map((c) => c.personId).filter((p): p is string => !!p))]
  if (input.modelId && (voices || selfVoice) && personIds.length) {
    const spaces = await ctx.storage.speakerVoiceGallery({ modelId: input.modelId, personIds }).catch(() => [])
    gallery = spaces
      .filter((sp) => voices || sp.personId === cands.self.id)
      .map((sp) => ({ personId: sp.personId, channel: sp.channel, confirmations: sp.confirmations, exemplars: sp.exemplars.map((e) => e.vector) }))
  }

  let llm: StoredLlm[]
  if (input.llm === 'call') {
    const offered = eligible
      .map((s) => ({ s, id: byKey.get(s.key) }))
      .filter(({ s, id }) => id && !id.isOwner && letters.has(s.key))
      .map(({ s }) => ({ identityKey: s.key, label: letters.get(s.key) as string, channel: s.source }))
    const knownSpeakers = [...stats.values()]
      .filter((s) => s.confirmed && s.confirmedName)
      .map((s) => ({ identityKey: s.key, name: s.confirmedName as string }))
    const replies = await bounded(
      suggestForJob(ctx, {
        noteId: input.noteId,
        passId: input.passId,
        chunks: input.chunks,
        offered,
        knownSpeakers,
        candidates: cands.llm,
        attendeeCount: cands.attendeeCount
      }),
      LLM_GUARD_MS,
      []
    )
    llm = []
    for (const m of replies) {
      const decideId = m.candidateId ? (cands.llmIds.get(m.candidateId) ?? null) : null
      if (m.candidateId && !decideId) continue
      const target = decideId ? cands.candidates.find((c) => c.id === decideId) : undefined
      if (decideId && !target) continue
      llm.push({
        clusterKey: m.identityKey,
        candidateId: decideId,
        personId: target?.personId ?? null,
        name: m.name,
        evidence: m.evidenceTypes,
        selfIntroduced: m.selfIntroduced,
        excerpts: m.excerpts
      })
    }
  } else {
    llm = remapLlm(input.llm, cands)
  }
  const mappings: DecideLlmMapping[] = llm.map((m) => ({
    clusterKey: m.clusterKey,
    candidateId: m.candidateId,
    name: m.name,
    evidence: m.evidence,
    selfIntroduced: m.selfIntroduced
  }))

  const result = decide(
    {
      noteId: input.noteId,
      passId: input.passId,
      modelId: input.modelId,
      voices,
      selfVoice,
      hasLinkedEvent: cands.hasLinkedEvent,
      clusters,
      candidates: cands.candidates,
      gallery,
      negatives,
      llm: mappings
    },
    getCalibration(ctx)
  )
  return {
    noteId: input.noteId,
    passId: input.passId,
    modelId: input.modelId,
    stats,
    decisions: new Map(result.clusters.map((d) => [d.key, d])),
    letters,
    llm,
    pending: new Set(pendingMap.keys()),
    voice: input.voice,
    candidates: cands
  }
}

// ---------- step 5: the write ----------

function autoFields(d: ClusterDecision): LabelWordFields {
  return { auto_spk: d.name, auto_pid: d.personId ?? null, auto_src: d.autoSrc ?? null }
}

function matchKinds(src: SpeakerAutoSource | null): SpeakerMatchKind[] {
  if (src === 'app') return ['auto_app']
  if (src === 'voice') return ['auto_voice']
  if (src === 'app+voice') return ['auto_app', 'auto_voice']
  return []
}

/** The row's evidence for its top candidate (the LLM mapping that named it), else any of the cluster's. */
function llmFor(d: Decision, key: string, top: { personId?: string; name: string } | undefined): StoredLlm | undefined {
  const mine = d.llm.filter((m) => m.clusterKey === key)
  return mine.find((m) => top && ((m.personId && m.personId === top.personId) || foldName(m.name) === foldName(top.name))) ?? mine[0]
}

/** How a decision is written: by the job, or by the bench's rerun of a stored pass. */
interface DecisionWriteOpts {
  /** The voice generation the decision read (checked in the queue, and again before the vectors). */
  voiceGen: number
  /** The cluster vectors may go to the 14-day store (the pass embedded in mode `all`). */
  storeVectors: boolean
  abandoned: () => boolean
}

/**
 * The decision write (item 5, and the bench's rerun): `auto_*` on every final word of each
 * auto cluster, `named_pass` on every chunk of the pass, and stale `auto_*` cleared elsewhere.
 * A cluster confirmed since the compute is left untouched, here and in the commit.
 */
function decisionWrite(ctx: MainContext, d: Decision, opts: DecisionWriteOpts): LabelWrite {
  const noteId = d.noteId
  let fresh = new Map<string, PassClusterStats>()
  const skipped = new Set<string>()
  const applied = new Set<string>()
  return {
    kind: 'job',
    passId: d.passId,
    voiceGen: opts.voiceGen,
    patch: (chunks) => {
      if (opts.abandoned() || capturing(ctx, noteId)) return null
      fresh = passClusters(chunks, d.passId)
      skipped.clear()
      applied.clear()
      const autos = new Map<string, ClusterDecision>()
      for (const c of d.decisions.values()) {
        if (fresh.get(c.key)?.confirmed) skipped.add(c.key)
        else if (c.band === 'auto' && writableName(c.name)) autos.set(c.key, c)
      }
      for (const s of fresh.values()) if (s.confirmed) skipped.add(s.key)
      const final = chunks.filter((c) => c.is_final)
      const keys = wordIdentityKeys(final)
      const patches: ChunkFieldPatch[] = []
      for (const c of final) {
        const det = c.providerDetails
        if (!det || det.mergeScopeId !== d.passId) continue
        const ks = keys.get(c.id)
        const words: NonNullable<ChunkFieldPatch['words']> = []
        det.words.forEach((w, index) => {
          const k = ks?.[index] ?? null
          if (k && skipped.has(k)) return
          const auto = k ? autos.get(k) : undefined
          if (auto) {
            words.push({ index, set: autoFields(auto) })
            applied.add(auto.key)
          } else if (w.auto_spk !== undefined || w.auto_pid !== undefined || w.auto_src !== undefined) {
            words.push({ index, set: { auto_spk: null, auto_pid: null, auto_src: null } })
          }
        })
        patches.push({ chunkId: c.id, words, details: { named_pass: d.passId } })
      }
      return patches
    },
    commit: () => commitDecision(ctx, d, opts, fresh, skipped, applied)
  }
}

async function commitDecision(
  ctx: MainContext,
  d: Decision,
  opts: DecisionWriteOpts,
  fresh: Map<string, PassClusterStats>,
  skipped: Set<string>,
  applied: Set<string>
): Promise<void> {
  const s = ctx.storage
  const noteId = d.noteId
  const left = (key: string): boolean => skipped.has(key) || !!fresh.get(key)?.confirmed
  // Suggestion rows: every visible cluster that is neither confirmed nor auto.
  const rows: Omit<SpeakerNameSuggestion, 'created_at'>[] = []
  for (const [key, label] of d.letters) {
    const c = d.decisions.get(key)
    const st = fresh.get(key) ?? d.stats.get(key)
    if (!c || !st || applied.has(key) || left(key)) continue
    // An auto name that couldn't be written (a placeholder) is no name at all.
    const band: SpeakerBand = c.band === 'auto' ? 'none' : c.band
    const top = band === 'none' ? undefined : c.candidates[0]
    const m = band === 'none' ? undefined : llmFor(d, key, top)
    rows.push({
      identityKey: key,
      label,
      name: band === 'suggest' ? (top?.name ?? null) : null,
      evidenceTypes: m?.evidence ?? [],
      channel: st.source,
      labelStream: 'reconciled',
      transcriptExcerpts: m?.excerpts ?? [],
      position: rows.length,
      band,
      candidates: band === 'none' ? [] : c.candidates,
      passId: d.passId,
      pending: d.pending.has(key)
    })
  }
  await s.replaceSpeakerNameSuggestions(noteId, rows)

  // Match rows for automatic names, before the vectors: a Forget of the person deletes the
  // vectors of every note it has a match row in.
  const matches = [...applied].flatMap((key) => {
    const c = d.decisions.get(key)
    return c?.personId ? matchKinds(c.autoSrc).map((kind) => ({ noteId, personId: c.personId as string, kind })) : []
  })
  if (matches.length) await s.recordSpeakerMatches(matches)

  // Cluster vectors: only while Recognize voices is on, for clusters not confirmed, and
  // only from a pass embedded in mode `all`. The generation is checked again right before the
  // save: a Forget all bumped it before its delete, and storage is serial, so either the save
  // lands before the delete or it doesn't happen.
  let vectors = 0
  if (d.modelId && opts.storeVectors && (await ctx.settings.get('speakers.voices'))) {
    const out: Omit<SpeakerClusterVectorRow, 'createdAt' | 'expiresAt'>[] = []
    for (const [label, v] of d.voice) {
      const key = `r:${d.passId}:${label}`
      if (!v.vector || !fresh.has(key) || left(key)) continue
      out.push({ noteId, passId: d.passId, source: v.source, label, modelId: d.modelId, vector: v.vector, speechMs: v.speechMs, cleanMs: v.cleanMs })
    }
    if (out.length && voiceGeneration().current() !== opts.voiceGen) {
      log('info', 'speakers:vectors-skipped', { noteId, code: 'stale-voice', vectors: out.length })
    } else if (out.length) {
      await s.saveSpeakerClusterVectors(out)
      vectors = out.length
    }
  }

  // `last_matched_at` for voice evidence at suggest or above.
  const matched = new Set<string>()
  for (const c of d.decisions.values()) if (!left(c.key)) for (const p of c.voiceMatched) matched.add(p)
  const now = new Date().toISOString()
  for (const p of matched) await s.updateSpeakerPerson(p, { lastMatchedAt: now }).catch((err: unknown) => log('warn', 'speakers:last-matched-failed', { err }))

  log('info', 'speakers:job-written', { noteId, auto: applied.size, rows: rows.length, vectors, matches: matches.length, matched: matched.size })
}

function pushNames(ctx: MainContext, noteId: string, people: boolean): void {
  for (const wc of ctx.windows.targets()) {
    wc.send('speaker-names:changed' satisfies PushChannel, { noteId })
    if (people) wc.send('speaker-people:changed' satisfies PushChannel, {})
  }
}

function passVoice(pass: DiarizePass): Map<string, ClusterVoice> {
  const out = new Map<string, ClusterVoice>()
  for (const [label, c] of pass.clusters) {
    out.set(label, { source: c.source === 'microphone' ? 'microphone' : 'system', vector: c.vector, speechMs: c.speechMs, cleanMs: c.cleanMs })
  }
  return out
}

/** Steps 2–6, recomputed once on a stale voice generation. */
async function decideAndWrite(ctx: MainContext, run: JobRun, pass: DiarizePass): Promise<void> {
  const noteId = run.noteId
  const voice = passVoice(pass)
  let llm: 'call' | StoredLlm[] = 'call'
  for (let attempt = 0; attempt < 2; attempt++) {
    const gen = voiceGeneration().current()
    const chunks = await getTranscriptionManager(ctx).getTranscript(noteId)
    if (run.abandoned) return
    const d = await computeDecision(ctx, { noteId, passId: pass.passId, chunks, modelId: run.modelId, voice, cleanMs: pass.cleanMs, llm })
    if (!d) {
      setState(ctx, run, 'failed', 'no-note')
      return
    }
    // The step-3 reply is reused by a recompute, with no second call.
    llm = d.llm
    if (run.abandoned) return
    const r = await labelQueue(ctx).enqueue(noteId, decisionWrite(ctx, d, { voiceGen: gen, storeVectors: run.storeVectors, abandoned: () => run.abandoned }))
    if (r.status === 'written') {
      setState(ctx, run, 'written')
      pushNames(ctx, noteId, d.decisions.size > 0)
      await passiveSelf(ctx, d, gen)
      return
    }
    if (r.status === 'dropped') {
      if (!run.abandoned) setState(ctx, run, 'failed', 'stale-pass')
      return
    }
  }
  log('warn', 'speakers:job-stale-dropped', { noteId, code: 'stale-voice' })
  setState(ctx, run, 'failed', 'stale')
}

/** The passive self rule, on the pass's mic clusters, after the write. `voiceGen`: the decision's. */
async function passiveSelf(ctx: MainContext, d: Decision, voiceGen: number): Promise<void> {
  if (!d.modelId) return
  const mic = [...d.stats.values()].filter((s) => s.channel === 'mic')
  const total = mic.reduce((n, s) => n + s.speechMs, 0)
  if (!total) return
  await selfPassive(ctx, {
    noteId: d.noteId,
    modelId: d.modelId,
    micClusters: mic.map((s) => {
      const v = d.voice.get(s.label)
      return { identityKey: s.key, speechMs: s.speechMs, cleanMs: v?.cleanMs ?? 0, share: s.speechMs / total, vector: v?.vector ?? null }
    }),
    voiceGen
  }).catch((err: unknown) => log('warn', 'speakers:self-passive-failed', { noteId: d.noteId, err }))
}

// ---------- stored passes (relabel, the bench's rerun) ----------

/** The cluster store's rows as the decision's voice input. */
export function storedVoice(rows: readonly SpeakerClusterVectorRow[]): Map<string, ClusterVoice> {
  return new Map(rows.map((r) => [r.label, { source: r.source, vector: r.vector, speechMs: r.speechMs, cleanMs: r.cleanMs }]))
}

/** The LLM evidence relabel may use: the rows' candidates with source `conversation` or `elimination`. */
export function storedLlm(rows: readonly SpeakerNameSuggestion[], passId: string): StoredLlm[] {
  const out: StoredLlm[] = []
  for (const r of rows) {
    if (r.passId !== passId) continue
    for (const c of r.candidates) {
      if (c.source !== 'conversation' && c.source !== 'elimination') continue
      const evidence: SpeakerEvidenceType[] = r.evidenceTypes.length ? r.evidenceTypes : c.source === 'elimination' ? ['elimination'] : ['named_then_replied']
      out.push({
        clusterKey: r.identityKey,
        candidateId: null,
        personId: c.personId ?? null,
        name: c.name,
        evidence,
        selfIntroduced: !c.personId && r.evidenceTypes.includes('introduced_self'),
        excerpts: r.transcriptExcerpts
      })
    }
  }
  return out
}

export type RerunResult =
  | { status: 'written' | 'dropped' | 'stale' | 'no-pass'; clusters: { key: string; band: SpeakerBand; name: string | null; autoSrc: SpeakerAutoSource | null }[] }

/**
 * The bench hook (dev builds with `NOTULA_DEV_SPEAKER_BENCH=1` only): re-runs steps 2–5 on
 * the note's stored pass, with the stored cluster vectors and the stored LLM evidence (no LLM
 * call), and writes the result like the job does. It answers bands and names, never a score.
 */
export async function rerunDecision(noteId: string): Promise<RerunResult> {
  const ctx = jobCtx
  if (!ctx || app.isPackaged || process.env['NOTULA_DEV_SPEAKER_BENCH'] !== '1') {
    throw notulaError('invalid-input', 'rerunDecision is a dev-only bench hook.')
  }
  if (jobBusy(noteId) || capturing(ctx, noteId)) return { status: 'dropped', clusters: [] }
  const gen = voiceGeneration().current()
  const chunks = await getTranscriptionManager(ctx).getTranscript(noteId)
  const passId = currentPassId(chunks)
  if (!passId) return { status: 'no-pass', clusters: [] }
  const modelId = getTranscriptionManager(ctx).models.speakerId()?.modelId ?? null
  const vectors = modelId ? await ctx.storage.listSpeakerClusterVectors({ noteId, passId, modelId }) : []
  try {
    const rows = await ctx.storage.listSpeakerNameSuggestions(noteId)
    const d = await computeDecision(ctx, { noteId, passId, chunks, modelId, voice: storedVoice(vectors), llm: storedLlm(rows, passId) })
    if (!d) return { status: 'no-pass', clusters: [] }
    const r = await labelQueue(ctx).enqueue(noteId, decisionWrite(ctx, d, { voiceGen: gen, storeVectors: true, abandoned: () => false }))
    if (r.status === 'written') pushNames(ctx, noteId, false)
    return {
      status: r.status,
      clusters: [...d.decisions.values()].map((c) => ({ key: c.key, band: c.band, name: c.band === 'auto' ? c.name : null, autoSrc: c.autoSrc }))
    }
  } finally {
    for (const v of vectors) v.vector.fill(0)
  }
}
