// SPDX-License-Identifier: Apache-2.0
// registerDiagnostics(): local troubleshooting: the logs zip, the 10 s
// performance trace, the macOS system log capture and detailed logging (`setVerboseLogging`);
// the `diag:*` IPC.
//
// - Export logs: one zip of `<userData>/logs/`,
//   `<userData>/troubleshooting-logs/` and a README, saved where the user picks. Never the
//   database, preferences, keys, `Local State`, audio or traces. The logger already redacts
//   secret-looking fields; the zip scrubs the stored key values and auth headers again.
// - The trace: Chromium content tracing with every category for 10 s, plus a
//   main-process heap snapshot, zipped at level 9 into `<userData>/traces/`, revealed.
// - The macOS unified log: `log stream` with Notula's process filter into
//   `<userData>/troubleshooting-logs/<ts>-unified-log.log` until Stop or quit.
// - Nothing is uploaded anywhere, and `traces/` and `troubleshooting-logs/`
//   are never cleaned up.
//
// Handlers and pushes write their channel literal.

import { spawn, type ChildProcess } from 'node:child_process'
import { createWriteStream, type WriteStream } from 'node:fs'
import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { arch, release, type as osType } from 'node:os'
import { basename, join } from 'node:path'
import { writeHeapSnapshot } from 'node:v8'
import { app, BrowserWindow, contentTracing, dialog, ipcMain, shell } from 'electron'
import { zip, type Zippable } from 'fflate'
import { notulaError } from '@shared/errors'
import type { InvokeChannel, InvokeRes, PushChannel, PushPayload, SendChannel } from '@shared/ipc'
import { TRACE_LIMITS, UNIFIED_LOG_PREDICATE, type UnifiedLogStatus } from '@shared/types/diagnostics'
import { FIXED_SECRET_IDS, type SecretId } from '@shared/types/settings'
import type { MainContext } from '../context'
import { log, setVerboseLogging } from '../log'
import { rebuildApplicationMenu } from '../shell'

const isMac = process.platform === 'darwin'

const LOGS_DIR = 'logs'
const TROUBLESHOOTING_DIR = 'troubleshooting-logs'
const TRACES_DIR = 'traces'

/** Shows a file in the file manager, except in scripted dev runs (NOTULA_DEV_DIALOG_DIR). */
function reveal(ctx: MainContext, path: string): void {
  if (ctx.isDev && process.env['NOTULA_DEV_DIALOG_DIR']) {
    log('debug', 'diag:reveal-skipped', { path })
    return
  }
  shell.showItemInFolder(path)
}

/** `<ts>`: an ISO time with `:` and `.` replaced by `-`. */
export function fileStamp(at = new Date()): string {
  return at.toISOString().replace(/[:.]/g, '-')
}

// ---------- the zip ----------

function zipAsync(files: Zippable, level: 9): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    zip(files, { level }, (err, data) => (err ? reject(err) : resolve(data)))
  })
}

