#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// notula: Notula's companion CLI. Zero dependencies, Node >= 18 APIs only.
// Runs under `node` or under the Notula executable with ELECTRON_RUN_AS_NODE=1 (the launchers pick).
//
// Reads the current user's `<userData>/local-api/companion.json` (or NOTULA_COMPANION_FILE), opens the
// pipe or socket it names, authenticates with the per-start token and sends one request.
// Exit codes: 0 success, 1 API error, 2 usage error. Results print to stdout as JSON; errors print to
// stderr as JSON with `code` and `message`.
'use strict'

const fs = require('node:fs')
const net = require('node:net')
const path = require('node:path')
const { spawn } = require('node:child_process')

const START_WAIT_MS = 15000
const REQUEST_TIMEOUT_MS = 60000
const OFF_MESSAGE = "Notula isn't running, or the companion CLI is off in Notula ▸ Settings ▸ Labs."
const TZ_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i

const SOURCE_KINDS = ['video', 'live', 'lesson', 'other']

const HELP = `notula: read your Notula meeting notes from the command line.

Usage:
  notula help
  notula notes list [--limit N] [--offset N] [--created-after TIME] [--created-before TIME]
                    [--source-kind KIND] [--series-id ID] [--has-source[=BOOL]] [--has-series[=BOOL]]
  notula notes get --id ID [--id ID ...]
  notula notes transcript get --id ID
  notula series list
  notula series get --id ID
  notula folders list [--search TEXT]
  notula folders add-document --folder-id ID --document-id ID
  notula folders remove-document --folder-id ID --document-id ID

Results print as JSON. TIME needs a timezone offset or Z, for example 2026-10-01T09:00:00Z.
KIND is video, live, lesson or other. BOOL is true or false; a bare --has-source means true.
--has-series=false lists the source notes that are in no series.
Exit codes: 0 success, 1 Notula error, 2 usage error.
`

class UsageError extends Error {}

function fail(code, message, exit) {
  process.stderr.write(JSON.stringify({ code, message }) + '\n')
  process.exit(exit)
}

/**
 * `--name value` and `--name=value`; repeated names collect into a list. Names in `booleans`
 * may also stand alone (true) or take a following `true` / `false`.
 */
function parseFlags(args, allowed, booleans = []) {
  const out = {}
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (!a.startsWith('--')) throw new UsageError(`Unexpected argument ${a}`)
    let name = a.slice(2)
    let value
    const eq = name.indexOf('=')
    if (eq >= 0) {
      value = name.slice(eq + 1)
      name = name.slice(0, eq)
    } else if (booleans.includes(name)) {
      value = args[i + 1] === 'true' || args[i + 1] === 'false' ? args[++i] : 'true'
    } else {
      value = args[++i]
      if (value === undefined) throw new UsageError(`--${name} needs a value`)
    }
    if (!allowed.includes(name)) throw new UsageError(`Unknown option --${name}`)
    ;(out[name] = out[name] || []).push(value)
  }
  return out
}

function one(flags, name, required) {
  const v = flags[name]
  if (!v) {
    if (required) throw new UsageError(`--${name} is required`)
    return undefined
  }
  if (v.length > 1) throw new UsageError(`--${name} can be given once`)
  return v[0]
}

function intFlag(flags, name, min, max) {
  const v = one(flags, name, false)
  if (v === undefined) return undefined
  if (!/^\d+$/.test(v) || Number(v) < min || Number(v) > max) throw new UsageError(`--${name} must be a whole number from ${min} to ${max}.`)
  return Number(v)
}

function boolFlag(flags, name) {
  const v = one(flags, name, false)
  if (v === undefined) return undefined
  if (v !== 'true' && v !== 'false') throw new UsageError(`--${name} must be true or false`)
  return v === 'true'
}

function idFlag(flags, name, required) {
  const v = one(flags, name, required)
  if (v === undefined) return undefined
  if (!v.trim() || v.length > 200) throw new UsageError(`--${name} needs an id`)
  return v.trim()
}

