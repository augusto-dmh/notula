// SPDX-License-Identifier: Apache-2.0
// registerImports(): recording imports: the queue, the cloud and local engines and the
// media-worker window; the `imports:*` IPC. Returns `ctx.imports`.
// Handlers are registered with literal channels only; paths come in, bytes never do.

import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { notulaError } from '@shared/errors'
import type { InvokeChannel, InvokeReq } from '@shared/ipc'
import type { ImportJob } from '@shared/types/recordings'
import type { ImportsApi, MainContext } from '../context'
import { expected } from '../ipc-expected'
import { log } from '../log'
import { getTranscriptionManager } from '../transcription/manager'
import { ImportFailure } from './cloud'
import { MediaHost } from './media'
import { ImportQueue } from './queue'

export function registerImports(ctx: MainContext): ImportsApi {
  const queue = new ImportQueue(ctx, getTranscriptionManager(ctx), new MediaHost(ctx))

  const start = async (paths: unknown): Promise<ImportJob[]> => {
    try {
      return await queue.start(paths)
    } catch (err) {
      if (err instanceof ImportFailure) throw expected(notulaError('invalid-input', err.message))
      throw err
    }
  }

  ipcMain.handle('imports:start' satisfies InvokeChannel, (_e, req: InvokeReq<'imports:start'>): Promise<ImportJob[]> =>
    start((req as { paths?: unknown } | null)?.paths)
  )

  ipcMain.handle('imports:list' satisfies InvokeChannel, (): Promise<ImportJob[]> => queue.list())

  ipcMain.handle('imports:dismiss' satisfies InvokeChannel, async (_e, req: InvokeReq<'imports:dismiss'>): Promise<void> => {
    const id = (req as { jobId?: unknown } | null)?.jobId
    if (typeof id !== 'string' || !id) throw expected(notulaError('invalid-input', 'jobId is required.'))
    await queue.dismiss(id)
  })

  // Unfinished jobs from an earlier run, once storage is ready.
  const restore = (): void => {
    void queue.restore().catch((err: unknown) => log('error', 'imports:restore-failed', { err }))
  }
  ctx.bus.on('storage:status', (s) => {
    if (s.state === 'ready') restore()
  })
  void ctx.storage
    .status()
    .then((s) => {
      if (s.state === 'ready') restore()
    })
    .catch(() => undefined)
  app.on('before-quit', () => {
    queue.quitting = true
    queue.stopAll()
  })

  return {
    // The File menu's "Import recording…": main's file dialog with the import filters, then the import path.
    promptAndStart: async () => {
      const win = ctx.windows.main() ?? BrowserWindow.getFocusedWindow()
      const opts = {
        title: 'Import recording',
        buttonLabel: 'Transcribe',
        properties: ['openFile', 'multiSelections'] as ('openFile' | 'multiSelections')[],
        filters: [{ name: 'Audio', extensions: ['mp3', 'm4a', 'aac', 'wav'] }]
      }
      const picked = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
      if (picked.canceled || !picked.filePaths.length) return
      await start(picked.filePaths)
    }
  }
}
