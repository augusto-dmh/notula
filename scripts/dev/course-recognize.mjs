// SPDX-License-Identifier: Apache-2.0
// Dev-only harness for Courses recognition (src/main/sources/recognize.ts). Runs the course and
// lesson rule tables as cases, the contradictions, the generic-title rule, and the measured
// shapes: a Circle community app with two spaces, a Hubla app holding a combo of products, and a
// YouTube channel. Every host, id and title is a placeholder.
//
// Run:  node scripts/dev/course-recognize.mjs     every case; exits 1 on a failure
//
// The TypeScript sources load through Node's type stripping; the resolve hook below maps
// `@shared/…` and extensionless relative imports to their `.ts` files.

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

const R = await import(pathToFileURL(resolve(root, 'src/main/sources/recognize.ts')).href)

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

const NOW = '2026-11-01T12:00:00.000Z'
const COMMUNITY = 'community.example.com'
const CIRCLE_APP = 'Chrome._crx_abcdefghijqrstuvwxyzabcdef'
const HUBLA_APP = 'app.hub.la-0a1b2c3d_example!App'
const HUBLA_AREA = 'https://app.hub.la/m/area-1'

function course(id, title, { kind = 'course', provider = 'web', key = `course:${id}`, apps = [], hosts = [], titles = [], keys = [], windowRead = false, registered = true } = {}) {
  return {
    id,
    workspace_id: 'w',
    owner_id: 'o',
    kind,
    provider,
    canonical_key: key,
    title,
    folder_id: null,
    state: 'active',
    registered_at: registered ? NOW : null,
    on_play: 'record',
    on_end: 'notes',
    match: registered ? { apps, hosts, titles, keys, windowRead } : null,
    catalog_origin: null,
    created_at: NOW,
    updated_at: NOW
  }
}

function items(seriesId, rows) {
  return rows.map((r, i) => ({
    id: `${seriesId}-i${i + 1}`,
    workspace_id: 'w',
    owner_id: 'o',
    series_id: seriesId,
    number: r.number ?? i + 1,
    section: r.section ?? null,
    title: r.title,
    url: r.url ?? null,
    canonical_key: r.key ?? null,
    duration_ms: r.durationMs ?? null,
    position: i
  }))
}

const appOf = (appUserModelId, name, host = null, browser = 'chrome') => ({
  appUserModelId,
  mapping: { appUserModelId, browser, profile: 'Default', appId: 'abcdefghijklmnopqrstuvwxyzabcdef', name, host, state: 'mapped' }
})

function signals(over = {}) {
  return {
    app: null,
    session: { title: '', artist: null },
    windowTitle: null,
    timing: { durationMs: null, positionMs: null, live: false },
    history: null,
    addressBar: null,
    windowRead: null,
    ...over
  }
}

const read = (over = {}) => ({ heading: null, course: null, breadcrumb: [], section: null, item: null, ...over })

const circleLesson = (space, section, lesson) => `https://${COMMUNITY}/c/${space}/sections/${section}/lessons/${lesson}`
const url = (u) => ({ url: u, canonicalKey: null })

// The Circle community: space `fundamentals` is in Courses, space `recordings` is not.
const fundamentalsApp = appOf(CIRCLE_APP, 'Example Community', null)
const fundamentals = {
  series: course('c-fund', 'Fundamentals', {
    provider: 'circle',
    key: `circle:${COMMUNITY}:course:fundamentals`,
    apps: [{ browser: 'chrome', appUserModelId: CIRCLE_APP, profile: 'Default', appId: 'abcdefghijklmnopqrstuvwxyzabcdef' }],
    hosts: [COMMUNITY],
    titles: ['[Course] Fundamentals | Example Community'],
    keys: [`circle:${COMMUNITY}:course:fundamentals`],
    windowRead: true
  }),
  catalog: items('c-fund', [
    { section: 'Module A', title: 'Welcome', url: circleLesson('fundamentals', 1, 101), key: `circle:${COMMUNITY}:101`, durationMs: 600_000 },
    { section: 'Module A', title: 'Setting up', durationMs: 1_200_000 },
    { section: 'Module B', title: 'First steps', durationMs: 1_800_000 },
    { section: 'Module B', title: 'Going further', durationMs: 1_801_500 }
  ]),
  finishedItemIds: []
}

