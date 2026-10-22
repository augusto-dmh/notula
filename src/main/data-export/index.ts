// SPDX-License-Identifier: Apache-2.0
// registerDataExport(): the local data export (high risk: it writes user data outside the
// app): the folder picker, the confirmations and the batched storage writes; the `export:*` IPC.
//
// - Main shows the folder picker and remembers what it returned; `export:start` refuses any
//   other folder, a request without the plaintext confirmation (when notes, transcripts or
//   the index are chosen), a decrypted copy without its own acknowledgement, a storage in a
//   recovery state, and a second export while one runs.
// - Main creates `Notula export <YYYY-MM-DD HH.mm>` (` (2)`… on a clash) inside the chosen
//   folder and never writes elsewhere, overwrites or deletes; the storage worker writes only
//   inside that folder and checks it again (export-repo.ts).
// - Notes go 20 per storage call, so other storage calls interleave; Cancel is honoured
//   between calls, and the README then says the export is incomplete.
// - Export notes as Markdown (`format: 'markdown'`, content sources): `Notula Markdown export
//   <YYYY-MM-DD HH.mm>`, one `.md` per note in its Notula folders, transcripts beside the notes.
//   It needs notes chosen and the same plaintext confirmation; no database copies. Only while
//   Sources is on, on Windows.
// - Counts are logged; titles and content never are. Nothing reaches the network.
//
// Handlers and pushes write their channel literal.

