// SPDX-License-Identifier: Apache-2.0
// Series, catalogs, lesson numbers and Merge, with catalog.ts, titles.ts and merge.ts.
//
// - Lesson numbers, at creation (`resolveLesson`, called by filing for course and playlist
//   series): the catalog by key or URL, then by normalized title (`numbered`, origin `catalog`;
//   it wins over the draft's own number). Without a catalog match, a draft numbered by its playlist
//   or the extension keeps its number; otherwise the title patterns give a `guessed` number, else
//   the lesson is `pending` (shown "—").
// - Import catalog: pasted text or a Markdown file (catalog.ts grammar, 2,000 items). The catalog
//   replaces the series' catalog in one transaction, then renumbers the series' lessons: `pending`
//   and `guessed` ones, and ones an earlier catalog numbered. Manual numbers are never touched, and
//   neither are playlist or extension numbers. `dryRun` counts without writing.
// - Delete catalog: the items go; lesson numbers stay as they are.
// - Update series: title, folder (never renamed, moved or deleted) and state.
// - Merge and its undo: merge.ts.
// While Sources is off (or off Windows) the reads answer empty and the writes reject.
// Logs: counts and ids, never titles or URLs.

import { ipcMain } from 'electron'
import { readFile, stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { notulaError } from '@shared/errors'
import type { InvokeChannel, InvokeRes } from '@shared/ipc'
import type { CatalogImportResult, CatalogInput, LessonOrigin, LessonState, SeriesState, SourceDraft } from '@shared/types/sources'
import { SOURCES_LIMITS } from '@shared/types/sources'
import type { MainContext } from '../context'
import { log } from '../log'
import { id, object } from '../notes/validate'
import type { SourceSeriesPatch } from '../storage/api'
import { draftLesson, parseCatalog, renumberRows } from './catalog'
import { mergeNotes, undoMerge } from './merge'
import { seriesIdRequest } from './validate'

export interface LessonResolution {
  number: number | null
  label: string | null
  state: LessonState
  origin: LessonOrigin | null
}

/** Pasted text or a file, in characters / bytes. */
const MAX_CATALOG_TEXT = 2 * 1024 * 1024
const MAX_SERIES_TITLE = 500
const SERIES_STATES: readonly SeriesState[] = ['active', 'paused']

const bad = (what: string): Error => notulaError('invalid-input', what)

/**
 * A new source note's lesson number in its series: the catalog by key or URL, then by normalized
 * title, then the title patterns (`guessed`), else `pending`. Null = keep the draft's own.
 */
export async function resolveLesson(ctx: MainContext, seriesId: string, draft: SourceDraft): Promise<LessonResolution | null> {
  return draftLesson(await ctx.storage.listCatalog(seriesId), draft)
}

// ---------- catalog files ----------

/** Handles to Markdown files main handed out (e.g. a study vault's course outline, by the importer). */
const catalogFiles = new Map<string, string>()

/** A handle `sources:import-catalog` accepts as `{kind: 'file', handle}` for this path. */
export function catalogFileHandle(path: string): string {
  for (const [h, p] of catalogFiles) if (p === path) return h
  const handle = randomUUID()
  catalogFiles.set(handle, path)
  return handle
}

async function catalogText(input: CatalogInput): Promise<string> {
  if (input.kind === 'text') return input.text
  const path = catalogFiles.get(input.handle)
  if (!path) throw bad('That file is no longer available. Choose it again.')
  const info = await stat(path).catch(() => null)
  if (!info?.isFile()) throw bad('That file is no longer available. Choose it again.')
  if (info.size > MAX_CATALOG_TEXT) throw bad('That file is too large for a catalog. Use a file under 2 MB.')
  return readFile(path, 'utf8')
}

// ---------- validation ----------

function catalogRequest(v: unknown): { seriesId: string; input: CatalogInput; dryRun: boolean } {
  const r = object(v, 'request')
  const seriesId = id(r['seriesId'], 'seriesId')
  const input = object(r['input'], 'input')
  let parsed: CatalogInput
  if (input['kind'] === 'text') {
    const text = input['text']
    if (typeof text !== 'string') throw bad('input.text must be a string')
    if (text.length > MAX_CATALOG_TEXT) throw bad('That catalog is too long. Paste up to 2,000 lessons.')
    parsed = { kind: 'text', text }
  } else if (input['kind'] === 'file') {
    const handle = input['handle']
    if (typeof handle !== 'string' || handle.length > 100) throw bad('input.handle is not valid')
    parsed = { kind: 'file', handle }
  } else {
    throw bad('input.kind is not valid')
  }
  const dryRun = r['dryRun']
  if (dryRun !== undefined && typeof dryRun !== 'boolean') throw bad('dryRun must be a boolean')
  return { seriesId, input: parsed, dryRun: dryRun === true }
}

function confirmedSeriesRequest(v: unknown): { seriesId: string } {
  const r = object(v, 'request')
  if (r['confirmed'] !== true) throw bad('confirmed must be true')
  return { seriesId: id(r['seriesId'], 'seriesId') }
}

function updateRequest(v: unknown): { seriesId: string; patch: SourceSeriesPatch } {
  const r = object(v, 'request')
  const seriesId = id(r['seriesId'], 'seriesId')
  const p = object(r['patch'], 'patch')
  const patch: SourceSeriesPatch = {}
  if (p['title'] !== undefined) {
    if (typeof p['title'] !== 'string') throw bad('title must be a string')
    const t = p['title'].replace(/\s+/g, ' ').trim()
    if (!t) throw bad('Enter a series name')
    if (t.length > MAX_SERIES_TITLE) throw bad('Use up to 500 characters for the series name')
    patch.title = t
  }
  if (p['folderId'] !== undefined) patch.folder_id = p['folderId'] === null ? null : id(p['folderId'], 'folderId')
  if (p['state'] !== undefined) {
    if (typeof p['state'] !== 'string' || !(SERIES_STATES as readonly string[]).includes(p['state'])) throw bad('state is not valid')
    patch.state = p['state'] as SeriesState
  }
  if (Object.keys(patch).length === 0) throw bad('Nothing to change')
  return { seriesId, patch }
}

function mergeRequest(v: unknown): { noteIds: [string, string] } {
  const r = object(v, 'request')
  if (r['confirmed'] !== true) throw bad('confirmed must be true')
  const ids = r['noteIds']
  if (!Array.isArray(ids) || ids.length !== 2) throw bad('noteIds must be two note ids')
  return { noteIds: [id(ids[0], 'noteIds'), id(ids[1], 'noteIds')] }
}

function mergeIdRequest(v: unknown): { mergeId: string } {
  return { mergeId: id(object(v, 'request')['mergeId'], 'mergeId') }
}

// ---------- import ----------

async function importCatalog(ctx: MainContext, raw: unknown): Promise<CatalogImportResult> {
  const { seriesId, input, dryRun } = catalogRequest(raw)
  const series = await ctx.storage.getSeries(seriesId)
  if (!series) throw notulaError('not-found', 'No such series')
  const parsed = parseCatalog(await catalogText(input))
  if (parsed.overLimit) throw bad(`A catalog can have up to ${SOURCES_LIMITS.catalogItems.toLocaleString('en-US')} lessons. Split the list and import the part you need.`)
  if (parsed.items.length === 0) throw bad('No lessons found. Put one lesson per line, with an optional number, duration and link.')
  const sources = await ctx.storage.listNoteSources({ seriesId })
  const rows = renumberRows(sources, parsed.items)
  let numbered = rows.unsettled.length + rows.fromCatalog.length
  if (!dryRun) {
    await ctx.storage.replaceCatalog(seriesId, parsed.items)
    numbered = 0
    if (rows.unsettled.length) numbered += await ctx.storage.applyLessonNumbers(rows.unsettled)
    if (rows.fromCatalog.length) numbered += await ctx.storage.applyLessonNumbers(rows.fromCatalog, { onlyUnsettled: false })
  }
  log('info', 'sources:catalog-imported', {
    dryRun,
    items: parsed.items.length,
    sections: parsed.sections,
    skipped: parsed.skippedLines,
    renumbered: parsed.renumbered,
    numbered
  })
  return { items: parsed.items.length, sections: parsed.sections, numbered, skippedLines: parsed.skippedLines, dryRun }
}

// ---------- IPC ----------

/**
 * `sources:list-series`, `sources:get-series`, `sources:update-series`, `sources:import-catalog`,
 * `sources:delete-catalog`, `sources:merge-notes`, `sources:merge-undo`.
 */
export function registerSeries(ctx: MainContext): void {
  const active = async (): Promise<boolean> => process.platform === 'win32' && (await ctx.settings.get('sources.enabled'))
  const requireActive = async (): Promise<void> => {
    if (!(await active())) throw bad('Sources is off')
  }

  ipcMain.handle('sources:list-series' satisfies InvokeChannel, async (): Promise<InvokeRes<'sources:list-series'>> => {
    if (!(await active())) return []
    return ctx.storage.listSeries()
  })

  ipcMain.handle('sources:get-series' satisfies InvokeChannel, async (_e, req: unknown): Promise<InvokeRes<'sources:get-series'>> => {
    const { seriesId } = seriesIdRequest(req)
    if (!(await active())) return null
    return ctx.storage.getSeriesDetail(seriesId)
  })

  ipcMain.handle('sources:update-series' satisfies InvokeChannel, async (_e, req: unknown): Promise<InvokeRes<'sources:update-series'>> => {
    await requireActive()
    const { seriesId, patch } = updateRequest(req)
    const series = await ctx.storage.updateSeries(seriesId, patch)
    log('info', 'sources:series-updated', { fields: Object.keys(patch).length, state: series.state })
    return series
  })

  ipcMain.handle('sources:import-catalog' satisfies InvokeChannel, async (_e, req: unknown): Promise<InvokeRes<'sources:import-catalog'>> => {
    await requireActive()
    return importCatalog(ctx, req)
  })

  ipcMain.handle('sources:delete-catalog' satisfies InvokeChannel, async (_e, req: unknown): Promise<InvokeRes<'sources:delete-catalog'>> => {
    await requireActive()
    const { seriesId } = confirmedSeriesRequest(req)
    const removed = await ctx.storage.deleteCatalog(seriesId)
    log('info', 'sources:catalog-deleted', { items: removed })
  })

  ipcMain.handle('sources:merge-notes' satisfies InvokeChannel, async (_e, req: unknown): Promise<InvokeRes<'sources:merge-notes'>> => {
    await requireActive()
    return mergeNotes(ctx, mergeRequest(req).noteIds)
  })

  ipcMain.handle('sources:merge-undo' satisfies InvokeChannel, async (_e, req: unknown): Promise<InvokeRes<'sources:merge-undo'>> => {
    await requireActive()
    await undoMerge(ctx, mergeIdRequest(req).mergeId)
  })
}
