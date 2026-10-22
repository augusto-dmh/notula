// SPDX-License-Identifier: Apache-2.0
// registerEnhance(): enhanced notes, regenerate, rewrite, titles and the LLM keys,
// auto-generation on `capture:stopped` (and after a wake), the startup housekeeping, and
// `ctx.enhance`. Handlers are registered with literal channels only, so each channel can
// be traced to its handler statically; the one push is written in push.ts.

import { ipcMain } from 'electron'
import { notulaError } from '@shared/errors'
import type { InvokeChannel, InvokeReq, InvokeRes } from '@shared/ipc'
import type { ProviderTestResult } from '@shared/types/common'
import type { CloudLlmProviderId, LlmProviderId } from '@shared/types/enhance'
import type { EnhanceApi, MainContext } from '../context'
import { expected } from '../ipc-expected'
import { log } from '../log'
import { AutoGeneration } from './auto'
import { noteChatInputs } from './chat-inputs'
import { runDevHarness } from './dev-harness'
import { toEnhanceError } from './errors'
import { Generator, ipcCode } from './generation'
import { buildProvider, CLOUD_LLM_PROVIDERS, LLM_PROVIDERS, llmSecretId } from '../llm/registry'
import { generateTitle } from './title'

const MAX_KEY_LENGTH = 1_024
const PROVIDER_CALL_TIMEOUT_MS = 30_000

function cloudProvider(req: unknown): CloudLlmProviderId {
  const p = (req as { provider?: unknown } | null)?.provider
  if (typeof p !== 'string' || !CLOUD_LLM_PROVIDERS.includes(p as CloudLlmProviderId)) {
    throw notulaError('invalid-input', 'Unknown AI provider.')
  }
  return p as CloudLlmProviderId
}

function anyProvider(req: unknown): LlmProviderId {
  const p = (req as { provider?: unknown } | null)?.provider
  if (typeof p !== 'string' || !LLM_PROVIDERS.includes(p as LlmProviderId)) {
    throw notulaError('invalid-input', 'Unknown AI provider.')
  }
  return p as LlmProviderId
}

function noteId(req: unknown): string {
  const id = (req as { noteId?: unknown } | null)?.noteId
  if (typeof id !== 'string' || !id) throw notulaError('invalid-input', 'noteId is required.')
  return id
}

