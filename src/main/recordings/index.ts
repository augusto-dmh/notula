// SPDX-License-Identifier: Apache-2.0
// registerRecordings(): kept meeting audio, encrypted as NAU1, the retention sweep and WAV
// export; the `recordings:*` IPC. Handlers are registered with literal channels only. No
// channel returns audio bytes or a key.

import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { notulaError } from '@shared/errors'
import type { InvokeChannel, InvokeReq } from '@shared/ipc'
import type { RecordingInfo, RecordingsUsage } from '@shared/types/recordings'
import type { MainContext } from '../context'
import { expected } from '../ipc-expected'
import { log } from '../log'
import { getRecordings } from './service'

function noteIdOf(req: unknown): string {
  const id = (req as { noteId?: unknown } | null)?.noteId
  if (typeof id !== 'string' || !id || id.length > 200) throw expected(notulaError('invalid-input', 'noteId is required.'))
  return id
}

export function registerRecordings(ctx: MainContext): void {
  const svc = getRecordings(ctx)

  ipcMain.handle('recordings:list' satisfies InvokeChannel, (_e, req: InvokeReq<'recordings:list'>): Promise<RecordingInfo[]> =>
    svc.list(noteIdOf(req))
  )

  ipcMain.handle(
    'recordings:export' satisfies InvokeChannel,
    async (e, req: InvokeReq<'recordings:export'>): Promise<{ paths: string[] }> => {
      const noteId = noteIdOf(req)
      const note = await ctx.storage.getNote(noteId, { includeDeleted: true })
      if (!note) throw expected(notulaError('not-found', 'This note no longer exists.'))
      const recordings = await svc.list(noteId)
      if (!recordings.length) return { paths: [] }
      // Dev builds only: NOTULA_DEV_DIALOG_DIR answers the picker, like the other pickers (the old
      // NOTULA_DEV_EXPORT_DIR still works).
      const devDir = !app.isPackaged ? (process.env['NOTULA_DEV_DIALOG_DIR'] || process.env['NOTULA_DEV_EXPORT_DIR'])?.trim() : ''
      if (devDir) return { paths: await svc.exportNote(noteId, devDir, note.title?.trim() || 'Untitled meeting') }
      const win = BrowserWindow.fromWebContents(e.sender) ?? ctx.windows.main()
      const opts = {
        title: 'Export meeting audio',
        buttonLabel: 'Export here',
        properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[]
      }
      const picked = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
      const folder = picked.filePaths[0]
      if (picked.canceled || !folder) return { paths: [] }
      return { paths: await svc.exportNote(noteId, folder, note.title?.trim() || 'Untitled meeting') }
    }
  )

  ipcMain.handle('recordings:delete' satisfies InvokeChannel, async (_e, req: InvokeReq<'recordings:delete'>): Promise<void> => {
    const r = req as { noteId?: unknown; recordingId?: unknown } | null
    if (typeof r?.recordingId === 'string' && r.recordingId) {
      await svc.deleteOne(r.recordingId)
      return
    }
    await svc.deleteForNote(noteIdOf(req))
  })

  ipcMain.handle('recordings:usage' satisfies InvokeChannel, (): Promise<RecordingsUsage> => svc.usage())

  ipcMain.handle('recordings:delete-all' satisfies InvokeChannel, async (_e, req: InvokeReq<'recordings:delete-all'>): Promise<void> => {
    if ((req as { confirmed?: unknown } | null)?.confirmed !== true) {
      throw expected(notulaError('invalid-input', 'Deleting all saved audio needs a confirmation.'))
    }
    await svc.deleteAll()
  })

  // Housekeeping once storage is ready: interrupted rows, then the first retention sweep.
  const start = (): void => {
    void svc.housekeeping().catch((err: unknown) => log('error', 'recordings:housekeeping-failed', { err }))
  }
  ctx.bus.on('storage:status', (s) => {
    if (s.state === 'ready') start()
  })
  void ctx.storage
    .status()
    .then((s) => {
      if (s.state === 'ready') start()
    })
    .catch(() => undefined)

  // A shorter retention applies at once rather than at the next 24 h sweep.
  ctx.bus.on('settings:changed', ({ keys }) => {
    if (keys.includes('audio.retention')) void svc.sweep('setting')
  })
}