// The Hubla app holds a combo: System Design is in Courses (a list by module), Other Product is not.
const hublaApp = appOf(HUBLA_APP, 'Hubla', 'app.hub.la', 'edge')
const hublaMatchApp = { browser: 'edge', appUserModelId: HUBLA_APP, profile: 'Default', appId: 'abcdefghijklmnopqrstuvwxyzabcdef' }
const systemDesign = {
  series: course('c-sd', 'System Design', { apps: [hublaMatchApp], hosts: ['app.hub.la'], keys: ['hubla:app.hub.la:m:area-1'], windowRead: true }),
  catalog: items('c-sd', [{ title: 'Introduction' }, { title: 'Caching' }, { title: 'Queues (Filas)' }, { title: 'Load balancing' }]),
  finishedItemIds: []
}

// ---------- the course rules ----------

test('course 1: a lesson URL whose course key is the course’s → exact', () => {
  const r = R.recognize(signals({ app: fundamentalsApp, session: { title: '[Course] Fundamentals | Example Community', artist: null }, history: url(circleLesson('fundamentals', 2, 999)) }), [fundamentals])
  eq([r.courseId, r.confidence], ['c-fund', 'exact'], 'course')
  check(r.signals.includes('course:1') && r.signals.includes('S5'), 'rule 1 from S5')
})

test('course 1: a lesson key in the list → exact, lesson 1', () => {
  const r = R.recognize(signals({ addressBar: url(circleLesson('fundamentals', 1, 101)), session: { title: 'Welcome', artist: null } }), [fundamentals])
  eq([r.courseId, r.confidence, r.lesson.itemId, r.lesson.state, r.lesson.origin], ['c-fund', 'exact', 'c-fund-i1', 'numbered', 'catalog'], 'course and lesson')
  check(r.signals.includes('lesson:1') && r.signals.includes('S6'), 'rule 1 from S6')
})

test('course 2: the window read names the course (Circle’s top bar) → exact', () => {
  const r = R.recognize(signals({ app: fundamentalsApp, session: { title: 'Something | Example Community', artist: null }, windowRead: read({ course: 'Fundamentals', heading: 'First steps', section: 'Module B' }) }), [fundamentals])
  eq([r.courseId, r.confidence, r.lesson.itemId], ['c-fund', 'exact', 'c-fund-i3'], 'course and lesson')
  check(r.signals.includes('course:2') && r.signals.includes('lesson:2'), 'rules 2 and 2')
})

test('course 3: the session title is an item’s title in exactly one course of the app → exact', () => {
  const r = R.recognize(signals({ app: hublaApp, session: { title: 'Caching', artist: null } }), [systemDesign])
  eq([r.courseId, r.confidence, r.lesson.itemId, r.lesson.state], ['c-sd', 'exact', 'c-sd-i2', 'numbered'], 'course and lesson')
  check(r.signals.includes('course:3') && r.signals.includes('lesson:4'), 'rules 3 and 4')
})

test('course 4: a learned title → title', () => {
  const r = R.recognize(signals({ app: null, session: { title: '[Course] Fundamentals | Example Community', artist: null } }), [fundamentals])
  eq([r.courseId, r.confidence], ['c-fund', 'title'], 'course')
  check(r.signals.includes('course:4'), 'rule 4')
})

test('course 4: blocked by a lesson URL pointing to another space', () => {
  const r = R.recognize(signals({ session: { title: '[Course] Fundamentals | Example Community', artist: null }, addressBar: url(circleLesson('recordings', 7, 700)) }), [fundamentals])
  eq(r.confidence, 'none', 'confidence')
})

test('course 4: blocked by a window read pointing to another course', () => {
  const other = { series: course('c-other', 'Other Course', { apps: [], hosts: [] }), catalog: items('c-other', [{ title: 'Only here' }]), finishedItemIds: [] }
  const r = R.recognize(signals({ session: { title: '[Course] Fundamentals | Example Community', artist: null }, windowRead: read({ heading: 'Only here' }) }), [fundamentals, other])
  eq([r.courseId, r.confidence], ['c-other', 'exact'], 'the read wins (rule 2)')
})

test('course 5: the app’s one course → app', () => {
  const r = R.recognize(signals({ app: fundamentalsApp, session: { title: 'A page | Example Community', artist: null } }), [fundamentals])
  eq([r.courseId, r.confidence], ['c-fund', 'app'], 'course')
  check(r.signals.includes('course:5'), 'rule 5')
})