function timeFlag(flags, name) {
  const v = one(flags, name, false)
  if (v === undefined) return undefined
  if (!TZ_TIME.test(v) || Number.isNaN(Date.parse(v))) throw new UsageError(`--${name} needs a time with a timezone offset or Z, for example 2026-10-01T09:00:00Z`)
  return v
}

/** argv → { method, params }, or null for help. */
function parseCommand(argv) {
  const [a, b, c, ...rest] = argv
  if (!a || a === 'help' || a === '--help' || a === '-h') return null
  if (a === 'notes' && b === 'list') {
    const f = parseFlags(
      [c, ...rest].filter((x) => x !== undefined),
      ['limit', 'offset', 'created-after', 'created-before', 'source-kind', 'series-id', 'has-source', 'has-series'],
      ['has-source', 'has-series']
    )
    const params = {}
    const limit = intFlag(f, 'limit', 1, 100)
    const offset = intFlag(f, 'offset', 0, Number.MAX_SAFE_INTEGER)
    const after = timeFlag(f, 'created-after')
    const before = timeFlag(f, 'created-before')
    if (limit !== undefined) params.limit = limit
    if (offset !== undefined) params.offset = offset
    if (after !== undefined) params.created_after = after
    if (before !== undefined) params.created_before = before
    const kind = one(f, 'source-kind', false)
    if (kind !== undefined && !SOURCE_KINDS.includes(kind)) throw new UsageError(`--source-kind must be one of ${SOURCE_KINDS.join(', ')}`)
    if (kind !== undefined) params.source_kind = kind
    const seriesId = idFlag(f, 'series-id', false)
    if (seriesId !== undefined) params.series_id = seriesId
    const hasSource = boolFlag(f, 'has-source')
    if (hasSource !== undefined) params.has_source = hasSource
    const hasSeries = boolFlag(f, 'has-series')
    if (hasSeries !== undefined) params.has_series = hasSeries
    return { method: 'notes.list', params }
  }
  if (a === 'series' && b === 'list') {
    parseFlags([c, ...rest].filter((x) => x !== undefined), [])
    return { method: 'series.list', params: {} }
  }
  if (a === 'series' && b === 'get') {
    const f = parseFlags([c, ...rest].filter((x) => x !== undefined), ['id'])
    return { method: 'series.get', params: { id: idFlag(f, 'id', true) } }
  }
  if (a === 'notes' && b === 'get') {
    const f = parseFlags([c, ...rest].filter((x) => x !== undefined), ['id'])
    const ids = f.id || []
    if (ids.length < 1 || ids.length > 100) throw new UsageError('Give 1 to 100 --id options')
    return { method: 'notes.get', params: { ids } }
  }
  if (a === 'notes' && b === 'transcript' && c === 'get') {
    const f = parseFlags(rest, ['id'])
    return { method: 'transcripts.get', params: { id: one(f, 'id', true) } }
  }
  if (a === 'folders' && b === 'list') {
    const f = parseFlags([c, ...rest].filter((x) => x !== undefined), ['search'])
    const search = one(f, 'search', false)
    if (search !== undefined && (search.trim().length < 1 || search.trim().length > 200)) throw new UsageError('--search must be 1 to 200 characters')
    return { method: 'folders.list', params: search === undefined ? {} : { search } }
  }
  if (a === 'folders' && (b === 'add-document' || b === 'remove-document')) {
    const f = parseFlags([c, ...rest].filter((x) => x !== undefined), ['folder-id', 'document-id'])
    return {
      method: b === 'add-document' ? 'folders.notes.add' : 'folders.notes.remove',
      params: { folder_id: one(f, 'folder-id', true), document_id: one(f, 'document-id', true) }
    }
  }
  throw new UsageError(`Unknown command: ${argv.join(' ')}. Run "notula help".`)
}

function companionFile() {
  return process.env.NOTULA_COMPANION_FILE || path.join(__dirname, '..', 'companion.json')
}

function readCompanion() {
  try {
    const j = JSON.parse(fs.readFileSync(companionFile(), 'utf8'))
    if (j && j.protocol_version === 1 && typeof j.path === 'string' && typeof j.token === 'string') return j
  } catch {
    // Missing or partly written.
  }
  return null
}

