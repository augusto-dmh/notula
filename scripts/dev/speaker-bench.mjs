// SPDX-License-Identifier: Apache-2.0
// The speaker benchmark: the gate for voice auto-naming. A dev-run
// benchmark, not a test suite: it never runs in the gate and has no committed fixtures. It
// drives the built app's replay feed (`NOTULA_DEV_SPEAKER_BENCH=1`, unpackaged builds only) on
// a scratch profile, reads the decisions back, and writes an aggregates-only report.
//
//   node scripts/dev/speaker-bench.mjs --dry                      synthetic tones end to end, the provider mock
//   node scripts/dev/speaker-bench.mjs setup                      the app's UI on the bench's label profile
//   node scripts/dev/speaker-bench.mjs label --manifest <m>       feeds unlabelled meetings for naming in the UI
//   node scripts/dev/speaker-bench.mjs export-labels --manifest <m>
//   node scripts/dev/speaker-bench.mjs run --manifest <m> --provider <p|none> [options]
//   node scripts/dev/speaker-bench.mjs compare-models --manifest <m>
//
// Options: --k <1..3> enrollment meetings per person (learning curve), --seed <n>, --no-t2,
// --no-t3, --t2-meetings <n>, --scenario-meetings <n>, --ffmpeg <path>, --home <dir> (bench home,
// outside the repo), --compare-models, --write-calibration (full runs only; never with --dry),
// --keep (keep the run's scratch profile).
//
// Everything is in scripts/dev/speaker-bench/README.md. `npm run build` first.

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { assertBuilt, linkModels, runApp } from './speaker-bench/electron.mjs'
import { composeStress, dryFixture, findFfmpeg, T3_VARIANTS, t2Variants } from './speaker-bench/fixtures.mjs'
import { assertPrivatePath, BENCH_DIR, loadManifest, ROOT } from './speaker-bench/manifest.mjs'
import { a1, clusterRows, coverageDrops, cpuSummary, derSummary, finalCalibration, micEchoSummary, fitCandidate, summarize, t2Summary, verification } from './speaker-bench/metrics.mjs'
import { compareModels } from './speaker-bench/models.mjs'
import { basePlan, BENCH_VERSION, benchSettings, feedMeeting, heldOutPeople, schedule } from './speaker-bench/protocol.mjs'
import { writeReport } from './speaker-bench/report.mjs'

const CALIBRATION = join(ROOT, 'resources', 'speakers', 'calibration.json')
const REPORTS = join(BENCH_DIR, 'reports')

function parseArgs(argv) {
  const a = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i]
    if (!x.startsWith('--')) a._.push(x)
    else if (['--dry', '--no-t2', '--no-t3', '--compare-models', '--write-calibration', '--keep', '--all'].includes(x)) a[x.slice(2)] = true
    else a[x.slice(2)] = argv[++i]
  }
  return a
}

const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)

function benchHome(args) {
  const home = resolve(args.home ?? join(process.env.LOCALAPPDATA ?? process.env.HOME ?? '.', 'notula-speaker-bench'))
  assertPrivatePath(home, 'The bench home')
  mkdirSync(home, { recursive: true })
  return home
}

/**
 * `--provider <file>`: `{settings: {"llm.provider": …, "llm.anthropic.model": …}, secret: {id: "llm.anthropic", env: "NOTULA_BENCH_LLM_KEY"}}`.
 * `--provider none`: no provider configured (a local provider with no model), so the LLM step is
 * skipped, with no request. Scenario injection still swaps the mock in and restores this.
 */
function providerConfig(args) {
  if (!args.provider) throw new Error('The LLM step uses your configured provider for every set: pass --provider <file>, or --provider none to skip it (see the README).')
  if (args.provider === 'none') return { settings: { 'llm.provider': 'local', 'llm.local.model': '' }, secret: null, none: true }
  assertPrivatePath(args.provider, 'The provider file')
  const p = JSON.parse(readFileSync(args.provider, 'utf8'))
  if (p.secret && !process.env[p.secret.env]) throw new Error(`Set ${p.secret.env} to the provider key (it is read by the app, never stored by the bench).`)
  return { settings: p.settings ?? {}, secret: p.secret ?? null }
}

function log(line) {
  process.stdout.write(`[speaker-bench] ${line}\n`)
}

// ---------- run (and --dry) ----------

