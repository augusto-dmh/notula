// SPDX-License-Identifier: Apache-2.0
// Speaker turns and the label mode, shared by
// the transcript view, the AI note prompts and chat's transcript windows. Pure: no
// Electron and no Node built-ins. Every consumer reads speaker names through this layer.
//
// Chunk-level (the default): consecutive chunks of one speaker, source and session
// form a turn, labelled Me (microphone), Them (system) or an attributed name. Turns
// never merge across sessions, so a pause and resume start a new turn.
//
// Word-level (diarization on, words that carry speaker labels, or a pass the job has written):
// each word of a chunk with word details takes a label, in priority order:
//   1. a user-confirmed name (`confirmed_spk`);
//   2. the post-meeting job's name (`auto_spk`), except on a word whose `att` names a
//      different person's individual tile: that word keeps its `att`;
//   3. an attribution name, the word's `att`, else the chunk's `detected_speaker_name`, only
//      while the chunk has no `named_pass` equal to its `mergeScopeId` (capturing, or the job
//      hasn't written yet), or on a word of a confirmed cluster, or on an auto cluster's
//      exception word (rule 2);
//   4. the local diarization label `r<N>` (a chunk with local labels never falls back to
//      the provider's);
//   5. the provider's speaker.
// So once the job has written, a suggest, tie or none speaker shows its letter in prompts,
// the API and exports: a suggestion ("Ana?") lives only in the suggestion rows and the pill
//. A cluster is confirmed when more than 50 % of its word time carries
// `confirmed_spk`, and auto when its words carry `auto_spk`; only those two count as named,
// never `att` or a single confirmed word. An old note's `diarization`-source
// `Speaker <digits>` chunk name counts as no name.
// Unlabelled runs take their neighbours' label when both agree. Identities are
// lettered in order of first appearance (A … Z, AA, AB …). An identity with < 10 s on a
// source where another has ≥ 10 s is suppressed, and after the meeting AssemblyAI
// "flicker" identities are too; a suppressed word with no name shows Unattributed.
// On the microphone, a single local voice with < 1 % cross-source overlap, or a voice
// holding ≥ 90 % of the mic words, is the owner: Me. A name shared by two
// identities shows as "Name (Speaker X)".
//
// Word-level turns are used whenever any word carries `confirmed_spk`, `auto_spk`, `att` or a
// provider `spk` label (a confirmed name, attribution word labels, or an imported recording's
// provider labels), or a chunk's pass has the job's decision written (`named_pass`), as well as
// when the caller asks for them (diarization on). In chunk-level turns too, a decided chunk is
// Me or Them, never its `detected_speaker_name`.

import type { AudioSource, IsoTime } from '../types/common'
import type { SpeakerAutoSource, SpeakerBand } from '../types/speakers'
import {
  DELETED_CHUNK_MARKER,
  SPEAKER_LABEL_ME,
  SPEAKER_LABEL_THEM,
  SPEAKER_UNATTRIBUTED,
  type SpeakerNameSuggestion,
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
/** The retired voiceprint pass's placeholder. */
const LEGACY_SPEAKER_N = /^Speaker \d+$/
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
  if (!name || name === 'You') return null
  // An old note's `Speaker N` from the retired voiceprint pass is no name.
  if (c.detectedSpeaker?.source === 'diarization' && LEGACY_SPEAKER_N.test(name)) return null
  return name
}

function chunkLabel(c: TranscriptChunk): string {
  return attributedName(c) ?? (c.source === 'microphone' ? SPEAKER_LABEL_ME : SPEAKER_LABEL_THEM)
}

/** The job has written its decision for this chunk's pass. */
function decided(c: TranscriptChunk): boolean {
  const d = c.providerDetails
  return !!d?.named_pass && d.named_pass === d.mergeScopeId
}

/** Case- and accent-insensitive equality of two names. */
export function sameSpeakerName(a: string, b: string): boolean {
  const n = (s: string): string => s.normalize('NFD').replace(/\p{M}/gu, '').trim().toLowerCase()
  return n(a) === n(b)
}