/** Regular files directly in `dir`, by name; an absent folder is empty. */
async function filesIn(dir: string): Promise<{ name: string; path: string; bytes: number }[]> {
  let entries: import('node:fs').Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out: { name: string; path: string; bytes: number }[] = []
  for (const e of entries) {
    if (!e.isFile()) continue
    const path = join(dir, e.name)
    try {
      out.push({ name: e.name, path, bytes: (await stat(path)).size })
    } catch {
      // Removed meanwhile.
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

async function folderBytes(dir: string): Promise<number> {
  return (await filesIn(dir)).reduce((n, f) => n + f.bytes, 0)
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

const AUTH_FIELD = /("?(?:authorization|x-api-key|api[_-]?key|token)"?\s*[:=]\s*"?)(?!\[redacted\])([^"\s,}]{6,})/gi
const AUTH_SCHEME = /\b(Bearer|Token|Basic)\s+(?!\[redacted\])[A-Za-z0-9._~+/=-]{12,}/g

/** Defense in depth: the logger redacts by field name; this also removes stored key values and auth headers. */
function scrub(text: string, secrets: string[]): string {
  let out = text
  for (const s of secrets) out = out.split(s).join('[redacted]')
  return out.replace(AUTH_FIELD, '$1[redacted]').replace(AUTH_SCHEME, '$1 [redacted]')
}

/** A JSON secret (OAuth tokens, MCP env values): its string leaves, so each is scrubbed on its own. */
function jsonLeaves(v: string): string[] {
  if (!v.startsWith('{') && !v.startsWith('[')) return []
  const out: string[] = []
  const walk = (x: unknown): void => {
    if (typeof x === 'string') {
      if (x.length >= 8) out.push(x)
    } else if (x && typeof x === 'object') for (const y of Object.values(x)) walk(y)
  }
  try {
    walk(JSON.parse(v))
  } catch {
    // not JSON: the whole value is scrubbed
  }
  return out
}

async function storedSecretValues(ctx: MainContext): Promise<string[]> {
  const values: string[] = []
  // Every stored id, the patterned ones too (hook URLs, MCP tokens and env values, plug-in secrets).
  const stored = await ctx.storage.listSecretIds().catch((): SecretId[] => [])
  for (const id of new Set<SecretId>([...FIXED_SECRET_IDS, ...stored])) {
    try {
      const v = await ctx.secrets.get(id)
      if (v && v.length >= 8) values.push(v, ...jsonLeaves(v))
    } catch {
      // Storage unavailable: the regex scrub still runs.
    }
  }
  return values
}

/** The logs zip. Resolves the bytes; writes nothing. */
async function buildLogsZip(ctx: MainContext): Promise<Uint8Array> {
  const logs = await filesIn(join(ctx.userDataPath, LOGS_DIR))
  const captures = await filesIn(join(ctx.userDataPath, TROUBLESHOOTING_DIR))
  const secrets = await storedSecretValues(ctx)
  const files: Zippable = {}
  for (const [folder, list] of [
    [LOGS_DIR, logs],
    [TROUBLESHOOTING_DIR, captures]
  ] as const) {
    for (const f of list) {
      const text = await readFile(f.path, 'utf8')
      files[`${folder}/${f.name}`] = new TextEncoder().encode(scrub(text, secrets))
    }
  }
  const readme = [
    'Notula logs',
    '',
    `Exported: ${new Date().toISOString()}`,
    `Notula ${app.getVersion()} · Electron ${process.versions.electron} · Chromium ${process.versions.chrome} · Node ${process.versions.node}`,
    `OS: ${osType()} ${release()} (${process.platform} ${arch()})`,
    '',
    'Files:',
    ...[...logs.map((f) => `  ${LOGS_DIR}/${f.name} (${formatBytes(f.bytes)})`), ...captures.map((f) => `  ${TROUBLESHOOTING_DIR}/${f.name} (${formatBytes(f.bytes)})`)],
    ...(logs.length + captures.length === 0 ? ['  (none)'] : []),
    '',
    'On this computer:',
    `  ${TRACES_DIR}/: ${formatBytes(await folderBytes(join(ctx.userDataPath, TRACES_DIR)))} (not included)`,
    `  ${TROUBLESHOOTING_DIR}/: ${formatBytes(captures.reduce((n, f) => n + f.bytes, 0))}`,
    '',
    'Not included: your notes and database, preferences, API keys, Local State, audio and traces.',
    'Notula never uploads this file. Share it only with someone you trust to read your logs.',
    ''
  ].join('\r\n')
  files['README.txt'] = new TextEncoder().encode(readme)
  return zipAsync(files, TRACE_LIMITS.zipLevel)
}

/** Export logs… (page and menu): the save dialog, then the zip. */
export async function exportLogsInteractive(ctx: MainContext, source: string): Promise<InvokeRes<'diag:export-logs'>> {
  const options: Electron.SaveDialogOptions = {
    title: 'Export logs',
    buttonLabel: 'Export',
    defaultPath: join(app.getPath('downloads'), `notula-logs-${fileStamp()}.zip`),
    filters: [{ name: 'Zip archive', extensions: ['zip'] }]
  }
  // Dev builds only: NOTULA_DEV_DIALOG_DIR answers the save dialog, for scripted checks.
  const devDir = ctx.isDev ? process.env['NOTULA_DEV_DIALOG_DIR'] : undefined
  const win = ctx.windows.main() ?? BrowserWindow.getFocusedWindow()
  const res = devDir
    ? { canceled: false, filePath: join(devDir, basename(options.defaultPath ?? 'notula-logs.zip')) }
    : win
      ? await dialog.showSaveDialog(win, options)
      : await dialog.showSaveDialog(options)
  if (res.canceled || !res.filePath) return { cancelled: true }
  try {
    const bytes = await buildLogsZip(ctx)
    await writeFile(res.filePath, bytes)
    log('info', 'diag:logs-exported', { source, bytes: bytes.byteLength })
    reveal(ctx, res.filePath)
    return { path: res.filePath }
  } catch (err) {
    log('error', 'diag:logs-export-failed', { source, err })
    throw notulaError('internal', 'Couldn’t export logs')
  }
}

export async function openLogsFolder(ctx: MainContext): Promise<void> {
  const dir = join(ctx.userDataPath, LOGS_DIR)
  try {
    await mkdir(dir, { recursive: true })
    const err = await shell.openPath(dir)
    if (err) log('warn', 'diag:open-logs-folder-failed', { err })
  } catch (err) {
    log('warn', 'diag:open-logs-folder-failed', { err })
  }
}

// ---------- the performance trace ----------

let tracing = false

function pushTrace(ctx: MainContext, state: PushPayload<'diag:trace-state'>): void {
  for (const wc of ctx.windows.targets()) wc.send('diag:trace-state' satisfies PushChannel, state)
}

async function stopTrace(ctx: MainContext, reason: 'auto' | 'manual'): Promise<void> {
  const dir = join(ctx.userDataPath, TRACES_DIR)
  const ts = fileStamp()
  const tracePath = join(dir, `trace-${ts}.json`)
  const heapPath = join(dir, `heap-${ts}.heapsnapshot`)
  const zipPath = join(dir, `trace-${ts}.zip`)
  try {
    await mkdir(dir, { recursive: true })
    const written = await contentTracing.stopRecording(tracePath)
    let heapWritten = false
    try {
      writeHeapSnapshot(heapPath)
      heapWritten = true
    } catch (err) {
      log('warn', 'perf-trace:heap-snapshot-failed', { err })
    }
    const files: Zippable = { [basename(written)]: new Uint8Array(await readFile(written)) }
    if (heapWritten) files[basename(heapPath)] = new Uint8Array(await readFile(heapPath))
    const bytes = await zipAsync(files, TRACE_LIMITS.zipLevel)
    await writeFile(zipPath, bytes, { flag: 'wx' })
    await unlink(written).catch(() => undefined)
    if (heapWritten) await unlink(heapPath).catch(() => undefined)
    reveal(ctx, zipPath)
    log('info', 'perf-trace:stopped', { reason, filename: basename(zipPath) })
    pushTrace(ctx, { state: 'stopped', path: zipPath })
  } catch (err) {
    log('error', 'content-tracing:stop-failed', { reason, err })
    pushTrace(ctx, { state: 'error', path: null })
  } finally {
    tracing = false
  }
}

/** Record Performance Trace (10s): page, Help menu and the Windows tray. */
export async function startTrace(ctx: MainContext, source: string): Promise<{ ok: boolean }> {
  if (tracing) throw notulaError('busy', 'A performance trace is already recording')
  tracing = true
  try {
    await contentTracing.startRecording({ included_categories: ['*'] })
  } catch (err) {
    tracing = false
    log('error', 'perf-trace:start-failed', { source, err })
    return { ok: false }
  }
  log('info', 'perf-trace:started', { durationMs: TRACE_LIMITS.durationMs, source })
  pushTrace(ctx, { state: 'started', path: null })
  setTimeout(() => void stopTrace(ctx, 'auto'), TRACE_LIMITS.durationMs)
  return { ok: true }
}

// ---------- the macOS unified log ----------

let unified: { child: ChildProcess; file: WriteStream; path: string } | null = null

export function unifiedLogRunning(): boolean {
  return unified !== null
}

function unifiedStatus(): UnifiedLogStatus {
  if (!isMac) return { supported: false, running: false, path: null }
  return { supported: true, running: unified !== null, path: unified?.path ?? null }
}

function stopUnified(reveal: boolean): void {
  const u = unified
  if (!u) return
  unified = null
  try {
    u.child.kill('SIGTERM')
  } catch (err) {
    log('warn', 'unified-log-stream:kill-failed', { err })
  }
  u.file.end()
  log('info', 'system-log-stream:stopped', { logFilePath: u.path })
  if (reveal) shell.showItemInFolder(u.path)
  rebuildApplicationMenu()
}

async function startUnified(ctx: MainContext): Promise<void> {
  const dir = join(ctx.userDataPath, TROUBLESHOOTING_DIR)
  try {
    await mkdir(dir, { recursive: true })
  } catch (err) {
    log('error', 'system-log-stream:folder-failed', { err })
    throw notulaError('internal', 'Couldn’t start the system log capture.')
  }
  const path = join(dir, `${fileStamp()}-unified-log.log`)
  const file = createWriteStream(path, { flags: 'a' })
  const filterArgs = ['--predicate', UNIFIED_LOG_PREDICATE, '--level', 'debug', '--style', 'compact']
  const child = spawn('/usr/bin/log', ['stream', ...filterArgs], { stdio: ['ignore', 'pipe', 'pipe'] })
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', () => resolve())
    child.once('error', (err) => {
      file.end()
      log('error', 'unified-log-stream:spawn-failed', { err })
      reject(notulaError('internal', 'Couldn’t start the system log capture.'))
    })
  })
  child.stdout?.pipe(file, { end: false })
  child.stderr?.pipe(file, { end: false })
  unified = { child, file, path }
  child.on('error', (err) => log('error', 'system-log-stream:error', { err }))
  child.on('exit', (code, signal) => {
    log('info', 'unified-log-stream:exited', { code, signal })
    if (unified?.child === child) {
      unified = null
      file.end()
      rebuildApplicationMenu()
    }
  })
  log('info', 'system-log-stream:started', { pid: child.pid, logFilePath: path, filterArgs })
  rebuildApplicationMenu()
}

