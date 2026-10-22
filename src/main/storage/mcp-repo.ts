// SPDX-License-Identifier: Apache-2.0
// MCP connections and local server tokens: `mcp_connections` and `mcp_server_tokens`
// (SHA-256 hashes only).
//
// Connection secrets (bearer token, environment values) never come here: they live in
// safeStorage under `mcp.token.<id>` / `mcp.env.<id>`. A token row holds only
// the hash of its token, so nothing in this file can give a token back.

import type { IsoTime } from '@shared/types/common'
import type { McpLocalServerToken, McpServerPolicy, McpToolPolicy, McpTransport } from '@shared/types/mcp'
import type { McpConnectionRow } from './api'
import { nowIso, parseJson } from './rows'
import { invalid, notFound, type StoreCtx } from './store'

const CONN_COLS =
  'id, name, transport_type, url, command, args, cwd, env_names, allow_private_network, enabled, tool_policy, server_policy, created_at, updated_at'
const TOKEN_COLS = 'id, name, kind, created_at, last_used_at'
const TRANSPORTS: readonly McpTransport[] = ['http', 'sse', 'stdio']
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const HASH = /^[0-9a-f]{64}$/

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

function toConnection(r: Record<string, unknown>): McpConnectionRow {
  const policy = parseJson<Record<string, unknown>>(r['tool_policy'], {})
  const toolPolicy: Record<string, McpToolPolicy> = {}
  for (const [k, v] of Object.entries(policy ?? {})) if (v === 'ask' || v === 'always') toolPolicy[k] = v
  return {
    id: String(r['id']),
    name: String(r['name']),
    transport: TRANSPORTS.includes(r['transport_type'] as McpTransport) ? (r['transport_type'] as McpTransport) : 'http',
    url: typeof r['url'] === 'string' ? r['url'] : null,
    command: typeof r['command'] === 'string' ? r['command'] : null,
    args: strings(parseJson<unknown>(r['args'], [])),
    cwd: typeof r['cwd'] === 'string' ? r['cwd'] : null,
    envNames: strings(parseJson<unknown>(r['env_names'], [])),
    allowPrivateNetwork: Number(r['allow_private_network']) === 1,
    enabled: Number(r['enabled']) === 1,
    serverPolicy: (r['server_policy'] === 'read-only-auto' ? 'read-only-auto' : 'ask') as McpServerPolicy,
    toolPolicy,
    createdAt: String(r['created_at']),
    updatedAt: String(r['updated_at'])
  }
}

function toToken(r: Record<string, unknown>): McpLocalServerToken {
  return {
    id: String(r['id']),
    name: String(r['name']),
    kind: r['kind'] === 'http' ? 'http' : 'stdio',
    createdAt: String(r['created_at']),
    lastUsedAt: typeof r['last_used_at'] === 'string' ? r['last_used_at'] : null
  }
}

export function listMcpConnections(s: StoreCtx): McpConnectionRow[] {
  const rows = s.db.prepare(`SELECT ${CONN_COLS} FROM mcp_connections ORDER BY created_at, rid`).all() as Record<string, unknown>[]
  return rows.map(toConnection)
}

