// SPDX-License-Identifier: Apache-2.0
// The Tasks page and the `tasks:*` IPC.
//
// - The list and the badge are computed in the storage worker from local data. The list
//   window is 7 days by note creation, the badge 7 days by meeting time.
// - A meeting task's toggle is one Yjs update to its summary room (origin `tasks`), appended to the
//   room's log and pushed to every window as `ydoc:updated`, so an open summary editor shows it at
//   once. A stale path changes nothing; the list refreshes either way.
// - Manual tasks live in `manual_tasks`, newest first, with a delete.
// - `tasks:changed` follows every write that can change the list (coalesced).
// The run itself is a chat the renderer starts on the user's provider; nothing here calls a model.

import { app, ipcMain } from 'electron'
import { notulaError } from '@shared/errors'
import type { InvokeChannel, InvokeReq, InvokeRes, PushChannel } from '@shared/ipc'
import { TASKS_LIMITS, type TaskToggle } from '@shared/types/tasks'
import type { YdocUpdated } from '@shared/types/ydoc'
import type { MainContext } from '../context'
import { expected } from '../ipc-expected'
import { log } from '../log'
import { runKHarness } from './dev-harness'

const ORIGIN = 'tasks'
const CHANGED_DEBOUNCE_MS = 300
const WATCHED = new Set(['manual_tasks', 'note_panels', 'documents'])

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

function bad(message: string): Error {
  return expected(notulaError('invalid-input', message))
}

function id(v: unknown, what: string): string {
  if (typeof v !== 'string' || !v || v.length > 200) throw bad(`${what} is required.`)
  return v
}

function toggleReq(v: unknown): TaskToggle {
  if (!isObject(v)) throw bad('request must be an object.')
  if (typeof v['checked'] !== 'boolean') throw bad('checked is required.')
  if (v['kind'] === 'manual') return { kind: 'manual', id: id(v['id'], 'id'), checked: v['checked'] }
  if (v['kind'] !== 'meeting') throw bad('kind is invalid.')
  const path = v['nodePath']
  if (!Array.isArray(path) || path.length === 0 || path.length > 64 || path.some((i) => !Number.isInteger(i) || (i as number) < 0)) {
    throw bad('nodePath is invalid.')
  }
  return { kind: 'meeting', documentId: id(v['documentId'], 'documentId'), panelId: id(v['panelId'], 'panelId'), nodePath: path as number[], checked: v['checked'] }
}

export function registerTasks(ctx: MainContext): void {
  const since = (): string => new Date(Date.now() - TASKS_LIMITS.windowMs).toISOString()

  let timer: NodeJS.Timeout | null = null
  const changed = (): void => {
    if (timer) return
    timer = setTimeout(() => {
      timer = null
      for (const wc of ctx.windows.targets()) wc.send('tasks:changed' satisfies PushChannel)
    }, CHANGED_DEBOUNCE_MS)
  }
  ctx.bus.on('storage:changed', (c) => {
    if (c.tables.some((t) => WATCHED.has(t))) changed()
  })

  ipcMain.handle('tasks:list' satisfies InvokeChannel, (_e, req: InvokeReq<'tasks:list'>): Promise<InvokeRes<'tasks:list'>> => {
    const q: Record<string, unknown> = isObject(req) ? req : {}
    return ctx.storage.listTasks({ since: since(), showCompleted: q['showCompleted'] === true, includeOlder: q['includeOlder'] === true })
  })

  ipcMain.handle('tasks:toggle' satisfies InvokeChannel, async (_e, req: InvokeReq<'tasks:toggle'>): Promise<void> => {
    const t = toggleReq(req)
    try {
      if (t.kind === 'manual') {
        await ctx.storage.setManualTask(t.id, t.checked)
        return
      }
      const r = await ctx.storage.toggleTaskItem({ panelId: t.panelId, nodePath: t.nodePath, checked: t.checked })
      if (!r) {
        log('info', 'tasks:toggle-no-room-update', { panelId: t.panelId })
        return
      }
      const { seq } = await ctx.storage.appendYdoc(r.roomId, r.update, ORIGIN)
      const payload: YdocUpdated = { roomId: r.roomId, update: r.update, seq, origin: ORIGIN }
      for (const wc of ctx.windows.targets()) wc.send('ydoc:updated' satisfies PushChannel, payload)
      log('info', 'tasks:toggled', { panelId: t.panelId, checked: t.checked })
    } finally {
      changed()
    }
  })

  ipcMain.handle('tasks:add' satisfies InvokeChannel, async (_e, req: InvokeReq<'tasks:add'>): Promise<InvokeRes<'tasks:add'>> => {
    const text = isObject(req) && typeof req['text'] === 'string' ? req['text'].trim() : ''
    if (!text) throw bad('A task needs some text.')
    if (text.length > TASKS_LIMITS.textMax) throw bad(`A task is at most ${TASKS_LIMITS.textMax} characters.`)
    const task = await ctx.storage.addManualTask(text)
    changed()
    return task
  })

  ipcMain.handle('tasks:delete' satisfies InvokeChannel, async (_e, req: InvokeReq<'tasks:delete'>): Promise<void> => {
    await ctx.storage.deleteManualTask(id(isObject(req) ? req['id'] : null, 'id'))
    changed()
  })

  ipcMain.handle(
    'tasks:get-badge' satisfies InvokeChannel,
    async (): Promise<InvokeRes<'tasks:get-badge'>> => ({ openCount: await ctx.storage.taskBadge(since()) })
  )

  // Dev only: the smoke harness (dev-harness.ts).
  const harness = process.env['NOTULA_DEV_K_HARNESS']
  if (!app.isPackaged && (harness === '1' || harness === '2')) void runKHarness(ctx, harness === '1' ? 1 : 2)
}
