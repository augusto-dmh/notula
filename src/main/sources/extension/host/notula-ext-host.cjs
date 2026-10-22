#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// notula-ext-host: the relay between a browser's native-messaging port and Notula's per-user pipe.
// Zero dependencies, Node >= 18 APIs only, run by
// notula-ext-host.cmd under the Notula executable with ELECTRON_RUN_AS_NODE=1.
//
// Browser side: 4-byte little-endian length + UTF-8 JSON. Pipe side: one JSON object per line.
// The relay holds no state and no logic beyond framing, size limits and the `auth` line:
// - argv: the caller's origin (`chrome-extension://<id>/`), then `--parent-window=<handle>`.
// - `endpoint.json` next to this script names the pipe and the per-start token; main writes it
//   while the bridge listens and deletes it on stop and quit.
// - Notula not reachable: one `{type:"bridge", state:"not-running"}` to the browser, then a retry
//   every 2 s for 10 s. Frames the browser sent meanwhile (its `hello`) are kept and forwarded if
//   the pipe comes up in time; otherwise the relay exits and the browser closes the port.
// - A browser frame over 1 MiB is dropped (counted); a pipe line over 1 MiB is dropped (the browser
//   refuses host messages over 1 MB); more than 4 MiB buffered either way ends the relay.
// - It exits when stdin closes (the browser closed the port) or when Notula closes the pipe.
// It never starts Notula, and it writes nothing to stdout but frames.
'use strict'

const fs = require('node:fs')
const net = require('node:net')
const path = require('node:path')

const HOST_VERSION = '1.0.0'
const FRAME_MAX = 1_048_576
const BUFFER_MAX = 4_194_304
const RETRIES = 5
const RETRY_MS = 2_000
/** Frames kept while Notula isn't reachable yet (the `hello`, a `mark`). */
const PENDING_MAX = 16
const PIPE_PREFIX = '\\\\.\\pipe\\notula-ext-bridge-'
const ORIGIN = /^chrome-extension:\/\/[a-p]{32}\/$/

const origin = process.argv[2] || ''
let socket = null
let connected = false
let exiting = false
let toldNotRunning = false
let attempts = 0
const pending = []
let pendingBytes = 0
const drops = { 'relay:frame-too-big': 0, 'relay:frame-invalid': 0, 'relay:line-too-big': 0, 'relay:line-invalid': 0 }

function exit(code) {
  if (exiting) return
  exiting = true
  if (socket) socket.destroy()
  // Let a last frame reach the browser before the process ends.
  process.stdout.write(Buffer.alloc(0), () => process.exit(code))
  setTimeout(() => process.exit(code), 500).unref()
}

// ---------- the browser side ----------

function toBrowser(json) {
  const body = Buffer.from(json, 'utf8')
  if (body.length > FRAME_MAX) {
    drops['relay:line-too-big']++
    return
  }
  const head = Buffer.alloc(4)
  head.writeUInt32LE(body.length, 0)
  process.stdout.write(Buffer.concat([head, body]))
}

let inBuf = Buffer.alloc(0)
/** Bytes of an oversized frame still to skip. */
let skip = 0

function onStdin(chunk) {
  if (skip > 0) {
    const n = Math.min(skip, chunk.length)
    skip -= n
    chunk = chunk.subarray(n)
    if (chunk.length === 0) return
  }
  inBuf = inBuf.length ? Buffer.concat([inBuf, chunk]) : chunk
  for (;;) {
    if (inBuf.length < 4) break
    const len = inBuf.readUInt32LE(0)
    if (len > FRAME_MAX) {
      drops['relay:frame-too-big']++
      const have = inBuf.length - 4
      if (have >= len) {
        inBuf = inBuf.subarray(4 + len)
        continue
      }
      skip = len - have
      inBuf = Buffer.alloc(0)
      break
    }
    if (inBuf.length < 4 + len) break
    const body = inBuf.subarray(4, 4 + len)
    inBuf = inBuf.subarray(4 + len)
    onFrame(body)
  }
  if (inBuf.length > BUFFER_MAX) exit(1)
}

function onFrame(body) {
  let line
  try {
    const msg = JSON.parse(body.toString('utf8'))
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) throw new Error('not an object')
    // Re-serialised so the pipe gets exactly one line per message.
    line = JSON.stringify(msg) + '\n'
  } catch {
    drops['relay:frame-invalid']++
    return
  }
  if (connected) {
    socket.write(line)
    return
  }
  if (pending.length >= PENDING_MAX || pendingBytes + line.length > BUFFER_MAX) return
  pending.push(line)
  pendingBytes += line.length
}

// ---------- the pipe side ----------

function readEndpoint() {
  try {
    const e = JSON.parse(fs.readFileSync(path.join(__dirname, 'endpoint.json'), 'utf8'))
    if (!e || typeof e.path !== 'string' || typeof e.token !== 'string') return null
    if (!e.path.startsWith(PIPE_PREFIX) || e.token.length < 16 || e.token.length > 200) return null
    return e
  } catch {
    return null
  }
}

function notReachable() {
  if (exiting) return
  if (!toldNotRunning) {
    toldNotRunning = true
    toBrowser(JSON.stringify({ type: 'bridge', state: 'not-running' }))
  }
  if (++attempts > RETRIES) return exit(0)
  setTimeout(connect, RETRY_MS)
}

let pipeBuf = ''

function onPipeData(chunk) {
  pipeBuf += chunk
  let nl
  while ((nl = pipeBuf.indexOf('\n')) >= 0) {
    const line = pipeBuf.slice(0, nl).trim()
    pipeBuf = pipeBuf.slice(nl + 1)
    if (!line) continue
    if (line.length > FRAME_MAX) {
      drops['relay:line-too-big']++
      continue
    }
    try {
      const msg = JSON.parse(line)
      if (!msg || typeof msg !== 'object' || Array.isArray(msg)) throw new Error('not an object')
    } catch {
      drops['relay:line-invalid']++
      continue
    }
    toBrowser(line)
  }
  if (pipeBuf.length > BUFFER_MAX) exit(1)
}

function flushDrops() {
  if (!connected) return
  for (const k of Object.keys(drops)) {
    if (drops[k] > 0) socket.write(JSON.stringify({ type: 'log', event: k, count: drops[k] }) + '\n')
    drops[k] = 0
  }
}

function connect() {
  if (exiting) return
  const e = readEndpoint()
  if (!e) return notReachable()
  const s = net.connect(e.path)
  s.setEncoding('utf8')
  s.once('connect', () => {
    socket = s
    connected = true
    s.write(JSON.stringify({ type: 'auth', token: e.token, origin, host_version: HOST_VERSION }) + '\n')
    for (const line of pending.splice(0)) s.write(line)
    pendingBytes = 0
    setInterval(flushDrops, 60_000).unref()
  })
  s.on('data', onPipeData)
  s.on('error', () => {
    if (!connected) notReachable()
  })
  s.on('close', () => {
    // Notula quit, restarted (a new token) or refused the auth: the browser reconnects later.
    if (connected) exit(0)
  })
}

// ---------- start ----------

if (!ORIGIN.test(origin)) {
  process.exit(1)
}
process.stdin.on('data', onStdin)
process.stdin.on('end', () => exit(0))
process.stdin.on('error', () => exit(0))
process.stdout.on('error', () => exit(0))
connect()