export function upsertMcpConnection(s: StoreCtx, c: McpConnectionRow): McpConnectionRow {
  if (!c || typeof c.id !== 'string' || !UUID.test(c.id)) throw invalid('connection id must be a UUID')
  if (typeof c.name !== 'string' || !c.name.trim()) throw invalid('name is required')
  if (!TRANSPORTS.includes(c.transport)) throw invalid('transport must be http, sse or stdio')
  if (c.transport === 'stdio' ? !c.command : !c.url) throw invalid(c.transport === 'stdio' ? 'command is required' : 'url is required')
  const now = nowIso()
  const url = c.transport === 'stdio' ? null : c.url
  const dupe = url ? (s.db.prepare(`SELECT id FROM mcp_connections WHERE url = ? AND id <> ?`).get(url, c.id) as { id: string } | undefined) : undefined
  if (dupe) throw invalid('A server with this URL is already in your list.')
  s.db
    .prepare(
      `INSERT INTO mcp_connections (id, workspace_id, owner_id, name, transport_type, url, command, args, cwd, env_names,
         allow_private_network, enabled, tool_policy, server_policy, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET name = excluded.name, transport_type = excluded.transport_type, url = excluded.url,
         command = excluded.command, args = excluded.args, cwd = excluded.cwd, env_names = excluded.env_names,
         allow_private_network = excluded.allow_private_network, enabled = excluded.enabled,
         tool_policy = excluded.tool_policy, server_policy = excluded.server_policy, updated_at = excluded.updated_at`
    )
    .run(
      c.id,
      s.identity.workspaceId,
      s.identity.ownerId,
      c.name.trim(),
      c.transport,
      url,
      c.transport === 'stdio' ? c.command : null,
      JSON.stringify(strings(c.args)),
      c.transport === 'stdio' ? c.cwd : null,
      JSON.stringify(strings(c.envNames)),
      c.allowPrivateNetwork ? 1 : 0,
      c.enabled ? 1 : 0,
      JSON.stringify(c.toolPolicy ?? {}),
      c.serverPolicy === 'read-only-auto' ? 'read-only-auto' : 'ask',
      typeof c.createdAt === 'string' && c.createdAt ? c.createdAt : now,
      now
    )
  s.touch('mcp_connections', c.id)
  return toConnection(s.db.prepare(`SELECT ${CONN_COLS} FROM mcp_connections WHERE id = ?`).get(c.id) as Record<string, unknown>)
}

export function deleteMcpConnection(s: StoreCtx, id: string): void {
  if (typeof id !== 'string') throw invalid('id must be a string')
  const r = s.db.prepare(`DELETE FROM mcp_connections WHERE id = ?`).run(id)
  if (r.changes) s.touch('mcp_connections', id)
}

export function listMcpServerTokens(s: StoreCtx): McpLocalServerToken[] {
  const rows = s.db.prepare(`SELECT ${TOKEN_COLS} FROM mcp_server_tokens ORDER BY created_at DESC, rid DESC`).all() as Record<string, unknown>[]
  return rows.map(toToken)
}

export function createMcpServerToken(s: StoreCtx, t: { id: string; name: string; kind: McpLocalServerToken['kind']; token_hash: string }): McpLocalServerToken {
  if (!t || typeof t.id !== 'string' || !UUID.test(t.id)) throw invalid('token id must be a UUID')
  if (typeof t.name !== 'string' || !t.name.trim() || t.name.length > 200) throw invalid('name is required')
  if (t.kind !== 'stdio' && t.kind !== 'http') throw invalid('kind must be stdio or http')
  if (typeof t.token_hash !== 'string' || !HASH.test(t.token_hash)) throw invalid('token_hash must be a SHA-256 hex digest')
  s.db
    .prepare(
      `INSERT INTO mcp_server_tokens (id, workspace_id, owner_id, name, kind, token_hash, created_at, last_used_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`
    )
    .run(t.id, s.identity.workspaceId, s.identity.ownerId, t.name.trim(), t.kind, t.token_hash, nowIso())
  return toToken(s.db.prepare(`SELECT ${TOKEN_COLS} FROM mcp_server_tokens WHERE id = ?`).get(t.id) as Record<string, unknown>)
}

export function findMcpServerToken(s: StoreCtx, tokenHash: string): (McpLocalServerToken & { token_hash: string }) | null {
  if (typeof tokenHash !== 'string' || !HASH.test(tokenHash)) return null
  const r = s.db.prepare(`SELECT ${TOKEN_COLS}, token_hash FROM mcp_server_tokens WHERE token_hash = ?`).get(tokenHash) as
    | Record<string, unknown>
    | undefined
  return r ? { ...toToken(r), token_hash: String(r['token_hash']) } : null
}

export function touchMcpServerToken(s: StoreCtx, id: string, at: IsoTime): void {
  s.db.prepare(`UPDATE mcp_server_tokens SET last_used_at = ? WHERE id = ?`).run(at, id)
}

export function deleteMcpServerToken(s: StoreCtx, id: string): void {
  const r = s.db.prepare(`DELETE FROM mcp_server_tokens WHERE id = ?`).run(id)
  if (!r.changes) throw notFound('mcp server token', id)
}
