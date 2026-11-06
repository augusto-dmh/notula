// SPDX-License-Identifier: Apache-2.0
// Dev-only check for transcripts in full-text search (migration `transcripts-fts`), on synthetic
// data only. It never opens the real data folder.
//
//   node scripts/dev/transcript-search-check.mjs [--prev <git rev>] [--keep]
//
// 1. Builds the storage engine of the previous release (`--prev`, default the merge base of HEAD
//    and main, else main) and of this tree for Node, with Vite (dependencies stay external).
// 2. The previous build writes a database with notes and transcripts. This tree upgrades it:
//    every row kept, the new tables and triggers, the schema of a fresh database, and the
//    backfill queues every note with a transcript.
// 3. On the upgraded file, with this tree's indexer on a fake clock: the backfill drain, partial
//    and final chunks, an erased and a deleted chunk, a chunk moved to another note, trash,
//    restore and permanent delete, a caption-only note, the 30 s rule and the batch caps,
//    `searchFts` sources and ranking, and the search page's transcript match.
// 4. A size line: index bytes over transcript characters for a synthetic 50-note library.
//
// Exits 1 on any failure. `--keep` keeps the scratch folder.

import { randomBytes, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
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
const OUT = join(tmpdir(), 'notula-transcript-search-check')
const schemaOf = (dir) => Number(/export const SCHEMA_VERSION = (\d+)/.exec(readFileSync(join(dir, 'src/main/storage/protocol.ts'), 'utf8'))[1])
const TARGET = schemaOf(ROOT)
const MARKER = '[DELETED]'
const QUIET_MS = 30_000
const NEW_TABLE = /^transcripts_fts/

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

// ---------- the two engines ----------

function sourceTree(rev, dir) {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const tar = join(dir, 'src.tar')
  execFileSync('git', ['archive', '-o', tar, rev, 'src'], { cwd: ROOT })
  execFileSync('tar', ['-xf', basename(tar)], { cwd: dir })
  rmSync(tar)
  return dir
}

/** Builds `tree`'s storage modules for Node and imports them; dependencies stay external. */
async function bundle(tree, name, entries) {
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
      rolldownOptions: {
        input: Object.fromEntries(entries.map((e) => [e, join(tree, `src/main/storage/${e}.ts`)])),
        output: { format: 'es', entryFileNames: '[name].mjs' }
      }
    }
  })
  const mods = {}
  for (const e of entries) mods[e] = await import(pathToFileURL(join(outDir, `${e}.mjs`)).href)
  return mods
}

const engines = []

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

const openParams = (dataDir, keyHex) => ({
  dataDir,
  keyHex,
  appVersion: '0.0.0-check',
  devFailMigration: false,
  devVersionAhead: false,
  housekeeping: false
})

// ---------- reading a file directly ----------

function openRaw(dataDir, keyHex, opts = {}) {
  const db = new Database(join(dataDir, 'notula.db'), { fileMustExist: true, ...opts })
  db.pragma(`cipher = 'sqlcipher'`)
  db.pragma('legacy = 4')
  db.pragma(`key = "x'${keyHex}'"`)
  return db
}

function snapshot(dataDir, keyHex) {
  const db = openRaw(dataDir, keyHex, { readonly: true })
  try {
    const names = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all().map((r) => r.name)
    const tables = {}
    for (const t of names) {
      tables[t] = db
        .prepare(`SELECT * FROM "${t}"`)
        .all()
        .map((r) => JSON.stringify(Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Buffer.isBuffer(v) ? `x'${v.toString('hex')}'` : v]))))
        .sort()
    }
    return { version: db.pragma('user_version', { simple: true }), tables }
  } finally {
    db.close()
  }
}

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

// ---------- synthetic data ----------

const T0 = Date.parse('2026-10-05T09:00:00.000Z')
// Invented words: no real meeting text.
const VOCAB = 'alder brisket cobalt dunmore elvan fistral gorsey hollin ivel jessamy kestle lumber morrow nettle orrin pellow quarrel rillan sedge tamar umber vellan wisket yarrow zennor'.split(' ')

