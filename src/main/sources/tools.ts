// SPDX-License-Identifier: Apache-2.0
// Managed yt-dlp: download into `<userData>/tools/yt-dlp/` after lookups are granted,
// SHA-256 against the release's checksum file, weekly updates, a newer PATH copy preferred.
//
// Every run is `--ignore-config`, never with cookie options, one job at a time and ≥ 2 s apart,
// with an egress check before spawning (the socket guard doesn't cover child processes). Logs
// carry exit codes and counts only, never stderr.
//
// - The binary is downloaded only on the user's click (`sources:tools-download`, after the size
//   and licence are shown), never silently on first need. Only Windows (`yt-dlp.exe`).
// - Release: `github.com/yt-dlp/yt-dlp/releases/latest` resolves the tag; `yt-dlp.exe` and
//   `SHA2-256SUMS` come from that tag. The binary streams into `yt-dlp.exe.partial` while it is
//   hashed; only a matching digest replaces the installed copy. `meta.json` records the version,
//   digest and the last update check.
// - Updates: checked in the background at most weekly while lookups are granted and the mode is
//   `managed`. A newer copy on PATH is used instead (`external`).
// - Back-off: after 3 failed runs in 10 min, runs pause for 30 min.

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, open, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { ipcMain, net } from 'electron'
import { notulaError } from '@shared/errors'
import type { InvokeChannel, InvokeReq, PushChannel } from '@shared/ipc'
import type { ToolsStatus } from '@shared/types/sources'
import type { MainContext } from '../context'
import { expected } from '../ipc-expected'
import { log } from '../log'
import { assertEgress, egressFetch } from '../net/egress'
import { egressBlocked, isLocalOnly } from '../privacy'

export type YtDlpPurpose = 'search' | 'metadata' | 'captions'

export interface YtDlpJob {
  purpose: YtDlpPurpose
  /** Without `--ignore-config`, which the runner always adds. */
  args: string[]
  /** search 10 s, metadata 15 s, captions 60 s by default. */
  timeoutMs?: number
  signal?: AbortSignal
}

export type YtDlpResult =
  | { ok: true; stdout: string; exitCode: 0 }
  | { ok: false; reason: 'not-ready' | 'local-only' | 'off' | 'paused' | 'timeout' | 'failed'; exitCode: number | null }

const RELEASES = 'https://github.com/yt-dlp/yt-dlp/releases'
const EXE = 'yt-dlp.exe'
const SUMS = 'SHA2-256SUMS'
const META = 'meta.json'
/** Shown before the download (about 18 MB). */
const SIZE_ESTIMATE = 18 * 1024 * 1024
const DOWNLOAD_CAP = 64 * 1024 * 1024
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000
const UPDATE_EVERY_MS = 7 * 24 * 60 * 60_000
const UPDATE_TICK_MS = 6 * 60 * 60_000
const PATH_RECHECK_MS = 60 * 60_000
const VERSION_TIMEOUT_MS = 10_000
const TIMEOUTS: Record<YtDlpPurpose, number> = { search: 10_000, metadata: 15_000, captions: 60_000 }
const JOB_GAP_MS = 2_000
const FAILURES_TO_PAUSE = 3
const FAILURE_WINDOW_MS = 10 * 60_000
const PAUSE_MS = 30 * 60_000
const STDOUT_CAP = 48 * 1024 * 1024
const TAG = /^\d{4}\.\d{2}\.\d{2}(\.\d+)?$/
/** The `latest` page answers its redirect within this long. */
const LATEST_TIMEOUT_MS = 15_000
/**
 * Options a caller may never pass: cookies, credentials and headers, other configs, commands and
 * the programs they run (downloaders, ffmpeg, postprocessors), batch input, self-update, and any
 * cluster of short options (`-qu`), which every internal caller avoids. Case matters
 * (`-P` is the output path, `-p` the password).
 */
