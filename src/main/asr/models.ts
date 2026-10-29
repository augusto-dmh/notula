// SPDX-License-Identifier: Apache-2.0
// The local model manager.
// Main does the fetching (net.fetch, following GitHub's redirect to its release CDN);
// the storage process never touches the network, and nothing executable is ever
// downloaded: only the files the manifest pins.
//
// Layout: <userData>/models/<asr|diarization>/<modelId>/<member path> (`speaker-id` sits
// with diarization). An alias (manifest `alias`) has no folder of its own: it is one
// file of its home model, shares that model's download and state, and can't be deleted
// on its own. A model is
// built in two staging folders next to it: `<dir>.download/` holds each download as
// `<file>.partial` while its SHA-256 is streamed, and `<dir>.partial/` receives the
// verified members (archives are extracted with the OS `tar`). Only when every
// download and member verifies is `<dir>.partial` renamed to `<dir>`. Any mismatch
// deletes both staging folders and leaves the state `error` (in memory only).

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, statSync, type WriteStream } from 'node:fs'
import { copyFile, link, mkdir, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { SpeakerModelState } from '@shared/types/speakers'
import { DEFAULT_LOCAL_ASR_MODEL, type LocalModelId, type LocalModelState } from '@shared/types/transcript'
import { log } from '../log'
import { aliasesOf, MODEL_MANIFEST, modelFiles, modelHome, speakerIdModelId, type ModelDownload, type ModelFile, type ModelManifestEntry } from './manifest'
import type { VerifiedFile } from './protocol'
import { baseName, sha256File } from './verify'

/** Progress pushes: at most one per 250 ms per model; the final state always. */
const PUSH_EVERY_MS = 250
const TAR_TIMEOUT_MS = 10 * 60_000

export type FetchLike = (url: string, init: { signal: AbortSignal; redirect: 'follow' }) => Promise<Response>

export interface ModelManagerOptions {
  /** `<userData>/models`. */
  root: string
  fetch: FetchLike
  /** Why a delete must wait (`busy: …`), or null. */
  busyReason(id: LocalModelId): string | null
}

export class ModelError extends Error {}

function isModelId(v: unknown): v is LocalModelId {
  return typeof v === 'string' && Object.hasOwn(MODEL_MANIFEST, v)
}

/** The request's model id, or the ASR default. */
export function modelIdOf(req: unknown): LocalModelId | null {
  const id = (req as { modelId?: unknown } | null)?.modelId
  if (id === undefined || id === null) return DEFAULT_LOCAL_ASR_MODEL
  return isModelId(id) ? id : null
}

/** `%SystemRoot%\System32\tar.exe` on Windows when present, else `tar` on PATH. */
function tarCommand(): string {
  if (process.platform === 'win32') {
    const sys = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'tar.exe')
    if (existsSync(sys)) return sys
  }
  return 'tar'
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: TAR_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        const detail = (stderr || err.message).toString().trim().split(/\r?\n/).slice(-2).join(' ')
        reject(new ModelError(`tar failed: ${detail}`))
      } else resolve(stdout.toString())
    })
  })
}

/**
 * One chunk into the stream, waiting for `drain` when its buffer is full. A stream
 * error (a full disk, an open failure) rejects instead of hanging or going uncaught;
 * the caller keeps a permanent `error` listener on the stream.
 */
function writeChunk(out: WriteStream, chunk: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    if (out.errored) {
      reject(out.errored)
      return
    }
    if (out.write(chunk)) {
      resolve()
      return
    }
    const onDrain = (): void => {
      out.off('error', onError)
      resolve()
    }
    const onError = (err: Error): void => {
      out.off('drain', onDrain)
      reject(err)
    }
    out.once('drain', onDrain)
    out.once('error', onError)
  })
}

function endStream(out: WriteStream): Promise<void> {
  return new Promise((resolve, reject) => {
    if (out.errored) {
      reject(out.errored)
      return
    }
    out.once('error', reject)
    out.end((err?: Error | null) => (err ? reject(err) : resolve()))
  })
}

/** Links (same volume, instant) or copies a verified file into the staging folder. */
async function reuse(from: string, to: string): Promise<void> {
  await mkdir(dirname(to), { recursive: true })
  try {
    await link(from, to)
  } catch {
    await copyFile(from, to)
  }
}

/**
 * The identification model's state for `speakers:get-status`: the manager's state, or
 * `mismatch` when it is ready but the calibration file's `modelSha` names another extractor.
 * `calibrationSha` null: no calibration file to compare.
 */
export function speakerModelState(s: LocalModelState, calibrationSha: string | null): SpeakerModelState {
  if (s.state === 'ready' && calibrationSha !== null && calibrationSha !== speakerIdModelId()) return 'mismatch'
  return s.state
}

