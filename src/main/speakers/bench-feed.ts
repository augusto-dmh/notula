// SPDX-License-Identifier: Apache-2.0
// The speaker benchmark's replay feed: dev only, present only in an
// unpackaged build started with `NOTULA_DEV_SPEAKER_BENCH=1`. It feeds a manifest's meetings
// through the production capture path so the note pass and the job run as they do live.
//
// `scripts/dev/speaker-bench.mjs` writes a plan (`NOTULA_DEV_SPEAKER_BENCH_PLAN`), starts the
// app on a scratch profile (`NOTULA_USER_DATA_DIR`) in the tray only, and reads the results file
// this module writes before it quits. The script owns the protocol, the metrics and the report;
// this module only does what needs the running app:
//   - `feed`: a note, its session (on-device ASR, the meeting's language), a synthetic linked
//     event with the attendees, the WAVs in real time through `TranscriptionManager.feed` (one
//     call per source and 100 ms), an optional UIA record stream replayed into the attribution
//     service as its worker's records, `TranscriptionManager.stop`, the pass and the job, a dump
//     of the clusters, then the protocol's confirmations through the real naming handlers;
//   - `evaluate`: the production `decide` on each note's stored pass, per signal set, gallery
//     scope and calibration, plus the voice scores the calibration is fitted from;
//   - `scenarios`: the A1–A16 checks of the bench README that need the app (A1 and A2 are counted by the
//     script from the dumps);
//   - `export-labels`: the clusters the dev named in the scratch profile, as label spans.
//
// Results stay in the run folder the plan names. Vectors never leave this process; scores and
// person ids (the manifest's pseudonyms) go only into that results file, never to a log or IPC.
// `registerSpeakerProfiles` loads this module with a dynamic import behind the same tests, so it
// is a chunk of its own in a dev build, and a release build (`--mode release`, `npm run dist`)
// folds that import away and never emits it.

import { createHash, createDecipheriv } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { dirname, join } from 'node:path'
import { app, BrowserWindow, ipcMain, type WebContents } from 'electron'
import type { InvokeChannel, InvokeReq, InvokeRes } from '@shared/ipc'
import { VOICE_AGREEMENT_VERSION } from '@shared/lib/speaker-notices'
import { speakerIdentities, wordIdentityKeys } from '@shared/lib/speakers'
import type { AudioSource } from '@shared/types/common'
import type { CalendarEvent } from '@shared/types/notes'
import type { SecretId, Settings } from '@shared/types/settings'
import { SPEAKER_PROFILE_LIMITS, type SpeakerAutoSource, type SpeakerBand, type SpeakerChannel, type SpeakerJobStatus } from '@shared/types/speakers'
import type { SpeakerNameAccept, TranscriptChunk } from '@shared/types/transcript'
import { speakerIdModelId } from '../asr/manifest'
import type { MainContext } from '../context'
import { log } from '../log'
import { loadOrCreateKey } from '../storage/keyfile'
import { DB_FILE } from '../storage/protocol'
import { getTranscriptionManager } from '../transcription/manager'
import { getAttribution } from './attribution'
import { calibrationState, getCalibration, parseCalibration, type SpeakerCalibrationState } from './calibration'
import { decideCluster, noteCandidates, noteLanguage, passClusters, pendingByCluster, tileKinds, type PassClusterStats } from './candidates'
import { decide, type DecideCandidate, type DecideCluster, type DecideLlmMapping, type DecideVoiceSpace } from './decide'
import { conditionFor } from './decide/conditions'
import { foldName, sigmoid } from './decide/evidence'
import { jobBusy, rerunDecision, SPEAKER_LABELS_WAIT_MS, storedLlm, type StoredLlm } from './job'
import { currentPassId } from './label-queue'
import { requestRelabel } from './relabel'

export function maybeRunSpeakerBench(ctx: MainContext): void {
  if (import.meta.env.MODE === 'release') return
  if (app.isPackaged || process.env['NOTULA_DEV_SPEAKER_BENCH'] !== '1') return
  const planPath = process.env['NOTULA_DEV_SPEAKER_BENCH_PLAN']?.trim()
  if (!planPath) {
    log('warn', 'speaker-bench:no-plan')
    return
  }
  void runBench(ctx, planPath).catch((err: unknown) => {
    log('error', 'speaker-bench:failed', { message: err instanceof Error ? err.message : String(err) })
    app.exit(3)
  })
}

// ---------- the plan (written by scripts/dev/speaker-bench.mjs) ----------

/** A manifest person: `id` is the pseudonym every result uses; `name` and `email` stay in the app. */
interface BenchPerson {
  id: string
  name: string
  email: string
  self?: boolean
}

/** A label span on the meeting's timeline (ms from the feed's start). */
interface LabelSpan {
  channel: SpeakerChannel
  startMs: number
  endMs: number
  person: string
}

interface FeedAudio {
  channel: SpeakerChannel
  path: string
  offsetMs: number
}

interface FeedMeeting {
  id: string
  title: string
  /** A session language (`pt-BR`, `en`, `multi`). */
  language: string
  audio: FeedAudio[]
  /** Person ids on the synthetic linked event (the user is added as `self`). */
  attendees: string[]
  /** A pseudonymized record stream (JSON lines with `tMs`), already transformed for the run. */
  uia: { app: 'zoom' | 'teams' | 'meet'; path: string } | null
  labels: LabelSpan[]
}

interface FeedStep {
  kind: 'feed'
  tag: string
  meeting: FeedMeeting
  /** `mock-contradict`: the in-app mock names every labelled cluster as someone else. */
  llm?: 'configured' | 'mock-abstain' | 'mock-contradict'
  /** People to confirm from this meeting (the open-set protocol's enrollment). */
  enroll?: string[]
}

interface EvalNote {
  tag: string
  noteId: string
  labels: LabelSpan[]
  composed: boolean
}

interface EvaluateStep {
  kind: 'evaluate'
  tag: string
  notes: EvalNote[]
  /** A calibration file to decide under (the fitted candidate); absent = the shipped file. */
  calibrationPath?: string
  /** Learning curve: enrollment meetings per person to keep in the gallery. */
  ks: number[]
}

interface ScenarioStep {
  kind: 'scenarios'
  tag: string
  /** Test notes (baseline feeds) the reruns use. */
  notes: EvalNote[]
  heldOut: string[]
  /** Meetings re-fed by A7, A12 and A16 (with their UIA streams, if any), by their baseline note's tag. */
  refeed: { tag: string; meeting: FeedMeeting }[]
  /** A meeting (with labels) of each held-out person, to enroll them for A3. */
  heldOutEnroll: { person: string; meeting: string; noteId: string; labels: LabelSpan[] }[]
}

interface ExportLabelsStep {
  kind: 'export-labels'
  notes: { meetingId: string; noteId: string; feedStartMs: number; outPath: string }[]
}

type BenchStep = FeedStep | EvaluateStep | ScenarioStep | ExportLabelsStep

interface BenchPlan {
  version: 1
  runId: string
  resultsPath: string
  dry: boolean
  settings: Partial<Settings>
  /** The provider key for a fresh run profile: read from this environment variable, never from the plan. */
  secret: { id: SecretId; env: string } | null
  /** The in-app mock replaces the provider for the whole run (`--dry`). */
  mockProvider: boolean
  people: BenchPerson[]
  /** Person id → their enrollment notes, in order (filled by the script for later launches). */
  enrolled: Record<string, string[]>
  /** Note id → its feed's start (epoch ms), for notes fed by an earlier launch. */
  feedStarts: Record<string, number>
  steps: BenchStep[]
}

// ---------- results ----------

interface ClusterDump {
  key: string
  label: string
  letter: string | null
  channel: SpeakerChannel
  speechMs: number
  cleanMs: number | null
  confirmed: boolean
  band: SpeakerBand
  /** Auto: the manifest id behind `auto_pid` (or the name match), else `other`. */
  auto: { person: string; src: SpeakerAutoSource | null } | null
  candidates: { person: string; source: string }[]
  /** Word time on the meeting's timeline, merged. */
  segments: [number, number][]
}

interface NoteDump {
  tag: string
  meetingId: string
  noteId: string
  feedStartMs: number
  passId: string | null
  language: string
  asr: 'local' | 'missing'
  audioMs: number
  fedMs: number
  stopToDoneMs: number
  job: { state: string; reason?: string; times: Record<string, number> }
  cpuSeconds: Record<string, number>
  uiaRecords: number
  clusters: ClusterDump[]
  enrolled: { person: string; clusters: number; agreement: boolean }[]
}

interface Check {
  id: string
  status: 'pass' | 'fail' | 'n/a'
  detail: Record<string, unknown>
}

interface BenchResults {
  runId: string
  startedAt: string
  endedAt: string
  modelId: string | null
  asrReady: boolean
  calibration: { voice: boolean; reason?: string }
  people: Record<string, string>
  feeds: NoteDump[]
  evaluations: unknown[]
  checks: Check[]
  trace: { invokes: number; pushes: number; findings: { kind: string; channel: string }[] }
  logScan: { files: number; vectors: number; notice: number; evidence: number } | null
  labelsExported: { meetingId: string; spans: number }[]
  errors: string[]
}

// ---------- small helpers ----------

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const FEED_MS = 100
const BYTES_PER_MS = 32
const UNDO_WAIT_MS = SPEAKER_PROFILE_LIMITS.undoWindowMs + 1_500

async function until(fn: () => Promise<boolean> | boolean, ms: number, step = 250): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await Promise.resolve().then(fn).catch(() => false)) return true
    await sleep(step)
  }
  return false
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** A seeded shuffle, so a rerun is reproducible. */
function shuffled<T>(list: readonly T[], seed: number): T[] {
  const out = [...list]
  let s = seed >>> 0 || 1
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1664525 + 1013904223) >>> 0
    const j = s % (i + 1)
    ;[out[i], out[j]] = [out[j] as T, out[i] as T]
  }
  return out
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0
  let na = 0
  let nb = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const x = a[i] as number
    const y = b[i] as number
    dot += x * y
    na += x * x
    nb += y * y
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0
}

/** 16 kHz mono s16 PCM of a WAV file. */
function pcmFromWav(path: string): Buffer {
  const b = readFileSync(path)
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') throw new Error(`not a WAV file: ${path}`)
  let i = 12
  while (i + 8 <= b.length) {
    const id = b.toString('ascii', i, i + 4)
    const size = b.readUInt32LE(i + 4)
    if (id === 'fmt ') {
      const channels = b.readUInt16LE(i + 10)
      const rate = b.readUInt32LE(i + 12)
      const bits = b.readUInt16LE(i + 22)
      if (channels !== 1 || rate !== 16_000 || bits !== 16) throw new Error(`the bench WAVs must be 16 kHz mono 16-bit: ${path}`)
    }
    if (id === 'data') return b.subarray(i + 8, Math.min(b.length, i + 8 + size))
    i += 8 + size + (size % 2)
  }
  throw new Error(`no data chunk: ${path}`)
}

/** The person of each cluster: the label person holding most of its word time (≥ 50 %), else null. */
function truthOf(segments: readonly [number, number][], channel: SpeakerChannel, labels: readonly LabelSpan[]): string | null {
  const held = new Map<string, number>()
  let total = 0
  for (const [s, e] of segments) {
    total += e - s
    for (const l of labels) {
      if (l.channel !== channel) continue
      const o = Math.min(e, l.endMs) - Math.max(s, l.startMs)
      if (o > 0) held.set(l.person, (held.get(l.person) ?? 0) + o)
    }
  }
  const best = [...held].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]
  return best && total > 0 && best[1] * 2 >= total ? best[0] : null
}