const DENIED_ARG =
  /^(--(cookies|cookies-from-browser|config-locations?|username|password|twofactor|netrc|netrc-location|netrc-cmd|video-password|ap-mso|ap-username|ap-password|exec|exec-before-download|batch-file|load-info-json|update|update-to|plugin-dirs|client-certificate[\w-]*|ffmpeg-location|downloader|external-downloader|downloader-args|external-downloader-args|use-postprocessor|postprocessor-args|ppa|add-headers?|referer|user-agent|load-pages|print-to-file)|-[upan2U]|-[A-Za-z0-9]{2,})(=|$)/

interface Meta {
  version: string
  sha256: string
  installedAt: string
  lastCheckedAt: string | null
}

let ctxRef: MainContext | null = null
let status: ToolsStatus = {
  state: 'absent',
  version: null,
  path: null,
  reason: null,
  progress: null,
  sizeBytes: SIZE_ESTIMATE,
  licence: 'Unlicense',
  lastCheckedAt: null,
  blockedByLocalOnly: false
}
let installed: Meta | null = null
let pathCopy: { path: string; version: string | null; checkedAt: number } | null = null
let busy: 'downloading' | 'updating' | null = null
let queue: Promise<unknown> = Promise.resolve()
let lastJobEndAt = 0
const failures: number[] = []
let pausedUntil = 0
let lastProgressPush = 0

function toolDir(ctx: Pick<MainContext, 'userDataPath'>): string {
  return join(ctx.userDataPath, 'tools', 'yt-dlp')
}

function managedPath(ctx: Pick<MainContext, 'userDataPath'>): string {
  return join(toolDir(ctx), EXE)
}

/** `2026.08.19` < `2026.08.19.1` < `2026.09.01`; null for anything else. */
function versionKey(v: string | null): number[] | null {
  if (!v || !TAG.test(v)) return null
  return v.split('.').map(Number).concat([0]).slice(0, 4)
}

function newer(a: string | null, b: string | null): boolean {
  const ka = versionKey(a)
  const kb = versionKey(b)
  if (!ka) return false
  if (!kb) return true
  for (let i = 0; i < 4; i++) {
    const x = ka[i] ?? 0
    const y = kb[i] ?? 0
    if (x !== y) return x > y
  }
  return false
}

function push(ctx: MainContext, force = true): void {
  const now = Date.now()
  if (!force && now - lastProgressPush < 250) return
  lastProgressPush = now
  for (const wc of ctx.windows.targets()) wc.send('sources:tools-progress' satisfies PushChannel, toolsStatus())
}

function setStatus(ctx: MainContext | null, patch: Partial<ToolsStatus>, force = true): void {
  status = { ...status, ...patch, blockedByLocalOnly: isLocalOnly() }
  if (ctx) push(ctx, force)
}

export function toolsStatus(): ToolsStatus {
  return { ...status, blockedByLocalOnly: isLocalOnly() }
}

// ---------- the installed copy and PATH ----------

async function readMeta(ctx: MainContext): Promise<Meta | null> {
  try {
    const raw = JSON.parse(await readFile(join(toolDir(ctx), META), 'utf8')) as Partial<Meta>
    if (typeof raw.version !== 'string' || !TAG.test(raw.version) || typeof raw.sha256 !== 'string') return null
    if (!existsSync(managedPath(ctx))) return null
    return {
      version: raw.version,
      sha256: raw.sha256,
      installedAt: typeof raw.installedAt === 'string' ? raw.installedAt : new Date(0).toISOString(),
      lastCheckedAt: typeof raw.lastCheckedAt === 'string' ? raw.lastCheckedAt : null
    }
  } catch {
    return null
  }
}

/** The digest the installed copy matched this run (hashed once per run: it is about 18 MB). */
let verifiedSha: string | null = null

