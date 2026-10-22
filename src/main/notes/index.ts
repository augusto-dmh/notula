// SPDX-License-Identifier: Apache-2.0
// registerNotesIpc(): the core IPC surface (storage:*, notes:*, ydoc:*, panels:*, prefs:*),
// the trash channels, and the pushes that follow the storage change feed.
//
// Every channel is written as a literal at its call site, so each one can be traced to its
// handler statically. Every payload is whitelisted in validate.ts before it reaches storage.

import { ipcMain } from 'electron'
import type { InvokeChannel, InvokeRes, PushChannel, SendChannel } from '@shared/ipc'
import { peopleForNote } from '@shared/lib/people'
import type { CalendarEvent, CreationSource, Note } from '@shared/types/notes'
import type { NotesChanged, StoreTable } from '@shared/types/storage'
import type { YdocUpdated } from '@shared/types/ydoc'
import type { MainContext } from '../context'
import { log } from '../log'
import { applyRendererPatch } from '../settings'
import { onStorageStatus } from '../storage'
import { autoDeleteIfEmpty, stopCaptureFor } from './trash'
import {
  autoDeleteRequest,
  createInput,
  deletePermanentlyRequest,
  findByEvent,
  getRequest,
  id,
  listQuery,
  notePatch,
  object,
  panelPatch,
  recoveryAction,
  roomId,
  ydocAppend
} from './validate'

const STORE_TABLES: readonly StoreTable[] = ['documents', 'note_panels', 'calendar_events']

/** The stored `created_via` is the platform. */
function creationSource(): CreationSource {
  switch (process.platform) {
    case 'darwin':
      return 'macOS'
    case 'win32':
      return 'Windows'
    case 'linux':
      return 'desktop'
    default:
      return 'unknown'
  }
}