test('course 5: blocked by a learned title of another course', () => {
  const other = { series: course('c-other', 'Other Course', { titles: ['Shared Page | Example Community'] }), catalog: [], finishedItemIds: [] }
  const r = R.recognize(signals({ app: fundamentalsApp, session: { title: 'Shared Page | Example Community', artist: null } }), [fundamentals, other])
  eq([r.courseId, r.confidence], ['c-other', 'title'], 'the learned title wins (rule 4)')
})

test('course 5: blocked by a window read naming another course', () => {
  const other = { series: course('c-other', 'Other Course'), catalog: items('c-other', [{ title: 'Elsewhere lesson' }]), finishedItemIds: [] }
  const r = R.recognize(signals({ app: fundamentalsApp, session: { title: 'A page | Example Community', artist: null }, windowRead: read({ heading: 'Elsewhere lesson' }) }), [fundamentals, other])
  eq(r.confidence, 'none', 'confidence')
})

test('course 6: one app, several courses, nothing tells them apart → ambiguous', () => {
  const second = { series: course('c-sd2', 'Second Product', { apps: [hublaMatchApp], hosts: ['app.hub.la'] }), catalog: items('c-sd2', [{ title: 'Other lesson' }]), finishedItemIds: [] }
  const r = R.recognize(signals({ app: hublaApp, session: { title: 'Unlisted lesson', artist: null } }), [systemDesign, second])
  eq([r.courseId, r.confidence, r.candidates], [null, 'ambiguous', ['c-sd', 'c-sd2']], 'ambiguous')
  check(r.signals.includes('course:6'), 'rule 6')
})

test('course 7: nothing fits → none', () => {
  const r = R.recognize(signals({ session: { title: 'Some video', artist: 'Someone' } }), [fundamentals, systemDesign])
  eq([r.courseId, r.confidence, r.lesson.state], [null, 'none', 'pending'], 'none')
  check(r.signals.includes('course:7'), 'rule 7')
})

test('only courses in Courses are matched', () => {
  const removed = { ...fundamentals, series: { ...fundamentals.series, registered_at: null } }
  const r = R.recognize(signals({ addressBar: url(circleLesson('fundamentals', 1, 101)) }), [removed])
  eq(r.confidence, 'none', 'confidence')
})

test('recognize is deterministic', () => {
  const s = signals({ app: hublaApp, session: { title: 'Caching', artist: null }, timing: { durationMs: 776_400, positionMs: 1_000, live: false } })
  eq(R.recognize(s, [systemDesign]), R.recognize(s, [systemDesign]), 'same input, same output')
})

// ---------- the generic-title rule ----------

test('generic titles: never matched, never learned', () => {
  const learnedGeneric = { ...systemDesign, series: { ...systemDesign.series, apps: [], match: { ...systemDesign.series.match, apps: [], titles: ['Hubla'] } } }
  const r = R.recognize(signals({ session: { title: 'Hubla', artist: null }, history: url(`${HUBLA_AREA}`) }), [learnedGeneric])
  check(r.confidence !== 'title', `a bare app or site name never matches a learned title (got ${r.confidence})`)
  const g = R.genericNames(signals({ app: hublaApp }))
  check(R.isGenericTitle('Hubla', g), '"Hubla" is generic (the app name)')
  check(R.isGenericTitle('hub.la', g), 'the host is generic')
  check(!R.isGenericTitle('Caching', g), 'a lesson title is not')
  eq(R.learnTitles(signals({ app: hublaApp, session: { title: 'Hubla', artist: null } }), systemDesign), null, 'not learned')
  const circle = R.genericNames(signals({ app: fundamentalsApp }))
  check(R.isGenericTitle('Example Community', circle), '"Example Community" is generic')
  check(!R.isGenericTitle('Recordings, class 3 | Example Community', circle), 'a space title is not')
})

test('learned titles: recorded once, at most 20, oldest dropped', () => {
  const s = signals({ app: fundamentalsApp, session: { title: 'A new page | Example Community', artist: null } })
  const next = R.learnTitles(s, fundamentals)
  eq(next, ['[Course] Fundamentals | Example Community', 'A new page | Example Community'], 'appended')
  eq(R.learnTitles(signals({ app: fundamentalsApp, session: { title: '[Course] Fundamentals | Example Community', artist: null } }), fundamentals), null, 'already known')
  eq(R.learnTitles(signals({ app: hublaApp, session: { title: 'Caching', artist: null } }), systemDesign), null, 'an item’s title is not learned')
  const full = { ...fundamentals, series: { ...fundamentals.series, match: { ...fundamentals.series.match, titles: Array.from({ length: 20 }, (_, i) => `Page ${i} | Example Community`) } } }
  const capped = R.learnTitles(s, full)
  eq([capped.length, capped[0], capped.at(-1)], [20, 'Page 1 | Example Community', 'A new page | Example Community'], 'capped')
})