interface Throttle {
  last: number
  timer: NodeJS.Timeout | null
}

export class LocalModelManager {
  /** The opt-in error is held in memory only. */
  private readonly errors = new Map<LocalModelId, string>()
  private readonly jobs = new Map<LocalModelId, Promise<void>>()
  private readonly received = new Map<LocalModelId, number>()
  private queue: Promise<unknown> = Promise.resolve()
  private readonly listeners = new Set<(s: LocalModelState) => void>()
  private readonly throttles = new Map<LocalModelId, Throttle>()
  private readonly users = new Map<LocalModelId, number>()

  constructor(private readonly opts: ModelManagerOptions) {
    // A quit or crash mid-download leaves the staging folders behind.
    // Nothing can be downloading yet, and the sweep runs first on the queue.
    void this.enqueue(() => this.sweepStaging())
  }

  /** Removes every model's `<dir>.download` and `<dir>.partial` left from an earlier run. */
  private async sweepStaging(): Promise<void> {
    let removed = 0
    for (const id of Object.keys(MODEL_MANIFEST) as LocalModelId[]) {
      if (MODEL_MANIFEST[id].alias) continue
      const dir = this.dir(id)
      for (const stage of [`${dir}.download`, `${dir}.partial`]) {
        if (!existsSync(stage)) continue
        try {
          await rm(stage, { recursive: true, force: true })
          removed++
        } catch (err) {
          log('warn', 'asr:model-staging-sweep-failed', { modelId: id, err })
        }
      }
    }
    if (removed) log('info', 'asr:model-staging-swept', { folders: removed })
  }

  /** A worker holds the model's files until the returned release runs (an alias holds its home's). */
  use(model: LocalModelId): () => void {
    const id = modelHome(model)
    this.users.set(id, (this.users.get(id) ?? 0) + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      const n = (this.users.get(id) ?? 1) - 1
      if (n > 0) this.users.set(id, n)
      else this.users.delete(id)
    }
  }

  inUse(id: LocalModelId): boolean {
    return (this.users.get(modelHome(id)) ?? 0) > 0
  }

  onState(cb: (s: LocalModelState) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  /** The model's folder; an alias's is its home's. */
  dir(model: LocalModelId): string {
    const id = modelHome(model)
    const entry = MODEL_MANIFEST[id]
    return join(this.opts.root, entry.kind === 'asr' ? 'asr' : 'diarization', id)
  }

  /** Every member with its absolute path, for the workers' layer-3 check (an alias: its one file). */
  files(id: LocalModelId): VerifiedFile[] {
    const dir = this.dir(id)
    return modelFiles(id).map((m) => ({ path: join(dir, m.path), bytes: m.bytes, sha256: m.sha256 }))
  }

  /**
   * The `speaker-id` extractor when it is ready: its file for the diarize worker, and its
   * model id, the file's SHA-256. Null otherwise.
   */
  speakerId(): { file: VerifiedFile; modelId: string } | null {
    if (!this.isReady('speaker-id')) return null
    return { file: this.files('speaker-id')[0] as VerifiedFile, modelId: speakerIdModelId() }
  }

  /** "Ready": every member exists with its exact size; no re-hash. An alias is ready when its home is. */
  isReady(model: LocalModelId): boolean {
    const id = modelHome(model)
    if (this.jobs.has(id)) return false
    return this.files(id).every((f) => {
      try {
        return statSync(f.path).size === f.bytes
      } catch {
        return false
      }
    })
  }

  isDownloading(id: LocalModelId): boolean {
    return this.jobs.has(modelHome(id))
  }

  /** An alias reports its home's state under its own id. */
  stateNow(model: LocalModelId): LocalModelState {
    const id = modelHome(model)
    if (id !== model) return { ...this.stateNow(id), modelId: model }
    const totalBytes = MODEL_MANIFEST[id].totalBytes
    if (this.jobs.has(id)) return { modelId: id, state: 'downloading', receivedBytes: this.received.get(id) ?? 0, totalBytes }
    if (this.isReady(id)) return { modelId: id, state: 'ready', totalBytes }
    const message = this.errors.get(id)
    if (message !== undefined) return { modelId: id, state: 'error', message, totalBytes }
    return { modelId: id, state: 'missing', totalBytes }
  }

  /** Get, start and delete run one at a time on one queue. */
  getState(id: LocalModelId): Promise<LocalModelState> {
    return this.enqueue(async () => this.stateNow(id))
  }

  /**
   * Returns the current state when the model is ready or a download is
   * running (the caller joins it); otherwise starts one and returns `downloading`.
   */
  download(model: LocalModelId): Promise<LocalModelState> {
    // An alias downloads its home: no second download, no second copy.
    const id = modelHome(model)
    return this.enqueue(async () => {
      if (this.jobs.has(id) || this.isReady(id)) return this.stateNow(model)
      this.start(id)
      return this.stateNow(model)
    })
  }

  /** Refused while downloading or while a meeting is transcribed. An alias is never deleted on its own. */
  delete(id: LocalModelId): Promise<LocalModelState> {
    return this.enqueue(async () => {
      if (MODEL_MANIFEST[id].alias) throw new ModelError('It shares a file with another model. Delete that model instead.')
      if (this.jobs.has(id)) throw new ModelError('Still downloading. Delete it when done.')
      const busy = this.opts.busyReason(id)
      if (busy) throw new ModelError(`busy: ${busy}`)
      const dir = this.dir(id)
      await rm(dir, { recursive: true, force: true })
      await rm(`${dir}.partial`, { recursive: true, force: true })
      await rm(`${dir}.download`, { recursive: true, force: true })
      this.errors.delete(id)
      log('info', 'asr:model-deleted', { modelId: id })
      this.push(id, true)
      return this.stateNow(id)
    })
  }

  /** For a meeting that starts with the model missing: download, then report. */
  async ensureReady(id: LocalModelId): Promise<boolean> {
    if (this.isReady(id)) return true
    await this.download(id)
    await this.jobs.get(modelHome(id))
    return this.isReady(id)
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn)
    this.queue = next.catch(() => undefined)
    return next
  }

