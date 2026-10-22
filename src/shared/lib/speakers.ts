// SPDX-License-Identifier: Apache-2.0
// Speaker turns and the label mode, shared by
// the transcript view, the AI note prompts and chat's transcript windows. Pure: no
// Electron and no Node built-ins.
//
// Chunk-level (the default): consecutive chunks of one speaker, source and session
// form a turn, labelled Me (microphone), Them (system) or an attributed name. Turns
// never merge across sessions, so a pause and resume start a new turn.
//
// Word-level (diarization on, or words that carry speaker labels): each word of a chunk
// with word details takes a label, in priority order:
//   1. a user-confirmed name (`confirmed_spk`);
//   2. an attribution name: the word's `att`, else the chunk's `detected_speaker_name`;
//   3. the local diarization label `r<N>` (a chunk with local labels never falls back to
//      the provider's);
//   4. the provider's speaker.
// Unlabelled runs take their neighbours' label when both agree. Identities are
// lettered in order of first appearance (A … Z, AA, AB …). An identity with < 10 s on a
// source where another has ≥ 10 s is suppressed, and after the meeting AssemblyAI
// "flicker" identities are too; a suppressed word with no name shows Unattributed.
// On the microphone, a single local voice with < 1 % cross-source overlap, or a voice
// holding ≥ 90 % of the mic words, is the owner: Me. A name shared by two
// identities shows as "Name (Speaker X)".
//
// Word-level turns are used whenever any word carries `confirmed_spk`, `att` or a provider
// `spk` label (a confirmed name, attribution word labels, or an imported recording's
// provider labels), as well as when the caller asks for them (diarization on).

import type { AudioSource, IsoTime } from '../types/common'
import {
  DELETED_CHUNK_MARKER,
  SPEAKER_LABEL_ME,
  SPEAKER_LABEL_THEM,
  SPEAKER_UNATTRIBUTED,
  type TranscriptChunk
} from '../types/transcript'

export interface SpeakerTurn {
  label: string
  source: AudioSource
  text: string
  startTimestamp: IsoTime
  endTimestamp: IsoTime
  chunkIds: string[]
  sessionId: string
}

export type LabelMode = 'named' | 'lettered' | 'me_others' | 'mic_only' | 'unlabeled'

const SUPPRESS_MIN_MS = 10_000
const FLICKER_MAX_MS = 30_000
const FLICKER_MIN_RUNS = 20
const FLICKER_RUN_GAP_MS = 2_000
const FLICKER_MAX_RUN_MS = 3_000
const FLICKER_MAX_CONF = 0.4
const OWNER_MAX_OVERLAP = 0.01
const OWNER_MIN_SHARE = 0.9
const SPEAKER_LETTERS = /^Speaker [A-Z]+$/
const ROOM_PREFIX = '[Room] '

