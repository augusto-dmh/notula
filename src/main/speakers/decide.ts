// SPDX-License-Identifier: Apache-2.0
// The decision module: evidence per (cluster, candidate), fusion
// from the calibration, a one-to-one assignment with an unknown option per cluster (autos take
// theirs from one that only voice able to name automatically can steer), and the bands. Pure:
// no I/O and no logging, so the job, relabel and the benchmark all drive it. Its inputs and
// outputs never leave main.

import type {
  SpeakerAutoSource,
  SpeakerBand,
  SpeakerCalibrationLanguage,
  SpeakerCandidate,
  SpeakerChannel
} from '@shared/types/speakers'
import { SPEAKER_PROFILE_LIMITS } from '@shared/types/speakers'
import type { SpeakerEvidenceType } from '@shared/types/transcript'
import { SPEAKER_LABEL_ME } from '@shared/types/transcript'
import type { SpeakerCalibrationState } from './calibration'
import { assignOneToOne } from './decide/assign'
import { conditionFor, fusionOf, type DecideCondition } from './decide/conditions'
import {
  appEvidence,
  foldName,
  fuse,
  isElimination,
  mappingRefersTo,
  negativeKey,
  pairAllowed,
  sigmoid,
  voiceEvidence,
  type EvidenceInput,
  type PairEvidence
} from './decide/evidence'

/** One meeting-app tile over a system cluster's `att`-stamped words. */
export interface DecideTile {
  participantId: string
  name: string
  /** This tile's share of the cluster's tile-stamped speech (word time). */
  share: number
  /** Room tiles, the user's own tile and screen-share audio give no naming evidence. */
  kind: 'individual' | 'room' | 'self' | 'screen-share'
}

/** One unconfirmed cluster of the pass. Confirmed clusters (> 50 % `confirmed_spk`) are left out by the caller. */
export interface DecideCluster {
  /** `r:<passId>:r<N>`. */
  key: string
  /** `r<N>`. */
  label: string
  channel: SpeakerChannel
  language: SpeakerCalibrationLanguage
  /** Word time. */
  speechMs: number
  cleanMs: number
  /** The identification vector of the installed model; null without one (under 3 s, no model, voice off). */
  vector: Float32Array | null
  /** System clusters only; `[]` on the mic. */
  tiles: DecideTile[]
  /** The stamped share of all the cluster's speech. */
  coverage: number
}

export interface DecideCandidate {
  /** Stable and unique: the person id, else `app:<participantId>`, else `name:<folded name>`. */
  id: string
  personId: string | null
  name: string
  isSelf: boolean
  /** On the linked event (minus the user and calendar resources): the only people voice may auto-name. */
  attendee: boolean
  /** Known people: confirmed or recognized lately, or of the same calendar series. */
  known: boolean
  /** The meeting-app participants that map to this candidate. */
  tileIds: string[]
  /** Its individual tile is stamped on this meeting's system words, so it is never assigned to a mic cluster. */
  stampedOnSystem: boolean
  /** An active agreement record, or self. */
  hasAgreement: boolean
  /** The person's Recognize automatically switch. */
  autoRecognize: boolean
}

/** One voice space of the installed model. Spaces of another model never reach `decide`. */
export interface DecideVoiceSpace {
  personId: string
  channel: SpeakerChannel
  /** Confirmations (for self: enrollment events) behind the space. */
  confirmations: number
  exemplars: Float32Array[]
}

/** An accepted LLM mapping (the existing gate), as evidence. */
export interface DecideLlmMapping {
  clusterKey: string
  /** A `CANDIDATES` entry; null for a self-introduced new name (suggest only). */
  candidateId: string | null
  name: string
  evidence: SpeakerEvidenceType[]
  selfIntroduced: boolean
}

export interface DecideInput {
  noteId: string
  passId: string
  /** The installed extractor's id; null without it (voice gives no evidence). */
  modelId: string | null
  /** `speakers.voices` and `speakers.selfVoice`. */
  voices: boolean
  selfVoice: boolean
  /** Without a linked event, voice auto-names nobody but self. */
  hasLinkedEvent: boolean
  clusters: DecideCluster[]
  candidates: DecideCandidate[]
  gallery: DecideVoiceSpace[]
  /** "Not <name>" pairings of this pass. */
  negatives: { clusterKey: string; personId: string }[]
  llm: DecideLlmMapping[]
}

