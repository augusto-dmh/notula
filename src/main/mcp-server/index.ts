// SPDX-License-Identifier: Apache-2.0
// registerMcpServer(): Notula's localhost MCP server and the notula-mcp shim config; the
// `mcp-server:*` IPC.
//
// - Listens while `mcpServer.enabled` and at least one transport switch is on, with
//   `node:http` on 127.0.0.1 only, port `mcpServer.port`, single endpoint `/mcp`.
// - Request order: Origin → 403; Host not 127.0.0.1:<port> / localhost:<port> → 403; no or
//   unknown bearer → 401; a token whose kind's switch is off → 401; 20/s per token, burst 40
//   → 429 with Retry-After; body over 1 MB → 413; then one SDK StreamableHTTPServerTransport
//   per MCP session, bound to the token that opened it.
// - Tokens: `ntl_mcp_` + 32 random bytes base64url, shown once; only the SHA-256 hash is
//   stored, compared in constant time.
// - Tools: the ten read-only library tools through `ctx.chat.runLibraryTool` (chat's own
//   implementation: same caps and shapes as chat), `readOnlyHint: true`, at most 4
//   concurrent calls per token. No model calls, no writes. `readAboutMe` is listed too while
//   the user shares their About me profile and the token isn't paused (user-context).
// - `<userData>/mcp/endpoint.json` tells the shim where to connect; removed on quit.
// - Local-only mode stops the server.
// - Usage: every tool call adds one call to its token's row for the local day, and a failed or
//   refused one also an error (`mcp_token_usage`). Counts only: no tool names, arguments or
//   results. Rows older than 30 days are pruned at start-up and daily. `mcp-server:list-apps`
//   shows each token as a connected app with its last 30 days.
// - Install (`mcp-server:install`): mints a token for Cursor or VS Code and opens the app's own
//   install link with it. The token, the link and the entry never leave main or reach the log.
//   Notula never writes another app's config file.
// - Setup snippets (`mcp-server:get-snippet`): a new token in the setup text for a local app,
//   shown once.

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import { app, ipcMain, shell } from 'electron'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { InvokeChannel, InvokeReq, InvokeRes, PushChannel } from '@shared/ipc'
import { notulaError } from '@shared/errors'
import {
  MCP_LIMITS,
  MCP_TOKEN_PREFIX,
  type McpConnectedApp,
  type McpInstallResult,
  type McpInstallTarget,
  type McpSnippet,
  type McpSnippetClient,
  type McpLocalServerActivity,
  type McpLocalServerConfig,
  type McpLocalServerStatus,
  type McpStdioConfig
} from '@shared/types/mcp'
import type { LibraryToolName } from '../chat/tool-api'
import type { MainContext } from '../context'
import { resourcePath } from '../lifecycle/resources'
import { log } from '../log'
import { egressBlocked } from '../privacy'
import { agentAccess, forgetAgent, profileMarkdown, recordAgentRead } from '../user-context'

interface Session {
  transport: StreamableHTTPServerTransport
  server: Server
  tokenId: string
  clientName: string | null
}

interface Bucket {
  tokens: number
  at: number
}

const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex')

const ABOUT_ME_TOOL = {
  name: 'readAboutMe',
  title: 'About me',
  description:
    'Returns the About me profile the user keeps in Notula, as Markdown. It can hold these sections: Who you are, What you’re working on, People you work with, Your teams and routines, How you like to work, Communication, Your meetings and calendar, Where your notes go, and How Notula should help you. After them come two tables when they have rows: the projects the user is part of (with a summary and their part) and the terms they use (with meanings). Read it to fit your answers to this user.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { title: 'About me', readOnlyHint: true, destructiveHint: false, openWorldHint: false }
} as const

function deny(res: ServerResponse, status: number, message: string, headers: Record<string, string> = {}): void {
  if (res.headersSent) return
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers })
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }))
}

const DAY_MS = 86_400_000

