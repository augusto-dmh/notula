// SPDX-License-Identifier: Apache-2.0
// registerScratchpad(): the daily scratchpad and the `scratchpad:*` IPC.
//
// - The days live in the encrypted DB (`scratchpad_days`), never in localStorage.
// - `has_text` is computed here from the saved document (any non-blank text run).
// - After a save, `scratchpad:changed` goes to every window with the saving window's id; a
//   window that did not save it reloads that day when its content differs.
// - Days are listed relative to this computer's local date.
//
// Handlers and pushes write their channel literal.

import { ipcMain } from 'electron'
import { notulaError } from '@shared/errors'
import type { InvokeChannel, InvokeRes, PushChannel } from '@shared/ipc'
import type { MainContext } from '../context'
import { log } from '../log'

const DATE = /^\d{4}-\d{2}-\d{2}$/
const MAX_DEPTH = 200

/** `YYYY-MM-DD` in local time. */
export function localDate(d = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** True when any text node of the ProseMirror JSON has non-blank text. */
export function hasText(node: unknown, depth = 0): boolean {
  if (!node || typeof node !== 'object' || depth > MAX_DEPTH) return false
  const n = node as { text?: unknown; content?: unknown }
  if (typeof n.text === 'string' && n.text.trim() !== '') return true
  return Array.isArray(n.content) && n.content.some((c) => hasText(c, depth + 1))
}

function requireDate(v: unknown): string {
  if (typeof v !== 'string' || !DATE.test(v)) throw notulaError('invalid-input', 'date must be YYYY-MM-DD')
  return v
}

export function registerScratchpad(ctx: MainContext): void {
  ipcMain.handle('scratchpad:list-days' satisfies InvokeChannel, () => ctx.storage.listScratchpadDays(localDate()))

  ipcMain.handle('scratchpad:get-day' satisfies InvokeChannel, (_e, p: unknown) =>
    ctx.storage.getScratchpadDay(requireDate((p as { date?: unknown } | null)?.date))
  )

  ipcMain.handle('scratchpad:save-day' satisfies InvokeChannel, async (e, p: unknown): Promise<InvokeRes<'scratchpad:save-day'>> => {
    const date = requireDate((p as { date?: unknown } | null)?.date)
    const content = (p as { content?: unknown } | null)?.content
    if (!content || typeof content !== 'object' || (content as { type?: unknown }).type !== 'doc') {
      throw notulaError('invalid-input', 'content must be a ProseMirror document')
    }
    const result = await ctx.storage.saveScratchpadDay(date, content, hasText(content))
    log('debug', 'scratchpad:saved', { date })
    const sourceWebContentsId = e.sender.id
    for (const wc of ctx.windows.targets()) {
      wc.send('scratchpad:changed' satisfies PushChannel, { date, sourceWebContentsId })
    }
    return result
  })
}
