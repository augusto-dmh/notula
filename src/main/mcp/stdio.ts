// SPDX-License-Identifier: Apache-2.0
// The stdio transport for the user's local MCP servers, written on
// the SDK's framing helpers so main controls the spawn itself:
//
// - an argument list, never a shell string; on Windows a `.cmd` / `.bat` launcher (npx)
//   is resolved on PATH and run through cmd.exe with every argument escaped;
// - the minimal inherited environment plus the user's variables;
// - stderr into a 200 KB ring (`View log`), with the user's secret values masked;
// - shutdown: close stdin, wait 5 s, then terminate.

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, extname, isAbsolute, join } from 'node:path'
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { MCP_LIMITS } from '@shared/types/mcp'

const INHERITED = ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'USERPROFILE', 'HOME', 'TEMP', 'TMP', 'TMPDIR', 'APPDATA', 'LOCALAPPDATA', 'ComSpec', 'PATHEXT', 'LANG']

/** A bounded text log, oldest bytes dropped first. */
export class RingLog {
  private text = ''
  constructor(
    private readonly max: number,
    private readonly mask: () => string[]
  ) {}
  append(chunk: string): void {
    let t = chunk
    for (const secret of this.mask()) if (secret.length >= 4) t = t.split(secret).join('••••')
    this.text += t
    if (this.text.length > this.max) this.text = this.text.slice(this.text.length - this.max)
  }
  note(line: string): void {
    this.append(`[notula ${new Date().toISOString()}] ${line}\n`)
  }
  read(): string {
    return this.text
  }
}

function minimalEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const k of INHERITED) {
    const v = process.env[k]
    if (typeof v === 'string' && !(k in env)) env[k] = v
  }
  return { ...env, ...extra }
}

/** Finds `cmd` on PATH the way cmd.exe would (PATHEXT), returning the full path or null. */
function whichWindows(cmd: string, env: Record<string, string>): string | null {
  const exts = (env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
  const candidates = (base: string): string[] => (extname(base) ? [base] : exts.map((e) => base + e.toLowerCase()))
  const isFile = (p: string): boolean => {
    try {
      return existsSync(p) && statSync(p).isFile()
    } catch {
      return false
    }
  }
  if (isAbsolute(cmd) || cmd.includes('\\') || cmd.includes('/')) return candidates(cmd).find(isFile) ?? null
  const dirs = (env['PATH'] ?? env['Path'] ?? '').split(delimiter).filter(Boolean)
  for (const d of dirs) {
    const hit = candidates(join(d, cmd)).find(isFile)
    if (hit) return hit
  }
  return null
}

// cmd.exe quoting (the cross-spawn rules): quote each argument, double the backslashes that
// precede a quote, then caret-escape every metacharacter, twice for a batch shim.
const META = /([()\][%!^"`<>&|;, *?])/g
function escapeCommand(s: string): string {
  return s.replace(META, '^$1')
}
function escapeArgument(arg: string): string {
  let a = arg.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"').replace(/(?=(\\+?)?)\1$/, '$1$1')
  a = `"${a}"`
  return a.replace(META, '^$1').replace(META, '^$1')
}

export interface SpawnSpec {
  command: string
  args: string[]
  cwd: string | null
  env: Record<string, string>
}

export function spawnServer(spec: SpawnSpec): ChildProcess {
  const env = minimalEnv(spec.env)
  const cwd = spec.cwd && existsSync(spec.cwd) ? spec.cwd : homedir()
  const opts = { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'], windowsHide: true }
  if (process.platform === 'win32') {
    const resolved = whichWindows(spec.command, env)
    if (!resolved) throw new Error(`Command not found: ${spec.command}`)
    if (/\.(cmd|bat)$/i.test(resolved)) {
      const line = [escapeCommand(resolved), ...spec.args.map(escapeArgument)].join(' ')
      return spawn(env['ComSpec'] ?? 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], { ...opts, windowsVerbatimArguments: true })
    }
    return spawn(resolved, spec.args, opts)
  }
  return spawn(spec.command, spec.args, opts)
}

/** One MCP session over a child's stdin/stdout. */
export class ChildStdioTransport implements Transport {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void
  private child: ChildProcess | null = null
  private readonly buffer = new ReadBuffer()
  private closed = false

  constructor(
    private readonly spec: SpawnSpec,
    private readonly log: RingLog,
    private readonly onExit: (code: number | null, signal: string | null, expected: boolean) => void
  ) {}

  get pid(): number | null {
    return this.child?.pid ?? null
  }

  async start(): Promise<void> {
    const child = spawnServer(this.spec)
    this.child = child
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', () => resolve())
      child.once('error', (err) => reject(err))
    })
    child.on('error', (err) => this.onerror?.(err))
    child.stdout!.on('data', (chunk: Buffer) => {
      this.buffer.append(chunk)
      for (;;) {
        let msg: JSONRPCMessage | null
        try {
          msg = this.buffer.readMessage()
        } catch (err) {
          this.log.note('dropped a line that is not JSON-RPC')
          this.onerror?.(err instanceof Error ? err : new Error(String(err)))
          continue
        }
        if (!msg) break
        this.onmessage?.(msg)
      }
    })
    child.stderr!.setEncoding('utf8')
    child.stderr!.on('data', (s: string) => this.log.append(s))
    child.stdin!.on('error', () => undefined)
    child.on('exit', (code, signal) => {
      const expected = this.closed
      this.child = null
      this.log.note(`process exited (code ${code ?? 'none'}${signal ? `, ${signal}` : ''})`)
      this.onExit(code, signal, expected)
      this.onclose?.()
    })
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const stdin = this.child?.stdin
    if (!stdin || stdin.destroyed) throw new Error('The server process is not running.')
    await new Promise<void>((resolve, reject) => {
      stdin.write(serializeMessage(message), (err) => (err ? reject(err) : resolve()))
    })
  }

  /** The MCP stdio shutdown: close stdin, wait, then terminate. */
  async close(): Promise<void> {
    this.closed = true
    const child = this.child
    if (!child) return
    await new Promise<void>((resolve) => {
      let done = false
      const finish = (): void => {
        if (done) return
        done = true
        resolve()
      }
      child.once('exit', finish)
      child.stdin?.end()
      setTimeout(() => {
        if (child.exitCode !== null || child.signalCode !== null) return finish()
        // On Windows a cmd.exe shim's own children (npx → node) die only with the tree.
        if (process.platform === 'win32' && child.pid) {
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => child.kill())
        } else child.kill()
        setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
          finish()
        }, 2_000).unref()
      }, MCP_LIMITS.shutdownGraceMs).unref()
    })
  }
}