async function run(args) {
  const dry = !!args.dry
  if (dry && args['write-calibration']) throw new Error('--dry never writes calibration.json.')
  assertBuilt()
  const seed = Number(args.seed ?? 1)
  const k = Math.min(3, Math.max(1, Number(args.k ?? (dry ? 1 : 3))))
  const runId = `${dry ? 'dry' : 'run'}-${stamp()}`
  const publicRun = join(BENCH_DIR, 'runs', runId)
  // Real runs keep their profile and per-cluster files outside the repo; composed fixtures go to the git-ignored folder.
  const privateRun = dry ? publicRun : join(benchHome(args), 'runs', runId)
  const profile = join(privateRun, 'profile')
  mkdirSync(privateRun, { recursive: true })
  mkdirSync(publicRun, { recursive: true })
  const calibrationBefore = sha256(CALIBRATION)
  const shipped = JSON.parse(readFileSync(CALIBRATION, 'utf8'))

  const manifest = dry ? dryFixture(join(publicRun, 'fixtures')) : loadManifest(args.manifest)
  const provider = dry ? { settings: {}, secret: null } : providerConfig(args)
  if (!dry) linkModels(profile, join(benchHome(args), 'models'))
  const ffmpeg = findFfmpeg(args.ffmpeg)
  const notes = []
  if (dry) notes.push('Synthetic tones, no voice: on a machine without the speech models the feed runs without a session (no download), so no pass and no cluster exist; the stages still run end to end.')
  if (provider.none) notes.push('No LLM (--provider none): the LLM step is skipped, so the llm and fused sets hold no conversation evidence. The scenarios that inject a reply (A6, A7) still use the mock.')

  const labelled = manifest.meetings.filter((m) => m.labels.length)
  for (const m of manifest.meetings) if (!m.labels.length) notes.push(`Meeting ${m.id} has no labels and is skipped (label it first).`)
  const heldOut = heldOutPeople(manifest, { seed })
  const sched = schedule(labelled, { k, heldOut })

  // T2 replays and T3 mixtures, composed into the run's git-ignored folder.
  const t2 = []
  if (!args['no-t2']) {
    const withStream = labelled.filter((m) => m.uia).slice(0, Number(args['t2-meetings'] ?? (dry ? 1 : 1e9)))
    for (const m of withStream) {
      const lags = dry ? [0, 1_500, 3_000] : undefined
      for (const v of t2Variants(m.uia.path, join(publicRun, 'fixtures', 't2'), { seed, ...(lags ? { lags } : {}) })) {
        t2.push({ tag: `t2:${m.id}:${v.variant}`, meeting: feedMeeting(m, { id: `${m.id}`, uia: { app: m.uia.app, path: v.path } }) })
      }
    }
  }
  let t3 = { people: [], meetings: [], skipped: 'off (--no-t3)' }
  if (!args['no-t3']) {
    const variants = dry ? T3_VARIANTS.filter((v) => v.name === 'overlap0' || v.name === 'overlap30' || (ffmpeg && v.name === 'opus12-both')) : T3_VARIANTS
    t3 = composeStress(manifest, join(publicRun, 'fixtures', 't3'), { ffmpeg, variants, meetingMs: dry ? 6_000 : 60_000, seed, dry })
  }
  const people = [...manifest.people.map(({ id, name, email, self }) => ({ id, name, email, ...(self ? { self: true } : {}) })), ...t3.people]
  const meetingsById = new Map([...labelled, ...t3.meetings].map((m) => [m.id, m]))
  const ctx = {
    meetingOfTag: (tag) => meetingsById.get(tag.startsWith('t2:') ? tag.split(':')[1] : tag.split('~')[0]),
    enrolledIn: {},
    heldOut,
    selfId: manifest.people.find((p) => p.self)?.id ?? null
  }
  for (const [p, ms] of Object.entries(sched.enrolledIn)) ctx.enrolledIn[p] = ms
  for (const m of t3.meetings) if (m.role === 'enroll') for (const p of m.attendees) (ctx.enrolledIn[p] ??= []).push(m.id)

  const settings = { ...benchSettings(manifest), ...provider.settings }
  const common = { runId, dry, manifest, people, settings, secret: provider.secret, mockProvider: dry }

  // Launch 1: the baseline meetings in order (with the protocol's confirmations), T2, T3.
  log(`launch 1: ${sched.meetings.length} meetings, ${t2.length} T2 replays, ${t3.meetings.length} T3 meetings (real time)`)
  const steps1 = [
    ...sched.meetings.map(({ meeting, enroll }) => ({ kind: 'feed', tag: meeting.id, meeting: feedMeeting(meeting), enroll })),
    ...t2.map((x) => ({ kind: 'feed', tag: x.tag, meeting: x.meeting })),
    ...t3.meetings.map((m) => ({ kind: 'feed', tag: m.id, meeting: feedMeeting(m), enroll: m.role === 'enroll' ? m.attendees : [] }))
  ]
  const r1 = await runApp({
    profile,
    planPath: join(privateRun, 'plan-1.json'),
    logPath: join(privateRun, 'app.log'),
    plan: basePlan({ ...common, resultsPath: join(privateRun, 'results-1.json'), steps: steps1 })
  })
  const feedStarts = Object.fromEntries(r1.feeds.map((f) => [f.noteId, f.feedStartMs]))
  const noteOf = new Map(r1.feeds.map((f) => [f.tag, f.noteId]))
  const enrolledNotes = {}
  for (const [p, ms] of Object.entries(ctx.enrolledIn)) enrolledNotes[p] = ms.map((m) => noteOf.get(m)).filter(Boolean)
  const evalNotes = r1.feeds
    .filter((f) => !f.tag.startsWith('t2:'))
    .map((f) => ({ tag: f.tag, noteId: f.noteId, labels: ctx.meetingOfTag(f.tag)?.labels ?? [], composed: !!ctx.meetingOfTag(f.tag)?.composed }))
  const later = { ...common, enrolled: enrolledNotes, feedStarts }
  const ks = Array.from({ length: k }, (_, i) => i + 1)

  // Launch 2: the production `decide` on every stored pass, under the shipped file; the voice scores.
  log('launch 2: evaluate under the shipped calibration')
  const r2 = await runApp({
    profile,
    planPath: join(privateRun, 'plan-2.json'),
    logPath: join(privateRun, 'app.log'),
    plan: basePlan({ ...later, resultsPath: join(privateRun, 'results-2.json'), steps: [{ kind: 'evaluate', tag: 'shipped', notes: evalNotes, ks }] })
  })
  const rows2 = clusterRows(r2.evaluations[0], ctx)
  const fitted = fitCandidate(rows2, shipped, { modelId: r1.modelId, seed, createdAt: new Date().toISOString() })
  const candidatePath = join(privateRun, 'calibration.candidate-eval.json')
  writeFileSync(candidatePath, JSON.stringify(fitted.file, null, 1))

  // Launch 3: the same under the fitted candidate (would-be autos), then the A1–A16 scenario phase.
  log('launch 3: evaluate under the fitted candidate, then the scenario phase')
  const testNotes = evalNotes.filter((n) => !n.composed)
  const refeed = labelled.slice(0, Number(args['scenario-meetings'] ?? (dry ? 1 : 2))).map((m) => ({ tag: m.id, meeting: feedMeeting(m) }))
  const heldOutEnroll = heldOut
    .map((p) => {
      const m = labelled.find((x) => x.labels.some((l) => l.person === p))
      return m && noteOf.get(m.id) ? { person: p, meeting: m.id, noteId: noteOf.get(m.id), labels: m.labels } : null
    })
    .filter(Boolean)
  const r3 = await runApp({
    profile,
    planPath: join(privateRun, 'plan-3.json'),
    logPath: join(privateRun, 'app.log'),
    plan: basePlan({
      ...later,
      resultsPath: join(privateRun, 'results-3.json'),
      steps: [
        { kind: 'evaluate', tag: 'candidate', notes: evalNotes, ks, calibrationPath: candidatePath },
        { kind: 'scenarios', tag: 'scenarios', notes: testNotes, heldOut, refeed, heldOutEnroll }
      ]
    })
  })

  // Metrics, the gate on the production decisions under the candidate, the report.
  const rows3 = clusterRows(r3.evaluations.find((e) => e.tag === 'candidate') ?? r3.evaluations[0], ctx)
  const asShipped = summarize(rows2, { seed })
  const candidate = summarize(rows3, { seed })
  const gate = Object.fromEntries(Object.entries(candidate.byCondition).filter(([, c]) => c.gate).map(([key, c]) => [key, c.gate]))
  const baselineFeeds = r1.feeds.filter((f) => !f.tag.startsWith('t2:'))
  // A14 over the earlier launches too: their IPC traces, and the app's stdout for vector-like float runs.
  const appLog = readFileSync(join(privateRun, 'app.log'), 'utf8')
  const stdoutVectors = (appLog.match(/(-?\d+\.\d+\s*,\s*){31,}-?\d+\.\d+/g) ?? []).length
  const earlierFindings = r1.trace.findings.length + r2.trace.findings.length
  const checks = [
    a1([...r1.feeds, ...r3.feeds]),
    ...r3.checks,
    ...r2.checks,
    { id: 'A14:launches-1-2+stdout', status: earlierFindings || stdoutVectors ? 'fail' : 'pass', detail: { ipcFindings: earlierFindings, stdoutVectors, invokes: r1.trace.invokes + r2.trace.invokes, pushes: r1.trace.pushes + r2.trace.pushes } }
  ]
  const models = args['compare-models'] || dry ? compareModels(manifest, { enrolledIn: sched.enrolledIn, heldOut, seed, dry }) : { skipped: 'not requested (--compare-models)', results: [] }
  const errors = [...r1.errors, ...r2.errors, ...r3.errors]
  const report = {
    runId,
    dry,
    benchVersion: BENCH_VERSION,
    createdAt: new Date().toISOString(),
    modelId: r1.modelId,
    asrReady: r1.asrReady,
    notes,
    data: {
      people: manifest.people.length,
      heldOutPeople: heldOut.length,
      enrollmentMeetingsPerPerson: k,
      meetingsFed: baselineFeeds.length,
      meetingsWithAPass: baselineFeeds.filter((f) => f.passId).length,
      clustersEvaluated: rows3.length,
      realClusters: rows3.filter((r) => !r.composed).length,
      composedClusters: rows3.filter((r) => r.composed).length,
      t2Replays: t2.length,
      t3Meetings: t3.meetings.length,
      ipcInvokes: r1.trace.invokes + r2.trace.invokes + r3.trace.invokes,
      ipcPushes: r1.trace.pushes + r2.trace.pushes + r3.trace.pushes
    },
    gate,
    overall: candidate.overall,
    overallAsShipped: asShipped.overall,
    byCondition: candidate.byCondition,
    verification: verification(rows2),
    der: derSummary(baselineFeeds, ctx),
    micEcho: micEchoSummary(baselineFeeds, ctx),
    cpu: cpuSummary(baselineFeeds),
    t2: t2Summary(r1.feeds, ctx),
    t3: candidate.composed,
    t3Skipped: t3.skipped,
    models,
    calibration: {},
    checks,
    errors
  }

  // The calibration writer: aggregates only, autoEnabled from the gate (≥30s), never in --dry.
  const conditionsPassing = Object.values(gate).filter((g) => g.pass).length
  report.calibration = {
    fitted: 'calibration.candidate.json in the run folder',
    conditionsPassing,
    logisticSources: [...new Set(Object.values(fitted.notes).map((n) => n.logistic))].join(', ') || '—',
    kept: 'margin, tieMargin and fusion weights keep the shipped values',
    written: false
  }
  const reportHash = writeReport(REPORTS, report)
  const finalFile = finalCalibration(fitted.file, candidate, { reportHash, benchVersion: BENCH_VERSION })
  writeFileSync(join(privateRun, 'calibration.candidate.json'), JSON.stringify(finalFile, null, 2) + '\n')
  if (args['write-calibration'] && !dry) {
    const drops = coverageDrops(shipped, finalFile)
    if (drops.length) log(`coverage drops > 5 points (each needs a reason in the commit): ${JSON.stringify(drops)}`)
    writeFileSync(CALIBRATION, JSON.stringify(finalFile, null, 2) + '\n')
    log(`wrote ${CALIBRATION} (reportHash ${reportHash.slice(0, 12)}…): commit it with the report's JSON`)
  }

  const calibrationAfter = sha256(CALIBRATION)
  const failed = checks.filter((c) => c.status === 'fail')
  log(`report: ${join(REPORTS, `${runId}.md`)}`)
  log(`checks: ${checks.map((c) => `${c.id}=${c.status}`).join(' ')}`)
  if (errors.length) log(`errors: ${errors.join(' | ')}`)
  if (!args.keep) rmSync(profile, { recursive: true, force: true })
  if (dry) {
    const problems = []
    if (calibrationAfter !== calibrationBefore) problems.push('calibration.json changed')
    if (failed.length) problems.push(`failed checks: ${failed.map((c) => c.id).join(', ')}`)
    if (errors.length) problems.push(`${errors.length} errors`)
    if (!existsSync(join(REPORTS, `${runId}.md`))) problems.push('no report')
    if (problems.length) {
      log(`DRY RUN FAILED: ${problems.join('; ')}`)
      process.exitCode = 1
    } else log('dry run passed: every stage ran, no invariant failed, calibration.json untouched')
  } else if (failed.length) process.exitCode = 1
}