/** The installed binary still has the digest it was installed with; a replaced file never runs. */
async function installedCopyIntact(ctx: MainContext, meta: Meta): Promise<boolean> {
  const want = meta.sha256.toLowerCase()
  if (verifiedSha === want) return true
  try {
    const hash = createHash('sha256')
    const fh = await open(managedPath(ctx), 'r')
    try {
      for await (const chunk of fh.createReadStream({ autoClose: false })) hash.update(chunk as Buffer)
    } finally {
      await fh.close()
    }
    if (hash.digest('hex') !== want) {
      log('warn', 'sources:tools-checksum-mismatch', { installed: true })
      return false
    }
    verifiedSha = want
    return true
  } catch {
    return false
  }
}

async function writeMeta(ctx: MainContext, meta: Meta): Promise<void> {
  await writeFile(join(toolDir(ctx), META), JSON.stringify(meta, null, 2), 'utf8')
  installed = meta
}

/** `yt-dlp.exe` on PATH (not Notula's own copy). */
function findOnPath(ctx: MainContext): string | null {
  const own = managedPath(ctx).toLowerCase()
  for (const dir of (process.env['PATH'] ?? '').split(delimiter)) {
    const d = dir.trim().replace(/^"|"$/g, '')
    if (!d) continue
    const p = join(d, EXE)
    if (p.toLowerCase() !== own && existsSync(p)) return p
  }
  return null
}

