// SPDX-License-Identifier: Apache-2.0
// Dev-only check for the Courses storage (migration 19), on synthetic data only. It never opens
// the real data folder.
//
//   node scripts/dev/courses-storage-check.mjs [--prev <git rev>] [--keep]
//
// 1. Builds the storage engine of the previous release (`--prev`, a schema-18 tree; default the
//    merge base of HEAD and main, else main) and of this tree for Node, with Vite (dependencies
//    stay external), and drives each through its RPC dispatch, as the storage worker does.
// 2. The previous build writes a schema-18 database with series, notes, sources, spans and lesson
//    lists. This tree upgrades it to 19: every row kept, the five course columns at their
//    defaults, no CHECK on them, the schema of a fresh database and a backup of the old file. An
//    injected failure rolls back: the file stays at 18 with every row, and the previous build
//    still opens and writes it.
// 3. On the upgraded file: register, update and unregister round trips (unregistering keeps the
//    folder, the lesson list, the notes and the behavior; registering again restores the behavior
//    given), the match checks on write, a damaged match read as empty (and logged), the lesson
//    list's origin, the picker (manual numbers win) and remembered lesson keys.
// 4. The course view on a seeded course: watched %, finished at 90 %, lessons with notes (trashed
//    notes don't count), the next lesson (after the most recently finished; with nothing
//    finished, the first without a note), Needs a lesson, and Courses ordered by last watched.
// 5. The storage review's fixes: the course and series lists prepare as many statements for more
//    series (no per-series reads), sites and apps only for a registered series, a pick of an item
//    without a number stays counted, finished on the raw share (89.5 % isn't), manual lessons
//    against updates and replaced sources, learned titles and hosts trimmed instead of refused,
//    `discardSourceRun`, and the export's `series.json` (a course with no notes included).
//
// Exits 1 on any failure. `--keep` keeps the scratch folder.