// ---------- the lesson rules ----------

test('lesson 2: heading plus section when the list has sections', () => {
  const r = R.recognize(signals({ app: fundamentalsApp, windowRead: read({ course: 'Fundamentals', heading: 'Setting up', section: 'Module A' }) }), [fundamentals])
  eq([r.lesson.itemId, r.lesson.state, r.lesson.label], ['c-fund-i2', 'numbered', 'Module A'], 'lesson')
})

test('lesson 2: Circle’s item marker within its section', () => {
  const r = R.recognize(signals({ app: fundamentalsApp, windowRead: read({ course: 'Fundamentals', heading: 'Renamed on the site', section: 'Module B', item: { label: null, index: 2 } }) }), [fundamentals])
  eq([r.lesson.itemId, r.lesson.number], ['c-fund-i4', 4], 'lesson')
  check(r.signals.includes('lesson:2'), 'rule 2')
})

test('lesson 2: the same heading in two sections needs the module', () => {
  const twice = { ...fundamentals, catalog: items('c-fund', [{ section: 'A', title: 'Recap' }, { section: 'B', title: 'Recap' }]) }
  const r = R.recognize(signals({ app: fundamentalsApp, windowRead: read({ course: 'Fundamentals', heading: 'Recap', section: 'B' }) }), [twice])
  eq(r.lesson.itemId, 'c-fund-i2', 'the module picks')
  eq(R.itemFromRead(read({ heading: 'Recap' }), twice.catalog), null, 'no module: no match')
})

test('lesson 3: one keyless item within ±2 s', () => {
  const r = R.recognize(signals({ app: fundamentalsApp, session: { title: 'A page | Example Community', artist: null }, timing: { durationMs: 1_201_900, positionMs: 0, live: false } }), [fundamentals])
  eq([r.lesson.itemId, r.lesson.state], ['c-fund-i2', 'numbered'], 'lesson')
  check(r.signals.includes('lesson:3'), 'rule 3')
})

test('lesson 3: two items within ±2 s → no match', () => {
  const r = R.recognize(signals({ app: fundamentalsApp, session: { title: 'A page | Example Community', artist: null }, timing: { durationMs: 1_800_700, positionMs: 0, live: false } }), [fundamentals])
  check(!r.signals.includes('lesson:3'), 'not rule 3')
  eq(r.lesson.state, 'pending', 'pending')
})

test('lesson 3: an item with a key is not matched by duration', () => {
  const r = R.recognize(signals({ app: fundamentalsApp, session: { title: 'A page | Example Community', artist: null }, timing: { durationMs: 600_000, positionMs: 0, live: false } }), [fundamentals])
  check(!r.signals.includes('lesson:3'), 'not rule 3')
})

test('lesson 4: title equality', () => {
  const r = R.recognize(signals({ app: hublaApp, session: { title: 'Load balancing', artist: null } }), [systemDesign])
  eq([r.lesson.itemId, r.lesson.number, r.lesson.state, r.lesson.origin], ['c-sd-i4', 4, 'numbered', 'catalog'], 'lesson')
})

test('lesson 5: the item after the newest finished lesson → guessed', () => {
  const watched = { ...fundamentals, finishedItemIds: ['c-fund-i2', 'c-fund-i1'] }
  const r = R.recognize(signals({ app: fundamentalsApp, session: { title: 'A page | Example Community', artist: null } }), [watched])
  eq([r.lesson.itemId, r.lesson.number, r.lesson.state, r.lesson.origin], ['c-fund-i3', 3, 'guessed', null], 'lesson')
  check(r.signals.includes('lesson:5'), 'rule 5')
})

test('lesson 6: otherwise pending', () => {
  const r = R.recognize(signals({ app: fundamentalsApp, session: { title: 'A page | Example Community', artist: null } }), [fundamentals])
  eq([r.lesson.itemId, r.lesson.state, r.lesson.label], [null, 'pending', null], 'lesson')
  check(r.signals.includes('lesson:6'), 'rule 6')
})

test('a window read naming a lesson the list is missing → pending, with that title', () => {
  const r = R.recognize(signals({ app: fundamentalsApp, windowRead: read({ course: 'Fundamentals', heading: 'Bonus lesson', section: 'Module C' }) }), [fundamentals])
  eq([r.courseId, r.lesson.state, r.lesson.label], ['c-fund', 'pending', 'Bonus lesson'], 'lesson')
})

