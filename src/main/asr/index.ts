// SPDX-License-Identifier: Apache-2.0
// registerLocalAsr(): the local model manager and the `asr:*-local-model` and
// `system:get-languages` IPC, the new-profile language default, and
// the diarization temp-audio cleanup.
// Handlers are registered with literal channels only.

import { app, ipcMain } from 'electron'
import { notulaError } from '@shared/errors'
import type { InvokeChannel, InvokeReq, PushChannel } from '@shared/ipc'
import { MULTI_LANGUAGE_SETS } from '@shared/types/languages'
import type { LocalModelState } from '@shared/types/transcript'
import type { MainContext } from '../context'
import { expected } from '../ipc-expected'
import { log } from '../log'
import { DEFAULT_SUPPORTED_CODES, defaultLanguageFor } from '../transcription/languages'
import { getTranscriptionManager } from '../transcription/manager'
import { cleanupOnQuit } from './diarize'
import { getLocalModels } from './instance'
import { MODEL_MANIFEST } from './manifest'
import { ModelError, modelIdOf } from './models'

/**
 * The OS preferred languages. Dev builds may override them with
 * `NOTULA_DEV_SYSTEM_LANGUAGES` (comma-separated) to exercise the new-profile default.
 */
function systemLanguages(): string[] {
  const dev = !app.isPackaged ? process.env['NOTULA_DEV_SYSTEM_LANGUAGES']?.trim() : ''
  if (dev) {
    return dev
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  }
  return app.getPreferredSystemLanguages()
}

/**
 * The new-profile default. Runs only when the raw
 * settings hold no `asr.language` row, so an existing profile never changes language.
 * The OS codes are checked against the default cloud provider's multilingual set when
 * that provider is configured, else against the 32-code list.
 */
async function applyLanguageDefault(ctx: MainContext): Promise<boolean> {
  const raw = await ctx.storage.getSettingsRaw()
  if (raw['asr.language'] !== undefined) return true
  // The earliest builds never wrote default rows, so an old profile can lack `asr.language`;
  // one that finished onboarding is not new and keeps its language.
  if ((raw['onboarding.aiProvidersDoneAt'] ?? null) !== null) {
    log('info', 'asr:language-default-skipped', { reason: 'existing profile' })
    return true
  }
  const langs = systemLanguages()
  if (!langs.length) {
    log('info', 'asr:language-default-skipped', { reason: 'no system languages' })
    return true
  }
  const provider = raw['asr.provider'] ?? 'deepgram'
  let supported: readonly string[] = DEFAULT_SUPPORTED_CODES
  if (provider === 'deepgram' && (await ctx.secrets.has('asr.deepgram'))) supported = MULTI_LANGUAGE_SETS['nova-3']
  else if (provider === 'assemblyai' && (await ctx.secrets.has('asr.assemblyai'))) supported = MULTI_LANGUAGE_SETS['universal-3-5-pro']
  const language = defaultLanguageFor(langs, supported)
  await ctx.settings.set('asr.language', language)
  if (language === 'multi') await ctx.settings.set('enhance.summaryLanguage', 'multi')
  log('info', 'asr:language-default', { systemLanguages: langs.join(','), language, provider })
  return true
}

function toIpcError(err: unknown): Error {
  if (err instanceof ModelError && err.message.startsWith('busy: ')) {
    return expected(notulaError('busy', err.message.slice('busy: '.length)))
  }
  return err instanceof Error ? err : new Error(String(err))
}

export function registerLocalAsr(ctx: MainContext): void {
  const models = getLocalModels(ctx)
  const manager = getTranscriptionManager(ctx)

  const modelId = (req: unknown) => {
    const id = modelIdOf(req)
    if (!id) throw expected(notulaError('invalid-input', 'Unknown model.'))
    return id
  }

  ipcMain.handle(
    'asr:get-local-model-state' satisfies InvokeChannel,
    (_e, req: InvokeReq<'asr:get-local-model-state'>): Promise<LocalModelState> => models.getState(modelId(req))
  )

  ipcMain.handle(
    'asr:download-local-model' satisfies InvokeChannel,
    async (_e, req: InvokeReq<'asr:download-local-model'>): Promise<LocalModelState> => {
      try {
        return await models.download(modelId(req))
      } catch (err) {
        throw toIpcError(err)
      }
    }
  )

  ipcMain.handle(
    'asr:delete-local-model' satisfies InvokeChannel,
    async (_e, req: InvokeReq<'asr:delete-local-model'>): Promise<LocalModelState> => {
      try {
        return await models.delete(modelId(req))
      } catch (err) {
        throw toIpcError(err)
      }
    }
  )

  ipcMain.handle('system:get-languages' satisfies InvokeChannel, (): string[] => systemLanguages())

  // At most one push per 250 ms per model, and the final state always.
  models.onState((state) => {
    for (const wc of ctx.windows.targets()) wc.send('asr:local-model-state-changed' satisfies PushChannel, state)
  })

  // Temp audio from an earlier run is deleted at startup, and this run's at quit.
  manager.diarizer.cleanupStale()
  cleanupOnQuit(manager.diarizer)

  const tryDefault = (): void => {
    applyLanguageDefault(ctx).catch((err: unknown) => {
      log('warn', 'asr:language-default-failed', { err })
      // Storage may still be opening or in recovery: try again once it is ready.
      const once = (s: { state: string }): void => {
        if (s.state !== 'ready') return
        ctx.bus.off('storage:status', once)
        void applyLanguageDefault(ctx).catch((e: unknown) => log('warn', 'asr:language-default-failed', { err: e }))
      }
      ctx.bus.on('storage:status', once)
    })
  }
  tryDefault()

  log('debug', 'asr:local-manifest', {
    models: Object.values(MODEL_MANIFEST).map((m) => ({ id: m.id, urls: m.downloads.map((d) => d.url) }))
  })
}