export interface ClusterDecision {
  key: string
  band: SpeakerBand
  /** Auto only: what the job writes on the cluster's words (`auto_spk`, `auto_pid`, `auto_src`). */
  name: string | null
  personId: string | null
  autoSrc: SpeakerAutoSource | null
  /** Suggest and tie: the suggestion row's candidates, best first, at most 2. */
  candidates: SpeakerCandidate[]
  /** People whose voice evidence for this cluster reached suggest or above (match rows, `last_matched_at`). */
  voiceMatched: string[]
}

export interface DecideResult {
  clusters: ClusterDecision[]
}

const L = SPEAKER_PROFILE_LIMITS

interface ClusterState {
  cluster: DecideCluster
  cond: DecideCondition
  /** Allowed pairs with at least one signal, by candidate id. */
  pairs: Map<string, PairEvidence>
  /** Self-introduced new names: suggest only, never in the assignment. */
  intros: PairEvidence[]
  mappings: DecideLlmMapping[]
  assigned: DecideCandidate | null
  /** The assignment on `autoFused`: the only candidate this cluster may be named after automatically. */
  autoAssigned: DecideCandidate | null
}

/** The same input gives the same result whatever the order of clusters or candidates. */
export function decide(input: DecideInput, calibration: SpeakerCalibrationState): DecideResult {
  const file = calibration.file
  // A mismatch between the file and the installed extractor disables voice entirely.
  const voiceOn = calibration.voice && input.modelId !== null && file?.modelSha === input.modelId
  const opts: EvidenceInput = {
    voiceOn,
    voices: input.voices,
    selfVoice: input.selfVoice,
    fusion: fusionOf(file)
  }
  const clusters = [...input.clusters].sort((a, b) => compare(a.key, b.key))
  const candidates = [...input.candidates].sort((a, b) => compare(a.id, b.id))
  const negatives = new Set(input.negatives.map((n) => negativeKey(n.clusterKey, n.personId)))
  const gallery = new Map<string, DecideVoiceSpace[]>()
  for (const s of input.gallery) gallery.set(s.personId, [...(gallery.get(s.personId) ?? []), s])

  // Evidence and fusion per allowed pair.
  const states: ClusterState[] = clusters.map((c) => {
    const cond = conditionFor(calibration, c.channel, c.language, c.cleanMs)
    const mappings = input.llm.filter((m) => m.clusterKey === c.key)
    const pairs = new Map<string, PairEvidence>()
    for (const j of candidates) {
      if (!pairAllowed(c, j, negatives)) continue
      const voice = voiceEvidence(c, j, j.personId ? (gallery.get(j.personId) ?? []) : [], cond, opts)
      const app = appEvidence(c, j)
      const cues = mappings.filter((m) => refersUniquely(m, j, candidates))
      const elimination = cues.length > 0 && cues.every(isElimination)
      const conversation = cues.length > 0 && !elimination
      const f = fuse({ voice, app, conversation, elimination }, opts.fusion)
      if (!f) continue
      const own = voice && !voiceMayName(c, j, input) ? fuse({ voice: null, app, conversation, elimination }, opts.fusion) : f
      pairs.set(j.id, {
        id: j.id,
        candidate: j,
        name: j.isSelf ? SPEAKER_LABEL_ME : j.name,
        voice,
        app,
        conversation,
        elimination,
        fused: f.fused,
        p: sigmoid(f.fused),
        autoFused: own?.fused ?? null,
        source: f.source
      })
    }
    const intros: PairEvidence[] = []
    for (const m of mappings) {
      if (m.candidateId !== null || !m.selfIntroduced) continue
      if (candidates.some((j) => refersUniquely(m, j, candidates))) continue
      const id = `intro:${foldName(m.name)}`
      if (!m.name.trim() || intros.some((x) => x.id === id)) continue
      const f = fuse({ voice: null, app: null, conversation: true, elimination: false }, opts.fusion)
      if (!f) continue
      intros.push({
        id,
        candidate: null,
        name: m.name.trim(),
        voice: null,
        app: null,
        conversation: true,
        elimination: false,
        fused: f.fused,
        p: sigmoid(f.fused),
        autoFused: null,
        source: 'conversation'
      })
    }
    intros.sort((a, b) => compare(a.id, b.id))
    return { cluster: c, cond, pairs, intros, mappings, assigned: null, autoAssigned: null }
  })

  // One-to-one assignment, with one unknown option per cluster scored at its floor.
  const floorOdds = (s: ClusterState): number => Math.log(s.cond.floor / (1 - s.cond.floor))
  const assign = (score: (e: PairEvidence) => number | null): (DecideCandidate | null)[] => {
    const weight = states.map((s) =>
      candidates.map((j) => {
        const e = s.pairs.get(j.id)
        const x = e ? score(e) : null
        if (x === null) return null
        const w = x - floorOdds(s)
        return w > 0 ? w : null
      })
    )
    return assignOneToOne(weight, candidates.length).map((col) => candidates[col] ?? null)
  }
  const assigned = assign((e) => e.fused)
  // Autos come from an assignment that voice which can't name automatically doesn't steer:
  // otherwise a non-attendee's voice could move their tile onto a cluster the app rule then names.
  const steered = states.some((s) => [...s.pairs.values()].some((e) => e.autoFused !== e.fused))
  const autoAssigned = steered ? assign((e) => e.autoFused) : assigned
  states.forEach((s, i) => {
    s.assigned = assigned[i] ?? null
    s.autoAssigned = autoAssigned[i] ?? null
  })

  // Auto rows first, in the table's order.
  const autos = new Map<string, { j: DecideCandidate; src: SpeakerAutoSource }>()
  for (const s of states) {
    const j = s.autoAssigned
    if (!j) continue
    const app = appAuto(s, j)
    const voice = voiceAuto(s, j, states, input, voiceOn)
    if (app) autos.set(s.cluster.key, { j, src: voice ? 'app+voice' : 'app' })
    else if (voice) autos.set(s.cluster.key, { j, src: 'voice' })
  }
  // No two clusters of a note get the same person (or name) automatically.
  const byName = new Map<string, string[]>()
  for (const [key, a] of autos) {
    const k = a.j.personId ?? `name:${foldName(a.j.name)}`
    byName.set(k, [...(byName.get(k) ?? []), key])
  }
  for (const keys of byName.values()) if (keys.length > 1) for (const key of keys) autos.delete(key)
  // An auto takes its person; any other cluster keeps the person it was assigned, unless that
  // person is named automatically elsewhere.
  const assignedTo = new Map<string, string>()
  for (const [key, a] of autos) assignedTo.set(a.j.id, key)
  for (const s of states) {
    if (s.assigned && !autos.has(s.cluster.key) && !assignedTo.has(s.assigned.id)) assignedTo.set(s.assigned.id, s.cluster.key)
  }

  const decisions = new Map<string, ClusterDecision>()
  for (const s of states) {
    const voiceMatched = [...s.pairs.values()]
      .filter((e) => e.candidate?.personId && e.voice && e.voice.p >= s.cond.tauSuggest)
      .map((e) => e.candidate?.personId as string)
      .sort(compare)
    const auto = autos.get(s.cluster.key)
    if (auto) {
      decisions.set(s.cluster.key, {
        key: s.cluster.key,
        band: 'auto',
        name: auto.j.isSelf ? SPEAKER_LABEL_ME : auto.j.name,
        personId: auto.j.personId,
        autoSrc: auto.src,
        candidates: [],
        voiceMatched
      })
      continue
    }
    const { band, shown } = lowerBand(s, assignedTo)
    decisions.set(s.cluster.key, {
      key: s.cluster.key,
      band,
      name: null,
      personId: null,
      autoSrc: null,
      candidates: shown.map(toCandidate),
      voiceMatched
    })
  }
  return { clusters: input.clusters.map((c) => decisions.get(c.key) as ClusterDecision) }
}