test('finishedItems: newest finish first', () => {
  eq(
    R.finishedItems([
      { catalogItemId: 'a', finished: true, lastWatchedAt: '2026-10-01T00:00:00Z' },
      { catalogItemId: 'b', finished: false, lastWatchedAt: '2026-10-03T00:00:00Z' },
      { catalogItemId: 'c', finished: true, lastWatchedAt: '2026-10-02T00:00:00Z' },
      { catalogItemId: null, finished: true, lastWatchedAt: '2026-10-04T00:00:00Z' }
    ]),
    ['c', 'a'],
    'order'
  )
})

// ---------- the measured shapes ----------

test('Circle app, two spaces: the space in Courses is recognized', () => {
  const r = R.recognize(
    signals({ app: fundamentalsApp, session: { title: '[Course] Fundamentals | Example Community', artist: null }, history: url(circleLesson('fundamentals', 1, 101)), timing: { durationMs: 7_635_900, positionMs: 0, live: false } }),
    [fundamentals]
  )
  eq([r.courseId, r.confidence, r.lesson.itemId], ['c-fund', 'exact', 'c-fund-i1'], 'course and lesson')
})

test('Circle app, two spaces: the other space (not in Courses) → none', () => {
  const r = R.recognize(
    signals({ app: fundamentalsApp, session: { title: 'Recordings, class 3 | Example Community', artist: null }, history: url(circleLesson('recordings', 3, 303)), timing: { durationMs: 7_635_900, positionMs: 0, live: false } }),
    [fundamentals]
  )
  eq([r.courseId, r.confidence], [null, 'none'], 'none')
  const read2 = R.recognize(
    signals({ app: fundamentalsApp, session: { title: 'Recordings, class 3 | Example Community', artist: null }, history: url(circleLesson('recordings', 3, 303)), windowRead: read({ course: 'Recordings', heading: 'Class 3' }) }),
    [fundamentals]
  )
  eq(read2.confidence, 'none', 'with the window read too')
})

test('Hubla combo with the window read → exact (module › lesson, a list by module)', () => {
  const other = { series: course('c-op', 'Other Product', { apps: [hublaMatchApp], hosts: ['app.hub.la'], keys: ['hubla:app.hub.la:m:area-1'] }), catalog: items('c-op', [{ title: 'Unrelated module' }]), finishedItemIds: [] }
  const r = R.recognize(
    signals({
      app: hublaApp,
      session: { title: 'message queue', artist: null },
      history: url(`${HUBLA_AREA}/p/lesson-77`),
      windowRead: read({ heading: 'message queue', breadcrumb: ['System Design Product', 'Queues (Filas)', 'message queue'], section: 'Queues (Filas)', item: { label: 'Conteúdo 2', index: 2 } })
    }),
    [systemDesign, other]
  )
  eq([r.courseId, r.confidence, r.lesson.itemId, r.lesson.number, r.lesson.state], ['c-sd', 'exact', 'c-sd-i3', 3, 'numbered'], 'course and lesson')
  check(r.signals.includes('course:2') && r.signals.includes('lesson:2'), 'rules 2 and 2')
})

test('Hubla combo without the window read, session title in the list → exact by rule 3', () => {
  const r = R.recognize(signals({ app: hublaApp, session: { title: 'Queues (Filas)', artist: null }, timing: { durationMs: 776_400, positionMs: 0, live: false } }), [systemDesign])
  eq([r.courseId, r.confidence, r.lesson.itemId], ['c-sd', 'exact', 'c-sd-i3'], 'course and lesson')
  check(r.signals.includes('course:3'), 'rule 3')
})

test('Hubla combo, session title not in the list (by module) → app, pending, labelled', () => {
  const r = R.recognize(signals({ app: hublaApp, session: { title: 'message queue', artist: null }, windowTitle: 'message queue - Audio playing', timing: { durationMs: 776_400, positionMs: 0, live: false } }), [systemDesign])
  eq([r.courseId, r.confidence, r.lesson.state, r.lesson.label, r.lesson.itemId], ['c-sd', 'app', 'pending', 'message queue', null], 'course and lesson')
})

