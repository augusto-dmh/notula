// SPDX-License-Identifier: Apache-2.0
// registerMcpClient(): the MCP client over the user's servers, registered as a chat
// tool provider through `ctx.chat`; the `mcp:*` IPC.
//
// - Gate: Labs `mcpClient.enabled`, off by default. While it is off no server is
//   started or contacted and chat gets no MCP tools; the saved rows stay.
// - Main owns every connection through SDK 1.31.0: stdio (our own spawn,
//   ./stdio.ts), Streamable HTTP and legacy SSE through the guarded fetch (./guard.ts).
//   Tokens and environment values live in safeStorage (`mcp.token.<id>`, `mcp.env.<id>`)
//   and never reach the renderer, a log line or the stderr ring (masked).
// - stdio crashes restart with backoff 1, 2, 4… s up to 60 s; 5 failures in 5 min set
//   `error` until the user reconnects.
// - Tools: `tools/list` on connect and on list-changed; `mcp__<server>__<tool>` (./naming.ts);
//   at most 64 per request in server order; approval unless "Always allow" or the
//   read-only-auto server policy with `readOnlyHint`; `tools/call` with 60 s; results
//   shaped for the model (text, structured JSON, omitted media, 12,000 characters).
// - Audit: one debug line per call with server, tool, outcome and duration, never
//   arguments or results.

import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { app, ipcMain } from 'electron'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import { SSEClientTransport, SseError } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { ToolListChangedNotificationSchema, type Tool } from '@modelcontextprotocol/sdk/types.js'
import type { InvokeChannel, InvokeRes, PushChannel } from '@shared/ipc'
import { notulaError } from '@shared/errors'
import {
  MCP_LIMITS,
  type McpConnectionState,
  type McpPolicyChange,
  type McpServerInfo,
  type McpServerInput,
  type McpServerPatch,
  type McpToolInfo,
  type McpToolPolicy
} from '@shared/types/mcp'
import { LOCAL_ONLY_COPY } from '@shared/types/local-only'
import { STRUCTURED_SECRET_PREFIX, type SecretId } from '@shared/types/settings'
import type { ChatToolProvider, ChatToolResult, ChatToolSpec } from '../chat/tool-api'
import type { MainContext } from '../context'
import { log } from '../log'
import { egressBlocked, LOCAL_ONLY_REASON } from '../privacy'
import type { McpConnectionRow } from '../storage/api'
import { checkServerUrl, guardedFetch, UrlRefused } from './guard'
import { offeredName, serverSlugs } from './naming'
import { ChildStdioTransport, RingLog } from './stdio'

const SIGN_IN = "This server needs sign-in, which Notula doesn't support yet. Add an API token instead."
const CONNECT_TIMEOUT_MS = 30_000
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

const tokenId = (id: string): SecretId => `mcp.token.${id}`
const envId = (id: string): SecretId => `mcp.env.${id}`

function encodeEnv(env: Record<string, string>): string {
  return STRUCTURED_SECRET_PREFIX + Buffer.from(JSON.stringify(env), 'utf8').toString('base64url')
}

