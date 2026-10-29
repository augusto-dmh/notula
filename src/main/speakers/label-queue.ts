// SPDX-License-Identifier: Apache-2.0
// The label-write queue: one serial chain per note for every
// write to a transcript's speaker fields. It serializes writes, not computation: the pass,
// the embedding and the LLM call run outside it, and each write re-reads the chunks inside
// its turn and returns a field-level patch. A stale whole chunk is never written back.
//
// Writers: the diarization pass's patch, the post-meeting job's write, user naming, relabel,
// undo, the source-note position write and `transcript:delete-sections`.
//
// Staleness, checked inside the queue on the chunks as read there:
// - a write with a `passId` whose pass is no longer the note's current one (`currentPassId`):
//   the job's and relabel's writes are dropped (the newer pass runs its own job); any other
//   kind answers `stale` with `why: 'pass'`, so naming can refuse with `stale`. The pass's own
//   write (`diarization`) sets the pass and is never checked;
// - a write with a `voiceGen` other than the current voice generation answers `stale` with
//   `why: 'voice'`: the job recomputes once, relabel drops it.
// Both are logged as codes. The patch then only touches the fields it names.

import type { ProviderDetails, ProviderWord, TranscriptChunk } from '@shared/types/transcript'
import type { MainContext } from '../context'
import { log } from '../log'
import { getTranscriptionManager } from '../transcription/manager'
import { voiceGeneration } from './voice-gen'

export type LabelWriteKind = 'diarization' | 'job' | 'naming' | 'relabel' | 'undo' | 'position' | 'delete-sections'

/** The word fields a label write may change. */
export type LabelWordField = 'merged_spk' | 'confirmed_spk' | 'confirmed_pid' | 'auto_spk' | 'auto_pid' | 'auto_src'
/** The chunk fields a label write may change (inside `providerDetails`). */
export type LabelDetailField = 'mergeScopeId' | 'named_pass' | 'sourcePositionMs'

/** `null` removes the field. */
export type LabelWordFields = { [K in LabelWordField]?: NonNullable<ProviderWord[K]> | null }
export type LabelDetailFields = { [K in LabelDetailField]?: NonNullable<ProviderDetails[K]> | null }

/** A field-level patch of one chunk, computed from the chunks the write read inside the queue. */
export interface ChunkFieldPatch {
  chunkId: string
  /** By index into that chunk's `providerDetails.words`. */
  words?: { index: number; set: LabelWordFields }[]
  details?: LabelDetailFields
  /** The details to start from when the chunk has none (the position write of a chunk without words). */
  base?: ProviderDetails
}

export interface LabelWrite {
  kind: LabelWriteKind
  /** The pass the write was computed for (job, relabel, naming). */
  passId?: string
  /** The voice generation the write read (job, relabel). */
  voiceGen?: number
  /** Runs inside the queue on freshly read chunks. `null` drops the write; `[]` writes no chunk. */
  patch(chunks: readonly TranscriptChunk[]): ChunkFieldPatch[] | null
  /**
   * Runs inside the queue right after the chunk write, so nothing interleaves: the write's
   * other rows (suggestion rows, cluster vectors, match rows), or a write that isn't a chunk
   * patch (`delete-sections`). Not run when the write is dropped or stale.
   */
  commit?(applied: readonly TranscriptChunk[]): Promise<void>
}

export type LabelWriteResult =
  | { status: 'written'; chunks: number }
  /** `patch` returned null, or the write's pass is no longer the note's. */
  | { status: 'dropped' }
  /**
   * `voice`: the voice generation moved since the write was computed (the job recomputes once,
   * then drops; relabel drops). `pass`: a naming-side write computed for an older pass.
   */
  | { status: 'stale'; why: 'pass' | 'voice' }

export interface LabelQueue {
  enqueue(noteId: string, write: LabelWrite): Promise<LabelWriteResult>
  /** Resolves when every write queued for the note so far has settled. */
  idle(noteId: string): Promise<void>
}

/**
 * The note's current pass: the `mergeScopeId` on the most final words. Every chunk a pass
 * covers carries its id, and the pass's write strips older ids, so one pass id remains.
 */
