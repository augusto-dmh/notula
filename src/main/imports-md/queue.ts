// SPDX-License-Identifier: Apache-2.0
// The Markdown import run, shaped like the recording import queue: a persisted batch,
// a pump that does one item at a time, a push to every window on each change, and a restore
// once storage is ready.
//
// - Per item: read the files again and re-hash; a changed file is skipped ("Changed after the
//   preview…"), a vanished one fails; otherwise one `importNoteItem` call writes the note, its
//   panels, transcript, folder memberships and the item's `done` state in one transaction.
// - Folders are created before the first item that needs them and recorded on the batch, so
//   undo can remove them. A folder with the same title under the same parent is reused.
// - Cancel stops between items; the rest are skipped and the batch is `cancelled`.
// - Restart: a `queued` or `running` batch left by a quit or crash resumes once (a marker in
//   `error`; storage has no `running → queued` move), its files hashed again per item; a second
//   interruption fails its planned items with "Import interrupted…" and the batch. Without this,
//   storage would refuse every new import while the stale batch stays open.
// - No AI runs and nothing goes to the network. Logs carry ids, states and counts only.

import type { PushChannel } from '@shared/ipc'
import { parseError } from '@shared/errors'
import {
  IMPORT_LIMITS,
  IMPORT_SESSION,
  type ImportBatch,
  type ImportItem,
  type ImportProgress
} from '@shared/types/imports-markdown'
import type { CreationSource } from '@shared/types/notes'
import type { MainContext } from '../context'
import { log } from '../log'
import type { ImportNotePayload } from '../storage/api'
import { builtinTemplates } from '../templates/catalog'
import { localeDayFirst } from './dates'
import { notesText, parseExportIndex, type ParseContext, type SourceFile } from './formats'
import { findFolder, parseSpec, specFiles, type FolderLookup, type ItemSpec } from './plan'
import { itemHash, readOne } from './scan'

export const RUN_COPY = {
  changed: 'Changed after the preview. Preview again to import it.',
  vanished: 'The file was moved or deleted',
  interrupted: 'Import interrupted. Import the folder again to continue.',
  cancelled: 'Import cancelled.',
  failed: 'Notula couldn’t import this note.',
  disk: 'Not enough disk space to continue.'
} as const

/** An internal marker in `error` while a batch runs again after a restart (never shown). */
const REQUEUED = '__requeued__'
const MAX_NOTES_CHARS = 4 * 1024 * 1024
const MAX_CHUNK_CHARS = 100_000

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

/** The batch as the renderer sees it: no internal markers. */
export function publicBatch(b: ImportBatch): ImportBatch {
  return b.error?.startsWith(REQUEUED) ? { ...b, error: null } : b
}

/** The panel titles that mark a summary section in a Notula export. */
export async function panelTitles(ctx: MainContext): Promise<Set<string>> {
  const titles = new Set<string>(['summary'])
  for (const t of builtinTemplates()) titles.add(t.title.trim().toLowerCase())
  try {
    for (const t of await ctx.storage.listTemplates()) if (!t.deleted_at) titles.add(t.title.trim().toLowerCase())
  } catch {
    // Built-ins are enough to go on.
  }
  return titles
}

function isSpec(v: unknown): v is ItemSpec {
  if (!v || typeof v !== 'object') return false
  const s = v as ItemSpec
  return typeof s.format === 'string' && !!s.files && typeof s.files === 'object'
}

function isPaths(v: unknown): v is string[][] {
  return Array.isArray(v) && v.every((p) => Array.isArray(p) && p.length <= 2 && p.every((t) => typeof t === 'string' && t.trim() !== ''))
}

export class MarkdownImportQueue {
  private readonly ctx: MainContext
  private pumping = false
  private restored = false
  private readonly cancelRequested = new Set<string>()
  quitting = false

  constructor(ctx: MainContext) {
    this.ctx = ctx
  }

  private pushBatch(b: ImportBatch, report?: ImportProgress['report']): void {
    const out = publicBatch(b)
    const progress: ImportProgress = {
      batchId: b.id,
      state: b.state,
      counts: { ...b.counts, total: b.counts.planned + b.counts.done + b.counts.skipped + b.counts.failed },
      ...(report ? { report } : {})
    }
    for (const wc of this.ctx.windows.targets()) {
      if (this.ctx.windows.kindOf(wc) !== 'main') continue
      wc.send('notes-import:changed' satisfies PushChannel, out)
      wc.send('notes-import:progress' satisfies PushChannel, progress)
    }
  }

  /** Pushes the batch's current row (after any change made elsewhere, such as undo). */
  async refresh(batchId: string): Promise<void> {
    const b = await this.ctx.storage.getImportBatch(batchId)
    if (b) this.pushBatch(b)
  }

  cancel(batchId: string): void {
    this.cancelRequested.add(batchId)
  }

