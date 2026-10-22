// SPDX-License-Identifier: Apache-2.0
// registerMarkdownImports(): Import notes from Markdown files and vaults.
// Owns the `notes-import:*` IPC and pushes, main's folder and file pickers, the read-only scan
// and in-memory preview, and the persisted import queue. Not behind Labs; only Find sources
// needs `sources.enabled`.
//
// - Paths come in only as handles main handed out from its own pickers; bytes never cross IPC.
// - The preview lives in memory for 30 minutes or until the next scan. Changing an option
//   recomputes it without reading the files again.
// - `notes-import:start` persists the batch and its ticked items in one storage call; the queue
//   then writes one note per item in one transaction. One batch at a time.
// - Undo trashes the chosen notes through the normal trash path, then deletes the folders the
//   batch created that are empty.
// - Nothing goes to the network and no AI runs. Logs carry ids, states and counts only, never
//   titles, paths, URLs or content.
// Handlers and pushes write their channel literal.

import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { notulaError, parseError } from '@shared/errors'
import type { InvokeChannel, InvokeRes, PushChannel } from '@shared/ipc'
import {
  IMPORT_LIMITS,
  type ImportCandidates,
  type ImportFolderMode,
  type ImportOptions,
  type ImportPreset,
  type ImportPreview,
  type ImportScanProgress
} from '@shared/types/imports-markdown'
import type { MainContext } from '../context'
import { expected } from '../ipc-expected'
import { log } from '../log'
import { openSettingsSection } from '../lifecycle'
import { stopCaptureFor } from '../notes/trash'
import { catalogFileHandle } from '../sources/series'
import { localeDayFirst } from './dates'
import { computeRows, formItems, localDateKey, sourceKey, summarize, type FolderLookup, type Formed, type Row, type StatusEnv } from './plan'
import { MarkdownImportQueue, panelTitles, publicBatch } from './queue'
import { scanFolder, ScanError, SCAN_COPY } from './scan'

const NOT_AVAILABLE = 'Not available while Notula is recovering your data.'
const PRESETS: readonly ImportPreset[] = ['auto', 'plain', 'obsidian', 'notula-export', 'study-vault']
const FOLDER_MODES: readonly ImportFolderMode[] = ['mirror', 'single', 'none']
const MAX_PICKED = 5_000

interface Handle {
  root: string
  /** Picked files, relative to `root`. */
  only?: string[]
  /** The single-folder mode's name. */
  label: string
}

interface Preview {
  id: string
  handle: Handle
  preset: ImportPreset
  options: ImportOptions
  formed: Formed
  env: StatusEnv
  rows: Row[]
  expiresAt: number
}

interface Scan {
  previewId: string
  abort: AbortController
}

let promptHook: (() => Promise<void>) | null = null

/**
 * The File menu's "Import notes…": main's folder picker with the `auto` preset, then the scan.
 * Settings opens first, so its Import notes card shows the preview when the scan ends.
 */
