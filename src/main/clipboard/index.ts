// SPDX-License-Identifier: Apache-2.0
// registerClipboard(): the `clipboard:*` IPC, the awaited clipboard writes of copy, export and
// chat's "Copy as image".
//
// The renderer writes with the Clipboard API first; these are its fallbacks, so a
// rejected write still reaches the user's clipboard or an error toast.

import { clipboard, ClipboardItem, ipcMain } from 'electron'
import { notulaError } from '@shared/errors'
import type { InvokeChannel, InvokeRes } from '@shared/ipc'
import type { Rect } from '@shared/types/common'
import type { MainContext } from '../context'
import { log } from '../log'

/** Upper bound for one clipboard flavor. */
const MAX_FLAVOR_CHARS = 16 * 1024 * 1024
/** Upper bound for one side of a captured page region. */
const MAX_RECT_SIDE = 16_384

const bad = (message: string): Error => notulaError('invalid-input', message)

function record(v: unknown): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw bad('request must be an object')
  return v as Record<string, unknown>
}

function flavor(v: unknown, what: string): string {
  if (typeof v !== 'string' || v.length > MAX_FLAVOR_CHARS) throw bad(`${what} must be a string under 16 MB`)
  return v
}

function rect(v: unknown): Rect {
  const r = record(v)
  const out: Record<keyof Rect, number> = { x: 0, y: 0, width: 0, height: 0 }
  for (const k of ['x', 'y', 'width', 'height'] as const) {
    const n = r[k]
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > MAX_RECT_SIDE) throw bad(`rect.${k} must be a number`)
    out[k] = Math.round(n)
  }
  if (out.width < 1 || out.height < 1) throw bad('rect must have a size')
  return out
}

export function registerClipboard(_ctx: MainContext): void {
  // One clipboard item with both flavors, committed atomically.
  ipcMain.handle(
    'clipboard:write' satisfies InvokeChannel,
    async (_e, req: unknown): Promise<InvokeRes<'clipboard:write'>> => {
      const r = record(req)
      const item = new ClipboardItem({ 'text/html': flavor(r['html'], 'html'), 'text/plain': flavor(r['text'], 'text') })
      await clipboard.write([item])
    }
  )

  // The transcript's plain-text fallback.
  ipcMain.handle(
    'clipboard:copy-text' satisfies InvokeChannel,
    async (_e, req: unknown): Promise<InvokeRes<'clipboard:copy-text'>> => {
      await clipboard.writeText(flavor(record(req)['text'], 'text'))
    }
  )

  // The sending window's region, captured by main, then written as a PNG.
  ipcMain.handle(
    'clipboard:write-image-rect' satisfies InvokeChannel,
    async (e, req: unknown): Promise<InvokeRes<'clipboard:write-image-rect'>> => {
      const region = rect(record(req)['rect'])
      const image = await e.sender.capturePage(region)
      if (image.isEmpty()) throw notulaError('internal', 'the page region could not be captured')
      const png = new Uint8Array(image.toPNG())
      await clipboard.write([new ClipboardItem({ 'image/png': new Blob([png], { type: 'image/png' }) })])
      log('debug', 'clipboard:image-written', { width: region.width, height: region.height })
    }
  )
}