export function currentPassId(chunks: readonly TranscriptChunk[]): string | null {
  const words = new Map<string, number>()
  for (const c of chunks) {
    const scope = c.is_final ? c.providerDetails?.mergeScopeId : undefined
    if (scope) words.set(scope, (words.get(scope) ?? 0) + Math.max(1, c.providerDetails?.words.length ?? 0))
  }
  let best: string | null = null
  let most = 0
  for (const [scope, n] of words) {
    if (n > most || (n === most && best !== null && scope < best)) {
      best = scope
      most = n
    }
  }
  return best
}

/** Applies field patches to chunks, returning only the changed chunks (new objects). Pure. */
export function applyChunkPatches(chunks: readonly TranscriptChunk[], patches: readonly ChunkFieldPatch[]): TranscriptChunk[] {
  const byId = new Map(chunks.map((c) => [c.id, c]))
  const out = new Map<string, TranscriptChunk>()
  for (const p of patches) {
    const base = out.get(p.chunkId) ?? byId.get(p.chunkId)
    const d = base?.providerDetails ?? p.base
    if (!base || !d) continue
    const words = d.words.slice()
    for (const w of p.words ?? []) {
      const word = words[w.index]
      if (!word) continue
      const next: Record<string, unknown> = { ...word }
      for (const [k, v] of Object.entries(w.set)) {
        if (v === null) delete next[k]
        else if (v !== undefined) next[k] = v
      }
      words[w.index] = next as unknown as ProviderWord
    }
    const details: Record<string, unknown> = { ...d, words }
    for (const [k, v] of Object.entries(p.details ?? {})) {
      if (v === null) delete details[k]
      else if (v !== undefined) details[k] = v
    }
    out.set(p.chunkId, { ...base, providerDetails: details as unknown as ProviderDetails })
  }
  return [...out.values()]
}

class NoteLabelQueue implements LabelQueue {
  private readonly tails = new Map<string, Promise<unknown>>()

  constructor(private readonly ctx: MainContext) {}

  enqueue(noteId: string, write: LabelWrite): Promise<LabelWriteResult> {
    const prev = this.tails.get(noteId) ?? Promise.resolve()
    const run = prev.then(() => this.run(noteId, write))
    const tail = run.catch(() => undefined)
    this.tails.set(noteId, tail)
    void tail.then(() => {
      if (this.tails.get(noteId) === tail) this.tails.delete(noteId)
    })
    return run
  }

  async idle(noteId: string): Promise<void> {
    while (this.tails.has(noteId)) await this.tails.get(noteId)
  }

  private async run(noteId: string, write: LabelWrite): Promise<LabelWriteResult> {
    const store = getTranscriptionManager(this.ctx).store
    const chunks = await store.getTranscript(noteId)
    if (write.passId !== undefined && write.kind !== 'diarization' && currentPassId(chunks) !== write.passId) {
      log('info', 'speakers:label-write-stale', { noteId, kind: write.kind, why: 'pass' })
      return write.kind === 'job' || write.kind === 'relabel' ? { status: 'dropped' } : { status: 'stale', why: 'pass' }
    }
    if (write.voiceGen !== undefined && write.voiceGen !== voiceGeneration().current()) {
      log('info', 'speakers:label-write-stale', { noteId, kind: write.kind, why: 'voice' })
      return { status: 'stale', why: 'voice' }
    }
    const patches = write.patch(chunks)
    if (patches === null) {
      log('info', 'speakers:label-write-dropped', { noteId, kind: write.kind })
      return { status: 'dropped' }
    }
    const revised = applyChunkPatches(chunks, patches)
    if (revised.length) await store.publishRevisions(noteId, revised)
    if (write.commit) await write.commit(revised)
    return { status: 'written', chunks: revised.length }
  }
}

let queue: NoteLabelQueue | null = null

/** The app-wide queue. */
export function labelQueue(ctx: MainContext): LabelQueue {
  if (!queue) queue = new NoteLabelQueue(ctx)
  return queue
}