/** Start/Stop macOS Unified Log (menu and page). Elsewhere it only answers "not supported". */
export async function toggleUnifiedLog(ctx: MainContext, source: string): Promise<UnifiedLogStatus> {
  if (!isMac) return unifiedStatus()
  if (unified) stopUnified(true)
  else {
    log('info', 'unified-log-stream:start-requested', { source })
    await startUnified(ctx)
  }
  return unifiedStatus()
}

// ---------- registration ----------

export function registerDiagnostics(ctx: MainContext): void {
  // Detailed logging: at startup and on every change.
  void ctx.settings
    .get('diagnostics.verboseLogging')
    .then((on) => setVerboseLogging(on === true))
    .catch((err: unknown) => log('warn', 'diag:verbose-read-failed', { err }))
  ctx.bus.on('settings:changed', (e) => {
    if (e.keys.includes('diagnostics.verboseLogging')) setVerboseLogging(e.settings['diagnostics.verboseLogging'] === true)
  })

  ipcMain.handle('diag:export-logs' satisfies InvokeChannel, () => exportLogsInteractive(ctx, 'page'))
  ipcMain.on('diag:show-logs-folder' satisfies SendChannel, () => void openLogsFolder(ctx))
  ipcMain.handle('diag:trace-start' satisfies InvokeChannel, () => startTrace(ctx, 'page'))
  ipcMain.handle('diag:unified-log-toggle' satisfies InvokeChannel, () => toggleUnifiedLog(ctx, 'page'))
  ipcMain.handle('diag:unified-log-status' satisfies InvokeChannel, (): UnifiedLogStatus => unifiedStatus())

  // Quitting stops a running capture without revealing it.
  app.on('before-quit', () => stopUnified(false))
}
