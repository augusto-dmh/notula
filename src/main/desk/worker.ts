// SPDX-License-Identifier: Apache-2.0
// The notula-desk utility process entry, built to out/main/desk.js: dictation's OS helpers
// (foreground app, focused-field context, synthetic paste) while dictation is armed.
// No network, no audio.
//
// - Windows: one warm Windows PowerShell running `resources/desk/desk.ps1` (no native
//   addon). Requests and replies are JSON lines; this process only relays them.
// - macOS: each op is one `osascript` call to System Events (foreground app and window,
//   Cmd+V). Focused-field context is not available (`unsupported`); the modifier state is not
//   readable, so main waits a fixed 300 ms.
// - Protocol with main: {type:'start', scriptPath} → {type:'ready'}; {type:'req', id, op} →
//   {type:'reply', id, ok, …}; {type:'stop'}. A reply that does not come is main's timeout.
// - The key hook: {type:'hook-start', scriptPath} spawns
//   `resources/desk/keyhook.ps1` (Windows) or `keyhook-mac.js` under osascript (macOS) and
//   relays its JSON lines as {type:'hook', …}; {type:'hook-send', msg} writes one request;
//   {type:'hook-stop'} ends it; its exit is {type:'hook-exit', code}. One hook process at most.

import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'

type MainToDesk =
  | { type: 'start'; scriptPath: string }
  | { type: 'req'; id: number; op: string }
  | { type: 'stop' }
  | { type: 'hook-start'; scriptPath: string }
  | { type: 'hook-send'; msg: Record<string, unknown> }
  | { type: 'hook-stop' }

const port = process.parentPort
let ps: ChildProcessWithoutNullStreams | null = null
let hook: ChildProcessWithoutNullStreams | null = null

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
      send({ ...msg, type: 'hook' })
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

function startWindows(scriptPath: string): void {
  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-OwnerPid', String(process.pid)],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
  )
  ps = child
  child.on('error', (err) => {
    send({ type: 'log', level: 'warn', event: 'desk:powershell-error', data: { err: err.message } })
    send({ type: 'exit' })
  })
  child.stderr.setEncoding('utf8')
  let stderr = ''
  child.stderr.on('data', (s: string) => {
    stderr = (stderr + s).slice(-2_000)
  })
  child.on('exit', (code) => {
    if (ps === child) ps = null
    send({ type: 'log', level: code === 0 ? 'debug' : 'warn', event: 'desk:powershell-exit', data: { code, stderr: stderr.slice(-400) } })
    send({ type: 'exit' })
  })
  createInterface({ input: child.stdout }).on('line', (line) => {
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(line) as Record<string, unknown>
    } catch {
      return
    }
    if (msg['event'] === 'ready') send({ type: 'ready' })
    else send({ ...msg, type: 'reply' })
  })
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
    case 'fullscreen':
      // macOS full-screen apps live in their own Space, where the panel is not shown anyway.
      return { fullscreen: false }
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
    if (process.platform === 'win32') startWindows(m.scriptPath)
    else send({ type: 'ready' })
    return
  }
  if (m.type === 'hook-start') return startHook(m.scriptPath)
  if (m.type === 'hook-send') {
    if (hook) hook.stdin.write(`${JSON.stringify(m.msg)}
`)
    return
  }
  if (m.type === 'hook-stop') return stopHook()
  if (m.type === 'stop') {
    stopHook()
    if (ps) {
      ps.stdin.end()
      const child = ps
      setTimeout(() => child.kill(), 1_000).unref()
    }
    setTimeout(() => process.exit(0), 1_200).unref()
    return
  }
  if (m.type === 'req') {
    if (process.platform === 'win32') {
      if (!ps) {
        send({ type: 'reply', id: m.id, ok: false, error: 'helper not running' })
        return
      }
      ps.stdin.write(`${JSON.stringify({ id: m.id, op: m.op })}\n`)
      return
    }
    macOp(m.op).then(
      (r) => send({ ...r, type: 'reply', id: m.id, ok: true }),
      (err: unknown) => send({ type: 'reply', id: m.id, ok: false, error: err instanceof Error ? err.message : String(err) })
    )
  }
})
