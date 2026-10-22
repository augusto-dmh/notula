// SPDX-License-Identifier: Apache-2.0
// Dev check for content sources' surfaces (backfill, the Local API, the CLI, the export), on synthetic data only. It never opens the
// real data folder, never starts the app and makes no network call.
//
//   node scripts/dev/cli-source-check.mjs [--keep]
//
// 1. Builds this tree's storage engine and the real main modules behind them (local-api/index.ts,
//    sources/backfill.ts, data-export/index.ts) with vite into the OS temp folder, with
//    `electron` replaced by a stub (no window, no network: lookups stay off).
// 2. Opens a fresh database (schema 9) in a scratch folder and seeds, through the storage API:
//    a YouTube video note in a channel series with spans, a stamped projection and a
//    system-audio transcript whose chunks carry video positions; a course with a catalog and two
//    lesson notes (one pending, one with a video-captions transcript); a plain meeting note; and
//    three older notes without a source (a YouTube URL in the text, two hand-typed titles).
// 3. Starts the real Local API listener with the companion CLI on, and runs the real CLI
//    (`notula-cli.cjs`) against it: `notes list` with every new filter, `notes get`
//    (`notes_md_stamped`), `notes transcript get` (`position_ms`), `series list`, `series get`,
//    and the usage errors. This is the `/study` ingest round trip.
// 4. Runs Find sources (preview, apply, undo) through its IPC handlers.
// 5. Runs Export notes as Markdown and the standard export into a scratch folder: the folder
//    tree, front-matter (source properties, export format 2 section markers), the stamped body,
//    the `[mm:ss]` transcripts, and never-overwrite.
//
// Exits 1 on any failure. `--keep` keeps the scratch folder.