/** `--version` of a binary (no network). Null on a failure. */
function binaryVersion(path: string): Promise<string | null> {
  return new Promise((resolve) => {
    let out = ''
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(path, ['--ignore-config', '--version'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    } catch {
      resolve(null)
      return
    }
    const timer = setTimeout(() => killTree(child), VERSION_TIMEOUT_MS)
    child.stdout?.on('data', (b: Buffer) => {
      out = (out + b.toString('utf8')).slice(0, 200)
    })
    child.on('error', () => {
      clearTimeout(timer)
      resolve(null)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const v = out.trim()
      resolve(code === 0 && TAG.test(v) ? v : null)
    })
  })
}

/** Lookups granted, the Labs switch on, Windows. */
async function allowed(ctx: MainContext): Promise<boolean> {
  if (process.platform !== 'win32') return false
  return (await ctx.settings.get('sources.enabled')) && (await ctx.settings.get('sources.onlineLookups'))
}

/** Recomputes the state from the settings, the installed copy and PATH. */
async function refresh(ctx: MainContext): Promise<ToolsStatus> {
  if (busy) return toolsStatus()
  if (process.platform !== 'win32') {
    setStatus(ctx, { state: 'off', reason: 'unsupported', version: null, path: null, progress: null })
    return toolsStatus()
  }
  const mode = await ctx.settings.get('sources.ytDlp')
  installed = await readMeta(ctx)
  const lastCheckedAt = installed?.lastCheckedAt ?? null
  if (mode === 'off') {
    setStatus(ctx, { state: 'off', reason: null, version: installed?.version ?? null, path: null, progress: null, lastCheckedAt })
    return toolsStatus()
  }
  // A PATH copy is run (for its version) only with lookups granted and egress allowed.
  const mayProbe = (await allowed(ctx)) && !(await egressBlocked(ctx, { kind: 'source-lookup' }))
  if (mayProbe && (!pathCopy || Date.now() - pathCopy.checkedAt > PATH_RECHECK_MS)) {
    const p = findOnPath(ctx)
    pathCopy = p ? { path: p, version: await binaryVersion(p), checkedAt: Date.now() } : { path: '', version: null, checkedAt: Date.now() }
  }
  const external = pathCopy?.path ? pathCopy : null
  if (mode === 'external') {
    if (external) setStatus(ctx, { state: 'external', reason: null, version: external.version, path: external.path, progress: null, lastCheckedAt })
    else setStatus(ctx, { state: 'absent', reason: mayProbe ? 'not-on-path' : null, version: null, path: null, progress: null, lastCheckedAt })
    return toolsStatus()
  }
  if (external && external.version && newer(external.version, installed?.version ?? null)) {
    setStatus(ctx, { state: 'external', reason: null, version: external.version, path: external.path, progress: null, lastCheckedAt })
  } else if (installed && !(await installedCopyIntact(ctx, installed))) {
    setStatus(ctx, { state: 'failed', reason: 'checksum-mismatch', version: installed.version, path: null, progress: null, lastCheckedAt })
  } else if (installed) {
    setStatus(ctx, { state: 'ready', reason: null, version: installed.version, path: managedPath(ctx), progress: null, lastCheckedAt })
  } else {
    setStatus(ctx, { state: status.state === 'failed' ? 'failed' : 'absent', version: null, path: null, progress: null, lastCheckedAt })
  }
  return toolsStatus()
}

// ---------- download and update ----------

class ToolsError extends Error {}

/**
 * The newest release tag: the `latest` page redirects to `/releases/tag/<tag>`. Read from the
 * redirect itself: Electron's `net.fetch` follows it but leaves `Response.url` empty, and refuses
 * `redirect: 'manual'`, so the response alone never names the release.
 */
async function latestTag(ctx: MainContext): Promise<string> {
  const url = `${RELEASES}/latest`
  await assertEgress(ctx, { kind: 'source-tools' }, url, 'sources:tools')
  const location = await new Promise<string>((resolve, reject) => {
    const req = net.request({ url, redirect: 'manual' })
    const timer = setTimeout(() => {
      req.abort()
      reject(new ToolsError('release-unknown'))
    }, LATEST_TIMEOUT_MS)
    const done = (v: string): void => {
      clearTimeout(timer)
      resolve(v)
      req.abort()
    }
    req.on('redirect', (_status, _method, redirectUrl) => done(redirectUrl))
    req.on('response', () => done(''))
    req.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    req.end()
  })
  const m = /\/releases\/tag\/([^/?#]+)$/.exec(location)
  const tag = m ? decodeURIComponent(m[1] ?? '') : ''
  if (!TAG.test(tag)) throw new ToolsError('release-unknown')
  return tag
}

async function expectedDigest(ctx: MainContext, tag: string): Promise<string> {
  const res = await egressFetch(ctx, { kind: 'source-tools' }, `${RELEASES}/download/${tag}/${SUMS}`, { redirect: 'follow' }, 'sources:tools')
  if (!res.ok) throw new ToolsError('checksums-unavailable')
  const text = (await res.text()).slice(0, 64 * 1024)
  for (const line of text.split(/\r?\n/)) {
    const m = /^([0-9a-f]{64})\s+\*?(\S+)$/i.exec(line.trim())
    if (m && m[2] === EXE) return (m[1] ?? '').toLowerCase()
  }
  throw new ToolsError('checksum-missing')
}

/** Streams the binary into `<exe>.partial` while hashing it; renames only on a matching digest. */
async function fetchVerified(ctx: MainContext, tag: string, digest: string): Promise<void> {
  const dir = toolDir(ctx)
  await mkdir(dir, { recursive: true })
  const partial = join(dir, `${EXE}.partial`)
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), DOWNLOAD_TIMEOUT_MS)
  const fh = await open(partial, 'w')
  try {
    const res = await egressFetch(ctx, { kind: 'source-tools' }, `${RELEASES}/download/${tag}/${EXE}`, { redirect: 'follow', signal: ac.signal }, 'sources:tools')
    if (!res.ok || !res.body) throw new ToolsError(`http-${res.status}`)
    const length = Number(res.headers.get('content-length') ?? NaN)
    if (Number.isFinite(length) && length > DOWNLOAD_CAP) throw new ToolsError('too-large')
    const total = Number.isFinite(length) ? length : null
    setStatus(ctx, { sizeBytes: total ?? SIZE_ESTIMATE, progress: { receivedBytes: 0, totalBytes: total } })
    const hash = createHash('sha256')
    let received = 0
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      received += chunk.byteLength
      if (received > DOWNLOAD_CAP) {
        ac.abort()
        throw new ToolsError('too-large')
      }
      hash.update(chunk)
      await fh.write(chunk)
      setStatus(ctx, { progress: { receivedBytes: received, totalBytes: total } }, false)
    }
    await fh.close()
    const got = hash.digest('hex')
    if (got !== digest) throw new ToolsError('checksum-mismatch')
    await rename(partial, join(dir, EXE))
  } catch (err) {
    await fh.close().catch(() => undefined)
    await rm(partial, { force: true }).catch(() => undefined)
    if (err instanceof ToolsError) throw err
    throw new ToolsError(ac.signal.aborted ? 'timeout' : 'network')
  } finally {
    clearTimeout(timer)
  }
}

