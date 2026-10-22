// SPDX-License-Identifier: Apache-2.0
// Bubble snapshots: the display under the cursor is captured as a
// full-resolution still, shown dimmed in a full-display overlay (kind `snapshot-region`), and the
// dragged rectangle is cropped at device pixels, put on the clipboard as PNG and added to the note
// through `ctx.attachments` (outside the 10-image limit). One capture at a time; the
// still never touches the disk.

import { clipboard, ClipboardItem, desktopCapturer, screen, systemPreferences, type BrowserWindow, type Display, type NativeImage } from 'electron'
import type { PushChannel } from '@shared/ipc'
import type { Rect } from '@shared/types/common'
import { BUBBLE_SNAPSHOT_LIMITS as L, type BubbleSnapshotResult } from '@shared/types/snapshots'
import type { MainContext } from '../context'
import { log } from '../log'
import { openScreenGuide } from '../screen-guide/guide'
import { fit } from './frames'

type Outcome = { kind: 'done'; rect: Rect } | { kind: 'cancel' }

export class RegionSnapshots {
  private busy = false
  private overlay: BrowserWindow | null = null
  private pending: {
    image: NativeImage
    display: Display
    settle(o: Outcome): void
  } | null = null

  constructor(private readonly ctx: MainContext) {}

  isOverlay(wcId: number): boolean {
    return !!this.overlay && !this.overlay.isDestroyed() && this.overlay.webContents.id === wcId
  }

  /** The overlay asked for its still (`snapshot-region:ready`). */
  ready(): void {
    const p = this.pending
    const w = this.overlay
    if (!p || !w || w.isDestroyed()) return
    w.webContents.send('snapshot-region:image' satisfies PushChannel, { dataUrl: p.image.toDataURL(), scaleFactor: p.display.scaleFactor })
  }

  done(rect: Rect): void {
    this.pending?.settle({ kind: 'done', rect })
  }

  cancel(): void {
    this.pending?.settle({ kind: 'cancel' })
  }

  async take(noteId: string): Promise<BubbleSnapshotResult> {
    if (this.busy) return { status: 'failed', error: 'busy' }
    this.busy = true
    try {
      if (process.platform === 'darwin' && systemPreferences.getMediaAccessStatus('screen') !== 'granted') {
        // The guide instead of a black image.
        openScreenGuide()
        return { status: 'failed', error: 'permission-denied' }
      }
      const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
      const image = await this.still(display)
      if (!image || image.isEmpty()) return { status: 'failed', error: 'capture-failed' }
      const outcome = await this.select(image, display)
      if (outcome.kind === 'cancel') return { status: 'cancelled' }
      const cropped = this.crop(image, display, outcome.rect)
      if (!cropped) return { status: 'cancelled' }
      const png = cropped.toPNG()
      await clipboard
        .write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(png)], { type: 'image/png' }) })])
        .catch((err: unknown) => log('warn', 'bubble:snapshot-clipboard-failed', { err }))
      try {
        const a = await this.ctx.attachments.addNoteImage(
          noteId,
          { bytes: fit(cropped, L.maxSide).toPNG(), mimeType: 'image/png', fileName: `Snapshot ${new Date().toISOString().slice(11, 19).replace(/:/g, '.')}.png` },
          { countTowardLimit: false, maxSide: L.maxSide }
        )
        log('debug', 'bubble:snapshot-attached')
        return { status: 'attached', attachmentId: a.id }
      } catch (err) {
        log('warn', 'bubble:snapshot-store-failed', { err })
        return { status: 'failed', error: 'storage-failed' }
      }
    } catch (err) {
      log('warn', 'bubble:snapshot-failed', { err })
      return { status: 'failed', error: 'capture-failed' }
    } finally {
      this.busy = false
    }
  }

  private async still(display: Display): Promise<NativeImage | null> {
    const size = { width: Math.round(display.size.width * display.scaleFactor), height: Math.round(display.size.height * display.scaleFactor) }
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size, fetchWindowIcons: false })
    const match = sources.find((s) => s.display_id === String(display.id)) ?? (sources.length === 1 ? sources[0] : undefined)
    return match?.thumbnail ?? null
  }

  private select(image: NativeImage, display: Display): Promise<Outcome> {
    return new Promise<Outcome>((resolve) => {
      let settled = false
      const timer = setTimeout(() => settle({ kind: 'cancel' }), L.regionTimeoutMs)
      const settle = (o: Outcome): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.pending = null
        const w = this.overlay
        this.overlay = null
        if (w && !w.isDestroyed()) w.destroy()
        resolve(o)
      }
      this.pending = { image, display, settle }
      const w = this.ctx.windows.createSecondary({
        kind: 'snapshot-region',
        route: '/snapshot-region',
        title: 'Snapshot',
        ...display.bounds,
        frame: false,
        transparent: false,
        backgroundColor: '#000000',
        hasShadow: false,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        alwaysOnTop: true,
        skipTaskbar: true,
        focusable: true,
        enableLargerThanScreen: true,
        roundedCorners: false
      })
      w.setAlwaysOnTop(true, 'screen-saver')
      w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
      w.once('ready-to-show', () => {
        if (w.isDestroyed()) return
        w.setBounds(display.bounds)
        w.show()
        w.focus()
      })
      w.on('closed', () => settle({ kind: 'cancel' }))
      this.overlay = w
    })
  }

  /** The DIP rectangle at device-pixel precision; under 4 × 4 px is a cancel. */
  private crop(image: NativeImage, display: Display, r: Rect): NativeImage | null {
    if (!r || ![r.x, r.y, r.width, r.height].every((v) => typeof v === 'number' && Number.isFinite(v))) return null
    if (r.width < L.minRegionPx || r.height < L.minRegionPx) return null
    const size = image.getSize()
    const kx = size.width / display.bounds.width
    const ky = size.height / display.bounds.height
    const x = Math.max(0, Math.round(r.x * kx))
    const y = Math.max(0, Math.round(r.y * ky))
    const width = Math.min(size.width - x, Math.round(r.width * kx))
    const height = Math.min(size.height - y, Math.round(r.height * ky))
    if (width < 1 || height < 1) return null
    return image.crop({ x, y, width, height })
  }
}