/** One connection: auth, one request, the response. Rejects with { connect: true } when the endpoint is gone. */
function call(info, method, params) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(info.path)
    let buf = ''
    let authed = false
    let settled = false
    const done = (fn, v) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      fn(v)
    }
    const timer = setTimeout(() => done(reject, { code: 'INTERNAL_ERROR', message: 'Notula did not answer in time' }), REQUEST_TIMEOUT_MS)
    socket.setEncoding('utf8')
    socket.on('connect', () => socket.write(JSON.stringify({ type: 'auth', token: info.token }) + '\n'))
    socket.on('error', (err) => {
      if (!authed && (err.code === 'ENOENT' || err.code === 'ECONNREFUSED')) done(reject, { connect: true })
      else done(reject, { code: 'INTERNAL_ERROR', message: err.message })
    })
    socket.on('close', () => done(reject, authed ? { code: 'INTERNAL_ERROR', message: 'Notula closed the connection' } : { connect: true }))
    socket.on('data', (chunk) => {
      buf += chunk
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        let msg
        try {
          msg = JSON.parse(line)
        } catch {
          continue
        }
        if (msg.type === 'auth') {
          if (!msg.ok) return done(reject, { connect: true })
          authed = true
          socket.write(JSON.stringify({ type: 'request', id: '1', method, params }) + '\n')
        } else if (msg.type === 'response') {
          if (msg.ok) return done(resolve, msg.result)
          return done(reject, msg.error || { code: 'INTERNAL_ERROR', message: 'Unknown error' })
        }
      }
    })
  })
}

/** Starts Notula once, tray only (`--notula-task=background`). */
function startNotula() {
  const exe = process.env.NOTULA_EXE
  if (!exe) return false
  const args = []
  if (process.env.NOTULA_APP_ARGS) args.push(process.env.NOTULA_APP_ARGS)
  args.push('--notula-task=background')
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.NOTULA_EXE
  delete env.NOTULA_APP_ARGS
  try {
    const child = spawn(exe, args, { detached: true, stdio: 'ignore', env, windowsHide: true })
    child.on('error', () => undefined)
    child.unref()
    return true
  } catch {
    return false
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  let cmd
  try {
    cmd = parseCommand(process.argv.slice(2))
  } catch (err) {
    if (err instanceof UsageError) fail('USAGE', err.message, 2)
    throw err
  }
  if (!cmd) {
    process.stdout.write(HELP)
    return
  }

  const attempt = async (info) => {
    try {
      return { ok: true, result: await call(info, cmd.method, cmd.params) }
    } catch (e) {
      if (e && e.connect) return { ok: false, connect: true }
      return { ok: false, error: e }
    }
  }

  let info = readCompanion()
  let r = info ? await attempt(info) : { ok: false, connect: true }
  if (!r.ok && r.connect) {
    // The listener is up without the companion token: the Labs switch is off, so don't start anything.
    const endpoint = path.join(path.dirname(companionFile()), 'endpoint.json')
    let listenerUp = false
    try {
      // A file left by a crash names a process that is gone.
      process.kill(JSON.parse(fs.readFileSync(endpoint, 'utf8')).pid, 0)
      listenerUp = true
    } catch (e) {
      listenerUp = !!(e && e.code === 'EPERM')
    }
    if (listenerUp || !startNotula()) fail('NOT_RUNNING', OFF_MESSAGE, 1)
    const stale = info && info.token
    const until = Date.now() + START_WAIT_MS
    while (Date.now() < until) {
      await sleep(250)
      info = readCompanion()
      if (!info || info.token === stale) continue
      r = await attempt(info)
      if (r.ok || !r.connect) break
    }
    if (!r.ok && r.connect) fail('NOT_RUNNING', OFF_MESSAGE, 1)
  }
  if (!r.ok) fail(r.error.code || 'INTERNAL_ERROR', r.error.message || 'Unknown error', 1)
  process.stdout.write(JSON.stringify(r.result, null, 2) + '\n')
}

main().catch((err) => fail('INTERNAL_ERROR', err && err.message ? err.message : String(err), 1))
