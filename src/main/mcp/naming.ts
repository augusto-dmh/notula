// SPDX-License-Identifier: Apache-2.0
// How MCP tools are offered to the model: `mcp__<server>__<tool>`.
//
// - `<server>` is the connection name slugged to `a-z 0-9 _ -`, with `_<6 hex>` of the
//   connection id appended when two connections slug the same;
// - characters outside `A-Z a-z 0-9 _ -` in `<tool>` become `_`;
// - a name over 64 characters has its tool part cut and `_<6 hex>` of the tool name added.

import { createHash } from 'node:crypto'
import { MCP_LIMITS } from '@shared/types/mcp'

export function hex6(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 6)
}

export function slugServer(name: string): string {
  const s = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
  return s || 'server'
}

/** Server slugs per connection id, in list order, made unique. */
export function serverSlugs(conns: readonly { id: string; name: string }[]): Map<string, string> {
  const counts = new Map<string, number>()
  for (const c of conns) counts.set(slugServer(c.name), (counts.get(slugServer(c.name)) ?? 0) + 1)
  const out = new Map<string, string>()
  for (const c of conns) {
    const base = slugServer(c.name)
    out.set(c.id, (counts.get(base) ?? 0) > 1 ? `${base}_${c.id.replace(/-/g, '').slice(0, 6)}` : base)
  }
  return out
}

export function offeredName(serverSlug: string, tool: string): string {
  const safe = tool.replace(/[^A-Za-z0-9_-]/g, '_') || 'tool'
  const full = `mcp__${serverSlug}__${safe}`
  if (full.length <= MCP_LIMITS.toolNameMax) return full
  const prefix = `mcp__${serverSlug}__`
  const room = MCP_LIMITS.toolNameMax - prefix.length - 7
  if (room < 1) return `mcp__${serverSlug.slice(0, MCP_LIMITS.toolNameMax - 20)}__${hex6(tool)}`.slice(0, MCP_LIMITS.toolNameMax)
  return `${prefix}${safe.slice(0, room)}_${hex6(tool)}`
}
