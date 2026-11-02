// SPDX-License-Identifier: Apache-2.0
// Dev-only check for Courses automation: the pure parts as cases. The per-playback decision
// (automatic start, the card modes, today's offer, and the never-start rules), finished
// detection, the one-start rule with Undo and Stop, and the watched-scope cut with its budget
// warning. Hosts, ids and titles are placeholders.
//
// Run:  node scripts/dev/course-automation-check.mjs     every case; exits 1 on a failure
//
// The TypeScript sources load through Node's type stripping; the resolve hook maps `@shared/…`
// and extensionless relative imports to their `.ts` files.

import { registerHooks } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

registerHooks({
  resolve(specifier, context, next) {
    let r
    if (specifier.startsWith('@shared/')) r = next(pathToFileURL(resolve(root, 'src/shared', `${specifier.slice(8)}.ts`)).href, context)
    else if (specifier.startsWith('.') && context.parentURL?.endsWith('.ts') && !/\.[cm]?[jt]s$/.test(specifier)) r = next(new URL(`${specifier}.ts`, context.parentURL).href, context)
    else r = next(specifier, context)
    return r.url.endsWith('.ts') ? { ...r, format: 'module-typescript' } : r
  }
})

const A = await import(pathToFileURL(resolve(root, 'src/main/sources/automation.ts')).href)
const T = await import(pathToFileURL(resolve(root, 'src/main/enhance/transcript.ts')).href)

// ---------- a tiny runner ----------

let failures = 0
let checks = 0
let current = ''

function check(cond, what) {
  checks++
  if (!cond) {
    failures++
    console.log(`  FAIL [${current}] ${what}`)
  }
}

function eq(actual, expected, what) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  check(a === e, `${what}: expected ${e}, got ${a}`)
}

function test(name, fn) {
  current = name
  const before = failures
  try {
    fn()
  } catch (err) {
    failures++
    console.log(`  FAIL [${name}] threw: ${err?.stack ?? err}`)
  }
  console.log(`${failures === before ? 'ok  ' : 'FAIL'} ${name}`)
}

// ---------- fixtures ----------

const lesson = (state = 'numbered') => ({ itemId: state === 'numbered' ? 'item-1' : null, number: state === 'pending' ? null : 53, label: null, state, origin: state === 'numbered' ? 'catalog' : null })
const rec = (confidence, state = 'numbered', extra = {}) => ({ courseId: confidence === 'none' || confidence === 'ambiguous' ? null : 'series-1', confidence, lesson: lesson(state), signals: [], ...extra })
const record = { onPlay: 'record', onEnd: 'notes' }
const ask = { onPlay: 'ask', onEnd: 'notes' }
const base = (over = {}) => ({
  recognition: rec('exact'),
  behavior: record,
  courseLike: false,
  privateWindow: false,
  onboarding: false,
  locked: false,
  capturing: null,
  suppressed: false,
  ...over
})
const kind = (d) => (d.kind === 'card' ? `card:${d.mode}` : d.kind === 'nothing' ? `nothing:${d.reason}` : d.kind)

// ---------- the decision ----------

test('matched confidences start automatically under on_play = record', () => {
  for (const c of ['exact', 'title', 'app']) eq(kind(A.decide(base({ recognition: rec(c) }))), 'auto-start', c)
})

test('on_play = ask gets the course card', () => {
  eq(kind(A.decide(base({ behavior: ask }))), 'card:course', 'ask')
})

test('pending and guessed lessons still start (a new note, never continued)', () => {
  eq(kind(A.decide(base({ recognition: rec('app', 'pending') }))), 'auto-start', 'pending')
  eq(kind(A.decide(base({ recognition: rec('title', 'guessed') }))), 'auto-start', 'guessed')
})

test('ambiguous gets Which course is this?', () => {
  eq(kind(A.decide(base({ recognition: rec('ambiguous', 'pending', { candidates: ['a', 'b'] }), behavior: null }))), 'card:which-course', 'ambiguous')
})

test('none: course-like gets Add course, other videos keep the offer', () => {
  eq(kind(A.decide(base({ recognition: rec('none', 'pending'), behavior: null, courseLike: true }))), 'card:add-course', 'course-like')
  eq(kind(A.decide(base({ recognition: rec('none', 'pending'), behavior: null }))), 'offer', 'video')
})

test('never in private windows (no cards either)', () => {
  eq(kind(A.decide(base({ privateWindow: true }))), 'nothing:private', 'private')
  eq(kind(A.decide(base({ privateWindow: 'unknown' }))), 'nothing:private', 'unknown')
  eq(kind(A.decide(base({ privateWindow: true, recognition: rec('none', 'pending'), courseLike: true, behavior: null }))), 'nothing:private', 'no add-course card')
})

test('never during onboarding', () => {
  eq(kind(A.decide(base({ onboarding: true }))), 'nothing:onboarding', 'onboarding')
})

