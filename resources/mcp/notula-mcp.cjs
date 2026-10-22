#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// notula-mcp: the stdio shim AI apps launch to reach Notula's local MCP server. No
// dependencies; Node 18 or newer, or Notula's own executable with ELECTRON_RUN_AS_NODE=1.
//
//   notula-mcp.cjs --endpoint <endpoint.json> --app <Notula executable> [--app-arg <arg>]…
//   environment: NOTULA_MCP_TOKEN
//
// stdout carries only MCP messages (one JSON-RPC message per line); everything else goes to
// stderr. Each stdin line is POSTed to http://127.0.0.1:<port>/mcp; a JSON reply is written
// as one line, an SSE reply one `data` payload per line, a 202 writes nothing. On stdin end
// the session is deleted and the shim exits 0.

'use strict'

const fs = require('node:fs')
const readline = require('node:readline')
const { spawn } = require('node:child_process')

const START_TIMEOUT_MS = 15000
const OFF_MESSAGE = 'The Notula MCP server is off. Turn it on in Notula ▸ Settings ▸ Connectors.'

function fail(message) {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

function parseArgs(argv) {
  const out = { endpoint: null, app: null, appArgs: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--endpoint') out.endpoint = argv[++i] || null
    else if (a === '--app') out.app = argv[++i] || null
    else if (a === '--app-arg') out.appArgs.push(argv[++i] || '')
  }
  return out
}

function readEndpoint(path) {
  try {
    const v = JSON.parse(fs.readFileSync(path, 'utf8'))
    return v && v.version === 1 && Number.isInteger(v.port) ? v : null
  } catch {
    return null
  }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err && err.code === 'EPERM'
  }
}

async function reachable(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'GET', signal: AbortSignal.timeout(1000) })
    await res.body?.cancel().catch(() => undefined)
    return true
  } catch {
    return false
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function startApp(args) {
  if (!args.app) fail("Notula didn't start")
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.NOTULA_MCP_TOKEN
  try {
    const child = spawn(args.app, [...args.appArgs, '--notula-task=background'], { detached: true, stdio: 'ignore', env, windowsHide: false })
    child.on('error', () => undefined)
    child.unref()
  } catch {
    fail("Notula didn't start")
  }
}

async function resolveEndpoint(args) {
  let ep = readEndpoint(args.endpoint)
  if (ep && pidAlive(ep.pid) && ep.enabled && ep.stdio && (await reachable(ep.port))) return ep
  if (ep && pidAlive(ep.pid) && (!ep.enabled || !ep.stdio)) fail(OFF_MESSAGE)
  process.stderr.write('Starting Notula…\n')
  startApp(args)
  const deadline = Date.now() + START_TIMEOUT_MS
  while (Date.now() < deadline) {
    await sleep(300)
    ep = readEndpoint(args.endpoint)
    if (!ep || !pidAlive(ep.pid)) continue
    if (!ep.enabled || !ep.stdio) fail(OFF_MESSAGE)
    if (await reachable(ep.port)) return ep
  }
  fail("Notula didn't start")
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.endpoint) fail('notula-mcp: --endpoint is required')
  const token = process.env.NOTULA_MCP_TOKEN
  if (!token) fail('notula-mcp: NOTULA_MCP_TOKEN is not set. Copy the configuration again from Notula ▸ Settings ▸ Connectors.')
  const ep = await resolveEndpoint(args)
  const url = `http://127.0.0.1:${ep.port}/mcp`

  let sessionId = null
  let protocolVersion = null
  /** Until the session exists, messages go one at a time; then concurrently. */
  let gate = Promise.resolve()
  const inflight = new Set()

  const write = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`)

  const headers = () => {
    const h = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream'
    }
    if (sessionId) h['Mcp-Session-Id'] = sessionId
    if (protocolVersion) h['MCP-Protocol-Version'] = protocolVersion
    return h
  }

  const noteInit = (msg) => {
    if (msg && msg.result && typeof msg.result.protocolVersion === 'string') protocolVersion = msg.result.protocolVersion
  }

  const relay = async (line, msg) => {
    let res
    try {
      res = await fetch(url, { method: 'POST', headers: headers(), body: line })
    } catch {
      if (msg && msg.id !== undefined) write({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'Notula is not reachable.' } })
      return
    }
    const sid = res.headers.get('mcp-session-id')
    if (sid) sessionId = sid
    if (res.status === 202) {
      await res.body?.cancel().catch(() => undefined)
      return
    }
    const type = res.headers.get('content-type') || ''
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      process.stderr.write(`notula-mcp: HTTP ${res.status}${text ? `: ${text.slice(0, 300)}` : ''}\n`)
      if (res.status === 401) process.stderr.write('notula-mcp: the token was refused. Copy the configuration again from Notula ▸ Settings ▸ Connectors.\n')
      if (msg && msg.id !== undefined) {
        let parsed = null
        try {
          parsed = JSON.parse(text)
        } catch {}
        if (parsed && parsed.jsonrpc === '2.0' && parsed.error) write({ ...parsed, id: msg.id })
        else write({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: `Notula answered HTTP ${res.status}` } })
      }
      return
    }
    if (type.includes('text/event-stream')) {
      const decoder = new TextDecoder()
      let buf = ''
      let data = []
      const flush = () => {
        if (!data.length) return
        const payload = data.join('\n')
        data = []
        try {
          const obj = JSON.parse(payload)
          noteInit(obj)
          write(obj)
        } catch {
          process.stderr.write('notula-mcp: dropped an SSE event that is not JSON\n')
        }
      }
      for await (const chunk of res.body) {
        buf += decoder.decode(chunk, { stream: true })
        let i
        while ((i = buf.indexOf('\n')) >= 0) {
          const raw = buf.slice(0, i).replace(/\r$/, '')
          buf = buf.slice(i + 1)
          if (raw === '') flush()
          else if (raw.startsWith('data:')) data.push(raw.slice(5).replace(/^ /, ''))
        }
      }
      flush()
      return
    }
    const text = await res.text()
    if (!text.trim()) return
    try {
      const obj = JSON.parse(text)
      const list = Array.isArray(obj) ? obj : [obj]
      for (const m of list) {
        noteInit(m)
        write(m)
      }
    } catch {
      process.stderr.write('notula-mcp: Notula sent a reply that is not JSON\n')
    }
  }

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
  rl.on('line', (line) => {
    if (!line.trim()) return
    let msg = null
    try {
      msg = JSON.parse(line)
    } catch {
      process.stderr.write('notula-mcp: ignored a stdin line that is not JSON\n')
      return
    }
    const run = () => relay(line, msg).catch((err) => process.stderr.write(`notula-mcp: ${err && err.message ? err.message : err}\n`))
    let p
    if (!sessionId) {
      p = gate.then(run)
      gate = p
    } else p = run()
    inflight.add(p)
    p.finally(() => inflight.delete(p))
  })
  rl.on('close', async () => {
    await gate.catch(() => undefined)
    await Promise.allSettled([...inflight])
    if (sessionId) {
      await fetch(url, { method: 'DELETE', headers: headers(), signal: AbortSignal.timeout(2000) }).catch(() => undefined)
    }
    process.exit(0)
  })
}

main().catch((err) => fail(`notula-mcp: ${err && err.message ? err.message : err}`))