// ---------- labelling and setup ----------

async function setup(args) {
  const home = benchHome(args)
  const profile = join(home, 'label-profile')
  linkModels(profile, join(home, 'models'))
  log(`opening the app on ${profile}: download the speech models (Settings) and, after \`label\`, name every speaker; quit the app when done`)
  await runApp({ profile, interactive: true, plan: null, planPath: null, logPath: join(home, 'setup.log') })
}

async function label(args) {
  const home = benchHome(args)
  const manifest = loadManifest(args.manifest)
  const profile = join(home, 'label-profile')
  linkModels(profile, join(home, 'models'))
  const todo = manifest.meetings.filter((m) => args.all || !m.labels.length)
  const provider = args.provider ? providerConfig(args) : { settings: {}, secret: null }
  log(`feeding ${todo.length} meetings into the label profile (real time)`)
  const r = await runApp({
    profile,
    planPath: join(home, 'plan-label.json'),
    logPath: join(home, 'label.log'),
    plan: basePlan({
      runId: `label-${stamp()}`,
      resultsPath: join(home, 'results-label.json'),
      dry: false,
      manifest,
      settings: { ...benchSettings(manifest), ...provider.settings },
      secret: provider.secret,
      mockProvider: false,
      steps: todo.map((m) => ({ kind: 'feed', tag: m.id, meeting: feedMeeting(m) }))
    })
  })
  const map = { manifest: resolve(args.manifest), notes: r.feeds.map((f) => ({ meetingId: f.meetingId, noteId: f.noteId, feedStartMs: f.feedStartMs })) }
  writeFileSync(join(home, 'label-notes.json'), JSON.stringify(map, null, 1))
  log('now run `setup`, name every speaker of those notes in the app, quit it, then run `export-labels`')
}

