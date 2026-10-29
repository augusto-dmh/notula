// SPDX-License-Identifier: Apache-2.0
// Relabel within the 14-day window: when a person gains an exemplar,
// the decision re-runs for every note whose cluster vectors still exist, from voice plus
// stored non-biometric facts. It never calls the LLM, never lowers or replaces an auto name,
// and changes only `auto_*`, `named_pass` and suggestion rows, one queued write per note.
//
// - Inputs: the stored cluster vectors of the note's current pass; tile shares and coverage
//   from the words' `att`; the LLM evidence from the suggestion rows' `conversation` and
//   `elimination` candidates; attendees from the note (`job.ts` `computeDecision`).
// - It only raises, and only where the person who gained the exemplar is involved: a cluster
//   with no band (`none`) may become suggest or tie; a cluster that isn't auto may become auto
//   when the voice-auto row passes (`auto_src` `voice` or `app+voice`), and only for a person
//   not already named in the note (one-to-one).
// - The write carries the pass id and voice generation it read; stale either way, it is
//   dropped and logged as a code. Confirmed clusters (> 50 % `confirmed_spk`) are never touched.
// - Notes whose job runs, or that are capturing, are skipped: their job decides with the new
//   exemplar anyway. Relabels run one at a time.

import type { PushChannel } from '@shared/ipc'
import { wordIdentityKeys } from '@shared/lib/speakers'
import type { SpeakerBand, SpeakerMatchKind } from '@shared/types/speakers'
import type { MainContext } from '../context'
import { log } from '../log'
import { getTranscriptionManager } from '../transcription/manager'
import { passClusters, type PassClusterStats } from './candidates'
import type { ClusterDecision } from './decide'
import { capturing, computeDecision, jobBusy, storedLlm, storedVoice } from './job'
import { currentPassId, labelQueue, type ChunkFieldPatch } from './label-queue'
import { voiceGeneration } from './voice-gen'

const RANK: Record<SpeakerBand, number> = { none: 0, suggest: 1, tie: 1, auto: 2 }

let chain: Promise<void> = Promise.resolve()

/** Fire and forget; resolves when every affected note's write has settled. */
export function requestRelabel(ctx: MainContext, personId: string): Promise<void> {
  const next = chain.then(() => relabelAll(ctx, personId)).catch((err: unknown) => log('warn', 'speakers:relabel-failed', { err }))
  chain = next
  return next
}

async function relabelAll(ctx: MainContext, personId: string): Promise<void> {
  if (!(await ctx.settings.get('speakers.voices'))) return
  const model = getTranscriptionManager(ctx).models.speakerId()
  if (!model) return
  const notes = await ctx.storage.notesWithSpeakerClusterVectors({ modelId: model.modelId })
  let changed = 0
  for (const noteId of notes) {
    if (capturing(ctx, noteId) || jobBusy(noteId)) continue
    try {
      if (await relabelNote(ctx, noteId, personId, model.modelId)) changed++
    } catch (err) {
      log('warn', 'speakers:relabel-note-failed', { noteId, err })
    }
  }
  log('info', 'speakers:relabel-done', { notes: notes.length, changed })
}

interface Raise {
  decision: ClusterDecision
  band: SpeakerBand
}

