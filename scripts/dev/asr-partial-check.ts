// SPDX-License-Identifier: Apache-2.0
// Dev-only check for the local engine's live-line cadence, window and splice
// (src/main/asr/vad.ts, partials.ts). Feeds synthetic 16 kHz audio to the pure segmenter
// and synthetic word timings to the splice; no app, no model.
// Run: node scripts/dev/asr-partial-check.ts   (Node's type stripping; exits 1 on a failure)

import {
  partialDue,
  partialWindow,
  PARTIAL_WINDOW_MS,
  splicePartial,
  SPLICE_GUARD_MS
} from '../../src/main/asr/partials.ts'
import type { AsrWorkerWord } from '../../src/main/asr/protocol.ts'
import { HOP_SAMPLES, PARTIAL_EVERY_HOPS, SAMPLE_RATE, Segmenter, type Segment } from '../../src/main/asr/vad.ts'

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`)
}

// ---------- the segmenter: 1 s of silence, then 30 s of continuous speech ----------

/** A loud voiced tone with a 4 Hz syllable envelope that never dips under the gate. */
function render(seconds: number, speechFrom: number): Float32Array {
  const out = new Float32Array(Math.round(seconds * SAMPLE_RATE))
  for (let i = 0; i < out.length; i++) {
    const t = i / SAMPLE_RATE
    if (t < speechFrom) continue
    const env = 0.6 + 0.4 * Math.abs(Math.sin(2 * Math.PI * 4 * t))
    out[i] = 0.2 * env * Math.sin(2 * Math.PI * 180 * t)
  }
  return out
}

const audio = render(31, 1)
const partials: { seg: Segment; hop: number }[] = []
const finals: Segment[] = []
let hopsFed = 0
const segmenter = new Segmenter({
  final: (s) => finals.push(s),
  partial: (s) => partials.push({ seg: s, hop: hopsFed })
})
// One hop per push so each offer is stamped with the hop it came on.
for (let at = 0; at < audio.length; at += HOP_SAMPLES) {
  hopsFed++
  segmenter.push(audio.subarray(at, at + HOP_SAMPLES))
}
segmenter.flush()

const first = finals[0]
const firstId = first?.id
const own = partials.filter((p) => p.seg.id === firstId)
check('one 25 s segment closes at the cap', !!first && first.samples.length >= 25 * SAMPLE_RATE && first.samples.length < 25 * SAMPLE_RATE + HOP_SAMPLES,
  `${first ? (first.samples.length / SAMPLE_RATE).toFixed(2) : '-'} s`)

// a) cadence
const gaps = own.slice(1).map((p, i) => p.hop - (own[i] as { hop: number }).hop)
check('a) partial offers are at least 62 hops apart', PARTIAL_EVERY_HOPS === 62 && gaps.every((g) => g >= 62), `gaps ${[...new Set(gaps)].join(',')}`)
check('a) 11-12 partial offers in the segment', own.length >= 11 && own.length <= 12, `${own.length}`)

// b) and c) the Parakeet window
const windows = own.map((p) => partialWindow(p.seg, 'parakeet', SAMPLE_RATE))
const maxWindow = Math.max(...windows.map((w) => w.samples.length))
check('b) every Parakeet window is at most 8 s + one hop', maxWindow <= (PARTIAL_WINDOW_MS / 1000) * SAMPLE_RATE + HOP_SAMPLES, `${(maxWindow / SAMPLE_RATE).toFixed(2)} s`)
check('b) each window ends at the snapshot\'s end',
  own.every((p, i) => {
    const w = windows[i] as { startSample: number; samples: Float32Array }
    return w.startSample + w.samples.length === p.seg.startSample + p.seg.samples.length
  }))
const totalS = windows.reduce((s, w) => s + w.samples.length, 0) / SAMPLE_RATE
const wholeS = own.reduce((s, p) => s + p.seg.samples.length, 0) / SAMPLE_RATE
check('c) partial audio for the 25 s segment is at most 90 s', totalS <= 90, `${totalS.toFixed(1)} s windowed, ${wholeS.toFixed(1)} s whole`)
const whisperS = own.reduce((s, p) => s + partialWindow(p.seg, 'whisper', SAMPLE_RATE).samples.length, 0) / SAMPLE_RATE
check('c) Whisper still reads the whole open segment', whisperS === wholeS)

// d) the final is the whole segment
const firstOffer = own[0]?.seg
const audioAt = first ? audio.subarray(first.startSample, first.startSample + first.samples.length) : new Float32Array(0)
check('d) the final starts where the segment\'s partials start', !!first && !!firstOffer && first.startSample === firstOffer.startSample)
check('d) the final\'s samples are the whole segment',
  !!first && audioAt.length === first.samples.length && audioAt.every((v, i) => v === first.samples[i]) &&
    first.samples.length >= (own[own.length - 1]?.seg.samples.length ?? Infinity))

// ---------- e) the floor ----------

check('e) 1,999 ms after the last start: not due', !partialDue(10_000, 11_999, 'parakeet'))
check('e) 2,000 ms after the last start: due', partialDue(10_000, 12_000, 'parakeet'))
check('e) Whisper at 2,999 ms: not due', !partialDue(10_000, 12_999, 'whisper'))
check('e) Whisper at 3,000 ms: due', partialDue(10_000, 13_000, 'whisper'))
check('e) a fresh session is due at once', partialDue(0, 5_000, 'parakeet'))

// ---------- f) the splice ----------

const w = (word: string, s: number, e: number): AsrWorkerWord => ({ w: word, s_ms: s * 1000, e_ms: e * 1000 })
const text = (r: ReturnType<typeof splicePartial>): string => (r === 'whole-segment' ? r : r.words.map((x) => x.w).join(' '))
const prev = { words: [w('a', 0, 0.4), w('b', 0.5, 0.9), w('c', 6.8, 7.3)], endMs: 9_000 }
const decoded = [w('d', 6.8, 7.2), w('e', 7.0, 7.5)]
// A window starting at 6 s puts the cut at 7 s.
const windowStart = 7_000 - SPLICE_GUARD_MS
const spliced = splicePartial(prev, decoded, true, windowStart, 0)
check('f) previous a, b, c kept; d dropped, e kept: a b c e', text(spliced) === 'a b c e', text(spliced))
check('f) the seam never repeats or skips a start', spliced !== 'whole-segment' &&
  spliced.words.every((x, i, all) => i === 0 || x.s_ms >= (all[i - 1] as AsrWorkerWord).s_ms))
const atZero = splicePartial(prev, decoded, true, 0, 0)
check('f) a window at the segment\'s start returns the decode unchanged',
  atZero !== 'whole-segment' && !atZero.spliced && JSON.stringify(atZero.words) === JSON.stringify(decoded))
check('f) an untimed decode: whole segment', splicePartial(prev, decoded, false, windowStart, 0) === 'whole-segment')
check('f) no earlier line: whole segment', splicePartial(null, decoded, true, windowStart, 0) === 'whole-segment')
check('f) an earlier line short of the seam: whole segment',
  splicePartial({ ...prev, endMs: 7_500 }, decoded, true, windowStart, 0) === 'whole-segment')

// A long monologue: words every 0.5 s, each partial decoded from its 8 s window only, spliced
// onto the last. Every word of the segment so far appears once, in order.
{
  const all = Array.from({ length: 50 }, (_, i) => w(`w${i}`, i * 0.5, i * 0.5 + 0.4))
  let live: { words: AsrWorkerWord[]; endMs: number } | null = null
  let ok = true
  for (let endS = 2; endS <= 25; endS += 2) {
    const endMs = endS * 1000
    const startMs = Math.max(0, endMs - PARTIAL_WINDOW_MS)
    // The window's edge splits the word under it: its decode starts at the edge.
    const dec = all
      .filter((x) => x.e_ms > startMs && x.s_ms < endMs)
      .map((x) => (x.s_ms < startMs ? { ...x, w: `${x.w}-cut`, s_ms: startMs } : x))
    const r = splicePartial(live, dec, true, startMs, 0)
    if (r === 'whole-segment') {
      ok = false
      break
    }
    const want = all.filter((x) => x.s_ms < endMs).map((x) => x.w).join(' ')
    if (r.words.map((x) => x.w).join(' ') !== want) ok = false
    live = { words: r.words, endMs }
  }
  check('f) a 25 s monologue spliced every 2 s keeps every word once', ok)
}

if (failures) {
  console.log(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nall checks passed')
