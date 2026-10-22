// SPDX-License-Identifier: Apache-2.0
// registerChat(): the chat engine (context, tools, citations) and the `chat:*` IPC.
// Handlers are registered with literal channels only, so each channel can be traced to its
// handler statically; the two pushes are written in push.ts.
//
// `registerChat(ctx)` returns the ChatApi of `tool-api.ts` (the tool
// registry, registry.ts), which index.ts assigns to `ctx.chat`: the MCP client registers its
// tools through it and the local MCP server runs the library tools.

import { app, ipcMain } from 'electron'
import { notulaError, parseError } from '@shared/errors'
import type { InvokeChannel, InvokeReq, InvokeRes } from '@shared/ipc'
import { CHAT_LIMITS, type ChatThreadQuery } from '@shared/types/chat'
import { CHAT_MODEL_AUTO } from '@shared/types/enhance'
import type { MainContext } from '../context'
import { expected } from '../ipc-expected'
import { forgetModelLists } from '../llm/models'
import { log } from '../log'
import { installDevFixtures } from './dev-fixtures'
import { ChatEngine } from './engine'
import { ToolRegistry } from './registry'
import { forgetFolders } from './library'
import { pushChatChanged } from './push'
import { bad, uuid } from './request'
import type { ChatApi } from './tool-api'

/** Storage rejections the user can act on keep their code and message, without a stack. */
function rethrow(err: unknown): never {
  const p = parseError(err)
  if (p.code === 'internal') throw err
  throw expected(notulaError(p.code, p.message))
}

function threadQuery(raw: unknown): ChatThreadQuery {
  const q = (raw ?? {}) as Record<string, unknown>
  const out: ChatThreadQuery = {}
  if (q['groupingKey'] !== undefined) {
    if (typeof q['groupingKey'] !== 'string' || q['groupingKey'].length > 500) throw bad('groupingKey is invalid.')
    out.groupingKey = q['groupingKey']
  }
  if (q['includeDispatch'] === true) out.includeDispatch = true
  return out
}

export function registerChat(ctx: MainContext): ChatApi {
  const registry = new ToolRegistry(ctx)
  const engine = new ChatEngine(ctx, registry)

  // ---------- send and stop ----------

  ipcMain.handle(
    'chat:send-message' satisfies InvokeChannel,
    async (_e, req: InvokeReq<'chat:send-message'>): Promise<InvokeRes<'chat:send-message'>> => {
      try {
        return await engine.send(req)
      } catch (err) {
        rethrow(err)
      }
    }
  )

  ipcMain.handle('chat:stop' satisfies InvokeChannel, async (_e, req: InvokeReq<'chat:stop'>): Promise<void> => {
    await engine.stop((req as { threadId?: unknown } | null)?.threadId)
  })

  // ---------- threads ----------

  ipcMain.handle(
    'chat:list-threads' satisfies InvokeChannel,
    async (_e, req: InvokeReq<'chat:list-threads'>): Promise<InvokeRes<'chat:list-threads'>> => {
      try {
        return await ctx.storage.listChatThreads(threadQuery(req))
      } catch (err) {
        rethrow(err)
      }
    }
  )

  ipcMain.handle(
    'chat:get-thread' satisfies InvokeChannel,
    async (_e, req: InvokeReq<'chat:get-thread'>): Promise<InvokeRes<'chat:get-thread'>> => {
      const id = uuid((req as { threadId?: unknown } | null)?.threadId, 'threadId')
      try {
        const thread = await ctx.storage.getChatThread(id)
        if (!thread) return null
        return { thread, messages: await ctx.storage.listChatMessages(id) }
      } catch (err) {
        rethrow(err)
      }
    }
  )

  ipcMain.handle(
    'chat:update-thread' satisfies InvokeChannel,
    async (_e, req: InvokeReq<'chat:update-thread'>): Promise<InvokeRes<'chat:update-thread'>> => {
      const id = uuid((req as { threadId?: unknown } | null)?.threadId, 'threadId')
      const patch = ((req as { patch?: unknown } | null)?.patch ?? {}) as Record<string, unknown>
      const out: { title?: string | null; is_pinned?: boolean } = {}
      if (patch['title'] !== undefined) {
        if (patch['title'] !== null && typeof patch['title'] !== 'string') throw bad('title must be text.')
        // At most 100 characters; empty shows as "New chat".
        const title = typeof patch['title'] === 'string' ? patch['title'].trim().slice(0, CHAT_LIMITS.renameMax) : ''
        out.title = title || null
      }
      if (patch['is_pinned'] !== undefined) {
        if (typeof patch['is_pinned'] !== 'boolean') throw bad('is_pinned must be a boolean.')
        out.is_pinned = patch['is_pinned']
      }
      try {
        const existing = await ctx.storage.getChatThread(id)
        if (!existing) throw expected(notulaError('not-found', 'That chat no longer exists.'))
        const thread = await ctx.storage.upsertChatThread({ id, ...out })
        pushChatChanged(ctx.windows, [id])
        return thread
      } catch (err) {
        rethrow(err)
      }
    }
  )

  ipcMain.handle('chat:delete-thread' satisfies InvokeChannel, async (_e, req: InvokeReq<'chat:delete-thread'>): Promise<void> => {
    const id = uuid((req as { threadId?: unknown } | null)?.threadId, 'threadId')
    await engine.stop(id)
    try {
      await ctx.storage.deleteChatThread(id)
    } catch (err) {
      rethrow(err)
    }
    log('info', 'chat:thread-deleted', { threadId: id })
    pushChatChanged(ctx.windows, [id])
  })

  // ---------- tool-call decisions ----------

  ipcMain.handle('chat:update-tool-call' satisfies InvokeChannel, async (_e, req: InvokeReq<'chat:update-tool-call'>): Promise<void> => {
    try {
      await engine.updateToolCall(req)
    } catch (err) {
      rethrow(err)
    }
  })

  // ---------- bus ----------

  // A provider change resets both selections to Auto.
  ctx.bus.on('settings:changed', (e) => {
    if (e.keys.some((k) => k === 'llm.provider' || k.endsWith('.baseUrl') || k.endsWith('.model'))) forgetModelLists()
    if (!e.keys.includes('llm.provider')) return
    for (const key of ['chat.model.single', 'chat.model.multi'] as const) {
      if (e.settings[key] === CHAT_MODEL_AUTO) continue
      void ctx.settings.set(key, CHAT_MODEL_AUTO).catch((err: unknown) => log('warn', 'chat:model-reset-failed', { key, err }))
    }
    log('info', 'chat:models-reset', { provider: e.settings['llm.provider'] })
  })
  ctx.bus.on('folders:changed', () => forgetFolders())
  ctx.bus.on('enhance:completed', (e) => engine.onGenerationCompleted(e))
  // A real quit only: a soft quit hides the window and the answer keeps streaming.
  app.on('will-quit', () => engine.stopAll())

  const api = registry.api()
  installDevFixtures(ctx, registry, api)
  return api
}