  private start(id: LocalModelId): void {
    this.errors.delete(id)
    this.received.set(id, 0)
    const entry = MODEL_MANIFEST[id]
    const started = Date.now()
    log('info', 'asr:model-download-start', { modelId: id, totalBytes: entry.totalBytes })
    const job = this.build(entry)
      .then(() => {
        log('info', 'asr:model-ready', { modelId: id, ms: Date.now() - started })
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        this.errors.set(id, message)
        log('warn', 'asr:model-download-failed', { modelId: id, message })
      })
      .finally(() => {
        this.jobs.delete(id)
        this.received.delete(id)
        this.push(id, true)
      })
    this.jobs.set(id, job)
    this.push(id, true)
  }

  private addReceived(id: LocalModelId, n: number): void {
    this.received.set(id, (this.received.get(id) ?? 0) + n)
    this.push(id, false)
  }

  /** Throttled to one push per 250 ms per model; `final` always goes out at once. */
  private push(id: LocalModelId, final: boolean): void {
    let t = this.throttles.get(id)
    if (!t) {
      t = { last: 0, timer: null }
      this.throttles.set(id, t)
    }
    const emit = (): void => {
      const th = this.throttles.get(id) as Throttle
      if (th.timer) clearTimeout(th.timer)
      th.timer = null
      th.last = Date.now()
      // An alias's state moves with its home's.
      for (const m of [id, ...aliasesOf(id)]) {
        const s = this.stateNow(m)
        for (const l of this.listeners) l(s)
      }
    }
    if (final) {
      emit()
      return
    }
    const wait = PUSH_EVERY_MS - (Date.now() - t.last)
    if (wait <= 0) emit()
    else if (!t.timer) t.timer = setTimeout(emit, wait)
  }

