// SPDX-License-Identifier: Apache-2.0
// Dev-only check for the speaker-profile storage (migration 12), on synthetic data only. It never
// opens the real data folder.
//
//   node scripts/dev/speaker-storage-check.mjs [--prev <git rev>] [--keep]
//
// 1. Builds the storage engine of the previous build (`--prev`, a schema-11 tree; default the
//    merge base of HEAD and main, else main) and of this tree for Node, with Vite (dependencies
//    stay external), and drives each through its RPC dispatch, as the storage worker does.
// 2. The previous build writes a schema-11 database with a few notes and transcripts, the Labs
//    voiceprint keys and a self voiceprint. This tree upgrades it to 12: every row kept, the two
//    keys moved (`speakers.voices` never written), the Labs marker, the eight new tables empty,
//    a backup that holds the schema-11 data without the biometric table and passes
//    integrity_check, the schema of a fresh database, and a no-op second start. An injected
//    failure rolls back to 11 unchanged, and a retry reuses that backup; a backup whose row
//    counts no longer match is not reused.
// 3. On the upgraded file, the speaker-profile storage API: the self row and the legacy
//    conversion, the agreement guard and both switches, exact weighted centroids and a confirmation's w/Σw pull,
//    the sample cap after confirmations and after a merge, the far-from-profile skip, merges
//    (into the user, across withdrawals), cluster vectors and pending requests with every trash
//    path and the transcript retention purge, negatives re-mapped, both exports, Forget and
//    Forget all (each proven by a byte scan of a decrypted copy, free pages included, and an
//    empty WAL; Forget with the cluster vectors of the notes the person was named in or asked
//    about), no blending across model ids, the sweeps, Delete person, the People list join
//    and the logs. Also the pending request's span: the speaker's longest turn on its channel.
// 4. The speaker bench's A3, A7 and A15 on synthetic notes: a voice that can't name its person
//    automatically (a non-attendee's, or one with no calibrated condition, voice autos off, a
//    space on the other channel, one confirmation, under 30 s) moves no auto (the production
//    `decide`), an app auto drops under a contradicting mapping, the bench's mock names the
//    system clusters as someone else, and the prompt, chat and webhook outputs print a cluster
//    with a suggestion row as its letter, word by word, while a real leak is still counted.
//
// Exits 1 on any failure. `--keep` keeps the scratch folder.

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
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
const OUT = join(tmpdir(), 'notula-speaker-storage-check')
/** The schema version this tree migrates to, and the one before it. */
const TARGET = 12
const PREV = 11

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
let checks = 0