async function relabelNote(ctx: MainContext, noteId: string, personId: string, modelId: string): Promise<boolean> {
  const gen = voiceGeneration().current()
  const chunks = await getTranscriptionManager(ctx).getTranscript(noteId)
  const passId = currentPassId(chunks)
  if (!passId) return false
  const vectors = await ctx.storage.listSpeakerClusterVectors({ noteId, passId, modelId })
  if (!vectors.length) return false
  try {
    const rows = await ctx.storage.listSpeakerNameSuggestions(noteId)
    // Relabel never calls the LLM: the stored rows stand in for its reply.
    const d = await computeDecision(ctx, { noteId, passId, chunks, modelId, voice: storedVoice(vectors), llm: storedLlm(rows, passId) })
    if (!d) return false
    const bandOf = new Map(rows.filter((r) => r.passId === passId).map((r) => [r.identityKey, r.band]))
    const taken = namedPeople(chunks, d.stats)
    const raises: Raise[] = []
    for (const c of [...d.decisions.values()].sort((a, b) => (a.key < b.key ? -1 : 1))) {
      const s = d.stats.get(c.key)
      if (!s || s.confirmed || s.auto) continue
      if (c.personId !== personId && !c.candidates.some((k) => k.personId === personId)) continue
      const current = bandOf.get(c.key) ?? 'none'
      if (c.band === 'auto') {
        const byVoice = c.autoSrc === 'voice' || c.autoSrc === 'app+voice'
        if (!byVoice || !c.personId || !c.name || taken.has(c.personId)) continue
        taken.add(c.personId)
        raises.push({ decision: c, band: 'auto' })
      } else if (RANK[c.band] > RANK[current]) {
        raises.push({ decision: c, band: c.band })
      }
    }
    if (!raises.length) return false
    const r = await labelQueue(ctx).enqueue(noteId, {
      kind: 'relabel',
      passId,
      voiceGen: gen,
      patch: (fresh) => {
        if (capturing(ctx, noteId) || jobBusy(noteId)) return null
        const now = passClusters(fresh, passId)
        const keep = raises.filter((x) => {
          const s = now.get(x.decision.key)
          return s && !s.confirmed && !s.auto
        })
        raises.splice(0, raises.length, ...keep)
        const autos = new Map(keep.filter((x) => x.band === 'auto').map((x) => [x.decision.key, x.decision]))
        if (!autos.size) return []
        const final = fresh.filter((c) => c.is_final)
        const keys = wordIdentityKeys(final)
        const patches: ChunkFieldPatch[] = []
        for (const c of final) {
          const det = c.providerDetails
          if (!det || det.mergeScopeId !== passId) continue
          const ks = keys.get(c.id)
          const words: NonNullable<ChunkFieldPatch['words']> = []
          det.words.forEach((_w, index) => {
            const a = ks?.[index] ? autos.get(ks[index] as string) : undefined
            if (a) words.push({ index, set: { auto_spk: a.name, auto_pid: a.personId ?? null, auto_src: a.autoSrc ?? null } })
          })
          if (words.length || det.named_pass !== passId) patches.push({ chunkId: c.id, words, details: { named_pass: passId } })
        }
        return patches
      },
      commit: async () => {
        const s = ctx.storage
        const matches: { noteId: string; personId: string; kind: SpeakerMatchKind }[] = []
        for (const x of raises) {
          const c = x.decision
          if (x.band === 'auto') {
            await s.deleteSpeakerNameSuggestion(noteId, c.key)
            if (c.personId) {
              matches.push({ noteId, personId: c.personId, kind: 'auto_voice' })
              if (c.autoSrc === 'app+voice') matches.push({ noteId, personId: c.personId, kind: 'auto_app' })
            }
          } else {
            await s.patchSpeakerNameSuggestion(noteId, c.key, { band: x.band, candidates: c.candidates })
          }
        }
        if (matches.length) await s.recordSpeakerMatches(matches)
        // A voice match at suggest or above refreshes the person's 12-month clock.
        if (raises.some((x) => x.decision.voiceMatched.includes(personId))) {
          await s.updateSpeakerPerson(personId, { lastMatchedAt: new Date().toISOString() }).catch(() => undefined)
        }
      }
    })
    if (r.status !== 'written') {
      log('info', 'speakers:relabel-dropped', { noteId, code: r.status === 'stale' ? `stale-${r.why}` : 'dropped' })
      return false
    }
    for (const wc of ctx.windows.targets()) wc.send('speaker-names:changed' satisfies PushChannel, { noteId })
    log('info', 'speakers:relabel-written', { noteId, raised: raises.length })
    return raises.length > 0
  } finally {
    for (const v of vectors) v.vector.fill(0)
  }
}

/** People already named in the note (confirmed or auto): relabel keeps the one-to-one rule. */
function namedPeople(chunks: Parameters<typeof wordIdentityKeys>[0], stats: Map<string, PassClusterStats>): Set<string> {
  const out = new Set<string>()
  for (const s of stats.values()) if (s.auto?.personId) out.add(s.auto.personId)
  for (const c of chunks) for (const w of c.providerDetails?.words ?? []) if (w.confirmed_pid) out.add(w.confirmed_pid)
  return out
}
