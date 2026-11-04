// SPDX-License-Identifier: Apache-2.0
// Dev-only check for Courses automation: the pure parts as cases. The per-playback decision
// (automatic start, the card modes, today's offer, and the never-start rules), finished
// detection and the samples it reads, the one-start rule with Undo and Stop and the lesson key,
// the latest recognition kept while a decision is busy, continuing after a stop, a main start
// cancelled before it reaches the gates, who generates a course note's notes, the Next window
// after an ad pod, and the watched-scope cut with its budget warning. Where a rule lives in
// Electron-bound code, a case checks the wiring in the source text. Hosts, ids and titles are
// placeholders.
//
// Run:  node scripts/dev/course-automation-check.mjs     every case; exits 1 on a failure
//
// The TypeScript sources load through Node's type stripping; the resolve hook maps `@shared/…`
// and extensionless relative imports to their `.ts` files.

import { readFileSync } from 'node:fs'
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
const MS = await import(pathToFileURL(resolve(root, 'src/main/capture/main-starts.ts')).href)
const OR = await import(pathToFileURL(resolve(root, 'src/main/sources/offer-rules.ts')).href)

/** A source file's text, for the wiring cases. */
const src = (rel) => readFileSync(resolve(root, rel), 'utf8').replace(/\r\n/g, '\n')
/** One method or function's text: from its signature to the closing brace at its indent. */
function body(text, signature) {
  const at = text.indexOf(signature)
  if (at < 0) return ''
  const lineStart = text.lastIndexOf('\n', at) + 1
  const pad = text.slice(lineStart, at).match(/^\s*/)[0]
  const end = text.indexOf(`\n${pad}}\n`, at)
  return text.slice(at, end < 0 ? undefined : end)
}

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
  eq(kind(A.decide(base({ privateWindow: true, recognition: rec('none', 'pending'), courseLike: true, behavior: null }))), 'nothing:private', 'no add-course card')
})

