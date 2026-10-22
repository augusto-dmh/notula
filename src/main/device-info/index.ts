// SPDX-License-Identifier: Apache-2.0
// This device: `device:get-info` and `device:reveal-data-folder`.
//
// - Notula has no accounts, so the only "session" is this computer: `device:get-info` describes it
//   and `device:reveal-data-folder` opens the data folder in the file manager.
// - `app.firstRunAt` ("In use since") is set once, at the first start that knows it, from the database's
//   creation time or else now. Until storage is open the write is retried on the next read.
// Nothing here leaves the machine.

import { hostname } from 'node:os'
import { app, ipcMain, shell } from 'electron'
import type { InvokeChannel, InvokeRes, SendChannel } from '@shared/ipc'
import type { IsoTime } from '@shared/types/common'
import type { MainContext } from '../context'
import { log } from '../log'
import { runGHarness } from './dev-harness'

/** "Windows 11", "macOS", "Linux": the OS family as people name it. */
export function osName(): string {
  if (process.platform === 'darwin') return 'macOS'
  if (process.platform === 'win32') {
    // Windows 11 still reports 10.0; its builds start at 22000.
    const build = Number(process.getSystemVersion().split('.')[2] ?? 0)
    return build >= 22_000 ? 'Windows 11' : 'Windows 10'
  }
  return 'Linux'
}

/** Sets `app.firstRunAt` once; resolves to its value, or null while storage is not open. */
async function ensureFirstRunAt(ctx: MainContext): Promise<IsoTime | null> {
  const current = await ctx.settings.get('app.firstRunAt')
  if (current) return current
  try {
    const created = await ctx.storage.databaseCreatedAt()
    const at = created ?? (new Date().toISOString() as IsoTime)
    await ctx.settings.set('app.firstRunAt', at)
    log('debug', 'device:first-run-at', { from: created ? 'database' : 'now' })
    return at
  } catch (err) {
    log('debug', 'device:first-run-at-deferred', { err: err instanceof Error ? err.message : String(err) })
    return null
  }
}

export function registerDeviceInfo(ctx: MainContext): void {
  void ensureFirstRunAt(ctx).catch(() => undefined)
  // Dev only (unpackaged): the general settings smoke harness.
  const harness = process.env['NOTULA_DEV_G_HARNESS']
  if (!app.isPackaged && (harness === '1' || harness === '2')) void runGHarness(ctx, harness === '1' ? 1 : 2)

  ipcMain.handle('device:get-info' satisfies InvokeChannel, async (): Promise<InvokeRes<'device:get-info'>> => {
    const [firstRunAt, deviceLockEnabled, status] = await Promise.all([
      ensureFirstRunAt(ctx),
      ctx.settings.get('security.deviceLock'),
      ctx.storage.status().catch(() => null)
    ])
    return {
      deviceName: hostname(),
      os: osName(),
      osVersion: process.getSystemVersion(),
      appVersion: app.getVersion(),
      dataFolder: app.getPath('userData'),
      encrypted: status?.state === 'ready',
      firstRunAt,
      deviceLockEnabled
    }
  })

  ipcMain.on('device:reveal-data-folder' satisfies SendChannel, () => {
    void shell.openPath(app.getPath('userData')).then((err) => {
      if (err) log('warn', 'device:reveal-failed', { err })
    })
  })
}