test('under the device lock the card asks instead', () => {
  eq(kind(A.decide(base({ locked: true }))), 'card:course', 'locked')
})

test('another note capturing: Link this note only when it qualifies', () => {
  eq(kind(A.decide(base({ capturing: { noteId: 'n', ownAuto: false, linkable: true } }))), 'card:link-capturing', 'hand-started')
  eq(kind(A.decide(base({ capturing: { noteId: 'n', ownAuto: false, linkable: false } }))), 'nothing:capturing', 'calendar meeting or older')
  eq(kind(A.decide(base({ capturing: { noteId: 'n', ownAuto: true, linkable: false } }))), 'auto-start', 'own automatic note: the next lesson')
})

test('suppressed playbacks start nothing', () => {
  eq(kind(A.decide(base({ suppressed: true }))), 'nothing:suppressed', 'suppressed')
})

test('a hand-started capture qualifies for 5 minutes, with no event and no source', () => {
  const now = 1_000_000_000
  check(A.qualifiesForLink({ captureStartedAt: now - 60_000, byHand: true, hasEvent: false, hasSource: false }, now), '1 min')
  check(!A.qualifiesForLink({ captureStartedAt: now - 6 * 60_000, byHand: true, hasEvent: false, hasSource: false }, now), '6 min')
  check(!A.qualifiesForLink({ captureStartedAt: now - 60_000, byHand: true, hasEvent: true, hasSource: false }, now), 'calendar event')
  check(!A.qualifiesForLink({ captureStartedAt: now - 60_000, byHand: true, hasEvent: false, hasSource: true }, now), 'source note')
  check(!A.qualifiesForLink({ captureStartedAt: now - 60_000, byHand: false, hasEvent: false, hasSource: false }, now), 'started by main')
})

test('course-like playbacks', () => {
  check(A.isCourseLike({ app: true, url: null, site: null }), 'an unmapped course app')
  check(A.isCourseLike({ app: false, url: null, site: 'community.circle.so' }), 'a known course host')
  check(A.isCourseLike({ app: false, url: 'https://community.example.com/c/space-a/sections/12/lessons/345', site: null }), 'a Circle lesson URL')
  check(A.isCourseLike({ app: false, url: 'https://app.hub.la/m/area-1/p/lesson-9', site: null }), 'a Hubla lesson URL')
  check(!A.isCourseLike({ app: false, url: 'https://app.hub.la/m/area-1', site: null }), 'a Hubla member area root')
  check(!A.isCourseLike({ app: false, url: 'https://www.youtube.com/watch?v=abcdefghijk', site: 'youtube.com' }), 'a YouTube video')
  check(A.isCourseLike({ app: false, url: 'https://courses.example.org/x/y', site: null }, ['courses.example.org']), 'a host the user added')
})

// ---------- finished ----------

test('finished at 90 % of the duration', () => {
  const d = 1_000_000
  check(A.isFinished({ durationMs: d, live: false, positionMs: 900_000, ended: false, watchedMs: 0 }), '90 %')
  check(!A.isFinished({ durationMs: d, live: false, positionMs: 899_000, ended: false, watchedMs: 0 }), 'just under')
})

test('finished when the session ended within the last 60 s', () => {
  const d = 7_635_900
  check(A.isFinished({ durationMs: d, live: false, positionMs: d - 59_000, ended: true, watchedMs: 0 }), 'ended 59 s before the end')
  check(!A.isFinished({ durationMs: 100_000_000, live: false, positionMs: 100_000_000 - 61_000 - 20_000_000, ended: true, watchedMs: 0 }), 'ended far from the end')
  check(!A.isFinished({ durationMs: 200_000, live: false, positionMs: 150_000, ended: false, watchedMs: 0 }), 'paused at 75 % is not finished')
})

test('paused at 40 % is not finished', () => {
  check(!A.isFinished({ durationMs: 1_000_000, live: false, positionMs: 400_000, ended: false, watchedMs: 400_000 }), '40 %')
  check(!A.isFinished({ durationMs: 1_000_000, live: false, positionMs: null, ended: true, watchedMs: 400_000 }), 'no position')
})

test('live: ended after 10 min watched', () => {
  check(A.isFinished({ durationMs: null, live: true, positionMs: null, ended: true, watchedMs: 10 * 60_000 }), '10 min')
  check(!A.isFinished({ durationMs: null, live: true, positionMs: null, ended: true, watchedMs: 9 * 60_000 }), '9 min')
  check(!A.isFinished({ durationMs: null, live: true, positionMs: null, ended: false, watchedMs: 60 * 60_000 }), 'still live')
})

// ---------- one start per playback, Undo and Stop ----------

