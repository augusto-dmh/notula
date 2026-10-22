// SPDX-License-Identifier: Apache-2.0
// Dev-only harness for the passive provider. Replays synthetic reader lines through
// the pure state machine (debounce, eligibility, ad guard, spans, binding) and checks the pure
// identification rules (URL keys, tab and window facts, History matching, profiles and the host
// filter on a synthetic in-memory History, search verification, yt-dlp parsing), plus two rules
// outside the provider: superseded sessions at the transcript read, and when the
// stamped projection feeds a prompt. No PowerShell, no browser, no network, no real History.
//
// Run:  node scripts/dev/media-replay.mjs                 every synthetic case; exits 1 on a failure
//       node scripts/dev/media-replay.mjs <events.jsonl>  replays a recording and prints the effects
//
// A recording is either the reader's own lines (`{"ev":"sessions",…}` with an added `"at"` epoch
// ms) or a media-session probe's (`ts`
// HH:mm:ss.fff, `pos`/`end` in seconds). Titles in a recording are printed only as lengths.
//
// The TypeScript sources load through Node's type stripping; the resolve hook below maps
// `@shared/…` and extensionless relative imports to their `.ts` files.

import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

registerHooks({
  resolve(specifier, context, next) {
    let r
    // The transcript read is checked on its own: the store's runtime half (classes with
    // parameter properties) can't be type-stripped, and the read needs none of it.
    if (specifier === './store' && context.parentURL?.endsWith('/storage/transcript-repo.ts')) {
      return { url: 'data:text/javascript,export const inTransaction = (s, f) => f(); export const invalid = (m) => new Error(m)', format: 'module', shortCircuit: true }
    }
    if (specifier.startsWith('@shared/')) r = next(pathToFileURL(resolve(root, 'src/shared', `${specifier.slice(8)}.ts`)).href, context)
    else if (specifier.startsWith('.') && context.parentURL?.endsWith('.ts') && !/\.[cm]?[jt]s$/.test(specifier)) r = next(new URL(`${specifier}.ts`, context.parentURL).href, context)
    else r = next(specifier, context)
    // The package has no "type": the sources are ES modules in TypeScript.
    return r.url.endsWith('.ts') ? { ...r, format: 'module-typescript' } : r
  }
})

const src = (p) => pathToFileURL(resolve(root, p)).href
const { SOURCES_LIMITS } = await import(src('src/shared/types/sources.ts'))
const { createMachine, step, snapshot, feedSample, bindingOf } = await import(src('src/main/media/machine.ts'))
const { sessionsFromRecord, tabFacts, windowFacts, siteFromLabel } = await import(src('src/main/media/lines.ts'))
const M = await import(src('src/main/media/match.ts'))
const { parseSourceUrl, guessKey, cleanTitle } = await import(src('src/shared/lib/source-key.ts'))
const transcriptRepo = await import(src('src/main/storage/transcript-repo.ts'))
const inputs = await import(src('src/main/enhance/inputs.ts'))
const sqlite = await import('node:sqlite')
const { DEFAULT_SETTINGS } = await import(src('src/shared/types/settings.ts'))