import { randomBytes, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { builtinModules, createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const require = createRequire(join(ROOT, 'package.json'))
const Database = require('better-sqlite3-multiple-ciphers')

const args = process.argv.slice(2)
const PREV_REV = args.includes('--prev') ? args[args.indexOf('--prev') + 1] : mergeBase()
const KEEP = args.includes('--keep')
const OUT = join(tmpdir(), 'notula-courses-storage-check')
/** The schema this tree migrates to (read from the source), and the one before Courses. */
const TARGET = Number(/export const SCHEMA_VERSION = (\d+)/.exec(readFileSync(join(ROOT, 'src/main/storage/protocol.ts'), 'utf8'))[1])
const PREV = 18
const COURSE_COLUMNS = { registered_at: null, on_play: 'record', on_end: 'notes', match_json: null, catalog_origin: null }

/** Where this branch left main, so the default needs no commit id; main when git can't tell. */
function mergeBase() {
  try {
    return execFileSync('git', ['merge-base', 'HEAD', 'main'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return 'main'
  }
}

// ---------- a tiny runner ----------

let failures = 0

function check(name, ok, detail) {
  if (!ok) failures++
  const extra = detail === undefined ? '' : typeof detail === 'string' ? ` ${detail}` : ` ${JSON.stringify(detail)}`
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok && typeof detail !== 'string' ? '' : extra}`)
}

function throws(fn, pattern) {
  try {
    fn()
    return 'no error'
  } catch (err) {
    return pattern.test(err.message) ? true : err.message
  }
}

// ---------- the two engines ----------

/** `rev`'s `src` folder, extracted under `dir`. */
function sourceTree(rev, dir) {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const tar = join(dir, 'src.tar')
  execFileSync('git', ['archive', '-o', tar, rev, 'src'], { cwd: ROOT })
  execFileSync('tar', ['-xf', basename(tar)], { cwd: dir })
  rmSync(tar)
  return dir
}

/** Builds `tree`'s storage engine for Node and imports it; dependencies stay external. */
async function bundle(tree, name) {
  const { build } = await import(pathToFileURL(require.resolve('vite')).href)
  const outDir = join(OUT, name)
  const isBare = (id) => !id.startsWith('.') && !id.startsWith('/') && !id.startsWith('@shared') && !/^[A-Za-z]:[\\/]/.test(id) && !id.startsWith('\0')
  const externals = {
    name: 'externals',
    enforce: 'pre',
    resolveId(id) {
      if (!isBare(id)) return null
      return { id: id.startsWith('node:') || builtinModules.includes(id) ? id : import.meta.resolve(id), external: true }
    }
  }
  await build({
    configFile: false,
    logLevel: 'warn',
    root: tree,
    resolve: { alias: { '@shared': join(tree, 'src/shared') } },
    plugins: [externals],
    build: {
      ssr: true,
      outDir,
      emptyOutDir: true,
      minify: false,
      target: 'node22',
      rolldownOptions: { input: { engine: join(tree, 'src/main/storage/engine.ts') }, output: { format: 'es', entryFileNames: '[name].mjs' } }
    }
  })
  return import(pathToFileURL(join(outDir, 'engine.mjs')).href)
}

const engines = []

/** One engine, called the way the storage worker calls it; results cross a structured clone like a port. */
function client(Engine) {
  const logs = []
  const engine = new Engine((e) => {
    if (e.type === 'log') logs.push(e)
  })
  engines.push(engine)
  let id = 0
  const call = (method, ...params) => {
    const reply = engine.handle({ id: ++id, method, params })
    if (!reply.ok) throw new Error(`${reply.error.code}: ${reply.error.message}`)
    return structuredClone(reply.result)
  }
  return { call, logs }
}

const openParams = (dataDir, keyHex, extra = {}) => ({
  dataDir,
  keyHex,
  appVersion: '0.0.0-check',
  devFailMigration: false,
  devVersionAhead: false,
  housekeeping: false,
  ...extra
})

// ---------- reading a file directly ----------

function openRaw(dataDir, keyHex, opts = {}) {
  const db = new Database(dataDir.endsWith('.db') ? dataDir : join(dataDir, 'notula.db'), { fileMustExist: true, ...opts })
  db.pragma(`cipher = 'sqlcipher'`)
  db.pragma('legacy = 4')
  db.pragma(`key = "x'${keyHex}'"`)
  return db
}

/** The schema version and every row of every table, as sorted JSON lines. */
function snapshot(dataDir, keyHex) {
  const db = openRaw(dataDir, keyHex, { readonly: true })
  try {
    const version = db.pragma('user_version', { simple: true })
    const names = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all().map((r) => r.name)
    const tables = {}
    for (const t of names) {
      tables[t] = db
        .prepare(`SELECT * FROM "${t}"`)
        .all()
        .map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Buffer.isBuffer(v) ? `x'${v.toString('hex')}'` : v])))
    }
    return { version, tables }
  } finally {
    db.close()
  }
}

const lines = (rows) => rows.map((r) => JSON.stringify(r)).sort()

function shape(dataDir, keyHex) {
  const db = openRaw(dataDir, keyHex, { readonly: true })
  try {
    return db
      .prepare(`SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`)
      .all()
      .map((r) => `${r.type} ${r.name} ${r.tbl_name} ${(r.sql ?? '').replace(/\s+/g, ' ')}`)
  } finally {
    db.close()
  }
}

/** Tables whose rows differ, after `transform` maps the old rows to what the new file should hold. */
function tableDiff(before, after, transform = {}) {
  const names = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()
  return names.filter((t) => {
    const want = lines((transform[t] ?? ((x) => x))(before[t] ?? []))
    const got = lines(after[t] ?? [])
    return want.join('\n') !== got.join('\n')
  })
}

// ---------- the synthetic data set ----------

const T0 = Date.parse('2026-10-05T09:00:00.000Z')
const HOUR = 3_600_000
const BEHAVIOR = { onPlay: 'ask', onEnd: 'button' }
const MATCH = {
  apps: [{ browser: 'chrome', appUserModelId: 'Chrome._crx_aaaabbbbccccddddeeeeffffgggghhhh', profile: 'Profile 1', appId: 'aaaabbbbccccddddeeeeffffgggghhhh' }],
  hosts: ['Community.Example.com'],
  titles: ['Example Community'],
  keys: ['circle:community.example.com:space:example-course'],
  windowRead: true
}
const lessonUrl = (n) => `https://community.example.com/c/example-course/sections/1/lessons/${100 + n}`
const lessonKey = (n) => `circle:community.example.com:${100 + n}`

/** Seeds, through any build's storage API, a course with five lessons and a channel with one video. */
function seed(call) {
  const note = (title) => call('createNote', { origin: 'unknown', title, created_via: 'Windows' }).id
  const folder = call('createFolder', { title: 'Example course' })
  const course = call('upsertSeries', { kind: 'course', provider: 'circle', canonical_key: 'circle:community.example.com:course:example-course', title: 'Example course', folder_id: folder.id }).series
  call(
    'replaceCatalog',
    course.id,
    [1, 2, 3, 4, 5].map((n) => ({ number: n, section: n <= 3 ? 'Part one' : 'Part two', title: `Lesson ${n}`, url: lessonUrl(n), canonical_key: lessonKey(n), duration_ms: 600_000 }))
  )
  const notes = {}
  // Lesson n's note, with one span per [posStart, posEnd, wallStartHour].
  const lesson = (n, spans) => {
    const id = note(`Lesson ${n}`)
    call('createNoteSource', {
      note_id: id, kind: 'lesson', provider: 'circle', canonical_key: lessonKey(n), url: lessonUrl(n), title: `Lesson ${n}`,
      duration_ms: 600_000, series_id: course.id, lesson_number: n, lesson_state: 'numbered', lesson_origin: 'catalog', confidence: 'exact', detected_via: 'history'
    })
    if (spans.length) call('addSourceSpans', id, spans.map(([a, b, h]) => ({ wall_start: T0 + h * HOUR, wall_end: T0 + h * HOUR + (b - a), pos_start_ms: a, pos_end_ms: b, rate: 1 })))
    call('addNotesToFolder', folder.id, [id], 'manual')
    return id
  }
  notes.l1 = lesson(1, [[0, 570_000, 1]]) // 95 %, finished first
  notes.l2 = lesson(2, [[0, 300_000, 3]]) // 50 %, watched last
  notes.l3 = lesson(3, [[0, 300_000, 2], [290_000, 560_000, 2.5]]) // 93 % from two overlapping spans, finished most recently
  notes.l4 = lesson(4, [[0, 60_000, 2.7]]) // 10 %
  notes.l5 = lesson(5, [[0, 600_000, 0.5]]) // finished, then trashed
  notes.guessed = note('Probably lesson 6')
  call('createNoteSource', {
    note_id: notes.guessed, kind: 'lesson', provider: 'circle', canonical_key: 'title:community.example.com:probably lesson 6', title: 'Probably lesson 6',
    series_id: course.id, lesson_number: 6, lesson_label: 'Aula 6', lesson_state: 'guessed', confidence: 'guess', detected_via: 'media-session'
  })
  notes.pending = note('A lesson without a number')
  call('createNoteSource', {
    note_id: notes.pending, kind: 'lesson', provider: 'circle', canonical_key: 'title:community.example.com:a lesson without a number', title: 'A lesson without a number',
    series_id: course.id, confidence: 'guess', detected_via: 'media-session'
  })
  const channel = call('upsertSeries', { kind: 'channel', provider: 'youtube', canonical_key: 'youtube:channel:examplechannel', title: 'Example channel' }).series
  notes.video = note('A sample video')
  call('createNoteSource', {
    note_id: notes.video, kind: 'video', provider: 'youtube', canonical_key: 'youtube:abcdefghijk', url: 'https://www.youtube.com/watch?v=abcdefghijk', title: 'A sample video',
    channel: 'Example channel', duration_ms: 300_000, series_id: channel.id, confidence: 'exact', detected_via: 'media-session'
  })
  call('addSourceSpans', notes.video, [{ wall_start: T0 + 4 * HOUR, wall_end: T0 + 4 * HOUR + 300_000, pos_start_ms: 0, pos_end_ms: 300_000, rate: 1 }])
  return { course, channel, folder, notes }
}

// ---------- the run ----------

const scratch = join(OUT, 'data')
try {
  rmSync(OUT, { recursive: true, force: true })
  mkdirSync(scratch, { recursive: true })
  console.log(`Building the storage engines (${PREV_REV} and this tree)…`)
  const OLD = await bundle(sourceTree(PREV_REV, join(OUT, 'prev-src')), 'prev')
  const NEW = await bundle(ROOT, 'new')
  const keyHex = randomBytes(32).toString('hex')

  const freshDir = join(scratch, 'fresh')
  const fc = client(NEW.StorageEngine)
  const fs0 = fc.call('open', openParams(freshDir, keyHex))
  fc.call('close')
  check(`this tree creates a fresh database at schema ${TARGET}`, fs0.state === 'ready' && fs0.schemaVersion === TARGET, { state: fs0.state, detail: fs0.detail })
  const want = shape(freshDir, keyHex)

  // ---------- 18 → 19 ----------

  const dataDir = join(scratch, 'v18')
  const oc = client(OLD.StorageEngine)
  const os = oc.call('open', openParams(dataDir, keyHex))
  check(`${PREV_REV.slice(0, 12)} creates a schema-${PREV} database`, os.state === 'ready' && os.schemaVersion === PREV, { state: os.state, schemaVersion: os.schemaVersion })
  const seeded = seed(oc.call)
  oc.call('trashNote', seeded.notes.l5)
  oc.call('close')
  cpSync(dataDir, join(scratch, 'rollback'), { recursive: true })
  const before = snapshot(dataDir, keyHex)
  check(
    'the seeded file has series, notes, sources, spans and lesson lists',
    before.version === PREV && before.tables.source_series.length === 2 && before.tables.series_catalog_items.length === 5 && before.tables.note_sources.length === 8 && before.tables.source_spans.length === 7,
    { series: before.tables.source_series.length, catalog: before.tables.series_catalog_items.length, sources: before.tables.note_sources.length, spans: before.tables.source_spans.length }
  )
  check('the old series rows have none of the course columns', before.tables.source_series.every((r) => !('registered_at' in r) && !('match_json' in r)))

  const m = client(NEW.StorageEngine)
  const ms = m.call('open', openParams(dataDir, keyHex))
  m.call('close')
  check(`this tree migrates the schema-${PREV} database to ${TARGET}`, ms.state === 'ready' && ms.schemaVersion === TARGET, { state: ms.state, schemaVersion: ms.schemaVersion, detail: ms.detail })
  const after = snapshot(dataDir, keyHex)
  const withDefaults = (rows) => rows.map((r) => ({ ...r, ...COURSE_COLUMNS }))
  const diff = tableDiff(before.tables, after.tables, { source_series: withDefaults })
  check('every row is kept, and the series gain the course columns at their defaults', diff.length === 0, diff.length ? `differs in ${diff.join(', ')}` : `${Object.keys(after.tables).length} tables`)
  const seriesSql = shape(dataDir, keyHex).find((l) => l.startsWith('table source_series ')) ?? ''
  check(
    'the course columns are declared as migration 19 says, with no CHECK',
    /registered_at TEXT,/.test(seriesSql) && /on_play TEXT NOT NULL DEFAULT 'record',/.test(seriesSql) && /on_end TEXT NOT NULL DEFAULT 'notes',/.test(seriesSql) &&
      /match_json TEXT,/.test(seriesSql) && /catalog_origin TEXT(\)|,)/.test(seriesSql) && !/(registered_at|on_play|on_end|match_json|catalog_origin)[^,]*CHECK/.test(seriesSql),
    seriesSql.slice(seriesSql.indexOf('registered_at'))
  )
  const sd = want.filter((l) => !shape(dataDir, keyHex).includes(l))
  check('the upgraded file has the schema of a fresh database', sd.length === 0, sd.join(' | '))
  check(`a backup of the schema-${PREV} file was written first`, !!ms.backupPath && existsSync(ms.backupPath) && new RegExp(`notula-v${PREV}-`).test(ms.backupPath), ms.backupPath)
  if (ms.backupPath) {
    const bk = snapshot(ms.backupPath, keyHex)
    check(`the backup is schema ${PREV} with every row`, bk.version === PREV && tableDiff(before.tables, bk.tables).length === 0, tableDiff(before.tables, bk.tables))
  }

  // A failed migration leaves the old file usable.
  const rDir = join(scratch, 'rollback')
  const r = client(NEW.StorageEngine)
  const rs = r.call('open', openParams(rDir, keyHex, { devFailMigration: true }))
  r.call('close')
  check(`an injected failure after migration ${TARGET} rolls back to ${PREV}`, rs.state === 'migration-failed' && rs.schemaVersion === PREV, { state: rs.state, schemaVersion: rs.schemaVersion, detail: rs.detail })
  const rSnap = snapshot(rDir, keyHex)
  const rDiff = tableDiff(before.tables, rSnap.tables)
  check('after that rollback every row is unchanged and the series have no course column', rSnap.version === PREV && rDiff.length === 0 && rSnap.tables.source_series.every((x) => !('registered_at' in x)), rDiff)
  const ro = client(OLD.StorageEngine)
  const ros = ro.call('open', openParams(rDir, keyHex))
  const roNote = ros.state === 'ready' ? ro.call('createNote', { origin: 'unknown', title: 'Written after the rollback', created_via: 'Windows' }).id : null
  const roSeries = ros.state === 'ready' ? ro.call('listSeries').length : 0
  ro.call('close')
  check('the previous build still opens, reads and writes the rolled-back file', ros.state === 'ready' && ros.schemaVersion === PREV && !!roNote && roSeries === 2, { state: ros.state })
  const rr = client(NEW.StorageEngine)
  const rrs = rr.call('open', openParams(rDir, keyHex))
  rr.call('close')
  check('a later start of this tree upgrades it', rrs.state === 'ready' && rrs.schemaVersion === TARGET, { state: rrs.state, detail: rrs.detail })

  // ---------- register, update, unregister ----------

  const c = client(NEW.StorageEngine)
  c.call('open', openParams(dataDir, keyHex))
  const call = c.call
  const { course, channel, folder, notes } = seeded

  const plain = call('getSeries', course.id)
  check('an upgraded series is plain: not registered, default behavior, no match, no lesson-list origin', plain.registered_at === null && plain.on_play === 'record' && plain.on_end === 'notes' && plain.match === null && plain.catalog_origin === null, plain)
  check('a plain series has no course page', call('getCourseView', course.id) === null)
  check('Courses starts empty', call('listCourses').length === 0)

  const reg = call('registerCourse', course.id, BEHAVIOR, MATCH)
  check(
    'registerCourse sets registered_at, the behavior and the match (hosts lower-cased)',
    typeof reg.registered_at === 'string' && reg.on_play === 'ask' && reg.on_end === 'button' && reg.match.hosts.join() === 'community.example.com' &&
      reg.match.apps[0].profile === 'Profile 1' && reg.match.titles.join() === 'Example Community' && reg.match.windowRead === true,
    reg
  )
  const again = call('registerCourse', course.id, BEHAVIOR, MATCH)
  check('registering again keeps the first registered_at', again.registered_at === reg.registered_at)

  const up1 = call('updateCourse', course.id, { behavior: { onEnd: 'notes' } })
  check('updateCourse patches one behavior field and keeps the other, the match and registered_at', up1.on_play === 'ask' && up1.on_end === 'notes' && up1.match.keys.length === 1 && up1.registered_at === reg.registered_at, up1)
  const up2 = call('updateCourse', course.id, { match: { ...MATCH, titles: [], windowRead: false } })
  check('updateCourse replaces the match whole', up2.match.titles.length === 0 && up2.match.windowRead === false && up2.on_end === 'notes', up2.match)

  const catalogBefore = call('listCatalog', course.id).map((x) => x.id).join()
  const off = call('unregisterCourse', course.id)
  check(
    'unregisterCourse clears registered_at and keeps the folder, the behavior and the match',
    off.registered_at === null && off.folder_id === folder.id && off.on_play === 'ask' && off.on_end === 'notes' && off.match?.hosts.join() === 'community.example.com',
    off
  )
  check('… and the lesson list and the notes', call('listCatalog', course.id).map((x) => x.id).join() === catalogBefore && call('listNoteSources', { seriesId: course.id }).length === 6)
  check('an unregistered course leaves Courses and has no course page', call('listCourses').length === 0 && call('getCourseView', course.id) === null)
  const back = call('registerCourse', course.id, BEHAVIOR, MATCH)
  check('registering again restores the behavior given, with a new registered_at', back.on_play === 'ask' && back.on_end === 'button' && back.registered_at !== null && back.match.titles.length === 1, back)

  // ---------- the match on write and on read ----------

  const many = (n, f) => Array.from({ length: n }, (_, i) => f(i))
  const t21 = call('updateCourse', course.id, { match: { ...MATCH, titles: many(21, (i) => `Title ${i}`) } }).match.titles
  check('a 21st learned title trims the oldest instead of failing', t21.length === 20 && t21[0] === 'Title 1' && t21[19] === 'Title 20', t21)
  const relearned = call('updateCourse', course.id, { match: { ...MATCH, titles: [...t21, 'Title 1'] } }).match.titles
  check('… a title learned again counts as the newest', relearned.length === 20 && relearned[19] === 'Title 1' && relearned[0] === 'Title 2', relearned)
  check('20 learned titles are kept whole', call('updateCourse', course.id, { match: { ...MATCH, titles: many(20, (i) => `Title ${i}`) } }).match.titles.length === 20)
  const h51 = call('updateCourse', course.id, { match: { ...MATCH, hosts: many(51, (i) => `h${i}.example.com`) } }).match.hosts
  check('a 51st host trims the oldest instead of failing', h51.length === 50 && h51[0] === 'h1.example.com' && h51[49] === 'h50.example.com', h51.length)
  call('updateCourse', course.id, { match: { ...MATCH, titles: many(20, (i) => `Title ${i}`) } })
  check('a host must be a host name', throws(() => call('updateCourse', course.id, { match: { ...MATCH, hosts: ['https://community.example.com/c'] } }), /host names/))
  check('an app needs a known browser', throws(() => call('updateCourse', course.id, { match: { ...MATCH, apps: [{ ...MATCH.apps[0], browser: 'netscape' }] } }), /browser/))
  check('an app needs an app id', throws(() => call('updateCourse', course.id, { match: { ...MATCH, apps: [{ ...MATCH.apps[0], appUserModelId: '' }] } }), /appUserModelId/))
  check('windowRead must be a boolean', throws(() => call('registerCourse', course.id, BEHAVIOR, { ...MATCH, windowRead: 'yes' }), /windowRead/))
  check('an unknown behavior is refused', throws(() => call('updateCourse', course.id, { behavior: { onPlay: 'always' } }), /on_play/))
  check('a refused write changes nothing', call('getSeries', course.id).match.titles.length === 20 && call('getSeries', course.id).on_play === 'ask')
  call('updateCourse', course.id, { match: MATCH })

  call('close')
  const raw = openRaw(dataDir, keyHex)
  raw.prepare(`UPDATE source_series SET match_json = ? WHERE id = ?`).run('{"apps": [', channel.id)
  raw.close()
  const c2 = client(NEW.StorageEngine)
  c2.call('open', openParams(dataDir, keyHex))
  const damaged = c2.call('getSeries', channel.id)
  check('a damaged match reads as the empty match', JSON.stringify(damaged.match) === JSON.stringify({ apps: [], hosts: [], titles: [], keys: [], windowRead: false }), damaged.match)
  const badLog = c2.logs.find((l) => l.event === 'sources:bad-match')
  check('… and the counter is logged, with nothing else', !!badLog && typeof badLog.data?.count === 'number' && Object.keys(badLog.data).join() === 'count', badLog)
  const cc = c2.call

  // ---------- the lesson list's origin, the picker, remembered keys ----------

  check('setCatalogOrigin round trip', cc('setCatalogOrigin', course.id, 'vault').catalog_origin === 'vault' && cc('setCatalogOrigin', course.id, null).catalog_origin === null)
  check('an unknown lesson-list origin is refused', throws(() => cc('setCatalogOrigin', course.id, 'scraped'), /catalog origin/))
  cc('setCatalogOrigin', course.id, 'import')

  const items = cc('listCatalog', course.id)
  const picked = cc('setLessonForNote', notes.guessed, items[4].id, 'manual')
  check('a manual pick numbers the note from the item', picked.lesson_number === 5 && picked.lesson_state === 'numbered' && picked.lesson_origin === 'manual' && picked.series_id === course.id, picked)
  const overwritten = cc('setLessonForNote', notes.guessed, items[3].id, 'catalog')
  check('a non-manual write never overwrites a manual number', overwritten.lesson_number === 5 && overwritten.lesson_origin === 'manual', overwritten)
  const bulk = cc('applyLessonNumbers', [{ noteId: notes.guessed, lesson_number: 9, lesson_label: null, lesson_state: 'numbered', lesson_origin: 'playlist' }], { onlyUnsettled: false })
  check('nor does a bulk numbering', bulk === 0 && cc('getNoteSource', notes.guessed).lesson_number === 5)
  const repicked = cc('setLessonForNote', notes.guessed, items[3].id, 'manual')
  check('a second manual pick replaces the first', repicked.lesson_number === 4 && repicked.lesson_origin === 'manual')
  const cleared = cc('setLessonForNote', notes.guessed, null, 'manual')
  check('Not a lesson clears the series and the lesson', cleared.series_id === null && cleared.lesson_number === null && cleared.lesson_state === 'pending' && cleared.lesson_origin === 'manual', cleared)
  check('picking for a note without a source is not-found', throws(() => cc('setLessonForNote', notes.video + 'x', items[0].id, 'manual'), /not-found/))

  const bare = cc('replaceCatalog', channel.id, [{ number: 1, section: null, title: 'Bare item', url: null, canonical_key: null, duration_ms: null }])[0]
  const remembered = cc('rememberLessonKey', bare.id, 'youtube:abcdefghijk', 'https://www.youtube.com/watch?v=abcdefghijk')
  check('rememberLessonKey fills an empty key and URL', remembered.canonical_key === 'youtube:abcdefghijk' && remembered.url === 'https://www.youtube.com/watch?v=abcdefghijk', remembered)
  const kept = cc('rememberLessonKey', bare.id, 'youtube:zzzzzzzzzzz', 'https://www.youtube.com/watch?v=zzzzzzzzzzz')
  check('… and never replaces a filled one', kept.canonical_key === 'youtube:abcdefghijk' && kept.url === 'https://www.youtube.com/watch?v=abcdefghijk', kept)
  check('rememberLessonKey of an unknown item is null', cc('rememberLessonKey', 'no-such-item', 'youtube:abcdefghijk', null) === null)
  cc('deleteCatalog', channel.id)

  // ---------- the course view ----------

  // Put the guessed note back for Needs a lesson.
  cc('updateNoteSource', notes.guessed, { series_id: course.id, lesson_number: 6, lesson_label: 'Aula 6', lesson_state: 'guessed', lesson_origin: null })
  const view = cc('getCourseView', course.id)
  const ls = view?.detail.lessons ?? []
  const row = (n) => ls.find((l) => l.number === n && l.catalogItemId !== null)
  check(
    'watched % per lesson (span coverage over duration), finished at 90 % or more',
    [1, 2, 3, 4, 5].map((n) => `${row(n)?.watchedPercent ?? '-'}:${row(n)?.finished}`).join() === '95:true,50:false,93:true,10:false,-:false',
    ls.map((l) => [l.number, l.watchedPercent, l.finished])
  )
  check('lessonsTotal counts the lesson list; lessonsWithNotes skips the trashed note', view?.detail.lessonsTotal === 5 && view.detail.lessonsWithNotes === 4, { total: view?.detail.lessonsTotal, withNotes: view?.detail.lessonsWithNotes })
  check(
    'the next lesson is the first after the most recently finished one without a finished note',
    view?.detail.nextLesson?.number === 4 && view.detail.nextLesson.catalogItemId === items[3].id && view.detail.nextLesson.url === lessonUrl(4) && view.detail.nextLesson.title === 'Lesson 4',
    view?.detail.nextLesson
  )
  check(
    'Needs a lesson lists the pending and guessed notes',
    (view?.needsLesson ?? []).map((x) => `${x.noteId === notes.guessed ? 'g' : x.noteId === notes.pending ? 'p' : '?'}:${x.state}:${x.label}`).sort().join() === 'g:guessed:Aula 6,p:pending:null',
    view?.needsLesson
  )
  check('playsIn is left for main', view?.playsIn === null)

  // Lesson 4 finished most recently: nothing after 5 is unfinished but 5 itself (its note is in Trash).
  cc('addSourceSpans', notes.l4, [{ wall_start: T0 + 5 * HOUR, wall_end: T0 + 5 * HOUR + 600_000, pos_start_ms: 0, pos_end_ms: 600_000, rate: 1 }])
  check('after lesson 4 is finished, the next lesson is 5', cc('getCourseView', course.id)?.detail.nextLesson?.number === 5)
  cc('restoreNote', notes.l5)
  cc('addSourceSpans', notes.l5, [{ wall_start: T0 + 6 * HOUR, wall_end: T0 + 6 * HOUR + 600_000, pos_start_ms: 0, pos_end_ms: 600_000, rate: 1 }])
  check('with the last lesson finished most recently there is no next lesson', cc('getCourseView', course.id)?.detail.nextLesson === null)

  // A second course with nothing finished: the first lesson without a note.
  const fresh = cc('upsertSeries', { kind: 'course', provider: 'circle', canonical_key: 'circle:courses.example.org:course:second', title: 'Second course' }).series
  cc('replaceCatalog', fresh.id, [1, 2, 3].map((n) => ({ number: n, section: null, title: `Part ${n}`, url: `https://courses.example.org/c/second/lessons/${n}`, canonical_key: `circle:courses.example.org:${n}`, duration_ms: 600_000 })))
  const started = cc('createNote', { origin: 'unknown', title: 'Part 1', created_via: 'Windows' }).id
  cc('createNoteSource', {
    note_id: started, kind: 'lesson', provider: 'circle', canonical_key: 'circle:courses.example.org:1', url: 'https://courses.example.org/c/second/lessons/1', title: 'Part 1',
    duration_ms: 600_000, series_id: fresh.id, lesson_number: 1, lesson_state: 'numbered', confidence: 'exact', detected_via: 'history'
  })
  cc('addSourceSpans', started, [{ wall_start: T0 + 7 * HOUR, wall_end: T0 + 7 * HOUR + 60_000, pos_start_ms: 0, pos_end_ms: 60_000, rate: 1 }])
  cc('registerCourse', fresh.id, { onPlay: 'record', onEnd: 'notes' }, { apps: [], hosts: ['courses.example.org'], titles: [], keys: [], windowRead: false })
  const fv = cc('getCourseView', fresh.id)
  check('with nothing finished, the next lesson is the first without a note', fv?.detail.nextLesson?.number === 2 && fv.needsLesson.length === 0, fv?.detail.nextLesson)

  // Courses: registered series only, last watched first; the list rows carry the progress fields.
  const courses = cc('listCourses')
  check('listCourses: registered series only, ordered by last watched', courses.map((x) => x.id).join() === `${fresh.id},${course.id}`, courses.map((x) => [x.title, x.lastWatchedAt]))
  const listed = courses.find((x) => x.id === course.id)
  check('a list row carries lessonsTotal, lessonsWithNotes and the next lesson', listed?.lessonsTotal === 5 && listed.lessonsWithNotes === 5 && listed.nextLesson === null && courses[0].nextLesson?.number === 2, listed)
  const plainRow = cc('listSeries').find((x) => x.id === channel.id)
  check('a series without a lesson list has no progress', plainRow?.lessonsTotal === 0 && plainRow.lessonsWithNotes === 0 && plainRow.nextLesson === null)
  // ---------- R1 fixes ----------

  // Set-based views: the number of statements a list prepares doesn't grow with the series.
  const proto = Database.prototype
  const prepare = proto.prepare
  let prepares = 0
  proto.prepare = function (...a) {
    prepares++
    return prepare.apply(this, a)
  }
  const counted = (fn) => {
    prepares = 0
    fn()
    return prepares
  }
  const listCost = counted(() => cc('listCourses'))
  const seriesCost = counted(() => cc('listSeries'))
  check('getCourseView reads the series, its lesson list, notes, spans and duplicates once each', counted(() => cc('getCourseView', course.id)) <= 5, prepares)
  for (let k = 0; k < 3; k++) {
    const extra = cc('upsertSeries', { kind: 'course', provider: 'circle', canonical_key: `circle:courses.example.org:course:extra-${k}`, title: `Extra ${k}` }).series
    cc('replaceCatalog', extra.id, [1, 2].map((n) => ({ number: n, section: null, title: `Extra part ${n}`, url: null, canonical_key: `circle:courses.example.org:extra-${k}-${n}`, duration_ms: 600_000 })))
    const en = cc('createNote', { origin: 'unknown', title: `Extra ${k}`, created_via: 'Windows' }).id
    cc('createNoteSource', {
      note_id: en, kind: 'lesson', provider: 'circle', canonical_key: `circle:courses.example.org:extra-${k}-1`, title: `Extra ${k}`, duration_ms: 600_000,
      series_id: extra.id, lesson_number: 1, lesson_state: 'numbered', confidence: 'exact', detected_via: 'history'
    })
    cc('addSourceSpans', en, [{ wall_start: T0 + 8 * HOUR, wall_end: T0 + 8 * HOUR + 600_000, pos_start_ms: 0, pos_end_ms: 600_000, rate: 1 }])
    cc('registerCourse', extra.id, { onPlay: 'record', onEnd: 'notes' }, { apps: [], hosts: [], titles: [], keys: [], windowRead: false })
  }
  check('listCourses prepares as many statements for 5 courses as for 2', listCost > 0 && counted(() => cc('listCourses')) === listCost, { before: listCost, after: prepares })
  check('listSeries prepares as many statements for 6 series as for 3', counted(() => cc('listSeries')) === seriesCost, { before: seriesCost, after: prepares })
  check('the API series list and series get too', counted(() => cc('apiListSeries')) === seriesCost && counted(() => cc('apiGetSeries', course.id)) <= 7, prepares)
  proto.prepare = prepare
  const consistent = cc('listCourses').every((x) => {
    const d = cc('getSeriesDetail', x.id)
    return d.lessonsTotal === x.lessonsTotal && d.lessonsWithNotes === x.lessonsWithNotes && JSON.stringify(d.nextLesson) === JSON.stringify(x.nextLesson)
  })
  check('every list row has the progress of its own lessons view', consistent)

  // The API's course fields: sites and apps only for a registered series; apps leave storage as ids.
  cc('registerCourse', channel.id, BEHAVIOR, MATCH)
  cc('unregisterCourse', channel.id)
  const apiRows = cc('apiListSeries')
  const apiChannel = apiRows.find((x) => x.id === channel.id)
  const apiCourse = apiRows.find((x) => x.id === course.id)
  check('an unregistered series has no sites, apps or behavior', apiChannel?.registered === false && apiChannel.sites.length === 0 && apiChannel.apps.length === 0 && apiChannel.on_play === null, apiChannel)
  check('a course has its sites, and its app ids for main to name', apiCourse?.sites.join() === 'community.example.com' && apiCourse.apps.join() === MATCH.apps[0].appUserModelId, apiCourse)
  const apiOne = cc('apiGetSeries', course.id)
  check('series.get has the list fields and the lessons with finished', apiOne?.lessons_total === 5 && apiOne.lessons.length >= 5 && apiOne.lessons.every((l) => typeof l.finished === 'boolean'), apiOne?.lessons_total)

  // A pick of an item without a number stays counted (the key binds them).
  const freshItems = cc('replaceCatalog', fresh.id, [
    ...[1, 2, 3].map((n) => ({ number: n, section: null, title: `Part ${n}`, url: `https://courses.example.org/c/second/lessons/${n}`, canonical_key: `circle:courses.example.org:${n}`, duration_ms: 600_000 })),
    { number: null, section: 'Extras', title: 'Bonus with a key', url: 'https://courses.example.org/c/second/lessons/bonus', canonical_key: 'circle:courses.example.org:bonus', duration_ms: 600_000 },
    { number: null, section: 'Extras', title: 'Bonus without a key', url: null, canonical_key: null, duration_ms: 600_000 }
  ])
  const pendingNote = (title) => {
    const nid = cc('createNote', { origin: 'unknown', title, created_via: 'Windows' }).id
    cc('createNoteSource', { note_id: nid, kind: 'lesson', provider: 'circle', canonical_key: `title:courses.example.org:${title.toLowerCase()}`, title, series_id: fresh.id, confidence: 'guess', detected_via: 'media-session' })
    return nid
  }
  const withKey = pendingNote('Bonus one')
  const withoutKey = pendingNote('Bonus two')
  const beforePick = cc('getCourseView', fresh.id)
  const pk1 = cc('setLessonForNote', withKey, freshItems[3].id, 'manual')
  const pk2 = cc('setLessonForNote', withoutKey, freshItems[4].id, 'manual')
  const afterPick = cc('getCourseView', fresh.id)
  const rowOf = (itemId) => afterPick?.detail.lessons.find((l) => l.catalogItemId === itemId)
  check(
    'a picked numberless item takes its note (the note adopts the item key)',
    rowOf(freshItems[3].id)?.noteId === withKey && pk1.canonical_key === 'circle:courses.example.org:bonus' && pk1.lesson_number === null && pk1.lesson_state === 'numbered',
    pk1
  )
  check('a picked numberless item without a key takes the note key', rowOf(freshItems[4].id)?.noteId === withoutKey && cc('listCatalog', fresh.id)[4].canonical_key === pk2.canonical_key)
  check(
    '… both count in lessonsWithNotes, leave Needs a lesson and are not left over',
    afterPick.detail.lessonsWithNotes === beforePick.detail.lessonsWithNotes + 2 &&
      afterPick.needsLesson.length === 0 &&
      !afterPick.detail.lessons.some((l) => l.catalogItemId === null && (l.noteId === withKey || l.noteId === withoutKey)),
    { before: beforePick.detail.lessonsWithNotes, after: afterPick.detail.lessonsWithNotes, needs: afterPick.needsLesson.length }
  )

  // Finished is >= 90 % of the raw share; a note without a duration measures against its item's.
  const almost = cc('createNote', { origin: 'unknown', title: 'Part 3', created_via: 'Windows' }).id
  cc('createNoteSource', {
    note_id: almost, kind: 'lesson', provider: 'circle', canonical_key: 'circle:courses.example.org:3', title: 'Part 3', series_id: fresh.id, lesson_number: 3,
    lesson_state: 'numbered', lesson_origin: 'catalog', confidence: 'exact', detected_via: 'media-session'
  })
  cc('addSourceSpans', almost, [{ wall_start: T0 + 9 * HOUR, wall_end: T0 + 9 * HOUR + 537_000, pos_start_ms: 0, pos_end_ms: 537_000, rate: 1 }])
  const part3 = cc('getCourseView', fresh.id).detail.lessons.find((l) => l.catalogItemId === freshItems[2].id)
  check('89.5 % shows as 90 % but is not finished', part3?.noteId === almost && part3.watchedPercent === 90 && part3.finished === false, part3)

  // A manual lesson survives updateNoteSource and a replaced source of another origin.
  const manualNote = cc('createNote', { origin: 'unknown', title: 'Manual', created_via: 'Windows' }).id
  const manualSrc = { note_id: manualNote, kind: 'lesson', provider: 'circle', canonical_key: 'circle:courses.example.org:manual', title: 'Manual', series_id: fresh.id, confidence: 'exact', detected_via: 'manual' }
  cc('createNoteSource', { ...manualSrc, lesson_number: 2, lesson_state: 'numbered', lesson_origin: 'manual' })
  const up = cc('updateNoteSource', manualNote, { title: 'Manual renamed', lesson_number: 7, lesson_state: 'numbered', lesson_origin: 'playlist' })
  check('updateNoteSource keeps a manual number against another origin, and applies the rest', up.lesson_number === 2 && up.lesson_origin === 'manual' && up.title === 'Manual renamed', up)
  const rep = cc('createNoteSource', { ...manualSrc, title: 'Replaced', lesson_number: 3, lesson_state: 'numbered', lesson_origin: 'catalog' }, { replace: true })
  check('a replaced source of another origin keeps the manual lesson', rep.lesson_number === 2 && rep.lesson_origin === 'manual' && rep.title === 'Replaced', rep)
  const rep2 = cc('createNoteSource', { ...manualSrc, title: 'Replaced again' }, { replace: true })
  check('… and so does a replacement with no lesson', rep2.lesson_number === 2 && rep2.lesson_origin === 'manual', rep2)
  const typed = cc('updateNoteSource', manualNote, { lesson_number: 4, lesson_state: 'numbered', lesson_origin: 'manual' })
  check('a manual write still changes it', typed.lesson_number === 4)
  const userCleared = cc('updateNoteSource', manualNote, { lesson_number: null, lesson_state: 'pending', lesson_origin: null })
  check('the user clearing the number goes through', userCleared.lesson_number === null && userCleared.lesson_origin === null, userCleared)
  cc('updateNoteSource', manualNote, { lesson_number: 4, lesson_state: 'numbered', lesson_origin: 'manual' })
  const moved = cc('updateNoteSource', manualNote, { series_id: course.id, lesson_number: null, lesson_state: 'pending', lesson_origin: null })
  check('a move to another series takes its own lesson', moved.series_id === course.id && moved.lesson_number === null, moved)

  // discardSourceRun: the run's spans go and its session is hidden, in one transaction.
  const runNote = cc('createNote', { origin: 'unknown', title: 'Continued', created_via: 'Windows' }).id
  cc('createNoteSource', { note_id: runNote, kind: 'video', provider: 'youtube', canonical_key: 'youtube:lmnopqrstuv', title: 'Continued', confidence: 'exact', detected_via: 'media-session' })
  const runSpans = [0, 1, 2].map((h) => ({ wall_start: T0 + (10 + h) * HOUR, wall_end: T0 + (10 + h) * HOUR + 60_000, pos_start_ms: h * 60_000, pos_end_ms: (h + 1) * 60_000, rate: 1 }))
  cc('addSourceSpans', runNote, runSpans)
  const disc = cc('discardSourceRun', runNote, T0 + 11 * HOUR, 'session-run-1')
  const runSrc = cc('getNoteSource', runNote)
  check(
    'discardSourceRun deletes the spans from the run start and hides the session',
    disc.spans === 2 && disc.hidden === true && cc('listSourceSpans', runNote).length === 1 && runSrc.superseded_session_ids.join() === 'session-run-1',
    disc
  )
  const disc2 = cc('discardSourceRun', runNote, T0 + 11 * HOUR, 'session-run-1')
  check('… again, it changes nothing', disc2.spans === 0 && disc2.hidden === false && cc('getNoteSource', runNote).superseded_session_ids.length === 1)
  check('without a session it only deletes spans', cc('discardSourceRun', runNote, T0, null).spans === 1 && cc('getNoteSource', runNote).superseded_session_ids.length === 1)
  const bareNote = cc('createNote', { origin: 'unknown', title: 'No source', created_via: 'Windows' }).id
  cc('addSourceSpans', bareNote, runSpans)
  check('a session for a note without a source is refused, and no span goes', throws(() => cc('discardSourceRun', bareNote, T0, 'session-run-2'), /not-found/) === true && cc('listSourceSpans', bareNote).length === 3)

  // The data export's series block: every series with its course fields, notes or not.
  const lonely = cc('upsertSeries', { kind: 'course', provider: 'circle', canonical_key: 'circle:courses.example.org:course:lonely', title: 'No notes yet' }).series
  cc('replaceCatalog', lonely.id, [{ number: 1, section: null, title: 'Only lesson', url: null, canonical_key: null, duration_ms: null }])
  cc('registerCourse', lonely.id, BEHAVIOR, MATCH)
  const exportRoot = join(OUT, 'Notula export 2026-11-01 10.00')
  mkdirSync(exportRoot, { recursive: true })
  const ws = cc('writeExportSeries', { root: exportRoot })
  const file = JSON.parse(readFileSync(join(exportRoot, 'series.json'), 'utf8'))
  const lonelyBlock = file.series.find((x) => x.id === lonely.id)
  check(
    'series.json has one block per series, a course without notes with its course fields and lesson list',
    ws.series === file.series.length &&
      new Set(file.series.map((x) => x.id)).size === file.series.length &&
      !!lonelyBlock?.registered_at &&
      lonelyBlock.on_play === 'ask' &&
      lonelyBlock.match?.hosts.join() === 'community.example.com' &&
      lonelyBlock.lessons.length === 1 &&
      lonelyBlock.catalog_origin === null,
    lonelyBlock
  )
  check('… and a plain series too, with its course fields empty', file.series.find((x) => x.id === channel.id)?.registered_at === null)
  check('a second series block in the same export is refused (never overwrites)', throws(() => cc('writeExportSeries', { root: exportRoot }), /EEXIST|exists/) === true)
  const wn = cc('writeExportNotes', { root: exportRoot, notes: [{ id: notes.l1, baseName: 'lesson-one', trashed: false, hasTranscript: false }], markdown: true, transcripts: false })
  check('the notes of an export still carry their series fields', wn.written.length === 1 && wn.errors.length === 0 && /series/.test(readFileSync(join(exportRoot, wn.written[0].notesFile), 'utf8')), wn.errors)

  check('logs carry no titles, URLs or hosts', !JSON.stringify([...c.logs, ...c2.logs]).match(/example\.(com|org)|Lesson \d|Example course/), c2.logs.map((l) => l.event))
  cc('close')
} catch (err) {
  check('the run finished', false, err.stack ?? String(err))
} finally {
  for (const e of engines) {
    try {
      e.handle({ id: 0, method: 'close', params: [] })
    } catch {
      // already closed
    }
  }
  if (KEEP) console.log(`kept ${OUT}`)
  else rmSync(OUT, { recursive: true, force: true })
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed')
process.exit(failures ? 1 : 0)
