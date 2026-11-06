// SPDX-License-Identifier: Apache-2.0
// The notula-desk utility process entry, built to out/main/desk.js: dictation's OS helpers
// (foreground app, focused-field context, synthetic paste). Main forks it only while the key
// hook runs or a request needs it. No network, no audio.
//
// - Windows: one Windows PowerShell running `resources/desk/desk.ps1` (no native addon), the
//   ops script. It starts on the first request; requests that arrive while it starts wait for
//   its ready line, and get `ok:false` if it fails. Requests and replies are JSON lines; this
//   process only relays them. {type:'ops-stop'} closes its stdin (its exit raises what it
//   still holds lowered).
// - macOS: each op is one `osascript` call to System Events (foreground app and window,
//   Cmd+V). Focused-field context is not available (`unsupported`); the modifier state is not
//   readable, so main waits a fixed 300 ms.
// - Protocol with main: {type:'start', scriptPath} → {type:'ready'} at once; {type:'req', id,
//   op, args?} → {type:'reply', id, ok, …}; {type:'stop'}. A reply that does not come is main's
//   timeout. The ops script's start is {type:'ops-ready'} (logged as `desk:ops-started` with
//   its `ms` and the op that started it), its exit {type:'ops-exit'}.
// - The key hook: {type:'hook-start', scriptPath} spawns
//   `resources/desk/keyhook.ps1` (Windows) or `keyhook-mac.js` under osascript (macOS) and
//   relays its JSON lines as {type:'hook', …}; {type:'hook-send', msg} writes one request;
//   {type:'hook-stop'} ends it; its exit is {type:'hook-exit', code}. One hook process at most.
// - Full screen: either script can run the watcher (foreground-watch.cs). Its unsolicited lines
//   are pushed as {type:'fullscreen', from:'hook'|'ops', full, x, y}, never as a reply.

import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'

type OpsRequest = { id: number; op: string; args?: Record<string, unknown> }

type MainToDesk =
  | { type: 'start'; scriptPath: string }
  | ({ type: 'req' } & OpsRequest)
  | { type: 'ops-stop' }
  | { type: 'stop' }
  | { type: 'hook-start'; scriptPath: string }
  | { type: 'hook-send'; msg: Record<string, unknown> }
  | { type: 'hook-stop' }

const port = process.parentPort
let scriptPath: string | null = null
let ps: ChildProcessWithoutNullStreams | null = null
let psReady = false
/** Requests waiting for the ops script's ready line. */
let queued: OpsRequest[] = []
let hook: ChildProcessWithoutNullStreams | null = null

function pushFullscreen(from: 'hook' | 'ops', msg: Record<string, unknown>): void {
  send({ type: 'fullscreen', from, full: msg['full'], x: msg['x'], y: msg['y'] })
}

function startHook(scriptPath: string): void {
  if (hook) return
  const child =
    process.platform === 'win32'
      ? spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-OwnerPid', String(process.pid)], {
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe']
        })
      : spawn('osascript', ['-l', 'JavaScript', scriptPath], { stdio: ['pipe', 'pipe', 'pipe'] })
  hook = child
  send({ type: 'log', level: 'info', event: 'desk:hook-spawned', data: { pid: child.pid ?? null } })
  child.on('error', (err) => send({ type: 'log', level: 'warn', event: 'desk:hook-error', data: { err: err.message } }))
  child.stderr.setEncoding('utf8')
  let stderr = ''
  child.stderr.on('data', (t: string) => {
    stderr = (stderr + t).slice(-2_000)
  })
  child.on('exit', (code) => {
    if (hook === child) hook = null
    send({ type: 'log', level: code === 0 ? 'debug' : 'warn', event: 'desk:hook-exit', data: { code, stderr: stderr.slice(-400) } })
    send({ type: 'hook-exit', code })
  })
  createInterface({ input: child.stdout }).on('line', (line) => {
    try {
      const msg = JSON.parse(line) as Record<string, unknown>
      if (msg['event'] === 'fullscreen') pushFullscreen('hook', msg)
      else send({ ...msg, type: 'hook' })
    } catch {
      /* not a protocol line */
    }
  })
}

function stopHook(): void {
  const child = hook
  if (!child) return
  child.stdin.end()
  setTimeout(() => {
    if (child.exitCode === null) child.kill()
  }, 1_000).unref()
}

function send(m: Record<string, unknown>): void {
  port.postMessage(m)
}

function writeOps(r: OpsRequest): void {
  ps?.stdin.write(`${JSON.stringify(r)}\n`)
}

function failQueued(error: string): void {
  const waiting = queued
  queued = []
  for (const r of waiting) send({ type: 'reply', id: r.id, ok: false, error })
}