import { randomUUID } from 'node:crypto'
import { mkdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { notulaError, parseError } from '@shared/errors'
import type { InvokeChannel, InvokeRes, PushChannel } from '@shared/ipc'
import {
  DATA_EXPORT,
  type DataExportDone,
  type DataExportFormat,
  type DataExportInclude,
  type DataExportProgress,
  type DataExportRequest
} from '@shared/types/data-export'
import type { MainContext } from '../context'
import { log } from '../log'

const LOCAL_STATE_FILE = 'Local State'
const NOT_AVAILABLE = 'Not available while Notula is recovering your data.'

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** `Notula export <YYYY-MM-DD HH.mm>` (`Notula Markdown export …`) in local time. */
function exportFolderName(format: DataExportFormat, at = new Date()): string {
  return `Notula ${format === 'markdown' ? 'Markdown export' : 'export'} ${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}.${pad(at.getMinutes())}`
}

/** Creates a new export folder inside `parent`, adding ` (2)`, ` (3)`… on a clash; never reuses one. */
async function createExportFolder(parent: string, format: DataExportFormat = 'standard'): Promise<string> {
  const base = exportFolderName(format)
  for (let n = 1; n <= 999; n++) {
    const dir = join(parent, n === 1 ? base : `${base} (${n})`)
    try {
      await mkdir(dir)
      return dir
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }
  }
  throw new Error('too many exports with the same name in this folder')
}

function isBool(v: unknown): v is boolean {
  return typeof v === 'boolean'
}

function parseRequest(p: unknown): DataExportRequest {
  const r = p as Partial<DataExportRequest> | null
  const inc = r?.include as Partial<DataExportInclude> | undefined
  if (
    !r ||
    typeof r.folder !== 'string' ||
    !inc ||
    !isBool(inc.notes) ||
    !isBool(inc.transcripts) ||
    !isBool(inc.index) ||
    !isBool(inc.encryptedDb) ||
    !isBool(inc.decryptedDb) ||
    !isBool(r.includeTrash) ||
    !isBool(r.confirmedPlaintext) ||
    !isBool(r.confirmedDecryptedDb) ||
    (r.format !== undefined && r.format !== 'standard' && r.format !== 'markdown')
  ) {
    throw notulaError('invalid-input', 'malformed export request')
  }
  return {
    folder: r.folder,
    include: { notes: inc.notes, transcripts: inc.transcripts, index: inc.index, encryptedDb: inc.encryptedDb, decryptedDb: inc.decryptedDb },
    includeTrash: r.includeTrash,
    confirmedPlaintext: r.confirmedPlaintext,
    confirmedDecryptedDb: r.confirmedDecryptedDb,
    format: r.format === 'markdown' ? 'markdown' : 'standard'
  }
}

interface Active {
  exportId: string
  cancelled: boolean
}

function readme(o: {
  format: DataExportFormat
  include: DataExportInclude
  includeTrash: boolean
  counts: DataExportDone['counts']
  errors: DataExportDone['errors']
  cancelled: boolean
  databaseFiles: string[]
}): string {
  const lines = ['Notula export', '']
  if (o.cancelled) lines.push('INCOMPLETE: this export was cancelled before it finished. Some files are missing.', '')
  lines.push(`Exported: ${new Date().toISOString()} by Notula ${app.getVersion()}`, '')
  lines.push('This folder holds:')
  if (o.format === 'markdown') {
    lines.push(`  ${o.counts.notes} notes as Markdown, in folders named like your Notula folders${o.includeTrash ? ' (notes from Trash in Trash/)' : ''}`)
    if (o.include.transcripts) lines.push(`  ${o.counts.transcripts} transcripts beside their notes, as <name>.transcript.md with [mm:ss] times`)
    lines.push('  A note linked to a video or lesson has source_url, source_kind, channel, series, lesson, duration')
    lines.push('  and watched in its front-matter, and [mm:ss] links to the video in its text.')
  } else if (o.include.notes) lines.push(`  notes/           ${o.counts.notes} notes as Markdown with front-matter${o.includeTrash ? ' (notes from Trash in notes/Trash/)' : ''}`)
  if (o.include.transcripts) lines.push(`  transcripts/     ${o.counts.transcripts} transcripts as plain text`)
  if (o.include.index) lines.push('  index.csv        one row per exported note (UTF-8, opens in spreadsheet apps)')
  if (o.databaseFiles.length > 0) lines.push(`  database/        ${o.databaseFiles.join(', ')} (see database/README.txt)`)
  lines.push('')
  if (o.include.notes || o.include.transcripts || o.include.index || o.include.decryptedDb) {
    lines.push('These files are not encrypted. Anyone who can open this folder can read your notes.', '')
  }
  lines.push('Not included: chat threads, meeting audio, and attachments (images and files). The notes list their')
  lines.push('attachments by name only.', '')
  if (o.errors.length > 0) {
    lines.push(`Problems (${o.errors.length}):`)
    for (const e of o.errors) lines.push(`  ${e.noteId ? `note ${e.noteId}: ` : ''}${e.message}`)
    lines.push('')
  }
  lines.push('Notula never uploads exports. Nothing in this folder was sent anywhere.', '')
  return lines.join('\n')
}

export function registerDataExport(ctx: MainContext): void {
  /** Folders the picker returned in this session (resolved paths). */
  const chosen = new Set<string>()
  let active: Active | null = null

  function push(channel: 'progress', payload: DataExportProgress): void
  function push(channel: 'done', payload: DataExportDone): void
  function push(channel: 'progress' | 'done', payload: DataExportProgress | DataExportDone): void {
    for (const wc of ctx.windows.targets()) {
      if (ctx.windows.kindOf(wc) !== 'main') continue
      if (channel === 'progress') wc.send('export:progress' satisfies PushChannel, payload as DataExportProgress)
      else wc.send('export:done' satisfies PushChannel, payload as DataExportDone)
    }
  }

  async function drive(run: Active, root: string, req: DataExportRequest): Promise<void> {
    const errors: DataExportDone['errors'] = []
    const counts = { notes: 0, transcripts: 0, trashed: 0 }
    const databaseFiles: string[] = []
    const { include } = req
    try {
      const format = req.format ?? 'standard'
      const refs = include.notes || include.transcripts || include.index ? await ctx.storage.listExportNotes({ includeTrash: req.includeTrash, format }) : []
      const rows: { id: string; notesFile: string | null; transcriptFile: string | null }[] = []

      if (include.notes || include.transcripts) {
        const phase = include.notes ? 'notes' : 'transcripts'
        push('progress', { exportId: run.exportId, phase, done: 0, total: refs.length })
        for (let i = 0; i < refs.length && !run.cancelled; i += DATA_EXPORT.batchNotes) {
          const batch = refs.slice(i, i + DATA_EXPORT.batchNotes)
          const res = await ctx.storage.writeExportNotes({ root, notes: batch, markdown: include.notes, transcripts: include.transcripts, format })
          for (const w of res.written) {
            rows.push(w)
            if (w.notesFile) counts.notes += 1
            if (w.transcriptFile) counts.transcripts += 1
            if (w.notesFile && batch.find((b) => b.id === w.id)?.trashed) counts.trashed += 1
          }
          errors.push(...res.errors)
          push('progress', { exportId: run.exportId, phase, done: Math.min(i + batch.length, refs.length), total: refs.length })
        }
      } else {
        for (const r of refs) rows.push({ id: r.id, notesFile: null, transcriptFile: null })
      }

      if (include.index && !run.cancelled) {
        push('progress', { exportId: run.exportId, phase: 'index', done: 0, total: 1 })
        await ctx.storage.writeExportIndex({ root, rows })
        push('progress', { exportId: run.exportId, phase: 'index', done: 1, total: 1 })
      }

      const kinds = [...(include.encryptedDb ? (['encrypted'] as const) : []), ...(include.decryptedDb ? (['decrypted'] as const) : [])]
      for (let i = 0; i < kinds.length && !run.cancelled; i++) {
        push('progress', { exportId: run.exportId, phase: 'database', done: i, total: kinds.length })
        try {
          const res = await ctx.storage.writeDatabaseCopy({
            root,
            kind: kinds[i]!,
            localStatePath: join(ctx.userDataPath, LOCAL_STATE_FILE)
          })
          databaseFiles.push(...res.files.map((f) => f.replace(/^database\//, '')))
        } catch (err) {
          errors.push({ noteId: '', message: parseError(err).message })
        }
        push('progress', { exportId: run.exportId, phase: 'database', done: i + 1, total: kinds.length })
      }
    } catch (err) {
      errors.push({ noteId: '', message: parseError(err).message })
      log('error', 'data-export:failed', { err: parseError(err).code })
    }

    const done: DataExportDone = { exportId: run.exportId, path: root, cancelled: run.cancelled, counts, errors }
    try {
      await ctx.storage.writeExportReadme({ root, text: readme({ format: req.format ?? 'standard', include, includeTrash: req.includeTrash, counts, errors, cancelled: run.cancelled, databaseFiles }) })
    } catch (err) {
      errors.push({ noteId: '', message: `README.txt could not be written: ${parseError(err).message}` })
    }
    log('info', 'data-export:done', {
      cancelled: run.cancelled,
      notes: counts.notes,
      transcripts: counts.transcripts,
      trashed: counts.trashed,
      problems: errors.length,
      database: databaseFiles.length
    })
    if (active === run) active = null
    push('done', done)
    // Scripted dev runs (NOTULA_DEV_DIALOG_DIR) open no file manager window.
    if (!done.cancelled && !(ctx.isDev && process.env['NOTULA_DEV_DIALOG_DIR'])) {
      const err = await shell.openPath(root)
      if (err) log('warn', 'data-export:reveal-failed', { err })
    }
  }

  ipcMain.handle('export:choose-folder' satisfies InvokeChannel, async (): Promise<InvokeRes<'export:choose-folder'>> => {
    // Dev builds only: NOTULA_DEV_DIALOG_DIR answers the picker, for scripted checks.
    const devDir = ctx.isDev ? process.env['NOTULA_DEV_DIALOG_DIR'] : undefined
    if (devDir) {
      chosen.add(resolve(devDir))
      return { path: devDir }
    }
    const options: Electron.OpenDialogOptions = {
      title: 'Choose a folder for your export',
      buttonLabel: 'Choose folder',
      properties: ['openDirectory', 'createDirectory']
    }
    const win = ctx.windows.main() ?? BrowserWindow.getFocusedWindow()
    const res = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    const path = res.filePaths[0]
    if (res.canceled || !path) return { cancelled: true }
    chosen.add(resolve(path))
    return { path }
  })

  /** Every `export:start` refusal; resolves the validated parent folder. */
  async function checkRequest(req: DataExportRequest): Promise<string> {
    const status = await ctx.storage.status()
    if (status.state !== 'ready') throw notulaError('invalid-input', NOT_AVAILABLE)
    if (active) throw notulaError('busy', 'An export is already running')
    const folder = resolve(req.folder)
    if (!chosen.has(folder)) throw notulaError('invalid-input', 'Choose the folder with Choose folder… first.')
    const { include } = req
    const plaintext = include.notes || include.transcripts || include.index
    if (!plaintext && !include.encryptedDb && !include.decryptedDb) throw notulaError('invalid-input', 'Choose at least one thing to export.')
    if (plaintext && req.confirmedPlaintext !== true) throw notulaError('invalid-input', 'The plaintext confirmation is required.')
    if (req.format === 'markdown') {
      // Content sources' Export notes as Markdown: Labs, Windows only (nothing runs while Sources is off).
      if (process.platform !== 'win32' || !(await ctx.settings.get('sources.enabled'))) throw notulaError('invalid-input', 'Turn on Sources in Settings ▸ Labs first.')
      if (!include.notes) throw notulaError('invalid-input', 'Choose notes to export as Markdown.')
      if (include.encryptedDb || include.decryptedDb) throw notulaError('invalid-input', 'Database copies aren’t part of a Markdown export.')
    }
    if (include.decryptedDb && req.confirmedDecryptedDb !== true) {
      throw notulaError('invalid-input', 'The decrypted copy needs its own acknowledgement.')
    }
    let isDir = false
    try {
      isDir = (await stat(folder)).isDirectory()
    } catch {
      isDir = false
    }
    if (!isDir) throw notulaError('invalid-input', 'That folder no longer exists.')
    return folder
  }

  ipcMain.handle('export:start' satisfies InvokeChannel, async (_e, p: unknown): Promise<InvokeRes<'export:start'>> => {
    const req = parseRequest(p)
    const folder = await checkRequest(req)
    const { include } = req
    // Claimed before the first await below, so two starts can never both run.
    if (active) throw notulaError('busy', 'An export is already running')
    const run: Active = { exportId: randomUUID(), cancelled: false }
    active = run
    let root: string
    try {
      root = await createExportFolder(folder, req.format)
    } catch (err) {
      active = null
      log('error', 'data-export:mkdir-failed', { err })
      throw notulaError('internal', 'Notula couldn’t create the export folder there.')
    }
    log('info', 'data-export:started', {
      notes: include.notes,
      transcripts: include.transcripts,
      index: include.index,
      encryptedDb: include.encryptedDb,
      decryptedDb: include.decryptedDb,
      includeTrash: req.includeTrash,
      format: req.format ?? 'standard'
    })
    void drive(run, root, req).catch((err: unknown) => {
      log('error', 'data-export:drive-failed', { err })
      if (active === run) active = null
    })
    return { exportId: run.exportId }
  })

  ipcMain.handle('export:cancel' satisfies InvokeChannel, (_e, p: unknown) => {
    const id = (p as { exportId?: unknown } | null)?.exportId
    if (typeof id !== 'string') throw notulaError('invalid-input', 'exportId must be a string')
    if (active && active.exportId === id) {
      active.cancelled = true
      log('info', 'data-export:cancel-requested')
    }
  })

  if (ctx.isDev && process.env['NOTULA_DEV_EXPORT_HARNESS'] === '1') void runDevHarness(ctx, checkRequest)
  if (ctx.isDev && process.env['NOTULA_DEV_EXPORT_SEED'] === '1') void seedDevNote(ctx)
}

/**
 * Dev builds only (`NOTULA_DEV_EXPORT_SEED=1`): one sample meeting note with a summary panel
 * and a two-speaker transcript, written through the storage API, so the export's note,
 * transcript and index paths can be checked without a provider. Seeds once per profile.
 */
async function seedDevNote(ctx: MainContext): Promise<void> {
  for (let i = 0; i < 50 && (await ctx.storage.status()).state !== 'ready'; i++) await new Promise((r) => setTimeout(r, 200))
  try {
    const title = 'Q3 plan: "kickoff" / review?'
    const existing = await ctx.storage.listNotes({ scope: 'own' })
    if (existing.items.some((n) => n.title === title)) return
    const start = new Date(Date.now() - 3_600_000)
    const end = new Date(start.getTime() + 1_800_000)
    const note = await ctx.storage.createNote({
      origin: 'new_note_button',
      title,
      transcribe: false,
      created_via: 'Windows',
      calendarEvent: {
        id: 'dev-seed-event',
        iCalUID: 'dev-seed@notula',
        summary: 'Q3 planning',
        start: { dateTime: start.toISOString() },
        end: { dateTime: end.toISOString() },
        attendees: [
          { email: 'ana@example.com', displayName: 'Ana Souza' },
          { email: 'ben@example.com', displayName: 'Ben Okafor' }
        ]
      }
    })
    await ctx.storage.updateNote(note.id, {
      notes_md: ['# Agenda', '', '- Budget = 120k', '- Hiring: two engineers', '', 'See [the doc](https://example.com/q3).'].join('\n'),
      notes_text: 'Agenda Budget = 120k Hiring: two engineers See the doc.',
      people: {
        creator: { name: 'Me', email: 'me@example.com' },
        attendees: [
          { name: 'Ana Souza', email: 'ana@example.com' },
          { name: 'Ben Okafor', email: 'ben@example.com' }
        ]
      }
    })
    const now = new Date().toISOString()
    await ctx.storage.createPanel({
      document_id: note.id,
      content_edited_at: now,
      deleted_at: null,
      title: 'Summary',
      template_key: null,
      content: null,
      content_markdown: [
        '# Decisions',
        '',
        '- Ship the **beta** in August.',
        '- Café budget approved (€2k).',
        '',
        '## Next steps',
        '',
        '1. Ana drafts the plan',
        '2. Ben books the review'
      ].join('\n'),
      generated_content: null,
      last_opened_at: null,
      enhance_started_at: null,
      enhance_failed_at: null,
      enhance_error: null,
      ai_line_map: null,
      speakers_attributed: false,
      crdt_version: 0
    })
    const session = randomUUID()
    await ctx.storage.createSession({ id: session, document_id: note.id, provider: 'deepgram', model: 'nova-3', language: 'en', started_at: start.toISOString() })
    const identity = await ctx.storage.identity()
    const line = (i: number, source: 'microphone' | 'system', text: string): import('@shared/types/transcript').TranscriptChunk => ({
      id: randomUUID(),
      document_id: note.id,
      workspace_id: identity.workspaceId,
      owner_id: identity.ownerId,
      transcription_session_id: session,
      source,
      start_timestamp: new Date(start.getTime() + i * 5_000).toISOString(),
      end_timestamp: new Date(start.getTime() + i * 5_000 + 4_000).toISOString(),
      text,
      is_final: true,
      detected_speaker_name: null,
      detectedSpeaker: null
    })
    await ctx.storage.upsertChunks([
      line(0, 'microphone', 'Let us start with the budget.'),
      line(1, 'system', 'We can do 120k for the quarter.'),
      line(2, 'microphone', 'Great, and hiring?'),
      line(3, 'system', 'Two engineers, starting in September.')
    ])
    await ctx.storage.trashNote((await ctx.storage.createNote({ origin: 'new_note_button', title: 'Old idea (trashed)', created_via: 'Windows', transcribe: false })).id).catch(() => undefined)
    log('info', 'data-export:dev-seeded')
  } catch (err) {
    log('error', 'data-export:dev-seed-failed', { err })
  }
}

/**
 * Dev builds only (`NOTULA_DEV_EXPORT_HARNESS=1`): proves that the storage worker refuses
 * every write outside an export folder, so that refusal is checked against the real
 * worker. Results are log lines `data-export:harness` with `pass` true or false.
 */
async function runDevHarness(ctx: MainContext, checkRequest: (req: DataExportRequest) => Promise<string>): Promise<void> {
  for (let i = 0; i < 50 && (await ctx.storage.status()).state !== 'ready'; i++) await new Promise((r) => setTimeout(r, 200))
  const outside = join(ctx.userDataPath, 'harness-not-an-export')
  await mkdir(outside, { recursive: true })
  const request = (over: Partial<DataExportRequest>): DataExportRequest => ({
    folder: outside,
    include: { notes: true, transcripts: false, index: false, encryptedDb: false, decryptedDb: false },
    includeTrash: false,
    confirmedPlaintext: true,
    confirmedDecryptedDb: false,
    ...over
  })
  const cases: [string, () => Promise<unknown>][] = [
    ['main: a folder the picker did not return', () => checkRequest(request({}))],
    ['readme outside an export folder', () => ctx.storage.writeExportReadme({ root: outside, text: 'x' })],
    ['index outside an export folder', () => ctx.storage.writeExportIndex({ root: outside, rows: [] })],
    ['notes outside an export folder', () => ctx.storage.writeExportNotes({ root: outside, notes: [], markdown: true, transcripts: true })],
    ['database copy outside an export folder', () => ctx.storage.writeDatabaseCopy({ root: outside, kind: 'encrypted', localStatePath: join(ctx.userDataPath, 'Local State') })],
    ['a relative root', () => ctx.storage.writeExportReadme({ root: 'Notula export 2026-01-01 00.00', text: 'x' })],
    ['a traversal in a base name', async () => {
      const root = await createExportFolder(outside)
      return ctx.storage.writeExportNotes({ root, notes: [{ id: 'x', baseName: '..\\..\\escape', trashed: false, hasTranscript: false }], markdown: true, transcripts: false }).then((r) => {
        if (r.errors.length === 1 && r.written.length === 0) throw new Error('refused in errors')
        return r
      })
    }]
  ]
  for (const [name, fn] of cases) {
    let pass = false
    try {
      await fn()
    } catch {
      pass = true
    }
    log(pass ? 'info' : 'error', 'data-export:harness', { case: name, pass })
  }
}
