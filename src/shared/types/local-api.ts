// SPDX-License-Identifier: Apache-2.0
// The token-authenticated Local API and the companion CLI. No type here carries a key
// after creation or a hash.

import type { IsoTime } from './common'

export type LocalApiScope = 'notes:read' | 'transcripts:read' | 'folders:write'
export type LocalApiKeyStatus = 'active' | 'expired' | 'revoked'

export interface LocalApiKey {
  id: string
  description: string
  scopes: LocalApiScope[]
  status: LocalApiKeyStatus
  createdAt: IsoTime
  lastUsedAt: IsoTime | null
  expiresAt: IsoTime | null
  revokedAt: IsoTime | null
}

export interface LocalApiKeyInput {
  description: string
  scopes: LocalApiScope[]
  expiresIn: 'never' | '30d' | '90d' | '1y'
}

export interface LocalApiStatus {
  enabled: boolean
  listening: boolean
  endpoint: string | null
  companionActive: boolean
  error: 'local-only' | 'listen-failed' | null
}

export type LocalApiErrorCode = 'UNAUTHENTICATED' | 'FORBIDDEN' | 'NOT_FOUND' | 'INVALID_REQUEST' | 'INTERNAL_ERROR'

export interface LocalApiActivity {
  at: IsoTime
  /** The key's description, or 'Companion CLI'. */
  client: string
  method: string
  ok: boolean
  code: LocalApiErrorCode | null
  durationMs: number
}

export const LOCAL_API_METHODS = [
  'notes.list',
  'notes.get',
  'transcripts.get',
  'folders.list',
  'folders.notes.add',
  'folders.notes.remove',
  // Content sources: series in catalog order, for the study vault
  'series.list',
  'series.get'
] as const

export type LocalApiMethod = (typeof LOCAL_API_METHODS)[number]

export const LOCAL_API_METHOD_SCOPE: Record<LocalApiMethod, LocalApiScope> = {
  'notes.list': 'notes:read',
  'notes.get': 'notes:read',
  'transcripts.get': 'transcripts:read',
  'folders.list': 'notes:read',
  'folders.notes.add': 'folders:write',
  'folders.notes.remove': 'folders:write',
  'series.list': 'notes:read',
  'series.get': 'notes:read'
}

export const LOCAL_API_LIMITS = {
  bufferBytes: 262_144,
  listMax: 100,
  listDefault: 50,
  idsMax: 100,
  searchMax: 200,
  inFlightPerConnection: 4,
  ratePerSec: 20,
  activityMax: 50,
  descriptionMax: 500,
  protocolVersion: 1,
  stopWithinMs: 1_000
} as const

export const LOCAL_API_KEY_PREFIX = 'ntl_api_'

export type CompanionAgentId = 'claude-code' | 'codex' | 'cursor' | 'gemini-cli' | 'opencode'

/** The coding agents the companion CLI can install into: ids, commands and global skills folders. */
export const COMPANION_AGENTS: readonly {
  id: CompanionAgentId
  label: string
  command: string
  skillsDir: { win32: string; default: string }
}[] = [
  { id: 'claude-code', label: 'Claude Code', command: 'claude', skillsDir: { win32: '~/.claude/skills', default: '~/.claude/skills' } },
  { id: 'codex', label: 'Codex', command: 'codex', skillsDir: { win32: '~/.codex/skills', default: '~/.codex/skills' } },
  { id: 'cursor', label: 'Cursor', command: 'cursor', skillsDir: { win32: '~/.cursor/skills', default: '~/.cursor/skills' } },
  { id: 'gemini-cli', label: 'Gemini CLI', command: 'gemini', skillsDir: { win32: '~/.gemini/skills', default: '~/.gemini/skills' } },
  {
    id: 'opencode',
    label: 'OpenCode',
    command: 'opencode',
    skillsDir: { win32: '%APPDATA%/opencode/skills', default: '~/.config/opencode/skills' }
  }
]

export type CompanionAgentState = 'installed' | 'available' | 'conflict' | 'undetected'

export interface CompanionCliStatus {
  enabled: boolean
  blockedByLocalOnly: boolean
  cliPath: string
  skillPath: string
  agents: { id: CompanionAgentId; label: string; installPath: string; state: CompanionAgentState; detail: string | null }[]
}

export const COMPANION_LIMITS = { startWaitMs: 15_000, detectTimeoutMs: 5_000, skillFolderName: 'notula' } as const