/** Spawns the ops script for `reason`, the op that needs it. */
function startOps(reason: string): void {
  if (ps || !scriptPath) return
  const t0 = Date.now()
  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-OwnerPid', String(process.pid)],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
  )
  ps = child
  psReady = false
  let gone = false
  const exited = (): void => {
    if (gone) return
    gone = true
    if (ps !== child) return
    ps = null
    psReady = false
    failQueued('helper not running')
    send({ type: 'ops-exit' })
  }
  child.on('error', (err) => {
    send({ type: 'log', level: 'warn', event: 'desk:powershell-error', data: { err: err.message } })
    exited()
  })
  // A write racing the script's exit fails here instead of throwing; the exit settles the requests.
  child.stdin.on('error', () => undefined)
  child.stderr.setEncoding('utf8')
  let stderr = ''
  child.stderr.on('data', (s: string) => {
    stderr = (stderr + s).slice(-2_000)
  })
  child.on('exit', (code) => {
    send({ type: 'log', level: code === 0 ? 'debug' : 'warn', event: 'desk:powershell-exit', data: { code, stderr: stderr.slice(-400) } })
    exited()
  })
  createInterface({ input: child.stdout }).on('line', (line) => {
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(line) as Record<string, unknown>
    } catch {
      return
    }
    if (msg['event'] === 'ready') {
      if (ps !== child || psReady) return
      psReady = true
      send({ type: 'log', level: 'info', event: 'desk:ops-started', data: { ms: Date.now() - t0, reason } })
      send({ type: 'ops-ready' })
      const waiting = queued
      queued = []
      for (const r of waiting) writeOps(r)
    } else if (msg['event'] === 'fullscreen') pushFullscreen('ops', msg)
    else send({ ...msg, type: 'reply' })
  })
}

/** Closes the ops script's stdin: it raises what it holds and exits. It is let go at once, so a
 *  request that arrives meanwhile starts a fresh one. */
function stopOps(): void {
  const child = ps
  if (!child) return
  ps = null
  psReady = false
  failQueued('helper stopped')
  child.stdin.end()
  setTimeout(() => {
    if (child.exitCode === null) child.kill()
  }, 1_000).unref()
}

function osascript(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-e', script], { timeout: 3_000 }, (err, stdout) => (err ? reject(err) : resolve(String(stdout).trim())))
  })
}

async function macOp(op: string): Promise<Record<string, unknown>> {
  switch (op) {
    case 'ping':
      return {}
    case 'foreground': {
      const out = await osascript(
        'tell application "System Events"\nset p to first application process whose frontmost is true\nset n to name of p\nset t to ""\ntry\nset t to name of front window of p\nend try\nset b to ""\ntry\nset b to bundle identifier of p\nend try\nreturn n & linefeed & t & linefeed & b\nend tell'
      )
      const [process, title = '', bundle = ''] = out.split('\n')
      return { process, title, bundle, pid: 0 }
    }
    case 'context': {
      const fg = await macOp('foreground')
      return { result: 'unsupported', process: fg['process'], title: fg['title'], bundle: fg['bundle'], field: null, before: '', after: '', selection: '' }
    }
    case 'modifiers':
      return { held: null }
    case 'paste':
      await osascript('tell application "System Events" to keystroke "v" using command down')
      return { sent: true }
    default:
      throw new Error('unknown op')
  }
}

port.on('message', (e: { data: MainToDesk }) => {
  const m = e.data
  if (m.type === 'start') {
    scriptPath = m.scriptPath
    send({ type: 'ready' })
    return
  }
  if (m.type === 'hook-start') return startHook(m.scriptPath)
  if (m.type === 'hook-send') {
    if (hook) hook.stdin.write(`${JSON.stringify(m.msg)}
`)
    return
  }
  if (m.type === 'hook-stop') return stopHook()
  if (m.type === 'ops-stop') return stopOps()
  if (m.type === 'stop') {
    stopHook()
    stopOps()
    setTimeout(() => process.exit(0), 1_200).unref()
    return
  }
  if (m.type === 'req') {
    if (process.platform === 'win32') {
      // Args go along: duck's root, factor and fade, unduck's entries, the watcher's on.
      const r: OpsRequest = { id: m.id, op: m.op, ...(m.args ? { args: m.args } : {}) }
      if (!ps) startOps(m.op)
      if (!ps) send({ type: 'reply', id: m.id, ok: false, error: 'helper not running' })
      else if (psReady) writeOps(r)
      else queued.push(r)
      return
    }
    macOp(m.op).then(
      (r) => send({ ...r, type: 'reply', id: m.id, ok: true }),
      (err: unknown) => send({ type: 'reply', id: m.id, ok: false, error: err instanceof Error ? err.message : String(err) })
    )
  }
})
