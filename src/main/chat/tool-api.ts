// SPDX-License-Identifier: Apache-2.0
// The chat tool registry contract. The registry lives inside `chat/` and is returned as
// ChatApi from `registerChat(ctx)` (index.ts assigns `ctx.chat`); the MCP client registers
// its tool provider and the local MCP server runs the library tools through it.

import type { ChatPlace, ChatToolCategory } from '@shared/types/chat'
import type { LlmToolDef } from '../llm/types'

export interface ChatToolSpec {
  def: LlmToolDef
  category: ChatToolCategory
  needsApproval: boolean
  readOnly: boolean
  title?: string
  /** The MCP server a `mcp__<server>__<tool>` tool belongs to. */
  meta?: { mcpLinkId: string; mcpEndpoint: string; mcpToolLabel: string | null }
}

export interface ChatToolResult {
  /** What the model sees. */
  content: string
  /** The card's data. */
  data?: unknown
  isError: boolean
}

export interface ChatToolProvider {
  id: string
  /** Called once per answer. */
  tools(ctx: { place: ChatPlace; noteId: string | null }): Promise<ChatToolSpec[]>
  run(
    name: string,
    args: Record<string, unknown>,
    opts: { signal: AbortSignal; threadId: string; onProgress?(message: string): void }
  ): Promise<ChatToolResult>
  /** Tools that need approval: a problem that goes back to the model before any card waits. */
  check?(name: string, args: Record<string, unknown>): Promise<string | null>
  /** Tools that need approval: what their approval card shows. */
  preview?(name: string, args: Record<string, unknown>): Promise<{ title: string; lines: string[] } | null>
}

/** The read-only tools the local MCP server offers. */
export type LibraryToolName =
  | 'getCurrentTime'
  | 'listMeetings'
  | 'findMeetingsByTerms'
  | 'findMeetingsWithPeople'
  | 'gatherMeetingContext'
  | 'getMeetings'
  | 'readMeetings'
  | 'readTranscript'
  | 'findFolders'
  | 'locateNotes'

export interface ChatApi {
  /** Returns the unregister function. */
  registerToolProvider(p: ChatToolProvider): () => void
  libraryTools(): {
    name: LibraryToolName
    title: string
    description: string
    inputSchema: LlmToolDef['inputSchema']
    outputSchema: Record<string, unknown>
  }[]
  /** The same implementation, caps and shapes as chat's own tools. */
  runLibraryTool(name: LibraryToolName, args: Record<string, unknown>, signal: AbortSignal): Promise<ChatToolResult>
}