/** The first rule: auto by meeting app. */
function appAuto(s: ClusterState, j: DecideCandidate): boolean {
  const c = s.cluster
  if (c.channel !== 'system' || c.speechMs < L.autoMinSpeechMs || c.coverage < L.appCoverage) return false
  const tiles = [...c.tiles].sort((a, b) => b.share - a.share || compare(a.participantId, b.participantId))
  const top = tiles[0]
  if (!top || top.kind !== 'individual' || top.share < L.appTileShare) return false
  if ((tiles[1]?.share ?? 0) > L.appNextTileMax) return false
  if (!j.tileIds.includes(top.participantId)) return false
  // The LLM has no accepted mapping of this cluster to a different candidate.
  if (s.mappings.some((m) => !mappingRefersTo(m, j))) return false
  // No voice evidence at suggest level or above for a different person.
  for (const e of s.pairs.values()) {
    if (e.id !== j.id && e.voice && e.voice.p >= s.cond.tauSuggest) return false
  }
  return true
}

/** The second rule: auto by voice (and self on mic). */
function voiceAuto(
  s: ClusterState,
  j: DecideCandidate,
  states: ClusterState[],
  input: DecideInput,
  voiceOn: boolean
): boolean {
  const c = s.cluster
  const e = s.pairs.get(j.id)
  if (!voiceOn || !e?.voice || e.voice.crossChannel || !e.voice.space) return false
  if (!voiceMayName(c, j, input)) return false
  if (c.cleanMs < L.autoMinSpeechMs) return false
  if (e.voice.space.confirmations < L.autoMinConfirmations) return false
  if (!s.cond.autoEnabled) return false
  if (e.p < s.cond.tauAuto) return false
  const floorP = s.cond.floor
  // The margin to the runner-up person.
  let runnerUp = floorP
  for (const o of s.pairs.values()) if (o.id !== j.id) runnerUp = Math.max(runnerUp, o.p)
  if (!clearsMargin(e.p - runnerUp, s.cond)) return false
  // Mutual uniqueness: this cluster is also the person's best cluster by that margin.
  let otherCluster = floorP
  for (const o of states) {
    if (o === s) continue
    const oe = o.pairs.get(j.id)
    if (oe) otherCluster = Math.max(otherCluster, oe.p)
  }
  if (!clearsMargin(e.p - otherCluster, s.cond)) return false
  // No contradicting signal: another person's individual tile covering ≥ 50 % of the speech, …
  for (const t of c.tiles) {
    if (t.kind === 'individual' && !j.tileIds.includes(t.participantId) && t.share * c.coverage >= L.appCoverage) {
      return false
    }
  }
  // … or an accepted LLM mapping to another candidate.
  if (s.mappings.some((m) => !mappingRefersTo(m, j))) return false
  return true
}