// ---------- the run ----------

class Bench {
  readonly results: BenchResults
  /** person id ↔ manifest id. */
  private readonly toManifest = new Map<string, string>()
  private readonly toPerson = new Map<string, string>()
  private readonly byName = new Map<string, string>()
  private readonly people = new Map<string, BenchPerson>()
  private traceWc: WebContents | null = null
  private mock: Server | null = null
  private mockUrl = ''
  private mockMode: 'abstain' | 'contradict' = 'abstain'
  private mockNote: { noteId: string; feedStartMs: number; labels: LabelSpan[] } | null = null
  /** The note the running feed created. */
  private feeding: string | null = null
  mockCalls = 0
  private readonly jobTimes = new Map<string, Record<string, number>>()
  /** Agreement and evidence texts the run saw, for the A14 scans (never written anywhere). */
  private readonly secrets = { notice: new Set<string>(), evidence: new Set<string>() }
  /** Channels whose reply may carry the agreement text (View message only). */
  private static readonly NOTICE_OK = new Set(['speaker-people:agreement-text'])

  constructor(
    private readonly ctx: MainContext,
    readonly plan: BenchPlan
  ) {
    this.results = {
      runId: plan.runId,
      startedAt: new Date().toISOString(),
      endedAt: '',
      modelId: null,
      asrReady: false,
      calibration: { voice: false },
      people: {},
      feeds: [],
      evaluations: [],
      checks: [],
      trace: { invokes: 0, pushes: 0, findings: [] },
      logScan: null,
      labelsExported: [],
      errors: []
    }
    for (const p of plan.people) {
      this.people.set(p.id, p)
      this.byName.set(foldName(p.name), p.id)
    }
  }

  manifestOf(personId: string | null | undefined, name?: string | null): string {
    if (personId && this.toManifest.has(personId)) return this.toManifest.get(personId) as string
    if (name && this.byName.has(foldName(name))) return this.byName.get(foldName(name)) as string
    return 'other'
  }

  save(): void {
    mkdirSync(dirname(this.plan.resultsPath), { recursive: true })
    writeFileSync(this.plan.resultsPath, JSON.stringify(this.results, null, 1))
  }

  // ----- the IPC trace -----

  /** A hidden page: the pushes main sends to its windows reach it, and are scanned. */
  openTrace(): void {
    const win = new BrowserWindow({ show: false, width: 200, height: 200, webPreferences: { sandbox: true, contextIsolation: true } })
    void win.loadURL('about:blank')
    const wc = win.webContents
    const send = wc.send.bind(wc)
    wc.send = (channel: string, ...args: unknown[]): void => {
      this.results.trace.pushes++
      if (channel === 'speakers:job-changed') {
        const s = args[0] as SpeakerJobStatus | undefined
        if (s?.noteId) {
          const t = this.jobTimes.get(s.noteId) ?? {}
          t[s.state] ??= Date.now()
          this.jobTimes.set(s.noteId, t)
        }
      }
      this.scan(channel, args, 'push')
      send(channel, ...args)
    }
    this.traceWc = wc
  }