  /** At startup: an open batch resumes once; a second interruption fails what's left. */
  async restore(): Promise<void> {
    if (this.restored) return
    this.restored = true
    for (const b of await this.ctx.storage.listImportBatches()) {
      if (b.state !== 'running' && b.state !== 'queued') continue
      // A batch that never started has nothing to recover: it simply runs.
      if (b.state === 'queued' && b.error !== REQUEUED) continue
      if (b.error === REQUEUED) {
        for (const it of await this.ctx.storage.listImportItems(b.id, { states: ['planned'] })) {
          await this.ctx.storage.updateImportItem(it.id, { state: 'failed', reason: RUN_COPY.interrupted })
        }
        const done = await this.ctx.storage.updateImportBatch(b.id, { state: 'failed', error: null, finished_at: new Date().toISOString() })
        this.pushBatch(done)
        log('info', 'notes-import:interrupted', { batchId: b.id })
        continue
      }
      this.pushBatch(await this.ctx.storage.updateImportBatch(b.id, { error: REQUEUED }))
      log('info', 'notes-import:resumed', { batchId: b.id, from: b.state })
    }
    void this.pump()
  }

  async pump(): Promise<void> {
    if (this.pumping) return
    this.pumping = true
    try {
      for (;;) {
        if (this.quitting) return
        // The oldest open batch; a resumed one is still `running`.
        const next = (await this.ctx.storage.listImportBatches()).filter((b) => b.state === 'queued' || b.state === 'running').pop()
        if (!next) return
        await this.run(next)
      }
    } catch (err) {
      log('error', 'notes-import:pump-failed', { code: parseError(err).code })
    } finally {
      this.pumping = false
    }
  }

  private async run(batch: ImportBatch): Promise<void> {
    const s = this.ctx.storage
    let current = await s.updateImportBatch(batch.id, { state: 'running' })
    this.pushBatch(current)
    log('info', 'notes-import:run-start', { batchId: batch.id, planned: current.counts.planned })
    const items = await s.listImportItems(batch.id, { states: ['planned'] })
    const base: ParseContext = { dayFirst: localeDayFirst(), panelTitles: await panelTitles(this.ctx), exportSummaries: null }
    const indexes = new Map<string, Map<string, boolean> | null>()
    const lookup: FolderLookup = { folders: (await s.listFolders()).folders.map((f) => ({ id: f.id, title: f.title, parent_id: f.parent_id })) }
    const created = [...current.created_folder_ids]
    const createdVia = creationSource()
    let stoppedBy: string | null = null

    const ensureFolder = async (path: string[]): Promise<string> => {
      let parent: string | null = null
      for (const title of path) {
        const found = findFolder(lookup, title, parent)
        if (found) {
          parent = found.id
          continue
        }
        const folder = await s.createFolder({ title: title.trim().slice(0, 200), parentId: parent })
        lookup.folders.push({ id: folder.id, title: folder.title, parent_id: folder.parent_id })
        created.push(folder.id)
        current = await s.updateImportBatch(batch.id, { created_folder_ids: created })
        parent = folder.id
      }
      return parent!
    }

    const indexFor = async (exportRoot: string): Promise<Map<string, boolean> | null> => {
      if (!indexes.has(exportRoot)) {
        const f = await readOne(batch.root_path, exportRoot ? `${exportRoot}/index.csv` : 'index.csv')
        indexes.set(exportRoot, typeof f === 'string' ? null : parseExportIndex(f.text))
      }
      return indexes.get(exportRoot) ?? null
    }

    for (const item of items) {
      if (this.quitting) return
      if (this.cancelRequested.has(batch.id)) break
      try {
        await this.importOne(batch, item, { base, indexFor, ensureFolder, createdVia })
      } catch (err) {
        const e = parseError(err)
        const disk = /SQLITE_FULL|disk is full|ENOSPC/i.test(e.message)
        await s.updateImportItem(item.id, { state: 'failed', reason: disk ? RUN_COPY.disk : e.message.slice(0, 500) || RUN_COPY.failed }).catch(() => undefined)
        log('warn', 'notes-import:item-failed', { batchId: batch.id, itemId: item.id, code: e.code })
        if (disk) {
          stoppedBy = RUN_COPY.disk
          break
        }
      }
      const b = await s.getImportBatch(batch.id)
      if (b) {
        current = b
        this.pushBatch(b)
      }
      // Yield, so a large batch never freezes the main process.
      await new Promise<void>((r) => setImmediate(r))
    }

    const cancelled = this.cancelRequested.delete(batch.id)
    if (cancelled || stoppedBy) {
      for (const it of await s.listImportItems(batch.id, { states: ['planned'] })) {
        await s.updateImportItem(it.id, { state: cancelled ? 'skipped' : 'failed', reason: cancelled ? RUN_COPY.cancelled : stoppedBy })
      }
    }
    const after = (await s.getImportBatch(batch.id)) ?? current
    const state = cancelled ? 'cancelled' : stoppedBy || (after.counts.done === 0 && after.counts.failed > 0) ? 'failed' : 'complete'
    const done = await s.updateImportBatch(batch.id, { state, error: stoppedBy, finished_at: new Date().toISOString() })
    this.pushBatch(done, await this.report(batch.id))
    log('info', 'notes-import:run-done', { batchId: batch.id, state, ...done.counts })
  }