function check(name, ok, detail) {
  checks++
  if (!ok) failures++
  const extra = detail === undefined ? '' : typeof detail === 'string' ? ` ${detail}` : ` ${JSON.stringify(detail)}`
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok && typeof detail !== 'string' ? '' : extra}`)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
/** A fixed time on 2026-10-01, `min` minutes past nine (UTC). */
const at = (min) => new Date(Date.UTC(2026, 9, 1, 9, min)).toISOString()

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

/**
 * Builds `src/main/storage/<entry>.ts` of `tree` for Node and imports it, keyed by the entry's
 * file name (`../speakers/pending-span` → `pending-span`). Dependencies stay external, written as
 * file URLs into this tree's node_modules, so the output loads from the scratch folder.
 */
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
        input: Object.fromEntries(entries.map((e) => [basename(e), join(tree, 'src/main/storage', `${e}.ts`)])),
        output: { format: 'es', entryFileNames: '[name].mjs' }
      }
    }
  })
  const out = {}
  for (const e of entries) out[basename(e)] = await import(pathToFileURL(join(outDir, `${basename(e)}.mjs`)).href)
  return out
}

/** Every engine made, so a failed run still closes its databases before the scratch folder goes. */
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

/** A raw connection to a data folder's database, or to a database file. */
function openRaw(path, keyHex, opts = {}) {
  const file = path.endsWith('.db') ? path : join(path, 'notula.db')
  const db = new Database(file, { fileMustExist: true, ...opts })
  db.pragma(`cipher = 'sqlcipher'`)
  db.pragma('legacy = 4')
  db.pragma(`key = "x'${keyHex}'"`)
  return db
}

/** The schema version and every row of every table (rows sorted, blobs as hex). */
function snapshot(path, keyHex) {
  const db = openRaw(path, keyHex, { readonly: true })
  try {
    const version = db.pragma('user_version', { simple: true })
    const names = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all().map((r) => r.name)
    const tables = {}
    for (const t of names) {
      const rows = db.prepare(`SELECT * FROM "${t}"`).raw(false).all()
      tables[t] = rows
        .map((r) => JSON.stringify(Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Buffer.isBuffer(v) ? `x'${v.toString('hex')}'` : v]))))
        .sort()
    }
    return { version, tables }
  } finally {
    db.close()
  }
}

/** The schema, one line per object. */
function shape(path, keyHex) {
  const db = openRaw(path, keyHex, { readonly: true })
  try {
    return db
      .prepare(`SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`)
      .all()
      .map((r) => `${r.type} ${r.name} ${r.tbl_name} ${(r.sql ?? '').replace(/\s+/g, ' ')}`)
  } finally {
    db.close()
  }
}

const digest = (tables) =>
  Object.fromEntries(Object.entries(tables).map(([t, rows]) => [t, createHash('sha256').update(rows.join('\n')).digest('hex').slice(0, 16)]))

function compare(name, want, got) {
  const tables = [...new Set([...Object.keys(want), ...Object.keys(got)])].sort()
  const diff = tables.filter((t) => want[t] !== got[t])
  check(name, diff.length === 0, diff.length ? `differs in ${diff.join(', ')}` : `${tables.length} tables`)
}

const diffLines = (a, b) => [...a.filter((l) => !b.includes(l)).map((l) => `- ${l}`), ...b.filter((l) => !a.includes(l)).map((l) => `+ ${l}`)]

// ---------- the bench's A7 and A15 ----------

/**
 * The speaker bench's A7 (a contradicting LLM reply drops an app auto) and A15 (a cluster with a
 * suggestion row goes out as its letter), on synthetic notes: the production `decide` and output
 * formatters, the bench's mock reply and its word-by-word leak count, and why the earlier,
 * name-based count and first-come mock failed on a real run with nothing wrong in the app.
 */
function benchChecks(NEW) {
  const BC = NEW['bench-checks']
  const SP = NEW.speakers

  // A7, the app: an individual tile on all of a system cluster's speech names it automatically,
  // unless an accepted LLM mapping names it as someone else.
  {
    const cluster = { key: 'r:p1:r1', label: 'r1', channel: 'system', language: 'pt', speechMs: 60_000, cleanMs: 60_000, vector: null, tiles: [{ participantId: 't-ana', name: 'Ana Souza', share: 1, kind: 'individual' }], coverage: 1 }
    const cand = (id, name, tileIds) => ({ id, personId: id, name, isSelf: false, attendee: true, known: false, tileIds, stampedOnSystem: tileIds.length > 0, hasAgreement: false, autoRecognize: true })
    const input = (llm) => ({
      noteId: 'n', passId: 'p1', modelId: null, voices: false, selfVoice: false, hasLinkedEvent: true,
      clusters: [cluster], candidates: [cand('ana', 'Ana Souza', ['t-ana']), cand('bruno', 'Bruno Lima', [])], gallery: [], negatives: [], llm
    })
    const off = { voice: false, reason: 'missing', file: null }
    const run = (llm) => NEW.decide.decide(input(llm), off).clusters[0]
    const mapping = (candidateId, name) => ({ clusterKey: cluster.key, candidateId, name, evidence: ['named_then_replied'], selfIntroduced: false })
    const plain = run([])
    const agreeing = run([mapping('ana', 'Ana Souza')])
    const contradicted = run([mapping('bruno', 'Bruno Lima')])
    check('A7: the tile alone names the cluster automatically (app)', plain.band === 'auto' && plain.autoSrc === 'app' && plain.personId === 'ana', plain)
    check('A7: a mapping that agrees with the tile keeps it automatic', agreeing.band === 'auto' && agreeing.personId === 'ana', agreeing)
    check('A7: a mapping to someone else takes the automatic name away', contradicted.band !== 'auto' && contradicted.name === null, contradicted)
  }

  // A3: only attendees are named automatically by voice. Carla isn't on the event; her tile is
  // stamped on her long turn (r1, 80 % of it, enough for the app rule) and on a 10 s cluster (r2,
  // all of it). One-to-one, her tile goes to r2, which is too short to be named automatically, so
  // r1 gets no name. Her voice, once remembered, agrees with r1: it may give r1 a suggestion,
  // never an automatic name. Such a tile, moved by a held-out person's voice, is how A3 saw one
  // cluster rise on a real run.
  {
    const voiceOf = (i) => Float32Array.from({ length: 8 }, (_, k) => (k === i ? 1 : 0.05))
    const cluster = (label, speechMs, tiles, vector) => ({
      key: `r:p1:${label}`, label, channel: 'system', language: 'pt', speechMs, cleanMs: speechMs, vector, tiles, coverage: 1
    })
    const tile = (share, name = 'Carla Dias') => ({ participantId: name, name, share, kind: 'individual' })
    const carla = (attendee) => ({
      id: 'carla', personId: 'carla', name: 'Carla Dias', isSelf: false, attendee, known: !attendee, tileIds: ['Carla Dias'],
      stampedOnSystem: true, hasAgreement: true, autoRecognize: true
    })
    const bruno = { id: 'bruno', personId: 'bruno', name: 'Bruno Lima', isSelf: false, attendee: true, known: false, tileIds: [], stampedOnSystem: false, hasAgreement: true, autoRecognize: true }
    const conditions = ['<10s', '10-30s', '>=30s'].map((bucket) => ({
      channel: 'system', language: 'pt', bucket, autoEnabled: bucket === '>=30s', tauAuto: 0.97, tauSuggest: 0.75, margin: 0.1, tieMargin: 0.03, logistic: { a: 11, b: -6 }
    }))
    const calibration = { voice: true, file: { modelSha: 'm', reportHash: null, createdAt: '2026-10-30T00:00:00.000Z', benchVersion: 0, conditions } }
    const space = (personId, i, channel = 'system', confirmations = 3) => ({ personId, channel, confirmations, exemplars: [voiceOf(i)] })
    const run = (attendee, gallery, { cal = calibration, r1CleanMs = 90_000 } = {}) =>
      new Map(
        NEW.decide.decide({
          noteId: 'n', passId: 'p1', modelId: cal.file.modelSha, voices: true, selfVoice: true, hasLinkedEvent: true,
          clusters: [
            { ...cluster('r1', 90_000, [tile(0.8), tile(0.1, 'Bruno Lima')], voiceOf(1)), cleanMs: r1CleanMs },
            cluster('r2', 10_000, [tile(1)], voiceOf(5)),
            cluster('r3', 60_000, [], voiceOf(2))
          ],
          candidates: [carla(attendee), bruno], gallery, negatives: [], llm: []
        }, cal).clusters.map((d) => [d.key.slice(5), d])
      )
    const before = run(false, [space('bruno', 2)])
    const after = run(false, [space('bruno', 2), space('carla', 1)])
    const attending = run(true, [space('bruno', 2), space('carla', 1)])
    const bands = (m) => Object.fromEntries([...m].map(([k, d]) => [k, `${d.band}${d.personId ? `:${d.personId}/${d.autoSrc}` : ''}`]))
    check('A3 (fixture): without her voice, Carla\'s tile goes to r2, r1 gets no name and Bruno is named by voice', before.get('r1').band === 'none' && before.get('r2').band === 'suggest' && before.get('r3').band === 'auto' && before.get('r3').personId === 'bruno', bands(before))
    check('A3: a non-attendee\'s remembered voice turns no suggestion automatic, not even one her tile agrees with', [...before].every(([k, d]) => d.band === 'auto' || after.get(k).band !== 'auto'), { before: bands(before), after: bands(after) })
    check('A3: her voice still suggests her on her own turn', after.get('r1').band === 'suggest' && after.get('r1').candidates[0]?.personId === 'carla' && after.get('r1').voiceMatched.includes('carla'), bands(after))
    check('A3: as an attendee, her voice names r1 automatically', attending.get('r1').band === 'auto' && attending.get('r1').personId === 'carla', bands(attending))
    // An attendee whose voice can't name her automatically here may not move her tile either:
    // each gate of a voice auto but the score also keeps her voice out of the auto assignment.
    const rises = (before, after) => [...after].filter(([k, d]) => d.band === 'auto' && (before.get(k).band !== 'auto' || before.get(k).personId !== d.personId)).map(([k]) => k)
    const blocked = [
      ['no condition in the file', [space('carla', 1)], { cal: { voice: true, file: { ...calibration.file, conditions: [] } } }],
      ['only a space on the other channel', [space('carla', 1, 'mic')], {}],
      ['one confirmation', [space('carla', 1, 'system', 1)], {}],
      ['under 30 s of clean speech on her turn', [space('carla', 1)], { r1CleanMs: 25_000 }]
    ]
    for (const [why, voice, opts] of blocked) {
      const b = run(true, [space('bruno', 2)], opts)
      const a = run(true, [space('bruno', 2), ...voice], opts)
      check(`A3: an attendee's voice with ${why} changes no automatic name`, rises(b, a).length === 0, { before: bands(b), after: bands(a) })
    }
    // The shipped calibration has every voice auto off: there, no voice gives or moves an auto.
    const shipped = JSON.parse(readFileSync(join(ROOT, 'resources/speakers/calibration.json'), 'utf8'))
    const cal = { voice: true, file: shipped }
    const off = shipped.conditions.length > 0 && shipped.conditions.every((c) => !c.autoEnabled)
    const sb = run(true, [], { cal })
    const sa = run(true, [space('bruno', 2), space('carla', 1)], { cal })
    check('A3: under the shipped calibration (voice autos off), remembered voices give or move no automatic name', off && rises(sb, sa).length === 0, { autoEnabledOff: off, before: bands(sb), after: bands(sa) })
    // The app rule alone, with no one remembered: a dominant tile on one cluster stays automatic.
    const alone = new Map(NEW.decide.decide({
      noteId: 'n', passId: 'p1', modelId: 'm', voices: true, selfVoice: true, hasLinkedEvent: true,
      clusters: [cluster('r1', 90_000, [tile(0.8), tile(0.1, 'Bruno Lima')], voiceOf(1))],
      candidates: [carla(false), bruno], gallery: [space('carla', 1)], negatives: [], llm: []
    }, calibration).clusters.map((d) => [d.key.slice(5), d]))
    check('A3: a tile that passes the app rule on its own stays automatic for a non-attendee', alone.get('r1').band === 'auto' && alone.get('r1').autoSrc === 'app', bands(alone))
  }

  // A7, the bench's mock reply. A meeting with two candidates and four lettered clusters: a
  // split of the user's voice and an unlabelled cluster appear first, on the mic.
  {
    const p = (name) => ({ name, email: `${name.split(' ')[0].toLowerCase()}@example.test` })
    const clusters = [
      { key: 'r:p1:r8', label: 'Speaker A', channel: 'mic', speechMs: 12_000, truth: p('Dana Example') },
      { key: 'r:p1:r7', label: 'Speaker B', channel: 'mic', speechMs: 11_000, truth: null },
      { key: 'r:p1:r1', label: 'Speaker C', channel: 'system', speechMs: 60_000, truth: p('Bruno Lima') },
      { key: 'r:p1:r2', label: 'Speaker D', channel: 'system', speechMs: 40_000, truth: p('Ana Souza') }
    ]
    const cands = [{ id: 'c1', ...p('Ana Souza') }, { id: 'c2', ...p('Bruno Lima') }]
    // The earlier mock: every lettered cluster in order, the first unused candidate that isn't its person.
    const used = new Set()
    const firstCome = new Map()
    for (const c of clusters) {
      const other = cands.find((j) => !used.has(j.id) && (!c.truth || (j.email !== c.truth.email && j.name !== c.truth.name)))
      if (!other) continue
      used.add(other.id)
      firstCome.set(c.key, other.id)
    }
    check('A7 (why it failed): the first-come mock spends both candidates on the mic and leaves the app cluster uncontradicted', !firstCome.has('r:p1:r1') && !firstCome.has('r:p1:r2'), Object.fromEntries(firstCome))
    const planned = new Map(BC.contradictingMappings(clusters, cands).map((m) => [m.key, m.candidate.id]))
    check(
      'A7: the mock names both system clusters as someone else, and no unlabelled cluster',
      planned.get('r:p1:r1') === 'c1' && planned.get('r:p1:r2') === 'c2' && !planned.has('r:p1:r7') && !planned.has('r:p1:r8'),
      Object.fromEntries(planned)
    )
    // A first choice that would block a later cluster gives way (a maximum matching).
    const swap = BC.contradictingMappings(
      [
        { key: 'r:p1:r1', label: 'Speaker A', channel: 'system', speechMs: 60_000, truth: p('Bruno Lima') },
        { key: 'r:p1:r2', label: 'Speaker B', channel: 'system', speechMs: 30_000, truth: p('Carla Dias') }
      ],
      [{ id: 'c1', ...p('Ana Souza') }, { id: 'c2', ...p('Carla Dias') }]
    )
    const sw = new Map(swap.map((m) => [m.key, m.candidate.id]))
    check('A7: the mock contradicts as many clusters as the candidates allow', sw.get('r:p1:r1') === 'c2' && sw.get('r:p1:r2') === 'c1', Object.fromEntries(sw))
  }

  // A15: a decided note. Mic: the user (r9, the owner: Me) and a short split of their voice (r8,
  // a row suggesting Me). System: Bruno (r1, auto by app; two words stamped with Carla's tile,
  // which they keep), Ana (r2, a row suggesting Ana, one word she confirmed, and a long turn with
  // no sentence end, so a chat window cuts it mid-word) and Carla (r3, a row suggesting Carla).
  {
    const base = Date.parse('2026-10-29T10:00:00.000Z')
    const chunks = []
    let n = 0
    const say = (source, label, startS, count, extra = () => ({})) => {
      const anchor = base + startS * 1000
      const words = Array.from({ length: count }, (_, i) => ({ w: `${label}w${n}x${i}`, s_ms: i * 500, e_ms: i * 500 + 450, merged_spk: label, ...extra(i) }))
      chunks.push({
        id: `a15-${String(n++).padStart(3, '0')}`, document_id: 'a15', source, transcription_session_id: 's1', is_final: true, text: words.map((w) => w.w).join(' '),
        start_timestamp: new Date(anchor).toISOString(), end_timestamp: new Date(anchor + count * 500).toISOString(),
        providerDetails: { provider: 'local', words, wallClockAnchorMs: anchor, mergeScopeId: 'p1', named_pass: 'p1' }
      })
    }
    const bruno = (i) => ({ att: 'Bruno Lima', auto_spk: 'Bruno Lima', auto_pid: 'bruno', auto_src: 'app', ...(i < 2 ? { att: 'Carla Dias' } : {}) })
    for (let t = 0; t < 600; t += 60) say('microphone', 'r9', t, 40)
    say('microphone', 'r8', 605, 24)
    say('system', 'r1', 620, 60, bruno)
    say('system', 'r2', 660, 30, (i) => (i === 3 ? { confirmed_spk: 'Ana Souza', confirmed_pid: 'ana' } : {}))
    say('system', 'r1', 700, 30, bruno)
    say('system', 'r3', 720, 30)
    say('system', 'r2', 740, 400, (i) => ({ w: `r2-long-${i}` }))
    const rows = [
      { identityKey: 'r:p1:r8', band: 'suggest', candidates: [{ name: 'Me', source: 'voice' }] },
      { identityKey: 'r:p1:r2', band: 'suggest', candidates: [{ name: 'Ana Souza', source: 'app' }] },
      { identityKey: 'r:p1:r3', band: 'suggest', candidates: [{ name: 'Carla Dias', source: 'conversation' }] }
    ]
    const rowKeys = new Set(rows.map((r) => r.identityKey))
    const prompt = NEW.transcript.formatTranscript(chunks, { wordLevel: true }).text
    const promptOff = NEW.transcript.formatTranscript(chunks, { wordLevel: false }).text
    const chat = NEW.windows
      .transcriptWindows(SP.speakerTurns(chunks, { wordLevel: false, live: false }))
      .map((w) => NEW.windows.renderWindow('a15', w))
      .join('\n\n')
    const labels = SP.chunkSpeakerLabels(chunks, { wordLevel: true })
    const webhook = chunks.map((c) => ({ speaker: labels.get(c.id) ?? '', text: c.text }))
    const lines = { prompt: BC.labelledLines(prompt), promptNoSeparation: BC.labelledLines(promptOff), chat: BC.labelledLines(chat) }
    const outLabels = new Set([...Object.values(lines).flat().map((l) => l.label), ...webhook.map((e) => e.speaker)])
    check('A15 (fixture): the outputs print Me, Bruno, Carla on two of his words, Ana on her confirmed word, and letters', ['Me', 'Bruno Lima', 'Carla Dias', 'Ana Souza', 'Speaker A', 'Speaker C', 'Speaker D'].every((l) => outLabels.has(l)), [...outLabels])

    // The earlier count: a row's candidate name anywhere as a label, unless some cluster is named it.
    const { identities } = SP.speakerIdentities(chunks, { live: false })
    const named = new Set(identities.filter((i) => i.name).map((i) => i.name.toLowerCase()))
    const outputs = { ...Object.fromEntries(Object.entries(lines).map(([k, v]) => [k, v.map((l) => l.label)])), webhook: webhook.map((e) => e.speaker) }
    let byName = 0
    for (const ls of Object.values(outputs)) for (const r of rows) for (const c of r.candidates) if (!named.has(c.name.toLowerCase()) && ls.some((l) => l.toLowerCase() === c.name.toLowerCase())) byName++
    check('A15 (why it failed): the name-based count finds leaks in outputs that print every row cluster as its letter', byName > 0, { leaks: byName })

    const counts = { ...Object.fromEntries(Object.entries(lines).map(([k, v]) => [k, BC.lineLeaks(chunks, rowKeys, v)])), webhook: BC.chunkLeaks(chunks, rowKeys, webhook) }
    check(
      'A15: word by word, no row cluster goes out under anything but its letter (its confirmed word excepted)',
      Object.values(counts).every((c) => c.leaks === 0 && c.words > 0) && counts.prompt.words === 24 + 30 + 30 + 400 && counts.prompt.unaligned === 0,
      counts
    )
    // Ana's long turn is cut mid-word (the owner's too): only the cut words go unchecked.
    check('A15: a chat window that cuts a word leaves only the pieces unaligned', counts.chat.words < counts.prompt.words && counts.chat.words >= counts.prompt.words - 4 && counts.chat.unaligned <= 12, counts.chat)
    check(
      'A15: the prompt and webhook outputs align every word; chat stays within its tolerance',
      counts.prompt.unaligned === 0 && counts.promptNoSeparation.unaligned === 0 && counts.webhook.unaligned === 0 && counts.chat.unaligned > 0 && counts.chat.unaligned <= BC.CHAT_UNALIGNED_SHARE * counts.chat.tokens,
      { tolerance: BC.CHAT_UNALIGNED_SHARE, counts }
    )
    // A line that can't be aligned still counts under a row's name that no other cluster prints.
    // Carla's name is also on two of Bruno's words, so a line under it may be his.
    const rowNames = [...rows.flatMap((r) => r.candidates.map((c) => c.name)), 'Dana Example']
    const lost = BC.lineLeaks(chunks, rowKeys, [...lines.prompt, { label: 'Carla Dias', text: 'cut pieces' }, { label: 'Dana Example', text: 'cut pieces' }], rowNames)
    check('A15: an unaligned line under a row\'s suggested name is a leak, unless another cluster prints that name', lost.unaligned === 4 && lost.leaks === 2, lost)
    // A row cluster whose words still carry an automatic name prints it: counted apart.
    const stale = chunks.map((c) => (c.providerDetails.words[0]?.merged_spk === 'r3' ? { ...c, providerDetails: { ...c.providerDetails, words: c.providerDetails.words.map((w) => ({ ...w, auto_spk: 'Carla Dias', auto_pid: 'carla', auto_src: 'app' })) } } : c))
    check('A15: a row cluster named automatically anyway is counted', BC.namedRows(chunks, rowKeys) === 0 && BC.namedRows(stale, rowKeys) === 1, { clean: BC.namedRows(chunks, rowKeys), stale: BC.namedRows(stale, rowKeys) })
    // Ana's confirmed word may go out under her name only.
    const asBruno = BC.lineLeaks(chunks, rowKeys, lines.prompt.map((l) => (/\br2(w|-long)/.test(l.text) ? { ...l, label: 'Bruno Lima' } : l)))
    check('A15: a confirmed word printed under another name is a leak', asBruno.leaks === 430, asBruno)

    // A real leak is still found: Ana's turn printed under her suggested name, in each output kind.
    const leakyLines = lines.prompt.map((l) => (/\br2(w|-long)/.test(l.text) ? { ...l, label: 'Ana Souza' } : l))
    const leakyHook = webhook.map((e) => (e.text.startsWith('r2') ? { ...e, speaker: 'Ana Souza' } : e))
    const lineLeak = BC.lineLeaks(chunks, rowKeys, leakyLines)
    const hookLeak = BC.chunkLeaks(chunks, rowKeys, leakyHook)
    check('A15: a row cluster printed under its suggested name is a leak (lines and per-chunk)', lineLeak.leaks === 429 && hookLeak.leaks === 2, { lineLeak, hookLeak })
  }
}

