// SPDX-License-Identifier: Apache-2.0
// The MCP client (the user's servers in chat) and Notula's local MCP server. Tokens and
// environment values are secrets; server tokens are stored as hashes only.

import type { IsoTime } from './common'

export type McpTransport = 'http' | 'sse' | 'stdio'
export type McpConnectionState = 'connecting' | 'connected' | 'needs_auth' | 'error' | 'disabled'
export type McpToolPolicy = 'ask' | 'always'
export type McpServerPolicy = 'ask' | 'read-only-auto'

export interface McpServerInfo {
  id: string
  name: string
  transport: McpTransport
  url: string | null
  command: string | null
  args: string[]
  cwd: string | null
  /** The variable names only; values are a secret. */
  envNames: string[]
  hasToken: boolean
  allowPrivateNetwork: boolean
  enabled: boolean
  state: McpConnectionState
  error: string | null
  toolCount: number
  toolsCut: number
  serverPolicy: McpServerPolicy
  toolPolicy: Record<string, McpToolPolicy>
  /** Shown, never sent to a model. */
  instructions: string | null
  createdAt: IsoTime
  updatedAt: IsoTime
}

export interface McpServerInput {
  name: string
  transport: McpTransport
  url?: string
  token?: string
  command?: string
  args?: string[]
  cwd?: string | null
  env?: Record<string, string>
  allowPrivateNetwork?: boolean
}

export type McpServerPatch = Partial<McpServerInput> & { enabled?: boolean; clearToken?: boolean }

export interface McpToolInfo {
  name: string
  /** `mcp__<server>__<tool>`. */
  offeredAs: string
  title: string | null
  description: string
  readOnlyHint: boolean
  policy: McpToolPolicy
}

export type McpPolicyChange = { id: string; tool: string; policy: McpToolPolicy } | { id: string; serverPolicy: McpServerPolicy }

export interface McpLocalServerConfig {
  enabled: boolean
  stdio: boolean
  http: boolean
  port: number
}

export type McpLocalServerStatus = McpLocalServerConfig & {
  listening: boolean
  error: 'port-in-use' | 'local-only' | null
  url: string | null
}

export interface McpLocalServerToken {
  id: string
  name: string
  kind: 'stdio' | 'http'
  createdAt: IsoTime
  lastUsedAt: IsoTime | null
}

/** `mcp-server:get-stdio-config`: how an AI app launches the `notula-mcp` shim. */
export interface McpStdioConfig {
  tokenId: string
  entryName: 'notula'
  command: string
  args: string[]
  env: Record<string, string>
  /** The `mcpServers` entry, ready to paste. */
  configJson: string
  usesNode: boolean
}

export interface McpLocalServerActivity {
  at: IsoTime
  client: string | null
  tool: string
  ok: boolean
  durationMs: number
}

/** SDK 1.31.0 negotiates `2025-11-25` down to `2024-10-07`. */
export const MCP_PROTOCOL = { sdk: '1.31.0', latest: '2025-11-25' } as const

export const MCP_LIMITS = {
  toolCallTimeoutMs: 60_000,
  resultMaxChars: 12_000,
  toolsPerRequest: 64,
  toolNameMax: 64,
  stderrRingBytes: 204_800,
  shutdownGraceMs: 5_000,
  restartBackoffMaxMs: 60_000,
  crashLimit: 5,
  crashWindowMs: 300_000,
  defaultPort: 52_417,
  ratePerSec: 20,
  burst: 40,
  bodyMaxBytes: 1_048_576,
  concurrentPerToken: 4,
  activityMax: 50,
  shimStartMs: 15_000
} as const

export const MCP_TOKEN_PREFIX = 'ntl_mcp_'

export const MCP_BLOCKED_HOSTS = ['localhost.localdomain', 'metadata.google.internal', 'metadata.goog'] as const