  private async build(entry: ModelManifestEntry): Promise<void> {
    const final = this.dir(entry.id)
    const stage = `${final}.partial`
    const dl = `${final}.download`
    await rm(stage, { recursive: true, force: true })
    await rm(dl, { recursive: true, force: true })
    await mkdir(stage, { recursive: true })
    await mkdir(dl, { recursive: true })
    try {
      for (const d of entry.downloads) {
        // A download whose members already verify in place is reused.
        if (await this.verifiedIn(final, d.members)) {
          for (const m of d.members) await reuse(join(final, m.path), join(stage, m.path))
          this.addReceived(entry.id, d.bytes)
          log('info', 'asr:model-download-reused', { modelId: entry.id, file: baseName(d.url) })
          continue
        }
        const file = join(dl, baseName(d.url))
        await this.fetchVerified(entry.id, d, file)
        if (d.kind === 'archive') await this.extract(d, file, stage)
        else {
          const m = d.members[0] as ModelFile
          await mkdir(dirname(join(stage, m.path)), { recursive: true })
          await rename(file, join(stage, m.path))
        }
        // Layer 2: every member's SHA-256 against its pin.
        const bad = await this.firstBadMember(stage, d.members)
        if (bad) throw new ModelError(bad)
      }
      await rm(final, { recursive: true, force: true })
      await mkdir(dirname(final), { recursive: true })
      await rename(stage, final)
    } finally {
      await rm(dl, { recursive: true, force: true }).catch(() => undefined)
      await rm(stage, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  private async verifiedIn(dir: string, members: ModelFile[]): Promise<boolean> {
    if (!existsSync(dir)) return false
    return (await this.firstBadMember(dir, members)) === null
  }

  private async firstBadMember(dir: string, members: ModelFile[]): Promise<string | null> {
    for (const m of members) {
      const p = join(dir, m.path)
      let size: number
      try {
        size = (await stat(p)).size
      } catch {
        return `missing model file ${m.path}`
      }
      if (size !== m.bytes) return `model file ${m.path} has ${size} bytes, expected ${m.bytes}`
      const got = await sha256File(p)
      if (got !== m.sha256) return `integrity check failed for ${m.path}: expected ${m.sha256}, got ${got}`
    }
    return null
  }

  /**
   * Layer 1: streams the download into `<file>.partial` while hashing it. A
   * Content-Length above the cap fails at once, and a body that grows past it is
   * cancelled. Only a matching digest renames the partial into place.
   */
  private async fetchVerified(id: LocalModelId, d: ModelDownload, file: string): Promise<void> {
    const partial = `${file}.partial`
    const name = baseName(d.url)
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), d.timeoutMs)
    let out: WriteStream | null = null
    try {
      const res = await this.opts.fetch(d.url, { signal: ac.signal, redirect: 'follow' })
      if (!res.ok || !res.body) throw new ModelError(`download of ${name} failed: HTTP ${res.status}`)
      const length = Number(res.headers.get('content-length') ?? NaN)
      if (Number.isFinite(length) && length > d.capBytes) {
        ac.abort()
        throw new ModelError(`download of ${name} is ${length} bytes, over its ${d.capBytes}-byte cap`)
      }
      const hash = createHash('sha256')
      out = createWriteStream(partial)
      // Without a listener, an ENOSPC or open failure is an uncaught exception in main.
      // The write and end promises reject with it.
      out.on('error', (err) => log('warn', 'asr:model-write-failed', { modelId: id, file: name, message: err.message }))
      let total = 0
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        total += chunk.byteLength
        if (total > d.capBytes) {
          ac.abort()
          throw new ModelError(`download of ${name} grew past its ${d.capBytes}-byte cap`)
        }
        hash.update(chunk)
        await writeChunk(out, chunk)
        this.addReceived(id, chunk.byteLength)
      }
      await endStream(out)
      out = null
      const got = hash.digest('hex')
      if (got !== d.sha256) throw new ModelError(`integrity check failed for ${name}: expected ${d.sha256}, got ${got}`)
      if (total !== d.bytes) throw new ModelError(`download of ${name} has ${total} bytes, expected ${d.bytes}`)
      await rename(partial, file)
    } catch (err) {
      if (out) out.destroy()
      await rm(partial, { force: true }).catch(() => undefined)
      if (err instanceof ModelError) throw err
      const aborted = ac.signal.aborted
      throw new ModelError(
        aborted ? `download of ${name} timed out` : `download of ${name} failed: ${err instanceof Error ? err.message : String(err)}`
      )
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Extracts only the pinned members with the OS `tar`. Member paths are relative
   * to the archive's single top-level directory; anything else in the archive
   * (test audio, scripts) is never written.
   */
  private async extract(d: ModelDownload, archive: string, stage: string): Promise<void> {
    const tar = tarCommand()
    const listing = (await run(tar, ['-tf', archive]))
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
    const norm = (l: string): string => l.replace(/^\.\//, '').replace(/\/+$/, '')
    const tops = new Set(listing.map((l) => norm(l).split('/')[0]).filter(Boolean))
    if (tops.size !== 1) throw new ModelError(`archive ${baseName(d.url)} does not have one top-level folder`)
    const top = [...tops][0] as string
    const stored = d.members.map((m) => {
      const hit = listing.find((l) => norm(l) === `${top}/${m.path}`)
      if (!hit) throw new ModelError(`archive ${baseName(d.url)} is missing ${m.path}`)
      return { m, stored: hit }
    })
    const x = join(dirname(archive), 'x')
    await rm(x, { recursive: true, force: true })
    await mkdir(x, { recursive: true })
    // -m: members get the extraction time, not the archive's (2024–2025) dates, so no
    // cleanup tool mistakes a freshly installed model for a stale file.
    await run(tar, ['-xmf', archive, '-C', x, ...stored.map((s) => s.stored)])
    for (const { m } of stored) {
      const to = join(stage, m.path)
      await mkdir(dirname(to), { recursive: true })
      await rename(join(x, top, m.path), to)
    }
    await rm(x, { recursive: true, force: true })
    await rm(archive, { force: true })
  }
}
