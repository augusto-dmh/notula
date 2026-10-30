// SPDX-License-Identifier: Apache-2.0
// Pure parts of the speaker bench's checks, kept apart from `bench-feed.ts` so the dev
// checks in `scripts/dev/` can drive them on synthetic notes. Dev only: only the bench feed
// imports this module, so a release build never emits it.
//
// - `contradictingMappings`: A7's mock reply. Every labelled cluster gets a candidate that
//   isn't its own person, one candidate per cluster (the gate drops a name given twice),
//   system clusters first, as only they can be named by the meeting app.
// - `lineLeaks`, `chunkLeaks`: A15. Which words of an unnamed cluster (one with a suggestion
//   row) an output prints under anything but the cluster's letter. Each output line is aligned
//   back to the note's words, so a name on another cluster's words (the owner's Me, or an auto
//   cluster's word that keeps another tile's name) is not counted against this one. A line
//   that can't be aligned still counts as a leak when it carries a row's suggested name that
//   no other cluster's words print; `unalignedShare` is the share A15 tolerates.

import { sameSpeakerName, speakerIdentities, wordIdentityKeys } from '@shared/lib/speakers'
import { DELETED_CHUNK_MARKER, type TranscriptChunk } from '@shared/types/transcript'

// ---------- A7: the contradicting reply ----------

export interface MockCluster {
  key: string
  /** `Speaker <letters>`. */
  label: string
  channel: 'mic' | 'system'
  speechMs: number
  /** The labelled person; null when the labels hold nobody for it. */
  truth: { name: string; email: string } | null
}

export interface MockCandidate {
  id: string
  name: string
  email: string
}

const fold = (s: string): string => s.normalize('NFD').replace(/\p{M}/gu, '').trim().toLowerCase()

/**
 * One candidate other than its own person for as many labelled clusters as the candidates
 * allow (a maximum matching), system clusters and longer speech first: a cluster placed
 * once keeps a candidate when a later one needs a swap.
 */
export function contradictingMappings(clusters: readonly MockCluster[], candidates: readonly MockCandidate[]): { key: string; label: string; candidate: MockCandidate }[] {
  const order = clusters
    .filter((c) => c.truth !== null)
    .sort((a, b) => (a.channel === b.channel ? 0 : a.channel === 'system' ? -1 : 1) || b.speechMs - a.speechMs || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  const allowed = (c: MockCluster, j: MockCandidate): boolean => {
    const t = c.truth
    if (!t) return false
    if (t.email && j.email && t.email.toLowerCase() === j.email.toLowerCase()) return false
    return fold(t.name) !== fold(j.name)
  }
  const owner = new Map<string, number>()
  const place = (i: number, seen: Set<string>): boolean => {
    for (const j of candidates) {
      if (seen.has(j.id) || !allowed(order[i] as MockCluster, j)) continue
      seen.add(j.id)
      const held = owner.get(j.id)
      if (held === undefined || place(held, seen)) {
        owner.set(j.id, i)
        return true
      }
    }
    return false
  }
  order.forEach((_, i) => place(i, new Set()))
  const out: { key: string; label: string; candidate: MockCandidate }[] = []
  for (const [id, i] of owner) {
    const c = order[i] as MockCluster
    out.push({ key: c.key, label: c.label, candidate: candidates.find((j) => j.id === id) as MockCandidate })
  }
  return out.sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0))
}

// ---------- A15: letters in what goes out ----------

/** A labelled line of a transcript output: the prompt's `Label: text`, a chat window's line. */
export interface OutputLine {
  label: string
  text: string
}

export interface LeakCount {
  /** Words of the unnamed clusters the output printed. */
  words: number
  /** Of those, the words printed under another label (not the letter, not a name the user confirmed on that word). */
  leaks: number
  /** Output tokens that could not be placed on a word of the note (a word a chat window cut, else none). */
  unaligned: number
  /** Output tokens read, placed or not (per-chunk outputs: entries). */
  tokens: number
}

/**
 * The unaligned share of an output's tokens A15 tolerates: a chat window cuts a turn with no
 * sentence end mid-word, which leaves the two pieces unaligned. The prompt and webhook outputs
 * print whole words, so they get none.
 */
export const CHAT_UNALIGNED_SHARE = 0.02

/** `Label: text` lines; anything else (a window's header, a gap line) is not a speaker line. */
export function labelledLines(text: string): OutputLine[] {
  const out: OutputLine[] = []
  for (const line of text.split('\n')) {
    const m = /^([^:\n]{1,80}): (.*)$/.exec(line)
    if (m) out.push({ label: (m[1] as string).trim(), text: m[2] as string })
  }
  return out
}

interface Word {
  text: string
  chunkId: string
  identity: string | null
  confirmed: string | null
}