/** True when some word carries a label that needs word-level turns (see the header). */
export function hasWordLabels(chunks: TranscriptChunk[]): boolean {
  return chunks.some((c) =>
    c.providerDetails?.words.some((w) => w.confirmed_spk !== undefined || w.auto_spk !== undefined || w.att !== undefined || w.spk !== undefined)
  )
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

/**
 * The note's current diarization pass: the `mergeScopeId` on the most final words (ties: the
 * smaller id), or null for a note without a pass. Naming sends it as `passId`. The same rule
 * as the label-write queue's staleness check.
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

/** The pass of a local identity key `r:<pass>:r<N>`; null for a provider key. */
export function identityPassId(identityKey: string): string | null {
  if (!identityKey.startsWith('r:')) return null
  const end = identityKey.lastIndexOf(':')
  return end > 2 ? identityKey.slice(2, end) : null
}

/** One spoken unit: a word of a chunk with word details, or a whole chunk without them. */
interface Item {
  chunk: TranscriptChunk
  text: string
  startMs: number
  endMs: number
  /** A fixed label (a name, or Me/Them for a chunk without word details). Set by `resolveNames` for words. */
  fixed: string | null
  /** Where a fixed name came from: the user's confirmation, the job, or attribution. */
  fixedBy: 'user' | 'auto' | 'attribution' | 'chunk' | null
  /** The word's own `confirmed_spk` / `auto_spk`, and its live name (`att`, else the chunk's). */
  user: string | null
  userPid: string | null
  auto: string | null
  autoPid: string | null
  autoSrc: SpeakerAutoSource | null
  att: string | null
  live: string | null
  /** The chunk's pass has the job's decision written. */
  decided: boolean
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
      // Once the job has written, a chunk's live name no longer prints: it is Me or Them.
      const isDecided = decided(c)
      const fixedName = isDecided ? null : name
      out.push({
        chunk: c,
        text: c.text.trim(),
        startMs: Date.parse(c.start_timestamp),
        endMs: Date.parse(c.end_timestamp),
        fixed: fixedName ?? (c.source === 'microphone' ? SPEAKER_LABEL_ME : SPEAKER_LABEL_THEM),
        fixedBy: fixedName ? 'attribution' : 'chunk',
        user: null,
        userPid: null,
        auto: null,
        autoPid: null,
        autoSrc: null,
        att: null,
        live: fixedName,
        decided: isDecided,
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
    const isDecided = decided(c)
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
      const auto = w.auto_spk?.trim() || null
      const att = w.att?.trim() || null
      const live = att ?? name
      out.push({
        chunk: c,
        text,
        startMs: d.wallClockAnchorMs + w.s_ms,
        endMs: d.wallClockAnchorMs + w.e_ms,
        fixed: null,
        fixedBy: null,
        user,
        userPid: user ? w.confirmed_pid?.trim() || null : null,
        auto,
        autoPid: auto ? w.auto_pid?.trim() || null : null,
        autoSrc: auto ? (w.auto_src ?? null) : null,
        att,
        live,
        decided: isDecided,
        identity,
        // A word whose live name no longer prints (the job has written) may take its neighbours' label.
        fillable: identity === null && !user && !auto && !(live && !isDecided),
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

/** Whether a cluster is named: confirmed (> 50 % of its word time), auto, or neither. */
export type SpeakerClusterState = 'confirmed' | 'auto' | 'unnamed'

interface Identity {
  key: string
  source: AudioSource
  speechMs: number
  words: Item[]
  state: SpeakerClusterState
  /** The confirmed name (the most-confirmed one) or the auto name. */
  name: string | null
  personId: string | null
  autoSource: SpeakerAutoSource | null
}

/** A word's weight for the > 50 % rule: its word time, at least 1 ms. */
function wordMs(it: Item): number {
  return Math.max(1, it.endMs - it.startMs)
}

function identities(list: Item[]): Map<string, Identity> {
  const out = new Map<string, Identity>()
  for (const it of list) {
    if (!it.identity) continue
    let id = out.get(it.identity)
    if (!id) {
      id = { key: it.identity, source: it.chunk.source, speechMs: 0, words: [], state: 'unnamed', name: null, personId: null, autoSource: null }
      out.set(it.identity, id)
    }
    id.words.push(it)
    if (it.chunk.is_final) id.speechMs += Math.max(0, it.endMs - it.startMs)
  }
  for (const id of out.values()) classify(id)
  return out
}

/** Confirmed when > 50 % of the cluster's word time carries `confirmed_spk`; else auto when its words carry `auto_spk`. */
function classify(id: Identity): void {
  let total = 0
  const confirmed = new Map<string, { ms: number; pid: string | null }>()
  const auto = new Map<string, { n: number; pid: string | null; src: SpeakerAutoSource | null }>()
  for (const w of id.words) {
    const ms = wordMs(w)
    total += ms
    if (w.user) {
      const c = confirmed.get(w.user) ?? { ms: 0, pid: w.userPid }
      c.ms += ms
      confirmed.set(w.user, c)
    } else if (w.auto) {
      const a = auto.get(w.auto) ?? { n: 0, pid: w.autoPid, src: w.autoSrc }
      a.n++
      auto.set(w.auto, a)
    }
  }
  const confirmedMs = [...confirmed.values()].reduce((s, c) => s + c.ms, 0)
  if (confirmedMs * 2 > total) {
    const [name, c] = [...confirmed.entries()].sort((a, b) => b[1].ms - a[1].ms)[0] as [string, { ms: number; pid: string | null }]
    id.state = 'confirmed'
    id.name = name
    id.personId = c.pid
    return
  }
  const top = [...auto.entries()].sort((a, b) => b[1].n - a[1].n)[0]
  if (top) {
    id.state = 'auto'
    id.name = top[0]
    id.personId = top[1].pid
    id.autoSource = top[1].src
  }
}

/**
 * The names a meeting app stamped on more than one cluster: one device shared by several
 * people, never an individual tile.
 */
function sharedTiles(list: Item[]): Set<string> {
  const byName = new Map<string, Set<string>>()
  for (const it of list) {
    if (!it.att || !it.identity) continue
    const set = byName.get(it.att) ?? new Set<string>()
    set.add(it.identity)
    byName.set(it.att, set)
  }
  return new Set([...byName].filter(([, s]) => s.size > 1).map(([n]) => n))
}

/** An `att` that names a different person's individual tile than the cluster's auto name. */
function keptAtt(att: string | null, autoName: string, shared: ReadonlySet<string>): att is string {
  return !!att && !att.startsWith(ROOM_PREFIX) && !shared.has(att) && !sameSpeakerName(att, autoName)
}

/** Each word's fixed label by priority (the first three rules; the last two are the identity's letter). */
function resolveNames(list: Item[], ids: Map<string, Identity>): void {
  const shared = sharedTiles(list)
  for (const it of list) {
    // A whole chunk without word details keeps its chunk label (set in `items`).
    if (it.fixedBy !== null) continue
    const id = it.identity ? ids.get(it.identity) : undefined
    if (it.user) {
      it.fixed = it.user
      it.fixedBy = 'user'
    } else if (it.auto) {
      if (keptAtt(it.att, it.auto, shared)) {
        it.fixed = it.att
        it.fixedBy = 'attribution'
      } else {
        it.fixed = it.auto
        it.fixedBy = 'auto'
      }
    } else if (it.live && (!it.decided || id?.state === 'confirmed')) {
      it.fixed = it.live
      it.fixedBy = 'attribution'
    } else if (id?.state === 'auto' && id.name && keptAtt(it.att, id.name, shared)) {
      // An auto cluster's exception word that carries no `auto_spk` of its own.
      it.fixed = it.att
      it.fixedBy = 'attribution'
    }
  }
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
  resolveNames(list, ids)
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
    return it.decided ? (it.chunk.source === 'microphone' ? SPEAKER_LABEL_ME : SPEAKER_LABEL_THEM) : chunkLabel(it.chunk)
  })
  return { labels, ids, owner, suppressed, letters, shared }
}

/** Consecutive units of one speaker, source and session form a turn, in the store's merge order. */
export function speakerTurns(chunks: TranscriptChunk[], opts: { wordLevel: boolean; live: boolean }): SpeakerTurn[] {
  const sorted = chunks.filter(visible).sort(compareChunks)
  // Word-level too once the job has written, so a non-auto speaker keeps its letter in every output.
  const wordLevel = opts.wordLevel || hasWordLabels(sorted) || sorted.some(decided)
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

/**
 * Each chunk's speaker under the label rules: the label of its first word's turn. For outputs that
 * stay per chunk (transcript reports), so a suggest, tie or none speaker goes out as its letter.
 */
export function chunkSpeakerLabels(chunks: TranscriptChunk[], opts: { wordLevel: boolean }): Map<string, string> {
  const out = new Map<string, string>()
  for (const t of speakerTurns(chunks, { wordLevel: opts.wordLevel, live: false })) {
    for (const id of t.chunkIds) if (!out.has(id)) out.set(id, t.label)
  }
  return out
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
export function wordIdentityKeys(chunks: readonly TranscriptChunk[]): Map<string, (string | null)[]> {
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
  /**
   * The identity's name when it is named: confirmed (> 50 % of its word time carries
   * `confirmed_spk`) or auto (`auto_spk`). Never from `att` or a single confirmed word.
   */
  name: string | null
  /** The name is a shared tile (one name over several identities). */
  sharedName: boolean
  isOwner: boolean
  suppressed: boolean
  /** The provider of the identity's words (AssemblyAI provider labels qualify for suggestions). */
  provider: string | null
  state: SpeakerClusterState
  /** The person behind the confirmed or auto name, when known. */
  personId: string | null
  /** What named an auto cluster; null otherwise. */
  autoSource: SpeakerAutoSource | null
  /** Final word time. */
  speechMs: number
  /** The first and last word times (wall-clock ms). A pending request stores the longest turn instead. */
  startMs: number
  endMs: number
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
  /** The turn's attributed, auto or confirmed name, if any. */
  name: string | null
  /** Where `name` came from: `user` (`confirmed_spk`), `auto` (`auto_spk`) or `attribution` (a live or kept `att`). */
  nameSource: 'user' | 'auto' | 'attribution' | null
  /** Mean provider speaker confidence over its provider-labelled words, or null. */
  speakerConfidence: number | null
}

/** Identities and word-level turns of a note's chunks (always word-level). */
export function speakerIdentities(chunks: readonly TranscriptChunk[], opts: { live: boolean }): { identities: SpeakerIdentity[]; turns: IdentityTurn[] } {
  const sorted = chunks.filter(visible).sort(compareChunks)
  const list = items(sorted, true)
  const a = analyze(list, opts.live)
  const out: SpeakerIdentity[] = []
  for (const id of a.ids.values()) {
    out.push({
      key: id.key,
      channel: id.source,
      labelStream: id.key.startsWith('r:') ? 'reconciled' : 'provider',
      letterLabel: a.letters.get(id.key) ?? null,
      name: id.name,
      sharedName: id.name !== null && a.shared.has(id.name),
      isOwner: id.key === a.owner,
      suppressed: a.suppressed.has(id.key),
      provider: id.words[0]?.provider ?? null,
      state: id.state,
      personId: id.personId,
      autoSource: id.autoSource,
      speechMs: id.speechMs,
      startMs: id.words.reduce((m, w) => Math.min(m, w.startMs), Number.POSITIVE_INFINITY),
      endMs: id.words.reduce((m, w) => Math.max(m, w.endMs), 0)
    })
  }
  const turns: IdentityTurn[] = []
  let cur: (IdentityTurn & { session: string; confSum: number; confN: number }) | null = null
  list.forEach((it, i) => {
    const label = a.labels[i] as string
    const key = it.identity
    const sameRun = cur && cur.identityKey === key && cur.label === label && cur.channel === it.chunk.source && cur.session === it.chunk.transcription_session_id
    if (!sameRun) {
      const named = it.fixed && it.fixedBy !== 'chunk'
      cur = {
        identityKey: key,
        label,
        channel: it.chunk.source,
        text: it.text,
        startMs: it.startMs,
        endMs: it.endMs,
        chunkIds: [it.chunk.id],
        name: named ? it.fixed : null,
        nameSource: named ? (it.fixedBy as 'user' | 'auto' | 'attribution') : null,
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

// ---------- the suggestion display ----------

/** How the pill and the who's-who row show a speaker. `soft`: a guess ("Ana?", "Ana or Bruno?"). */
export interface SpeakerDisplay {
  text: string
  /** `confirmed`, the cluster's band, or `pending` (a request waits for the person's agreement). */
  band: SpeakerBand | 'confirmed' | 'pending'
  soft: boolean
  /** The guessed names: one for suggest, two for a tie; empty otherwise. */
  guesses: string[]
}

type SuggestionView = Pick<SpeakerNameSuggestion, 'label' | 'name' | 'band' | 'candidates' | 'pending'>

/** A suggestion row as its guess: "Ana?", "Ana or Bruno?", or its letter (none, pending). */
export function suggestionDisplay(row: SuggestionView): SpeakerDisplay {
  if (row.pending) return { text: row.label, band: 'pending', soft: false, guesses: [] }
  const names = row.candidates.map((c) => c.name.trim()).filter(Boolean)
  if (row.band === 'tie' && names.length >= 2) {
    const guesses = names.slice(0, 2)
    return { text: `${guesses[0]} or ${guesses[1]}?`, band: 'tie', soft: true, guesses }
  }
  const one = names[0] ?? row.name?.trim()
  if ((row.band === 'suggest' || row.band === 'tie') && one) return { text: `${one}?`, band: 'suggest', soft: true, guesses: [one] }
  return { text: row.label, band: 'none', soft: false, guesses: [] }
}

/**
 * The pill of one turn: a name prints as a name; a turn that shows its letter
 * takes its cluster's suggestion row ("Ana?", "Ana or Bruno?", pending), if any.
 */
export function turnDisplay(turn: IdentityTurn, identity: SpeakerIdentity | undefined, row: SuggestionView | undefined): SpeakerDisplay {
  const plain = (band: SpeakerDisplay['band']): SpeakerDisplay => ({ text: turn.label, band, soft: false, guesses: [] })
  if (turn.nameSource === 'user' || identity?.state === 'confirmed') return plain('confirmed')
  // An auto cluster's turns, its kept `att` turns included, print as names.
  if (turn.nameSource === 'auto' || identity?.state === 'auto') return plain('auto')
  // A live name (capturing, or no job wrote) prints as today.
  if (turn.name || !row) return plain(row?.pending ? 'pending' : (row?.band ?? 'none'))
  return suggestionDisplay({ ...row, label: turn.label })
}