/** Installs or updates the managed copy. Runs inside the job queue, so no run holds the file. */
function install(ctx: MainContext, kind: 'downloading' | 'updating', knownTag?: string): Promise<void> {
  busy = kind
  setStatus(ctx, { state: kind, reason: null, progress: { receivedBytes: 0, totalBytes: null } })
  const work = async (): Promise<void> => {
    const t0 = Date.now()
    try {
      const tag = knownTag ?? (await latestTag(ctx))
      const digest = await expectedDigest(ctx, tag)
      await fetchVerified(ctx, tag, digest)
      const now = new Date().toISOString()
      await writeMeta(ctx, { version: tag, sha256: digest, installedAt: now, lastCheckedAt: now })
      verifiedSha = digest.toLowerCase()
      log('info', 'sources:tools-installed', { kind, ms: Date.now() - t0 })
      busy = null
      setStatus(ctx, { state: 'ready', version: tag, path: managedPath(ctx), reason: null, progress: null, lastCheckedAt: now })
      await refresh(ctx)
    } catch (err) {
      const reason = err instanceof ToolsError ? err.message : 'failed'
      log('warn', 'sources:tools-install-failed', { kind, reason, ms: Date.now() - t0 })
      busy = null
      installed = await readMeta(ctx)
      if (installed) setStatus(ctx, { state: 'ready', version: installed.version, path: managedPath(ctx), reason: `update-${reason}`, progress: null })
      else setStatus(ctx, { state: 'failed', reason, progress: null })
    }
  }
  const run = queue.then(work, work)
  queue = run.catch(() => undefined)
  return run
}

/** The weekly background check (managed mode, lookups granted, egress allowed). */
async function maybeUpdate(ctx: MainContext): Promise<void> {
  if (busy || !(await allowed(ctx))) return
  if ((await ctx.settings.get('sources.ytDlp')) !== 'managed') return
  if (await egressBlocked(ctx, { kind: 'source-tools' })) return
  installed = await readMeta(ctx)
  if (!installed) return
  const last = installed.lastCheckedAt ? Date.parse(installed.lastCheckedAt) : 0
  if (Date.now() - last < UPDATE_EVERY_MS) return
  try {
    const tag = await latestTag(ctx)
    if (newer(tag, installed.version)) {
      await install(ctx, 'updating', tag)
      return
    }
    await writeMeta(ctx, { ...installed, lastCheckedAt: new Date().toISOString() })
    log('info', 'sources:tools-up-to-date', {})
    await refresh(ctx)
  } catch (err) {
    log('warn', 'sources:tools-update-check-failed', { reason: err instanceof ToolsError ? err.message : 'network' })
  }
}

// ---------- running ----------

function recordFailure(): void {
  const now = Date.now()
  failures.push(now)
  while (failures.length && now - (failures[0] ?? 0) > FAILURE_WINDOW_MS) failures.shift()
  if (failures.length >= FAILURES_TO_PAUSE) {
    pausedUntil = now + PAUSE_MS
    failures.length = 0
    log('warn', 'sources:ytdlp-paused', { minutes: PAUSE_MS / 60_000 })
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0 || signal?.aborted) {
      resolve()
      return
    }
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(t)
      resolve()
    })
  })
}