/** The local calendar day `offset` days from today, as `YYYY-MM-DD`. */
function localDay(offset = 0): string {
  const d = new Date(Date.now() + offset * DAY_MS)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const INSTALL_NAMES: Record<McpInstallTarget, string> = { cursor: 'Cursor', vscode: 'VS Code' }

/** An argument for a command line: quoted when it holds anything but plain path characters. */
function shellArg(a: string): string {
  if (/^[\w@%+=:,./\\-]+$/.test(a)) return a
  // Windows paths can't hold a quote, and a backslash there is a path separator.
  return `"${process.platform === 'win32' ? a : a.replace(/(["\\$`])/g, '\\$1')}"`
}

/** Absolute `node` (≥ 18) on PATH, or null. */
function findNode(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('node', ['-p', 'process.execPath + "|" + process.versions.node'], { timeout: 5_000, windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null)
      const [path, version] = String(stdout).trim().split('|')
      const major = Number((version ?? '').split('.')[0])
      resolve(path && major >= 18 ? path : null)
    })
  })
}

export function registerMcpServer(ctx: MainContext): void {
  const endpointDir = join(ctx.userDataPath, 'mcp')
  const endpointFile = join(endpointDir, 'endpoint.json')
  let config: McpLocalServerConfig = { enabled: false, stdio: true, http: false, port: MCP_LIMITS.defaultPort }
  let http: HttpServer | null = null
  let listening = false
  let error: McpLocalServerStatus['error'] = null
  const sessions = new Map<string, Session>()
  const buckets = new Map<string, Bucket>()
  const running = new Map<string, number>()
  const touched = new Map<string, number>()
  const activity: McpLocalServerActivity[] = []
  /** Token id → the client name from its last MCP handshake. Memory only. */
  const clients = new Map<string, string>()
  let restarting: Promise<void> = Promise.resolve()

  const status = (): McpLocalServerStatus => ({
    ...config,
    listening,
    error,
    url: listening && config.http ? `http://127.0.0.1:${config.port}/mcp` : null
  })

  const push = (): void => {
    const s = status()
    for (const wc of ctx.windows.targets()) wc.send('mcp-server:changed' satisfies PushChannel, s)
  }

  const writeEndpoint = (): void => {
    try {
      mkdirSync(endpointDir, { recursive: true })
      const body = { version: 1, port: config.port, pid: process.pid, enabled: config.enabled && listening, stdio: config.stdio, http: config.http }
      writeFileSync(endpointFile, JSON.stringify(body), { mode: 0o600 })
    } catch (err) {
      log('warn', 'mcp-server:endpoint-write-failed', { err: err instanceof Error ? err.message : String(err) })
    }
  }

  // ---------- auth and limits ----------

  const authenticate = async (header: string | undefined): Promise<{ id: string; kind: 'stdio' | 'http' } | null> => {
    const m = /^Bearer\s+(\S+)$/i.exec(header ?? '')
    const token = m?.[1]
    if (!token || !token.startsWith(MCP_TOKEN_PREFIX)) return null
    const hash = sha256(token)
    const row = await ctx.storage.findMcpServerToken(hash).catch(() => null)
    if (!row) return null
    const a = Buffer.from(hash, 'hex')
    const b = Buffer.from(row.token_hash, 'hex')
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null
    const now = Date.now()
    if (now - (touched.get(row.id) ?? 0) > 60_000) {
      touched.set(row.id, now)
      void ctx.storage.touchMcpServerToken(row.id, new Date(now).toISOString()).catch(() => undefined)
    }
    return { id: row.id, kind: row.kind }
  }

  /** Token bucket: ms until the next request is allowed, or 0. */
  const rateLimit = (tokenId: string): number => {
    const now = Date.now()
    const b = buckets.get(tokenId) ?? { tokens: MCP_LIMITS.burst, at: now }
    b.tokens = Math.min(MCP_LIMITS.burst, b.tokens + ((now - b.at) / 1_000) * MCP_LIMITS.ratePerSec)
    b.at = now
    buckets.set(tokenId, b)
    if (b.tokens >= 1) {
      b.tokens -= 1
      return 0
    }
    return Math.ceil(((1 - b.tokens) / MCP_LIMITS.ratePerSec) * 1_000)
  }

  const readBody = (req: IncomingMessage): Promise<Buffer | 'too-large'> =>
    new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      let size = 0
      let over = false
      req.on('data', (c: Buffer) => {
        if (over) return
        size += c.length
        if (size > MCP_LIMITS.bodyMaxBytes) {
          over = true
          resolve('too-large')
          return
        }
        chunks.push(c)
      })
      req.on('end', () => !over && resolve(Buffer.concat(chunks)))
      req.on('error', reject)
    })

  // ---------- one MCP session ----------

  const recordActivity = (a: McpLocalServerActivity): void => {
    activity.unshift(a)
    if (activity.length > MCP_LIMITS.activityMax) activity.length = MCP_LIMITS.activityMax
  }

  /** One tool call in the token's daily usage row; a failed or refused call also counts an error. */
  const recordUsage = (tokenId: string, ok: boolean): void => {
    ctx.storage
      .recordMcpUsage({ tokenId, day: localDay(), error: !ok, at: new Date().toISOString() })
      .catch((err: unknown) => log('warn', 'mcp-server:usage-record-failed', { err: err instanceof Error ? err.message : String(err) }))
  }

  const pruneUsage = (): void => {
    ctx.storage
      .pruneMcpUsage(localDay(-MCP_LIMITS.usageDays))
      .then((n) => n && log('info', 'mcp-server:usage-pruned', { rows: n }))
      .catch((err: unknown) => log('warn', 'mcp-server:usage-prune-failed', { err: err instanceof Error ? err.message : String(err) }))
  }

  /** `readAboutMe`: the profile while it is shared with this token; each read is recorded. */
  const readAboutMe = async (tokenId: string, client: string | null, started: number): Promise<CallToolResult> => {
    const access = await agentAccess(ctx, tokenId).catch(() => 'off' as const)
    const ok = access === 'ok'
    recordActivity({ at: new Date(started).toISOString(), client, tool: ABOUT_ME_TOOL.name, ok, durationMs: Date.now() - started })
    recordUsage(tokenId, ok)
    if (access === 'paused') return { content: [{ type: 'text', text: "The user has paused this app's access to their profile." }], isError: true }
    if (!ok) return { content: [{ type: 'text', text: `Unknown tool ${ABOUT_ME_TOOL.name}.` }], isError: true }
    const { markdown } = await profileMarkdown(ctx)
    await recordAgentRead(ctx, tokenId).catch((err: unknown) => log('warn', 'mcp-server:about-me-record-failed', { err: err instanceof Error ? err.message : String(err) }))
    return { content: [{ type: 'text', text: markdown }] }
  }

  const newSession = (tokenId: string): StreamableHTTPServerTransport => {
    const server = new Server({ name: 'notula', version: app.getVersion() }, { capabilities: { tools: {} } })
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        sessions.set(sid, { transport, server, tokenId, clientName: null })
      }
    })
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId)
    }
    server.oninitialized = () => {
      const name = server.getClientVersion()?.name
      if (name) clients.set(tokenId, name.slice(0, 100))
    }
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        ...ctx.chat.libraryTools().map((t) => ({
          name: t.name,
          title: t.title,
          description: t.description,
          inputSchema: t.inputSchema as { type: 'object'; [k: string]: unknown },
          outputSchema: { ...t.outputSchema, type: 'object' } as { type: 'object'; [k: string]: unknown },
          annotations: { title: t.title, readOnlyHint: true, destructiveHint: false, openWorldHint: false }
        })),
        ...((await agentAccess(ctx, tokenId).catch(() => 'off')) === 'ok' ? [ABOUT_ME_TOOL] : [])
      ]
    }))
    server.setRequestHandler(CallToolRequestSchema, async (request, extra): Promise<CallToolResult> => {
      const name = request.params.name
      const started = Date.now()
      const client = server.getClientVersion()?.name ?? null
      if (name === ABOUT_ME_TOOL.name) return readAboutMe(tokenId, client, started)
      const known = ctx.chat.libraryTools().some((t) => t.name === name)
      if (!known) {
        recordUsage(tokenId, false)
        return { content: [{ type: 'text', text: `Unknown tool ${name}.` }], isError: true }
      }
      const n = running.get(tokenId) ?? 0
      if (n >= MCP_LIMITS.concurrentPerToken) {
        recordUsage(tokenId, false)
        return { content: [{ type: 'text', text: 'Too many tool calls at once. Wait for one to finish and try again.' }], isError: true }
      }
      running.set(tokenId, n + 1)
      try {
        const args = request.params.arguments && typeof request.params.arguments === 'object' ? request.params.arguments : {}
        const r = await ctx.chat.runLibraryTool(name as LibraryToolName, args, extra.signal)
        recordActivity({ at: new Date(started).toISOString(), client, tool: name, ok: !r.isError, durationMs: Date.now() - started })
        recordUsage(tokenId, !r.isError)
        log('debug', 'mcp-server:tool-call', { client, tool: name, ok: !r.isError, ms: Date.now() - started })
        if (r.isError) return { content: [{ type: 'text', text: r.content }], isError: true }
        const data = r.data
        const structured = data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : { result: data ?? null }
        return { content: [{ type: 'text', text: r.content }], structuredContent: structured }
      } catch (err) {
        recordActivity({ at: new Date(started).toISOString(), client, tool: name, ok: false, durationMs: Date.now() - started })
        recordUsage(tokenId, false)
        log('debug', 'mcp-server:tool-call', { client, tool: name, ok: false, ms: Date.now() - started })
        return { content: [{ type: 'text', text: 'The tool failed. Try again.' }], isError: true }
      } finally {
        running.set(tokenId, Math.max(0, (running.get(tokenId) ?? 1) - 1))
      }
    })
    void server.connect(transport)
    return transport
  }

  // ---------- the HTTP listener ----------

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const path = (req.url ?? '').split('?')[0]
    if (req.headers.origin !== undefined) return deny(res, 403, 'Browser origins are not allowed.')
    const host = (req.headers.host ?? '').toLowerCase()
    if (host !== `127.0.0.1:${config.port}` && host !== `localhost:${config.port}`) return deny(res, 403, 'Host not allowed.')
    if (path !== '/mcp') return deny(res, 404, 'Not found.')
    const auth = await authenticate(req.headers.authorization)
    if (!auth) return deny(res, 401, 'A valid Notula MCP token is required.', { 'WWW-Authenticate': 'Bearer' })
    if ((auth.kind === 'stdio' && !config.stdio) || (auth.kind === 'http' && !config.http)) {
      return deny(res, 401, 'This kind of connection is turned off in Notula.', { 'WWW-Authenticate': 'Bearer' })
    }
    const wait = rateLimit(auth.id)
    if (wait > 0) return deny(res, 429, 'Too many requests.', { 'Retry-After': String(Math.max(1, Math.ceil(wait / 1_000))) })

    let body: unknown = undefined
    if (req.method === 'POST') {
      const raw = await readBody(req)
      if (raw === 'too-large') {
        deny(res, 413, 'Request body too large.')
        req.destroy()
        return
      }
      try {
        body = JSON.parse(raw.toString('utf8'))
      } catch {
        return deny(res, 400, 'Parse error.')
      }
    }

    const sid = req.headers['mcp-session-id']
    const sessionId = Array.isArray(sid) ? sid[0] : sid
    if (sessionId) {
      const s = sessions.get(sessionId)
      if (!s || s.tokenId !== auth.id) return deny(res, 404, 'Session not found.')
      await s.transport.handleRequest(req, res, body)
      return
    }
    if (req.method !== 'POST') return deny(res, 400, 'No session.')
    const transport = newSession(auth.id)
    await transport.handleRequest(req, res, body)
  }

  const closeSessions = async (): Promise<void> => {
    const all = [...sessions.values()]
    sessions.clear()
    await Promise.allSettled(all.map((s) => s.server.close()))
  }

  const stop = async (): Promise<void> => {
    await closeSessions()
    const h = http
    http = null
    listening = false
    if (h) {
      h.closeAllConnections()
      await new Promise<void>((resolve) => h.close(() => resolve()))
    }
  }

  const start = async (): Promise<void> => {
    await stop()
    error = null
    const wanted = config.enabled && (config.stdio || config.http)
    if (wanted && (await egressBlocked(ctx, { kind: 'mcp-server' }))) {
      error = 'local-only'
      log('info', 'mcp-server:stopped', { reason: 'local-only mode' })
    }
    if (wanted && !error) {
      const h = createServer((req, res) => {
        handle(req, res).catch((err) => {
          log('warn', 'mcp-server:request-failed', { err: err instanceof Error ? err.message : String(err) })
          deny(res, 500, 'Internal error.')
        })
      })
      h.requestTimeout = 120_000
      const ok = await new Promise<boolean>((resolve) => {
        h.once('error', (err: NodeJS.ErrnoException) => {
          if (err.code === 'EADDRINUSE') error = 'port-in-use'
          log('warn', 'mcp-server:listen-failed', { port: config.port, code: err.code })
          resolve(false)
        })
        h.listen(config.port, '127.0.0.1', () => resolve(true))
      })
      if (ok) {
        http = h
        listening = true
        log('info', 'mcp-server:listening', { port: config.port, stdio: config.stdio, http: config.http })
      } else h.close()
    }
    writeEndpoint()
    push()
  }

  const restart = (): Promise<void> => {
    restarting = restarting.then(start, start)
    return restarting
  }

  const readConfig = async (): Promise<void> => {
    const s = await ctx.settings.getAll()
    config = { enabled: s['mcpServer.enabled'], stdio: s['mcpServer.stdio'], http: s['mcpServer.http'], port: s['mcpServer.port'] }
  }

  void app.whenReady().then(async () => {
    try {
      await readConfig()
    } catch (err) {
      log('warn', 'mcp-server:read-failed', { err: err instanceof Error ? err.message : String(err) })
    }
    await restart()
    pruneUsage()
    setInterval(pruneUsage, DAY_MS).unref()
  })
  ctx.bus.on('settings:changed', (e) => {
    if (!e.keys.some((k) => k.startsWith('mcpServer.') || k === 'privacy.localOnly')) return
    config = {
      enabled: e.settings['mcpServer.enabled'],
      stdio: e.settings['mcpServer.stdio'],
      http: e.settings['mcpServer.http'],
      port: e.settings['mcpServer.port']
    }
    void restart()
  })
  app.on('will-quit', () => {
    void stop()
    try {
      rmSync(endpointFile, { force: true })
    } catch {
      /* best effort */
    }
  })

  // ---------- tokens ----------

  const mint = async (name: string, kind: 'stdio' | 'http', target: McpInstallTarget | null = null): Promise<{ id: string; token: string }> => {
    const clean = typeof name === 'string' ? name.trim().slice(0, 100) : ''
    if (!clean) throw notulaError('invalid-input', 'Enter a name for this connection.')
    const token = MCP_TOKEN_PREFIX + randomBytes(32).toString('base64url')
    const id = randomUUID()
    await ctx.storage.createMcpServerToken({ id, name: clean, kind, token_hash: sha256(token), install_target: target })
    log('info', 'mcp-server:token-created', { kind, ...(target ? { target } : {}) })
    return { id, token }
  }

  const revoke = async (id: string): Promise<void> => {
    await ctx.storage.deleteMcpServerToken(id)
    // Sessions opened with the token end with it. Its usage rows go with it (ON DELETE CASCADE).
    for (const [sid, s] of sessions) {
      if (s.tokenId !== id) continue
      sessions.delete(sid)
      void s.server.close().catch(() => undefined)
    }
    buckets.delete(id)
    clients.delete(id)
    await forgetAgent(ctx, id).catch(() => undefined)
    log('info', 'mcp-server:token-revoked')
  }

  /** How an app launches the `notula-mcp` shim with `token`: the same entry everywhere. */
  const stdioEntry = async (token: string): Promise<{ command: string; args: string[]; env: Record<string, string>; usesNode: boolean }> => {
    const node = await findNode()
    const shim = resourcePath('mcp/notula-mcp.cjs')
    const args = [shim, '--endpoint', endpointFile, '--app', process.execPath]
    // Unpackaged runs start Electron with the app folder.
    if (!app.isPackaged) args.push('--app-arg', app.getAppPath())
    const env: Record<string, string> = { NOTULA_MCP_TOKEN: token }
    if (!node) env['ELECTRON_RUN_AS_NODE'] = '1'
    // Dev runs keep their own profile and display when the shim starts the app.
    if (!app.isPackaged) {
      for (const k of ['NOTULA_USER_DATA_DIR', 'NOTULA_DEV_DISPLAY']) {
        const v = process.env[k]
        if (v) env[k] = v
      }
    }
    return { command: node ?? process.execPath, args, env, usesNode: !!node }
  }

  const httpEntry = (token: string): { url: string; headers: Record<string, string> } => ({
    url: `http://127.0.0.1:${config.port}/mcp`,
    headers: { Authorization: `Bearer ${token}` }
  })

  /** Whether the server answers apps right now: on, a transport on, listening. */
  const serving = (): boolean => config.enabled && (config.stdio || config.http) && listening

  // ---------- IPC ----------

  ipcMain.handle('mcp-server:get-status' satisfies InvokeChannel, (): InvokeRes<'mcp-server:get-status'> => status())

  ipcMain.handle('mcp-server:set-config' satisfies InvokeChannel, async (_e, p: McpLocalServerConfig): Promise<InvokeRes<'mcp-server:set-config'>> => {
    const port = Number(p?.port)
    if (!Number.isInteger(port) || port < 1_024 || port > 65_535) throw notulaError('invalid-input', 'Choose a port between 1024 and 65535.')
    const next = { enabled: p.enabled === true, stdio: p.stdio === true, http: p.http === true, port }
    const keys = ['mcpServer.enabled', 'mcpServer.stdio', 'mcpServer.http', 'mcpServer.port'] as const
    const values = [next.enabled, next.stdio, next.http, next.port] as const
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i]!
      if (config[k.slice('mcpServer.'.length) as keyof McpLocalServerConfig] !== values[i]) await ctx.settings.set(k, values[i] as never)
    }
    config = next
    await restart()
    return status()
  })

  ipcMain.handle('mcp-server:create-token' satisfies InvokeChannel, (_e, p: { name: string }): Promise<InvokeRes<'mcp-server:create-token'>> =>
    mint(p?.name, 'http')
  )

  ipcMain.handle('mcp-server:list-tokens' satisfies InvokeChannel, (): Promise<InvokeRes<'mcp-server:list-tokens'>> => ctx.storage.listMcpServerTokens())

  ipcMain.handle('mcp-server:revoke-token' satisfies InvokeChannel, async (_e, p: { id: string }): Promise<InvokeRes<'mcp-server:revoke-token'>> => {
    if (typeof p?.id !== 'string') throw notulaError('invalid-input', 'id is required')
    await revoke(p.id)
  })

  ipcMain.handle('mcp-server:get-stdio-config' satisfies InvokeChannel, async (_e, p: { name: string }): Promise<InvokeRes<'mcp-server:get-stdio-config'>> => {
    const { id, token } = await mint(p?.name || 'Claude Desktop', 'stdio')
    const { command, args, env, usesNode } = await stdioEntry(token)
    const cfg: McpStdioConfig = {
      tokenId: id,
      entryName: 'notula',
      command,
      args,
      env,
      configJson: JSON.stringify({ mcpServers: { notula: { command, args, env } } }, null, 2),
      usesNode
    }
    log('info', 'mcp-server:stdio-config', { usesNode })
    return cfg
  })

  ipcMain.handle(
    'mcp-server:get-snippet' satisfies InvokeChannel,
    async (_e, p: InvokeReq<'mcp-server:get-snippet'>): Promise<InvokeRes<'mcp-server:get-snippet'>> => {
      const client = p?.client as McpSnippetClient
      const names: Record<McpSnippetClient, string> = {
        'claude-desktop': 'Claude Desktop',
        'claude-code': 'Claude Code',
        cursor: 'Cursor',
        vscode: 'VS Code',
        program: 'App that launches Notula',
        url: 'App that connects by URL'
      }
      if (!(client in names)) throw notulaError('invalid-input', 'client is invalid')
      if (!config.enabled) throw notulaError('invalid-input', 'Turn on the server first.')
      const transport: 'stdio' | 'http' | null =
        client === 'claude-desktop' || client === 'program' ? (config.stdio ? 'stdio' : null) : client === 'url' ? (config.http ? 'http' : null) : config.stdio ? 'stdio' : config.http ? 'http' : null
      if (!transport) {
        throw notulaError('invalid-input', client === 'url' ? 'Turn on “Apps that connect by URL” first.' : 'Turn on “Apps that launch Notula” first.')
      }
      const custom = (client === 'program' || client === 'url') && typeof p?.name === 'string' ? p.name.trim().slice(0, 100) : ''
      const { id, token } = await mint(custom || names[client], transport)
      const json = (v: unknown): string => JSON.stringify(v, null, 2)
      let text: string
      let format: McpSnippet['format'] = 'json'
      if (transport === 'stdio') {
        const { command, args, env } = await stdioEntry(token)
        const entry = { command, args, env }
        if (client === 'claude-code') {
          format = 'shell'
          const envs = Object.entries(env).map(([k, v]) => `--env ${shellArg(`${k}=${v}`)}`)
          text = ['claude mcp add --scope user', ...envs, 'notula --', shellArg(command), ...args.map(shellArg)].join(' ')
        } else if (client === 'vscode') text = json({ servers: { notula: { type: 'stdio', ...entry } } })
        else if (client === 'program') text = json(entry)
        else text = json({ mcpServers: { notula: entry } })
      } else {
        const entry = httpEntry(token)
        if (client === 'claude-code') {
          format = 'shell'
          text = `claude mcp add --scope user --transport http notula ${entry.url} --header ${shellArg(`Authorization: Bearer ${token}`)}`
        } else if (client === 'vscode') text = json({ servers: { notula: { type: 'http', ...entry } } })
        else if (client === 'url') text = json(entry)
        else text = json({ mcpServers: { notula: entry } })
      }
      log('info', 'mcp-server:snippet', { client, transport })
      return { client, tokenId: id, token, transport, format, text }
    }
  )

  ipcMain.handle(
    'mcp-server:install' satisfies InvokeChannel,
    async (_e, p: InvokeReq<'mcp-server:install'>): Promise<InvokeRes<'mcp-server:install'>> => {
      const target = p?.target
      if (target !== 'cursor' && target !== 'vscode') throw notulaError('invalid-input', 'target is invalid')
      const done = (outcome: McpInstallResult): McpInstallResult => {
        log('info', 'mcp-server:install', { target, outcome })
        return outcome
      }
      if (!serving()) return done('server-off')
      // An earlier install that the app never used would only pile up.
      for (const t of await ctx.storage.listMcpServerTokens()) {
        if (t.installTarget === target && !t.lastUsedAt) await revoke(t.id).catch(() => undefined)
      }
      const transport = config.stdio ? 'stdio' : 'http'
      const { id, token } = await mint(INSTALL_NAMES[target], transport, target)
      const entry = transport === 'stdio' ? await stdioEntry(token).then(({ command, args, env }) => ({ command, args, env })) : httpEntry(token)
      const link =
        target === 'cursor'
          ? `cursor://anysphere.cursor-deeplink/mcp/install?name=notula&config=${encodeURIComponent(Buffer.from(JSON.stringify(entry), 'utf8').toString('base64'))}`
          : `vscode:mcp/install?${encodeURIComponent(JSON.stringify({ name: 'notula', type: transport, ...entry }))}`
      if (!app.getApplicationNameForProtocol(link).trim()) {
        await revoke(id).catch(() => undefined)
        return done('no-app')
      }
      try {
        await shell.openExternal(link)
      } catch {
        await revoke(id).catch(() => undefined)
        return done('failed')
      }
      return done('opened')
    }
  )

  ipcMain.handle('mcp-server:list-apps' satisfies InvokeChannel, async (): Promise<InvokeRes<'mcp-server:list-apps'>> => {
    const [tokens, usage, s] = await Promise.all([
      ctx.storage.listMcpServerTokens(),
      ctx.storage.mcpUsageSince(localDay(-(MCP_LIMITS.usageDays - 1))),
      ctx.settings.getAll()
    ])
    const reads = s['userContext.agentReads']
    const paused = new Set(s['userContext.pausedAgentTokens'])
    return tokens.map(
      (t): McpConnectedApp => {
        const u = usage.find((x) => x.tokenId === t.id)
        return {
          id: t.id,
          name: t.name,
          kind: t.kind,
          createdAt: t.createdAt,
          lastUsedAt: t.lastUsedAt,
          calls30d: u?.calls ?? 0,
          errors30d: u?.errors ?? 0,
          clientName: clients.get(t.id) ?? null,
          readProfile: typeof reads[t.id] === 'string',
          profilePaused: paused.has(t.id)
        }
      }
    )
  })

  ipcMain.handle('mcp-server:get-activity' satisfies InvokeChannel, (): InvokeRes<'mcp-server:get-activity'> => activity.slice())
}
