// SPDX-License-Identifier: Apache-2.0
// Word learning from the user's corrections (`dictation.learnWords`, on by default).
//
// - Learning reads the field after a paste whenever it is on, with or without screen context;
//   that reading stays on this computer (./observe.ts).
// - Candidates come from a word diff of the watched field, inside the pasted words only
//   (./edits.ts): each changed span is at most 4 words on either side and at most 200
//   characters on the typed side; spans equal after normalising, known forms and one-word
//   rewordings are skipped. Forms with capitals rank first; at most 4 are kept.
// - LLM purpose `dictation-learn` (the user's provider or local model, temperature 0, 5 s)
//   decides, per candidate, whether the edit fixed the spelling of a name or term or was a
//   rewrite. An answer that doesn't decide every candidate exactly once is dropped whole.
// Only the changed words go to the model, never the text around them; nothing is sent without
// one set up.

import { DICTATION_LIMITS as L, normaliseTerm, validTerm, type DictationTerm } from '@shared/types/dictation'
import type { MainContext } from '../context'
import { currentProvider } from '../llm/registry'
import { MAX_TOKENS } from '../llm/types'
import { log } from '../log'
import { candidates as pick, type Candidate } from './edits'

/** Learning candidates from the watched edit (./edits.ts), at most 4. */
export function candidates(before: readonly string[], after: readonly string[], pasted: [number, number], known: readonly DictationTerm[]): Candidate[] {
  return pick(before, after, pasted, {
    spanWords: L.learnSpanWords,
    spanChars: L.learnSpanChars,
    max: L.learnMaxCandidates,
    known: new Set(known.map((t) => t.id)),
    normalise: normaliseTerm,
    valid: validTerm
  })
}

const SYSTEM = `You help a voice typing tool learn how its user spells names and special terms.

The tool typed some text, and the user then edited it. You get the user's edits as numbered items: the words the tool typed and the words the user changed them to. You never see the rest of the text.

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
    .map((c, i) => `<item number="${i + 1}">\n<typed>${escape(c.from)}</typed>\n<edited>${escape(c.to)}</edited>\n</item>`)
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
