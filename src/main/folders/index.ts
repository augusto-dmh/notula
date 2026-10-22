// SPDX-License-Identifier: Apache-2.0
// registerFolders(): folders and lists. Owns the `folders:*` IPC, recurring-series filing,
// the auto-add rules on
// bus `enhance:completed`, the opt-in AI folder suggestion (LLM purpose
// `folder-suggest`), and emits bus `folders:changed`.
//
// Every channel is written as a literal at its call site, so each one can be traced to its
// handler statically. Payloads are whitelisted in validate.ts; the repo enforces the folder rules.

import { ipcMain } from 'electron'
import type { InvokeChannel, InvokeRes, PushChannel } from '@shared/ipc'
import type { IsoTime } from '@shared/types/common'
import { FOLDER_LIMITS } from '@shared/types/folders'
import type { MainContext } from '../context'
import { log } from '../log'
import { Filing } from './filing'
import { SeriesIndex } from './series'
import {
  addNotesRequest,
  createRequest,
  deleteRequest,
  idRequest,
  removeNoteRequest,
  ruleRequest,
  updateRequest
} from './validate'

const FOLDER_TABLES = ['folders', 'folder_notes', 'folder_rules']
/** The `folders.useTimestamps` validator's key limit. */
const MAX_USE_KEYS = 1_000

export function registerFolders(ctx: MainContext): void {
  const { storage, settings, bus, windows } = ctx

  // ---------- push and bus ----------

  const pushChanged = (folderIds: string[]): void => {
    const payload = { folderIds }
    for (const wc of windows.targets()) wc.send('folders:changed' satisfies PushChannel, payload)
  }

  // The repo touches folder tables with folder ids only (folders-repo.ts), so a change's
  // ids are the folders that changed, whoever wrote them (IPC or the auto-add rules).
  storage.onChange((change) => {
    if (!change.tables.some((t) => FOLDER_TABLES.includes(t))) return
    pushChanged(change.ids)
    bus.emit('folders:changed', { folderIds: change.ids })
  })

  const series = new SeriesIndex(ctx)
  const filing = new Filing(ctx, series, pushChanged)
  bus.on('enhance:completed', (e) => void filing.onGenerated(e))

  // ---------- use timestamps: newest 10 per folder, 5 s de-dup ----------

  let useQueue: Promise<void> = Promise.resolve()
  const updateUses = (fn: (uses: Record<string, IsoTime[]>) => Record<string, IsoTime[]> | null): void => {
    useQueue = useQueue
      .then(async () => {
        const next = fn(structuredClone(await settings.get('folders.useTimestamps')))
        if (next) await settings.set('folders.useTimestamps', next)
      })
      .catch((err: unknown) => log('warn', 'folders:use-timestamps-failed', { err }))
  }

  const recordUse = (folderId: string): void =>
    updateUses((uses) => {
      const now = Date.now()
      const list = uses[folderId] ?? []
      const last = list[0] ? Date.parse(list[0]) : NaN
      if (!Number.isNaN(last) && now - last < FOLDER_LIMITS.useDedupMs) return null
      uses[folderId] = [new Date(now).toISOString(), ...list].slice(0, FOLDER_LIMITS.usesKept)
      const keys = Object.keys(uses)
      if (keys.length > MAX_USE_KEYS) {
        // Keep the folders used most recently.
        keys
          .sort((a, b) => Date.parse(uses[b]?.[0] ?? '') - Date.parse(uses[a]?.[0] ?? ''))
          .slice(MAX_USE_KEYS)
          .forEach((k) => delete uses[k])
      }
      return uses
    })

  const forgetUses = (folderId: string): void =>
    updateUses((uses) => {
      if (!(folderId in uses)) return null
      delete uses[folderId]
      return uses
    })

  // ---------- IPC ----------

  ipcMain.handle('folders:list' satisfies InvokeChannel, (): Promise<InvokeRes<'folders:list'>> => storage.listFolders())

  ipcMain.handle(
    'folders:create' satisfies InvokeChannel,
    async (_e, req: unknown): Promise<InvokeRes<'folders:create'>> => {
      const folder = await storage.createFolder(createRequest(req))
      // No telemetry: `folder-added` / `subfolder-created` are local debug lines.
      log('debug', 'folders:created', { id: folder.id, nested: folder.parent_id !== null, preset: folder.preset })
      return folder
    }
  )

  ipcMain.handle(
    'folders:update' satisfies InvokeChannel,
    (_e, req: unknown): Promise<InvokeRes<'folders:update'>> => {
      const r = updateRequest(req)
      return storage.updateFolder(r.id, r.patch)
    }
  )

  // Subfolders move up a level; notes are never touched.
  ipcMain.handle(
    'folders:delete' satisfies InvokeChannel,
    async (_e, req: unknown): Promise<InvokeRes<'folders:delete'>> => {
      const r = deleteRequest(req)
      await storage.deleteFolder(r.id)
      forgetUses(r.id)
    }
  )

  ipcMain.handle(
    'folders:add-notes' satisfies InvokeChannel,
    async (_e, req: unknown): Promise<InvokeRes<'folders:add-notes'>> => {
      const r = addNotesRequest(req)
      const added = await storage.addNotesToFolder(r.folderId, r.noteIds, r.source)
      recordUse(r.folderId)
      log('debug', 'folders:notes-added', { folderId: r.folderId, added, source: r.source })
      return { added }
    }
  )

  ipcMain.handle(
    'folders:remove-note' satisfies InvokeChannel,
    (_e, req: unknown): Promise<InvokeRes<'folders:remove-note'>> => {
      const r = removeNoteRequest(req)
      return storage.removeNoteFromFolder(r.folderId, r.noteId)
    }
  )

  ipcMain.handle(
    'folders:set-rule' satisfies InvokeChannel,
    (_e, req: unknown): Promise<InvokeRes<'folders:set-rule'>> => storage.setFolderRule(ruleRequest(req))
  )

  ipcMain.handle(
    'folders:delete-rule' satisfies InvokeChannel,
    (_e, req: unknown): Promise<InvokeRes<'folders:delete-rule'>> => storage.deleteFolderRule(idRequest(req, 'id'))
  )

  ipcMain.handle(
    'folders:suggest' satisfies InvokeChannel,
    (_e, req: unknown): Promise<InvokeRes<'folders:suggest'>> => filing.suggest(idRequest(req, 'noteId'))
  )
}