/** Whose voice may name them automatically: self on the mic, or an attendee with an agreement. */
function voiceMayName(c: DecideCluster, j: DecideCandidate, input: DecideInput): boolean {
  if (!j.autoRecognize) return false
  if (j.isSelf) return input.selfVoice && c.channel === 'mic'
  // Without a linked event, voice auto-names nobody but self.
  return input.voices && j.hasAgreement && j.attendee && input.hasLinkedEvent
}

function clearsMargin(diff: number, cond: DecideCondition): boolean {
  return diff >= cond.margin && diff > cond.tieMargin
}

/** The remaining rules: tie, suggest, none. Candidates assigned to another cluster aren't offered here. */
function lowerBand(
  s: ClusterState,
  assignedTo: Map<string, string>
): { band: SpeakerBand; shown: PairEvidence[] } {
  const tau = s.cond.tauSuggest
  const pool = [...s.pairs.values(), ...s.intros]
    .filter((e) => {
      const owner = assignedTo.get(e.id)
      return owner === undefined || owner === s.cluster.key
    })
    .sort(byP)
  const [first, second] = pool
  if (first && second && first.p >= tau && second.p >= tau && first.p - second.p <= s.cond.tieMargin) {
    return { band: 'tie', shown: [first, second] }
  }
  const qualifying = pool.filter((e) => qualifies(e, tau))
  const assigned = s.assigned ? qualifying.find((e) => e.id === s.assigned?.id) : undefined
  const best = assigned ?? qualifying[0]
  if (!best) return { band: 'none', shown: [] }
  // Meeting-app and voice evidence that disagree: both shown.
  const byApp = (e: PairEvidence): boolean => !!e.app && (e.app.dominant || e.app.p >= tau)
  const byVoice = (e: PairEvidence): boolean => !!e.voice && e.voice.p >= tau
  const other = qualifying.find(
    (e) => e.id !== best.id && ((byApp(best) && byVoice(e)) || (byVoice(best) && byApp(e)))
  )
  return { band: 'suggest', shown: other ? [best, other].sort(byP) : [best] }
}

/** The best candidate is ≥ `tauSuggest` from any signal or the fused score. */
function qualifies(e: PairEvidence, tau: number): boolean {
  if (e.p >= tau) return true
  if (e.voice && e.voice.p >= tau) return true
  if (e.app && (e.app.dominant || e.app.p >= tau)) return true
  return e.conversation || e.elimination
}

/** A mapping counts for a candidate only when it refers to it alone (a name equal to two is ambiguous). */
function refersUniquely(m: DecideLlmMapping, j: DecideCandidate, all: DecideCandidate[]): boolean {
  if (!mappingRefersTo(m, j)) return false
  return m.candidateId !== null || all.filter((k) => mappingRefersTo(m, k)).length === 1
}

function toCandidate(e: PairEvidence): SpeakerCandidate {
  const personId = e.candidate?.personId
  return personId ? { personId, name: e.name, source: e.source } : { name: e.name, source: e.source }
}

function byP(a: PairEvidence, b: PairEvidence): number {
  return b.p - a.p || compare(a.id, b.id)
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
