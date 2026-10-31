// SPDX-License-Identifier: Apache-2.0
// Word learning from the user's corrections (`dictation.learnWords`, on by default).
//
// - Candidates come from a word diff of the watched field (./observe.ts), inside the pasted
//   words only. Each changed span is at most 4 words on either side and at most 200 characters
//   on the original side. Spans equal after normalising are skipped, and so are new forms that
//   are already a live or removed term. Forms with capitals rank first; at most 4 are kept.
// - LLM purpose `dictation-learn` (the user's provider or local model, temperature 0, 5 s)
//   decides, per candidate, whether the edit fixed the spelling of a name or term or was a
//   rewrite. An answer that doesn't decide every candidate exactly once is dropped whole.
// Only the changed spans and their sentence go to the model; nothing is sent without one set up.

import { DICTATION_LIMITS as L, normaliseTerm, validTerm, type DictationTerm } from '@shared/types/dictation'
import type { MainContext } from '../context'
import { currentProvider } from '../llm/registry'
import { MAX_TOKENS } from '../llm/types'
import { log } from '../log'

export interface Candidate {
  from: string
  to: string
  /** The edited sentence around the change, for the model. */
  around: string
}

const strip = (w: string): string => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')

/** Changed spans between two word lists (longest common subsequence). */
export function wordDiff(a: readonly string[], b: readonly string[]): { a: [number, number]; b: [number, number] }[] {
  const n = a.length
  const m = b.length
  // Fields are clipped by the helper, so the table stays small (≤ ~800 × 800).
  const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!)
  const spans: { a: [number, number]; b: [number, number] }[] = []
  let i = 0
  let j = 0
  let open: { a: number; b: number } | null = null
  const close = (): void => {
    if (open && (open.a < i || open.b < j)) spans.push({ a: [open.a, i], b: [open.b, j] })
    open = null
  }
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      close()
      i++
      j++
    } else {
      open ??= { a: i, b: j }
      if (j < m && (i >= n || dp[i]![j + 1]! >= dp[i + 1]![j]!)) j++
      else i++
    }
  }
  close()
  return spans
}

/** Learning candidates from the watched edit, at most 4, capitalised forms first. */
export function candidates(before: readonly string[], after: readonly string[], pasted: [number, number], known: readonly DictationTerm[]): Candidate[] {
  const knownIds = new Set(known.map((t) => t.id))
  const out: Candidate[] = []
  const seen = new Set<string>()
  for (const span of wordDiff(before, after)) {
    if (span.a[0] < pasted[0] || span.a[1] > pasted[1]) continue
    const fromWords = before.slice(span.a[0], span.a[1])
    const toWords = after.slice(span.b[0], span.b[1])
    if (!fromWords.length || !toWords.length) continue
    if (fromWords.length > L.learnSpanWords || toWords.length > L.learnSpanWords) continue
    const from = fromWords.join(' ')
    if (from.length > L.learnSpanChars) continue
    const to = toWords.map(strip).join(' ').trim()
    if (!validTerm(to)) continue
    const id = normaliseTerm(to)
    if (normaliseTerm(fromWords.map(strip).join(' ')) === id || knownIds.has(id) || seen.has(id)) continue
    seen.add(id)
    out.push({ from: fromWords.map(strip).join(' '), to, around: after.slice(Math.max(0, span.b[0] - 8), span.b[1] + 8).join(' ') })
  }
  return out.sort((x, y) => Number(/\p{Lu}/u.test(y.to)) - Number(/\p{Lu}/u.test(x.to))).slice(0, L.learnMaxCandidates)
}

const SYSTEM = `You help a voice typing tool learn how its user spells names and special terms.

The tool typed some text, and the user then edited it. You get the user's edits as numbered items: the words the tool typed, the words the user changed them to, and the edited text around them.

For each item decide:
- "spelling": the user fixed how a name, product, place, acronym or special term is written, and the new form is worth remembering (for example rachel → Rachael, cooper netties → Kubernetes).
- "rewrite": anything else: a different word chosen, a grammar or style change, a fix of a common word, added or removed content.

Reply with JSON only, no other text: an array with one object per item, {"item": <number>, "verdict": "spelling" | "rewrite"}. Decide every item exactly once.`

const escape = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** The forms the model accepted as spellings; [] on any doubt (timeout, no model, a partial answer). */
export async function judge(ctx: MainContext, list: readonly Candidate[]): Promise<string[] | null> {
  if (!list.length) return []
  const provider = await currentProvider(ctx.settings, ctx.secrets)
  const avail = await provider.available()
  if (!avail.ok) return null
  const user = list
    .map((c, i) => `<item number="${i + 1}">\n<typed>${escape(c.from)}</typed>\n<edited>${escape(c.to)}</edited>\n<context>${escape(c.around)}</context>\n</item>`)
    .join('\n')
  let text = ''
  let stop: string | null = null
  try {
    for await (const ev of provider.stream(
      { purpose: 'dictation-learn', system: SYSTEM, user, maxTokens: MAX_TOKENS['dictation-learn'], temperature: 0 },
      AbortSignal.timeout(L.learnTimeoutMs)
    )) {
      if (ev.type === 'text') text += ev.delta
      else stop = ev.reason
    }
  } catch (err) {
    log('info', 'dictation:learn-failed', { reason: err instanceof Error ? err.name : 'error' })
    return []
  }
  if (stop !== 'end') return []
  let parsed: unknown
  try {
    parsed = JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''))
  } catch {
    log('info', 'dictation:learn-failed', { reason: 'unparseable' })
    return []
  }
  if (!Array.isArray(parsed) || parsed.length !== list.length) return []
  const verdicts = new Map<number, string>()
  for (const v of parsed) {
    const item = Number((v as { item?: unknown })?.item)
    const verdict = (v as { verdict?: unknown })?.verdict
    if (!Number.isInteger(item) || item < 1 || item > list.length || verdicts.has(item)) return []
    if (verdict !== 'spelling' && verdict !== 'rewrite') return []
    verdicts.set(item, verdict)
  }
  return list.filter((_, i) => verdicts.get(i + 1) === 'spelling').map((c) => c.to)
}