function chunk(noteId, i, text, extra = {}) {
  return {
    id: randomUUID(),
    document_id: noteId,
    workspace_id: '',
    owner_id: '',
    transcription_session_id: extra.session ?? `session-${noteId}`,
    source: extra.source ?? 'microphone',
    start_timestamp: new Date(T0 + i * 2_000).toISOString(),
    end_timestamp: new Date(T0 + i * 2_000 + 1_500).toISOString(),
    text,
    is_final: extra.final ?? true,
    detected_speaker_name: extra.speaker ?? 'Speaker A',
    ...extra.fields
  }
}

/** Seeds, through any build's storage API, notes with transcripts. */
function seed(call) {
  const note = (title) => call('createNote', { origin: 'unknown', title, created_via: 'Windows' }).id
  const n = {}
  n.only = note('A planning call')
  call('upsertChunks', [chunk(n.only, 0, 'We should move the gantrywhistle review.'), chunk(n.only, 1, 'Agreed, next week works.')])
  n.partial = note('A partial call')
  call('upsertChunks', [chunk(n.partial, 0, 'Partly heard: quorvane.', { final: false })])
  n.caption = note('A recorded lesson')
  call('upsertChunks', [chunk(n.caption, 0, 'Today we cover the plinthmoor method.', { source: 'system', speaker: null, session: `captions-${randomUUID()}` })])
  n.erase = note('An erased call')
  n.eraseChunk = chunk(n.erase, 0, 'Please keep the velloscrim figure private.')
  call('upsertChunks', [n.eraseChunk, chunk(n.erase, 1, 'The erase note stays searchable: tamberlode.')])
  n.del = note('A sections call')
  n.delChunk = chunk(n.del, 0, 'A section about the ostrovane numbers.')
  call('upsertChunks', [n.delChunk, chunk(n.del, 1, 'Another section stays.')])
  n.from = note('Merged away')
  n.moveChunk = chunk(n.from, 0, 'The halvering plan moves along.')
  call('upsertChunks', [n.moveChunk])
  n.to = note('Merged into')
  call('upsertChunks', [chunk(n.to, 0, 'The kept note had its own words.')])
  n.trash = note('A trashed call')
  call('upsertChunks', [chunk(n.trash, 0, 'Words about the dremmelfax launch.')])
  n.gone = note('A deleted call')
  call('upsertChunks', [chunk(n.gone, 0, 'The skarnwick budget is final.')])
  // Equal terms in the user's notes and in another note's transcript.
  n.byNotes = note('Notes hit')
  call('updateNote', n.byNotes, { notes_text: 'Remember the fernwhistle draft.' })
  n.byTranscript = note('Transcript hit')
  call('upsertChunks', [chunk(n.byTranscript, 0, 'The fernwhistle draft was read aloud.')])
  n.empty = note('No transcript')
  return n
}

// ---------- the run ----------