test('one automatic start per playback, again only after a key or title change', () => {
  const s = new A.AutoSuppression()
  check(s.allowed('pb-1', 'circle:community.example.com:345', 'Space A | Example Community'), 'first')
  s.mark('pb-1', 'circle:community.example.com:345', 'Space A | Example Community', 'started')
  check(!s.allowed('pb-1', 'circle:community.example.com:345', 'Space A | Example Community'), 'a second recognition')
  check(s.allowed('pb-1', 'circle:community.example.com:346', 'Space A | Example Community'), 'the next lesson key')
  check(s.allowed('pb-1', 'circle:community.example.com:345', 'Lesson title B'), 'a new title')
  check(s.allowed('pb-2', 'circle:community.example.com:345', 'Space A | Example Community'), 'another playback')
})

test('Undo and Stop suppress until the key or title changes', () => {
  for (const reason of ['undone', 'stopped']) {
    const s = new A.AutoSuppression()
    s.mark('pb-1', 'url:https://app.hub.la/m/area-1/p/lesson-9', 'Lesson nine', 'started')
    s.mark('pb-1', 'url:https://app.hub.la/m/area-1/p/lesson-9', 'Lesson nine', reason)
    eq(s.reason('pb-1'), reason, 'reason kept')
    check(!s.allowed('pb-1', 'url:https://app.hub.la/m/area-1/p/lesson-9', 'Lesson nine'), `${reason}: same key and title`)
    check(s.allowed('pb-1', 'url:https://app.hub.la/m/area-1/p/lesson-10', 'Lesson ten'), `${reason}: the next lesson`)
    const d = A.decide(base({ suppressed: !s.allowed('pb-1', 'url:https://app.hub.la/m/area-1/p/lesson-9', 'Lesson nine') }))
    eq(kind(d), 'nothing:suppressed', `${reason}: the decision`)
  }
})

// ---------- the watched scope ----------

const chunk = (id, posMs, text = 'word '.repeat(10).trim()) => ({
  id,
  text,
  start_timestamp: new Date(1_800_000_000_000 + posMs).toISOString(),
  end_timestamp: new Date(1_800_000_000_000 + posMs + 1_000).toISOString(),
  transcription_session_id: 's1',
  source: 'system',
  is_final: true,
  providerDetails: posMs === null ? null : { words: [], provider: 'local', model: '', wallClockAnchorMs: 0, sourcePositionMs: posMs }
})
const minutes = (m) => m * 60_000

test('the scope is the watched spans ± 60 s', () => {
  const chunks = [chunk('a', minutes(1)), chunk('b', minutes(9)), chunk('c', minutes(10.5)), chunk('d', minutes(12)), chunk('e', minutes(30))]
  const spans = [{ pos_start_ms: minutes(10), pos_end_ms: minutes(11) }]
  const r = T.watchedScope(chunks, spans, minutes(60), 3)
  eq(
    r.chunks.map((c) => c.id),
    ['b', 'c', 'd'],
    'inside ± 60 s'
  )
  eq(r.scope.whole, false, 'not whole')
  eq(r.scope.startMs, minutes(9), 'start')
  eq(r.scope.endMs, minutes(12), 'end')
  eq(r.scope.totalMs, minutes(60), 'total')
  eq(r.scope.noteCount, 3, 'note count')
})

test('the whole video at ≥ 85 % watched, or with no spans', () => {
  const chunks = [chunk('a', minutes(1)), chunk('b', minutes(59))]
  eq(T.watchedScope(chunks, [{ pos_start_ms: 0, pos_end_ms: minutes(51) }], minutes(60), 0).scope.whole, true, '85 %')
  eq(T.watchedScope(chunks, [{ pos_start_ms: 0, pos_end_ms: minutes(50) }], minutes(60), 0).scope.whole, false, '83 %')
  const none = T.watchedScope(chunks, [], minutes(60), 0)
  eq(none.scope.whole, true, 'no spans')
  eq(none.chunks.length, 2, 'every chunk')
})

test('overlapping spans merge; a chunk with no position is kept', () => {
  const spans = [
    { pos_start_ms: minutes(10), pos_end_ms: minutes(20) },
    { pos_start_ms: minutes(15), pos_end_ms: minutes(25) }
  ]
  eq(T.watchedMsOf(spans), minutes(15), 'merged watched time')
  const r = T.watchedScope([chunk('x', null), chunk('y', minutes(40))], spans, minutes(120), 0)
  eq(
    r.chunks.map((c) => c.id),
    ['x'],
    'untimed kept, far one cut'
  )
})

test('the budget cut returns the last position that fits', () => {
  const text = '\n[00:10] alpha beta\n[01:20] gamma delta\n[1:02:03] epsilon zeta'
  eq(T.budgetCut(text, 10_000), null, 'fits')
  const cut = T.budgetCut(text, 40)
  eq(cut?.cutAtMs, 80_000, 'cut at 01:20')
  const cutH = T.budgetCut(text, text.length - 1)
  eq(cutH?.cutAtMs, 3_723_000, 'h:mm:ss parsed')
})

console.log(`\n${checks} checks, ${failures} failed`)
process.exit(failures ? 1 : 0)