function compareChunks(a: TranscriptChunk, b: TranscriptChunk): number {
  if (a.start_timestamp !== b.start_timestamp) return a.start_timestamp < b.start_timestamp ? -1 : 1
  if (a.end_timestamp !== b.end_timestamp) return a.end_timestamp < b.end_timestamp ? -1 : 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

function visible(c: TranscriptChunk): boolean {
  return c.text !== DELETED_CHUNK_MARKER && c.text.trim().length > 0
}

function attributedName(c: TranscriptChunk): string | null {
  const name = c.detected_speaker_name?.trim()
  return name && name !== 'You' ? name : null
}

function chunkLabel(c: TranscriptChunk): string {
  return attributedName(c) ?? (c.source === 'microphone' ? SPEAKER_LABEL_ME : SPEAKER_LABEL_THEM)
}

/** True when some word carries a label that needs word-level turns (see the header). */
export function hasWordLabels(chunks: TranscriptChunk[]): boolean {
  return chunks.some((c) => c.providerDetails?.words.some((w) => w.confirmed_spk !== undefined || w.att !== undefined || w.spk !== undefined))
}

/** 0 → A … 25 → Z, 26 → AA, 27 → AB …. */
export function speakerLetters(index: number): string {
  let n = index
  let out = ''
  do {
    out = String.fromCharCode(65 + (n % 26)) + out
    n = Math.floor(n / 26) - 1
  } while (n >= 0)
  return out
}

/** One spoken unit: a word of a chunk with word details, or a whole chunk without them. */
interface Item {
  chunk: TranscriptChunk
  text: string
  startMs: number
  endMs: number
  /** A fixed label (a name, or Me/Them for a chunk without word details). */
  fixed: string | null
  /** Where a fixed name came from: the user's confirmation, or attribution. */
  fixedBy: 'user' | 'attribution' | 'chunk' | null
  /** The identity key of a diarized or provider-labelled word. */
  identity: string | null
  /** Has word details but no label: may take its neighbours' label. */
  fillable: boolean
  provider: string | null
  spkConf: number | null
  /** The word's label came from the local diarization pass. */
  reconciled: boolean
}

function items(chunks: TranscriptChunk[], wordLevel: boolean): Item[] {
  const out: Item[] = []
  for (const c of chunks) {
    const d = c.providerDetails
    const name = attributedName(c)
    if (!wordLevel || !d?.words.length) {
      out.push({
        chunk: c,
        text: c.text.trim(),
        startMs: Date.parse(c.start_timestamp),
        endMs: Date.parse(c.end_timestamp),
        fixed: chunkLabel(c),
        fixedBy: name ? 'attribution' : 'chunk',
        identity: null,
        fillable: false,
        provider: d?.provider ?? null,
        spkConf: null,
        reconciled: false
      })
      continue
    }
    // A chunk with local labels never falls back to provider labels.
    const local = d.words.some((w) => w.merged_spk !== undefined)
    for (const w of d.words) {
      const text = w.w.trim()
      if (!text) continue
      let identity: string | null = null
      if (local) {
        if (w.merged_spk !== undefined) identity = `r:${d.mergeScopeId ?? ''}:${w.merged_spk}`
      } else if (w.spk !== undefined) {
        identity = `p:${c.transcription_session_id}:${c.source}:${w.spk}`
      }
      const user = w.confirmed_spk?.trim() || null
      const att = w.att?.trim() || null
      const fixed = user ?? att ?? name
      out.push({
        chunk: c,
        text,
        startMs: d.wallClockAnchorMs + w.s_ms,
        endMs: d.wallClockAnchorMs + w.e_ms,
        fixed,
        fixedBy: user ? 'user' : fixed ? 'attribution' : null,
        identity,
        fillable: !fixed && identity === null,
        provider: d.provider,
        spkConf: typeof w.spk_conf === 'number' ? w.spk_conf : null,
        reconciled: local && w.merged_spk !== undefined
      })
    }
  }
  return out
}

/** A run of unlabelled words takes its neighbours' label when both agree, on one source. */
function fillNeighbours(list: Item[]): void {
  let i = 0
  while (i < list.length) {
    if (!(list[i] as Item).fillable) {
      i++
      continue
    }
    let j = i
    while (j < list.length && (list[j] as Item).fillable) j++
    const before = list[i - 1]
    const after = list[j]
    const source = (list[i] as Item).chunk.source
    if (
      before?.identity &&
      after?.identity &&
      before.identity === after.identity &&
      before.chunk.source === source &&
      after.chunk.source === source
    ) {
      for (let k = i; k < j; k++) (list[k] as Item).identity = before.identity
    }
    i = j
  }
}

interface Identity {
  key: string
  source: AudioSource
  speechMs: number
  words: Item[]
}

function identities(list: Item[]): Map<string, Identity> {
  const out = new Map<string, Identity>()
  for (const it of list) {
    if (!it.identity) continue
    let id = out.get(it.identity)
    if (!id) {
      id = { key: it.identity, source: it.chunk.source, speechMs: 0, words: [] }
      out.set(it.identity, id)
    }
    id.words.push(it)
    if (it.chunk.is_final) id.speechMs += Math.max(0, it.endMs - it.startMs)
  }
  return out
}

/** An AssemblyAI flicker identity, judged only after the meeting. */
function isFlicker(id: Identity): boolean {
  if (!id.key.startsWith('p:')) return false
  const words = id.words
  if (!words.every((w) => w.chunk.is_final && w.provider === 'assemblyai' && w.spkConf !== null)) return false
  if (id.speechMs < SUPPRESS_MIN_MS || id.speechMs > FLICKER_MAX_MS) return false
  // Protected: a name, attribution or user label keeps an identity visible.
  if (words.some((w) => w.fixed)) return false
  let runs = 0
  let runStart = 0
  let runEnd = Number.NEGATIVE_INFINITY
  let longest = 0
  for (const w of words) {
    if (w.startMs - runEnd >= FLICKER_RUN_GAP_MS) {
      if (runs) longest = Math.max(longest, runEnd - runStart)
      runs++
      runStart = w.startMs
    }
    runEnd = Math.max(runEnd, w.endMs)
  }
  if (runs) longest = Math.max(longest, runEnd - runStart)
  const conf = words.reduce((s, w) => s + (w.spkConf ?? 0), 0) / words.length
  return runs >= FLICKER_MIN_RUNS && longest <= FLICKER_MAX_RUN_MS && conf < FLICKER_MAX_CONF
}

function overlapMs(a: Item[], b: Item[]): number {
  let total = 0
  let j = 0
  const bs = [...b].sort((x, y) => x.startMs - y.startMs)
  for (const w of [...a].sort((x, y) => x.startMs - y.startMs)) {
    while (j < bs.length && (bs[j] as Item).endMs <= w.startMs) j++
    for (let k = j; k < bs.length && (bs[k] as Item).startMs < w.endMs; k++) {
      const o = bs[k] as Item
      total += Math.max(0, Math.min(w.endMs, o.endMs) - Math.max(w.startMs, o.startMs))
    }
  }
  return total
}

/** The microphone identity that is the note's owner, or null. */
function micOwner(ids: Map<string, Identity>, list: Item[]): string | null {
  const mic = [...ids.values()].filter((i) => i.source === 'microphone')
  if (!mic.length) return null
  const local = mic.filter((i) => i.key.startsWith('r:'))
  if (local.length === 1) {
    const voice = local[0] as Identity
    const system = list.filter((it) => it.chunk.source === 'system')
    const share = voice.speechMs > 0 ? overlapMs(voice.words, system) / voice.speechMs : 0
    if (share < OWNER_MAX_OVERLAP) return voice.key
  }
  const micWords = list.filter((it) => it.chunk.source === 'microphone').length
  const top = [...mic].sort((a, b) => b.words.length - a.words.length)[0]
  if (top && micWords > 0 && top.words.length / micWords >= OWNER_MIN_SHARE) return top.key
  return null
}

interface Analysis {
  labels: string[]
  ids: Map<string, Identity>
  owner: string | null
  suppressed: Set<string>
  letters: Map<string, string>
  /** Names shared by more than one identity (shown as "Name (Speaker X)"). */
  shared: Set<string>
}

function analyze(list: Item[], live: boolean): Analysis {
  fillNeighbours(list)
  const ids = identities(list)
  const suppressed = new Set<string>()
  for (const id of ids.values()) {
    const louder = [...ids.values()].some((o) => o !== id && o.source === id.source && o.speechMs >= SUPPRESS_MIN_MS)
    if (louder && id.speechMs < SUPPRESS_MIN_MS) suppressed.add(id.key)
    else if (!live && isFlicker(id)) suppressed.add(id.key)
  }
  const owner = micOwner(ids, list)
  // Letters in order of first appearance; the owner and suppressed ones take none.
  const letters = new Map<string, string>()
  for (const it of list) {
    const k = it.identity
    if (!k || letters.has(k) || k === owner || suppressed.has(k)) continue
    letters.set(k, `Speaker ${speakerLetters(letters.size)}`)
  }
  // A name shared by two identities shows as "Name (Speaker X)".
  const namesByIdentity = new Map<string, Set<string>>()
  for (const it of list) {
    if (!it.fixed || !it.identity) continue
    const set = namesByIdentity.get(it.fixed) ?? new Set<string>()
    set.add(it.identity)
    namesByIdentity.set(it.fixed, set)
  }
  const shared = new Set([...namesByIdentity.entries()].filter(([, s]) => s.size > 1).map(([n]) => n))
  const raw = list.map((it) => {
    if (it.fixed) {
      const letter = it.identity ? letters.get(it.identity) : undefined
      return shared.has(it.fixed) && letter ? `${it.fixed} (${letter})` : it.fixed
    }
    if (it.identity) {
      if (it.identity === owner) return SPEAKER_LABEL_ME
      if (suppressed.has(it.identity)) return SPEAKER_UNATTRIBUTED
      return letters.get(it.identity) ?? SPEAKER_UNATTRIBUTED
    }
    return ''
  })
  // Unlabelled words of a labelled chunk follow the nearest labelled word of that chunk;
  // a chunk with no labels at all keeps its source's default.
  const labels = raw.map((label, i) => {
    if (label) return label
    const it = list[i] as Item
    for (let k = i - 1; k >= 0 && (list[k] as Item).chunk === it.chunk; k--) if (raw[k]) return raw[k] as string
    for (let k = i + 1; k < list.length && (list[k] as Item).chunk === it.chunk; k++) if (raw[k]) return raw[k] as string
    return chunkLabel(it.chunk)
  })
  return { labels, ids, owner, suppressed, letters, shared }
}

/** Consecutive units of one speaker, source and session form a turn, in the store's merge order. */
export function speakerTurns(chunks: TranscriptChunk[], opts: { wordLevel: boolean; live: boolean }): SpeakerTurn[] {
  const sorted = chunks.filter(visible).sort(compareChunks)
  const wordLevel = opts.wordLevel || hasWordLabels(sorted)
  const list = items(sorted, wordLevel)
  const labels = wordLevel ? analyze(list, opts.live).labels : list.map((it) => it.fixed ?? chunkLabel(it.chunk))
  const turns: SpeakerTurn[] = []
  let cur: SpeakerTurn | null = null
  list.forEach((it, i) => {
    const label = labels[i] as string
    const c = it.chunk
    const startIso = new Date(it.startMs).toISOString()
    const endIso = new Date(it.endMs).toISOString()
    if (cur && cur.label === label && cur.source === c.source && cur.sessionId === c.transcription_session_id) {
      cur.text = `${cur.text} ${it.text}`
      if (cur.chunkIds[cur.chunkIds.length - 1] !== c.id) cur.chunkIds.push(c.id)
      if (endIso > cur.endTimestamp) cur.endTimestamp = endIso
      return
    }
    cur = {
      label,
      source: c.source,
      text: it.text,
      startTimestamp: startIso,
      endTimestamp: endIso,
      chunkIds: [c.id],
      sessionId: c.transcription_session_id
    }
    turns.push(cur)
  })
  return turns
}

/** How the turns are labelled, for the prompts' label instructions. */
export function labelMode(turns: SpeakerTurn[]): { mode: LabelMode; hasRoomLabels: boolean } {
  const labels = new Set(turns.map((t) => t.label))
  const generic = new Set([SPEAKER_LABEL_ME, SPEAKER_LABEL_THEM, SPEAKER_UNATTRIBUTED])
  const hasRoomLabels = [...labels].some((l) => l.startsWith(ROOM_PREFIX))
  let mode: LabelMode = 'unlabeled'
  if ([...labels].some((l) => !generic.has(l) && !SPEAKER_LETTERS.test(l))) mode = 'named'
  else if ([...labels].some((l) => SPEAKER_LETTERS.test(l))) mode = 'lettered'
  else if (labels.has(SPEAKER_LABEL_THEM)) mode = 'me_others'
  else if (labels.has(SPEAKER_LABEL_ME)) mode = 'mic_only'
  return { mode, hasRoomLabels }
}

// ---------- speaker identities, for name suggestions ----------

/**
 * Each chunk's per-word identity keys, aligned with `providerDetails.words` (null for a word
 * with no identity), after the neighbour fill: exactly the words a confirmed name
 * must cover so the whole identity shows it.
 */
export function wordIdentityKeys(chunks: TranscriptChunk[]): Map<string, (string | null)[]> {
  const sorted = chunks.filter(visible).sort(compareChunks)
  const list = items(sorted, true)
  fillNeighbours(list)
  const byChunk = new Map<string, (string | null)[]>()
  let cursor = 0
  for (const c of sorted) {
    const words = c.providerDetails?.words
    if (!words?.length) {
      // A chunk without words is one item in the list.
      cursor++
      continue
    }
    const keys: (string | null)[] = []
    for (const w of words) {
      if (!w.w.trim()) {
        keys.push(null)
        continue
      }
      keys.push((list[cursor] as Item | undefined)?.identity ?? null)
      cursor++
    }
    byChunk.set(c.id, keys)
  }
  return byChunk
}

/** One word-level speaker identity of a note. */
export interface SpeakerIdentity {
  /** `r:<scope>:<rN>` (local diarization) or `p:<session>:<source>:<spk>` (provider labels). */
  key: string
  channel: AudioSource
  labelStream: 'reconciled' | 'provider'
  /** `Speaker <letters>`; null for the owner (Me) and suppressed identities. */
  letterLabel: string | null
  /** A real name on the identity's words (user-confirmed or attributed), when there is one. */
  name: string | null
  /** The name is a shared tile (one name over several identities). */
  sharedName: boolean
  isOwner: boolean
  suppressed: boolean
  /** The provider of the identity's words (AssemblyAI provider labels qualify for suggestions). */
  provider: string | null
}

/** A word-level turn with the identity behind it (null for unlabelled words). */
export interface IdentityTurn {
  identityKey: string | null
  label: string
  channel: AudioSource
  text: string
  startMs: number
  endMs: number
  chunkIds: string[]
  /** The turn's attributed or confirmed name, if any. */
  name: string | null
  /** Mean provider speaker confidence over its provider-labelled words, or null. */
  speakerConfidence: number | null
}

/** Identities and word-level turns of a note's chunks (always word-level). */
export function speakerIdentities(chunks: TranscriptChunk[], opts: { live: boolean }): { identities: SpeakerIdentity[]; turns: IdentityTurn[] } {
  const sorted = chunks.filter(visible).sort(compareChunks)
  const list = items(sorted, true)
  const a = analyze(list, opts.live)
  const out: SpeakerIdentity[] = []
  for (const id of a.ids.values()) {
    const named = id.words.find((w) => w.fixed && w.fixedBy !== 'chunk')
    const name = named?.fixed ?? null
    out.push({
      key: id.key,
      channel: id.source,
      labelStream: id.key.startsWith('r:') ? 'reconciled' : 'provider',
      letterLabel: a.letters.get(id.key) ?? null,
      name,
      sharedName: name !== null && a.shared.has(name),
      isOwner: id.key === a.owner,
      suppressed: a.suppressed.has(id.key),
      provider: id.words[0]?.provider ?? null
    })
  }
  const turns: IdentityTurn[] = []
  let cur: (IdentityTurn & { session: string; confSum: number; confN: number }) | null = null
  list.forEach((it, i) => {
    const label = a.labels[i] as string
    const key = it.identity
    const sameRun = cur && cur.identityKey === key && cur.label === label && cur.channel === it.chunk.source && cur.session === it.chunk.transcription_session_id
    if (!sameRun) {
      cur = {
        identityKey: key,
        label,
        channel: it.chunk.source,
        text: it.text,
        startMs: it.startMs,
        endMs: it.endMs,
        chunkIds: [it.chunk.id],
        name: it.fixed && it.fixedBy !== 'chunk' ? it.fixed : null,
        speakerConfidence: null,
        session: it.chunk.transcription_session_id,
        confSum: 0,
        confN: 0
      }
      turns.push(cur)
    } else if (cur) {
      cur.text = `${cur.text} ${it.text}`
      if (cur.chunkIds[cur.chunkIds.length - 1] !== it.chunk.id) cur.chunkIds.push(it.chunk.id)
      cur.endMs = Math.max(cur.endMs, it.endMs)
    }
    // Provider confidence only, excluding reconciled and attributed words.
    if (cur && it.spkConf !== null && !it.reconciled && !it.fixed && key !== null && !a.suppressed.has(key)) {
      cur.confSum += it.spkConf
      cur.confN++
      cur.speakerConfidence = cur.confSum / cur.confN
    }
  })
  return {
    identities: out,
    turns: turns.map((t) => {
      const { session: _s, confSum: _c, confN: _n, ...rest } = t as IdentityTurn & { session: string; confSum: number; confN: number }
      return rest
    })
  }
}