/** The binary to run now, or null. */
function binary(): string | null {
  if (status.state === 'ready' || status.state === 'external') return status.path
  // While an update downloads, the installed copy keeps serving (the queue holds the rename).
  // Only a copy that matched its digest this run.
  if (status.state === 'updating' && installed && ctxRef && verifiedSha === installed.sha256.toLowerCase()) return managedPath(ctxRef)
  return null
}

/** `<drive>:\Windows\System32\taskkill.exe`: the environment may pick the drive only. */
function taskkillExe(): string {
  const root = process.env.SystemRoot ?? ''
  return join(/^[A-Za-z]:\\Windows$/i.test(root) ? root : 'C:\\Windows', 'System32', 'taskkill.exe')
}

/**
 * Ends a run with its children: the one-file yt-dlp is a bootloader that starts the real
 * program as its child, which a plain kill would leave running. The parent stays
 * alive until taskkill has walked the tree; a plain kill follows when taskkill can't run.
 */
function killTree(child: ReturnType<typeof spawn>): void {
  const plain = (): void => {
    try {
      child.kill()
    } catch {
      // Already gone.
    }
  }
  if (process.platform !== 'win32' || child.pid === undefined || child.exitCode !== null) return plain()
  try {
    const k = spawn(taskkillExe(), ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    k.on('error', plain)
    k.on('exit', (code) => {
      if (code !== 0) plain()
    })
  } catch {
    plain()
  }
}

function exec(bin: string, job: YtDlpJob, timeoutMs: number): Promise<YtDlpResult> {
  return new Promise((resolve) => {
    const t0 = Date.now()
    let bytes = 0
    let over = false
    let timedOut = false
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(bin, ['--ignore-config', '--no-cookies', '--no-cookies-from-browser', ...job.args], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch {
      resolve({ ok: false, reason: 'failed', exitCode: null })
      return
    }
    const kill = (): void => killTree(child)
    const timer = setTimeout(() => {
      timedOut = true
      kill()
    }, timeoutMs)
    const onAbort = (): void => kill()
    job.signal?.addEventListener('abort', onAbort)
    // Buffers kept whole and decoded once, so a character split across chunks stays intact.
    const parts: Buffer[] = []
    child.stdout?.on('data', (b: Buffer) => {
      bytes += b.byteLength
      if (bytes > STDOUT_CAP) {
        over = true
        kill()
        return
      }
      parts.push(b)
    })
    // stderr carries titles and URLs: drained, never kept or logged.
    child.stderr?.resume()
    child.on('error', () => undefined)
    child.on('close', (code) => {
      clearTimeout(timer)
      job.signal?.removeEventListener('abort', onAbort)
      log('info', 'sources:ytdlp-run', { purpose: job.purpose, exitCode: code, ms: Date.now() - t0, bytes, timedOut, over })
      if (code === 0 && !over && !timedOut) resolve({ ok: true, stdout: Buffer.concat(parts).toString('utf8'), exitCode: 0 })
      else resolve({ ok: false, reason: timedOut ? 'timeout' : 'failed', exitCode: code })
    })
  })
}

/** One job at a time, ≥ 2 s apart, with the egress check right before spawning. */
export async function runYtDlp(ctx: MainContext, job: YtDlpJob): Promise<YtDlpResult> {
  if (process.platform !== 'win32') return { ok: false, reason: 'not-ready', exitCode: null }
  if (!(await allowed(ctx)) || (await ctx.settings.get('sources.ytDlp')) === 'off') return { ok: false, reason: 'off', exitCode: null }
  const kind = job.purpose === 'captions' ? 'source-captions' : 'source-lookup'
  if (await egressBlocked(ctx, { kind })) return { ok: false, reason: 'local-only', exitCode: null }
  if (Date.now() < pausedUntil) return { ok: false, reason: 'paused', exitCode: null }
  if (job.args.some((a) => DENIED_ARG.test(a))) {
    log('warn', 'sources:ytdlp-denied-arg', { purpose: job.purpose })
    return { ok: false, reason: 'failed', exitCode: null }
  }
  if (!binary()) await refresh(ctx)
  if (!binary()) return { ok: false, reason: 'not-ready', exitCode: null }
  const work = async (): Promise<YtDlpResult> => {
    await sleep(lastJobEndAt + JOB_GAP_MS - Date.now(), job.signal)
    if (job.signal?.aborted) return { ok: false, reason: 'failed', exitCode: null }
    // Settings may have changed while queued.
    if (!(await allowed(ctx))) return { ok: false, reason: 'off', exitCode: null }
    if (await egressBlocked(ctx, { kind })) return { ok: false, reason: 'local-only', exitCode: null }
    if (Date.now() < pausedUntil) return { ok: false, reason: 'paused', exitCode: null }
    const bin = binary()
    if (!bin) return { ok: false, reason: 'not-ready', exitCode: null }
    const r = await exec(bin, job, job.timeoutMs ?? TIMEOUTS[job.purpose])
    lastJobEndAt = Date.now()
    if (!r.ok && !job.signal?.aborted) recordFailure()
    return r
  }
  const run = queue.then(work, work)
  queue = run.catch(() => undefined)
  return run
}

// ---------- registration ----------

/** Leftovers of an interrupted download. */
async function sweep(ctx: MainContext): Promise<void> {
  try {
    for (const name of await readdir(toolDir(ctx))) {
      if (name.endsWith('.partial')) await rm(join(toolDir(ctx), name), { force: true })
    }
  } catch {
    // No folder yet.
  }
}

/** `sources:tools-status`, `sources:tools-download`, push `sources:tools-progress`. */
export function registerSourceTools(ctx: MainContext): void {
  ctxRef = ctx

  ipcMain.handle('sources:tools-status' satisfies InvokeChannel, (): Promise<ToolsStatus> => refresh(ctx))

  ipcMain.handle('sources:tools-download' satisfies InvokeChannel, async (_e, req: InvokeReq<'sources:tools-download'>): Promise<ToolsStatus> => {
    if (!req || typeof req !== 'object' || (req as { confirmed?: unknown }).confirmed !== true) {
      throw expected(notulaError('invalid-input', 'The download needs confirmed: true.'))
    }
    if (process.platform !== 'win32') throw expected(notulaError('invalid-input', 'Sources run on Windows only.'))
    if (!(await ctx.settings.get('sources.enabled'))) throw expected(notulaError('invalid-input', 'Sources is off.'))
    if (!(await ctx.settings.get('sources.onlineLookups'))) throw expected(notulaError('invalid-input', 'Online lookups are off.'))
    if ((await ctx.settings.get('sources.ytDlp')) !== 'managed') throw expected(notulaError('invalid-input', 'yt-dlp is not managed by Notula.'))
    if (await egressBlocked(ctx, { kind: 'source-tools' })) throw expected(notulaError('provider-error', 'local-only mode'))
    if (busy) return toolsStatus()
    void install(ctx, (await readMeta(ctx)) ? 'updating' : 'downloading')
    return toolsStatus()
  })

  ctx.bus.on('settings:changed', ({ keys }) => {
    if (keys.some((k) => k === 'sources.ytDlp' || k === 'sources.onlineLookups' || k === 'sources.enabled' || k === 'privacy.localOnly')) {
      pathCopy = null
      void refresh(ctx).catch((err: unknown) => log('warn', 'sources:tools-refresh-failed', { err }))
    }
  })

  if (process.platform !== 'win32') return
  void sweep(ctx)
    .then(() => refresh(ctx))
    .catch((err: unknown) => log('warn', 'sources:tools-refresh-failed', { err }))
  setTimeout(() => void maybeUpdate(ctx), 60_000).unref()
  setInterval(() => void maybeUpdate(ctx), UPDATE_TICK_MS).unref()
}