function decodeEnv(raw: string | null): Record<string, string> {
  if (!raw?.startsWith(STRUCTURED_SECRET_PREFIX)) return {}
  try {
    const v = JSON.parse(Buffer.from(raw.slice(STRUCTURED_SECRET_PREFIX.length), 'base64url').toString('utf8')) as unknown
    const out: Record<string, string> = {}
    if (v && typeof v === 'object') for (const [k, s] of Object.entries(v)) if (typeof s === 'string') out[k] = s
    return out
  } catch {
    return {}
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function isAuthChallenge(err: unknown): boolean {
  if (err instanceof UnauthorizedError) return true
  if (err instanceof StreamableHTTPError && err.code === 401) return true
  if (err instanceof SseError && err.code === 401) return true
  return /\b401\b|unauthorized/i.test(errMessage(err))
}

/** Shapes a `tools/call` result for the model. */
function shapeResult(r: { content?: unknown; structuredContent?: unknown; isError?: unknown }): ChatToolResult {
  const parts = Array.isArray(r.content) ? (r.content as Record<string, unknown>[]) : []
  const texts: string[] = []
  const links: { uri: string; title: string }[] = []
  for (const p of parts) {
    if (p['type'] === 'text' && typeof p['text'] === 'string') texts.push(p['text'])
    else if (p['type'] === 'image') texts.push('[image omitted]')
    else if (p['type'] === 'audio') texts.push('[audio omitted]')
    else if (p['type'] === 'resource_link' && typeof p['uri'] === 'string') {
      const title = typeof p['title'] === 'string' ? p['title'] : typeof p['name'] === 'string' ? p['name'] : 'Open result'
      links.push({ uri: p['uri'], title })
      texts.push(`[${title}](${p['uri']})`)
    } else if (p['type'] === 'resource') {
      const res = p['resource'] as Record<string, unknown> | undefined
      if (res && typeof res['text'] === 'string') texts.push(res['text'])
    }
  }
  let content = texts.filter((t) => !t.startsWith('[') || t.length > 0).join('\n\n')
  if (!texts.some((t) => !t.startsWith('[image') && !t.startsWith('[audio')) && r.structuredContent !== undefined) {
    content = [JSON.stringify(r.structuredContent), ...texts].join('\n\n')
  }
  if (!content) content = r.isError ? 'The tool failed without a message.' : 'The tool returned no content.'
  if (content.length > MCP_LIMITS.resultMaxChars) content = `${content.slice(0, MCP_LIMITS.resultMaxChars)}\n[truncated]`
  const resultText = texts.filter((t) => t !== '[image omitted]' && t !== '[audio omitted]').join('\n\n')
  return {
    content,
    isError: r.isError === true,
    data: {
      text: resultText.slice(0, MCP_LIMITS.resultMaxChars),
      ...(r.structuredContent !== undefined ? { structured: r.structuredContent } : {}),
      ...(links.length ? { links } : {})
    }
  }
}

interface Conn {
  row: McpConnectionRow
  state: McpConnectionState
  error: string | null
  tools: Tool[]
  toolsCut: number
  instructions: string | null
  client: Client | null
  transport: Transport | null
  log: RingLog
  secrets: string[]
  crashes: number[]
  restartTimer: ReturnType<typeof setTimeout> | null
  /** Bumped on every connect/disconnect, so a stale attempt never overwrites state. */
  epoch: number
}

export function registerMcpClient(ctx: MainContext): void {
  const conns = new Map<string, Conn>()
  let labsOn = false
  let loaded = false
  /** offered name → (connection id, tool name), rebuilt on every `tools()`. */
  let routes = new Map<string, { id: string; tool: string }>()

  const push = (ids: string[]): void => {
    for (const wc of ctx.windows.targets()) wc.send('mcp:changed' satisfies PushChannel, { ids })
  }

  const info = async (c: Conn): Promise<McpServerInfo> => ({
    ...c.row,
    hasToken: await ctx.secrets.has(tokenId(c.row.id)).catch(() => false),
    state: c.state,
    error: c.error,
    toolCount: c.tools.length,
    toolsCut: c.toolsCut,
    instructions: c.instructions
  })

  const ordered = (): Conn[] => [...conns.values()].sort((a, b) => a.row.createdAt.localeCompare(b.row.createdAt))

  const setState = (c: Conn, state: McpConnectionState, error: string | null): void => {
    c.state = state
    c.error = error
    push([c.row.id])
  }

  // ---------- connections ----------

  const disconnect = async (c: Conn, state: McpConnectionState = 'disabled'): Promise<void> => {
    c.epoch++
    if (c.restartTimer) clearTimeout(c.restartTimer)
    c.restartTimer = null
    const client = c.client
    const transport = c.transport
    c.client = null
    c.transport = null
    c.tools = []
    c.state = state
    if (client) await client.close().catch(() => undefined)
    else if (transport) await transport.close().catch(() => undefined)
  }

  const listAll = async (client: Client): Promise<Tool[]> => {
    const out: Tool[] = []
    let cursor: string | undefined
    for (let page = 0; page < 20; page++) {
      const r = await client.listTools(cursor ? { cursor } : {}, { timeout: CONNECT_TIMEOUT_MS })
      out.push(...r.tools)
      cursor = r.nextCursor
      if (!cursor) break
    }
    return out
  }

  const onStdioExit = (c: Conn, epoch: number, expected: boolean): void => {
    if (expected || epoch !== c.epoch) return
    c.client = null
    c.transport = null
    c.tools = []
    const now = Date.now()
    c.crashes = [...c.crashes.filter((t) => now - t < MCP_LIMITS.crashWindowMs), now]
    if (c.crashes.length >= MCP_LIMITS.crashLimit) {
      log('warn', 'mcp:server-crashed-repeatedly', { server: c.row.name })
      setState(c, 'error', 'The server stopped 5 times in 5 minutes. Reconnect to try again.')
      return
    }
    const delay = Math.min(MCP_LIMITS.restartBackoffMaxMs, 1_000 * 2 ** (c.crashes.length - 1))
    log('info', 'mcp:server-restart-scheduled', { server: c.row.name, delayMs: delay })
    c.log.note(`restarting in ${Math.round(delay / 1000)} s`)
    setState(c, 'connecting', null)
    c.restartTimer = setTimeout(() => {
      c.restartTimer = null
      void connect(c)
    }, delay)
  }

  const connect = async (c: Conn): Promise<void> => {
    await disconnect(c, 'connecting')
    const epoch = c.epoch
    if (!labsOn) return setState(c, 'disabled', null)
    if (!c.row.enabled) return setState(c, 'disabled', null)
    // Every MCP-client server, remote and stdio, stays off while local-only is on.
    if (await egressBlocked(ctx, { kind: 'mcp-client' })) {
      if (epoch === c.epoch) setState(c, 'disabled', LOCAL_ONLY_COPY.blocked)
      return
    }
    setState(c, 'connecting', null)
    const started = Date.now()
    try {
      let transport: Transport
      if (c.row.transport === 'stdio') {
        const env = decodeEnv(await ctx.secrets.get(envId(c.row.id)))
        c.secrets = Object.values(env)
        c.log.note(`starting ${basename(c.row.command ?? '')}`)
        transport = new ChildStdioTransport(
          { command: c.row.command ?? '', args: c.row.args, cwd: c.row.cwd, env },
          c.log,
          (_code, _signal, expected) => onStdioExit(c, epoch, expected)
        )
      } else {
        const url = await checkServerUrl(c.row.url ?? '', { allowPrivateNetwork: c.row.allowPrivateNetwork })
        const token = await ctx.secrets.get(tokenId(c.row.id))
        const requestInit: RequestInit = token ? { headers: { Authorization: `Bearer ${token}` } } : {}
        const fetch = guardedFetch({ allowPrivateNetwork: c.row.allowPrivateNetwork })
        transport =
          c.row.transport === 'sse'
            ? new SSEClientTransport(url, { requestInit, fetch, eventSourceInit: { fetch } as EventSourceInit })
            : new StreamableHTTPClientTransport(url, { requestInit, fetch })
      }
      const client = new Client({ name: 'Notula', version: app.getVersion() }, { capabilities: {} })
      c.transport = transport
      c.client = client
      await Promise.race([
        client.connect(transport, { timeout: CONNECT_TIMEOUT_MS }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('The server did not answer in time.')), CONNECT_TIMEOUT_MS).unref())
      ])
      if (epoch !== c.epoch) return
      client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
        if (epoch !== c.epoch) return
        try {
          c.tools = await listAll(client)
          push([c.row.id])
        } catch (err) {
          log('warn', 'mcp:tools-refresh-failed', { server: c.row.name, err: errMessage(err) })
        }
      })
      c.instructions = client.getInstructions() ?? null
      c.tools = await listAll(client)
      if (epoch !== c.epoch) return
      log('info', 'mcp:connected', { server: c.row.name, transport: c.row.transport, tools: c.tools.length, ms: Date.now() - started })
      setState(c, 'connected', null)
    } catch (err) {
      if (epoch !== c.epoch) return
      const auth = !(err instanceof UrlRefused) && isAuthChallenge(err)
      const message = err instanceof UrlRefused ? `Notula can’t use this URL. ${err.detail}` : auth ? SIGN_IN : errMessage(err).slice(0, 300)
      log('warn', 'mcp:connect-failed', { server: c.row.name, transport: c.row.transport, auth })
      c.log.note(`connect failed: ${message}`)
      const client = c.client
      c.client = null
      c.transport = null
      c.epoch++
      if (client) await client.close().catch(() => undefined)
      setState(c, auth ? 'needs_auth' : 'error', message)
    }
  }

  const newConn = (row: McpConnectionRow): Conn => {
    const c: Conn = {
      row,
      state: 'disabled',
      error: null,
      tools: [],
      toolsCut: 0,
      instructions: null,
      client: null,
      transport: null,
      log: new RingLog(MCP_LIMITS.stderrRingBytes, () => c.secrets),
      secrets: [],
      crashes: [],
      restartTimer: null,
      epoch: 0
    }
    return c
  }

  const load = async (): Promise<void> => {
    if (loaded) return
    loaded = true
    try {
      for (const row of await ctx.storage.listMcpConnections()) conns.set(row.id, newConn(row))
    } catch (err) {
      loaded = false
      log('warn', 'mcp:load-failed', { err: errMessage(err) })
      return
    }
    if (labsOn) for (const c of conns.values()) void connect(c)
    push([...conns.keys()])
  }

  const applyLabs = (on: boolean): void => {
    if (on === labsOn) return
    labsOn = on
    for (const c of conns.values()) {
      c.crashes = []
      void (on ? connect(c) : disconnect(c).then(() => push([c.row.id])))
    }
  }

  void ctx.settings
    .get('mcpClient.enabled')
    .then((on) => {
      labsOn = on === true
      return ctx.storage.status()
    })
    .then((s) => {
      if (s.state === 'ready') void load()
    })
    .catch(() => undefined)
  ctx.bus.on('storage:status', (s) => {
    if (s.state === 'ready') void load()
  })
  ctx.bus.on('settings:changed', (e) => {
    if (e.keys.includes('mcpClient.enabled')) applyLabs(e.settings['mcpClient.enabled'] === true)
    // Local-only on disconnects every server; off reconnects the enabled ones.
    if (e.keys.includes('privacy.localOnly') && labsOn) {
      const on = e.settings['privacy.localOnly'] === true
      for (const c of conns.values()) {
        void (on ? disconnect(c).then(() => setState(c, 'disabled', LOCAL_ONLY_COPY.blocked)) : connect(c))
      }
    }
  })
  app.on('will-quit', () => {
    for (const c of conns.values()) void disconnect(c)
  })

  const get = (id: unknown): Conn => {
    const c = typeof id === 'string' ? conns.get(id) : undefined
    if (!c) throw notulaError('not-found', 'That server no longer exists.')
    return c
  }

  // ---------- validation ----------

  const validate = async (
    input: McpServerInput,
    selfId: string | null
  ): Promise<{ row: Omit<McpConnectionRow, 'id' | 'createdAt' | 'updatedAt' | 'enabled' | 'serverPolicy' | 'toolPolicy'> }> => {
    const name = typeof input.name === 'string' ? input.name.trim().slice(0, 100) : ''
    const transport = input.transport === 'stdio' || input.transport === 'sse' ? input.transport : 'http'
    if (transport === 'stdio') {
      if (!name) throw notulaError('invalid-input', 'Enter a name for this server.')
      const command = typeof input.command === 'string' ? input.command.trim() : ''
      if (!command) throw notulaError('invalid-input', 'Enter a command')
      const args = Array.isArray(input.args) ? input.args.filter((a): a is string => typeof a === 'string').slice(0, 100) : []
      const env = input.env && typeof input.env === 'object' ? input.env : {}
      for (const k of Object.keys(env)) if (!ENV_NAME.test(k)) throw notulaError('invalid-input', `"${k}" is not a valid variable name`)
      return {
        row: {
          name,
          transport,
          url: null,
          command,
          args,
          cwd: typeof input.cwd === 'string' && input.cwd.trim() ? input.cwd.trim() : null,
          envNames: Object.keys(env),
          allowPrivateNetwork: false
        }
      }
    }
    const raw = typeof input.url === 'string' ? input.url.trim() : ''
    if (!name || !raw) throw notulaError('invalid-input', 'Enter a name and a URL.')
    const allowPrivateNetwork = input.allowPrivateNetwork === true
    try {
      new URL(raw)
    } catch {
      throw notulaError('invalid-input', 'Enter a valid URL.')
    }
    try {
      await checkServerUrl(raw, { allowPrivateNetwork })
    } catch (err) {
      throw notulaError('invalid-input', `Enter a valid URL\n${err instanceof UrlRefused ? err.detail : 'Notula couldn’t check this address.'}`)
    }
    const url = new URL(raw).toString()
    for (const c of conns.values()) if (c.row.id !== selfId && c.row.url === url) throw notulaError('invalid-input', 'A server with this URL is already in your list.')
    return { row: { name, transport, url, command: null, args: [], cwd: null, envNames: [], allowPrivateNetwork } }
  }

  const storeSecrets = async (id: string, input: { token?: string; env?: Record<string, string> }, clearToken: boolean): Promise<void> => {
    if (clearToken) await ctx.secrets.clear(tokenId(id))
    else if (typeof input.token === 'string' && input.token.trim()) {
      try {
        await ctx.secrets.set(tokenId(id), input.token.trim())
      } catch {
        throw notulaError('invalid-input', 'The token can only hold printable characters without spaces.')
      }
    }
    if (input.env && typeof input.env === 'object') {
      const env: Record<string, string> = {}
      for (const [k, v] of Object.entries(input.env)) if (typeof v === 'string') env[k] = v
      if (Object.keys(env).length) await ctx.secrets.set(envId(id), encodeEnv(env))
      else await ctx.secrets.clear(envId(id))
    }
  }

  // ---------- IPC ----------

  ipcMain.handle('mcp:list-servers' satisfies InvokeChannel, async (): Promise<InvokeRes<'mcp:list-servers'>> => {
    await load()
    return Promise.all(ordered().map(info))
  })

  ipcMain.handle('mcp:add-server' satisfies InvokeChannel, async (_e, p: McpServerInput): Promise<InvokeRes<'mcp:add-server'>> => {
    await load()
    const { row } = await validate(p ?? ({} as McpServerInput), null)
    const id = randomUUID()
    const saved = await ctx.storage.upsertMcpConnection({
      ...row,
      id,
      enabled: true,
      serverPolicy: 'ask',
      toolPolicy: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    })
    try {
      await storeSecrets(id, { token: p.token, env: row.transport === 'stdio' ? p.env : undefined }, false)
    } catch (err) {
      await ctx.storage.deleteMcpConnection(id).catch(() => undefined)
      throw err
    }
    const c = newConn(saved)
    conns.set(id, c)
    log('info', 'mcp:server-added', { server: saved.name, transport: saved.transport })
    await connect(c)
    return info(c)
  })

  ipcMain.handle('mcp:update-server' satisfies InvokeChannel, async (_e, p: { id: string; patch: McpServerPatch }): Promise<InvokeRes<'mcp:update-server'>> => {
    const c = get(p?.id)
    const patch = p.patch ?? {}
    const onlyEnabled = Object.keys(patch).every((k) => k === 'enabled')
    let row: McpConnectionRow = { ...c.row }
    if (!onlyEnabled) {
      const merged: McpServerInput = {
        name: patch.name ?? c.row.name,
        transport: patch.transport ?? c.row.transport,
        url: patch.url ?? c.row.url ?? undefined,
        command: patch.command ?? c.row.command ?? undefined,
        args: patch.args ?? c.row.args,
        cwd: patch.cwd !== undefined ? patch.cwd : c.row.cwd,
        env: patch.env ?? Object.fromEntries(c.row.envNames.map((n) => [n, ''])),
        allowPrivateNetwork: patch.allowPrivateNetwork ?? c.row.allowPrivateNetwork
      }
      const v = await validate(merged, c.row.id)
      row = { ...row, ...v.row, envNames: patch.env ? Object.keys(patch.env) : c.row.envNames }
    }
    if (typeof patch.enabled === 'boolean') row.enabled = patch.enabled
    c.row = await ctx.storage.upsertMcpConnection(row)
    await storeSecrets(c.row.id, { token: patch.token, env: patch.env }, patch.clearToken === true)
    c.crashes = []
    await connect(c)
    return info(c)
  })

  ipcMain.handle('mcp:remove-server' satisfies InvokeChannel, async (_e, p: { id: string }): Promise<InvokeRes<'mcp:remove-server'>> => {
    const c = get(p?.id)
    await disconnect(c)
    conns.delete(c.row.id)
    await ctx.storage.deleteMcpConnection(c.row.id)
    await Promise.all([ctx.secrets.clear(tokenId(c.row.id)), ctx.secrets.clear(envId(c.row.id))]).catch(() => undefined)
    log('info', 'mcp:server-removed', { server: c.row.name })
    push([c.row.id])
  })

  ipcMain.handle('mcp:reconnect-server' satisfies InvokeChannel, async (_e, p: { id: string }): Promise<InvokeRes<'mcp:reconnect-server'>> => {
    const c = get(p?.id)
    c.crashes = []
    await connect(c)
    return info(c)
  })

  const policyOf = (c: Conn, tool: Tool): McpToolPolicy => c.row.toolPolicy[tool.name] ?? 'ask'

  ipcMain.handle('mcp:list-tools' satisfies InvokeChannel, (_e, p: { id: string }): InvokeRes<'mcp:list-tools'> => {
    const c = get(p?.id)
    const slugs = serverSlugs(ordered().map((x) => x.row))
    const slug = slugs.get(c.row.id) ?? 'server'
    return c.tools.map(
      (t): McpToolInfo => ({
        name: t.name,
        offeredAs: offeredName(slug, t.name),
        title: t.title ?? t.annotations?.title ?? null,
        description: t.description ?? '',
        readOnlyHint: t.annotations?.readOnlyHint === true,
        policy: policyOf(c, t)
      })
    )
  })

  ipcMain.handle('mcp:set-tool-policy' satisfies InvokeChannel, async (_e, p: McpPolicyChange): Promise<InvokeRes<'mcp:set-tool-policy'>> => {
    const c = get(p?.id)
    if ('serverPolicy' in p) {
      c.row = await ctx.storage.upsertMcpConnection({ ...c.row, serverPolicy: p.serverPolicy === 'read-only-auto' ? 'read-only-auto' : 'ask' })
    } else {
      if (typeof p.tool !== 'string' || !p.tool) throw notulaError('invalid-input', 'tool is required')
      const toolPolicy = { ...c.row.toolPolicy }
      if (p.policy === 'always') toolPolicy[p.tool] = 'always'
      else delete toolPolicy[p.tool]
      c.row = await ctx.storage.upsertMcpConnection({ ...c.row, toolPolicy })
    }
    push([c.row.id])
    return info(c)
  })

  ipcMain.handle('mcp:get-log' satisfies InvokeChannel, (_e, p: { id: string }): InvokeRes<'mcp:get-log'> => ({ text: get(p?.id).log.read() }))

  // ---------- the chat tool provider ----------

  const provider: ChatToolProvider = {
    id: 'mcp',
    tools: async () => {
      if (!labsOn) return []
      const list = ordered()
      const slugs = serverSlugs(list.map((x) => x.row))
      const specs: ChatToolSpec[] = []
      const next = new Map<string, { id: string; tool: string }>()
      for (const c of list) {
        c.toolsCut = 0
        if (c.state !== 'connected' || !c.row.enabled) continue
        const slug = slugs.get(c.row.id) ?? 'server'
        for (const t of c.tools) {
          if (specs.length >= MCP_LIMITS.toolsPerRequest) {
            c.toolsCut++
            continue
          }
          const name = offeredName(slug, t.name)
          if (next.has(name)) continue
          next.set(name, { id: c.row.id, tool: t.name })
          const readOnly = t.annotations?.readOnlyHint === true
          const auto = policyOf(c, t) === 'always' || (c.row.serverPolicy === 'read-only-auto' && readOnly)
          const title = t.title ?? t.annotations?.title ?? null
          const schema = (t.inputSchema ?? { type: 'object' }) as ChatToolSpec['def']['inputSchema']
          specs.push({
            def: { name, description: (t.description ?? title ?? t.name).slice(0, 4_000), inputSchema: { ...schema, type: 'object' } },
            category: 'generic',
            needsApproval: !auto,
            readOnly,
            ...(title ? { title } : {}),
            meta: {
              mcpLinkId: c.row.id,
              mcpEndpoint: c.row.transport === 'stdio' ? `stdio:${basename(c.row.command ?? '')}` : (c.row.url ?? ''),
              mcpToolLabel: title
            }
          })
        }
      }
      routes = next
      return specs
    },
    run: async (name, args, opts) => {
      const route = routes.get(name)
      const c = route ? conns.get(route.id) : undefined
      if (!route || !c?.client || c.state !== 'connected') return { content: 'This MCP server is not connected.', isError: true }
      // Local-only mode (the egress guard): tool arguments, which can quote notes, go to no MCP-client server.
      if (await egressBlocked(ctx, { kind: 'mcp-client' })) {
        log('info', 'mcp:tool-call-blocked', { server: c.row.name, reason: LOCAL_ONLY_REASON })
        return { content: LOCAL_ONLY_COPY.blocked, isError: true }
      }
      const started = Date.now()
      try {
        const r = await c.client.callTool({ name: route.tool, arguments: args }, undefined, {
          signal: opts.signal,
          timeout: MCP_LIMITS.toolCallTimeoutMs,
          onprogress: (p) => {
            if (typeof p.message === 'string') opts.onProgress?.(p.message)
          }
        })
        const shaped = shapeResult(r as { content?: unknown; structuredContent?: unknown; isError?: unknown })
        log('debug', 'mcp:tool-call', { server: c.row.name, tool: route.tool, ok: !shaped.isError, ms: Date.now() - started })
        return shaped
      } catch (err) {
        const timedOut = /timed out|timeout/i.test(errMessage(err))
        log('debug', 'mcp:tool-call', { server: c.row.name, tool: route.tool, ok: false, timedOut, ms: Date.now() - started })
        return { content: timedOut ? 'The tool did not answer within 60 seconds.' : `The tool failed: ${errMessage(err).slice(0, 500)}`, isError: true }
      }
    }
  }

  // `ctx.chat` is filled during wiring; register once the app is up.
  void app.whenReady().then(() => {
    try {
      ctx.chat.registerToolProvider(provider)
    } catch (err) {
      log('warn', 'mcp:provider-register-failed', { err: errMessage(err) })
    }
  })
}
