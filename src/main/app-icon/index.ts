// SPDX-License-Identifier: Apache-2.0
// App icon colours: `app-icon:get-state` and `app-icon:set`.
//
// - Seven options: Default plus six colours, each unlocked by a number of the user's own
//   non-trashed notes, counted in the local database. Main re-checks the threshold on
//   every `app-icon:set`, so a locked colour is refused whatever the renderer sends.
// - The choice is `ui.appIcon` (main-only). It is applied at start-up and on every change:
//   on Windows to every Notula window through `windows.setAppIcon` (taskbar and Alt-Tab; the
//   shortcut and exe icon stay as installed, the tray keeps its status icon); on macOS to the Dock
//   while Notula runs, with no Finder icon. Development builds do the same.
// - The art is drawn at runtime (`tints.ts`). A debug log line on change.

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app, ipcMain, nativeImage } from 'electron'
import { notulaError } from '@shared/errors'
import type { InvokeChannel, InvokeReq, InvokeRes } from '@shared/ipc'
import { APP_ICON_THRESHOLDS, type AppIconState, type AppIconValue } from '@shared/types/app-icon'
import type { MainContext } from '../context'
import { expected } from '../ipc-expected'
import { log } from '../log'
import { iconImage } from './tints'

const VALUES: readonly AppIconValue[] = ['black', 'white', 'blue', 'yellow', 'red', 'pink']

export const appIconPlatformSupported = (): boolean => process.platform === 'win32' || process.platform === 'darwin'

/** macOS: the bundle's own icon, for Default. */
function bundleDockIcon(): Electron.NativeImage | null {
  for (const name of ['icon.icns', 'electron.icns']) {
    const p = join(process.resourcesPath, name)
    if (existsSync(p)) return nativeImage.createFromPath(p)
  }
  return null
}

export function applyAppIcon(ctx: MainContext, value: AppIconValue | null): void {
  if (process.platform === 'darwin') {
    const img = value ? iconImage(value) : bundleDockIcon()
    if (img && !img.isEmpty()) app.dock?.setIcon(img)
    return
  }
  if (process.platform === 'win32') ctx.windows.setAppIcon(value ? iconImage(value) : null)
}

async function noteCount(ctx: MainContext): Promise<number> {
  try {
    return await ctx.storage.noteCount({ excludeTrashed: true })
  } catch (err) {
    // Storage in recovery: nothing is unlocked beyond Default (the note count is unknown).
    log('debug', 'app-icon:count-failed', { err: err instanceof Error ? err.message : String(err) })
    return 0
  }
}

export async function appIconState(ctx: MainContext): Promise<AppIconState> {
  const [current, count] = await Promise.all([ctx.settings.get('ui.appIcon'), noteCount(ctx)])
  return { current, noteCount: count, platformSupported: appIconPlatformSupported() }
}

/** The change itself: validates, re-checks the threshold, stores and applies. */
export async function setAppIcon(ctx: MainContext, req: unknown): Promise<AppIconState> {
  const value = typeof req === 'object' && req !== null ? (req as { value?: unknown }).value : undefined
  if (value !== null && !VALUES.includes(value as AppIconValue)) throw expected(notulaError('invalid-input', 'value is invalid.'))
  const v = value as AppIconValue | null
  if (v) {
    const need = APP_ICON_THRESHOLDS[v]
    const count = await noteCount(ctx)
    if (count < need) {
      log('debug', 'app-icon:locked-refused', { value: v, count, need })
      throw expected(notulaError('invalid-input', `Unlock after ${need} notes (${count}/${need})`))
    }
  }
  await ctx.settings.set('ui.appIcon', v)
  applyAppIcon(ctx, v)
  log('debug', 'app-icon:changed', { value: v ?? 'default' })
  return appIconState(ctx)
}

export function registerAppIcon(ctx: MainContext): void {
  let applied: AppIconValue | null = null
  const applyStored = (): void => {
    void ctx.settings
      .get('ui.appIcon')
      .then((v) => {
        if (v === applied) return
        applied = v
        applyAppIcon(ctx, v)
      })
      .catch((err: unknown) => log('warn', 'app-icon:apply-failed', { err }))
  }
  applyStored()
  // Storage that opens late (after recovery) carries the stored choice with it.
  ctx.bus.on('storage:status', (s) => {
    if (s.state === 'ready') applyStored()
  })
  ctx.bus.on('settings:changed', (e) => {
    if (e.keys.includes('ui.appIcon')) applied = e.settings['ui.appIcon']
  })

  ipcMain.handle('app-icon:get-state' satisfies InvokeChannel, (): Promise<InvokeRes<'app-icon:get-state'>> => appIconState(ctx))
  ipcMain.handle('app-icon:set' satisfies InvokeChannel, (_e, req: InvokeReq<'app-icon:set'>): Promise<InvokeRes<'app-icon:set'>> => setAppIcon(ctx, req))
}