  /** Vector-sized float arrays, score fields and agreement text in what crossed (or would cross) IPC. */
  scan(channel: string, payload: unknown, dir: 'push' | 'reply' | 'request'): void {
    const found = (kind: string): void => {
      this.results.trace.findings.push({ kind: `${dir}:${kind}`, channel })
    }
    const seen = new Set<unknown>()
    const walk = (v: unknown, depth: number, key: string): void => {
      if (v === null || v === undefined || depth > 12) return
      if (ArrayBuffer.isView(v)) {
        if (v instanceof Float32Array || v instanceof Float64Array) found('float-array')
        return
      }
      if (typeof v === 'string') {
        if (v.length >= 40 && !Bench.NOTICE_OK.has(channel)) {
          for (const n of this.secrets.notice) if (v.includes(n.slice(0, 80))) found('notice-text')
        }
        if (v.length >= 20 && !(Bench.NOTICE_OK.has(channel) || (dir === 'request' && channel === 'speaker-people:record-agreement'))) {
          for (const e of this.secrets.evidence) if (v.includes(e)) found('evidence-text')
        }
        return
      }
      if (typeof v === 'number') {
        if (/^(score|scores|cosine|similarity|probability|logodds|fused|confidence_score)$/i.test(key)) found('score-field')
        return
      }
      if (typeof v !== 'object' || seen.has(v)) return
      seen.add(v)
      if (Array.isArray(v)) {
        const floats = v.filter((x) => typeof x === 'number' && !Number.isInteger(x)).length
        if (floats >= 32) found('float-list')
        v.forEach((x) => walk(x, depth + 1, key))
        return
      }
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if (/^(vector|embedding|centroid|exemplars)$/i.test(k) && x !== null && typeof x === 'object') found(`field:${k}`)
        walk(x, depth + 1, k)
      }
    }
    walk(payload, 0, '')
  }

  /**
   * Calls the registered `ipcMain.handle` handler of `channel`, as a renderer invoke would reach
   * it (read only, as the device-lock guard reads Electron 44's handler map). The request and the
   * structured-clone of the reply are scanned like the pushes.
   */
  async invoke<C extends InvokeChannel>(channel: C, req: InvokeReq<C>): Promise<InvokeRes<C>> {
    const handlers = (ipcMain as unknown as { _invokeHandlers?: Map<string, (e: unknown, ...args: unknown[]) => unknown> })._invokeHandlers
    const fn = handlers?.get(channel)
    if (!fn) throw new Error(`no handler for ${channel}`)
    this.results.trace.invokes++
    this.scan(channel, req, 'request')
    const reply = (await fn({ sender: this.traceWc, senderFrame: null, processId: 0, frameId: 0 }, req)) as InvokeRes<C>
    const cloned = structuredClone(reply)
    this.scan(channel, cloned, 'reply')
    return cloned
  }

  // ----- the provider mock -----

  async startMock(): Promise<string> {
    if (this.mock) return this.mockUrl
    const server = createServer((req, res) => void this.onMock(req, res))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    this.mock = server
    this.mockUrl = `http://127.0.0.1:${port}/v1`
    return this.mockUrl
  }

  private async onMock(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const json = (body: unknown): void => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (req.method === 'GET' && req.url?.endsWith('/models')) return json({ object: 'list', data: [{ id: 'bench-mock', object: 'model' }] })
    let body: { stream?: boolean; messages?: { role: string; content: unknown }[] } = {}
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as typeof body
    } catch {
      // An empty reply below.
    }
    const user = (body.messages ?? [])
      .filter((m) => m.role === 'user')
      .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
      .join('\n')
    let content = 'OK'
    if (user.includes('TRANSCRIPT:') && user.includes('MEETING TITLE:')) {
      this.mockCalls++
      content = JSON.stringify(await this.mockSpeakerReply(user).catch(() => ({ mappings: [], extra_speakers_likely: null })))
    }
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content } }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`)
      res.end('data: [DONE]\n\n')
      return
    }
    json({
      id: 'bench',
      object: 'chat.completion',
      model: 'bench-mock',
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
    })
  }

  /** Abstains, or names every labelled cluster as another candidate with `certain` evidence. */
  private async mockSpeakerReply(prompt: string): Promise<unknown> {
    const target = this.mockNote
    if (this.mockMode !== 'contradict' || !target) return { mappings: [], extra_speakers_likely: null }
    const cands: { id: string; name: string; email: string }[] = []
    let inCands = false
    for (const line of prompt.split('\n')) {
      if (line.startsWith('CANDIDATES:')) {
        inCands = true
        continue
      }
      if (inCands) {
        const m = /^- \[(c\d+)\] (.*?)(?: <([^>]*)>)?$/.exec(line)
        if (!m) break
        cands.push({ id: m[1] as string, name: (m[2] ?? '').trim(), email: (m[3] ?? '').toLowerCase() })
      }
    }
    const chunks = (await this.ctx.storage.getTranscript(target.noteId)).filter((c) => c.is_final)
    const passId = currentPassId(chunks)
    if (!passId) return { mappings: [], extra_speakers_likely: null }
    const stats = passClusters(chunks, passId)
    const { identities } = speakerIdentities(chunks, { live: false })
    const segs = this.segments(chunks, target.feedStartMs)
    const used = new Set<string>()
    const mappings: unknown[] = []
    for (const id of identities) {
      if (!id.letterLabel || !stats.has(id.key)) continue
      const s = stats.get(id.key) as PassClusterStats
      const truth = truthOf(segs.get(id.key) ?? [], s.channel, target.labels)
      const truthPerson = truth ? this.people.get(truth) : undefined
      const other = cands.find((c) => !used.has(c.id) && (!truthPerson || (c.email !== truthPerson.email && foldName(c.name) !== foldName(truthPerson.name))))
      if (!other) continue
      used.add(other.id)
      mappings.push({
        label: id.letterLabel,
        candidate: other.id,
        name: other.name,
        confidence: 'certain',
        evidence: [{ type: 'named_then_replied', quote: `${other.name}, over to you` }]
      })
    }
    return { mappings, extra_speakers_likely: false }
  }

  async useMock(mode: 'abstain' | 'contradict'): Promise<() => Promise<void>> {
    const url = await this.startMock()
    this.mockMode = mode
    const s = await this.ctx.settings.getAll()
    const saved = { provider: s['llm.provider'], base: s['llm.local.baseUrl'], model: s['llm.local.model'] }
    await this.ctx.settings.set('llm.provider', 'local')
    await this.ctx.settings.set('llm.local.baseUrl', url)
    await this.ctx.settings.set('llm.local.model', 'bench-mock')
    return async () => {
      this.mockMode = 'abstain'
      await this.ctx.settings.set('llm.provider', saved.provider)
      await this.ctx.settings.set('llm.local.baseUrl', saved.base)
      await this.ctx.settings.set('llm.local.model', saved.model)
    }
  }

  // ----- people -----

  async personIdOf(manifestId: string): Promise<string | null> {
    const known = this.toPerson.get(manifestId)
    if (known) return known
    const p = this.people.get(manifestId)
    if (!p) return null
    const row = p.self ? await this.ctx.storage.ensureSelfPerson(p.name) : await this.ctx.storage.findSpeakerPersonByEmail(p.email)
    if (!row) return null
    const live = row.mergedInto ? await this.ctx.storage.getSpeakerPerson(row.id, { resolveMerged: true }) : row
    if (!live) return null
    this.toPerson.set(manifestId, live.id)
    this.toManifest.set(live.id, manifestId)
    this.results.people[manifestId] = live.id
    return live.id
  }

  async loadPeople(): Promise<void> {
    for (const p of this.plan.people) await this.personIdOf(p.id).catch(() => null)
  }

  // ----- transcript reading -----

  /** Each cluster's word time on the meeting timeline, merged across gaps under 300 ms. */
  segments(final: readonly TranscriptChunk[], feedStartMs: number): Map<string, [number, number][]> {
    const keys = wordIdentityKeys(final)
    const raw = new Map<string, [number, number][]>()
    for (const c of final) {
      const d = c.providerDetails
      const ks = keys.get(c.id)
      if (!d || !ks) continue
      d.words.forEach((w, i) => {
        const k = ks[i]
        if (!k) return
        const list = raw.get(k) ?? []
        list.push([d.wallClockAnchorMs + w.s_ms - feedStartMs, d.wallClockAnchorMs + w.e_ms - feedStartMs])
        raw.set(k, list)
      })
    }
    const out = new Map<string, [number, number][]>()
    for (const [k, list] of raw) {
      list.sort((a, b) => a[0] - b[0])
      const merged: [number, number][] = []
      for (const [s, e] of list) {
        const last = merged[merged.length - 1]
        if (last && s - last[1] < 300) last[1] = Math.max(last[1], e)
        else merged.push([s, e])
      }
      out.set(k, merged.map(([s, e]) => [Math.round(s), Math.round(e)]))
    }
    return out
  }

  /** The note's clusters as the pipeline left them: bands, auto names and candidates, no scores. */
  async dumpClusters(noteId: string, feedStartMs: number): Promise<{ passId: string | null; clusters: ClusterDump[] }> {
    const final = (await this.ctx.storage.getTranscript(noteId)).filter((c) => c.is_final)
    const passId = currentPassId(final)
    if (!passId) return { passId: null, clusters: [] }
    const stats = passClusters(final, passId)
    const { identities } = speakerIdentities(final, { live: false })
    const letters = new Map(identities.map((i) => [i.key, i.letterLabel]))
    const rows = new Map((await this.ctx.storage.listSpeakerNameSuggestions(noteId)).filter((r) => r.passId === passId).map((r) => [r.identityKey, r]))
    const vectors = await this.ctx.storage.listSpeakerClusterVectors({ noteId, passId }).catch(() => [])
    const clean = new Map(vectors.map((v) => [v.label, v.cleanMs]))
    for (const v of vectors) v.vector.fill(0)
    const segs = this.segments(final, feedStartMs)
    const clusters: ClusterDump[] = []
    for (const s of stats.values()) {
      const row = rows.get(s.key)
      const band: SpeakerBand = s.auto ? 'auto' : (row?.band ?? 'none')
      clusters.push({
        key: s.key,
        label: s.label,
        letter: letters.get(s.key) ?? null,
        channel: s.channel,
        speechMs: Math.round(s.speechMs),
        cleanMs: clean.has(s.label) ? Math.round(clean.get(s.label) as number) : null,
        confirmed: s.confirmed,
        band,
        auto: s.auto ? { person: this.manifestOf(s.auto.personId, s.auto.name), src: s.auto.src } : null,
        candidates: band === 'auto' ? [] : (row?.candidates ?? []).map((c) => ({ person: this.manifestOf(c.personId, c.name), source: c.source })),
        segments: segs.get(s.key) ?? []
      })
    }
    return { passId, clusters }
  }

  // ----- feeding -----

  private event(m: FeedMeeting, tag: string, attendees: readonly string[], startMs: number, endMs: number, profile: { name: string; email: string }): CalendarEvent {
    return {
      id: `speaker-bench-${this.plan.runId}-${tag}`,
      summary: m.title,
      start: { dateTime: new Date(startMs).toISOString() },
      end: { dateTime: new Date(endMs).toISOString() },
      attendees: [
        ...(profile.email ? [{ email: profile.email, displayName: profile.name, self: true }] : []),
        ...attendees
          .map((id) => this.people.get(id))
          .filter((p): p is BenchPerson => !!p && !p.self)
          .map((p) => ({ email: p.email, displayName: p.name, responseStatus: 'accepted' }))
      ]
    }
  }

  /** Rewrites only the attendees of the note's synthetic linked event. */
  async writeAttendees(noteId: string, attendees: readonly string[]): Promise<void> {
    const event = (await this.ctx.storage.getNote(noteId))?.linked_event
    if (!event) return
    const self = (event.attendees ?? []).filter((a) => a.self)
    const others = attendees
      .map((id) => this.people.get(id))
      .filter((p): p is BenchPerson => !!p && !p.self)
      .map((p) => ({ email: p.email, displayName: p.name, responseStatus: 'accepted' }))
    await this.ctx.storage.updateNote(noteId, { linked_event: { ...event, attendees: [...self, ...others] } })
  }

  private cpuSample(acc: Map<number, { service: string; cpu: number }>): void {
    for (const m of app.getAppMetrics()) {
      const service = (m as { serviceName?: string }).serviceName ?? m.type
      const cpu = (m.cpu as { cumulativeCPUUsage?: number }).cumulativeCPUUsage
      if (typeof cpu !== 'number') continue
      const had = acc.get(m.pid)
      acc.set(m.pid, { service, cpu: Math.max(had?.cpu ?? 0, cpu) })
    }
  }

  async feed(step: FeedStep): Promise<NoteDump> {
    const m = step.meeting
    const manager = getTranscriptionManager(this.ctx)
    const s = await this.ctx.settings.getAll()
    const audio = m.audio.map((a) => ({ ...a, pcm: pcmFromWav(a.path), source: (a.channel === 'mic' ? 'microphone' : 'system') as AudioSource }))
    const audioMs = Math.max(0, ...audio.map((a) => a.offsetMs + a.pcm.byteLength / BYTES_PER_MS))
    const createdAt = Date.now()
    const note = await this.ctx.storage.createNote({
      origin: 'unknown',
      title: m.title,
      calendarEvent: this.event(m, step.tag, m.attendees, createdAt, createdAt + audioMs + 60_000, { name: s['profile.name'], email: s['profile.email'] }),
      created_via: 'desktop'
    })
    const noteId = note.id
    this.feeding = noteId
    const available = await manager.registry.local.available(m.language)
    // A missing model is never fetched by the bench (a local session would download it): no session.
    const asr: 'local' | 'missing' = available.ok ? 'local' : 'missing'
    const sources = audio.map((a) => a.source)
    if (asr === 'local') manager.start({ noteId, language: m.language, keywords: [], asr: 'local', sources })
    else log('info', 'speaker-bench:no-asr', { reason: available.ok ? 'ok' : available.reason })

    let restoreLlm: (() => Promise<void>) | null = null
    if (step.llm === 'mock-abstain' || step.llm === 'mock-contradict') {
      restoreLlm = await this.useMock(step.llm === 'mock-contradict' ? 'contradict' : 'abstain')
    }

    const records = m.uia ? this.readStream(m.uia.path) : []
    const attribution = getAttribution(this.ctx) as unknown as {
      owner: string | null
      detectors: Record<string, { state: string; lastSeenTilesAt: number }>
      timeline: { clearAll(): void }
      onWorker(msg: unknown): void
    }
    const cpu = new Map<number, { service: string; cpu: number }>()
    this.cpuSample(cpu)
    const feedStartMs = Date.now()
    this.mockNote = { noteId, feedStartMs, labels: m.labels }
    let nextRecord = 0
    const ticks = Math.ceil(audioMs / FEED_MS)
    for (let i = 0; i < ticks; i++) {
      const t = i * FEED_MS
      const due = feedStartMs + t
      const wait = due - Date.now()
      if (wait > 0) await sleep(wait)
      for (const a of audio) {
        const piece = Buffer.alloc(FEED_MS * BYTES_PER_MS)
        const from = (t - a.offsetMs) * BYTES_PER_MS
        for (let at = 0; at < piece.length; at += 2) {
          const src = from + at
          if (src >= 0 && src + 1 < a.pcm.byteLength) piece.writeInt16LE(a.pcm.readInt16LE(src), at)
        }
        manager.feed(noteId, a.source, piece, due)
      }
      // The stream's records, as the UIA worker would post them (the detector owns attribution).
      while (m.uia && nextRecord < records.length && (records[nextRecord]?.tMs ?? Infinity) <= t + FEED_MS) {
        const r = records[nextRecord++] as Record<string, unknown> & { tMs: number }
        attribution.owner = m.uia.app
        const d = attribution.detectors[m.uia.app]
        if (d && d.state !== 'active' && d.state !== 'blind') d.state = 'blind'
        const { tMs, ...record } = r
        attribution.onWorker({ type: 'record', app: m.uia.app, record: { ...this.named(record), timestamp: feedStartMs + tMs } })
      }
      if (i % 10 === 0) this.cpuSample(cpu)
    }
    const fedMs = Date.now() - feedStartMs
    const stoppedAt = Date.now()
    if (asr === 'local') await manager.stop(noteId, 'speaker_bench')
    if (m.uia) {
      attribution.owner = null
      attribution.timeline.clearAll()
    }
    // The pass and the job (the pass awaits the job's write), bounded as enhance bounds it.
    const sampler = setInterval(() => this.cpuSample(cpu), 1_000)
    try {
      await Promise.race([manager.awaitStops(noteId).then(() => manager.diarizer.awaitPass(noteId)), sleep(SPEAKER_LABELS_WAIT_MS)])
      await until(() => !jobBusy(noteId), 30_000)
    } finally {
      clearInterval(sampler)
    }
    const stopToDoneMs = Date.now() - stoppedAt
    this.cpuSample(cpu)
    if (restoreLlm) await restoreLlm()
    this.mockNote = null

    const { passId, clusters } = await this.dumpClusters(noteId, feedStartMs)
    const session = await this.ctx.storage.latestSession(noteId).catch(() => null)
    const final = (await this.ctx.storage.getTranscript(noteId)).filter((c) => c.is_final)
    const cpuSeconds: Record<string, number> = {}
    for (const { service, cpu: sec } of cpu.values()) cpuSeconds[service] = Math.round(((cpuSeconds[service] ?? 0) + sec) * 100) / 100
    const runState = this.jobTimes.get(noteId) ?? {}
    const dump: NoteDump = {
      tag: step.tag,
      meetingId: m.id,
      noteId,
      feedStartMs,
      passId,
      language: noteLanguage(session?.language ?? null, final),
      asr,
      audioMs: Math.round(audioMs),
      fedMs,
      stopToDoneMs,
      job: { state: Object.keys(runState).pop() ?? 'none', times: runState },
      cpuSeconds,
      uiaRecords: records.length,
      clusters,
      enrolled: []
    }
    if (step.enroll?.length && passId) dump.enrolled = await this.enroll(noteId, passId, clusters, m.labels, step.enroll, m.language)
    return dump
  }

  /** Manifest ids in a pseudonymized record become the people's names, as the reader would see them. */
  private named(record: Record<string, unknown>): Record<string, unknown> {
    const name = (v: unknown): unknown => (typeof v === 'string' && this.people.has(v) ? (this.people.get(v) as BenchPerson).name : v)
    const out: Record<string, unknown> = { ...record, participantName: name(record['participantName']) }
    if (Array.isArray(record['participants'])) {
      out['participants'] = (record['participants'] as Record<string, unknown>[]).map((p) => ({ ...p, name: name(p['name']) }))
    }
    return out
  }

  private readStream(path: string): (Record<string, unknown> & { tMs: number })[] {
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as Record<string, unknown> & { tMs: number })
      .filter((r) => typeof r.tMs === 'number' && Number.isFinite(r.tMs))
      .sort((a, b) => a.tMs - b.tMs)
  }

  // ----- confirmations (through the app's own naming path) -----

  /** Names each labelled cluster of `persons` with Remember voice on: an agreement first, then the accept. */
  async enroll(
    noteId: string,
    passId: string,
    clusters: readonly ClusterDump[],
    labels: readonly LabelSpan[],
    persons: readonly string[],
    language: string
  ): Promise<{ person: string; clusters: number; agreement: boolean }[]> {
    const out: { person: string; clusters: number; agreement: boolean }[] = []
    for (const id of persons) {
      const p = this.people.get(id)
      if (!p) continue
      const mine = clusters.filter((c) => !c.confirmed && truthOf(c.segments, c.channel, labels) === id)
      let agreement = false
      let named = 0
      for (const c of mine) {
        try {
          const r = await this.confirm(noteId, passId, c, p, language)
          agreement ||= r.agreement
          if (r.named) named++
        } catch (err) {
          this.results.errors.push(`enroll ${id}: ${message(err)}`)
        }
      }
      out.push({ person: id, clusters: named, agreement })
    }
    if (out.some((o) => o.clusters > 0)) await sleep(UNDO_WAIT_MS)
    return out
  }

  /** One confirmation the way the sheet does it: accept, the agreement when asked, accept again. */
  async confirm(
    noteId: string,
    passId: string,
    c: Pick<ClusterDump, 'key'>,
    p: BenchPerson,
    language: string,
    opts: { agree?: boolean; remember?: boolean } = {}
  ): Promise<{ named: boolean; agreement: boolean }> {
    const base: Omit<SpeakerNameAccept, 'personId' | 'email' | 'self'> = {
      noteId,
      identityKey: c.key,
      name: p.name,
      edited: false,
      chosenFromList: true,
      remember: opts.remember ?? true,
      scope: 'speaker',
      passId
    }
    await until(() => !jobBusy(noteId), 60_000)
    if (p.self) {
      const r = await this.invoke('speaker-names:accept' satisfies InvokeChannel, { ...base, self: true })
      await this.personIdOf(p.id)
      return { named: r.chunksNamed > 0, agreement: true }
    }
    const known = await this.personIdOf(p.id)
    const first = await this.invoke('speaker-names:accept' satisfies InvokeChannel, known ? { ...base, personId: known } : { ...base, email: p.email })
    const personId = known ?? (await this.personIdOf(p.id))
    if (!first.needsAgreement || !personId || opts.agree === false) return { named: first.chunksNamed > 0, agreement: !first.needsAgreement }
    const lang = language.toLowerCase().startsWith('pt') ? 'pt' : 'en'
    const evidenceText = `Speaker bench synthetic agreement ${this.plan.runId} ${p.id}`
    this.secrets.evidence.add(evidenceText)
    await this.invoke('speaker-people:record-agreement' satisfies InvokeChannel, {
      personId,
      method: 'email',
      language: lang,
      noticeVersion: VOICE_AGREEMENT_VERSION,
      evidenceText
    })
    const text = await this.invoke('speaker-people:agreement-text' satisfies InvokeChannel, { personId })
    this.secrets.notice.add(text.noticeText)
    const again = await this.invoke('speaker-names:accept' satisfies InvokeChannel, { ...base, personId })
    return { named: first.chunksNamed > 0 || again.chunksNamed > 0, agreement: true }
  }

  // ----- evaluation (the production `decide` on stored passes) -----

  private async inputs(noteId: string): Promise<EvalInputs | null> {
    const note = await this.ctx.storage.getNote(noteId)
    if (!note) return null
    const final = (await this.ctx.storage.getTranscript(noteId)).filter((c) => c.is_final)
    const passId = currentPassId(final)
    if (!passId) return null
    const s = await this.ctx.settings.getAll()
    const stats = passClusters(final, passId)
    const { identities } = speakerIdentities(final, { live: false })
    const byKey = new Map(identities.map((i) => [i.key, i]))
    const kinds = tileKinds(stats.values(), s['profile.name'].trim())
    const tiles = [...kinds].filter(([, k]) => k === 'individual').map(([name]) => name)
    const cands = await noteCandidates(this.ctx, note, tiles, { withVoice: true })
    const session = await this.ctx.storage.latestSession(noteId).catch(() => null)
    const language = noteLanguage(session?.language ?? null, final)
    const eligible = [...stats.values()].filter((x) => !x.confirmed && byKey.has(x.key) && !byKey.get(x.key)?.suppressed)
    const modelId = getTranscriptionManager(this.ctx).models.speakerId()?.modelId ?? null
    const vectors = modelId ? await this.ctx.storage.listSpeakerClusterVectors({ noteId, passId, modelId }) : []
    const pendingRows = await this.ctx.storage.listSpeakerPending({ noteId }).catch(() => [])
    const pendingMap = pendingByCluster(final, passId, pendingRows)
    const negatives = [
      ...(await this.ctx.storage.listSpeakerNegatives(noteId).catch(() => []))
        .filter((n) => n.passId === passId)
        .map((n) => ({ clusterKey: n.identityKey, personId: n.personId })),
      ...[...pendingMap].flatMap(([clusterKey, people]) => people.map((personId) => ({ clusterKey, personId })))
    ]
    const rows = await this.ctx.storage.listSpeakerNameSuggestions(noteId)
    return {
      noteId,
      passId,
      final,
      stats,
      kinds,
      cands: cands.candidates,
      selfId: cands.self.id,
      hasLinkedEvent: cands.hasLinkedEvent,
      language,
      eligible,
      modelId,
      voice: new Map(vectors.map((v) => [v.label, { vector: v.vector, cleanMs: v.cleanMs }])),
      negatives,
      llm: storedLlm(rows, passId),
      selfVoice: s['speakers.selfVoice']
    }
  }

  /** Every enrolled person as an attendee candidate (the "everyone" gallery scope). */
  private async everyone(base: readonly DecideCandidate[]): Promise<DecideCandidate[]> {
    const out = base.map((c) => ({ ...c }))
    for (const id of Object.keys(this.plan.enrolled)) {
      const personId = await this.personIdOf(id)
      if (!personId) continue
      const had = out.find((c) => c.personId === personId)
      if (had) {
        had.attendee = true
        continue
      }
      const row = await this.ctx.storage.getSpeakerPerson(personId)
      if (!row || row.isSelf) continue
      const agreed = !!(await this.ctx.storage.getSpeakerAgreement(personId).catch(() => null))
      out.push({
        id: personId,
        personId,
        name: row.displayName,
        isSelf: false,
        attendee: true,
        known: false,
        tileIds: [],
        stampedOnSystem: false,
        hasAgreement: agreed,
        autoRecognize: row.autoRecognize
      })
    }
    return out
  }

  /** The gallery of these candidates, with each person's exemplars cut to their first `k` enrollment meetings. */
  private async gallery(modelId: string, candidates: readonly DecideCandidate[], k: number | null): Promise<DecideVoiceSpace[]> {
    const personIds = [...new Set(candidates.map((c) => c.personId).filter((p): p is string => !!p))]
    if (!personIds.length) return []
    const spaces = await this.ctx.storage.speakerVoiceGallery({ modelId, personIds })
    const out: DecideVoiceSpace[] = []
    for (const sp of spaces) {
      let exemplars = sp.exemplars
      const manifestId = this.toManifest.get(sp.personId)
      const notes = manifestId ? this.plan.enrolled[manifestId] : undefined
      if (k !== null && notes) {
        const keep = new Set(notes.slice(0, k))
        const samples = await this.ctx.storage.listSpeakerSamples(sp.personId)
        const noteOf = new Map(samples.map((x) => [x.sampleId, x.noteId]))
        exemplars = exemplars.filter((e) => keep.has(noteOf.get(e.id) ?? ''))
      }
      if (exemplars.length) out.push({ personId: sp.personId, channel: sp.channel, confirmations: sp.confirmations, exemplars: exemplars.map((e) => e.vector) })
    }
    return out
  }

  private mappings(stored: readonly StoredLlm[], candidates: readonly DecideCandidate[]): DecideLlmMapping[] {
    const out: DecideLlmMapping[] = []
    for (const m of stored) {
      const byPerson = m.personId ? candidates.find((c) => c.personId === m.personId) : undefined
      const sameName = !byPerson ? candidates.filter((c) => !c.isSelf && foldName(c.name) === foldName(m.name)) : []
      const target = byPerson ?? (sameName.length === 1 ? sameName[0] : undefined)
      if (target) out.push({ clusterKey: m.clusterKey, candidateId: target.id, name: m.name, evidence: m.evidence, selfIntroduced: m.selfIntroduced })
      else if (m.selfIntroduced) out.push({ clusterKey: m.clusterKey, candidateId: null, name: m.name, evidence: m.evidence, selfIntroduced: true })
    }
    return out
  }

  private async decideVariant(
    x: EvalInputs,
    v: { voice: boolean; app: boolean; llm: boolean; scope: 'attendees' | 'everyone'; k: number | null },
    calibration: SpeakerCalibrationState,
    shuffle = 0
  ): Promise<Map<string, { band: SpeakerBand; person: string | null; src: SpeakerAutoSource | null; candidates: string[] }>> {
    let candidates = v.scope === 'everyone' ? await this.everyone(x.cands) : x.cands.map((c) => ({ ...c }))
    let clusters: DecideCluster[] = x.eligible.map((s) => {
      const voice = x.voice.get(s.label)
      const c = decideCluster(s, x.kinds, x.language, { cleanMs: voice?.cleanMs ?? 0, vector: v.voice && x.modelId ? (voice?.vector ?? null) : null })
      return v.app ? c : { ...c, tiles: [], coverage: 0 }
    })
    let gallery = v.voice && x.modelId ? await this.gallery(x.modelId, candidates, v.k) : []
    let llm = v.llm ? this.mappings(x.llm, candidates) : []
    if (shuffle) {
      clusters = shuffled(clusters, shuffle)
      candidates = shuffled(candidates, shuffle + 1)
      gallery = shuffled(gallery, shuffle + 2).map((g, i) => ({ ...g, exemplars: shuffled(g.exemplars, shuffle + 3 + i) }))
      llm = shuffled(llm, shuffle + 4)
    }
    const r = decide(
      {
        noteId: x.noteId,
        passId: x.passId,
        modelId: x.modelId,
        voices: true,
        selfVoice: x.selfVoice,
        hasLinkedEvent: x.hasLinkedEvent,
        clusters,
        candidates,
        gallery,
        negatives: x.negatives,
        llm
      },
      calibration
    )
    return new Map(
      r.clusters.map((d) => [
        d.key,
        {
          band: d.band,
          person: d.band === 'auto' ? this.manifestOf(d.personId, d.name) : null,
          src: d.autoSrc,
          candidates: d.candidates.map((c) => this.manifestOf(c.personId, c.name))
        }
      ])
    )
  }

  async evaluate(step: EvaluateStep): Promise<void> {
    const shipped = getCalibration(this.ctx)
    let calibration = shipped
    if (step.calibrationPath) {
      const file = parseCalibration(JSON.parse(readFileSync(step.calibrationPath, 'utf8')))
      if (!file) throw new Error('the candidate calibration is invalid')
      calibration = calibrationState(file, speakerIdModelId())
    }
    const foreign = 'f'.repeat(64)
    const notes: unknown[] = []
    let a4Diff = 0
    let a4Clusters = 0
    let a5Spaces = 0
    let a5Voice = 0
    let a2Violations = 0
    let a2Clusters = 0
    for (const n of step.notes) {
      const x = await this.inputs(n.noteId)
      if (!x) {
        notes.push({ tag: n.tag, noteId: n.noteId, passId: null, clusters: [] })
        continue
      }
      try {
        const variants: Record<string, Awaited<ReturnType<Bench['decideVariant']>>> = {}
        const sets = { fused: [true, true, true], voice: [true, false, false], app: [false, true, false], llm: [false, false, true] } as const
        for (const [name, [voice, app, llm]] of Object.entries(sets)) {
          for (const scope of ['attendees', 'everyone'] as const) {
            if (scope === 'everyone' && name !== 'voice' && name !== 'fused') continue
            variants[`${name}:${scope}`] = await this.decideVariant(x, { voice, app, llm, scope, k: null }, calibration)
          }
        }
        for (const k of step.ks) variants[`voice:attendees:k${k}`] = await this.decideVariant(x, { voice: true, app: false, llm: false, scope: 'attendees', k }, calibration)

        // A4: the same input in another order decides the same.
        const again = await this.decideVariant(x, { voice: true, app: true, llm: true, scope: 'attendees', k: null }, calibration, 7 + notes.length)
        for (const [key, d] of variants['fused:attendees'] ?? new Map()) {
          a4Clusters++
          const e = again.get(key)
          if (!e || e.band !== d.band || e.person !== d.person || e.candidates.join() !== d.candidates.join()) a4Diff++
        }
        // A5: no space of another model id, and no voice evidence under another model's calibration.
        if (calibration.file) {
          a5Spaces += (await this.ctx.storage.speakerVoiceGallery({ modelId: foreign })).length
          const other = await this.decideVariant(x, { voice: true, app: false, llm: false, scope: 'attendees', k: null }, calibrationState(calibration.file, foreign))
          for (const d of other.values()) if (d.band !== 'none') a5Voice++
        }

        const segs = this.segments(x.final, this.feedStartOf(n.noteId))
        const enrolledPeople = Object.keys(this.plan.enrolled)
        const galleryAll = x.modelId ? await this.gallery(x.modelId, await this.everyone(x.cands), null) : []
        const clusters = []
        for (const s of x.eligible) {
          const voice = x.voice.get(s.label)
          const cond = conditionFor(calibration, s.channel, x.language, voice?.cleanMs ?? 0)
          const scores: { person: string; cos: number; attendee: boolean; self: boolean; channel: SpeakerChannel }[] = []
          if (voice?.vector) {
            for (const sp of galleryAll) {
              const person = this.manifestOf(sp.personId)
              if (!enrolledPeople.includes(person)) continue
              let best = -1
              for (const e of sp.exemplars) best = Math.max(best, cosine(voice.vector, e))
              const attendee = x.cands.some((c) => c.personId === sp.personId && c.attendee)
              scores.push({ person, cos: Math.round(best * 1e4) / 1e4, attendee, self: sp.personId === x.selfId, channel: sp.channel })
            }
          }
          // A2: voice alone, no candidate above the floor ⇒ none.
          const voiceOnly = variants['voice:attendees']?.get(s.key)
          if (voiceOnly) {
            a2Clusters++
            const maxP = Math.max(
              0,
              ...scores.filter((sc) => sc.attendee || sc.self).map((sc) => sigmoid(cond.logistic.a * sc.cos + cond.logistic.b))
            )
            if (maxP <= cond.floor && voiceOnly.band !== 'none') a2Violations++
          }
          const out: Record<string, unknown> = {}
          for (const [name, map] of Object.entries(variants)) {
            const d = map.get(s.key)
            if (d) out[name] = d
          }
          clusters.push({
            key: s.key,
            label: s.label,
            channel: s.channel,
            speechMs: Math.round(s.speechMs),
            cleanMs: voice ? Math.round(voice.cleanMs) : null,
            segments: segs.get(s.key) ?? [],
            scores,
            decisions: out
          })
        }
        notes.push({ tag: n.tag, noteId: n.noteId, passId: x.passId, language: x.language, composed: n.composed, clusters })
      } finally {
        for (const v of x.voice.values()) v.vector?.fill(0)
      }
    }
    this.results.evaluations.push({ tag: step.tag, calibration: step.calibrationPath ? 'candidate' : 'shipped', voice: calibration.voice, notes })
    this.check(`A2:${step.tag}`, a2Clusters ? (a2Violations ? 'fail' : 'pass') : 'n/a', { clusters: a2Clusters, violations: a2Violations })
    this.check(`A4:${step.tag}:decide`, a4Clusters ? (a4Diff ? 'fail' : 'pass') : 'n/a', { clusters: a4Clusters, differing: a4Diff })
    this.check(`A5:${step.tag}`, calibration.file && step.notes.length ? (a5Spaces || a5Voice ? 'fail' : 'pass') : 'n/a', {
      foreignSpaces: a5Spaces,
      voiceUnderForeignModel: a5Voice,
      note: 'model switch simulated with a foreign model id (one extractor installed)'
    })
  }

  feedStartOf(noteId: string): number {
    return this.results.feeds.find((f) => f.noteId === noteId)?.feedStartMs ?? this.plan.feedStarts[noteId] ?? 0
  }

  check(id: string, status: Check['status'], detail: Record<string, unknown>): void {
    this.results.checks.push({ id, status, detail })
    log('info', 'speaker-bench:check', { id, status })
  }

  // ----- the scenario phase -----

  async confirmedHash(noteId: string): Promise<string> {
    const h = createHash('sha256')
    for (const c of await this.ctx.storage.getTranscript(noteId)) {
      c.providerDetails?.words.forEach((w, i) => h.update(`${c.id}:${i}:${w.confirmed_spk ?? ''}:${w.confirmed_pid ?? ''}\n`))
    }
    return h.digest('hex')
  }

  async bands(noteId: string): Promise<Map<string, { band: SpeakerBand; person: string | null; src: SpeakerAutoSource | null; candidates: string[] }>> {
    const { clusters } = await this.dumpClusters(noteId, 0)
    return new Map(clusters.map((c) => [c.key, { band: c.band, person: c.auto?.person ?? null, src: c.auto?.src ?? null, candidates: c.candidates.map((x) => x.person) }]))
  }

  /** A rerun with A6's hash taken around it. */
  async rerun(noteId: string, a6: { mismatches: number; runs: number }): Promise<string> {
    const before = await this.confirmedHash(noteId)
    const r = await rerunDecision(noteId)
    a6.runs++
    if ((await this.confirmedHash(noteId)) !== before) a6.mismatches++
    return r.status
  }

  async scenarios(step: ScenarioStep): Promise<void> {
    const a6 = { mismatches: 0, runs: 0 }
    const notes = step.notes
    const withPass = async (): Promise<EvalNote[]> => {
      const out: EvalNote[] = []
      for (const n of notes) if (currentPassId((await this.ctx.storage.getTranscript(n.noteId)).filter((c) => c.is_final))) out.push(n)
      return out
    }
    const live = await withPass()
    const truthMap = async (n: EvalNote): Promise<Map<string, string | null>> => {
      const final = (await this.ctx.storage.getTranscript(n.noteId)).filter((c) => c.is_final)
      const passId = currentPassId(final)
      const stats = passId ? passClusters(final, passId) : new Map<string, PassClusterStats>()
      const segs = this.segments(final, this.feedStartOf(n.noteId))
      return new Map([...stats.values()].map((s) => [s.key, truthOf(segs.get(s.key) ?? [], s.channel, n.labels)]))
    }
    const attendeesOf = async (noteId: string): Promise<string[]> => {
      const note = await this.ctx.storage.getNote(noteId)
      return (note?.linked_event?.attendees ?? []).filter((a) => !a.self).map((a) => this.plan.people.find((p) => p.email === a.email.toLowerCase())?.id ?? '').filter(Boolean)
    }

    // A4: shuffled attendees, then a rerun: identical bands.
    {
      let diff = 0
      let total = 0
      for (const [i, n] of live.entries()) {
        const before = await this.bands(n.noteId)
        const att = await attendeesOf(n.noteId)
        await this.writeAttendees(n.noteId, shuffled(att, 31 + i))
        await this.rerun(n.noteId, a6)
        const after = await this.bands(n.noteId)
        for (const [k, b] of before) {
          total++
          const a = after.get(k)
          if (!a || a.band !== b.band || a.person !== b.person) diff++
        }
        await this.writeAttendees(n.noteId, att)
      }
      this.check('A4:rerun', total ? (diff ? 'fail' : 'pass') : 'n/a', { clusters: total, differing: diff })
    }

    // A10: "Not <name>" on a proposed person, then a rerun: never proposed again for that cluster.
    {
      let injected = 0
      let violations = 0
      for (const n of live) {
        for (const [key, b] of await this.bands(n.noteId)) {
          const target = b.person ?? b.candidates[0]
          if (!target || target === 'other' || injected >= 6) continue
          const personId = await this.personIdOf(target)
          if (!personId) continue
          try {
            await until(() => !jobBusy(n.noteId), 30_000)
            await this.invoke('speaker-names:not-person' satisfies InvokeChannel, { noteId: n.noteId, identityKey: key, personId })
            injected++
          } catch (err) {
            this.results.errors.push(`A10 not-person: ${message(err)}`)
            continue
          }
          await sleep(UNDO_WAIT_MS)
          await this.rerun(n.noteId, a6)
          const after = (await this.bands(n.noteId)).get(key)
          if (after && (after.person === target || after.candidates.includes(target))) violations++
        }
      }
      this.check('A10', injected ? (violations ? 'fail' : 'pass') : 'n/a', { negatives: injected, violations })
    }

    // A3: every held-out person enrolled as a non-attendee: no cluster rises to auto.
    {
      let rose = 0
      let compared = 0
      const saved = new Map<string, string[]>()
      for (const n of live) {
        const att = await attendeesOf(n.noteId)
        saved.set(n.noteId, att)
        await this.writeAttendees(n.noteId, att.filter((a) => !step.heldOut.includes(a)))
        await this.rerun(n.noteId, a6)
      }
      const before = new Map<string, Map<string, { band: SpeakerBand }>>()
      for (const n of live) before.set(n.noteId, await this.bands(n.noteId))
      let enrolled = 0
      for (const h of step.heldOutEnroll) {
        const final = (await this.ctx.storage.getTranscript(h.noteId)).filter((c) => c.is_final)
        const passId = currentPassId(final)
        if (!passId) continue
        const { clusters } = await this.dumpClusters(h.noteId, this.feedStartOf(h.noteId))
        const p = this.people.get(h.person)
        const c = clusters.find((x) => !x.confirmed && truthOf(x.segments, x.channel, h.labels) === h.person)
        if (!p || !c) continue
        const r = await this.confirm(h.noteId, passId, c, p, 'en').catch(() => ({ named: false, agreement: false }))
        if (r.named) enrolled++
      }
      if (enrolled) await sleep(UNDO_WAIT_MS)
      for (const n of live) {
        await this.rerun(n.noteId, a6)
        const after = await this.bands(n.noteId)
        for (const [k, b] of before.get(n.noteId) ?? new Map<string, { band: SpeakerBand }>()) {
          compared++
          if (b.band !== 'auto' && after.get(k)?.band === 'auto') rose++
        }
        await this.writeAttendees(n.noteId, saved.get(n.noteId) ?? [])
      }
      this.check('A3', enrolled && compared ? (rose ? 'fail' : 'pass') : 'n/a', { heldOutEnrolled: enrolled, clusters: compared, roseToAuto: rose })
    }

    // A7 (app removed, contradicting LLM), A12 (no-show, extra guest) and A15: re-feeds.
    const baseline = new Map<string, { n: EvalNote; truth: Map<string, string | null>; bands: Awaited<ReturnType<Bench['bands']>> }>()
    // Every baseline note, with or without a pass: a re-feed may get one where the baseline didn't.
    for (const n of notes) baseline.set(n.tag, { n, truth: await truthMap(n), bands: await this.bands(n.noteId) })
    const refeeds: { kind: string; base: string; meeting: FeedMeeting; dump: NoteDump }[] = []
    for (const { tag, meeting: m } of step.refeed) {
      if (!baseline.has(tag)) continue
      const add = async (kind: string, meeting: FeedMeeting, llm?: FeedStep['llm']): Promise<void> => {
        refeeds.push({ kind, base: tag, meeting, dump: await this.feed({ kind: 'feed', tag: `${tag}~${kind}`, meeting, ...(llm ? { llm } : {}) }) })
      }
      try {
        if (m.uia) await add('no-app', { ...m, uia: null })
        await add('contradict', m, 'mock-contradict')
        const att = m.attendees.filter((a) => !this.people.get(a)?.self)
        const noShow = this.plan.people.find((p) => !p.self && !att.includes(p.id) && !m.labels.some((l) => l.person === p.id))
        if (noShow) await add('no-show', { ...m, attendees: [...m.attendees, noShow.id] })
        const guest = att.find((a) => m.labels.some((l) => l.person === a))
        if (guest) await add('extra-guest', { ...m, attendees: m.attendees.filter((a) => a !== guest) })
      } catch (err) {
        this.results.errors.push(`refeed ${tag}: ${message(err)}`)
      }
    }
    for (const r of refeeds) this.results.feeds.push(r.dump)
    {
      // A7: each baseline auto cluster, by its labelled person, against the same person in the re-feed.
      let appDropped = 0
      let appKept = 0
      let contradictedDropped = 0
      let contradictedKept = 0
      for (const r of refeeds) {
        const base = baseline.get(r.base)
        if (!base || (r.kind !== 'no-app' && r.kind !== 'contradict')) continue
        const autoBy = new Map<string, SpeakerAutoSource | null>()
        for (const [k, b] of base.bands) {
          const t = base.truth.get(k)
          if (t && b.band === 'auto') autoBy.set(t, b.src)
        }
        for (const c of r.dump.clusters) {
          const t = truthOf(c.segments, c.channel, r.meeting.labels)
          if (!t || !autoBy.has(t)) continue
          const src = autoBy.get(t)
          if (r.kind === 'no-app' && src === 'app') {
            if (c.band === 'auto') appKept++
            else appDropped++
          }
          if (r.kind === 'contradict') {
            if (c.band === 'auto' && c.auto?.person === t) contradictedKept++
            else contradictedDropped++
          }
        }
      }
      const any = appDropped + appKept + contradictedDropped + contradictedKept
      this.check('A7:app-removed+contradicted', any ? (appKept || contradictedKept ? 'fail' : 'pass') : 'n/a', { appDropped, appKept, contradictedDropped, contradictedKept })
    }
    {
      // A12: no elimination suggestion when speakers ≠ attendees + the user.
      let rows = 0
      let elimination = 0
      for (const r of refeeds) {
        if (r.kind !== 'no-show' && r.kind !== 'extra-guest') continue
        for (const s of await this.ctx.storage.listSpeakerNameSuggestions(r.dump.noteId)) {
          rows++
          if (s.evidenceTypes.includes('elimination') || s.candidates.some((c) => c.source === 'elimination')) elimination++
        }
      }
      this.check('A12', refeeds.some((r) => r.kind === 'no-show' || r.kind === 'extra-guest') ? (elimination ? 'fail' : 'pass') : 'n/a', { rows, elimination })
    }

    // A15: no suggest or tie name as a speaker label in what goes out: the summary prompt's
    // transcript (with Separate speakers as set, and off), a chat readTranscript and a webhook body.
    {
      const { buildPromptInputs } = await import('../enhance/inputs')
      const { P2_TOOLS, runLocalTool } = await import('../chat/tools')
      const { buildBody } = await import('../webhooks')
      const readTranscript = P2_TOOLS.find((t) => t.def.name === 'readTranscript')
      let checked = 0
      let leaks = 0
      let letters = 0
      const leaksBy: Record<string, number> = { prompt: 0, promptNoSeparation: 0, chat: 0, webhook: 0 }
      const s = await this.ctx.settings.getAll()
      const lineLabels = (text: string): string[] =>
        text
          .split('\n')
          .map((l) => /^([^:]{1,80}): /.exec(l)?.[1]?.trim() ?? '')
          .filter(Boolean)
      for (const id of [...live.map((n) => n.noteId), ...refeeds.map((r) => r.dump.noteId)]) {
        const rows = (await this.ctx.storage.listSpeakerNameSuggestions(id)).filter((r) => r.band === 'suggest' || r.band === 'tie')
        if (!rows.length) continue
        const note = await this.ctx.storage.getNote(id)
        const chunks = await this.ctx.storage.getTranscript(id)
        const { identities } = speakerIdentities(chunks.filter((c) => c.is_final), { live: false })
        const named = new Set(identities.filter((i) => i.name).map((i) => foldName(i.name as string)))
        const outputs: Record<string, string[]> = {}
        for (const [kind, settings] of [
          ['prompt', s],
          ['promptNoSeparation', { ...s, 'transcription.diarization': false }]
        ] as const) {
          const { vars } = buildPromptInputs({ note, chunks, settings, language: s['asr.language'], locale: app.getLocale() })
          outputs[kind] = lineLabels(String(vars['transcript'] ?? ''))
        }
        if (readTranscript) {
          const env = {
            ctx: this.ctx,
            place: { kind: 'meeting' as const, noteId: id },
            threadId: 'speaker-bench',
            signal: new AbortController().signal,
            noteId: id,
            target: null,
            latestSummaryPanelId: null,
            rewriteStarted: false,
            scanned: new Map(),
            windows: new Map()
          }
          outputs['chat'] = lineLabels((await runLocalTool(readTranscript, { meetingId: id }, env)).content)
        }
        const body = await buildBody(this.ctx, { eventId: 'speaker-bench', eventType: 'note.summarized', occurredAt: new Date().toISOString(), note, includeTranscript: true, automation: null, test: true })
        const transcript = (JSON.parse(body) as { note?: { transcript?: { speaker?: string }[] } }).note?.transcript ?? []
        outputs['webhook'] = transcript.map((t) => t.speaker ?? '').filter(Boolean)
        checked++
        for (const [kind, labels] of Object.entries(outputs)) {
          for (const r of rows) {
            for (const c of r.candidates) {
              if (named.has(foldName(c.name)) || !labels.some((l) => foldName(l) === foldName(c.name))) continue
              leaks++
              leaksBy[kind] = (leaksBy[kind] ?? 0) + 1
            }
          }
        }
        if ((outputs['prompt'] ?? []).some((l) => /^Speaker [A-Z]+$/.test(l))) letters++
      }
      this.check('A15', checked ? (leaks ? 'fail' : 'pass') : 'n/a', { notes: checked, leaks, leaksBy, notesWithLetters: letters })
    }

    // A6 (relabel): no confirmed word changes, no LLM call, no auto lowered.
    {
      let lowered = 0
      let runs = 0
      const restore = await this.useMock('abstain')
      const calls = this.mockCalls
      try {
        const before = new Map<string, { hash: string; bands: Awaited<ReturnType<Bench['bands']>> }>()
        for (const n of live) before.set(n.noteId, { hash: await this.confirmedHash(n.noteId), bands: await this.bands(n.noteId) })
        for (const id of Object.keys(this.plan.enrolled).slice(0, 3)) {
          const personId = await this.personIdOf(id)
          if (!personId) continue
          await requestRelabel(this.ctx, personId)
          runs++
        }
        for (const n of live) {
          const b = before.get(n.noteId)
          if (!b) continue
          if ((await this.confirmedHash(n.noteId)) !== b.hash) a6.mismatches++
          const after = await this.bands(n.noteId)
          for (const [k, x] of b.bands) if (x.band === 'auto' && after.get(k)?.band !== 'auto') lowered++
        }
      } finally {
        await restore()
      }
      this.check('A6', runs || a6.runs ? (a6.mismatches || lowered || this.mockCalls !== calls ? 'fail' : 'pass') : 'n/a', {
        reruns: a6.runs,
        relabels: runs,
        confirmedChanged: a6.mismatches,
        autoLowered: lowered,
        llmCallsDuringRelabel: this.mockCalls - calls
      })
    }

    // A13: Remember voice with no agreement adds no exemplar.
    {
      const target = live.find((n) => n.noteId)
      let status: Check['status'] = 'n/a'
      const detail: Record<string, unknown> = {}
      if (target) {
        const final = (await this.ctx.storage.getTranscript(target.noteId)).filter((c) => c.is_final)
        const passId = currentPassId(final)
        const free = passId ? (await this.dumpClusters(target.noteId, 0)).clusters.find((c) => !c.confirmed && c.band !== 'auto') : undefined
        if (passId && free) {
          const nobody: BenchPerson = { id: 'bench-nobody', name: 'Bench Nobody', email: `nobody-${this.plan.runId}@bench.invalid` }
          this.people.set(nobody.id, nobody)
          await this.confirm(target.noteId, passId, free, nobody, 'en', { agree: false })
          await sleep(UNDO_WAIT_MS)
          const pid = await this.personIdOf(nobody.id)
          const samples = pid ? await this.ctx.storage.listSpeakerSamples(pid) : []
          status = samples.length ? 'fail' : 'pass'
          detail['exemplars'] = samples.length
        }
      }
      this.check('A13', status, detail)
    }

    // A11 and A8: the weighted mean and the cap.
    await this.meanAndCap(live)

    // A16: a re-pass and a Forget during a job; a confirmation during a relabel.
    await this.races(step, live)

    // A7 (voice off): every voice-only auto drops; app+voice drops once both are gone.
    {
      const beforeVoice = new Map<string, Awaited<ReturnType<Bench['bands']>>>()
      const noApp = refeeds.filter((r) => r.kind === 'no-app')
      for (const n of live) beforeVoice.set(n.noteId, await this.bands(n.noteId))
      for (const r of noApp) beforeVoice.set(r.dump.noteId, await this.bands(r.dump.noteId))
      await this.ctx.settings.set('speakers.voices', false)
      await sleep(1_500)
      let voiceKept = 0
      let voiceDropped = 0
      let bothKept = 0
      let bothDropped = 0
      for (const [noteId, before] of beforeVoice) {
        await this.rerun(noteId, a6)
        const after = await this.bands(noteId)
        const isNoApp = noApp.some((r) => r.dump.noteId === noteId)
        for (const [k, b] of before) {
          if (b.band !== 'auto') continue
          const a = after.get(k)
          if (b.src === 'voice') {
            if (a?.band === 'auto') voiceKept++
            else voiceDropped++
          }
          if (b.src === 'app+voice' && isNoApp) {
            if (a?.band === 'auto') bothKept++
            else bothDropped++
          }
        }
      }
      await this.ctx.settings.set('speakers.voices', true)
      const any = voiceKept + voiceDropped + bothKept + bothDropped
      this.check('A7:voice-off', any ? (voiceKept || bothKept ? 'fail' : 'pass') : 'n/a', { voiceDropped, voiceKept, appVoiceDropped: bothDropped, appVoiceKept: bothKept })
    }

    // A9: Forget, then Forget all, with a decrypted byte copy scanned for the vectors.
    await this.forget(live)
  }

  private async meanAndCap(live: EvalNote[]): Promise<void> {
    const modelId = getTranscriptionManager(this.ctx).models.speakerId()?.modelId ?? null
    // A11: an impostor cluster confirmed as an enrolled person under the cap.
    {
      let status: Check['status'] = 'n/a'
      const detail: Record<string, unknown> = {}
      outer: for (const n of live) {
        if (!modelId) break
        const final = (await this.ctx.storage.getTranscript(n.noteId)).filter((c) => c.is_final)
        const passId = currentPassId(final)
        if (!passId) continue
        const { clusters } = await this.dumpClusters(n.noteId, this.feedStartOf(n.noteId))
        const vectors = await this.ctx.storage.listSpeakerClusterVectors({ noteId: n.noteId, passId, modelId })
        try {
          for (const c of clusters) {
            const truth = truthOf(c.segments, c.channel, n.labels)
            const vec = vectors.find((v) => v.label === c.label)
            if (c.confirmed || !vec) continue
            const ana = Object.keys(this.plan.enrolled).find((p) => p !== truth && !this.people.get(p)?.self)
            const pid = ana ? await this.personIdOf(ana) : null
            if (!ana || !pid) continue
            const channel = c.channel
            const space = (await this.ctx.storage.speakerVoiceGallery({ modelId, personIds: [pid] })).find((s) => s.channel === channel)
            if (!space || space.count >= SPEAKER_PROFILE_LIMITS.exemplarCap) continue
            const sumW = space.exemplars.reduce((a, e) => a + e.weight, 0)
            const dim = vec.vector.length
            const m0 = new Float64Array(dim)
            for (const e of space.exemplars) for (let i = 0; i < dim; i++) m0[i] = (m0[i] as number) + (e.weight * (e.vector[i] as number)) / sumW
            const w = Math.min(1, vec.cleanMs / SPEAKER_PROFILE_LIMITS.exemplarWeightFullMs)
            await this.confirm(n.noteId, passId, c, this.people.get(ana) as BenchPerson, 'en')
            await sleep(UNDO_WAIT_MS)
            const after = (await this.ctx.storage.speakerVoiceGallery({ modelId, personIds: [pid] })).find((s) => s.channel === channel)
            const added = !!after && after.count === space.count + 1
            detail['added'] = added
            if (!after || !added) {
              detail['note'] = 'the exemplar was not added (far-from-profile guard or cap)'
              break outer
            }
            const sumW1 = after.exemplars.reduce((a, e) => a + e.weight, 0)
            const m1 = new Float64Array(dim)
            for (const e of after.exemplars) for (let i = 0; i < dim; i++) m1[i] = (m1[i] as number) + (e.weight * (e.vector[i] as number)) / sumW1
            // The move toward the new vector is exactly w / Σw of the way, and the stored centroid follows the mean.
            let err = 0
            for (let i = 0; i < dim; i++) {
              const expected = (m0[i] as number) + (w / sumW1) * ((vec.vector[i] as number) - (m0[i] as number))
              err = Math.max(err, Math.abs((m1[i] as number) - expected))
            }
            const centroidCos = cosine(after.centroid, Float32Array.from(m1))
            detail['maxError'] = Number(err.toExponential(2))
            detail['centroidCosine'] = Math.round(centroidCos * 1e6) / 1e6
            status = err < 1e-4 && centroidCos > 0.9999 ? 'pass' : 'fail'
            for (const e of [...space.exemplars, ...after.exemplars]) e.vector.fill(0)
            after.centroid.fill(0)
            break outer
          }
        } finally {
          for (const v of vectors) v.vector.fill(0)
        }
      }
      this.check('A11', status, detail)
    }
    // A8: many confirmations of one person, then a merge: no space over the cap.
    {
      const target = Object.keys(this.plan.enrolled).find((p) => !this.people.get(p)?.self)
      let confirmations = 0
      if (target && modelId) {
        const p = this.people.get(target) as BenchPerson
        for (const n of live) {
          if (confirmations >= 40) break
          const final = (await this.ctx.storage.getTranscript(n.noteId)).filter((c) => c.is_final)
          const passId = currentPassId(final)
          if (!passId) continue
          for (const c of (await this.dumpClusters(n.noteId, this.feedStartOf(n.noteId))).clusters) {
            if (c.confirmed || confirmations >= 40 || truthOf(c.segments, c.channel, n.labels) !== target) continue
            const r = await this.confirm(n.noteId, passId, c, p, 'en').catch(() => ({ named: false, agreement: false }))
            if (r.named) confirmations++
          }
        }
        if (confirmations) await sleep(UNDO_WAIT_MS)
      }
      const into = target ? await this.personIdOf(target) : null
      const fromManifest = Object.keys(this.plan.enrolled).find((p) => p !== target && !this.people.get(p)?.self)
      const from = fromManifest ? await this.personIdOf(fromManifest) : null
      let merged = false
      if (into && from) {
        try {
          await this.invoke('speaker-people:merge' satisfies InvokeChannel, { fromId: from, intoId: into, confirmed: true })
          merged = true
          if (fromManifest) {
            this.toPerson.delete(fromManifest)
            this.toManifest.delete(from)
          }
        } catch (err) {
          this.results.errors.push(`A8 merge: ${message(err)}`)
        }
      }
      const spaces = modelId && into ? await this.ctx.storage.speakerVoiceGallery({ modelId }) : []
      const over = spaces.filter((s) => s.count > SPEAKER_PROFILE_LIMITS.exemplarCap).length
      const maxCount = Math.max(0, ...spaces.map((s) => s.count))
      for (const s of spaces) {
        s.centroid.fill(0)
        for (const e of s.exemplars) e.vector.fill(0)
      }
      this.check('A8', confirmations || merged ? (over ? 'fail' : 'pass') : 'n/a', { confirmations, merged, spaces: spaces.length, maxCount, overCap: over })
    }
  }

  private async races(step: ScenarioStep, live: EvalNote[]): Promise<void> {
    const detail: Record<string, unknown> = {}
    let status: Check['status'] = 'n/a'
    const m = step.refeed[0]?.meeting
    const victimManifest = m?.attendees.find((a) => this.plan.enrolled[a] && !this.people.get(a)?.self)
    const victim = victimManifest ? await this.personIdOf(victimManifest) : null
    if (m && victim && victimManifest) {
      // A Forget while the re-fed meeting's job decides: no auto_* from the forgotten voice.
      let done = false
      const job = this.feed({ kind: 'feed', tag: `${step.refeed[0]?.tag ?? m.id}~race`, meeting: m }).finally(() => {
        done = true
      })
      const raced = await until(() => {
        const id = this.feeding
        return done || (!!id && !!this.jobTimes.get(id)?.['deciding'])
      }, 30 * 60_000, 50)
      const inJob = raced && !done
      await this.invoke('speaker-people:forget-voice' satisfies InvokeChannel, { personId: victim, reason: 'forget', confirmed: true }).catch((err: unknown) => {
        this.results.errors.push(`A16 forget: ${message(err)}`)
      })
      const dump = await job
      this.results.feeds.push(dump)
      const fromForgotten = dump.clusters.filter((c) => c.band === 'auto' && c.auto?.person === victimManifest && c.auto.src !== 'app').length
      detail['forgetDuringJob'] = { raced: inJob, voiceAutoFromForgotten: fromForgotten, jobState: dump.job.state }
      if (inJob) status = fromForgotten ? 'fail' : 'pass'
      delete this.plan.enrolled[victimManifest]
    }
    // A confirmation while a relabel runs: that cluster gets no auto_* and no suggestion row from it.
    const someone = Object.keys(this.plan.enrolled).find((p) => !this.people.get(p)?.self)
    const pid = someone ? await this.personIdOf(someone) : null
    const target = live[0]
    if (pid && target) {
      const final = (await this.ctx.storage.getTranscript(target.noteId)).filter((c) => c.is_final)
      const passId = currentPassId(final)
      const free = passId ? (await this.dumpClusters(target.noteId, 0)).clusters.find((c) => !c.confirmed && c.band !== 'auto') : undefined
      if (passId && free) {
        const relabel = requestRelabel(this.ctx, pid)
        const p: BenchPerson = { id: 'bench-race', name: 'Bench Race', email: `race-${this.plan.runId}@bench.invalid` }
        this.people.set(p.id, p)
        await this.invoke('speaker-names:accept' satisfies InvokeChannel, {
          noteId: target.noteId,
          identityKey: free.key,
          name: p.name,
          edited: true,
          chosenFromList: false,
          newName: p.name,
          remember: false,
          scope: 'speaker',
          passId
        }).catch((err: unknown) => this.results.errors.push(`A16 accept: ${message(err)}`))
        await relabel.catch(() => undefined)
        await sleep(UNDO_WAIT_MS)
        const after = (await this.dumpClusters(target.noteId, 0)).clusters.find((c) => c.key === free.key)
        const row = (await this.ctx.storage.listSpeakerNameSuggestions(target.noteId)).find((r) => r.identityKey === free.key)
        const bad = !!after?.auto || !!row
        detail['confirmDuringRelabel'] = { autoOnConfirmed: !!after?.auto, rowOnConfirmed: !!row }
        status = bad ? 'fail' : status === 'fail' ? 'fail' : 'pass'
      }
    }
    // A re-pass during a job is the job's recompute-once path; the bench can only trigger it when temp audio remains.
    if (m && m.audio.length) detail['repassDuringJob'] = 'not forced: a re-pass needs the note temp audio, which the pass consumes'
    this.check('A16', status, detail)
  }

  private async forget(live: EvalNote[]): Promise<void> {
    const modelId = getTranscriptionManager(this.ctx).models.speakerId()?.modelId ?? null
    const victimManifest = Object.keys(this.plan.enrolled).find((p) => !this.people.get(p)?.self)
    const victim = victimManifest ? await this.personIdOf(victimManifest) : null
    const dataDir = join(this.ctx.userDataPath, 'data')
    // A9 (Forget one person).
    {
      const detail: Record<string, unknown> = {}
      let status: Check['status'] = 'n/a'
      if (victim && modelId) {
        const spaces = await this.ctx.storage.speakerVoiceGallery({ modelId, personIds: [victim] })
        const needles = spaces.flatMap((s) => [s.centroid, ...s.exemplars.map((e) => e.vector)]).map((v) => Buffer.from(new Uint8Array(v.buffer, v.byteOffset, Math.min(64, v.byteLength))))
        await this.invoke('speaker-people:forget-voice' satisfies InvokeChannel, { personId: victim, reason: 'forget', confirmed: true })
        await sleep(1_000)
        const left = await this.ctx.storage.speakerVoiceGallery({ modelId, personIds: [victim] })
        const samples = await this.ctx.storage.listSpeakerSamples(victim)
        const scan = this.scanDatabase(dataDir, needles)
        detail['vectorsBefore'] = needles.length
        detail['spacesLeft'] = left.length
        detail['samplesLeft'] = samples.length
        detail['scan'] = scan
        let voiceAfter = 0
        for (const n of live) {
          await rerunDecision(n.noteId).catch(() => null)
          for (const r of await this.ctx.storage.listSpeakerNameSuggestions(n.noteId)) {
            if (r.candidates.some((c) => c.personId === victim && c.source === 'voice')) voiceAfter++
          }
        }
        detail['voiceEvidenceAfter'] = voiceAfter
        status = left.length || samples.length || !scan.decrypted || scan.found || voiceAfter ? 'fail' : 'pass'
        for (const s of [...spaces, ...left]) {
          s.centroid.fill(0)
          for (const e of s.exemplars) e.vector.fill(0)
        }
        needles.forEach((b) => b.fill(0))
      } else {
        detail['scan'] = this.scanDatabase(dataDir, [])
      }
      this.check('A9:forget', status, detail)
    }
    // A9 (Forget all): also every cluster vector.
    {
      const needles: Buffer[] = []
      if (modelId) {
        for (const n of live) {
          for (const v of await this.ctx.storage.listSpeakerClusterVectors({ noteId: n.noteId })) {
            needles.push(Buffer.from(new Uint8Array(v.vector.buffer, v.vector.byteOffset, Math.min(64, v.vector.byteLength))))
            v.vector.fill(0)
          }
        }
        for (const s of await this.ctx.storage.speakerVoiceGallery({ modelId })) {
          needles.push(Buffer.from(new Uint8Array(s.centroid.buffer, s.centroid.byteOffset, Math.min(64, s.centroid.byteLength))))
          s.centroid.fill(0)
          for (const e of s.exemplars) e.vector.fill(0)
        }
      }
      await this.invoke('speakers:forget-all' satisfies InvokeChannel, { confirmed: true })
      await sleep(1_000)
      const vectorsLeft = modelId ? (await this.ctx.storage.notesWithSpeakerClusterVectors({ modelId })).length : 0
      const spacesLeft = modelId ? (await this.ctx.storage.speakerVoiceGallery({ modelId })).length : 0
      const scan = this.scanDatabase(dataDir, needles)
      needles.forEach((b) => b.fill(0))
      const ran = needles.length > 0
      this.check('A9:forget-all', ran ? (vectorsLeft || spacesLeft || !scan.decrypted || scan.found ? 'fail' : 'pass') : 'n/a', {
        vectorsBefore: needles.length,
        notesWithVectorsLeft: vectorsLeft,
        spacesLeft,
        scan
      })
    }
  }

  /**
   * A byte copy of the database file (after Forget's TRUNCATE checkpoint) and its WAL, decrypted
   * page by page with the scratch profile's key (SQLCipher 4: AES-256-CBC, the IV in each page's
   * reserved tail, page 1 behind a 16-byte salt), every page scanned, free pages included. The
   * decrypted bytes never touch the disk; the encrypted copy is deleted.
   */
  scanDatabase(dataDir: string, needles: readonly Buffer[]): { decrypted: boolean; pages: number; walPages: number; found: number } {
    const key = loadOrCreateKey(dataDir)
    if (!key.ok) return { decrypted: false, pages: 0, walPages: 0, found: 0 }
    const k = Buffer.from(key.keyHex, 'hex')
    const tmp = join(this.ctx.userDataPath, 'speaker-bench-scan')
    mkdirSync(tmp, { recursive: true })
    const PAGE = 4096
    const RESERVE = 80
    let pages = 0
    let walPages = 0
    let found = 0
    let decrypted = false
    const decryptPage = (page: Buffer, first: boolean): Buffer => {
      const iv = page.subarray(PAGE - RESERVE, PAGE - RESERVE + 16)
      const body = page.subarray(first ? 16 : 0, PAGE - RESERVE)
      const d = createDecipheriv('aes-256-cbc', k, iv)
      d.setAutoPadding(false)
      return Buffer.concat([d.update(body), d.final()])
    }
    const look = (plain: Buffer): void => {
      for (const n of needles) if (n.length >= 16 && plain.includes(n)) found++
    }
    try {
      const db = join(tmp, 'copy.db')
      copyFileSync(join(dataDir, DB_FILE), db)
      const bytes = readFileSync(db)
      for (let off = 0; off + PAGE <= bytes.length; off += PAGE) {
        const plain = decryptPage(bytes.subarray(off, off + PAGE), off === 0)
        // Page 1's header after the salt: max/min payload fractions and leaf fraction (64, 32, 32).
        if (off === 0) decrypted = plain[5] === 64 && plain[6] === 32 && plain[7] === 32
        look(plain)
        plain.fill(0)
        pages++
      }
      bytes.fill(0)
      const walPath = join(dataDir, `${DB_FILE}-wal`)
      if (existsSync(walPath) && statSync(walPath).size > 32) {
        const wal = join(tmp, 'copy.db-wal')
        copyFileSync(walPath, wal)
        const w = readFileSync(wal)
        for (let off = 32; off + 24 + PAGE <= w.length; off += 24 + PAGE) {
          const pageNo = w.readUInt32BE(off)
          const plain = decryptPage(w.subarray(off + 24, off + 24 + PAGE), pageNo === 1)
          look(plain)
          plain.fill(0)
          walPages++
        }
        w.fill(0)
      }
    } catch (err) {
      this.results.errors.push(`scan: ${message(err)}`)
    } finally {
      k.fill(0)
      rmSync(tmp, { recursive: true, force: true })
    }
    return { decrypted, pages, walPages, found }
  }

  /** A14 on the logs: vector-like float runs, and the agreement and evidence texts the run used. */
  scanLogs(): void {
    const dir = join(this.ctx.userDataPath, 'logs')
    let files = 0
    let vectors = 0
    let notice = 0
    let evidence = 0
    const walk = (d: string): void => {
      if (!existsSync(d)) return
      for (const name of readdirSync(d)) {
        const p = join(d, name)
        if (statSync(p).isDirectory()) walk(p)
        else {
          files++
          const text = readFileSync(p, 'utf8')
          vectors += (text.match(/(-?\d+\.\d+\s*,\s*){31,}-?\d+\.\d+/g) ?? []).length
          for (const n of this.secrets.notice) if (text.includes(n.slice(0, 80))) notice++
          for (const e of this.secrets.evidence) if (text.includes(e)) evidence++
        }
      }
    }
    walk(dir)
    this.results.logScan = { files, vectors, notice, evidence }
    const t = this.results.trace
    this.check('A14', vectors || notice || evidence || t.findings.length ? 'fail' : 'pass', {
      logFiles: files,
      logVectors: vectors,
      logNotice: notice,
      logEvidence: evidence,
      invokes: t.invokes,
      pushes: t.pushes,
      ipcFindings: t.findings.length,
      textsTracked: this.secrets.notice.size + this.secrets.evidence.size
    })
  }

  // ----- labels (the dev names each cluster once, the bench exports the map) -----

  async exportLabels(step: ExportLabelsStep): Promise<void> {
    await this.loadPeople()
    for (const n of step.notes) {
      const final = (await this.ctx.storage.getTranscript(n.noteId)).filter((c) => c.is_final)
      const spans: LabelSpan[] = []
      for (const c of [...final].sort((a, b) => Date.parse(a.start_timestamp) - Date.parse(b.start_timestamp))) {
        const d = c.providerDetails
        if (!d) continue
        const channel: SpeakerChannel = c.source === 'microphone' ? 'mic' : 'system'
        for (const w of d.words) {
          if (!w.confirmed_spk) continue
          let person = this.manifestOf(w.confirmed_pid ?? null, w.confirmed_spk)
          if (person === 'other' && w.confirmed_pid) {
            const row = await this.ctx.storage.getSpeakerPerson(w.confirmed_pid, { resolveMerged: true })
            const byEmail = row?.email ? this.plan.people.find((p) => p.email === row.email) : undefined
            person = byEmail?.id ?? (row?.isSelf ? (this.plan.people.find((p) => p.self)?.id ?? 'other') : 'other')
          }
          const s = Math.round(d.wallClockAnchorMs + w.s_ms - n.feedStartMs)
          const e = Math.round(d.wallClockAnchorMs + w.e_ms - n.feedStartMs)
          const last = spans[spans.length - 1]
          if (last && last.person === person && last.channel === channel && s - last.endMs < 1_000) last.endMs = Math.max(last.endMs, e)
          else spans.push({ channel, startMs: s, endMs: e, person })
        }
      }
      mkdirSync(dirname(n.outPath), { recursive: true })
      writeFileSync(n.outPath, JSON.stringify({ meeting: n.meetingId, spans }, null, 1))
      this.results.labelsExported.push({ meetingId: n.meetingId, spans: spans.length })
    }
  }
}

interface EvalInputs {
  noteId: string
  passId: string
  final: TranscriptChunk[]
  stats: Map<string, PassClusterStats>
  kinds: ReturnType<typeof tileKinds>
  cands: DecideCandidate[]
  selfId: string
  hasLinkedEvent: boolean
  language: ReturnType<typeof noteLanguage>
  eligible: PassClusterStats[]
  modelId: string | null
  voice: Map<string, { vector: Float32Array; cleanMs: number }>
  negatives: { clusterKey: string; personId: string }[]
  llm: StoredLlm[]
  selfVoice: boolean
}

async function runBench(ctx: MainContext, planPath: string): Promise<void> {
  const plan = JSON.parse(readFileSync(planPath, 'utf8')) as BenchPlan
  if (plan.version !== 1) throw new Error('unknown plan version')
  log('info', 'speaker-bench:start', { steps: plan.steps.length, dry: plan.dry })
  const bench = new Bench(ctx, plan)
  const ready = await until(async () => (await ctx.storage.status()).state === 'ready', 120_000, 500)
  if (!ready) throw new Error('storage never became ready')
  bench.openTrace()
  try {
    for (const [k, v] of Object.entries(plan.settings)) await ctx.settings.set(k as keyof Settings, v as never)
    const key = plan.secret ? process.env[plan.secret.env] : undefined
    if (plan.secret && key) await ctx.secrets.set(plan.secret.id, key)
    if (plan.mockProvider) await bench.useMock('abstain')
    await sleep(1_000)
    const manager = getTranscriptionManager(ctx)
    bench.results.modelId = manager.models.speakerId()?.modelId ?? null
    bench.results.asrReady = (await manager.registry.local.available('en')).ok
    const cal = getCalibration(ctx)
    bench.results.calibration = cal.voice ? { voice: true } : { voice: false, reason: cal.reason }
    await bench.loadPeople()
    for (const step of plan.steps) {
      try {
        if (step.kind === 'feed') bench.results.feeds.push(await bench.feed(step))
        else if (step.kind === 'evaluate') await bench.evaluate(step)
        else if (step.kind === 'scenarios') await bench.scenarios(step)
        else if (step.kind === 'export-labels') await bench.exportLabels(step)
      } catch (err) {
        bench.results.errors.push(`${step.kind}${'tag' in step ? ` ${step.tag}` : ''}: ${message(err)}`)
        log('warn', 'speaker-bench:step-failed', { kind: step.kind })
      }
      bench.save()
    }
    if (plan.steps.some((s) => s.kind === 'scenarios')) bench.scanLogs()
  } finally {
    bench.results.endedAt = new Date().toISOString()
    bench.save()
    log('info', 'speaker-bench:done', { errors: bench.results.errors.length })
    app.quit()
  }
}
