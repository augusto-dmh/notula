// SPDX-License-Identifier: Apache-2.0
// registerSnapshots(): screen-share snapshots and bubble snapshots with the region overlay;
// their IPC.
//
// The picker (kind `snapshot-picker`) is a small always-on-top window beside the bubble's display centre;
// main closes it once a start resolves. `screen-snapshots:get-state` with an empty note id answers the
// feature's availability for the Labs row: `disabled` when the selected model takes no images or
// local-only mode blocks the provider, else `off`.

import { ipcMain, screen, type BrowserWindow } from 'electron'
import type { InvokeChannel, InvokeReq, InvokeRes, SendChannel, SendPayload } from '@shared/ipc'
import type { MainContext } from '../context'
import { log } from '../log'
import { bubbleHub } from '../bubble/hub'
import { RegionSnapshots } from './region'
import { ScreenSnapshots } from './screen'

const PICKER = { width: 560, height: 480 }

const validId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 200

export function registerSnapshots(ctx: MainContext): void {
  const shots = new ScreenSnapshots(ctx)
  const region = new RegionSnapshots(ctx)
  let picker: BrowserWindow | null = null

  const alive = (w: BrowserWindow | null): w is BrowserWindow => w !== null && !w.isDestroyed()

  function openPicker(noteId: string): void {
    if (alive(picker)) picker.destroy()
    const anchor = alive(bubbleHub.bubble) ? bubbleHub.bubble : ctx.windows.main()
    const d = anchor && !anchor.isDestroyed() ? screen.getDisplayMatching(anchor.getBounds()) : screen.getPrimaryDisplay()
    const a = d.workArea
    const width = Math.min(PICKER.width, a.width - 32)
    const height = Math.min(PICKER.height, a.height - 32)
    const w = ctx.windows.createSecondary({
      kind: 'snapshot-picker',
      route: `/snapshot-picker?noteId=${encodeURIComponent(noteId)}`,
      title: 'Choose what to snapshot',
      x: Math.round(a.x + (a.width - width) / 2),
      y: Math.round(a.y + (a.height - height) / 2),
      width,
      height,
      frame: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      roundedCorners: true,
      backgroundColor: '#1c1c1f'
    })
    w.setAlwaysOnTop(true, 'floating')
    w.once('ready-to-show', () => {
      if (!w.isDestroyed()) {
        w.show()
        w.focus()
      }
    })
    w.on('blur', () => {
      // A click elsewhere closes the picker, like a menu.
      setTimeout(() => {
        if (!w.isDestroyed() && !w.isFocused()) w.close()
      }, 150)
    })
    w.on('closed', () => {
      if (picker === w) picker = null
    })
    picker = w
  }

  // ---------- screen-share snapshots ----------

  ipcMain.handle('screen-snapshots:list-sources' satisfies InvokeChannel, (): Promise<InvokeRes<'screen-snapshots:list-sources'>> =>
    shots.listSources().catch((err: unknown) => {
      log('warn', 'snapshots:list-failed', { err })
      return []
    })
  )

  ipcMain.on('screen-snapshots:open-picker' satisfies SendChannel, (_e, raw: SendPayload<'screen-snapshots:open-picker'>) => {
    if (validId(raw?.noteId)) openPicker(raw.noteId)
  })

  ipcMain.handle(
    'screen-snapshots:start' satisfies InvokeChannel,
    async (e, req: InvokeReq<'screen-snapshots:start'>): Promise<InvokeRes<'screen-snapshots:start'>> => {
      if (!validId(req?.noteId) || typeof req.sourceId !== 'string' || !req.sourceId || req.sourceId.length > 300) return { status: 'source-gone' }
      const status = await shots.start(req.noteId, req.sourceId)
      if (status !== 'source-gone' && alive(picker) && picker.webContents.id === e.sender.id) picker.close()
      return { status }
    }
  )

  ipcMain.handle('screen-snapshots:stop' satisfies InvokeChannel, (_e, req: InvokeReq<'screen-snapshots:stop'>): void => {
    const reason = req?.reason
    if (!validId(req?.noteId) || (reason !== 'user' && reason !== 'meeting-ended' && reason !== 'source-gone')) return
    shots.stop(req.noteId, reason)
  })

  ipcMain.handle(
    'screen-snapshots:get-state' satisfies InvokeChannel,
    async (_e, req: InvokeReq<'screen-snapshots:get-state'>): Promise<InvokeRes<'screen-snapshots:get-state'>> => {
      const noteId = typeof req?.noteId === 'string' ? req.noteId.slice(0, 200) : ''
      if (noteId) return shots.state(noteId)
      return { noteId: '', state: (await shots.available()) ? 'off' : 'disabled', notice: null, sourceName: null, snapshots: [] }
    }
  )

  // ---------- bubble snapshots ----------

  ipcMain.handle('bubble:take-snapshot' satisfies InvokeChannel, async (_e, req: InvokeReq<'bubble:take-snapshot'>): Promise<InvokeRes<'bubble:take-snapshot'>> => {
    if (!validId(req?.noteId)) return { status: 'failed', error: 'capture-failed' }
    if (!(await ctx.settings.get('bubbleSnapshots.enabled'))) return { status: 'failed', error: 'capture-failed' }
    return region.take(req.noteId)
  })

  ipcMain.on('snapshot-region:ready' satisfies SendChannel, (e) => {
    if (region.isOverlay(e.sender.id)) region.ready()
  })

  ipcMain.on('snapshot-region:done' satisfies SendChannel, (e, raw: SendPayload<'snapshot-region:done'>) => {
    if (region.isOverlay(e.sender.id)) region.done(raw)
  })

  ipcMain.on('snapshot-region:cancel' satisfies SendChannel, (e) => {
    if (region.isOverlay(e.sender.id)) region.cancel()
  })
}