// ---------- run ----------

const SPEAKER_TABLES = [
  'speaker_agreements',
  'speaker_cluster_vectors',
  'speaker_exemplars',
  'speaker_matches',
  'speaker_negatives',
  'speaker_pending',
  'speaker_people',
  'speaker_voice_spaces'
]

const scratch = join(OUT, 'data')
try {
  rmSync(OUT, { recursive: true, force: true })
  mkdirSync(scratch, { recursive: true })
  console.log(`Building the storage engines (${PREV_REV} and this tree)…`)
  const OLD = await bundle(sourceTree(PREV_REV, join(OUT, 'prev-src')), 'prev', ['engine'])
  const NEW = await bundle(ROOT, 'new', ['engine', '../speakers/pending-span', '../speakers/bench-checks', '../speakers/decide', '../enhance/transcript', '../chat/windows', '../../shared/lib/speakers'])
  const keyHex = randomBytes(32).toString('hex')

  // A fresh database of this tree: the schema an upgrade must reach.
  const freshDir = join(scratch, 'fresh')
  const fc = client(NEW.engine.StorageEngine)
  const fs0 = fc.call('open', openParams(freshDir, keyHex))
  fc.call('close')
  check('this tree creates a fresh database at schema 12', fs0.state === 'ready' && fs0.schemaVersion === TARGET, { state: fs0.state, detail: fs0.detail })
  const want = shape(freshDir, keyHex)
  check('a fresh database has the eight speaker tables', SPEAKER_TABLES.every((t) => want.some((l) => l.startsWith(`table ${t} `))))

  // ---------- 11 → 12 ----------

  const dataDir = join(scratch, 'v11')
  const oc = client(OLD.engine.StorageEngine)
  const os = oc.call('open', openParams(dataDir, keyHex))
  check(`${PREV_REV} creates a schema-11 database`, os.state === 'ready' && os.schemaVersion === PREV, { state: os.state, schemaVersion: os.schemaVersion, detail: os.detail })
  const seededNotes = []
  for (let i = 0; i < 3; i++) {
    const note = oc.call('createNote', { origin: 'unknown', title: `Synthetic meeting ${i + 1}`, created_via: 'Windows' })
    seededNotes.push(note.id)
    const sessionId = randomUUID()
    oc.call(
      'upsertChunks',
      Array.from({ length: 4 }, (_, k) => ({
        id: randomUUID(), document_id: note.id, workspace_id: '', owner_id: '', transcription_session_id: sessionId,
        source: k % 2 ? 'system' : 'microphone', start_timestamp: at(i * 10 + k), end_timestamp: at(i * 10 + k + 1),
        text: `Line ${k + 1} of meeting ${i + 1}.`, is_final: true, detected_speaker_name: null, detectedSpeaker: null
      }))
    )
  }
  oc.call('setSettingRaw', 'capture.llmAutoStop', true)
  // A Labs user: both voiceprint keys stored, and a self voice profile.
  oc.call('setSettingRaw', 'voiceprint.enabled', true)
  oc.call('setSettingRaw', 'voiceprint.passive', false)
  const legacyVector = Array.from({ length: 16 }, (_, i) => Math.sin(i + 1))
  oc.call('saveVoiceprint', { id: randomUUID(), model_id: 'wespeaker-en-voxceleb-resnet34', centroids: [{ vector: legacyVector, totalSpeechMs: 45_000, updatedAt: at(0) }], total_speech_ms: 45_000, updated_at: at(0) })
  oc.call('close')
  for (const copy of ['rollback', 'stale']) cpSync(dataDir, join(scratch, copy), { recursive: true })
  const before = snapshot(dataDir, keyHex)
  const beforeDigest = digest(before.tables)
  const beforeShape = shape(dataDir, keyHex)
  check(
    'the seeded file is schema 11 with notes, transcripts, a Labs voiceprint and no speaker tables',
    before.version === PREV && before.tables.documents.length === 3 && before.tables.transcript_chunks.length === 12 && before.tables.voiceprints.length === 1 && SPEAKER_TABLES.every((t) => !before.tables[t]),
    { version: before.version }
  )

  /** Migration 12 on a schema-11 file: the two keys moved, the marker, the eight tables empty. */
  const moved12 = (tables) => {
    const out = { ...tables }
    const rename = { '"voiceprint.enabled"': '"speakers.selfVoice"', '"voiceprint.passive"': '"speakers.selfPassive"' }
    out.settings = tables.settings.map((r) => r.replace(/"key":("voiceprint\.(?:enabled|passive)")/, (_, k) => `"key":${rename[k]}`)).sort()
    out.meta = [...tables.meta, JSON.stringify({ key: 'speakers_moved_from_labs', value: JSON.stringify({ enabled: true, profile: true }) })].sort()
    for (const t of SPEAKER_TABLES) out[t] ??= []
    return out
  }
  /** What a backup holds: every row, the biometric table empty. */
  const voiceFree = (tables) => ({ ...tables, voiceprints: [] })

  const m = client(NEW.engine.StorageEngine)
  const ms = m.call('open', openParams(dataDir, keyHex))
  const settings = m.call('getSettingsRaw')
  m.call('close')
  check('this tree migrates the schema-11 database to 12', ms.state === 'ready' && ms.schemaVersion === TARGET, { state: ms.state, schemaVersion: ms.schemaVersion, detail: ms.detail })
  const after = snapshot(dataDir, keyHex)
  compare('every row of the schema-11 file is kept, the two keys moved, the marker written and the eight new tables empty', digest(moved12(before.tables)), digest(after.tables))
  check(
    'the Labs keys moved: selfVoice and selfPassive keep their values, the old keys are gone, speakers.voices is never written',
    settings['speakers.selfVoice'] === true && settings['speakers.selfPassive'] === false && settings['voiceprint.enabled'] === undefined && settings['voiceprint.passive'] === undefined &&
      settings['speakers.voices'] === undefined && !after.tables.settings.some((r) => JSON.parse(r).key === 'speakers.voices') && settings['capture.llmAutoStop'] === true,
    { selfVoice: settings['speakers.selfVoice'], selfPassive: settings['speakers.selfPassive'], voices: settings['speakers.voices'] }
  )
  check('the legacy voiceprints table is left in place (it is emptied at runtime)', after.tables.voiceprints.length === 1)
  check(
    'a Labs user (switch on, a self voiceprint) gets the movedFromLabs marker',
    after.tables.meta.some((r) => {
      const row = JSON.parse(r)
      return row.key === 'speakers_moved_from_labs' && JSON.parse(row.value).enabled === true && JSON.parse(row.value).profile === true
    })
  )
  check('a backup of the schema-11 file was written first', !!ms.backupPath && existsSync(ms.backupPath) && /notula-v11-[0-9TZ-]+\.db$/.test(ms.backupPath), ms.backupPath)
  const bk = snapshot(ms.backupPath, keyHex)
  check('the backup is schema 11', bk.version === PREV)
  compare('the backup holds the schema-11 data, without the biometric table', digest(voiceFree(before.tables)), digest(bk.tables))
  const bkDb = openRaw(ms.backupPath, keyHex, { readonly: true })
  const bkIntegrity = bkDb.pragma('integrity_check', { simple: true })
  bkDb.close()
  check('the backup passes integrity_check', bkIntegrity === 'ok', bkIntegrity)
  const sd = diffLines(want, shape(dataDir, keyHex))
  check('the upgraded file has the schema of a fresh database', sd.length === 0, sd.length ? `\n      ${sd.join('\n      ')}` : `${want.length} lines`)
  const m2 = client(NEW.engine.StorageEngine)
  const m2s = m2.call('open', openParams(dataDir, keyHex))
  m2.call('close')
  check('a second start of the upgraded file is a no-op', m2s.state === 'ready' && m2s.schemaVersion === TARGET && !m2s.backupPath, { state: m2s.state, backup: m2s.backupPath ?? null })
  compare('and leaves its data as it was', digest(after.tables), digest(snapshot(dataDir, keyHex).tables))

  const rDir = join(scratch, 'rollback')
  const r = client(NEW.engine.StorageEngine)
  const rs = r.call('open', openParams(rDir, keyHex, { devFailMigration: true }))
  r.call('close')
  check('an injected failure after migration 12 leaves the database at 11 (rolled back)', rs.state === 'migration-failed' && rs.schemaVersion === PREV && /rolled back/.test(rs.detail ?? ''), { state: rs.state, detail: rs.detail })
  const rSnap = snapshot(rDir, keyHex)
  compare('after that rollback every row is unchanged (the keys not moved, the voiceprint kept)', beforeDigest, digest(rSnap.tables))
  const rShape = diffLines(beforeShape, shape(rDir, keyHex))
  check('after that rollback the file is schema 11 with its schema unchanged (no speaker table)', rSnap.version === PREV && rShape.length === 0, rShape.join(' | '))
  check('the failed attempt kept its backup', !!rs.backupPath && existsSync(rs.backupPath), rs.backupPath)
  const rb = client(NEW.engine.StorageEngine)
  const rt = rb.call('open', openParams(rDir, keyHex))
  rb.call('close')
  check(
    'a retry reuses that backup, because it passes the check (integrity and row counts)',
    rt.state === 'ready' && rt.backupPath === rs.backupPath && rb.logs.some((l) => l.event === 'sqlite-backup-reused'),
    { backup: rt.backupPath, logs: rb.logs.map((l) => l.event).filter((e) => e.startsWith('sqlite-backup')) }
  )
  compare('and its data matches the first upgrade', digest(moved12(before.tables)), digest(snapshot(rDir, keyHex).tables))

  // A failed attempt, then a note written by the previous build: that backup no longer matches.
  const sDir = join(scratch, 'stale')
  const sf = client(NEW.engine.StorageEngine)
  const sfs = sf.call('open', openParams(sDir, keyHex, { devFailMigration: true }))
  sf.call('close')
  const sw = client(OLD.engine.StorageEngine)
  sw.call('open', openParams(sDir, keyHex))
  sw.call('createNote', { origin: 'unknown', title: 'Written after the failed attempt', created_via: 'Windows' })
  sw.call('close')
  const s2 = client(NEW.engine.StorageEngine)
  const s2s = s2.call('open', openParams(sDir, keyHex))
  s2.call('close')
  check('after a failed attempt and a new note, the upgrade still succeeds', s2s.state === 'ready' && s2s.schemaVersion === TARGET, { state: s2s.state, detail: s2s.detail })
  check(
    'a backup whose row counts no longer match the database is not reused',
    !!sfs.backupPath && s2s.backupPath !== sfs.backupPath && s2.logs.some((l) => l.event === 'sqlite-backup-not-reused'),
    { first: sfs.backupPath, second: s2s.backupPath }
  )

  // ---------- the pending request's span ----------

  {
    const SPAN = NEW['pending-span']
    const base = Date.parse('2026-10-29T10:00:00.000Z')
    const chunks = []
    /** One chunk: `n` one-second words of `label` on `source`, from `startS` seconds into the call. */
    const say = (source, label, startS, n) => {
      const anchor = base + startS * 1000
      const words = Array.from({ length: n }, (_, i) => ({ w: `w${i}`, s_ms: i * 1000, e_ms: i * 1000 + 900, merged_spk: label }))
      chunks.push({
        id: `span-${chunks.length}`, document_id: 'span', source, transcription_session_id: 's1', is_final: true, text: words.map((w) => w.w).join(' '),
        start_timestamp: new Date(anchor).toISOString(), end_timestamp: new Date(anchor + n * 1000).toISOString(),
        providerDetails: { provider: 'local', words, wallClockAnchorMs: anchor, mergeScopeId: 'p1' }
      })
    }
    // Ana (system r1) says about a third of the system speech, Bruno (system r2) the rest, from
    // minute 1 to 58; the user talks on the mic (r9) nearly the whole time. Ana's longest turn is
    // the 40 s one at minute 31.
    for (let t = 60; t < 3_540; t += 120) {
      say('system', 'r1', t, t === 1_860 ? 40 : 30)
      say('system', 'r2', t + 45, 70)
      say('microphone', 'r9', t, 110)
    }
    const ana = SPAN.pendingSpanOf(chunks, 'p1', 'r:p1:r1')
    const firstLast = { startMs: base + 60_000, endMs: base + 3_449_900 }
    check(
      'a first-to-last-word span over every channel names another speaker (why the span is a single turn)',
      SPAN.clusterForSpan(chunks, 'p1', firstLast) !== 'r:p1:r1',
      SPAN.clusterForSpan(chunks, 'p1', firstLast)
    )
    check(
      "the stored span is the speaker's longest turn on its channel, and it resolves back to that speaker",
      ana?.source === 'system' && ana.startMs === base + 1_860_000 && ana.endMs === base + 1_860_000 + 39_900 && SPAN.clusterForSpan(chunks, 'p1', ana) === 'r:p1:r1',
      ana
    )
    check('a span on the mic channel never resolves to a system speaker', SPAN.clusterForSpan(chunks, 'p1', { ...ana, source: 'microphone' }) === 'r:p1:r9')
    check('a cluster of another pass has no span', SPAN.pendingSpanOf(chunks, 'p2', 'r:p1:r1') === null)
  }

  // ---------- the bench's A7 and A15, on synthetic notes ----------

  benchChecks(NEW)

  // ---------- the speaker-profile storage API on the upgraded file ----------

  const sx = client(NEW.engine.StorageEngine)
  sx.call('open', openParams(dataDir, keyHex))
  const k = sx.call
  const kFails = (method, ...params) => {
    try {
      k(method, ...params)
      return ''
    } catch (err) {
      return err instanceof Error ? err.message : String(err)
    }
  }
  const raw = (fn) => {
    const db = openRaw(dataDir, keyHex, { readonly: true })
    try {
      return fn(db)
    } finally {
      db.close()
    }
  }
  const count = (table) => raw((db) => db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n)
  let seedN = 1
  /** A deterministic unit vector of 8 dims. */
  const vec = (n = seedN++) => {
    const v = Float32Array.from({ length: 8 }, (_, i) => (Math.sin(n * 12.9898 + i * 78.233) * 43758.5453) % 1)
    const norm = Math.hypot(...v)
    return v.map((x) => x / norm)
  }
  const ex = (personId, extra = {}) => ({
    personId, modelId: 'model-a', channel: 'system', vector: vec(), cleanMs: 30_000, weight: 1,
    sourceNoteId: null, sourcePassId: null, sourceLabel: null, spanStartMs: null, spanEndMs: null, via: 'confirm', farCosine: null, ...extra
  })
  const agree = (personId) =>
    k('recordSpeakerAgreement', { personId, method: 'email', noticeVersion: 'voice-agreement-1', noticeLanguage: 'en', noticeText: 'Hi, may I?', evidenceText: 'I agree', evidenceNoteId: null, evidenceAtMs: null })
  const unit = (v) => {
    const n = Math.hypot(...v)
    return v.map((x) => x / n)
  }
  const mean = (items) => {
    const total = items.reduce((s, e) => s + e.weight, 0)
    return Array.from({ length: items[0].vector.length }, (_, i) => items.reduce((s, e) => s + e.weight * e.vector[i], 0) / total)
  }
  const close = (a, b, eps = 1e-5) => a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) < eps)
  const space = (personId, modelId = 'model-a', channel = 'system') => k('speakerVoiceGallery', { modelId, personIds: [personId] }).find((r) => r.channel === channel)

  // The self row and the legacy conversion.
  const me = k('ensureSelfPerson', '')
  const me2 = k('ensureSelfPerson', 'Dana Example')
  check('ensureSelfPerson is idempotent: one self row, "Me" while the name is empty, then the profile name', me.isSelf && me.displayName === 'Me' && me2.id === me.id && me2.displayName === 'Dana Example' && count('speaker_people') === 1)
  const conv = k('convertLegacyVoiceprints', { aliasModelId: 'resnet-sha' })
  const selfSamples = k('listSpeakerSamples', me.id)
  check(
    'the Labs self voice becomes a self mic sample (alias case), and the legacy table ends empty',
    conv.converted === 1 && conv.deleted === 1 && selfSamples.length === 1 && selfSamples[0].via === 'legacy' && selfSamples[0].channel === 'mic' && count('voiceprints') === 0,
    { conv, samples: selfSamples.length }
  )
  check('a second conversion is a no-op', JSON.stringify(k('convertLegacyVoiceprints', { aliasModelId: null })) === JSON.stringify({ converted: 0, deleted: 0 }))
  check('movedFromLabs still reads true after the legacy rows are gone', k('speakerVoiceSummary', { modelId: null }).movedFromLabs === true)

  // The agreement guard, exact centroids and the cap. Samples of anyone else need Recognize voices on.
  k('setSettingRaw', 'speakers.voices', true)
  const ana = k('createSpeakerPerson', { displayName: 'Ana Souza', email: 'Ana@Example.test' })
  const bruno = k('createSpeakerPerson', { displayName: 'Bruno', email: null })
  check('a person keeps a lower-cased email; a taken email is refused', ana.email === 'ana@example.test' && /invalid-input/.test(kFails('createSpeakerPerson', { displayName: 'Other', email: 'ana@example.test' })))
  check('no sample for a non-self person without an active agreement, refused by the repo', k('addSpeakerExemplar', ex(ana.id)).status === 'refused-no-agreement' && count('speaker_exemplars') === 1)
  check(
    'the user needs no agreement, and has mic samples only',
    k('addSpeakerExemplar', ex(me.id, { channel: 'mic', modelId: 'resnet-sha', vector: Float32Array.from(unit(legacyVector)) })).status === 'added' && /invalid-input/.test(kFails('addSpeakerExemplar', ex(me.id)))
  )
  k('setSettingRaw', 'speakers.selfVoice', false)
  const selfOff = k('addSpeakerExemplar', ex(me.id, { channel: 'mic', modelId: 'resnet-sha', vector: Float32Array.from(unit(legacyVector)), via: 'passive' }))
  k('setSettingRaw', 'speakers.selfVoice', true)
  check('with Recognize my voice off the repo refuses a sample of the user', selfOff.status === 'refused-off' && k('listSpeakerSamples', me.id).length === 2, selfOff)
  agree(ana.id)
  k('addSpeakerExemplar', ex(ana.id, { weight: 1 }))
  k('addSpeakerExemplar', ex(ana.id, { weight: 0.5 }))
  const before3 = space(ana.id)
  k('addSpeakerExemplar', ex(ana.id, { weight: 0.25, vector: vec() }))
  const after3 = space(ana.id)
  const mOld = mean(before3.exemplars)
  const wSum = after3.exemplars.reduce((s, e) => s + e.weight, 0)
  const stored3 = after3.exemplars.find((e) => e.weight === 0.25).vector
  const pulled = mOld.map((x, i) => x + (0.25 / wSum) * (stored3[i] - x))
  check('one confirmation moves the un-normalized weighted mean exactly w/Σw toward it', close(mean(after3.exemplars), pulled))
  check('the centroid is the L2-normalized weighted mean of the current samples', close(Array.from(after3.centroid), unit(mean(after3.exemplars))) && after3.count === 3)
  for (let i = 0; i < 13; i++) k('addSpeakerExemplar', ex(ana.id))
  const atCap = space(ana.id)
  const closest = atCap.exemplars.reduce(
    (best, e) => {
      const d = e.vector.reduce((s, x, i) => s + x * atCap.centroid[i], 0)
      return d > best.d ? { id: e.id, d } : best
    },
    { id: null, d: -Infinity }
  )
  const cappedAdd = k('addSpeakerExemplar', ex(ana.id, { vector: vec() }))
  const afterCap = space(ana.id)
  check(
    'at the cap of 16 a new sample replaces the one closest to the centroid',
    atCap.count === 16 && cappedAdd.status === 'added' && cappedAdd.replacedId === closest.id && afterCap.count === 16 && !afterCap.exemplars.some((e) => e.id === closest.id)
  )
  check('the centroid stays exact after a replacement', close(Array.from(afterCap.centroid), unit(mean(afterCap.exemplars))))
  for (let i = 0; i < 24; i++) k('addSpeakerExemplar', ex(ana.id))
  check('the cap holds after 40 confirmations', space(ana.id).count === 16 && k('listSpeakerSamples', ana.id).length === 16)
  check(
    'the far-from-profile check skips a sample and counts it',
    k('addSpeakerExemplar', ex(ana.id, { farCosine: 0.9999 })).status === 'skipped-far' && k('getSpeakerPerson', ana.id).skippedSamples === 1 && space(ana.id).count === 16
  )

  // A merge into the user never takes someone else's voice data.
  const dan = k('createSpeakerPerson', { displayName: 'Dan', email: null })
  agree(dan.id)
  check(
    'a merge into the user is refused while the other person has an agreement record (preview too)',
    /invalid-input/.test(kFails('mergeSpeakerPeople', { fromId: dan.id, intoId: me.id })) && /invalid-input/.test(kFails('previewSpeakerMerge', { fromId: dan.id, intoId: me.id }))
  )
  const fay = k('createSpeakerPerson', { displayName: 'Fay', email: null })
  k('mergeSpeakerPeople', { fromId: fay.id, intoId: me.id })
  check('a merge into the user of a person with no voice data is allowed', k('getSpeakerPerson', fay.id).mergedInto === me.id && k('listSpeakerSamples', me.id).length === 2)

  // A merge moves everything and applies the cap again.
  agree(bruno.id)
  for (let i = 0; i < 6; i++) k('addSpeakerExemplar', ex(bruno.id))
  const mergeNote = k('createNote', { origin: 'unknown', title: 'A call with Bruno', created_via: 'Windows' }).id
  k('recordSpeakerMatches', [{ noteId: mergeNote, personId: bruno.id, kind: 'confirmed' }])
  k('addSpeakerNegative', { noteId: mergeNote, passId: 'p1', identityKey: 'r:p1:r1', personId: bruno.id })
  const preview = k('previewSpeakerMerge', { fromId: bruno.id, intoId: ana.id })
  check('the merge preview counts the samples the cap removes, the agreements and the meetings', preview.samplesRemoved === 6 && preview.agreementsMoved === 1 && preview.meetingsMoved === 1, preview)
  const merged = k('mergeSpeakerPeople', { fromId: bruno.id, intoId: ana.id })
  const anaAgreements = raw((db) => db.prepare(`SELECT revoked_at FROM speaker_agreements WHERE person_id = ?`).all(ana.id))
  check(
    'after a merge the survivor holds at most 16 per space; matches, negatives and agreements moved, one record active',
    merged.samplesRemoved === 6 && space(ana.id).count === 16 && k('getSpeakerPerson', bruno.id).mergedInto === ana.id &&
      k('listSpeakerMatches', ana.id).length === 1 && k('listSpeakerNegatives', mergeNote)[0]?.personId === ana.id &&
      anaAgreements.length === 2 && anaAgreements.filter((a) => a.revoked_at === null).length === 1,
    { merged, agreements: anaAgreements.length }
  )
  check('a merged id resolves to the survivor', k('getSpeakerPerson', bruno.id, { resolveMerged: true })?.id === ana.id && !k('listSpeakerPeople', { limit: 50 }).some((p) => p.id === bruno.id))
  check(
    'the person view shows a remembered voice and its agreement',
    (() => {
      const view = k('speakerPersonView', { personId: ana.id, modelId: 'model-a' })
      return view.voice.state === 'remembered' && !view.voice.stale && view.agreement?.method === 'email' && view.agreement.hasEvidence && view.canDelete === false && typeof view.voice.expiresAt === 'string'
    })()
  )
  check('with another installed model the voice reads stale', k('speakerPersonView', { personId: ana.id, modelId: 'model-b' }).voice.state === 'stale')

  // Cluster vectors, negatives and pending requests of a note; the trash paths.
  const tNote = k('createNote', { origin: 'unknown', title: 'Trash me', created_via: 'Windows' }).id
  const cv = (noteId, label, extra = {}) => ({ noteId, passId: 'p1', source: 'system', label, modelId: 'model-a', vector: vec(), speechMs: 40_000, cleanMs: 35_000, ...extra })
  const carla = k('createSpeakerPerson', { displayName: 'Carla', email: null })
  k('setSettingRaw', 'speakers.voices', false)
  check('with Recognize voices off the repo refuses a sample of an agreed person', k('addSpeakerExemplar', ex(ana.id)).status === 'refused-off')
  k('saveSpeakerClusterVectors', [cv(tNote, 'r1')])
  check('no cluster vector is stored while Recognize voices is off (its default)', count('speaker_cluster_vectors') === 0)
  check('a pending request needs a note that holds a vector', /invalid-input/.test(kFails('addSpeakerPending', { personId: carla.id, noteId: tNote, startMs: 1_000, endMs: 9_000 })))
  k('setSettingRaw', 'speakers.voices', true)
  k('saveSpeakerClusterVectors', [cv(tNote, 'r1'), cv(tNote, 'r2')])
  k('addSpeakerPending', { personId: carla.id, noteId: tNote, startMs: 1_000, endMs: 9_000, source: 'system' })
  check(
    'a request keeps its channel, and a bad channel is refused',
    k('listSpeakerPending', { noteId: tNote })[0]?.source === 'system' && /invalid-input/.test(kFails('addSpeakerPending', { personId: carla.id, noteId: tNote, startMs: 0, endMs: 1, source: 'video' }))
  )
  /** A suggestion row waiting on a request, and its flag as stored. */
  const pendingGuess = (noteId, identityKey = 'r:p1:r1') =>
    k('replaceSpeakerNameSuggestions', noteId, [
      { identityKey, label: 'Speaker A', name: null, evidenceTypes: [], channel: 'system', labelStream: 'reconciled', transcriptExcerpts: [], position: 0, band: 'none', candidates: [], passId: 'p1', pending: true }
    ])
  const flag = (noteId) => k('listSpeakerNameSuggestions', noteId).map((r) => r.pending).join()
  pendingGuess(tNote)
  check('cluster vectors are stored per note and pass', k('listSpeakerClusterVectors', { noteId: tNote }).length === 2 && k('notesWithSpeakerClusterVectors', { modelId: 'model-a' }).includes(tNote))
  check(
    'the person view lists the pending meeting (no agreement: not nameable yet)',
    (() => {
      const v = k('speakerPersonView', { personId: carla.id, modelId: 'model-a' })
      return v.voice.state === 'pending' && v.pending.length === 1 && v.pending[0].canName === false
    })()
  )
  k('trashNote', tNote)
  check("the user's trash secure-deletes the note's cluster vectors and drops its pending requests", k('listSpeakerClusterVectors', { noteId: tNote }).length === 0 && k('listSpeakerPending', { noteId: tNote }).length === 0)
  check('and clears the pending flag on its suggestion row, which a restore keeps', flag(tNote) === 'false')
  k('restoreNote', tNote)
  check('restoring the note from Trash brings back no vectors', k('listSpeakerClusterVectors', { noteId: tNote }).length === 0)
  k('saveSpeakerClusterVectors', [cv(tNote, 'r1')])
  k('markNoteDeleted', tNote)
  check('the auto-delete path deletes them too', count('speaker_cluster_vectors') === 0)
  k('saveSpeakerClusterVectors', [cv(tNote, 'r3')])
  check('a trashed note keeps no new vectors', count('speaker_cluster_vectors') === 0)

  // A dropped request clears the flag: Forget, the API delete, the sweep backstop.
  const pNote = k('createNote', { origin: 'unknown', title: 'Pending', created_via: 'Windows' }).id
  k('saveSpeakerClusterVectors', [cv(pNote, 'r1')])
  k('addSpeakerPending', { personId: carla.id, noteId: pNote, startMs: 0, endMs: 4_000 })
  check('a request stored without a channel reads null', k('listSpeakerPending', { noteId: pNote })[0]?.source === null)
  pendingGuess(pNote)
  check(
    "Forget drops the person's requests, clears their notes' pending flags and deletes those notes' cluster vectors",
    k('forgetSpeakerVoice', { personId: carla.id, via: 'forget' }).pending === 1 && flag(pNote) === 'false' && k('listSpeakerClusterVectors', { noteId: pNote }).length === 0
  )
  k('saveSpeakerClusterVectors', [cv(pNote, 'r1')])
  const req = k('addSpeakerPending', { personId: carla.id, noteId: pNote, startMs: 0, endMs: 4_000 })
  pendingGuess(pNote)
  check('deleting a request clears the flag once the note holds none', k('deleteSpeakerPending', [req.id]) === 1 && flag(pNote) === 'false')
  k('addSpeakerPending', { personId: carla.id, noteId: pNote, startMs: 0, endMs: 4_000 })
  pendingGuess(pNote)
  k('deleteSpeakerClusterVectors', { noteId: pNote, passId: 'p1' })
  check('a per-pass delete leaves the request to its caller', k('listSpeakerPending', { noteId: pNote }).length === 1)
  k('sweepSpeakerData', { now: new Date().toISOString() })
  check('the sweep drops a request whose note holds no vector, and clears its flag', k('listSpeakerPending', { noteId: pNote }).length === 0 && flag(pNote) === 'false')
  k('saveSpeakerClusterVectors', [cv(pNote, 'r2')])
  k('setSettingRaw', 'speakers.voices', false)
  k('sweepSpeakerData', { now: new Date().toISOString() })
  check('with Recognize voices off the sweep deletes every leftover cluster vector', count('speaker_cluster_vectors') === 0)
  k('setSettingRaw', 'speakers.voices', true)

  // The source-note merge is a third trash path.
  const sKeep = k('createNote', { origin: 'unknown', title: 'A video', created_via: 'Windows' }).id
  await sleep(5)
  const sDrop = k('createNote', { origin: 'unknown', title: 'A video, again', created_via: 'Windows' }).id
  const vsrc = (noteId) => ({
    note_id: noteId, kind: 'video', provider: 'youtube', canonical_key: 'youtube:voices', url: 'https://www.youtube.com/watch?v=voices', title: 'A video', channel: 'c',
    duration_ms: 600_000, confidence: 'exact', detected_via: 'media-session'
  })
  k('createNoteSource', vsrc(sKeep))
  k('createNoteSource', vsrc(sDrop))
  k('saveSpeakerClusterVectors', [cv(sDrop, 'r1'), cv(sKeep, 'r1')])
  k('addSpeakerPending', { personId: carla.id, noteId: sDrop, startMs: 0, endMs: 4_000 })
  pendingGuess(sDrop, 'r:p9:r1')
  const sMerge = k('mergeSourceNotes', { noteIds: [sKeep, sDrop] })
  check(
    'a source-note merge leaves no cluster vector or request on the trashed note, and the moved suggestion row waits on nothing',
    sMerge.trashedNoteId === sDrop && k('listSpeakerClusterVectors', { noteId: sDrop }).length === 0 && k('listSpeakerPending', { noteId: sDrop }).length === 0 &&
      k('listSpeakerClusterVectors', { noteId: sKeep }).length === 1 && flag(sKeep) === 'false',
    sMerge
  )

  // The transcript retention purge keeps the note row, so it deletes these rows itself.
  const [rn] = seededNotes
  k('saveSpeakerClusterVectors', [cv(rn, 'r1')])
  k('addSpeakerNegative', { noteId: rn, passId: 'p1', identityKey: 'r:p1:r1', personId: carla.id })
  k('recordSpeakerMatches', [{ noteId: rn, personId: carla.id, kind: 'auto_app' }])
  k('addSpeakerPending', { personId: carla.id, noteId: rn, startMs: 0, endMs: 5_000 })
  const others = raw((db) => db.prepare(`SELECT id FROM documents WHERE id <> ?`).all(rn).map((row) => row.id))
  const purged = k('purgeTranscripts', { olderThan: new Date(Date.now() + 60_000).toISOString(), skipNoteIds: others, batch: 1 })
  check(
    "the retention purge deletes the note's cluster vectors, negatives, match rows and pending requests",
    purged.noteIds.includes(rn) && !!k('getNote', rn) && k('listSpeakerClusterVectors', { noteId: rn }).length === 0 && k('listSpeakerNegatives', rn).length === 0 &&
      k('listSpeakerPending', { noteId: rn }).length === 0 && !k('listSpeakerMatches', carla.id).some((x) => x.noteId === rn),
    purged
  )

  // Negatives follow a re-pass.
  const nNote = k('createNote', { origin: 'unknown', title: 'Negatives', created_via: 'Windows' }).id
  k('addSpeakerNegative', { noteId: nNote, passId: 'p1', identityKey: 'r:p1:r1', personId: ana.id })
  k('addSpeakerNegative', { noteId: nNote, passId: 'p1', identityKey: 'r:p1:r2', personId: carla.id })
  k('remapSpeakerNegatives', { noteId: nNote, passId: 'p2', map: [{ from: 'r:p1:r1', to: 'r:p2:r3' }, { from: 'r:p1:r2', to: null }] })
  const negs = k('listSpeakerNegatives', nNote)
  check('a re-pass re-maps a negative to its successor and drops one without', negs.length === 1 && negs[0].identityKey === 'r:p2:r3' && negs[0].passId === 'p2' && negs[0].personId === ana.id)

  // Exports: the encrypted copy clears the voice tables and keeps agreements; the decrypted copy drops five.
  k('saveSpeakerClusterVectors', [cv(nNote, 'r1')])
  k('saveVoiceprint', { id: randomUUID(), model_id: 'wespeaker-en-voxceleb-resnet34', centroids: [{ vector: legacyVector, totalSpeechMs: 30_000, updatedAt: at(0) }], total_speech_ms: 30_000, updated_at: at(0) })
  const exportRoot = join(scratch, 'Notula export 2026-10-29 10.00')
  mkdirSync(exportRoot, { recursive: true })
  const localState = join(dirname(dataDir), 'Local State')
  const enc = k('writeDatabaseCopy', { root: exportRoot, kind: 'encrypted', localStatePath: localState })
  const dec = k('writeDatabaseCopy', { root: exportRoot, kind: 'decrypted', localStatePath: localState })
  const VOICE_TABLES = ['speaker_exemplars', 'speaker_voice_spaces', 'speaker_cluster_vectors', 'voiceprints', 'speaker_agreements', 'speaker_negatives', 'speaker_people']
  const tallies = (db) => Object.fromEntries(VOICE_TABLES.map((t) => [t, db.prepare(`SELECT count(*) AS n FROM ${t}`).get().n]))
  const live = raw(tallies)
  const encDb = openRaw(join(exportRoot, 'database', 'notula.db'), keyHex, { readonly: true })
  const encT = tallies(encDb)
  const encOk = encDb.pragma('integrity_check', { simple: true })
  encDb.close()
  check('the encrypted export is one encrypted file (VACUUM INTO), no raw WAL copy', enc.files.includes('database/notula.db') && !existsSync(join(exportRoot, 'database', 'notula.db-wal')) && encOk === 'ok', enc.files)
  check(
    'the encrypted export has no sample, voice space, cluster vector or legacy row, and keeps agreements and negatives',
    live.speaker_exemplars > 0 && live.speaker_cluster_vectors > 0 && live.voiceprints > 0 && encT.speaker_exemplars === 0 && encT.speaker_voice_spaces === 0 &&
      encT.speaker_cluster_vectors === 0 && encT.voiceprints === 0 && encT.speaker_agreements === live.speaker_agreements && encT.speaker_negatives === live.speaker_negatives &&
      encT.speaker_people === live.speaker_people,
    { live, encrypted: encT }
  )
  const decDb = new Database(join(exportRoot, 'database', 'notula-decrypted.db'), { readonly: true, fileMustExist: true })
  const decT = tallies(decDb)
  decDb.close()
  check(
    'the decrypted export drops the five tables (and the legacy one), and keeps the people',
    dec.files.includes('database/notula-decrypted.db') && decT.speaker_exemplars === 0 && decT.speaker_voice_spaces === 0 && decT.speaker_cluster_vectors === 0 && decT.voiceprints === 0 &&
      decT.speaker_agreements === 0 && decT.speaker_negatives === 0 && decT.speaker_people === live.speaker_people,
    decT
  )

  // Forget leaves no copy of a sample, free pages included (a decrypted byte copy of the file).
  const anaBytes = Buffer.from(space(ana.id).exemplars[0].vector.buffer)
  // Before: a checkpoint puts the sample in the main file, to prove the scan finds it. After a
  // Forget: no checkpoint of our own, so the WAL must already be empty (Forget's TRUNCATE).
  const walBytes = () => (existsSync(join(dataDir, 'notula.db-wal')) ? statSync(join(dataDir, 'notula.db-wal')).size : 0)
  const scan = (label, sample, { checkpoint = false } = {}) => {
    if (checkpoint) sx.call('checkpoint')
    const copy = join(scratch, `scan-${label}.db`)
    cpSync(join(dataDir, 'notula.db'), copy)
    const rw = openRaw(copy, keyHex)
    rw.pragma(`rekey = ''`)
    rw.close()
    return readFileSync(copy).includes(sample)
  }
  check('the scan of a decrypted copy finds a stored sample before Forget (the scan works)', scan('before', anaBytes, { checkpoint: true }))
  check('an active agreement record cannot be removed', /invalid-input/.test(kFails('deleteSpeakerAgreement', ana.id)))
  const forgot = k('forgetSpeakerVoice', { personId: ana.id, via: 'withdrawn' })
  const anaAfter = k('speakerPersonView', { personId: ana.id, modelId: 'model-a' })
  check(
    'Forget removes every sample and voice space of the person and stamps the record; the person and match rows stay',
    forgot.exemplars === 16 && forgot.spaces === 1 && !space(ana.id) && anaAfter.voice.state === 'forgotten' && anaAfter.agreement?.revokedVia === 'withdrawn' && k('listSpeakerMatches', ana.id).length === 1,
    forgot
  )
  check('after Forget the WAL is empty and no page of the file holds the sample, free pages included', walBytes() === 0 && !scan('after', anaBytes))
  check('remembering the voice again needs a new agreement', k('addSpeakerExemplar', ex(ana.id)).status === 'refused-no-agreement')
  k('deleteSpeakerAgreement', ana.id)
  check('Remove record deletes the revoked records', k('getSpeakerAgreement', ana.id) === null)

  // Forget also deletes the cluster vectors of every note the person was named in or asked about:
  // the job keeps an automatic name's vector, and a request points at the one the user picked.
  const lia = k('createSpeakerPerson', { displayName: 'Lia', email: null })
  agree(lia.id)
  const fNamed = k('createNote', { origin: 'unknown', title: 'Named by voice', created_via: 'Windows' }).id
  const fAsked = k('createNote', { origin: 'unknown', title: 'Asked first', created_via: 'Windows' }).id
  const fOther = k('createNote', { origin: 'unknown', title: 'Someone else', created_via: 'Windows' }).id
  k('saveSpeakerClusterVectors', [cv(fNamed, 'r1'), cv(fNamed, 'r2'), cv(fAsked, 'r1'), cv(fOther, 'r1')])
  k('recordSpeakerMatches', [{ noteId: fNamed, personId: lia.id, kind: 'auto_voice' }])
  k('addSpeakerPending', { personId: lia.id, noteId: fAsked, startMs: 0, endMs: 4_000 })
  k('addSpeakerPending', { personId: carla.id, noteId: fNamed, startMs: 0, endMs: 4_000 })
  k('addSpeakerPending', { personId: carla.id, noteId: fOther, startMs: 0, endMs: 4_000 })
  pendingGuess(fNamed)
  const liaBytes = Buffer.from(k('listSpeakerClusterVectors', { noteId: fNamed })[0].vector.buffer)
  check('the scan finds a cluster vector before Forget', scan('before-cluster', liaBytes, { checkpoint: true }))
  const liaForgot = k('forgetSpeakerVoice', { personId: lia.id, via: 'withdrawn' })
  check(
    'Forget deletes the cluster vectors of the notes the person was named in or asked about, and no others',
    liaForgot.clusterVectors === 3 && k('listSpeakerClusterVectors', { noteId: fNamed }).length === 0 && k('listSpeakerClusterVectors', { noteId: fAsked }).length === 0 &&
      k('listSpeakerClusterVectors', { noteId: fOther }).length === 1,
    liaForgot
  )
  check(
    "another person's request on those notes ends with the vectors and clears its flag; one elsewhere stays",
    k('listSpeakerPending', { noteId: fNamed }).length === 0 && flag(fNamed) === 'false' && k('listSpeakerPending', { noteId: fOther }).length === 1
  )
  check('after that Forget the WAL is empty and no page of the file holds the cluster vector', walBytes() === 0 && !scan('after-cluster', liaBytes))

  // Never blended across model ids.
  agree(ana.id)
  k('addSpeakerExemplar', ex(ana.id, { modelId: 'model-a' }))
  k('addSpeakerExemplar', ex(ana.id, { modelId: 'model-b' }))
  check("a sample of a new model never blends with the old one; the old model's samples go", !space(ana.id, 'model-a') && space(ana.id, 'model-b')?.count === 1 && k('listSpeakerSamples', ana.id).length === 1)
  check('a vector of another dimension for the same model is refused', /dimension/.test(kFails('addSpeakerExemplar', ex(ana.id, { modelId: 'model-b', vector: new Float32Array([1, 0, 0]) }))))

  // The sweeps.
  const swNote = k('createNote', { origin: 'unknown', title: 'Sweep', created_via: 'Windows' }).id
  k('saveSpeakerClusterVectors', [cv(swNote, 'r1'), cv(swNote, 'r2', { modelId: 'model-b' })])
  const swept0 = k('sweepSpeakerData', { now: new Date().toISOString(), modelId: 'model-b' })
  check('the sweep deletes cluster vectors of another model at once', swept0.clusterVectors >= 1 && k('listSpeakerClusterVectors', { noteId: swNote }).map((v) => v.modelId).join() === 'model-b')
  const swept14 = k('sweepSpeakerData', { now: new Date(Date.now() + 15 * 86_400_000).toISOString() })
  check('the sweep deletes cluster vectors past 14 days', swept14.clusterVectors === 1 && k('listSpeakerClusterVectors', { noteId: swNote }).length === 0 && swept14.peopleExpired.length === 0)
  const swept365 = k('sweepSpeakerData', { now: new Date(Date.now() + 366 * 86_400_000).toISOString() })
  check(
    'a voice not recognized for 365 days is forgotten and its record stamped expired (self included)',
    swept365.peopleExpired.includes(ana.id) && swept365.peopleExpired.includes(me.id) && k('getSpeakerAgreement', ana.id)?.revokedVia === 'expired' && k('listSpeakerSamples', me.id).length === 0,
    swept365
  )

  // An agreement with no sample yet expires on its own clock.
  const iris = k('createSpeakerPerson', { displayName: 'Iris', email: null })
  agree(iris.id)
  const withAgreement = k('speakerVoiceSummary', { modelId: null }).peopleWithAgreement
  const swept14i = k('sweepSpeakerData', { now: new Date(Date.now() + 15 * 86_400_000).toISOString() })
  const swept365i = k('sweepSpeakerData', { now: new Date(Date.now() + 366 * 86_400_000).toISOString() })
  check(
    'an agreement with no sample is counted, kept for now, and expired after 365 days without a recognition',
    withAgreement === 1 && !swept14i.peopleExpired.includes(iris.id) && swept365i.peopleExpired.includes(iris.id) && k('getSpeakerAgreement', iris.id)?.revokedVia === 'expired' &&
      k('speakerVoiceSummary', { modelId: null }).peopleWithAgreement === 0,
    { withAgreement, swept365i }
  )

  // A merge never revives a voice withdrawn after the surviving record.
  const jo = k('createSpeakerPerson', { displayName: 'Jo', email: null })
  const joS = k('createSpeakerPerson', { displayName: 'Jo Silva', email: null })
  agree(jo.id)
  k('addSpeakerExemplar', ex(jo.id))
  await sleep(5)
  agree(joS.id)
  await sleep(5)
  k('forgetSpeakerVoice', { personId: joS.id, via: 'withdrawn' })
  const joNote = k('createNote', { origin: 'unknown', title: 'Jo Silva named by voice', created_via: 'Windows' }).id
  k('saveSpeakerClusterVectors', [cv(joNote, 'r1')])
  k('recordSpeakerMatches', [{ noteId: joNote, personId: joS.id, kind: 'auto_voice' }])
  const joPreview = k('previewSpeakerMerge', { fromId: joS.id, intoId: jo.id })
  k('mergeSpeakerPeople', { fromId: joS.id, intoId: jo.id })
  check('a merge that forgets a withdrawn voice deletes the cluster vectors of the notes it was named in', k('listSpeakerClusterVectors', { noteId: joNote }).length === 0)
  const joRecords = k('listSpeakerAgreements', jo.id)
  check(
    'the preview says the voice is forgotten; the merge forgets it and stamps the surviving record withdrawn',
    typeof joPreview.withdrawnAt === 'string' && joPreview.samplesRemoved === 0 && k('listSpeakerSamples', jo.id).length === 0 && !space(jo.id) &&
      k('getSpeakerAgreement', jo.id)?.revokedVia === 'withdrawn' && k('addSpeakerExemplar', ex(jo.id)).status === 'refused-no-agreement',
    joPreview
  )
  check('every record of a person is listed, newest first', joRecords.length === 2 && joRecords[0].attestedAt >= joRecords[1].attestedAt && joRecords.every((a) => a.personId === jo.id))
  const kim = k('createSpeakerPerson', { displayName: 'Kim', email: null })
  const kimB = k('createSpeakerPerson', { displayName: 'Kim B.', email: null })
  agree(kimB.id)
  k('forgetSpeakerVoice', { personId: kimB.id, via: 'withdrawn' })
  await sleep(5)
  agree(kim.id)
  k('addSpeakerExemplar', ex(kim.id))
  k('mergeSpeakerPeople', { fromId: kimB.id, intoId: kim.id })
  check('an agreement made after the withdrawal keeps the voice', k('listSpeakerSamples', kim.id).length === 1 && k('getSpeakerAgreement', kim.id)?.revokedAt === null)
  k('forgetSpeakerVoice', { personId: kim.id, via: 'forget' })

  // Forget all, with and without the user's own voice.
  agree(ana.id)
  k('addSpeakerExemplar', ex(ana.id))
  k('addSpeakerExemplar', ex(me.id, { channel: 'mic', modelId: 'model-a' }))
  k('saveSpeakerClusterVectors', [cv(nNote, 'r9')])
  const lastBytes = Buffer.from(space(ana.id).exemplars[0].vector.buffer)
  check('the scan finds the sample before Forget all', scan('before-all', lastBytes, { checkpoint: true }))
  const keptSelf = k('forgetAllSpeakerVoices', { keepSelf: true })
  check('after Forget all the WAL is empty and no page of the file holds the sample', walBytes() === 0 && !scan('after-all', lastBytes))
  check(
    "Forget all (keep my voice): every other voice, cluster vector, negative and pending request goes; the user's voice stays",
    keptSelf.exemplars === 1 && count('speaker_cluster_vectors') === 0 && count('speaker_negatives') === 0 && count('speaker_pending') === 0 && k('listSpeakerSamples', me.id).length === 1 &&
      k('getSpeakerAgreement', ana.id)?.revokedVia === 'forget_all',
    keptSelf
  )
  k('forgetAllSpeakerVoices', { keepSelf: false })
  check('Forget all: no rows left in the voice tables', count('speaker_exemplars') === 0 && count('speaker_voice_spaces') === 0 && count('speaker_cluster_vectors') === 0 && count('voiceprints') === 0)

  // Delete person, and the People list.
  check(
    'Delete person: refused while a record exists, allowed for a person with nothing',
    /invalid-input/.test(kFails('deleteSpeakerPerson', ana.id)) && kFails('deleteSpeakerPerson', carla.id) === '' && k('getSpeakerPerson', carla.id) === null
  )
  const gus = k('createSpeakerPerson', { displayName: 'Gus', email: null })
  const hal = k('createSpeakerPerson', { displayName: 'Hal', email: null })
  k('mergeSpeakerPeople', { fromId: hal.id, intoId: gus.id })
  check(
    'a merged row is never deleted on its own; deleting its survivor takes it along',
    /invalid-input/.test(kFails('deleteSpeakerPerson', hal.id)) && kFails('deleteSpeakerPerson', gus.id) === '' && k('getSpeakerPerson', hal.id) === null && k('getSpeakerPerson', gus.id) === null
  )
  const eve = k('createSpeakerPerson', { displayName: 'Eve', email: null })
  const peopleRows = k('listPeople', { filter: 'all', myEmails: [] })
  check(
    'the People list carries persisted people: by email, an email-less one as a p:<id> row, never the user twice',
    peopleRows.some((row) => row.personId === ana.id && row.email === 'ana@example.test') && peopleRows.some((row) => row.personId === eve.id && row.email === undefined) &&
      !peopleRows.some((row) => row.personId === me.id && !row.email)
  )
  check('the voice filter keeps only people with a remembered voice', k('listPeople', { filter: 'voice', myEmails: [] }).length === 0)
  check('no log line carries a vector or agreement text', !sx.logs.some((l) => /I agree|Hi, may I/.test(JSON.stringify(l)) || JSON.stringify(l.data ?? {}).length > 2_000))
  sx.call('close')
} catch (err) {
  check('the run completes', false, err instanceof Error ? err.stack : String(err))
} finally {
  for (const e of engines) e.close()
  if (!KEEP) rmSync(OUT, { recursive: true, force: true })
  else console.log(`kept ${OUT}`)
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