import { randomBytes, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { builtinModules, createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const require = createRequire(join(ROOT, 'package.json'))
const KEEP = process.argv.includes('--keep')
const OUT = join(tmpdir(), 'notula-cli-source-check')
const CLI = join(ROOT, 'src/main/companion-cli/cli/notula-cli.cjs')

let failures = 0
function check(name, ok, detail) {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : `  ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 400)}`}`)
}

// ---------- the build ----------

/** The parts of Electron the bundled modules touch: inert, recorded where a check needs it. */
const ELECTRON_STUB = `
export const handlers = new Map()
const userData = process.env.NOTULA_CHECK_USERDATA
export const app = {
  isPackaged: false,
  whenReady: () => Promise.resolve(),
  on() {},
  once() {},
  getPath: () => userData,
  getAppPath: () => '',
  getVersion: () => '0.0.0-check'
}
export const ipcMain = { handle: (ch, fn) => handlers.set(ch, fn), on() {}, removeHandler: (ch) => handlers.delete(ch) }
export const shell = { openPath: async () => '', openExternal: async () => undefined }
export const dialog = { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) }
export const BrowserWindow = { getFocusedWindow: () => null, getAllWindows: () => [] }
export const utilityProcess = { fork() { throw new Error('no utility processes in the check') } }
export const net = { fetch() { throw new Error('no network in the check') } }
export const session = { defaultSession: null }
export const safeStorage = { isEncryptionAvailable: () => false }
export const nativeTheme = { shouldUseDarkColors: false, on() {} }
export const screen = { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1, height: 1 } }) }
export const Menu = { buildFromTemplate: () => ({}), setApplicationMenu() {} }
export const Notification = class {}
export const powerMonitor = { on() {} }
export const webContents = { getAllWebContents: () => [] }
export const clipboard = { writeText() {} }
export default { app, ipcMain, shell, dialog, BrowserWindow, utilityProcess, net, session, safeStorage, nativeTheme, screen, Menu, Notification, powerMonitor, webContents, clipboard }
`

async function bundle(entries) {
  const { build } = await import(pathToFileURL(require.resolve('vite')).href)
  mkdirSync(OUT, { recursive: true })
  const stub = join(OUT, 'electron-stub.mjs')
  writeFileSync(stub, ELECTRON_STUB)
  const isBare = (id) => !id.startsWith('.') && !id.startsWith('/') && !id.startsWith('@shared') && !/^[A-Za-z]:[\\/]/.test(id) && !id.startsWith('\0')
  const external = {
    name: 'external-by-url',
    enforce: 'pre',
    resolveId(id) {
      if (id === 'electron') return { id: pathToFileURL(stub).href, external: true }
      if (!isBare(id)) return null
      if (id.startsWith('node:') || builtinModules.includes(id)) return { id, external: true }
      return { id: pathToFileURL(require.resolve(id)).href, external: true }
    }
  }
  // `?raw` imports (the CLI files the companion module writes) as plain strings.
  const raw = {
    name: 'raw-text',
    enforce: 'pre',
    load(id) {
      if (!id.endsWith('?raw')) return null
      return `export default ${JSON.stringify(readFileSync(id.slice(0, -4), 'utf8'))}`
    }
  }
  await build({
    configFile: false,
    logLevel: 'error',
    root: ROOT,
    resolve: { alias: { '@shared': join(ROOT, 'src/shared') } },
    plugins: [external, raw],
    build: {
      ssr: true,
      outDir: join(OUT, 'build'),
      emptyOutDir: true,
      minify: false,
      rolldownOptions: {
        input: Object.fromEntries(Object.entries(entries).map(([name, path]) => [name, join(ROOT, path)])),
        output: { format: 'es', entryFileNames: '[name].mjs' }
      }
    }
  })
  const out = {}
  for (const name of Object.keys(entries)) out[name] = await import(pathToFileURL(join(OUT, 'build', `${name}.mjs`)).href)
  out.electron = await import(pathToFileURL(stub).href)
  return out
}

// ---------- the context ----------

const scratch = mkdtempSync(join(tmpdir(), 'notula-s7-'))
const userData = join(scratch, 'userData')
mkdirSync(userData, { recursive: true })
process.env.NOTULA_CHECK_USERDATA = userData

const mods = await bundle({
  engine: 'src/main/storage/engine.ts',
  localApi: 'src/main/local-api/index.ts',
  backfill: 'src/main/sources/backfill.ts',
  dataExport: 'src/main/data-export/index.ts',
  exportRepo: 'src/main/storage/export-repo.ts'
})

const engine = new mods.engine.StorageEngine(() => undefined)
let rid = 0
function call(method, ...params) {
  const r = engine.handle({ id: ++rid, method, params })
  if (!r.ok) throw new Error(`${method}: ${r.error.code}: ${r.error.message}`)
  return r.result
}
const opened = call('open', {
  dataDir: join(userData, 'data'),
  keyHex: randomBytes(32).toString('hex'),
  appVersion: '0.0.0-check',
  devFailMigration: false,
  devVersionAhead: false,
  housekeeping: false
})
check('a fresh database opens at schema 9', opened.state === 'ready' && opened.schemaVersion === 9, { state: opened.state, version: opened.schemaVersion })

const settings = {
  'localApi.enabled': false,
  'companionCli.enabled': true,
  'companionCli.allowTranscripts': true,
  'companionCli.allowFolderWrites': false,
  'privacy.localOnly': false,
  'profile.name': 'Check User',
  'profile.email': 'check@example.com',
  'sources.enabled': true,
  'sources.onlineLookups': false,
  'sources.courseHosts': [],
  'sources.ytDlp': 'managed'
}
const storage = new Proxy(
  {},
  {
    get: (_t, method) => {
      if (method === 'then') return undefined
      if (method === 'status') return async () => ({ state: 'ready' })
      if (method === 'onChange') return () => () => undefined
      return async (...params) => call(method, ...params)
    }
  }
)
const ctx = {
  storage,
  userDataPath: userData,
  isDev: true,
  settings: { get: async (k) => settings[k], getAll: async () => ({ ...settings }), set: async (k, v) => void (settings[k] = v) },
  bus: { on() {}, emit() {} },
  windows: { targets: () => [], main: () => null, kindOf: () => 'main' }
}

// ---------- the synthetic data set ----------

const T0 = Date.parse('2026-10-05T09:00:00.000Z')
const iso = (ms) => new Date(ms).toISOString()
const mk = (title, extra = {}) => call('createNote', { origin: 'unknown', title, created_via: 'Windows', ...extra }).id
const identity = call('identity')

// A YouTube video in a channel series: spans, stamps, a system-audio transcript mapped to the video.
const video = mk('Creating a loosely coupled monolith')
const channel = call('upsertSeries', { kind: 'channel', provider: 'youtube', canonical_key: 'youtube:channel:codeopinion', title: 'CodeOpinion' }).series
call('createNoteSource', {
  note_id: video, kind: 'video', provider: 'youtube', canonical_key: 'youtube:abcdefghijk', url: 'https://www.youtube.com/watch?v=abcdefghijk',
  title: 'Creating a loosely coupled monolith', channel: 'CodeOpinion', duration_ms: 600_000, series_id: channel.id, confidence: 'exact', detected_via: 'media-session'
})
call('updateNote', video, { notes_md: '# Key ideas\n\nModules own their data.', notes_text: 'Key ideas Modules own their data.' })
call('updateNoteSource', video, { notes_md_stamped: '# Key ideas\n\n[01:05](https://www.youtube.com/watch?v=abcdefghijk&t=65s) Modules own their data.' })
call('addSourceSpans', video, [{ wall_start: T0, wall_end: T0 + 300_000, pos_start_ms: 0, pos_end_ms: 300_000, rate: 1 }])
const audioSession = randomUUID()
call('createSession', { id: audioSession, document_id: video, provider: 'local', model: 'check', language: 'en', started_at: iso(T0) })
const chunk = (noteId, session, i, text, pos, startMs) => ({
  id: randomUUID(), document_id: noteId, workspace_id: identity.workspaceId, owner_id: identity.ownerId, transcription_session_id: session,
  source: 'system', start_timestamp: iso(startMs + i * 5_000), end_timestamp: iso(startMs + i * 5_000 + 4_000), text, is_final: true,
  detected_speaker_name: null, detectedSpeaker: null, ...(pos === null ? {} : { providerDetails: { words: [], provider: 'local', model: 'check', wallClockAnchorMs: startMs, sourcePositionMs: pos } })
})
call('upsertChunks', [chunk(video, audioSession, 0, 'Welcome back to the channel.', 60_000, T0), chunk(video, audioSession, 1, 'Today, coupling.', 65_000, T0)])

// A course with a catalog; lesson 2 has a note with a video-captions transcript, one lesson note is pending.
const course = call('upsertSeries', { kind: 'course', provider: 'circle', canonical_key: 'circle:courses.example.com:course:fundamentos', title: 'Fundamentos' }).series
call('replaceCatalog', course.id, [
  { number: 1, section: 'Intro', title: 'Welcome', url: 'https://courses.example.com/c/fundamentos/sections/1/lessons/11', canonical_key: 'circle:courses.example.com:11', duration_ms: 300_000 },
  { number: 2, section: 'Intro', title: 'Modules', url: 'https://courses.example.com/c/fundamentos/sections/1/lessons/12', canonical_key: 'circle:courses.example.com:12', duration_ms: 400_000 }
])
const lesson2 = mk('Modules')
call('createNoteSource', {
  note_id: lesson2, kind: 'lesson', provider: 'circle', canonical_key: 'circle:courses.example.com:12', url: 'https://courses.example.com/c/fundamentos/sections/1/lessons/12',
  title: 'Modules', channel: null, duration_ms: 400_000, series_id: course.id, lesson_number: 2, lesson_state: 'numbered', lesson_origin: 'catalog', confidence: 'exact', detected_via: 'history'
})
const captions = randomUUID()
call('createSession', { id: captions, document_id: lesson2, provider: 'captions', model: 'vtt', language: 'pt', started_at: iso(T0) })
call('upsertChunks', [chunk(lesson2, captions, 0, 'Bem-vindos.', null, T0 + 12_000)])
const pending = mk('Lesson without a number')
call('createNoteSource', {
  note_id: pending, kind: 'lesson', provider: 'circle', canonical_key: 'title:courses.example.com:lesson without a number', url: null,
  title: 'Lesson without a number', series_id: course.id, confidence: 'guess', detected_via: 'media-session'
})
const unfiled = mk('A video in no series')
call('createNoteSource', { note_id: unfiled, kind: 'video', provider: 'web', canonical_key: 'url:https://example.com/v', url: 'https://example.com/v', title: 'A video in no series', confidence: 'exact', detected_via: 'manual' })
const meeting = mk('Weekly sync')
const meetingSession = randomUUID()
call('createSession', { id: meetingSession, document_id: meeting, provider: 'local', model: 'check', language: 'en', started_at: iso(T0) })
call('upsertChunks', [chunk(meeting, meetingSession, 0, 'Let us start with the budget.', null, T0)])
// Older notes without a source, for Find sources.
const withUrl = mk('Notes on a talk')
call('updateNote', withUrl, { notes_md: 'Watched https://youtu.be/zyxwvutsrqp?t=30 today. Also [Sampleapp](https://notes.sampleapp.test/d/abc).', notes_text: 'Watched today.' })
const tagged = mk('[Vídeo] Event sourcing basics - Youtube - CodeOpinion')
const courseTitle = mk('[Curso] Fundamentos - Aula 33 - Arquitetura evolutiva')
// Folders for the Markdown export tree.
const courses = call('createFolder', { title: 'Courses' })
const sub = call('createFolder', { title: 'Fundamentos', parentId: courses.id })
call('addNotesToFolder', sub.id, [lesson2, pending], 'manual')

// ---------- 3. the Local API and the CLI ----------

mods.localApi.registerLocalApi(ctx)
const companionFile = join(userData, 'local-api', 'companion.json')
for (let i = 0; i < 100 && !existsSync(companionFile); i++) await new Promise((r) => setTimeout(r, 50))
check('the listener writes companion.json with the companion CLI on', existsSync(companionFile))

function cli(...args) {
  return new Promise((done) => {
    execFile(process.execPath, [CLI, ...args], { env: { ...process.env, NOTULA_COMPANION_FILE: companionFile, NOTULA_EXE: '' }, timeout: 20_000 }, (err, stdout, stderr) => {
      let json = null
      try {
        json = JSON.parse(stdout || stderr)
      } catch {
        json = null
      }
      done({ code: err ? (err.code ?? 1) : 0, json, stderr })
    })
  })
}
const ids = (r) => (r.json?.notes ?? []).map((n) => n.id).sort().join()
const sorted = (...xs) => [...xs].sort().join()

const all = await cli('notes', 'list', '--limit', '100')
check('notes list carries a source block (or null) on every note', all.code === 0 && all.json.notes.every((n) => 'source' in n), all.json?.notes?.length)
const vItem = all.json?.notes.find((n) => n.id === video)
check(
  'a source note item: kind, url, channel, series, watched',
  vItem?.source?.kind === 'video' && vItem.source.url === 'https://www.youtube.com/watch?v=abcdefghijk' && vItem.source.channel === 'CodeOpinion' &&
    vItem.source.series?.title === 'CodeOpinion' && vItem.source.watched.percent === 50 && vItem.source.watched.spans.length === 1,
  vItem?.source
)
check('a plain note has source null', all.json?.notes.find((n) => n.id === meeting)?.source === null)
check('--has-source lists only source notes', ids(await cli('notes', 'list', '--has-source')) === sorted(video, lesson2, pending, unfiled))
check('--has-source=false lists only notes without one', ids(await cli('notes', 'list', '--has-source=false')) === sorted(meeting, withUrl, tagged, courseTitle))
check('--has-series=false is the unfiled inbox', ids(await cli('notes', 'list', '--has-series', 'false')) === unfiled)
check('--source-kind lesson', ids(await cli('notes', 'list', '--source-kind', 'lesson')) === sorted(lesson2, pending))
check('--series-id', ids(await cli('notes', 'list', '--series-id', course.id)) === sorted(lesson2, pending))
const badKind = await cli('notes', 'list', '--source-kind', 'podcast')
check('an unknown --source-kind is a usage error', badKind.code === 2 && badKind.json?.code === 'USAGE', badKind.json)
const badBool = await cli('notes', 'list', '--has-source=maybe')
check('a bad boolean is a usage error', badBool.code === 2, badBool.json)

const got = await cli('notes', 'get', '--id', video, '--id', meeting)
const gv = got.json?.notes.find((n) => n.id === video)
check('notes get: notes_md unchanged, notes_md_stamped separate', gv?.notes_md === '# Key ideas\n\nModules own their data.' && /^# Key ideas\n\n\[01:05\]\(/.test(gv?.notes_md_stamped ?? ''), gv?.notes_md_stamped)
check('notes get: a plain note has notes_md_stamped null', got.json?.notes.find((n) => n.id === meeting)?.notes_md_stamped === null)

const tv = await cli('notes', 'transcript', 'get', '--id', video)
check('transcript get: video positions from the mapped chunks', tv.json?.transcript.map((c) => c.position_ms).join() === '60000,65000', tv.json?.transcript)
const tl = await cli('notes', 'transcript', 'get', '--id', lesson2)
check('transcript get: a video-captions chunk is its offset into the session', tl.json?.transcript[0]?.position_ms === 12_000, tl.json?.transcript)

const sl = await cli('series', 'list')
check('series list', sl.code === 0 && sl.json.series.map((x) => x.title).sort().join() === 'CodeOpinion,Fundamentos', sl.json)
const sg = await cli('series', 'get', '--id', course.id)
check(
  'series get: lessons in catalog order with note ids (unwatched ones null), then pending notes',
  sg.json?.lessons?.slice(0, 2).map((l) => `${l.number}:${l.note_id ?? '-'}`).join() === `1:-,2:${lesson2}` && sg.json.pending_note_ids.join() === pending,
  sg.json
)
const sMissing = await cli('series', 'get', '--id', 'no-such-series')
check('series get of an unknown id is NOT_FOUND', sMissing.code === 1 && sMissing.json?.code === 'NOT_FOUND', sMissing.json)
const sNoId = await cli('series', 'get')
check('series get without --id is a usage error', sNoId.code === 2, sNoId.json)
const help = await new Promise((done) => execFile(process.execPath, [CLI, 'help'], (_e, out) => done(out)))
check('help lists the new commands and filters', /series list/.test(help) && /series get --id ID/.test(help) && /--has-series/.test(help))

// ---------- 4. Find sources ----------

const handlers = mods.electron.handlers
mods.backfill.registerBackfill(ctx)
const invoke = (ch, req) => handlers.get(ch)(null, req)
if (process.platform === 'win32') {
  const preview = await invoke('sources:backfill-preview', {})
  const row = (id) => preview.rows.find((r) => r.noteId === id)
  check('preview: a YouTube URL in the text is exact and ticked', row(withUrl)?.proposal?.canonicalKey === 'youtube:zyxwvutsrqp' && row(withUrl).confidence === 'exact' && row(withUrl).ticked, row(withUrl))
  check('preview: Sampleapp links are never proposed', !preview.rows.some((r) => r.proposal?.url?.includes('sampleapp')))
  check('preview: a video title with lookups off is listed, not searched', row(tagged)?.proposal === null && preview.lookupsSkipped === true, row(tagged))
  check(
    'preview: a course title proposes a guess in its course, lesson guessed',
    row(courseTitle)?.proposal?.series?.title === 'Fundamentos' && row(courseTitle).proposal.lesson?.number === 33 && row(courseTitle).proposal.lesson.state === 'guessed' && row(courseTitle).ticked === false,
    row(courseTitle)?.proposal
  )
  check('preview: notes with a source and plain meetings are not rows', !row(video) && !row(meeting))
  const scoped = await invoke('sources:backfill-preview', { noteIds: [withUrl] })
  check('a scoped preview covers only its notes', scoped.rows.length === 1 && scoped.rows[0].noteId === withUrl)
  check('nothing changed before apply', call('getNoteSource', withUrl) === null)
  const applied = await invoke('sources:backfill-apply', { previewId: preview.previewId, rowIds: [row(withUrl).id, row(courseTitle).id] })
  const s1 = call('getNoteSource', withUrl)
  check('apply links the ticked rows', applied.applied === 2 && s1?.canonical_key === 'youtube:zyxwvutsrqp' && s1.detected_via === 'backfill', { applied, s1: s1?.canonical_key })
  check('apply never retitles the note', call('getNote', withUrl).title === 'Notes on a talk')
  let reused = ''
  try {
    await invoke('sources:backfill-apply', { previewId: preview.previewId, rowIds: [row(tagged).id] })
  } catch (err) {
    reused = err.message
  }
  check('a preview applies once', /expired/.test(reused), reused)
  const undone = await invoke('sources:backfill-undo', { batchId: applied.batchId })
  check('undo unlinks the batch', undone.reverted === 2 && call('getNoteSource', withUrl) === null && call('getNoteSource', courseTitle) === null, undone)
  let twice = ''
  try {
    await invoke('sources:backfill-undo', { batchId: applied.batchId })
  } catch (err) {
    twice = err.message
  }
  check('one undo per batch', /already undone/.test(twice), twice)
  // A link used since the apply (watched, or stamped notes typed) survives Undo.
  const again = await invoke('sources:backfill-preview', {})
  const rowAgain = (id) => again.rows.find((r) => r.noteId === id)
  check('preview: no-match rows do not count toward the cap', again.rows.filter((r) => r.proposal || r.choices.length).length <= 500 && !!rowAgain(withUrl) && !!rowAgain(courseTitle))
  const applied2 = await invoke('sources:backfill-apply', { previewId: again.previewId, rowIds: [rowAgain(withUrl).id, rowAgain(courseTitle).id] })
  call('addSourceSpans', withUrl, [{ wall_start: T0, wall_end: T0 + 60_000, pos_start_ms: 0, pos_end_ms: 60_000, rate: 1 }])
  call('updateNoteSource', courseTitle, { notes_md_stamped: 'typed after the apply' })
  const undone2 = await invoke('sources:backfill-undo', { batchId: applied2.batchId })
  check(
    'undo keeps links used since the apply (spans, stamped notes)',
    undone2.reverted === 0 && call('getNoteSource', withUrl) !== null && call('listSourceSpans', withUrl).length === 1 && call('getNoteSource', courseTitle)?.notes_md_stamped === 'typed after the apply',
    undone2
  )
} else {
  console.log('skip Find sources (Windows only)')
}

// ---------- 5. the exports ----------

mods.dataExport.registerDataExport(ctx)
const exportsDir = join(scratch, 'exports')
mkdirSync(exportsDir)
process.env.NOTULA_DEV_DIALOG_DIR = exportsDir
await invoke('export:choose-folder')
const runExport = async (req) => {
  await invoke('export:start', {
    folder: exportsDir,
    include: { notes: true, transcripts: true, index: false, encryptedDb: false, decryptedDb: false },
    includeTrash: false,
    confirmedPlaintext: true,
    confirmedDecryptedDb: false,
    ...req
  })
  // The export runs in the background; README.txt is its last file.
  for (let i = 0; i < 200; i++) {
    const dirs = readdirSync(exportsDir).map((d) => join(exportsDir, d))
    const done = dirs.filter((d) => existsSync(join(d, 'README.txt')))
    const mine = done.filter((d) => (req.format === 'markdown' ? /^Notula Markdown export/ : /^Notula export/).test(relative(exportsDir, d)))
    if (mine.length > (req.format === 'markdown' ? mdDone : stdDone)) return mine[mine.length - 1]
    await new Promise((r) => setTimeout(r, 50))
  }
  return null
}
let mdDone = 0
let stdDone = 0
const walk = (dir) => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)).map((x) => `${f}/${x}`) : [f]))

if (process.platform === 'win32') {
  const md = await runExport({ format: 'markdown' })
  mdDone++
  check('Export notes as Markdown writes a new "Notula Markdown export …" folder', !!md && /^Notula Markdown export \d{4}-\d{2}-\d{2} \d{2}\.\d{2}/.test(relative(exportsDir, md ?? '')), md)
  if (md) {
    const files = walk(md)
    check('the folder tree mirrors Notula folders (two levels)', files.includes('Courses/Fundamentos/2 - Modules.md') && files.some((f) => f.startsWith('Courses/Fundamentos/') && f.includes('Lesson without a number')), files)
    check('a numbered lesson file starts with its number; a transcript sits beside it', files.includes('Courses/Fundamentos/2 - Modules.transcript.md'), files)
    const vFile = files.find((f) => f.endsWith('Creating a loosely coupled monolith.md'))
    const vText = vFile ? readFileSync(join(md, vFile), 'utf8') : ''
    check(
      'front-matter has the flat source properties',
      /\nsource_url: "https:\/\/www\.youtube\.com\/watch\?v=abcdefghijk"\n/.test(vText) && /\nsource_kind: "video"\n/.test(vText) && /\nchannel: "CodeOpinion"\n/.test(vText) &&
        /\nseries: "CodeOpinion"\n/.test(vText) && /\nduration: "10:00"\n/.test(vText) && /\nwatched: 50\n/.test(vText),
      vText.slice(0, 900)
    )
    check('the body is the stamped projection', vText.includes('[01:05](https://www.youtube.com/watch?v=abcdefghijk&t=65s) Modules own their data.'))
    const line = Number(/notula_sections:\n {2}- kind: "notes"\n {4}title: "My notes"\n {4}line: (\d+)/.exec(vText)?.[1])
    check('section markers name the exact heading line', vText.split('\n')[line - 1] === '## My notes', { line, at: vText.split('\n')[line - 1] })
    check('export format 2', /\nnotula_export_version: 2\n/.test(vText))
    const vt = files.find((f) => f.endsWith('Creating a loosely coupled monolith.transcript.md'))
    const vtText = vt ? readFileSync(join(md, vt), 'utf8') : ''
    check('the transcript has [mm:ss] video times', /\n\[01:00\] [^:\n]+: Welcome back to the channel\. Today, coupling\.\n?/.test(vtText) || /\[01:00\] .*Welcome back/.test(vtText), vtText)
  }
  const std = await runExport({})
  stdDone++
  if (std) {
    const files = walk(std)
    const vFile = files.find((f) => f.startsWith('notes/') && f.includes('Creating a loosely coupled monolith'))
    const vText = vFile ? readFileSync(join(std, vFile), 'utf8') : ''
    check('the standard export has the nested source block', /\nsource:\n {2}kind: "video"\n {2}provider: "youtube"\n/.test(vText) && /\n {2}watched_percent: 50\n/.test(vText), vText.slice(0, 900))
    check('the standard export keeps notes_md as its body', vText.includes('\nModules own their data.') && !vText.includes('[01:05]('))
    const plain = files.find((f) => f.startsWith('notes/') && f.includes('Weekly sync'))
    check('a note without a source has source: null', !!plain && /\nsource: null\n/.test(readFileSync(join(std, plain), 'utf8')))
    const tFile = files.find((f) => f.startsWith('transcripts/') && f.includes('Creating a loosely coupled monolith'))
    check("a source note's standard transcript is timed", !!tFile && /\[01:00\] /.test(readFileSync(join(std, tFile), 'utf8')))
    const mFile = files.find((f) => f.startsWith('transcripts/') && f.includes('Weekly sync'))
    const mText = mFile ? readFileSync(join(std, mFile), 'utf8') : ''
    check('a meeting transcript stays exactly "Copy transcript" (no times)', /\nTranscript:\n[^[\n][^:\n]*: Let us start with the budget\.\n$/.test(mText), mText)
  } else check('the standard export finished', false)
  let refused = ''
  try {
    await invoke('export:start', {
      folder: exportsDir,
      include: { notes: true, transcripts: false, index: false, encryptedDb: true, decryptedDb: false },
      includeTrash: false,
      confirmedPlaintext: true,
      confirmedDecryptedDb: false,
      format: 'markdown'
    })
  } catch (err) {
    refused = err.message
  }
  check('a Markdown export refuses database copies', /Database copies/.test(refused), refused)
  let noConfirm = ''
  try {
    await invoke('export:start', { folder: exportsDir, include: { notes: true, transcripts: false, index: false, encryptedDb: false, decryptedDb: false }, includeTrash: false, confirmedPlaintext: false, confirmedDecryptedDb: false, format: 'markdown' })
  } catch (err) {
    noConfirm = err.message
  }
  check('a Markdown export needs the plaintext confirmation', /plaintext confirmation/.test(noConfirm), noConfirm)
  // Never overwrite: a second write of the same note into the same export folder fails.
  if (md) {
    const refs = call('listExportNotes', { includeTrash: false, format: 'markdown' }).filter((r) => r.id === video)
    const again = call('writeExportNotes', { root: md, notes: refs, markdown: true, transcripts: false, format: 'markdown' })
    check('an existing file is never overwritten', again.written.length === 0 && again.errors.length === 1, again)
  }
  let escape = ''
  try {
    const r = call('writeExportNotes', { root: md, notes: [{ id: video, baseName: 'x', trashed: false, hasTranscript: false, relDir: '../..' }], markdown: true, transcripts: false, format: 'markdown' })
    escape = r.errors[0]?.message ?? ''
  } catch (err) {
    escape = err.message
  }
  check('a folder outside the export is refused', /bad folder name|outside/.test(escape), escape)
  // A reserved stem plus a dot sanitizes once (`Aux_. notes`), so its folder passes the re-check.
  const sane = mods.exportRepo.sanitizeBaseName
  check('reserved names sanitize idempotently', ['Aux. notes', 'Con. reunião', 'nul.md', 'COM1'].every((n) => sane(sane(n, 50), 50) === sane(n, 50)) && sane('Aux. notes', 50) === 'Aux_. notes', ['Aux. notes', 'nul.md'].map((n) => sane(n, 50)))
} else {
  console.log('skip the Markdown export (Windows only)')
}

// ---------- done ----------

call('close')
if (KEEP) console.log(`kept ${scratch}`)
else rmSync(scratch, { recursive: true, force: true })
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed')
process.exit(failures ? 1 : 0)