function compareChunks(a: TranscriptChunk, b: TranscriptChunk): number {
  if (a.start_timestamp !== b.start_timestamp) return a.start_timestamp < b.start_timestamp ? -1 : 1
  if (a.end_timestamp !== b.end_timestamp) return a.end_timestamp < b.end_timestamp ? -1 : 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/** The note's words in the order the speaker turns print them, one entry per whitespace token. */
function noteWords(chunks: readonly TranscriptChunk[]): Word[] {
  const sorted = chunks.filter((c) => c.text !== DELETED_CHUNK_MARKER && c.text.trim().length > 0).sort(compareChunks)
  const keys = wordIdentityKeys(sorted)
  const out: Word[] = []
  for (const c of sorted) {
    const words = c.providerDetails?.words
    if (!words?.length) {
      for (const t of c.text.trim().split(/\s+/)) out.push({ text: t, chunkId: c.id, identity: null, confirmed: null })
      continue
    }
    const ks = keys.get(c.id) ?? []
    words.forEach((w, i) => {
      const text = w.w.trim()
      if (!text) return
      for (const t of text.split(/\s+/)) out.push({ text: t, chunkId: c.id, identity: ks[i] ?? null, confirmed: w.confirmed_spk?.trim() || null })
    })
  }
  return out
}

/** Each unnamed cluster's letter, for the row keys given. */
function lettersOf(chunks: readonly TranscriptChunk[], rowKeys: ReadonlySet<string>): Map<string, string> {
  const { identities } = speakerIdentities(chunks, { live: false })
  const out = new Map<string, string>()
  for (const i of identities) if (rowKeys.has(i.key) && i.state === 'unnamed' && i.letterLabel) out.set(i.key, i.letterLabel)
  return out
}

/**
 * The labels the note prints on words that aren't a row cluster's (an auto or the owner's name,
 * a kept tile name), and names the user confirmed on any word, folded: an unaligned line under
 * one of them may be any cluster's, so only another row name on it is surely a leak.
 */
function otherLabels(chunks: readonly TranscriptChunk[], rowKeys: ReadonlySet<string>): Set<string> {
  const out = new Set<string>()
  for (const t of speakerIdentities(chunks, { live: false }).turns) {
    if (t.identityKey && rowKeys.has(t.identityKey)) {
      if (t.nameSource === 'user' && t.name) out.add(fold(t.name))
      continue
    }
    out.add(fold(t.label))
    if (t.name) out.add(fold(t.name))
  }
  return out
}

/**
 * Row clusters whose words print a name anyway: an auto cluster (stale `auto_spk`) with a row
 * of this pass. `lettersOf` leaves them out of the word count, so A15 fails on them apart.
 */
export function namedRows(chunks: readonly TranscriptChunk[], rowKeys: ReadonlySet<string>): number {
  return speakerIdentities(chunks, { live: false }).identities.filter((i) => rowKeys.has(i.key) && i.state === 'auto').length
}

function tally(acc: LeakCount, w: Word, label: string, letters: ReadonlyMap<string, string>): void {
  const letter = w.identity ? letters.get(w.identity) : undefined
  if (!letter) return
  acc.words++
  // A confirmed word prints its confirmed name (with the letter when the name is shared).
  if (label !== letter && !(w.confirmed && sameSpeakerName(label.replace(/ \([^)]*\)$/, ''), w.confirmed))) acc.leaks++
}

/**
 * Prompt and chat outputs: each line's words are found in the note's words, in order (a line
 * is a run of consecutive words; an output may leave words out, never reorder them). A chat
 * window cuts a turn longer than a window mid-word when it has no sentence end, so a line may
 * start or end with a piece of a word: that piece is unaligned, the rest still counts. The
 * tokens of a line that can't be placed are leaks when its label is one of `rowNames` (the
 * rows' suggested names) and no other cluster's words print it.
 */
export function lineLeaks(
  chunks: readonly TranscriptChunk[],
  rowKeys: ReadonlySet<string>,
  lines: readonly OutputLine[],
  rowNames: readonly string[] = []
): LeakCount {
  const letters = lettersOf(chunks, rowKeys)
  const words = noteWords(chunks)
  const others = otherLabels(chunks, rowKeys)
  const named = new Set(rowNames.map(fold).filter((n) => !others.has(n)))
  const acc: LeakCount = { words: 0, leaks: 0, unaligned: 0, tokens: 0 }
  const lost = (label: string, n: number): void => {
    acc.unaligned += n
    if (n && named.has(fold(label))) {
      acc.words += n
      acc.leaks += n
    }
  }
  const find = (tokens: readonly string[], from: number): number => {
    const head = tokens.slice(0, 3)
    if (!head.length) return -1
    for (let p = from; p + head.length <= words.length; p++) if (head.every((t, i) => words[p + i]?.text === t)) return p
    return -1
  }
  let at = 0
  for (const line of lines) {
    let tokens = line.text.split(/\s+/).filter(Boolean)
    if (!tokens.length) continue
    acc.tokens += tokens.length
    let start = find(tokens, at)
    if (start < 0 && tokens.length > 1) {
      start = find(tokens.slice(1), at)
      if (start >= 0) {
        lost(line.label, 1)
        tokens = tokens.slice(1)
      }
    }
    if (start < 0) {
      lost(line.label, tokens.length)
      continue
    }
    let i = 0
    for (; i < tokens.length && words[start + i]?.text === tokens[i]; i++) tally(acc, words[start + i] as Word, line.label, letters)
    lost(line.label, tokens.length - i)
    at = start + i
  }
  return acc
}

/**
 * Per-chunk outputs (a webhook body's transcript): entry n is the n-th final chunk with text,
 * in the order given, and its speaker is the label of the chunk's first word.
 */
export function chunkLeaks(chunks: readonly TranscriptChunk[], rowKeys: ReadonlySet<string>, entries: readonly { speaker: string; text: string }[]): LeakCount {
  const letters = lettersOf(chunks, rowKeys)
  const first = new Map<string, Word>()
  for (const w of noteWords(chunks)) if (!first.has(w.chunkId)) first.set(w.chunkId, w)
  const finals = chunks.filter((c) => c.is_final && c.text.trim())
  const acc: LeakCount = { words: 0, leaks: 0, unaligned: 0, tokens: entries.length }
  entries.forEach((e, n) => {
    const c = finals[n]
    if (!c || c.text !== e.text) {
      acc.unaligned++
      return
    }
    const w = first.get(c.id)
    if (w) tally(acc, w, e.speaker, letters)
  })
  return acc
}