export function registerNotesIpc(ctx: MainContext): void {
  const { storage, settings, bus, windows } = ctx

  /**
   * `notes:create`: main fills `people` at creation:
   * the profile as creator, and the event's attendees without resources and without the
   * user's own addresses. A note without an event gets the creator only. A failure
   * keeps the note as created.
   */
  async function withPeople(note: Note, event: CalendarEvent | null): Promise<Note> {
    try {
      const [name, email, myEmails] = await Promise.all([
        settings.get('profile.name'),
        settings.get('profile.email'),
        ctx.calendar.myEmails()
      ])
      const people = peopleForNote({ event, profile: { name: name.trim(), email: email.trim() }, myEmails })
      return await storage.updateNote(note.id, { people })
    } catch (err) {
      log('warn', 'notes:people-fill-failed', { id: note.id, err })
      return note
    }
  }

  // ---------- pushes ----------

  onStorageStatus(storage, (status) => {
    bus.emit('storage:status', status)
    for (const wc of windows.targets()) wc.send('storage:status-changed' satisfies PushChannel, status)
  })

  // One `notes:changed` per committed write batch that touched a note-side table.
  storage.onChange((change) => {
    bus.emit('storage:changed', change)
    const tables = change.tables.filter((t): t is StoreTable => STORE_TABLES.includes(t as StoreTable))
    if (tables.length === 0) return
    const payload: NotesChanged = { tables, ids: change.ids }
    for (const wc of windows.targets()) wc.send('notes:changed' satisfies PushChannel, payload)
  })

  // Every settings change, renderer- or main-initiated.
  bus.on('settings:changed', (e) => {
    for (const wc of windows.targets()) wc.send('prefs:changed' satisfies PushChannel, e)
  })

  // ---------- storage ----------

  ipcMain.handle(
    'storage:get-status' satisfies InvokeChannel,
    (): Promise<InvokeRes<'storage:get-status'>> => storage.status()
  )

  ipcMain.handle(
    'storage:recover' satisfies InvokeChannel,
    (_e, req: unknown): Promise<InvokeRes<'storage:recover'>> => storage.recover(recoveryAction(req))
  )

  // ---------- notes ----------

  ipcMain.handle(
    'notes:list' satisfies InvokeChannel,
    (_e, q: unknown): Promise<InvokeRes<'notes:list'>> => storage.listNotes(listQuery(q))
  )

  ipcMain.handle('notes:get' satisfies InvokeChannel, (_e, req: unknown): Promise<InvokeRes<'notes:get'>> => {
    const r = getRequest(req)
    return storage.getNote(r.id, { includeDeleted: r.includeDeleted === true })
  })

  ipcMain.handle(
    'notes:create' satisfies InvokeChannel,
    async (_e, req: unknown): Promise<InvokeRes<'notes:create'>> => {
      const input = createInput(req)
      const note = await storage.createNote({ ...input, created_via: creationSource() })
      // No telemetry: `new-note-created` is a local debug line, never sent.
      log('debug', 'notes:created', { id: note.id, origin: input.origin })
      return withPeople(note, input.calendarEvent ?? null)
    }
  )

  ipcMain.handle(
    'notes:update' satisfies InvokeChannel,
    (_e, req: unknown): Promise<InvokeRes<'notes:update'>> => {
      const r = object(req, 'request')
      const noteId = id(r['id'])
      const { patch, dropped } = notePatch(r['patch'])
      if (dropped.length) log('warn', 'notes:patch-keys-dropped', { id: noteId, dropped })
      return storage.updateNote(noteId, patch)
    }
  )

  // A note being captured stops first (`document_deleted`).
  ipcMain.handle('notes:trash' satisfies InvokeChannel, async (_e, req: unknown): Promise<InvokeRes<'notes:trash'>> => {
    const noteId = id(object(req, 'request')['id'])
    await stopCaptureFor(ctx, noteId)
    await storage.trashNote(noteId)
    // No telemetry: the `document_deleted` event is a local debug line.
    log('debug', 'notes:trashed', { id: noteId })
  })

  ipcMain.handle(
    'notes:restore' satisfies InvokeChannel,
    (_e, req: unknown): Promise<InvokeRes<'notes:restore'>> => storage.restoreNote(id(object(req, 'request')['id']))
  )

  // ---------- trash ----------

  ipcMain.handle('notes:list-trash' satisfies InvokeChannel, (): Promise<InvokeRes<'notes:list-trash'>> => storage.listTrash())

  // Only the confirmation dialog sends `confirmed: true`; storage rejects a note not in Trash.
  ipcMain.handle(
    'notes:delete-permanently' satisfies InvokeChannel,
    async (_e, req: unknown): Promise<InvokeRes<'notes:delete-permanently'>> => {
      const r = deletePermanentlyRequest(req)
      await stopCaptureFor(ctx, r.id)
      const { roomsDeleted } = await storage.deleteNotePermanently(r.id)
      log('info', 'notes:deleted-permanently', { id: r.id, roomsDeleted })
    }
  )

  ipcMain.handle(
    'notes:auto-delete-if-empty' satisfies InvokeChannel,
    (_e, req: unknown): Promise<InvokeRes<'notes:auto-delete-if-empty'>> => autoDeleteIfEmpty(ctx, autoDeleteRequest(req))
  )

  ipcMain.handle(
    'notes:find-by-event' satisfies InvokeChannel,
    (_e, req: unknown): Promise<InvokeRes<'notes:find-by-event'>> => {
      const r = findByEvent(req)
      return storage.findNoteByEvent(r.eventId, r.startTime)
    }
  )

  // ---------- ydoc ----------

  ipcMain.handle(
    'ydoc:load' satisfies InvokeChannel,
    (_e, req: unknown): Promise<InvokeRes<'ydoc:load'>> => storage.loadYdoc(roomId(object(req, 'request')['roomId']))
  )

  // The appending renderer already has its update; every other renderer gets it.
  ipcMain.handle(
    'ydoc:append' satisfies InvokeChannel,
    async (e, req: unknown): Promise<InvokeRes<'ydoc:append'>> => {
      const r = ydocAppend(req)
      const res = await storage.appendYdoc(r.roomId, r.update, r.origin)
      const payload: YdocUpdated = { roomId: r.roomId, update: r.update, seq: res.seq, origin: r.origin }
      for (const wc of windows.targets()) {
        if (wc.id !== e.sender.id) wc.send('ydoc:updated' satisfies PushChannel, payload)
      }
      return res
    }
  )

  // ---------- panels ----------

  ipcMain.handle('panels:list' satisfies InvokeChannel, (_e, req: unknown): Promise<InvokeRes<'panels:list'>> => {
    const r = object(req, 'request')
    const includeDeleted = r['includeDeleted'] === true
    return storage.listPanels(id(r['noteId'], 'noteId'), { includeDeleted })
  })

  ipcMain.handle(
    'panels:update' satisfies InvokeChannel,
    (_e, req: unknown): Promise<InvokeRes<'panels:update'>> => {
      const r = object(req, 'request')
      const panelId = id(r['id'])
      const { patch, dropped } = panelPatch(r['patch'])
      if (dropped.length) log('warn', 'panels:patch-keys-dropped', { id: panelId, dropped })
      return storage.updatePanel(panelId, patch)
    }
  )

  // ---------- prefs ----------

  ipcMain.handle('prefs:get' satisfies InvokeChannel, (): Promise<InvokeRes<'prefs:get'>> => settings.getAll())

  ipcMain.on('prefs:set' satisfies SendChannel, (_e, patch: unknown) => {
    applyRendererPatch(settings, patch).catch((err: unknown) => log('error', 'prefs:set-failed', { err }))
  })
}