test('a window that may be private asks instead of starting (the Sources rule)', () => {
  eq(kind(A.decide(base({ privateWindow: 'unknown' }))), 'card:course', 'unknown: the card asks')
  eq(kind(A.decide(base({ privateWindow: 'unknown', recognition: rec('none', 'pending'), courseLike: true, behavior: null }))), 'card:add-course', 'unknown: Add course')
  eq(kind(A.decide(base({ privateWindow: 'unknown', recognition: rec('ambiguous', 'pending') }))), 'card:which-course', 'unknown: which course')
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

// ---------- review fixes (R3) ----------

const autoTs = src('src/main/sources/course-auto.ts')
const enhanceAutoTs = src('src/main/enhance/auto.ts')
const feedTs = src('src/main/sources/feed.ts')

test('H1: course notes skip the general automatic generation; other notes keep it', () => {
  eq(A.generalAutoGeneration({ seriesId: 'series-1', seriesRegistered: true }), false, 'a registered course')
  eq(A.generalAutoGeneration({ seriesId: 'series-2', seriesRegistered: false }), true, 'a plain Sources series')
  eq(A.generalAutoGeneration({ seriesId: null, seriesRegistered: false }), true, 'a meeting note')
  // Stop (toggle_off), the next-lesson switch (toggle_off), idle_timeout (stop and summarize) and the queue at launch.
  check(/courseNote\(noteId\)[\s\S]{0,120}'course-note'/.test(body(enhanceAutoTs, 'onStopped(e:')), 'onStopped skips course notes')
  check(/courseNote\(noteId\)[\s\S]{0,200}await stop\(\)/.test(body(enhanceAutoTs, 'async stopAndSummarize(')), 'stopAndSummarize only stops a course note')
  check(/courseNote\(item\.id\)/.test(body(enhanceAutoTs, 'async runQueued(')), 'the launch queue skips course notes')
  check(!/courseNote/.test(body(enhanceAutoTs, 'async autoGenerate(')), 'lesson notes (autoGenerate) still generate')
})

test('M1: Undo and Stop take back a start still on its way', () => {
  const c = new MS.CancelledStarts()
  const t0 = 1_000_000
  c.cancel('note-a', t0)
  check(!c.take('note-b', t0 + 10), 'another note is unaffected')
  check(c.take('note-a', t0 + 2_000), 'a main start arriving after the cancel is refused')
  check(!c.take('note-a', t0 + 2_100), 'the mark is used once')
  c.cancel('note-a', t0)
  check(!c.take('note-a', t0 + MS.CANCELLED_START_MS + 1), 'an old mark never blocks a later start')
  for (const sig of ['async undo(', 'private async stop(']) {
    const b = body(autoTs, sig)
    check(b.includes('cancelHeldStart(noteId') && b.indexOf('cancelHeldStart(noteId') < b.indexOf('capture.stop('), `${sig} cancels the held or pending start before stopping`)
  }
  const start = body(autoTs, 'private async autoStart(')
  check(/if \(auto\.undone \|\| auto\.stopped\) return/.test(start), 'nothing starts when Undo came during the plan')
  check(/startFromMain[\s\S]{0,200}if \(auto\.undone \|\| auto\.stopped\)[\s\S]{0,300}cancelHeldStart/.test(start), 'a start that resolves after Undo is cancelled')
  const ctl = src('src/main/capture/controller.ts')
  check(/startFromMain\([\s\S]{0,300}cancelledStarts\.take\(noteId/.test(ctl), 'the controller refuses a cancelled main start')
})

test('M2: Undo of a continued note discards its run, also a session that comes late', () => {
  check(body(autoTs, 'async undo(').includes('this.discardRun(noteId, auto)'), 'Undo discards the run')
  check(/discardSourceRun\(noteId, auto\.since, auto\.sessionId\)/.test(body(autoTs, 'private async discardRun(')), 'spans since the start, and the session when known')
  check(/auto\?\.undone\) void this\.lateSession/.test(autoTs), 'a session announced after Undo is handled')
  check(/capture\.stop\('auto_undo'\)[\s\S]{0,80}if \(!auto\.created\) await this\.discardRun/.test(body(autoTs, 'private async lateSession(')), 'it stops, and a continued note loses it')
})

test('M3: Record on the next lesson switches, and nothing says Recording when nothing started', () => {
  // Under ask, the next lesson's card while this playback's own note records: that note stops.
  eq(kind(A.decide(base({ behavior: ask, capturing: { noteId: 'n', ownAuto: true, linkable: false } }))), 'card:course', 'the next lesson asks')
  check(/d\.mode === 'course' && capturing && own && own\.key !== key[\s\S]{0,300}capture\.stop\(/.test(body(autoTs, 'private async decideOnce(')), 'the previous lesson stops while the card asks')
  check(/a === 'record' && series[\s\S]{0,300}capturingNote\(pid\)[\s\S]{0,200}now\?\.ownAuto \? now\.noteId : null/.test(body(autoTs, 'private async onAnswer(')), 'Record passes the capturing own note as switchFrom')
  const start = body(autoTs, 'private async autoStart(')
  check(start.includes("plan === 'system-audio' && !capturing") && start.indexOf("plan === 'system-audio' && !capturing") < start.indexOf('this.showRecordingCard('), 'L2: a refused start shows no card')
  check(/switchFrom && !capturing && this\.ctx\.capture\.currentNoteId\(\) === switchFrom/.test(start), 'the previous note never keeps the next lesson')
})

test('M4: a recognition during a busy decision waits; only the newest runs', () => {
  const q = new A.LatestPerPlayback()
  check(q.enter('pb-1', 'r1'), 'the first runs')
  check(!q.enter('pb-1', 'r2'), 'a second waits')
  check(!q.enter('pb-1', 'r3'), 'a third replaces it')
  check(q.enter('pb-2', 'x'), 'another playback runs at once')
  eq(q.leave('pb-1'), 'r3', 'the newest runs next')
  check(!q.enter('pb-1', 'r4'), 'still busy while it runs')
  eq(q.leave('pb-1'), 'r4', 'then the one that came meanwhile')
  eq(q.leave('pb-1'), null, 'then free')
  check(q.enter('pb-1', 'r5'), 'free again')
  check(!/await this\.sessionOf/.test(body(autoTs, 'private async autoStart(')), 'the session wait is outside the decision')
})

test('M5: continuing after a stop follows the automatic start rules and the plan', () => {
  const r = (over = {}) => A.resumeAllowed({ app: false, privateWindow: false, onboarding: false, locked: false, capturing: false, suppressed: 'started', plan: 'system-audio', onPlay: 'record', ...over })
  check(r(), 'a normal window, video audio')
  check(!r({ privateWindow: true }), 'a private window')
  check(!r({ privateWindow: 'unknown' }), 'an unknown window')
  check(r({ app: true, privateWindow: 'unknown' }), 'a course app has no private window')
  check(!r({ onboarding: true }) && !r({ locked: true }) && !r({ capturing: true }), 'onboarding, the lock, another capture')
  check(!r({ suppressed: 'undone' }) && !r({ suppressed: 'stopped' }), 'after Undo or Stop')
  check(!r({ plan: 'none' }) && !r({ plan: 'captions' }), 'the plan says no video audio (local-only, none set up, captions)')
  check(!r({ onPlay: 'ask' }), 'on_play = ask')
  const res = body(autoTs, 'async resumed(')
  check(res.includes('coursePlan(this.ctx, noteId)') && res.includes('privateWindow: playback.privateWindow'), 'resumed() re-plans and reads the window')
})

test('M6: finished detection reads the lesson’s own samples', () => {
  const d = 1_800_000
  let f = { positionMs: null, durationMs: d, live: false, title: null }
  const a = (pos, over = {}) => ({ keyMatches: false, title: 'Lesson A', positionMs: pos, durationMs: d, live: false, ...over })
  f = A.foldFinishSample(f, a(1_000_000))
  f = A.foldFinishSample(f, a(1_790_000))
  // The course app moves to lesson B in the same media session before the capture switches.
  f = A.foldFinishSample(f, a(5_000, { title: 'Lesson B', durationMs: 900_000 }))
  eq(f.positionMs, 1_790_000, 'a new title is another lesson')
  f = A.foldFinishSample(f, a(5_000, { durationMs: 900_000 }))
  eq(f.positionMs, 1_790_000, 'same title, another duration: another lesson')
  f = A.foldFinishSample(f, a(1_200_000))
  eq(f.positionMs, 1_790_000, 'the furthest position is kept')
  check(A.isFinished({ durationMs: f.durationMs, live: f.live, positionMs: f.positionMs, ended: false, watchedMs: 0 }), 'watched to the end reads as finished')
  const k = A.foldFinishSample({ positionMs: 10_000, durationMs: d, live: false, title: 'Lesson A' }, a(1_700_000, { keyMatches: true, title: 'Lesson A (renamed)', durationMs: d + 5_000 }))
  eq(k.positionMs, 1_700_000, 'the note’s own key always counts')
  check(feedTs.includes('foldFinishSample(w.sample'), 'the feed folds samples')
  check(/await this\.stoppedSince\(w\.noteId, w\.since\)/.test(body(feedTs, 'private async finishCheck(')), 'L3: the finish waits for the session’s final flush')
})

test('Item 9: the Next window starts when the playback ended, before the ad pod', () => {
  const t0 = 5_000_000
  eq(A.playbackEndedAt('ad', t0, t0 + 90_000), t0, 'released after an ad pod: ended when the ads began')
  eq(A.playbackEndedAt('bound', t0, t0 + 90_000), t0 + 90_000, 'a plain end: now')
  eq(A.playbackEndedAt('ad', null, t0), t0, 'no ad time known: now')
  // end → 90 s of ads → next item: Next; the same with no ads: too late; a 6-min pod: past the cap.
  check(OR.withinNextWindow(t0, t0 + 90_000, 90_000, 5_000), 'ads left out')
  check(!OR.withinNextWindow(t0, t0 + 90_000, 0, 5_000), 'no ads: 90 s is past the window')
  // Before the fix the end was seen only when the next item arrived, so the cap never applied.
  check(!OR.withinNextWindow(A.playbackEndedAt('ad', t0, t0 + 6 * 60_000), t0 + 6 * 60_000, 6 * 60_000, 5_000), 'the 5-min cap applies from the real end')
  check(/lastEnd = \{ at: playbackEndedAt\(prevState, this\.adSince, now\)/.test(feedTs), 'the feed reports that end')
})

test('L4: the lesson key holds when the item learns its URL', () => {
  const r = { courseId: 'series-1', lesson: { itemId: 'item-7', number: 7, label: null, state: 'numbered', origin: 'catalog' } }
  eq(A.lessonKeyOf(r, 'title:space a'), A.lessonKeyOf(r, 'circle:community.example.com:345'), 'same item, any draft key')
  const pending = { courseId: 'series-1', lesson: { itemId: null, number: null, label: null, state: 'pending', origin: null } }
  eq(A.lessonKeyOf(pending, 'circle:community.example.com:345'), 'circle:community.example.com:345', 'no item: the identified key')
  eq(A.lessonKeyOf(pending, 'title:space a'), 'series-1:pending', 'a guess key never counts')
})

test('lows: L1 adoption retry, L3 once across restarts, L6 log fields', () => {
  const store = src('src/renderer/src/features/capture/store.ts')
  check(/if \(pendingEnded && deferredAdopt\) queueMicrotask\(retryDeferredAdopt\)/.test(store), 'L1: main’s capture is adopted once the pending start ends')
  const ln = src('src/main/sources/lesson-notes.ts')
  check(ln.includes('listPanels(noteId, { includeDeleted: true })'), 'L3: a deleted lesson-notes panel still counts')
  const on = body(ln, 'export async function onLessonFinished(')
  check(on.indexOf('tried.add(noteId)') > 0 && on.indexOf('tried.add(noteId)') < on.indexOf('await '), 'L3: claimed before the first await')
  check(!/\{ err \}/.test(autoTs), 'L6: course-auto logs error names only')
  check(/try \{\s*await shell\.openExternal/.test(autoTs), 'L6: openExternal is caught')
})

test('QA: one card per playback, kind and title (Add course, then the course card)', () => {
  check(/this\.carded\.get\(pid\) === cardedKey\(d\.mode, playback\.title\)/.test(autoTs), 'the rule keys on the card kind')
  check(/cardedKey\('which-course', playback\.title\)/.test(autoTs), 'Which course is this? is asked once per title')
  const cs = src('src/main/sources/courses.ts')
  check(/const notPrivate = !!p\.app \|\| p\.privateWindow !== true/.test(cs), 'a window that may be private is recognized')
  check(/if \(w\.playback\.app \|\| w\.playback\.privateWindow === false\) await learn\(/.test(cs), 'learning only in a course app or a known-normal window')
  check(/watchOf\(playbackId\)\?\.playback/.test(cs) && /ended\.set\(pid, w\)/.test(cs), 'Recently played still finds an ended playback')
})

test('QA: lesson notes keep their own 150-word rule', () => {
  const lnTs = src('src/main/sources/lesson-notes.ts')
  check(/autoGenerate\(noteId, \{ lengthChecked: true \}\)/.test(lnTs), 'lesson notes tell auto-generation the length is checked')
  const autoEn = src('src/main/enhance/auto.ts')
  check(/if \(lengthChecked\) return null/.test(autoEn), 'the meeting minimum is skipped only when the caller checked')
  check(/if \(await this\.hasSummaryPanel\(noteId\)\) return 'has-panel'\n\s*if \(lengthChecked\) return null/.test(autoEn), 'an existing panel still blocks')
})

test('QA: Export lessons copies into the new folder it made', () => {
  const seek = src('src/main/sources/seek.ts')
  check(!/await cp\(root, dest,/.test(seek), 'not a copy onto the folder just made (that fails with EEXIST)')
  check(/for \(const entry of await readdir\(root\)\) await cp\(join\(root, entry\), join\(dest, entry\), \{ recursive: true, force: false, errorOnExist: true \}\)/.test(seek), 'entry by entry, never overwriting')
  check(/await rm\(dest, \{ recursive: true, force: true \}\)/.test(seek), 'a failed copy removes its own new folder')
})

test('QA: the sheet names a Circle course from its tab, its earlier series or its slug', () => {
  const cs = src('src/main/sources/courses.ts')
  check(/else if \(circleKey && !appTitle && sessionTitle\.includes\(' \| '\)\) title = sessionTitle\.slice\(0, sessionTitle\.lastIndexOf\(' \| '\)\)\.trim\(\)/.test(cs), 'a browser tab drops ` | <community>`')
  check(/if \(before\?\.title\) title = before\.title/.test(cs), 'a course added before keeps its name')
  check(/if \(!title && canonicalKey\.startsWith\('circle:'\)\) title = slugTitle\(/.test(cs), 'a pasted link names the course from its slug, not the host')
})

console.log(`\n${checks} checks, ${failures} failed`)
process.exit(failures ? 1 : 0)
