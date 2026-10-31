// SPDX-License-Identifier: Apache-2.0
// Dev-only check for word learning's diff and candidates (src/main/dictation/edits.ts): feeds
// synthetic before / after field readings, cut the way the desk helper cuts them, through the
// same steps the paste watcher and learn.ts take. No helper, no model.
// Run: node scripts/dev/learn-check.ts   (Node's type stripping; exits 1 on a failure)

import { candidates, findDuplicate, pastedRange, readingWords, sameField, wordsOf, type Reading } from '../../src/main/dictation/edits.ts'
import { DICTATION_LIMITS as L, normaliseTerm, validTerm } from '../../src/shared/types/dictation.ts'

interface Case {
  name: string
  pasted: string
  /** The reading that first shows the paste, and the last one. */
  before: Reading
  after: Reading
  known?: string[]
  /** The learned forms expected, in order; [] = nothing to learn. */
  expect: string[]
  /** The after reading must still count as the same field (default true). */
  same?: boolean
}

const at = (before: string, after = '', selection = ''): Reading => ({ before, selection, after, cutBefore: false, cutAfter: false })

const CASES: Case[] = [
  {
    name: 'one letter fixed in a name',
    pasted: 'We met at the Giaconda gallery on Friday.',
    before: at('Notes from the trip. We met at the Giaconda gallery on Friday.'),
    after: at('Notes from the trip. We met at the Gioc', 'onda gallery on Friday.'),
    expect: ['Gioconda']
  },
  {
    name: 'a name retyped whole, the caret moved to the end of the line',
    pasted: 'Please forward this to rachel before noon.',
    before: at('Please forward this to rachel before noon.'),
    after: at('Please forward this to Rachael before noon.'),
    expect: ['Rachael']
  },
  {
    name: 'a sound-alike merged into one term',
    pasted: 'The cluster runs on cooper netties now.',
    before: at('The cluster runs on cooper netties now.'),
    after: at('The cluster runs on Kubernetes', ' now.'),
    expect: ['Kubernetes']
  },
  {
    name: 'a plain rewording learns nothing',
    pasted: 'I will send the draft tomorrow.',
    before: at('I will send the draft tomorrow.'),
    after: at('I will email', ' the draft tomorrow.'),
    expect: []
  },
  {
    name: 'a selection inside the field changes nothing',
    pasted: 'Call Marta about the lease.',
    before: at('Call Marta about the lease.'),
    after: at('Call ', ' about the lease.', 'Marta'),
    expect: []
  },
  {
    name: 'an edit outside the pasted words learns nothing',
    pasted: 'see you at the office',
    before: at('Hi Jon, see you at the office'),
    after: at('Hi Jonah, see you at the office'),
    expect: []
  },
  {
    name: 'a form already in the dictionary is skipped',
    pasted: 'Ask Shivaun for the slides.',
    before: at('Ask Shivaun for the slides.'),
    after: at('Ask Siobhan for the slides.'),
    known: ['siobhan'],
    expect: []
  },
  {
    name: 'the caret window moved: cut edge words drop, the fix still learns',
    pasted: 'the Giaconda gallery',
    before: { before: 'xtra words here and the Giaconda gallery', selection: '', after: ' then more', cutBefore: true, cutAfter: false },
    after: { before: 'ords here and the Gioc', selection: '', after: 'onda gallery then mo', cutBefore: true, cutAfter: true },
    expect: ['Gioconda']
  },
  {
    name: 'another field in the same window is not the same field',
    pasted: 'Thanks for the quick reply on the budget.',
    before: at('Hello team. Thanks for the quick reply on the budget. Best, Ana'),
    after: at('Budget review'),
    expect: [],
    same: false
  }
]

let failed = 0
const check = (ok: boolean, name: string, detail: string): void => {
  if (ok) console.log(`ok    ${name}`)
  else {
    failed++
    console.log(`FAIL  ${name}: ${detail}`)
  }
}

for (const c of CASES) {
  const pasted = wordsOf(c.pasted)
  const before = readingWords(c.before)
  const after = readingWords(c.after)
  const range = pastedRange(before, pasted)
  if (!range) {
    check(false, c.name, 'the pasted words are not in the first reading')
    continue
  }
  const same = sameField(before, range, after)
  const got = same
    ? candidates(before, after, range, {
        spanWords: L.learnSpanWords,
        spanChars: L.learnSpanChars,
        max: L.learnMaxCandidates,
        known: new Set(c.known ?? []),
        normalise: normaliseTerm,
        valid: validTerm
      }).map((x) => x.to)
    : []
  const sameOk = same === (c.same ?? true)
  const learnOk = got.length === c.expect.length && got.every((t, i) => t === c.expect[i])
  check(sameOk && learnOk, c.name, `same field ${same}, learned ${JSON.stringify(got)}, expected ${JSON.stringify(c.expect)}`)
}

// At most 4 candidates, capitalised forms first.
{
  const pasted = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet'
  const before = wordsOf(pasted)
  const after = wordsOf('Alfa bravo Charly delta Ekko foxtrot golff hotel Indya juliet')
  const got = candidates(before, after, [0, before.length], {
    spanWords: L.learnSpanWords,
    spanChars: L.learnSpanChars,
    max: L.learnMaxCandidates,
    known: new Set(),
    normalise: normaliseTerm,
    valid: validTerm
  })
  check(got.length === L.learnMaxCandidates && got.every((x) => /\p{Lu}/u.test(x.to)), 'at most 4 candidates, capitals first', JSON.stringify(got))
}

// The duplicate-paste rule still holds.
{
  const pasted = wordsOf('see you at noon')
  check(!!findDuplicate(wordsOf('ok see you at noon see you at noon'), pasted, 0, L.duplicateGapWords), 'a paste twice in a row is a duplicate', 'not found')
  check(!findDuplicate(wordsOf('see you at noon and later that day we said see you at noon'), pasted, 0, L.duplicateGapWords), 'a repeat far apart is not a duplicate', 'found')
}

if (failed) {
  console.log(`\n${failed} failed`)
  process.exit(1)
}
console.log('\nall passed')