export function registerEnhance(ctx: MainContext): EnhanceApi {
  const generator = new Generator(ctx)
  const auto = new AutoGeneration(ctx, generator)

  // ---------- generation ----------

  ipcMain.handle(
    'enhance:generate' satisfies InvokeChannel,
    (_e, req: InvokeReq<'enhance:generate'>): Promise<InvokeRes<'enhance:generate'>> => generator.generate(req)
  )

  ipcMain.handle(
    'enhance:rewrite' satisfies InvokeChannel,
    (_e, req: InvokeReq<'enhance:rewrite'>): Promise<InvokeRes<'enhance:rewrite'>> => generator.rewrite(req)
  )

  ipcMain.handle(
    'enhance:title' satisfies InvokeChannel,
    (_e, req: InvokeReq<'enhance:title'>): Promise<InvokeRes<'enhance:title'>> => generateTitle(ctx, noteId(req))
  )

  ipcMain.handle(
    'enhance:get-active' satisfies InvokeChannel,
    (_e, req: InvokeReq<'enhance:get-active'>): InvokeRes<'enhance:get-active'> => generator.getActive(noteId(req))
  )

  // ---------- LLM keys and providers ----------

  ipcMain.handle('llm:set-key' satisfies InvokeChannel, async (_e, req: InvokeReq<'llm:set-key'>): Promise<void> => {
    const provider = cloudProvider(req)
    const key = typeof req?.key === 'string' ? req.key.trim() : ''
    if (!key || key.length > MAX_KEY_LENGTH || /\s/.test(key)) {
      throw expected(notulaError('invalid-input', 'That does not look like an API key.'))
    }
    await ctx.secrets.set(llmSecretId(provider), key)
    log('info', 'llm:key-set', { provider })
  })

  ipcMain.handle('llm:has-key' satisfies InvokeChannel, async (_e, req: InvokeReq<'llm:has-key'>): Promise<boolean> => {
    const id = llmSecretId(cloudProvider(req))
    if (await ctx.secrets.has(id)) return true
    // Dev builds may resolve a key from NOTULA_SECRET_* that `has` does not see.
    return ctx.isDev && (await ctx.secrets.get(id)) !== null
  })

  ipcMain.handle('llm:clear-key' satisfies InvokeChannel, async (_e, req: InvokeReq<'llm:clear-key'>): Promise<void> => {
    const provider = cloudProvider(req)
    await ctx.secrets.clear(llmSecretId(provider))
    log('info', 'llm:key-cleared', { provider })
  })

  ipcMain.handle('llm:test' satisfies InvokeChannel, async (_e, req: InvokeReq<'llm:test'>): Promise<ProviderTestResult> => {
    const id = anyProvider(req)
    const provider = buildProvider(id, await ctx.settings.getAll(), ctx.secrets)
    try {
      await provider.test(AbortSignal.timeout(PROVIDER_CALL_TIMEOUT_MS))
      log('info', 'llm:test-ok', { provider: id, model: provider.model })
      return { ok: true }
    } catch (err) {
      const e = toEnhanceError(err)
      log('info', 'llm:test-failed', { provider: id, code: e.code })
      return { ok: false, error: e.message }
    }
  })

  ipcMain.handle(
    'llm:list-models' satisfies InvokeChannel,
    async (_e, req: InvokeReq<'llm:list-models'>): Promise<InvokeRes<'llm:list-models'>> => {
      const id = anyProvider(req)
      const provider = buildProvider(id, await ctx.settings.getAll(), ctx.secrets)
      try {
        return await provider.listModels(AbortSignal.timeout(PROVIDER_CALL_TIMEOUT_MS))
      } catch (err) {
        // Shown in Settings as "Couldn't load models: …".
        const e = toEnhanceError(err)
        throw expected(notulaError(ipcCode(e.code), e.message))
      }
    }
  )

  // ---------- auto-generation ----------

  ctx.bus.on('capture:started', (e) => auto.onStarted(e))
  ctx.bus.on('capture:stopped', (e) => auto.onStopped(e))
  // A sleep stop is summarized after the wake.
  ctx.bus.on('power:suspended', () => auto.onSuspended())
  ctx.bus.on('power:resumed', (e) => auto.onResumed(e))

  // ---------- startup housekeeping, once storage is ready ----------

  let housekept = false
  const housekeeping = async (): Promise<void> => {
    if (housekept) return
    housekept = true
    // Panels left generating by the last run fail as `interrupted`, with Retry.
    try {
      const now = new Date().toISOString()
      for (const p of await ctx.storage.listGeneratingPanels()) {
        if (generator.isGenerating(p.id)) continue
        await ctx.storage.updatePanel(p.id, { enhance_failed_at: now, enhance_error: 'interrupted' })
        log('info', 'enhance:panel-interrupted', { panelId: p.id, noteId: p.document_id })
      }
    } catch (err) {
      log('error', 'enhance:interrupted-sweep-failed', { err })
    }
    // End-of-meeting generation queued by a quit or a window close.
    await auto.runQueued().catch((err: unknown) => log('error', 'enhance:queued-run-failed', { err }))
  }
  ctx.bus.on('storage:status', (s) => {
    if (s.state === 'ready') void housekeeping()
  })
  void ctx.storage
    .status()
    .then((s) => {
      if (s.state === 'ready') return housekeeping()
    })
    .catch((err: unknown) => log('error', 'enhance:status-failed', { err }))

  // Dev builds only: the notes and AI seams smoke harness (NOTULA_DEV_N_HARNESS).
  runDevHarness(ctx)

  // ---------- ctx.enhance ----------
  return {
    rewrite: (req) => generator.rewrite(req),
    didMeetingEnd: (id) => auto.didMeetingEnd(id),
    noteChatInputs: (id, opts) => noteChatInputs(ctx, id, opts),
    stopAndSummarize: (id, stop) => auto.stopAndSummarize(id, stop),
    // The end-of-meeting path for the demo and imports.
    autoGenerate: (id, opts) => auto.autoGenerate(id, opts)
  }
}
