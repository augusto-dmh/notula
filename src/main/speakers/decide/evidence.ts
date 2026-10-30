// SPDX-License-Identifier: Apache-2.0
// Evidence per (cluster, candidate) and its fusion. Each signal
// becomes a log-odds, or no evidence; the fused score is `Σ w·s + offset` with the calibration's
// weights. Channel and negatives are hard constraints, applied before any signal. Pure.

import type { SpeakerCandidateSource, SpeakerFusionSignal } from '@shared/types/speakers'
import { SPEAKER_PROFILE_LIMITS } from '@shared/types/speakers'
import type { DecideCandidate, DecideCluster, DecideLlmMapping, DecideVoiceSpace } from '../decide'
import type { DecideCondition, DecideFusion } from './conditions'

// Hand-set log-odds of an accepted LLM mapping, before the bench fits them.
const CONVERSATION_LOG_ODDS = 2.5
const ELIMINATION_LOG_ODDS = 2.5
/** Tile shares are clipped before the logit, so one tile never gives infinite evidence. */
const SHARE_CLIP = 0.02

export interface VoiceEvidence {
  cosine: number
  logOdds: number
  /** P(correct) of the voice signal alone. */
  p: number
  /** Only an exemplar of the other channel matched: at most suggest. */
  crossChannel: boolean
  /** The same-channel space that matched; null when cross-channel. */
  space: DecideVoiceSpace | null
}

export interface AppEvidence {
  /** The candidate's individual tiles' share of the cluster's tile-stamped speech. */
  share: number
  /** ≥ 80 % with every other tile ≤ 10 %: enough for suggest on its own. */
  dominant: boolean
  logOdds: number
  p: number
}

export interface PairEvidence {
  /** The candidate id; `intro:<folded name>` for a self-introduced new name. */
  id: string
  candidate: DecideCandidate | null
  name: string
  voice: VoiceEvidence | null
  app: AppEvidence | null
  conversation: boolean
  elimination: boolean
  /** Fused log-odds and P(correct). */
  fused: number
  p: number
  /**
   * The fused log-odds without voice that can't name this candidate automatically; null when no
   * other signal is left. The assignment that picks who may be named automatically reads it.
   */
  autoFused: number | null
  source: SpeakerCandidateSource
}

export interface EvidenceInput {
  voiceOn: boolean
  voices: boolean
  selfVoice: boolean
  fusion: DecideFusion
}

export function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x))
}

function logit(p: number): number {
  return Math.log(p / (1 - p))
}

/** Case- and accent-insensitive. */
export function foldName(name: string): string {
  return name.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim()
}

/** The hard constraints (the channel, the negatives). */
export function pairAllowed(c: DecideCluster, j: DecideCandidate, negatives: Set<string>): boolean {
  if (j.isSelf && c.channel === 'system') return false
  if (j.stampedOnSystem && c.channel === 'mic') return false
  if (j.personId !== null && negatives.has(negativeKey(c.key, j.personId))) return false
  return true
}

export function negativeKey(clusterKey: string, personId: string): string {
  return `${clusterKey}\u0000${personId}`
}

export function voiceEvidence(
  c: DecideCluster,
  j: DecideCandidate,
  spaces: DecideVoiceSpace[],
  cond: DecideCondition,
  opts: EvidenceInput
): VoiceEvidence | null {
  if (!opts.voiceOn || !c.vector || c.cleanMs < SPEAKER_PROFILE_LIMITS.vectorMinCleanMs) return null
  if (j.personId === null || (j.isSelf ? !opts.selfVoice : !opts.voices)) return null
  let same: { cosine: number; space: DecideVoiceSpace } | null = null
  let cross: number | null = null
  for (const space of spaces) {
    const cos = maxCosine(c.vector, space.exemplars)
    if (cos === null) continue
    if (space.channel === c.channel) {
      // Equal cosines: the space with more confirmations, so the gallery's order doesn't matter.
      if (!same || cos > same.cosine || (cos === same.cosine && space.confirmations > same.space.confirmations)) {
        same = { cosine: cos, space }
      }
    } else if (cross === null || cos > cross) {
      cross = cos
    }
  }
  const cosine = same?.cosine ?? cross
  if (cosine === null) return null
  const logOdds = cond.logistic.a * cosine + cond.logistic.b
  return { cosine, logOdds, p: sigmoid(logOdds), crossChannel: !same, space: same?.space ?? null }
}

/** System channel only; room, self and screen-share tiles give no naming evidence. */
export function appEvidence(c: DecideCluster, j: DecideCandidate): AppEvidence | null {
  if (c.channel !== 'system' || c.coverage <= 0 || j.tileIds.length === 0) return null
  let share = 0
  let others = 0
  for (const t of c.tiles) {
    if (t.kind === 'individual' && j.tileIds.includes(t.participantId)) share += t.share
    else others = Math.max(others, t.share)
  }
  if (share <= 0) return null
  share = Math.min(1, share)
  const dominant =
    share >= SPEAKER_PROFILE_LIMITS.appTileShare && others <= SPEAKER_PROFILE_LIMITS.appNextTileMax
  const clipped = Math.min(1 - SHARE_CLIP, Math.max(SHARE_CLIP, share))
  const logOdds = logit(clipped) * Math.min(1, c.coverage / SPEAKER_PROFILE_LIMITS.appCoverage)
  return { share, dominant, logOdds, p: sigmoid(logOdds) }
}

/** Does an accepted mapping point at this candidate (by id, or a self-introduced name equal to its name)? */
export function mappingRefersTo(m: DecideLlmMapping, j: DecideCandidate): boolean {
  if (m.candidateId !== null) return m.candidateId === j.id
  return foldName(m.name) === foldName(j.name)
}

/** An elimination-only mapping counts as elimination; any other accepted cue, as conversation. */
export function isElimination(m: DecideLlmMapping): boolean {
  return m.evidence.length > 0 && m.evidence.every((e) => e === 'elimination')
}

export function fuse(
  parts: { voice: VoiceEvidence | null; app: AppEvidence | null; conversation: boolean; elimination: boolean },
  fusion: DecideFusion
): { fused: number; source: SpeakerCandidateSource } | null {
  const signals: [SpeakerFusionSignal, number][] = []
  // This order also breaks ties for the shown source.
  if (parts.app) signals.push(['app', parts.app.logOdds])
  if (parts.voice) signals.push(['voice', parts.voice.logOdds])
  if (parts.conversation) signals.push(['conversation', CONVERSATION_LOG_ODDS])
  if (parts.elimination) signals.push(['elimination', ELIMINATION_LOG_ODDS])
  if (signals.length === 0) return null
  let fused = 0
  let source: SpeakerCandidateSource = signals[0]?.[0] as SpeakerCandidateSource
  let strongest = -Infinity
  for (const [k, s] of signals) {
    const term = fusion[k].weight * s + fusion[k].offset
    fused += term
    if (term > strongest) {
      strongest = term
      source = k
    }
  }
  return { fused, source }
}


function maxCosine(v: Float32Array, exemplars: Float32Array[]): number | null {
  let best: number | null = null
  for (const e of exemplars) {
    const cos = cosine(v, e)
    if (cos !== null && (best === null || cos > best)) best = cos
  }
  return best
}

function cosine(a: Float32Array, b: Float32Array): number | null {
  if (a.length !== b.length || a.length === 0) return null
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as number
    const y = b[i] as number
    dot += x * y
    na += x * x
    nb += y * y
  }
  if (na === 0 || nb === 0) return null
  return dot / Math.sqrt(na * nb)
}
