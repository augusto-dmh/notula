// SPDX-License-Identifier: Apache-2.0
// Development fixtures for the chat tool registry.
// Dev builds only, each behind its own environment variable; packaged builds never load them.
//
// - NOTULA_DEV_CHAT_PROVIDER_FIXTURE=1 registers a tool provider through `ctx.chat`, as the
//   MCP client does: one MCP-shaped write tool that asks for approval and echoes its text
//   once approved.
// - NOTULA_DEV_CHAT_LIBRARY_CHECK=<keyword> runs `findMeetingsByTerms` once through
//   `runLibraryTool` (the local MCP server's path) and once through chat's own tool entry,
//   and logs whether the two payloads are identical.

import { app } from 'electron'
import type { MainContext } from '../context'
import { log } from '../log'
import { toolAvailability, type ToolRegistry } from './registry'
import type { ChatApi, ChatToolProvider } from './tool-api'
import type { ToolEnv } from './tools'

const FIXTURE_TOOL = 'mcp__fixture__note_echo'

function fixtureProvider(): ChatToolProvider {
  return {
    id: 'dev-fixture',
    tools: async () => [
      {
        def: {
          name: FIXTURE_TOOL,
          description: 'Development fixture: echoes the text after the user approves it. Use it only when asked to test the provider fixture.',
          inputSchema: { type: 'object', properties: { text: { type: 'string', description: 'What to echo.' } }, required: ['text'], additionalProperties: false }
        },
        category: 'generic',
        needsApproval: true,
        readOnly: false,
        title: 'Fixture echo',
        meta: { mcpLinkId: 'dev-fixture', mcpEndpoint: 'fixture://local', mcpToolLabel: 'Fixture echo' }
      }
    ],
    run: async (name, args) => {
      const text = typeof args['text'] === 'string' ? args['text'] : ''
      log('info', 'chat:dev-fixture-ran', { name, chars: text.length })
      return { content: `Echo: ${text}`, data: { echoed: text }, isError: false }
    }
  }
}

async function libraryCheck(ctx: MainContext, registry: ToolRegistry, api: ChatApi, keyword: string): Promise<void> {
  const args = { keywords: [keyword] }
  const signal = AbortSignal.timeout(30_000)
  const viaServer = await api.runLibraryTool('findMeetingsByTerms', args, signal)
  const avail = await toolAvailability(ctx, { place: { kind: 'global' }, noteId: null, noteEdit: false, rewrite: false })
  const entry = registry.build(avail, []).entries.get('findMeetingsByTerms')
  if (!entry) {
    log('warn', 'chat:library-check', { ok: false, reason: 'chat does not offer the tool' })
    return
  }
  const env: ToolEnv = {
    ctx,
    place: { kind: 'global' },
    threadId: 'dev-library-check',
    signal,
    noteId: null,
    target: null,
    latestSummaryPanelId: null,
    rewriteStarted: false,
    scanned: new Map(),
    windows: new Map()
  }
  const viaChat = await registry.run(entry, 'findMeetingsByTerms', args, env)
  const same = viaServer.content === viaChat.content && JSON.stringify(viaServer.data) === JSON.stringify(viaChat.result) && viaServer.isError === viaChat.isError
  log('info', 'chat:library-check', {
    ok: same,
    count: (viaChat.result as { count?: number } | null)?.count ?? null,
    contentChars: viaChat.content.length,
    libraryTools: api.libraryTools().map((t) => t.name)
  })
}

export function installDevFixtures(ctx: MainContext, registry: ToolRegistry, api: ChatApi): void {
  if (app.isPackaged) return
  if (process.env['NOTULA_DEV_CHAT_PROVIDER_FIXTURE'] === '1') registry.register(fixtureProvider())
  const keyword = process.env['NOTULA_DEV_CHAT_LIBRARY_CHECK']?.trim()
  if (keyword) {
    const run = (): void => {
      void libraryCheck(ctx, registry, api, keyword).catch((err: unknown) => log('warn', 'chat:library-check-failed', { err }))
    }
    ctx.bus.on('storage:status', (s) => {
      if (s.state === 'ready') run()
    })
    setTimeout(run, 8_000)
  }
}