async function exportLabels(args) {
  const home = benchHome(args)
  const manifest = loadManifest(args.manifest)
  const map = JSON.parse(readFileSync(join(home, 'label-notes.json'), 'utf8'))
  const r = await runApp({
    profile: join(home, 'label-profile'),
    planPath: join(home, 'plan-export.json'),
    logPath: join(home, 'label.log'),
    plan: basePlan({
      runId: `export-${stamp()}`,
      resultsPath: join(home, 'results-export.json'),
      dry: false,
      manifest,
      settings: {},
      mockProvider: false,
      steps: [{ kind: 'export-labels', notes: map.notes.map((n) => ({ ...n, outPath: join(manifest.dir, 'labels', `${n.meetingId}.json`) })) }]
    })
  })
  for (const e of r.labelsExported) log(`${e.meetingId}: ${e.spans} spans → ${join(manifest.dir, 'labels', `${e.meetingId}.json`)}`)
}

async function models(args) {
  const manifest = loadManifest(args.manifest)
  const seed = Number(args.seed ?? 1)
  const heldOut = heldOutPeople(manifest, { seed })
  const sched = schedule(manifest.meetings.filter((m) => m.labels.length), { k: Math.min(3, Number(args.k ?? 3)), heldOut })
  const out = compareModels(manifest, { enrolledIn: sched.enrolledIn, heldOut, seed })
  mkdirSync(REPORTS, { recursive: true })
  const path = join(REPORTS, `models-${stamp()}.json`)
  writeFileSync(path, JSON.stringify(out, null, 1))
  log(`winner: ${out.winner ?? '—'} (${out.note ?? out.skipped}); ${path}`)
}

const args = parseArgs(process.argv.slice(2))
const command = args._[0] ?? (args.dry ? 'run' : null)
const commands = { run, setup, label, 'export-labels': exportLabels, 'compare-models': models }
if (!command || !commands[command]) {
  process.stdout.write('usage: node scripts/dev/speaker-bench.mjs --dry | setup | label | export-labels | run | compare-models (see scripts/dev/speaker-bench/README.md)\n')
  process.exitCode = 2
} else {
  commands[command](args).catch((err) => {
    process.stderr.write(`[speaker-bench] ${err instanceof Error ? err.stack : String(err)}\n`)
    process.exitCode = 1
  })
}