export function promptImportNotes(): Promise<void> {
  return promptHook ? promptHook() : Promise.resolve()
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function object(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw expected(notulaError('invalid-input', 'request must be an object'))
  return v as Record<string, unknown>
}

function str(v: unknown, what: string): string {
  if (typeof v !== 'string' || !v || v.length > 200) throw expected(notulaError('invalid-input', `${what} is required`))
  return v
}

function parseOptions(v: unknown): ImportOptions {
  const o = object(v)
  if (!FOLDER_MODES.includes(o['folderMode'] as ImportFolderMode)) throw expected(notulaError('invalid-input', 'unknown folder mode'))
  if (o['trash'] !== 'skip' && o['trash'] !== 'import-into-trash') throw expected(notulaError('invalid-input', 'unknown Trash option'))
  if (typeof o['findSourcesAfter'] !== 'boolean' || typeof o['includeOtherFiles'] !== 'boolean') {
    throw expected(notulaError('invalid-input', 'malformed import options'))
  }
  return {
    folderMode: o['folderMode'] as ImportFolderMode,
    trash: o['trash'],
    findSourcesAfter: o['findSourcesAfter'],
    includeOtherFiles: o['includeOtherFiles']
  }
}

function idList(v: unknown, what: string, max: number): string[] {
  if (!Array.isArray(v) || v.length > max || v.some((x) => typeof x !== 'string' || !x || x.length > 100)) {
    throw expected(notulaError('invalid-input', `${what} must be a list of ids`))
  }
  return [...new Set(v as string[])]
}

export function registerMarkdownImports(ctx: MainContext): void {
  const queue = new MarkdownImportQueue(ctx)
  const handles = new Map<string, Handle>()
  let preview: Preview | null = null
  let scan: Scan | null = null

  const pushScan = (p: ImportScanProgress): void => {
    for (const wc of ctx.windows.targets()) if (ctx.windows.kindOf(wc) === 'main') wc.send('notes-import:scan-progress' satisfies PushChannel, p)
  }

  const ready = async (): Promise<void> => {
    const status = await ctx.storage.status()
    if (status.state !== 'ready') throw expected(notulaError('invalid-input', NOT_AVAILABLE))
  }

  const live = (previewId: unknown): Preview => {
    const id = str(previewId, 'previewId')
    if (!preview || preview.id !== id || preview.expiresAt < Date.now()) {
      if (preview && preview.expiresAt < Date.now()) preview = null
      throw expected(notulaError('not-found', 'This preview expired. Choose the folder again.'))
    }
    return preview
  }

  const toPreview = (p: Preview): ImportPreview => ({
    previewId: p.id,
    preset: p.preset,
    options: p.options,
    rows: p.rows.map(({ paths: _paths, sourceKey: _key, ...row }) => row),
    summary: summarize(p.rows, p.env.lookup),
    expiresAt: new Date(p.expiresAt).toISOString(),
    // The series catalog import reads the outline itself, from a handle for the file main found.
    ...(p.formed.catalogs.length
      ? { catalogs: p.formed.catalogs.map((c) => ({ course: c.course, relPath: c.relPath, handle: catalogFileHandle(join(p.handle.root, ...c.relPath.split('/'))) })) }
      : {})
  })

  const window = (): BrowserWindow | null => ctx.windows.main() ?? BrowserWindow.getFocusedWindow()

  const chooseFolder = async (): Promise<InvokeRes<'notes-import:choose-folder'>> => {
    // Dev builds only: NOTULA_DEV_IMPORT_DIR answers the picker, for scripted checks.
    const devDir = ctx.isDev ? process.env['NOTULA_DEV_IMPORT_DIR'] : undefined
    const opts: Electron.OpenDialogOptions = { title: 'Import notes', buttonLabel: 'Choose folder', properties: ['openDirectory'] }
    const win = window()
    const res = devDir ? { canceled: false, filePaths: [devDir] } : win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    const path = res.filePaths[0]
    if (res.canceled || !path) return { cancelled: true }
    const root = resolve(path)
    const handle = randomUUID()
    handles.set(handle, { root, label: basename(root) || 'Imported notes' })
    return { handle }
  }

  const chooseFiles = async (): Promise<InvokeRes<'notes-import:choose-files'>> => {
    const opts: Electron.OpenDialogOptions = {
      title: 'Import notes',
      buttonLabel: 'Choose files',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Markdown', extensions: ['md', 'markdown', 'txt'] }]
    }
    const win = window()
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (res.canceled || !res.filePaths.length) return { cancelled: true }
    const paths = res.filePaths.slice(0, MAX_PICKED).map((p) => resolve(p))
    // The common parent is the import root.
    let root = dirname(paths[0]!)
    for (const p of paths) {
      while (relative(root, p).startsWith('..') || isAbsolute(relative(root, p))) {
        const up = dirname(root)
        if (up === root) break
        root = up
      }
    }
    const only = paths.map((p) => relative(root, p).split(sep).join('/'))
    const now = new Date()
    const handle = randomUUID()
    handles.set(handle, { root, only, label: `Imported ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` })
    return { handle }
  }

  /** Reads the settings-derived parts of a preview's status environment. */
  const statusEnv = async (h: Handle, formed: Formed): Promise<StatusEnv> => {
    const keys = new Set<string>()
    const hashes = new Set<string>()
    const exportIds = new Set<string>()
    for (const it of formed.items) {
      if (!it.spec) continue
      keys.add(sourceKey(h.root, it.relPath))
      if (it.hash) hashes.add(it.hash)
      if (it.info?.exportId) exportIds.add(it.info.exportId)
    }
    const matches = await ctx.storage.findImportMatches({ sourceKeys: [...keys], hashes: [...hashes], exportIds: [...exportIds] })
    const folders = (await ctx.storage.listFolders()).folders
    const lookup: FolderLookup = { folders: folders.map((f) => ({ id: f.id, title: f.title, parent_id: f.parent_id })) }
    const titleDates = new Set<string>()
    for (const n of (await ctx.storage.listNotes({ scope: 'own' })).items) {
      if (n.title) titleDates.add(`${n.title.trim().toLowerCase()}|${localDateKey(n.created_at)}`)
    }
    // The Videos folder: `sources.videosFolder` when it exists, else a top-level "Videos".
    let videos = ['Videos']
    const vid = (await ctx.settings.getAll())['sources.videosFolder']
    const vf = vid ? folders.find((f) => f.id === vid) : undefined
    if (vf) {
      const parent = vf.parent_id ? folders.find((f) => f.id === vf.parent_id) : undefined
      videos = parent ? [parent.title, vf.title] : [vf.title]
    }
    return { root: h.root, matches, lookup, titleDates, labels: { single: h.label, videos } }
  }

  const runScan = async (previewId: string, h: Handle, preset: ImportPreset, abort: AbortController): Promise<void> => {
    let last = 0
    try {
      const result = await scanFolder(h.root, {
        ...(h.only ? { only: h.only } : {}),
        signal: abort.signal,
        onProgress: (read, total) => {
          const now = Date.now()
          if (now - last < 150 && read !== total) return
          last = now
          pushScan({ previewId, state: 'scanning', read, total, reason: null })
        }
      })
      if (abort.signal.aborted) return
      const settings = await ctx.settings.getAll()
      const formed = formItems(result, preset, { dayFirst: localeDayFirst(), panelTitles: await panelTitles(ctx) })
      const env = await statusEnv(h, formed)
      if (abort.signal.aborted) return
      const options: ImportOptions = {
        folderMode: settings['notesImport.folderMode'],
        trash: 'skip',
        findSourcesAfter: settings['notesImport.findSourcesAfter'],
        includeOtherFiles: false
      }
      preview = { id: previewId, handle: h, preset, options, formed, env, rows: computeRows(formed, options, env), expiresAt: Date.now() + IMPORT_LIMITS.previewTtlMs }
      const total = result.files.length
      pushScan({ previewId, state: 'previewed', read: total, total, reason: null })
      log('info', 'notes-import:scanned', { preset, files: total, items: formed.items.length, studyVault: formed.studyVault, catalogs: formed.catalogs.length })
    } catch (err) {
      if (abort.signal.aborted) return
      const reason = err instanceof ScanError ? err.message : SCAN_COPY.unreadable
      if (!(err instanceof ScanError)) log('error', 'notes-import:scan-failed', { code: parseError(err).code })
      pushScan({ previewId, state: 'failed', read: 0, total: 0, reason })
    } finally {
      if (scan?.previewId === previewId) scan = null
    }
  }

  const startScan = async (handleId: string, preset: ImportPreset): Promise<string> => {
    await ready()
    const h = handles.get(handleId)
    if (!h) throw expected(notulaError('invalid-input', 'Choose the folder with Choose folder… first.'))
    try {
      if (!(await stat(h.root)).isDirectory()) throw new Error('not a folder')
    } catch {
      throw expected(notulaError('invalid-input', SCAN_COPY.unreadable))
    }
    scan?.abort.abort()
    preview = null
    const previewId = randomUUID()
    const abort = new AbortController()
    scan = { previewId, abort }
    pushScan({ previewId, state: 'scanning', read: 0, total: 0, reason: null })
    void runScan(previewId, h, preset, abort)
    return previewId
  }

  ipcMain.handle('notes-import:choose-folder' satisfies InvokeChannel, (): Promise<InvokeRes<'notes-import:choose-folder'>> => chooseFolder())
  ipcMain.handle('notes-import:choose-files' satisfies InvokeChannel, (): Promise<InvokeRes<'notes-import:choose-files'>> => chooseFiles())

  ipcMain.handle('notes-import:scan' satisfies InvokeChannel, async (_e, req: unknown): Promise<InvokeRes<'notes-import:scan'>> => {
    const r = object(req)
    const preset = r['preset'] as ImportPreset
    if (!PRESETS.includes(preset)) throw expected(notulaError('invalid-input', 'unknown preset'))
    return { previewId: await startScan(str(r['handle'], 'handle'), preset) }
  })

  ipcMain.handle('notes-import:get-preview' satisfies InvokeChannel, (_e, req: unknown): InvokeRes<'notes-import:get-preview'> => {
    const id = str(object(req)['previewId'], 'previewId')
    if (!preview || preview.id !== id) return null
    if (preview.expiresAt < Date.now()) {
      preview = null
      return null
    }
    return toPreview(preview)
  })

  ipcMain.handle('notes-import:set-options' satisfies InvokeChannel, async (_e, req: unknown): Promise<InvokeRes<'notes-import:set-options'>> => {
    const r = object(req)
    const p = live(r['previewId'])
    const options = parseOptions(r['options'])
    p.options = options
    p.rows = computeRows(p.formed, options, p.env)
    // The last choices are remembered.
    await ctx.settings.set('notesImport.folderMode', options.folderMode).catch(() => undefined)
    await ctx.settings.set('notesImport.findSourcesAfter', options.findSourcesAfter).catch(() => undefined)
    return toPreview(p)
  })

  ipcMain.handle('notes-import:start' satisfies InvokeChannel, async (_e, req: unknown): Promise<InvokeRes<'notes-import:start'>> => {
    await ready()
    const r = object(req)
    const p = live(r['previewId'])
    const options = parseOptions(r['options'])
    const wanted = new Set(idList(r['itemIds'], 'itemIds', IMPORT_LIMITS.entries + 1_000))
    // Statuses as of now, not as of the preview: a batch that finished since made its notes
    // "already imported".
    p.options = options
    p.env = await statusEnv(p.handle, p.formed)
    p.rows = computeRows(p.formed, options, p.env)
    const byId = new Map(p.formed.items.map((it) => [it.id, it]))
    const chosen = p.rows.filter((row) => wanted.has(row.itemId) && row.tickable)
    if (!chosen.length) throw expected(notulaError('invalid-input', 'Tick at least one note to import.'))
    if (chosen.length > IMPORT_LIMITS.itemsPerBatch) {
      throw expected(notulaError('invalid-input', `Import at most ${IMPORT_LIMITS.itemsPerBatch.toLocaleString('en-US')} notes at a time.`))
    }
    const items = chosen.map((row) => {
      const it = byId.get(row.itemId)!
      return {
        id: it.id,
        source_key: row.sourceKey,
        rel_path: it.relPath,
        format: it.spec!.format,
        content_hash: it.hash,
        size_bytes: it.size,
        export_note_id: it.info?.exportId ?? null,
        candidates: it.info?.candidates ?? [],
        meta: { ...(it.info?.meta ?? {}), spec: it.spec, paths: row.paths, contents: row.contents, warnings: row.warnings.slice(0, 20) },
        imported_title: it.info?.title ?? null
      }
    })
    let batchId: string
    try {
      const res = await ctx.storage.createImportBatch({ root_path: p.handle.root, preset: p.preset, options, items })
      batchId = res.batch.id
      await queue.refresh(batchId)
    } catch (err) {
      const e = parseError(err)
      if (e.code === 'invalid-input') throw expected(notulaError('invalid-input', e.message))
      throw err
    }
    log('info', 'notes-import:started', { batchId, items: items.length, folderMode: options.folderMode })
    // A new import shows the new state; the preview is spent.
    preview = null
    void queue.pump()
    return { batchId }
  })

  ipcMain.handle('notes-import:cancel' satisfies InvokeChannel, async (_e, req: unknown): Promise<InvokeRes<'notes-import:cancel'>> => {
    const r = object(req)
    if (typeof r['batchId'] === 'string') {
      queue.cancel(str(r['batchId'], 'batchId'))
      return
    }
    const id = str(r['previewId'], 'previewId')
    if (scan?.previewId === id) {
      scan.abort.abort()
      scan = null
      pushScan({ previewId: id, state: 'cancelled', read: 0, total: 0, reason: null })
    }
    if (preview?.id === id) preview = null
  })

  ipcMain.handle('notes-import:list-batches' satisfies InvokeChannel, async (): Promise<InvokeRes<'notes-import:list-batches'>> =>
    (await ctx.storage.listImportBatches()).map(publicBatch)
  )

  ipcMain.handle('notes-import:undo-preview' satisfies InvokeChannel, (_e, req: unknown): Promise<InvokeRes<'notes-import:undo-preview'>> =>
    ctx.storage.importUndoPreview(str(object(req)['batchId'], 'batchId'))
  )

  ipcMain.handle('notes-import:undo' satisfies InvokeChannel, async (_e, req: unknown): Promise<InvokeRes<'notes-import:undo'>> => {
    const r = object(req)
    if (r['confirmed'] !== true) throw expected(notulaError('invalid-input', 'The confirmation is required.'))
    const batchId = str(r['batchId'], 'batchId')
    const noteIds = idList(r['noteIds'], 'noteIds', IMPORT_LIMITS.itemsPerBatch)
    const batch = await ctx.storage.getImportBatch(batchId)
    if (!batch) throw expected(notulaError('not-found', 'This import is no longer in the history.'))
    if (batch.state === 'queued' || batch.state === 'running') throw expected(notulaError('invalid-input', 'Wait for the import to finish before undoing it.'))
    if (batch.state === 'undone') throw expected(notulaError('invalid-input', 'This import was already undone.'))
    // Only the batch's own live notes; through the normal trash path.
    const allowed = new Set((await ctx.storage.importUndoPreview(batchId)).notes.map((n) => n.noteId))
    let trashed = 0
    for (const id of noteIds) {
      if (!allowed.has(id)) continue
      await stopCaptureFor(ctx, id)
      await ctx.storage.trashNote(id)
      trashed++
    }
    const res = await ctx.storage.undoImportBatch(batchId)
    await queue.refresh(batchId)
    log('info', 'notes-import:undone', { batchId, trashed, foldersDeleted: res.foldersDeleted })
    return { trashed, foldersDeleted: res.foldersDeleted }
  })

  ipcMain.handle('notes-import:clear-history' satisfies InvokeChannel, async (_e, req: unknown): Promise<InvokeRes<'notes-import:clear-history'>> => {
    if (object(req)['confirmed'] !== true) throw expected(notulaError('invalid-input', 'The confirmation is required.'))
    await ctx.storage.clearImportHistory()
  })

  ipcMain.handle('notes-import:get-candidates' satisfies InvokeChannel, async (_e, req: unknown): Promise<InvokeRes<'notes-import:get-candidates'>> => {
    const ids = idList(object(req)['noteIds'], 'noteIds', IMPORT_LIMITS.itemsPerBatch)
    return (await ctx.storage.getImportCandidates(ids)).map(candidatesOf)
  })

  // The File menu's hook.
  promptHook = async () => {
    openSettingsSection('preferences', 'menu')
    const picked = await chooseFolder()
    if ('cancelled' in picked) return
    try {
      await startScan(picked.handle, 'auto')
    } catch (err) {
      log('warn', 'notes-import:menu-scan-refused', { code: parseError(err).code })
    }
  }

  // Unfinished batches from an earlier run, once storage is ready.
  const restore = (): void => {
    void queue.restore().catch((err: unknown) => log('error', 'notes-import:restore-failed', { code: parseError(err).code }))
  }
  ctx.bus.on('storage:status', (s) => {
    if (s.state === 'ready') restore()
  })
  void ctx.storage
    .status()
    .then((s) => {
      if (s.state === 'ready') restore()
    })
    .catch(() => undefined)
  app.on('before-quit', () => {
    queue.quitting = true
    scan?.abort.abort()
  })
}

/** A stored candidate row → what Find sources reads (hints and the last anchor live in `meta`). */
export function candidatesOf(row: { noteId: string; candidates: ImportCandidates['candidates']; meta: Record<string, unknown> }): ImportCandidates {
  const h = (row.meta['hints'] ?? {}) as Partial<ImportCandidates['hints']>
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  return {
    noteId: row.noteId,
    candidates: row.candidates,
    hints: { series: typeof h.series === 'string' ? h.series : null, lessonFromTitle: num(h.lessonFromTitle), lessonFromFolder: num(h.lessonFromFolder) },
    lastAnchorMs: num(row.meta['lastAnchorMs'])
  }
}