test('Hubla: a second play of a picked lesson (URL remembered) → numbered by rule 1', () => {
  const picked = { ...systemDesign, catalog: systemDesign.catalog.map((it, i) => (i === 2 ? { ...it, url: `${HUBLA_AREA}/p/lesson-77`, canonical_key: `url:${HUBLA_AREA}/p/lesson-77` } : it)) }
  const r = R.recognize(signals({ app: hublaApp, session: { title: 'message queue', artist: null }, history: url(`${HUBLA_AREA}/p/lesson-77`) }), [picked])
  eq([r.courseId, r.confidence, r.lesson.itemId, r.lesson.state], ['c-sd', 'exact', 'c-sd-i3', 'numbered'], 'course and lesson')
})

test('A YouTube channel in Courses', () => {
  const channel = {
    series: course('c-yt', 'Example Channel', { kind: 'channel', provider: 'youtube', key: 'youtube:channel:example channel', hosts: ['youtube.com'], keys: [] }),
    catalog: [],
    finishedItemIds: []
  }
  const watch = 'https://www.youtube.com/watch?v=abcdefghijk'
  const r = R.recognize(signals({ session: { title: 'Episode one', artist: 'Example Channel' }, addressBar: url(watch) }), [channel])
  eq([r.courseId, r.confidence, r.lesson.state, r.lesson.label], ['c-yt', 'exact', 'pending', 'Episode one'], 'the channel')
  const other = R.recognize(signals({ session: { title: 'Another video', artist: 'Someone Else' }, addressBar: url(watch) }), [channel])
  eq(other.confidence, 'none', 'another channel')
  const playlist = {
    series: course('c-pl', 'Example Playlist', { kind: 'playlist', provider: 'youtube', key: 'youtube:playlist:PLexample01', hosts: ['youtube.com'] }),
    catalog: items('c-pl', [{ title: 'Part one', url: watch, key: 'youtube:abcdefghijk' }]),
    finishedItemIds: []
  }
  const pl = R.recognize(signals({ session: { title: 'Part one', artist: 'Someone' }, addressBar: url(`${watch}&list=PLexample01`) }), [playlist, channel])
  eq([pl.courseId, pl.confidence, pl.lesson.itemId], ['c-pl', 'exact', 'c-pl-i1'], 'a playlist')
})

// ---------- helpers ----------

test('courseUrl: course keys and lesson pages', () => {
  const c = R.courseUrl(circleLesson('fundamentals', 1, 101))
  eq([c.courseKeys, c.lesson], [[`circle:${COMMUNITY}:course:fundamentals`], true], 'Circle lesson')
  const root = R.courseUrl(`https://${COMMUNITY}/c/fundamentals`)
  eq([root.courseKeys, root.lesson], [[`circle:${COMMUNITY}:course:fundamentals`], false], 'Circle course root')
  const h = R.courseUrl(`${HUBLA_AREA}/p/lesson-77`)
  eq([h.courseKeys, h.lesson], [['hubla:app.hub.la:m:area-1'], true], 'Hubla lesson')
  eq(R.courseUrl(HUBLA_AREA).lesson, false, 'Hubla member area root')
  eq(R.courseUrl('https://www.youtube.com/watch?v=abcdefghijk&list=PLexample01', 'Example Channel').courseKeys, ['youtube:playlist:plexample01', 'youtube:channel:example channel'], 'YouTube')
})

test('cleanWindowTitle: browser decorations and the app name', () => {
  eq(R.cleanWindowTitle('message queue - Audio playing', 'Hubla'), 'message queue', 'Edge app window')
  eq(R.cleanWindowTitle('Example Community - Recordings, class 3', 'Example Community'), 'Recordings, class 3', 'app name prefix')
  eq(R.cleanWindowTitle(null, null), null, 'null')
})

test('pickLessonVisit: 120 s before to 5 s after, lesson URLs only, newest', () => {
  const seen = 1_000_000_000
  const rows = [
    { url: circleLesson('fundamentals', 1, 101), visitMs: seen - 130_000 },
    { url: circleLesson('fundamentals', 1, 102), visitMs: seen - 60_000 },
    { url: `https://${COMMUNITY}/c/fundamentals`, visitMs: seen - 1_000 },
    { url: circleLesson('fundamentals', 1, 103), visitMs: seen + 6_000 }
  ]
  eq(R.pickLessonVisit(rows, seen)?.canonicalKey, `circle:${COMMUNITY}:102`, 'the lesson in the window')
  eq(R.pickLessonVisit([], seen), null, 'none')
})

console.log(`\n${checks} checks, ${failures} failed`)
process.exit(failures ? 1 : 0)