const scratch = join(OUT, 'data')
let raw = null
try {
  rmSync(OUT, { recursive: true, force: true })
  mkdirSync(scratch, { recursive: true })
  console.log(`Building the storage engines (${PREV_REV} and this tree)…`)
  const prevTree = sourceTree(PREV_REV, join(OUT, 'prev-src'))
  const PREV = schemaOf(prevTree)
  const OLD = (await bundle(prevTree, 'prev', ['engine'])).engine
  const NEW = await bundle(ROOT, 'new', ['engine', 'fts'])
  const keyHex = randomBytes(32).toString('hex')
  const migration = /\{ version: (\d+), name: 'transcripts-fts'/.exec(readFileSync(join(ROOT, 'src/main/storage/migrations.ts'), 'utf8'))
  check(`the migration transcripts-fts is the last one, at ${TARGET}`, Number(migration?.[1]) === TARGET && PREV < TARGET, { migration: migration?.[1], PREV, TARGET })

  const freshDir = join(scratch, 'fresh')
  const fc = client(NEW.engine.StorageEngine)
  const fs0 = fc.call('open', openParams(freshDir, keyHex))
  fc.call('close')
  check(`a fresh database is at schema ${TARGET}`, fs0.state === 'ready' && fs0.schemaVersion === TARGET, { state: fs0.state, detail: fs0.detail })
  const want = shape(freshDir, keyHex)

  // ---------- the upgrade ----------

  const dataDir = join(scratch, 'upgrade')
  const oc = client(OLD.StorageEngine)
  const os = oc.call('open', openParams(dataDir, keyHex))
  check(`${PREV_REV.slice(0, 12)} creates a schema-${PREV} database`, os.state === 'ready' && os.schemaVersion === PREV, { state: os.state })
  const n = seed(oc.call)
  oc.call('trashNote', n.trash)
  oc.call('close')
  const before = snapshot(dataDir, keyHex)

  const up = client(NEW.engine.StorageEngine)
  const us = up.call('open', openParams(dataDir, keyHex))
  up.call('close')
  check(`this tree migrates it to ${TARGET}`, us.state === 'ready' && us.schemaVersion === TARGET, { state: us.state, detail: us.detail })
  const after = snapshot(dataDir, keyHex)
  const changed = [...new Set([...Object.keys(before.tables), ...Object.keys(after.tables)])]
    .filter((t) => !NEW_TABLE.test(t))
    .filter((t) => (before.tables[t] ?? []).join('\n') !== (after.tables[t] ?? []).join('\n'))
  check('every existing row is kept', changed.length === 0, changed.join(', '))
  const got = shape(dataDir, keyHex)
  const missing = want.filter((l) => !got.includes(l))
  const extra = got.filter((l) => !want.includes(l))
  check('the upgraded file has the schema of a fresh database', missing.length === 0 && extra.length === 0, [...missing, ...extra].join(' | '))
  const triggers = got.filter((l) => l.startsWith('trigger ') && /transcripts_fts/.test(l)).map((l) => l.split(' ')[1]).sort()
  check(
    'the new table, queue and triggers are there',
    got.some((l) => l.startsWith('table transcripts_fts ') && /trigram case_sensitive 0/.test(l)) &&
      got.some((l) => l.startsWith('table transcripts_fts_queue ') && /WITHOUT ROWID/.test(l)) &&
      ['documents_transcripts_fts_delete', 'documents_transcripts_fts_enqueue_update', 'transcript_chunks_fts_enqueue_delete', 'transcript_chunks_fts_enqueue_insert', 'transcript_chunks_fts_enqueue_update'].every((t) => triggers.includes(t)),
    triggers
  )
  check(
    'the existing FTS triggers are unchanged',
    ['documents_fts_enqueue_insert', 'documents_fts_enqueue_update', 'documents_fts_delete'].every((t) => got.find((l) => l.startsWith(`trigger ${t} `)) === want.find((l) => l.startsWith(`trigger ${t} `)))
  )
  const backfillLog = up.logs.find((l) => l.event === 'fts-backfill-queued')
  // Notes with an indexable transcript: only, caption, erase, del, from, to, gone, byTranscript (not partial, trash, byNotes, empty).
  check('the backfill queues every live note with a final transcript, counted in fts-backfill-queued', backfillLog?.data?.rows >= 8, backfillLog?.data)

  // ---------- this tree's indexer on a fake clock ----------

  raw = openRaw(dataDir, keyHex)
  raw.pragma('journal_mode = WAL')
  const ids = raw.prepare(`SELECT owner_id, workspace_id FROM documents LIMIT 1`).get()
  const logs = []
  const ctx = {
    db: raw,
    identity: { ownerId: ids.owner_id, workspaceId: ids.workspace_id },
    tmpDir: join(dataDir, 'tmp'),
    userDataDir: dataDir,
    touch() {},
    log(level, event, data) {
      logs.push({ level, event, data })
    }
  }
  let clock = Date.now()
  const indexer = new NEW.fts.FtsIndexer(() => ctx, { now: () => clock })
  const dueNow = () => (clock = Date.now() + QUIET_MS + 1_000)
  const drain = async () => {
    await indexer.drainNow()
  }
  const queued = () => raw.prepare(`SELECT document_id FROM transcripts_fts_queue`).all().map((r) => r.document_id)
  const indexed = (id) => raw.prepare(`SELECT count(*) AS c FROM transcripts_fts f JOIN documents d ON d.rid = f.rowid WHERE d.id = ?`).get(id).c
  const find = (term, sources = ['transcripts']) => NEW.fts.searchFts(ctx, { terms: [term], limit: 50, sources }).map((h) => h.documentId)
  const write = (method, ...a) => {
    const e = client(NEW.engine.StorageEngine)
    e.call('open', openParams(dataDir, keyHex))
    try {
      return e.call(method, ...a)
    } finally {
      e.call('close')
    }
  }

  clock = Date.now()
  await drain()
  check('a just-queued note waits for the quiet period', indexed(n.only) === 0 && queued().includes(n.only))
  dueNow()
  await drain()
  const run = logs.filter((l) => l.event === 'fts-transcripts-indexed')
  check('after 30 s the backfill drains', indexed(n.only) === 1 && queued().length === 0, queued())
  check('fts-transcripts-indexed logs notes, chars and ms only', run.length === 1 && Object.keys(run[0].data).sort().join() === 'chars,ms,notes' && run[0].data.notes >= 8, run)
  check('a note is found by a word only in its transcript', find('gantrywhistle').join() === n.only)
  check('the index row holds final text only, in order, without speakers', NEW.fts.transcriptText(raw, n.only) === 'We should move the gantrywhistle review.\nAgreed, next week works.')
  check('a caption-only note is found by a caption word', find('plinthmoor').join() === n.caption)
  check('a partial chunk is not indexed', find('quorvane').length === 0 && indexed(n.partial) === 0)
  check('a trashed note has no row', indexed(n.trash) === 0 && find('dremmelfax').length === 0)
  check('a note without a transcript has no row', indexed(n.empty) === 0)
  check('searchFts without sources returns no transcript hit', NEW.fts.searchFts(ctx, { terms: ['gantrywhistle'], limit: 50 }).length === 0)
  const ranked = NEW.fts.searchFts(ctx, { terms: ['fernwhistle'], limit: 50, sources: ['documents', 'panels', 'transcripts'] })
  check(
    'with transcripts, a transcript hit ranks after a note hit of equal terms',
    ranked.length === 2 && ranked[0].documentId === n.byNotes && ranked[0].source === 'document' && ranked[1].documentId === n.byTranscript && ranked[1].source === 'transcript' && ranked[1].inTitle === false && ranked[1].panelId === null,
    ranked
  )

  // A partial becomes final.
  write('upsertChunks', [{ ...chunk(n.partial, 0, 'Partly heard: quorvane.'), id: raw.prepare(`SELECT id FROM transcript_chunks WHERE document_id = ?`).get(n.partial).id }])
  clock = Date.now() + 20_000
  await drain()
  check('a write 20 s ago is not indexed yet', find('quorvane').length === 0 && queued().includes(n.partial))
  dueNow()
  await drain()
  check('a chunk made final is indexed after the quiet period', find('quorvane').join() === n.partial)

  // Erase: the chunk rewritten to the marker.
  write('upsertChunks', [{ ...n.eraseChunk, text: MARKER, is_final: true }])
  dueNow()
  await drain()
  check('a chunk erased to the marker leaves the index', find('velloscrim').length === 0 && find('tamberlode').join() === n.erase)
  const leftovers = raw.prepare(`SELECT count(*) AS c FROM transcripts_fts WHERE text LIKE '%velloscrim%'`).get().c
  check('… no erased text survives in the index content', leftovers === 0)

  // Deleted sections are queued as already due.
  write('deleteTranscriptSections', n.del, [n.delChunk.id])
  clock = Date.now()
  await drain()
  check('a deleted chunk leaves the index on the next drain, without the quiet period', find('ostrovane').length === 0 && indexed(n.del) === 1)

  // A chunk moved to another note moves its text.
  raw.prepare(`UPDATE transcript_chunks SET document_id = ? WHERE id = ?`).run(n.to, n.moveChunk.id)
  dueNow()
  await drain()
  check('a chunk moved to another note moves its text', find('halvering').join() === n.to && indexed(n.from) === 0)

  // Trash, restore, permanent delete.
  write('trashNote', n.only)
  dueNow()
  await drain()
  check('trash removes the note from the index', indexed(n.only) === 0 && find('gantrywhistle').length === 0)
  write('restoreNote', n.only)
  dueNow()
  await drain()
  check('restore brings it back', find('gantrywhistle').join() === n.only)
  write('trashNote', n.gone)
  write('deleteNotePermanently', n.gone)
  check('permanent delete removes the row and the queue entry at once', raw.prepare(`SELECT count(*) AS c FROM transcripts_fts WHERE text LIKE '%skarnwick%'`).get().c === 0 && !queued().includes(n.gone))

  // The search page.
  const page = write('searchNotes', 'gantrywhistle')
  check('the search page matches a transcript word with match type transcript and a snippet', page.results.length === 1 && page.results[0].matchType === 'transcript' && page.results[0].snippet === 'We should move the gantrywhistle review.', page.results)
  const titleFirst = write('searchNotes', 'planning')
  check('a title match keeps its own type', titleFirst.results[0]?.matchType === 'title')

  // Batch caps: 5 notes, then about 300,000 characters.
  const many = []
  for (let i = 0; i < 12; i++) {
    const id = write('createNote', { origin: 'unknown', title: `Batch ${i}`, created_via: 'Windows' }).id
    many.push(id)
  }
  write('upsertChunks', many.map((id, i) => chunk(id, 0, `Batch words ${VOCAB[i]} only.`)))
  clock = Date.now() + QUIET_MS - 5_000
  check('nothing is due before 30 s', indexer.indexTranscripts(ctx) === 0)
  dueNow()
  check('one transaction indexes at most 5 notes', indexer.indexTranscripts(ctx) === 5)
  await drain()
  check('… and the drain takes the rest', many.every((id) => indexed(id) === 1))
  const big = []
  for (let i = 0; i < 3; i++) big.push(write('createNote', { origin: 'unknown', title: `Long ${i}`, created_via: 'Windows' }).id)
  const longText = (seed) => Array.from({ length: 4_000 }, (_, j) => VOCAB[(j * 7 + seed) % VOCAB.length]).join(' ') + '.'
  write('upsertChunks', big.flatMap((id, i) => Array.from({ length: 10 }, (_, k) => chunk(id, k, longText(i + k)))))
  dueNow()
  const first = indexer.indexTranscripts(ctx)
  const second = indexer.indexTranscripts(ctx)
  check('a batch stops at about 300,000 characters, with at least one note', first === 1 && second === 1, { first, second, chars: NEW.fts.transcriptText(raw, big[0]).length })
  await drain()

  // The indexer comes back on its own for a deferred note.
  write('upsertChunks', [chunk(n.empty, 0, 'Late words about brindlequay.')])
  clock = Date.now()
  await drain()
  check('a deferred note sets a wake timer', indexer.wakeTimer !== null && find('brindlequay').length === 0)
  indexer.stop()

  check('logs carry counts only', !JSON.stringify(logs).match(/gantrywhistle|plinthmoor|Batch words|planning/i), logs.map((l) => l.event))
  raw.close()
  raw = null

  // ---------- the size line ----------

  const sizeDir = join(scratch, 'size')
  const sc = client(NEW.engine.StorageEngine)
  sc.call('open', openParams(sizeDir, keyHex))
  for (let i = 0; i < 50; i++) {
    const id = sc.call('createNote', { origin: 'unknown', title: `Library ${i}`, created_via: 'Windows' }).id
    // About an hour of speech: 600 lines of 12 words.
    sc.call(
      'upsertChunks',
      Array.from({ length: 600 }, (_, k) => chunk(id, k, Array.from({ length: 12 }, (_, w) => VOCAB[(i * 31 + k * 13 + w * 7) % VOCAB.length] + (w % 5 === 0 ? String(k % 97) : '')).join(' ') + '.'))
    )
  }
  sc.call('close')
  const sraw = openRaw(sizeDir, keyHex)
  const sctx = { ...ctx, db: sraw }
  let sclock = Date.now() + QUIET_MS + 1_000
  const sIndexer = new NEW.fts.FtsIndexer(() => sctx, { now: () => sclock })
  await sIndexer.drainNow()
  sIndexer.stop()
  const chars = sraw.prepare(`SELECT COALESCE(SUM(length(text)), 0) AS c FROM transcripts_fts`).get().c
  const idxBytes =
    sraw.prepare(`SELECT COALESCE(SUM(length(block)), 0) AS b FROM transcripts_fts_data`).get().b +
    sraw.prepare(`SELECT COALESCE(SUM(length(term)), 0) + count(*) * 16 AS b FROM transcripts_fts_idx`).get().b
  const rows = sraw.prepare(`SELECT count(*) AS c FROM transcripts_fts`).get().c
  sraw.close()
  check('the 50-note library is indexed', rows === 50, { rows })
  console.log(`size: ${rows} notes, ${chars.toLocaleString('en-US')} transcript characters, ${idxBytes.toLocaleString('en-US')} index bytes (${(idxBytes / chars).toFixed(2)} bytes per character, plus the content copy)`)
} catch (err) {
  check('the run finished', false, err.stack ?? String(err))
} finally {
  try {
    raw?.close()
  } catch {
    // already closed
  }
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