  /** The done screen's lists, from the stored items. */
  private async report(batchId: string): Promise<ImportProgress['report']> {
    const items = await this.ctx.storage.listImportItems(batchId)
    const noteIds: string[] = []
    const needSummary: string[] = []
    const issues: NonNullable<ImportProgress['report']>['issues'] = []
    for (const it of items) {
      if (it.state === 'done' && it.note_id) {
        noteIds.push(it.note_id)
        const c = it.meta['contents'] as { summaries?: unknown; transcript?: unknown } | undefined
        if (c && c.transcript && c.summaries === 0) needSummary.push(it.note_id)
      } else if ((it.state === 'skipped' || it.state === 'failed') && issues.length < 500) {
        issues.push({ relPath: it.rel_path, state: it.state, reason: it.reason ?? RUN_COPY.failed })
      }
    }
    return { noteIds, needSummary, issues }
  }

  private async importOne(
    batch: ImportBatch,
    item: ImportItem,
    env: {
      base: ParseContext
      indexFor(root: string): Promise<Map<string, boolean> | null>
      ensureFolder(path: string[]): Promise<string>
      createdVia: CreationSource
    }
  ): Promise<void> {
    const s = this.ctx.storage
    const spec = item.meta['spec']
    if (!isSpec(spec)) {
      await s.updateImportItem(item.id, { state: 'failed', reason: RUN_COPY.failed })
      return
    }
    // Read the files again and re-hash.
    const files: Record<string, SourceFile | null> = {}
    const read: { rel: string; sha256: string }[] = []
    for (const rel of specFiles(spec)) {
      const f = await readOne(batch.root_path, rel)
      if (f === 'vanished') {
        await s.updateImportItem(item.id, { state: 'failed', reason: RUN_COPY.vanished })
        return
      }
      if (typeof f === 'string') {
        await s.updateImportItem(item.id, { state: 'skipped', reason: RUN_COPY.changed })
        return
      }
      files[rel] = f
      read.push(f)
    }
    if (itemHash(read) !== item.content_hash) {
      await s.updateImportItem(item.id, { state: 'skipped', reason: RUN_COPY.changed })
      return
    }

    const ctx: ParseContext =
      spec.format === 'notula-export' && typeof spec.exportRoot === 'string' ? { ...env.base, exportSummaries: await env.indexFor(spec.exportRoot) } : env.base
    const p = parseSpec(spec, files, ctx)
    const folderIds: string[] = []
    const paths = item.meta['paths']
    if (isPaths(paths)) for (const path of paths) if (path.length) folderIds.push(await env.ensureFolder(path))

    const anchor = p.createdAt.getTime()
    const turns = p.transcript?.turns ?? []
    const payload: ImportNotePayload = {
      itemId: item.id,
      note: {
        id: p.exportId,
        title: p.title || null,
        created_at: p.createdAt.toISOString(),
        updated_at: (p.updatedAt.getTime() < anchor ? p.createdAt : p.updatedAt).toISOString(),
        created_via: env.createdVia,
        notes_md: p.notesMd.slice(0, MAX_NOTES_CHARS),
        notes_text: notesText(p).slice(0, MAX_NOTES_CHARS),
        people: p.attendees.length ? { attendees: p.attendees } : null,
        tags: p.tags,
        trashed: p.trashed && batch.options.trash === 'import-into-trash'
      },
      panels: p.panels.slice(0, 20).map((panel) => ({ title: panel.title.slice(0, 300), template_key: null, content_markdown: panel.markdown.slice(0, MAX_NOTES_CHARS) })),
      transcript:
        p.transcript && turns.length
          ? {
              session: {
                provider: IMPORT_SESSION.provider,
                model: p.transcript.kind === 'timed' ? IMPORT_SESSION.timed : IMPORT_SESSION.untimed,
                language: p.transcript.language,
                started_at: p.createdAt.toISOString(),
                ended_at: new Date(anchor + turns[turns.length - 1]!.endMs).toISOString(),
                end_reason: IMPORT_SESSION.endReason
              },
              chunks: turns.slice(0, IMPORT_LIMITS.chunksPerNote).map((t) => ({
                source: t.source,
                start_timestamp: new Date(anchor + t.startMs).toISOString(),
                end_timestamp: new Date(anchor + t.endMs).toISOString(),
                text: t.text.slice(0, MAX_CHUNK_CHARS),
                detected_speaker_name: t.speaker
              }))
            }
          : null,
      folderIds: [...new Set(folderIds)]
    }
    const { noteId } = await s.importNoteItem(payload)
    log('info', 'notes-import:note-created', { batchId: batch.id, itemId: item.id, noteId, panels: payload.panels.length, chunks: turns.length })
  }
}