const LIMITS = {
  debounceMs: SOURCES_LIMITS.debounceMs,
  eligiblePlayedMs: SOURCES_LIMITS.eligiblePlayedMs,
  minDurationMs: SOURCES_LIMITS.minDurationMs,
  spanMergeMs: SOURCES_LIMITS.spanMergeMs
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

function eq(a, b, what) {
  const ok = JSON.stringify(a) === JSON.stringify(b)
  check(ok, `${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`)
}

const file = process.argv[2]

function group(name, fn) {
  // Replaying a recording runs no synthetic case.
  if (file) return
  current = name
  const before = failures
  fn()
  console.log(`${failures === before ? 'ok  ' : 'FAIL'} ${name}`)
}

// ---------- synthetic reader lines ----------

const T0 = 1_792_000_000_000
const s = (n) => T0 + n * 1000

/** One reader session. `upd` defaults to the line time. */
function sess(app, title, artist, status, posS, endS, extra = {}) {
  return { app, cur: true, title, artist, album: '', status, posMs: posS * 1000, endMs: endS * 1000, rate: 1, ...extra }
}

/**
 * Feeds events in time order with a tick every 250 ms; returns every effect with its time and the
 * snapshots published on `changed`.
 */
function run(events, untilS, setup) {
  const m = createMachine(LIMITS)
  const log = []
  const snaps = []
  const apply = (input, at) => {
    for (const e of step(m, input, at)) {
      log.push({ at, ...e })
      if (e.type === 'changed') snaps.push({ at, list: snapshot(m, at) })
    }
  }
  if (setup) setup(m, apply)
  const queue = [...events].sort((a, b) => a.at - b.at)
  for (let t = s(0); t <= s(untilS); t += 250) {
    while (queue.length && (queue[0].at ?? 0) <= t) {
      const e = queue.shift()
      if (e.line) {
        const rec = { ev: 'sessions', sessions: e.line.map((x) => ({ updated: e.upd ?? e.at, ...x })) }
        apply({ type: 'sessions', sessions: sessionsFromRecord(rec, e.at) }, e.at)
      } else if (e.input) apply(e.input, e.at)
      else if (e.fn) e.fn(m, apply, e.at)
    }
    apply({ type: 'tick' }, t)
  }
  return { m, log, snaps }
}

const of = (log, type) => log.filter((e) => e.type === type)
const lastList = (snaps) => snaps.at(-1)?.list ?? []

// ---------- state machine cases ----------

group('ad then video (pre-roll): the ad is discarded, the video becomes the candidate', () => {
  const ad = sess('Chrome', 'Iogurtes Ninho: Mais do que palavras, amar é um gesto.', 'A Iogurteria Nestlé', 'Playing', 0, 15)
  const video = sess('Chrome', 'Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)', 'Rick Astley', 'Playing', 0, 213.1)
  const { log, snaps } = run([{ at: s(0), line: [ad] }, { at: s(15), line: [video] }], 60)
  const ended = of(log, 'ended')
  eq(ended.length, 1, 'one ended')
  eq(ended[0]?.reason, 'discarded', 'the ad is discarded')
  const cands = of(log, 'candidate')
  eq(cands.length, 1, 'one candidate')
  check(cands[0] && cands[0].at >= s(35) && cands[0].at <= s(36), `candidate after 20 s of the video (at ${(cands[0]?.at - T0) / 1000}s)`)
  check(snaps.every((x) => x.list.every((p) => !p.title.startsWith('Iogurtes') || p.state !== 'ended')), 'the discarded ad is never reported as an ended playback')
  const list = lastList(snaps)
  eq(list.length, 1, 'one playback')
  eq(list[0]?.state, 'candidate', 'video state')
  eq(list[0]?.durationMs, 213100, 'duration')
  eq(of(log, 'locate').length, 2, 'both titles were located after the debounce')
})

group('end then autoplay: the bound video ends at removal, the next is a new playback', () => {
  const a = sess('MSEdge', 'Video A', 'Chan', 'Playing', 0, 300)
  const b = sess('MSEdge', 'Video B', 'Chan', 'Playing', 0, 400)
  let aId = null
  const { log, snaps, m } = run(
    [
      { at: s(0), line: [a] },
      {
        at: s(30),
        fn: (mm, apply, at) => {
          aId = snapshot(mm, at)[0].id
          apply({ type: 'bind', noteId: 'n1', canonicalKey: 'youtube:aaaaaaaaaaa', playbackId: aId }, at)
        }
      },
      { at: s(60), line: [] },
      { at: s(63), line: [b] }
    ],
    90
  )
  const ended = of(log, 'ended')
  eq(ended.map((e) => e.reason), ['gone'], 'A ended once, as gone')
  eq(ended[0]?.playbackId, aId, 'the bound playback ended')
  check(ended[0] && ended[0].at >= s(61.5) && ended[0].at <= s(62), 'ended after the 1.5 s debounce')
  const spans = of(log, 'span')
  eq(spans.length, 1, 'one span')
  eq(spans[0]?.span.wallStart, s(30), 'span wall start = bind time')
  eq(spans[0]?.span.wallEnd, s(60), 'span wall end = removal time, not the debounce')
  eq(spans[0]?.span.posStartMs, 30000, 'span position start')
  eq(spans[0]?.span.posEndMs, 60000, 'span position end')
  eq(of(log, 'binding').map((e) => e.state), ['bound', 'ended'], 'binding bound → ended')
  eq(bindingOf(m)?.playbackId, null, 'the binding waits for a rebind')
  const ids = new Set(snaps.flatMap((x) => x.list.map((p) => p.id)))
  eq(ids.size, 2, 'two distinct playback ids')
  const reportedEnded = snaps.flatMap((x) => x.list.filter((p) => p.state === 'ended'))
  eq(reportedEnded.length, 1, 'the ended playback is reported once')
  eq(lastList(snaps)[0]?.title, 'Video B', 'B is current')
  eq(feedSample(m, s(90))?.stamping, false, 'no stamping for another title')
})

group('two browsers: each its own playback, the most recently changed first', () => {
  const e = sess('MSEdge', 'Edge video', 'Chan E', 'Playing', 0, 600)
  const c = sess('Chrome', 'Chrome video', 'Chan C', 'Playing', 0, 500)
  const { log, snaps } = run(
    [
      { at: s(0), line: [e] },
      { at: s(5), line: [e, { ...c, cur: true }] },
      { at: s(40), line: [{ ...e, status: 'Paused', posMs: 40000 }, c], upd: s(40) }
    ],
    45
  )
  eq(of(log, 'candidate').length, 2, 'two candidates')
  const list = lastList(snaps)
  eq(list.map((p) => p.browser), ['edge', 'chrome'], 'the paused Edge changed last, so it is first')
  eq(list.find((p) => p.browser === 'edge')?.status, 'paused', 'Edge paused')
  check(new Set(list.map((p) => p.id)).size === 2, 'distinct ids')
})

group('one browser, two sessions: the current one wins', () => {
  const recs = sessionsFromRecord(
    { ev: 'sessions', sessions: [sess('MSEdge', 'Background', 'X', 'Paused', 1, 300, { cur: false }), sess('MSEdge', 'Foreground', 'Y', 'Playing', 1, 300)] },
    s(0)
  )
  eq(recs.map((r) => r.title), ['Foreground'], 'one session per browser, the current one')
  const other = sessionsFromRecord({ ev: 'sessions', sessions: [sess('Spotify.exe', 'Song', 'Band', 'Playing', 1, 200)] }, s(0))
  eq(other.length, 0, 'unmeasured app ids are ignored')
})

group('an Incognito tab whose metadata Chrome withholds is dropped (runtime QA 2026-10-20)', () => {
  const withheld = sess('Chrome', 'A site is playing media', '', 'Playing', 30, 6980)
  const recs = sessionsFromRecord({ ev: 'sessions', sessions: [withheld, sess('Chrome', 'Normal tab', 'Chan', 'Paused', 1, 300, { cur: false })] }, s(0))
  eq(recs.map((r) => r.title), ['Normal tab'], 'the withheld session is dropped; the other session of that browser stands')
  const { log } = run([{ at: s(0), line: [withheld] }], 60)
  eq(of(log, 'candidate').length, 0, 'never a candidate')
  const named = sessionsFromRecord({ ev: 'sessions', sessions: [sess('Chrome', 'A site is playing media', 'Real Channel', 'Playing', 1, 300)] }, s(0))
  eq(named.length, 1, 'a real video with that title and an artist is kept')
})

group('live: end ≤ 0 is live, no duration, still a candidate', () => {
  const edgeLive = sess('MSEdge', 'Live stream', 'Chan', 'Playing', 0, -0.000001)
  const chromeLive = sess('Chrome', 'Boston Common LIVE', 'Third Polar Arch', 'Playing', 0, 0)
  const { log, snaps } = run([{ at: s(0), line: [edgeLive, chromeLive] }], 30)
  eq(of(log, 'candidate').length, 2, 'both candidates')
  const list = lastList(snaps)
  check(list.every((p) => p.live && p.durationMs === null), 'live, no duration')
})

group('flaps: a session that blinks during start-up stays one playback', () => {
  const v = sess('Chrome', 'Flappy', 'Chan', 'Playing', 0, 300)
  const { log, snaps } = run(
    [
      { at: s(0), line: [v] },
      { at: s(0.5), line: [] },
      { at: s(1.0), line: [v] },
      { at: s(1.2), line: [] },
      { at: s(2.0), line: [v] },
      // A mid-playback blink of a candidate.
      { at: s(40), line: [] },
      { at: s(41), line: [{ ...v, posMs: 41000 }], upd: s(41) }
    ],
    60
  )
  const ids = new Set(snaps.flatMap((x) => x.list.map((p) => p.id)))
  eq(ids.size, 1, 'one playback id')
  eq(of(log, 'ended').length, 0, 'never ended')
  eq(of(log, 'locate').length, 1, 'located once')
  eq(of(log, 'candidate').length, 1, 'one candidate')
  const c = of(log, 'candidate')[0]
  check(c && c.at >= s(21) && c.at <= s(23.5), `candidate after 20 s of playing time, gaps excluded (at ${(c?.at - T0) / 1000}s)`)
})

group('rate change, pause, seek: spans close and open; the feed extrapolates with the rate', () => {
  const v = sess('MSEdge', 'Lesson', 'Teacher', 'Playing', 0, 3600)
  let feedAt15 = null
  let feedAt25 = null
  const { log } = run(
    [
      { at: s(0), line: [v] },
      { at: s(0), fn: (mm, apply, at) => apply({ type: 'bind', noteId: 'n', canonicalKey: 'k', playbackId: snapshot(mm, at)[0].id }, at) },
      { at: s(10), line: [{ ...v, posMs: 10000, rate: 1.5 }], upd: s(10) },
      { at: s(15), fn: (mm, _a, at) => (feedAt15 = feedSample(mm, at)) },
      { at: s(20), line: [{ ...v, status: 'Paused', posMs: 25000, rate: 1.5 }], upd: s(20) },
      { at: s(25), fn: (mm, _a, at) => (feedAt25 = feedSample(mm, at)) },
      { at: s(30), line: [{ ...v, posMs: 25000, rate: 1 }], upd: s(30) },
      // A seek forward to 100 s at 40 s.
      { at: s(40), line: [{ ...v, posMs: 100000 }], upd: s(40) },
      { at: s(50), input: { type: 'unbind' } }
    ],
    55
  )
  const spans = of(log, 'span').map((e) => e.span)
  eq(
    spans.map((x) => [(x.wallStart - T0) / 1000, (x.wallEnd - T0) / 1000, x.posStartMs, x.posEndMs, x.rate]),
    [
      [0, 10, 0, 10000, 1],
      [10, 20, 10000, 25000, 1.5],
      [30, 40, 25000, 35000, 1],
      [40, 50, 100000, 110000, 1]
    ],
    'spans'
  )
  eq(feedAt15?.positionMs, 17500, 'feed at 15 s = 10 s + 5 s × 1.5')
  eq(feedAt15?.stamping, true, 'stamping while bound')
  eq(feedAt25?.positionMs, 25000, 'paused: the paused position')
  eq(feedAt25?.status, 'paused', 'paused status')
})

group('short spans merge into the next one', () => {
  const v = sess('MSEdge', 'Lesson', 'Teacher', 'Playing', 0, 3600)
  const { log } = run(
    [
      { at: s(0), line: [v] },
      { at: s(0), fn: (mm, apply, at) => apply({ type: 'bind', noteId: 'n', canonicalKey: 'k', playbackId: snapshot(mm, at)[0].id }, at) },
      { at: s(1), line: [{ ...v, status: 'Paused', posMs: 1000 }], upd: s(1) },
      { at: s(5), line: [{ ...v, posMs: 1000 }], upd: s(5) },
      { at: s(15), input: { type: 'unbind' } }
    ],
    16
  )
  const spans = of(log, 'span').map((e) => e.span)
  eq(spans.length, 1, 'one span')
  eq([spans[0]?.wallStart - T0, spans[0]?.posStartMs, spans[0]?.posEndMs], [0, 0, 11000], 'the 1 s span merged into the next')
})

group('mid-roll ad: the video is suspended and resumes under its own id', () => {
  const v = sess('Chrome', 'Long video', 'Chan', 'Playing', 0, 1800)
  const ad = sess('Chrome', 'Buy things', 'Brand', 'Playing', 0, 30)
  let vId = null
  let during = null
  let feedDuring = null
  const { log, snaps, m } = run(
    [
      { at: s(0), line: [v] },
      {
        at: s(40),
        fn: (mm, apply, at) => {
          vId = snapshot(mm, at)[0].id
          apply({ type: 'bind', noteId: 'n', canonicalKey: 'youtube:vvvvvvvvvvv', playbackId: vId }, at)
        }
      },
      { at: s(60), line: [ad] },
      {
        at: s(75),
        fn: (mm, _a, at) => {
          during = snapshot(mm, at)
          feedDuring = feedSample(mm, at)
        }
      },
      { at: s(90), line: [{ ...v, posMs: 60000 }], upd: s(90) },
      { at: s(100), input: { type: 'unbind' } }
    ],
    110
  )
  eq(during?.length, 1, 'one playback during the ad')
  eq(during?.[0]?.id, vId, 'the video stands for the browser')
  eq(during?.[0]?.ad, true, 'ad: true')
  eq(feedDuring?.stamping, false, 'no stamping during the ad')
  eq(feedDuring?.positionMs, null, 'no position during the ad')
  eq(of(log, 'ended').map((e) => e.reason), ['ad'], 'the ad item ended as an ad')
  eq(lastList(snaps)[0]?.id, vId, 'same id after the ad')
  eq(of(log, 'binding').map((e) => e.state), ['bound', 'ad', 'bound', 'unbound'], 'binding bound → ad → bound → unbound')
  const spans = of(log, 'span').map((e) => [(e.span.wallStart - T0) / 1000, (e.span.wallEnd - T0) / 1000, e.span.posStartMs, e.span.posEndMs])
  eq(spans, [[40, 60, 40000, 60000], [90, 100, 60000, 70000]], 'no span covers the ad')
  check(!snaps.some((x) => x.list.some((p) => p.title === 'Buy things')), 'the ad item is never reported')
  void m
})

// The pod shape recorded overnight (active-2026-10.jsonl): a 15 s ad, then a 79.7 s one.
group('mid-roll pod with a second ad over 60 s: the video still resumes under its own id', () => {
  const v = sess('Chrome', 'Long video', 'Chan', 'Playing', 0, 1800)
  const ad1 = sess('Chrome', '30% OFF na 2ª unidade', 'Kopenhagen', 'Playing', 0, 15)
  const ad2 = sess('Chrome', 'Live Entertainment - Sony × KADOKAWA DREAMS', 'Sony Corporation - Official', 'Playing', 0, 79.7)
  let vId = null
  let during = null
  const { log, snaps } = run(
    [
      { at: s(0), line: [v] },
      {
        at: s(40),
        fn: (mm, apply, at) => {
          vId = snapshot(mm, at)[0].id
          apply({ type: 'bind', noteId: 'n', canonicalKey: 'youtube:vvvvvvvvvvv', playbackId: vId }, at)
        }
      },
      { at: s(60), line: [ad1] },
      { at: s(75), line: [ad2] },
      { at: s(140), fn: (mm, _a, at) => (during = snapshot(mm, at)) },
      // 75 s + 79.7 s: later than 120 s after the pod began, within 120 s of its last item.
      { at: s(155), line: [{ ...v, posMs: 60000 }], upd: s(155) },
      { at: s(165), input: { type: 'unbind' } }
    ],
    170
  )
  eq(during?.map((p) => [p.id, p.ad]), [[vId, true]], 'the video stands for the browser through the pod')
  eq(of(log, 'ended').map((e) => e.reason), ['discarded', 'ad'], 'both pod items end as ads, never as playbacks')
  eq(of(log, 'candidate').length, 1, 'only the video was a candidate')
  eq(lastList(snaps)[0]?.id, vId, 'same id after the pod')
  eq(of(log, 'binding').map((e) => e.state), ['bound', 'ad', 'bound', 'unbound'], 'binding bound → ad → bound → unbound')
  const spans = of(log, 'span').map((e) => [(e.span.wallStart - T0) / 1000, (e.span.wallEnd - T0) / 1000, e.span.posStartMs, e.span.posEndMs])
  eq(spans, [[40, 60, 40000, 60000], [155, 165, 60000, 70000]], 'no span covers the pod')
  check(!snaps.some((x) => x.list.some((p) => p.title.startsWith('Live Entertainment') || p.title.startsWith('30%'))), 'no pod item is ever reported')
})

group('pre-roll pod as recorded (15 s, then 79.7 s): no candidate for either ad, the video is the candidate', () => {
  const ad1 = sess('Chrome', '30% OFF na 2ª unidade', 'Kopenhagen', 'Playing', 0, 15)
  const ad2 = sess('Chrome', 'Live Entertainment - Sony × KADOKAWA DREAMS', 'Sony Corporation - Official', 'Playing', 0, 79.7)
  const video = sess('Chrome', 'Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)', 'Rick Astley', 'Playing', 0, 213.1)
  const { log } = run([{ at: s(0), line: [ad1] }, { at: s(15), line: [ad2] }, { at: s(95), line: [video] }], 130)
  const cands = of(log, 'candidate')
  eq(cands.length, 1, 'one candidate')
  check(cands[0] && cands[0].at >= s(115), `the candidate is the video, 20 s after it began (at ${(cands[0]?.at - T0) / 1000}s)`)
  eq(of(log, 'ended').map((e) => e.reason), ['discarded', 'replaced'], 'the first ad is discarded, the second (played 80 s) replaced')
})

group('start-up flap longer than the debounce (recorded twice, 1.6 s): the blink is discarded, not ended', () => {
  const v = sess('Chrome', 'Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)', 'Rick Astley', 'Playing', 0, 213.1)
  const { log, snaps } = run([{ at: s(0), line: [v] }, { at: s(0.4), line: [] }, { at: s(2.2), line: [v] }], 30)
  eq(of(log, 'ended').map((e) => e.reason), ['discarded'], 'the first blink is discarded')
  check(!snaps.some((x) => x.list.some((p) => p.state === 'ended')), 'no ended playback is reported')
  eq(of(log, 'candidate').length, 1, 'one candidate')
})

group('a closing session (status Closed, end 0, no timeline time) is not read as live', () => {
  // Recorded at page start (soak-2026-10.jsonl): "Closed", posMs 0, endMs 0, updated = year 1601.
  const closed = (x) => ({ ...x, status: 'Closed', posMs: 0, endMs: 0, updated: -11644473600000 })
  const recs = sessionsFromRecord({ ev: 'sessions', sessions: [closed(sess('Chrome', 'T', 'A', 'Playing', 3, 300))] }, s(0))
  eq([recs[0]?.status, recs[0]?.positionMs, recs[0]?.endMs, recs[0]?.lastUpdatedAt], ['stopped', null, null, s(0)], 'no timeline from a Closed session')
  // A 90 s clip played 30 s, then a Closed sample: still not a candidate (live would be).
  const clip = sess('Chrome', 'Clip', 'Chan', 'Playing', 0, 90)
  const { log, snaps } = run([{ at: s(0), line: [clip] }, { at: s(30), line: [closed(clip)] }, { at: s(30.2), line: [clip] }], 40)
  eq(of(log, 'candidate').length, 0, 'no candidate')
  check(snaps.every((x) => x.list.every((p) => !p.live && p.durationMs === 90000)), 'never live, duration kept')
})

group('a short item that never gives way is real after 120 s', () => {
  const v = sess('Chrome', 'Long video', 'Chan', 'Playing', 0, 1800)
  const clip = sess('Chrome', 'Short clip', 'Other', 'Playing', 0, 50)
  const { log, snaps } = run([{ at: s(0), line: [v] }, { at: s(40), line: [clip] }], 170)
  eq(of(log, 'ended').map((e) => e.reason), ['gone'], 'the suspended video ends')
  eq(lastList(snaps).map((p) => [p.title, p.state, p.ad]), [['Short clip', 'provisional', false], ['Long video', 'ended', false]], 'the clip is a normal playback; the video is reported ended once')
})

group('eligibility: short videos and muted channels are never candidates', () => {
  const short = sess('MSEdge', 'Ninety seconds', 'Chan', 'Playing', 0, 90)
  const { log: l1 } = run([{ at: s(0), line: [short] }], 120)
  eq(of(l1, 'candidate').length, 0, '≤ 120 s: no candidate')
  const v = sess('MSEdge', 'Muted channel video', 'Loud Channel', 'Playing', 0, 900)
  const { log: l2, snaps } = run([{ at: s(0), line: [v] }], 30, (_m, apply) => apply({ type: 'mutes', mutes: ['channel:loud channel'] }, s(0)))
  eq(of(l2, 'candidate').length, 0, 'muted: no candidate')
  eq(lastList(snaps)[0]?.state, 'muted', 'state muted')
  const paused = sess('MSEdge', 'Paused video', 'Chan', 'Paused', 0, 900)
  const { log: l3 } = run([{ at: s(0), line: [paused] }], 60)
  eq(of(l3, 'candidate').length, 0, 'never playing: no candidate')
})

group('InPrivate and unknown windows pass through; a Short is never a candidate', () => {
  const v = sess('MSEdge', 'Some video', 'Chan', 'Playing', 0, 900)
  const { snaps } = run(
    [
      { at: s(0), line: [v] },
      { at: s(3), fn: (mm, apply, at) => apply({ type: 'window', playbackId: snapshot(mm, at)[0].id, privateWindow: 'unknown', site: null, url: null, short: false }, at) }
    ],
    30
  )
  eq([lastList(snaps)[0]?.privateWindow, lastList(snaps)[0]?.state], ['unknown', 'candidate'], 'unknown window: still a candidate (card only)')
  const { snaps: s2 } = run(
    [
      { at: s(0), line: [v] },
      { at: s(3), fn: (mm, apply, at) => apply({ type: 'window', playbackId: snapshot(mm, at)[0].id, privateWindow: true, site: 'youtube.com', url: null, short: false }, at) }
    ],
    30
  )
  eq(lastList(s2)[0]?.privateWindow, true, 'InPrivate flagged')
  const { log: l3 } = run(
    [
      { at: s(0), line: [v] },
      {
        at: s(3),
        fn: (mm, apply, at) =>
          apply({ type: 'window', playbackId: snapshot(mm, at)[0].id, privateWindow: false, site: 'youtube.com', url: 'https://www.youtube.com/shorts/O6OXQCfPCig', short: true }, at)
      }
    ],
    40
  )
  eq(of(l3, 'candidate').length, 0, 'a /shorts/ URL is never a candidate')
  eq(windowFacts('edge', 'Video - YouTube and 6 more pages - [InPrivate] - Microsoft​ Edge').privateWindow, true, 'Edge InPrivate title')
  eq(windowFacts('edge', 'Video - YouTube and 6 more pages - Personal - Microsoft​ Edge'), { privateWindow: false, profileName: 'Personal' }, 'Edge normal title + profile')
  eq(windowFacts('chrome', 'Video - YouTube - Google Chrome'), { privateWindow: 'unknown', profileName: null }, 'Chrome normal title: unknown until measured (B18)')
  eq(windowFacts('chrome', 'Video - YouTube - Google Chrome (Incognito)').privateWindow, true, 'Chrome Incognito title')
  eq(windowFacts('edge', 'Something else').privateWindow, 'unknown', 'unrecognised title = unknown')
  eq(windowFacts('edge', null).privateWindow, 'unknown', 'no title = unknown')
})

group('drop: a browser the extension covers is forgotten without an end', () => {
  const v = sess('Chrome', 'Covered', 'Chan', 'Playing', 0, 900)
  const { log, snaps } = run([{ at: s(0), line: [v] }, { at: s(5), input: { type: 'drop', browsers: ['chrome'] } }], 10)
  eq(of(log, 'ended').length, 0, 'no ended')
  eq(lastList(snaps).length, 0, 'gone from the snapshot')
})

// ---------- identification rules ----------

group('URL recognition and canonical keys', () => {
  const p = (u) => {
    const x = parseSourceUrl(u)
    return x && [x.provider, x.kind, x.canonicalKey, x.url, x.series?.canonicalKey ?? null, x.series?.index ?? null, x.startMs, x.short]
  }
  eq(
    p('https://www.youtube.com/watch?v=-w53i6Ae-YM&list=PL0vfts4VzfNh4huPTppuH0FZ0-a_qCMe-&index=2&si=abc&t=1m30s'),
    [
      'youtube',
      'video',
      'youtube:-w53i6Ae-YM',
      'https://www.youtube.com/watch?v=-w53i6Ae-YM&list=PL0vfts4VzfNh4huPTppuH0FZ0-a_qCMe-&index=2',
      'youtube:playlist:PL0vfts4VzfNh4huPTppuH0FZ0-a_qCMe-',
      2,
      90000,
      false
    ],
    'watch + playlist'
  )
  eq(p('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=RDdQw4w9WgXcQ&start_radio=1')?.[4], null, 'a mix is not a series')
  eq(p('https://youtu.be/dQw4w9WgXcQ?t=42')?.slice(0, 3).concat([p('https://youtu.be/dQw4w9WgXcQ?t=42')?.[6]]), ['youtube', 'video', 'youtube:dQw4w9WgXcQ', 42000], 'youtu.be')
  eq(p('https://www.youtube.com/shorts/O6OXQCfPCig')?.[7], true, 'shorts')
  eq(p('https://m.youtube.com/watch?v=jNQXAC9IVRw')?.[2], 'youtube:jNQXAC9IVRw', 'mobile host')
  eq(p('youtube.com/watch?v=jNQXAC9IVRw')?.[2], 'youtube:jNQXAC9IVRw', 'address bar without a scheme')
  eq(p('https://www.youtube.com/live/jNQXAC9IVRw')?.[1], 'live', '/live/')
  eq(p('https://www.youtube.com/embed/jNQXAC9IVRw')?.[2], 'youtube:jNQXAC9IVRw', 'embed')
  eq(
    p('https://www.courses.example.com/c/fundamentos-enterprise/sections/123456/lessons/1234567'),
    [
      'circle',
      'lesson',
      'circle:courses.example.com:1234567',
      'https://courses.example.com/c/fundamentos-enterprise/sections/123456/lessons/1234567',
      'circle:courses.example.com:course:fundamentos-enterprise',
      null,
      null,
      false
    ],
    'Circle lesson on a community host'
  )
  eq(p('https://community.example.org/c/space/sections/1/lessons/2')?.[2], 'circle:community.example.org:2', 'any Circle community')
  eq(p('https://www.courses.example.com/c/fundamentos-enterprise')?.[0], 'web', 'a space page is not a lesson')
  eq(p('https://www.udemy.com/course/react-the-complete-guide/learn/lecture/12345#overview')?.slice(0, 3), ['udemy', 'lesson', 'udemy:react-the-complete-guide:12345'], 'udemy')
  eq(p('https://www.coursera.org/learn/machine-learning/lecture/abc12/intro')?.slice(0, 3), ['coursera', 'lesson', 'coursera:machine-learning:abc12'], 'coursera')
  eq(p('https://aluno.hotmart.com/club/x/products/1/content/abc?utm_source=y')?.slice(0, 3), ['hotmart', 'lesson', 'url:https://aluno.hotmart.com/club/x/products/1/content/abc'], 'hotmart, tracking dropped')
  eq(p('https://vimeo.com/1084537')?.slice(0, 3), ['vimeo', 'video', 'url:https://vimeo.com/1084537'], 'vimeo')
  eq(p('https://player.vimeo.com/video/1084537')?.[2], 'url:https://vimeo.com/1084537', 'vimeo player')
  eq(p('https://Example.com/a/b/?b=2&a=1&fbclid=x#frag')?.[2], 'url:https://example.com/a/b?a=1&b=2', 'web: normalized')
  eq(p('ftp://example.com/x'), null, 'not http(s)')
  eq(p('not a url'), null, 'garbage')
  eq(guessKey('youtube.com', '(3) Some Video  Title'), 'title:youtube.com:some video title', 'guess key')
  eq(cleanTitle('(12) Video - YouTube', 'YouTube'), 'Video', 'clean title')
})

group('tab names and sites', () => {
  eq(tabFacts('(3) Video title - YouTube - Audio playing - Memory usage - 418 MB', 'Video title'), { siteLabel: 'YouTube', audio: true }, 'Edge playing tab')
  eq(tabFacts('Video title - YouTube - Discarded - Memory usage - 365 MB', 'Video title'), { siteLabel: 'YouTube', audio: false }, 'background tab')
  eq(tabFacts('Other - YouTube', 'Video title'), null, 'another tab')
  eq(tabFacts('Video title - Vimeo - Reproduzindo áudio', 'Video title'), { siteLabel: 'Vimeo', audio: true }, 'pt-BR marker')
  eq(siteFromLabel('YouTube'), 'youtube.com', 'site of YouTube')
  eq(siteFromLabel('Hotmart'), 'hotmart.com', 'site of a course provider')
})

group('History matching, profiles and Chromium time', () => {
  const now = Date.UTC(2026, 9, 19, 23, 44, 3, 697)
  eq(M.chromiumToMs('13436927043697055'), 1792453443697, 'visit_time as text → epoch ms')
  eq(M.chromiumToMs(M.msToChromium(now).toString()), now, 'round trip')
  const rows = [
    { url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa', title: '(2) My Video - YouTube', visitMs: now - 1000 },
    { url: 'https://www.youtube.com/watch?v=bbbbbbbbbbb', title: 'Other - YouTube', visitMs: now - 2000 },
    { url: 'https://www.courses.example.com/c/curso/sections/1/lessons/77', title: 'Example Courses', visitMs: now - 30_000 },
    { url: 'https://www.courses.example.com/c/curso/sections/1/lessons/76', title: 'Example Courses', visitMs: now - 600_000 }
  ]
  const q = (title, site, seen = now) => M.matchHistory(rows, { title, site, seenAtMs: seen, courseHosts: [] })
  const one = q('My Video', 'youtube.com')
  eq([one?.parsed.canonicalKey, one?.confidence, one?.how], ['youtube:aaaaaaaaaaa', 'exact', 'title'], 'one id → exact')
  const twoRows = [...rows, { url: 'https://youtu.be/ccccccccccc', title: 'My Video - YouTube', visitMs: now - 5000 }]
  const two = M.matchHistory(twoRows, { title: 'My Video', site: 'youtube.com', seenAtMs: now, courseHosts: [] })
  eq([two?.confidence, two?.alternatives.map((x) => x.canonicalKey)], ['high', ['youtube:ccccccccccc']], 'two ids → high on the newest + alternative')
  const lesson = q('Aula sem título no player', 'courses.example.com')
  eq([lesson?.parsed.canonicalKey, lesson?.confidence, lesson?.how], ['circle:courses.example.com:77', 'high', 'time'], 'course host: time correlation within 120 s')
  eq(q('Aula sem título no player', 'courses.example.com', now + 400_000), null, 'no lesson visit in the window')
  eq(q('Unknown thing', 'youtube.com'), null, 'YouTube: no time correlation')
  const ls = { profile: { info_cache: { Default: { name: 'Personal' }, 'Profile 1': { name: 'Work' }, '../evil': { name: 'Evil' } } } }
  eq(M.profileDirFor(ls, 'Work'), 'Profile 1', 'profile by name')
  eq(M.profileDirFor(ls, 'Evil'), null, 'odd folder names refused, and no Default instead (M1)')
  eq(M.profileDirFor(ls, null), null, 'no profile name, several profiles → not read (M1)')
  eq(M.profileDirFor(ls, 'A page title segment'), null, 'an unmapped name → not read (M1)')
  const only = { profile: { info_cache: { 'Profile 3': { name: 'Person 1' } } } }
  eq(M.profileDirFor(only, null), 'Profile 3', 'the only profile listed is the window’s')
  eq(M.profileDirFor(only, 'Something else'), 'Profile 3', 'the only profile, whatever the title says')
  eq(M.profileDirFor({ profile: { info_cache: { '../x': { name: 'X' } } } }, null), null, 'the only profile, but an odd folder')
  eq(M.profileDirFor(null, 'Work'), null, 'no Local State → not read')
  eq(M.profileDirFor({ profile: {} }, 'Work'), null, 'no profile list → not read')
  eq(M.historyLikePatterns(['youtube.com']).slice(0, 2), ['https://youtube.com/%', 'https://%.youtube.com/%'], 'LIKE patterns')
})

group('History query: hosts only (M7)', () => {
  const hosts = M.historyHosts(['school.example.org', 'courses.example.com'])
  eq(M.historyHostOk('https://www.youtube.com/watch?v=aaaaaaaaaaa', hosts), true, 'www.youtube.com')
  eq(M.historyHostOk('https://m.youtube.com/watch?v=aaaaaaaaaaa', hosts), true, 'a subdomain')
  eq(M.historyHostOk('https://www.google.com/url?q=https://www.youtube.com/watch?v=aaaaaaaaaaa', hosts), false, 'a redirect that carries a YouTube URL')
  eq(M.historyHostOk('https://evil.example/x.youtube.com/watch', hosts), false, '.youtube.com/ in a path')
  eq(M.historyHostOk('https://notyoutube.com/watch?v=aaaaaaaaaaa', hosts), false, 'a host that only ends in the name')
  eq(M.historyHostOk('https://lessons.school.example.org/c/a/sections/1/lessons/2', hosts), true, 'a course host the user added')
  eq(M.historyHostOk('ftp://youtube.com/x', hosts), false, 'not http(s)')
  eq(M.historyHostOk('not a url', hosts), false, 'garbage')
  const db = new sqlite.DatabaseSync(':memory:')
  try {
    db.exec('CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT, title TEXT); CREATE TABLE visits (id INTEGER PRIMARY KEY, url INTEGER, visit_time INTEGER)')
    const now = Date.UTC(2026, 9, 20, 12, 0, 0)
    const add = (id, url, title, ago) => {
      db.prepare('INSERT INTO urls (id, url, title) VALUES (?, ?, ?)').run(id, url, title)
      db.prepare('INSERT INTO visits (url, visit_time) VALUES (?, ?)').run(id, M.msToChromium(now - ago))
    }
    add(1, 'https://www.youtube.com/watch?v=aaaaaaaaaaa', 'A - YouTube', 1_000)
    add(2, 'https://www.google.com/url?q=https://www.youtube.com/watch?v=bbbbbbbbbbb', 'redirect', 2_000)
    add(3, 'https://evil.example/c/x/sections/1/lessons/2?u=https://x.courses.example.com/', 'Circle-shaped elsewhere', 3_000)
    add(4, 'https://www.courses.example.com/c/curso/sections/1/lessons/77', 'Example Courses', 4_000)
    add(5, 'https://www.youtube.com/watch?v=ccccccccccc', 'Old - YouTube', 30 * 60 * 60_000)
    add(6, 'https://bank.example/account', 'Bank', 500)
    const rows = M.queryHistoryRows(db, hosts, now - 24 * 60 * 60_000, 2000)
    eq(rows.map((r) => r.url), ['https://www.youtube.com/watch?v=aaaaaaaaaaa', 'https://www.courses.example.com/c/curso/sections/1/lessons/77'], 'only YouTube and course-host rows of the last 24 h reach memory')
    eq(rows[0]?.visitMs, now - 1_000, 'visit_time read as text')
    eq(M.queryHistoryRows(db, hosts, now - 24 * 60 * 60_000, 1).length, 1, 'the row limit counts matching rows only')
  } finally {
    db.close()
  }
})

group('superseded sessions at the transcript read (M3)', () => {
  const db = new sqlite.DatabaseSync(':memory:')
  try {
    db.exec(`CREATE TABLE transcript_chunks (id TEXT PRIMARY KEY, document_id TEXT, workspace_id TEXT, owner_id TEXT,
      transcription_session_id TEXT, source TEXT, start_timestamp TEXT, end_timestamp TEXT, text TEXT, is_final INTEGER,
      detected_speaker_name TEXT, detected_speaker TEXT, provider_details TEXT, created_at TEXT, updated_at TEXT);
      CREATE TABLE note_sources (note_id TEXT UNIQUE, superseded_session_ids TEXT NOT NULL DEFAULT '[]')`)
    const chunk = (id, note, session, t) =>
      db
        .prepare(`INSERT INTO transcript_chunks VALUES (?, ?, 'w', 'o', ?, 'system', ?, ?, ?, 1, NULL, NULL, NULL, '', '')`)
        .run(id, note, session, `2026-10-20T12:00:0${t}.000Z`, `2026-10-20T12:00:0${t}.500Z`, `text ${id}`)
    chunk('m2', 'meeting', 's2', 2)
    chunk('m1', 'meeting', 's1', 1)
    chunk('a1', 'video', 'audio', 1)
    chunk('c1', 'video', 'captions', 2)
    chunk('x1', 'broken', 'audio', 1)
    chunk('o1', 'linked', 'audio', 1)
    db.prepare('INSERT INTO note_sources (note_id, superseded_session_ids) VALUES (?, ?)').run('video', JSON.stringify(['audio']))
    db.prepare('INSERT INTO note_sources (note_id, superseded_session_ids) VALUES (?, ?)').run('broken', 'not json')
    db.prepare('INSERT INTO note_sources (note_id) VALUES (?)').run('linked')
    const s = { db }
    const plain = (note) => db.prepare('SELECT id FROM transcript_chunks WHERE document_id = ? ORDER BY start_timestamp, end_timestamp, id').all(note).map((r) => r.id)
    eq(transcriptRepo.getTranscript(s, 'meeting').map((c) => c.id), plain('meeting'), 'a note without a source: exactly the rows it had')
    eq(transcriptRepo.getTranscript(s, 'linked').map((c) => c.id), ['o1'], 'a source with nothing superseded: every row')
    eq(transcriptRepo.getTranscript(s, 'video').map((c) => c.id), ['c1'], 'a superseded session is left out')
    eq(transcriptRepo.getTranscript(s, 'broken').map((c) => c.id), ['x1'], 'an unreadable list hides nothing')
  } finally {
    db.close()
  }
})

group('the stamped projection only when current (M4)', () => {
  const url = 'https://www.youtube.com/watch?v=aaaaaaaaaaa'
  const note = { id: 'n', title: 'T', notes_md: 'First thought\n\n- a point', notes_text: '', created_at: '2026-10-20T12:00:00.000Z' }
  const stamped = `[01:02](${url}&t=62s) First thought\n\n- [02:03](${url}&t=123s) a point`
  const source = { kind: 'video', title: 'A talk', channel: 'Chan', url, duration_ms: 600_000, live: false, lesson_state: 'pending', lesson_number: null, lesson_label: null, notes_md_stamped: stamped }
  const vars = (notesMarkdown, src = source) =>
    inputs.buildPromptInputs({ note, chunks: [], settings: DEFAULT_SETTINGS, language: 'en', locale: 'en-US', source: { source: src, series: null }, ...(notesMarkdown === undefined ? {} : { notesMarkdown }) }).vars
  eq(vars(undefined).notes, stamped, 'in step with the stored notes: stamped')
  eq(vars('First thought\n\n- a point').notes, stamped, 'in step with the editor: stamped')
  eq(vars('First thought\n\n- a point\n\nTyped just now').notes, 'First thought\n\n- a point\n\nTyped just now', 'the editor is ahead: its text wins')
  eq(vars(undefined, { ...source, notes_md_stamped: '[00:05] Older text' }).notes, note.notes_md, 'a stale projection: the stored notes win')
  const escaped = '\\[01:02\\] First thought\n\n- \\[02:03\\] a point'
  eq(vars(undefined, { ...source, notes_md_stamped: escaped }).notes, escaped, 'escaped stamps without a URL')
  const meeting = inputs.buildPromptInputs({ note, chunks: [], settings: DEFAULT_SETTINGS, language: 'en', locale: 'en-US', notesMarkdown: 'Live text' }).vars
  eq([meeting.notes, meeting.transcript_is_media], ['Live text', false], 'a meeting: unchanged')
})

group('search verification and yt-dlp parsing', () => {
  const json = JSON.stringify({
    entries: [
      { id: 'dQw4w9WgXcQ', title: 'Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)', channel: 'Rick Astley', duration: 214 },
      { id: 'LLFhKaqnWwk', title: 'Rick Astley - Never Gonna Give You Up (Official Animated Video)', channel: 'Rick Astley', duration: 213 },
      { id: 'LQ4w9xiHkrY', title: 'Rick Astley - Never Gonna Give You Up [Remastered In 4K]', channel: 'Enjoy it', duration: 212 }
    ]
  })
  const hits = M.parseSearch(json)
  eq(hits.map((h) => h.id), ['dQw4w9WgXcQ', 'LLFhKaqnWwk', 'LQ4w9xiHkrY'], 'hits')
  const qy = { channel: 'Rick Astley', durationMs: 213100, live: false }
  eq(hits.map((h) => M.verifySearchHit(h, qy)), ['high', 'high', null], 'channel + duration ±2 s')
  eq(M.verifySearchHit(hits[0], { channel: 'Rick Astley', durationMs: 200000, live: false }), null, 'duration off')
  eq(M.verifySearchHit(hits[0], { channel: 'Rick Astley', durationMs: null, live: true }), 'guess', 'live: channel only = guess')
  const meta = M.parseVideoMeta(
    JSON.stringify({
      title: 'T',
      channel: 'Fireship',
      duration: 243,
      live_status: 'not_live',
      language: 'en',
      chapters: [{ start_time: 0, title: 'Intro' }, { start_time: 44, title: 'Two' }],
      subtitles: { en: [], 'pt-BR': [], live_chat: [] },
      automatic_captions: { 'en-orig': [], en: [], fr: [], 'pt-BR': [] },
      description: 'See https://fireship.io/pro and https://discord.gg/fireship.'
    }),
    '2026-10-20T00:00:00.000Z'
  )
  eq(meta?.durationMs, 243000, 'duration')
  eq(meta?.enrichment.chapters, [{ startMs: 0, title: 'Intro' }, { startMs: 44000, title: 'Two' }], 'chapters')
  eq(meta?.enrichment.captionTracks.map((t) => `${t.kind}:${t.lang}`), ['manual:en', 'manual:pt-BR', 'asr:en-orig', 'asr:en'], 'tracks: manual, and auto in the own language only')
  eq(meta?.enrichment.descriptionLinks, ['https://fireship.io/pro', 'https://discord.gg/fireship.'], 'description links')
  eq(M.parsePlaylist(JSON.stringify({ id: 'PLx', title: 'Alibaba', entries: [{ id: 'aaaaaaaaaaa' }, { id: '-w53i6Ae-YM' }] }), '-w53i6Ae-YM'), { id: 'PLx', title: 'Alibaba', index: 2 }, 'playlist position')
  eq(M.parseOEmbed('{"title":"T","author_name":"A"}'), { title: 'T', channel: 'A' }, 'oEmbed')
})

group('drafts', () => {
  const pb = { title: '(1) Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)', artist: 'Rick Astley', durationMs: 213100, live: false }
  const d = M.draftFromUrl(parseSourceUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), pb, 'exact', 'history', 'youtube.com')
  eq([d.canonicalKey, d.confidence, d.title, d.series?.kind, d.series?.canonicalKey, d.lesson], ['youtube:dQw4w9WgXcQ', 'exact', 'Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)', 'channel', 'youtube:channel:rick astley', null], 'video draft')
  const pl = M.draftFromUrl(parseSourceUrl('https://www.youtube.com/watch?v=-w53i6Ae-YM&list=PL0vfts4VzfNh4huPTppuH0FZ0-a_qCMe-&index=2'), pb, 'exact', 'media-session', null)
  eq([pl.series?.kind, pl.lesson], ['playlist', { number: 2, label: null, state: 'numbered' }], 'playlist draft numbered by position')
  const g = M.guessDraft({ title: 'Aula 3 - Arquitetura', artist: null, durationMs: 700000, live: false }, 'hotmart.com')
  eq([g.provider, g.kind, g.confidence, g.canonicalKey, g.lesson?.state], ['hotmart', 'lesson', 'guess', 'title:hotmart.com:aula 3 - arquitetura', 'pending'], 'course guess')
})

// ---------- a recording ----------

/** Replays a recording's lines through a fresh machine; `onEffects(effects, at, m)` sees each step. */
function replayLines(lines, onEffects) {
  const m = createMachine(LIMITS)
  let day = null
  const toMs = (rec) => {
    if (typeof rec.at === 'number') return rec.at
    const t = /^(\d\d):(\d\d):(\d\d)\.(\d{3})$/.exec(rec.ts ?? '')
    if (!t) return null
    day ??= Date.UTC(2026, 0, 1)
    return day + ((Number(t[1]) * 60 + Number(t[2])) * 60 + Number(t[3])) * 1000 + Number(t[4])
  }
  let last = null
  let n = 0
  for (const line of lines) {
    let rec
    try {
      rec = JSON.parse(line)
    } catch {
      continue
    }
    const at = toMs(rec)
    if (at === null || !Array.isArray(rec.sessions)) continue
    // The probe watcher's shape: seconds, no rate, no timeline time.
    const sessions = rec.ev === 'sessions' ? rec.sessions : rec.sessions.map((x) => ({ ...x, posMs: (x.pos ?? 0) * 1000, endMs: (x.end ?? 0) * 1000, rate: 1, updated: at }))
    if (last !== null) for (let t = last + 250; t < at; t += 250) onEffects(step(m, { type: 'tick' }, t), t, m)
    onEffects(step(m, { type: 'sessions', sessions: sessionsFromRecord({ ev: 'sessions', sessions }, at) }, at), at, m)
    last = at
    n++
  }
  if (last !== null) for (let t = last + 250; t <= last + 30_000; t += 250) onEffects(step(m, { type: 'tick' }, t), t, m)
  return { m, n }
}

// Optional local recordings (a muted throwaway browser, public videos only): a folder named by
// NOTULA_MEDIA_RECORDINGS. Without it the recorded groups are skipped.
const RECORDINGS = process.env.NOTULA_MEDIA_RECORDINGS ? resolve(process.env.NOTULA_MEDIA_RECORDINGS) : null
const recording = (name) => {
  if (!RECORDINGS) return null
  try {
    return readFileSync(resolve(RECORDINGS, name), 'utf8').split(/\r?\n/).filter(Boolean)
  } catch {
    return null
  }
}

group('recorded: the active probe (active-2026-10.jsonl)', () => {
  const lines = recording('active-2026-10.jsonl')
  if (!lines) return console.log('  (recording absent, skipped)')
  const cands = []
  const ended = []
  replayLines(lines, (effects, _at, m) => {
    for (const e of effects) {
      const t = [...m.tracks.values()].find((x) => x.id === e.playbackId)
      if (e.type === 'candidate') cands.push(t?.title)
      if (e.type === 'ended') ended.push(e.reason)
    }
  })
  // Rick Astley (no pre-roll), Fireship (playlist), Rick Astley again (the mix after its ad pod), Bee Gees (autoplay).
  eq(cands.map((t) => t?.slice(0, 12)), ['Rick Astley ', 'Alibaba is c', 'Rick Astley ', 'Bee Gees - S'], 'the four real videos are the candidates')
  check(!cands.some((t) => /OFF na|KADOKAWA|behind the screen/.test(t ?? '')), 'no ad and no Short is a candidate')
  eq(ended[0], 'discarded', 'the start-up flap is discarded')
})

group('recorded: the soak, pause and seeks through the reader (soak-2026-10.jsonl)', () => {
  const lines = recording('soak-2026-10.jsonl')
  if (!lines) return console.log('  (recording absent, skipped)')
  const spans = []
  const cands = []
  replayLines(lines, (effects, at, m) => {
    for (const e of effects) {
      if (e.type === 'span') spans.push(e.span)
      if (e.type !== 'candidate') continue
      const t = [...m.tracks.values()].find((x) => x.id === e.playbackId)
      cands.push([t?.artist, t?.endMs, t?.rate])
      // Take notes at once: the binding follows the pause and the two seeks.
      for (const b of step(m, { type: 'bind', noteId: 'n', canonicalKey: 'youtube:zjkBMFhNj_g', playbackId: e.playbackId }, at)) if (b.type === 'span') spans.push(b.span)
    }
  })
  eq(cands, [['Andrej Karpathy', 3587701, 1]], 'one candidate: artist, duration, rate 1')
  const pos = spans.map((x) => [x.posStartMs, x.posEndMs])
  check(pos.length >= 4, `spans closed at the pause, the play and both seeks (${pos.length})`)
  eq(pos[0]?.[1], 321344, 'the pause span ends at the paused position')
  check(pos.some(([a]) => a === 1500000) && pos.some(([a]) => a === 600000), 'spans start at the seek targets')
  check(spans.every((x) => x.rate === 1), 'the paused rate 0 and the seeking rate 0 read as 1')
})

function replayRecording(path) {
  const lines = readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean)
  const { n } = replayLines(lines, print)
  console.log(`${n} session lines replayed`)

  function print(effects, at, m) {
    for (const e of effects) {
      if (e.type === 'changed') {
        const list = snapshot(m, at).map((p) => `${p.browser}:${p.id}:${p.state}${p.ad ? ':ad' : ''}:title(${p.title.length})`)
        console.log(`${new Date(at).toISOString().slice(11, 23)} changed ${list.join(' ')}`)
      } else console.log(`${new Date(at).toISOString().slice(11, 23)} ${e.type} ${e.playbackId ?? ''} ${e.reason ?? ''}`)
    }
  }
}

if (file) {
  replayRecording(file)
} else {
  console.log(`\n${checks - failures}/${checks} checks passed`)
  process.exit(failures ? 1 : 0)
}
