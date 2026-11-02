// SPDX-License-Identifier: Apache-2.0
// Jump: a stamp, a transcript time or a citation seeks the playing session of the note's lesson
// (`sources:seek`); with no live session it opens the lesson and seeks once it plays. Also Export
// lessons (`sources:export-series`).
//
// - Target: a session whose lesson key is the note's: the one the feed bound to the note, else
//   the most recently updated. Never another key. The reader's `seek` never resumes a paused
//   player.
// - From the main window, the player's window is brought forward with a short hidden PowerShell
//   call (the reader has no focus command); from the side window it isn't.
// - No live session (or it went away): the lesson opens (its course app, else the browser) and
//   the seek waits up to 2 min for a session with the note's key. A refused seek opens the link
//   at that time instead.
// - Export lessons: the Markdown export (Export notes as Markdown) of the course's notes, written
//   by the storage worker into a scratch export folder under `<userData>/tmp`, then copied into a
//   new folder `<Course> <date>` (` (2)`… on a clash) inside the folder the user picked, never
//   over an existing file. The course's own folder is the export's root.
// Logs: states and counts only.

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { cp, mkdir, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { notulaError } from '@shared/errors'
import type { InvokeChannel, InvokeRes } from '@shared/ipc'
import { positionLink } from '@shared/lib/position'
import type { CanonicalKey, MediaSession, NoteSource, Playback, SeekResult } from '@shared/types/sources'
import type { MainContext } from '../context'
import { expected } from '../ipc-expected'
import { log } from '../log'
import { mediaFeed, seek as readerSeek } from '../media'
import type { ExportNoteRef } from '../storage/api'
import { courseExportFolderName } from './export-md'
import type { Track } from './offer'

/** A seek waits this long for the opened lesson's session. */
const PENDING_SEEK_MS = 120_000
const PENDING_CHECK_MS = 1_000
/** A video position past this is not a position (a day). */
const MAX_POSITION_MS = 86_400_000
const FOCUS_TIMEOUT_MS = 5_000
const EXPORT_BATCH = 20

export interface SeekHooks {
  /** Present tracks (offer.ts). */
  tracks(): Track[]
  /** `sources:open-lesson`: the course app at the lesson, else the default browser. */
  openLesson(seriesId: string, catalogItemId: string): Promise<{ opened: 'app' | 'browser' | 'none' }>
}

interface PendingSeek {
  noteId: string
  key: CanonicalKey
  positionMs: number
  until: number
}

const POWERSHELL = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

/** Brings a window forward by handle (restores it when minimized). Best effort. */
function bringForward(hwnd: string): void {
  if (!/^\d{1,20}$/.test(hwnd)) return
  const script = [
    "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class NotulaFront {",
    '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);',
    '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);',
    "[DllImport(\"user32.dll\")] public static extern bool IsIconic(IntPtr h); }'",
    `$h = [IntPtr]::new([Int64]${hwnd})`,
    'if ([NotulaFront]::IsIconic($h)) { [void][NotulaFront]::ShowWindow($h, 9) }',
    '[void][NotulaFront]::SetForegroundWindow($h)'
  ].join('\n')
  try {
    const child = spawn(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
      windowsHide: true,
      stdio: 'ignore'
    })
    const timer = setTimeout(() => child.kill(), FOCUS_TIMEOUT_MS)
    timer.unref()
    child.on('exit', () => clearTimeout(timer))
    child.on('error', (err) => log('warn', 'sources:seek-focus-failed', { name: err.name }))
  } catch (err) {
    log('warn', 'sources:seek-focus-failed', { name: err instanceof Error ? err.name : 'error' })
  }
}

function seekRequest(req: unknown): { noteId: string; positionMs: number; bringForward: boolean } {
  const r = req as { noteId?: unknown; positionMs?: unknown; bringForward?: unknown } | null
  if (typeof r?.noteId !== 'string' || !r.noteId || r.noteId.length > 200) throw expected(notulaError('invalid-input', 'noteId is required.'))
  const ms = r.positionMs
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0 || ms > MAX_POSITION_MS) throw expected(notulaError('invalid-input', 'positionMs is not a video position.'))
  return { noteId: r.noteId, positionMs: Math.round(ms), bringForward: r.bringForward === true }
}

function httpUrl(url: string | null | undefined): string | null {
  return url && /^https?:\/\//i.test(url) ? url : null
}

export function registerSeek(ctx: MainContext, hooks: SeekHooks): void {
  /** The reader's latest sessions: a playback's OS app id and window handle. */
  let sessions: MediaSession[] = []
  let pending: PendingSeek | null = null
  let timer: NodeJS.Timeout | null = null

  ctx.bus.on('media:sessions', (e) => {
    sessions = e.sessions
  })

  async function sourcesOn(): Promise<boolean> {
    return process.platform === 'win32' && !!(await ctx.settings.get('sources.enabled'))
  }

  /** The reader's session of a playback: a course app by its app id, a browser by its title. */
  function sessionOf(p: Playback): MediaSession | null {
    if (p.app) return sessions.find((s) => s.app?.appUserModelId === p.app?.appUserModelId) ?? null
    const own = sessions.filter((s) => !s.app && s.browser === p.browser)
    return own.find((s) => s.title === p.title) ?? (own.length === 1 ? own[0]! : null)
  }

  /** The bound playback when it carries the key, else the most recently updated one that does. */
  function target(noteId: string, key: CanonicalKey): { track: Track; session: MediaSession } | null {
    const tracks = hooks.tracks()
    const b = mediaFeed.binding()
    const bound = b && b.noteId === noteId && b.canonicalKey === key && b.playbackId ? tracks.find((t) => t.playback.id === b.playbackId) : undefined
    const keyed = tracks.filter((t) => t.draft?.canonicalKey === key).sort((x, y) => y.playback.updatedAt - x.playback.updatedAt)
    for (const t of [...(bound ? [bound] : []), ...keyed]) {
      const session = sessionOf(t.playback)
      if (session) return { track: t, session }
    }
    return null
  }

  function stopTimer(): void {
    if (timer) clearInterval(timer)
    timer = null
  }

  /** The opened lesson's session appeared: seek it once. */
  function checkPending(): void {
    const p = pending
    if (!p) return stopTimer()
    if (Date.now() > p.until) {
      pending = null
      stopTimer()
      log('info', 'sources:seek-pending', { state: 'expired' })
      return
    }
    const t = target(p.noteId, p.key)
    if (!t) return
    pending = null
    stopTimer()
    void readerSeek(t.session.appId, p.positionMs).then(
      (result) => log('info', 'sources:seek-pending', { state: result }),
      (err: unknown) => log('warn', 'sources:seek-pending-failed', { name: err instanceof Error ? err.name : 'error' })
    )
  }

  /** Opens the lesson: its course app when it has one, else the link in the default browser. */
  async function openLesson(source: NoteSource, positionMs: number): Promise<boolean> {
    if (source.series_id) {
      const item = await ctx.storage.findCatalogItem(source.series_id, { canonicalKey: source.canonical_key, url: source.url }).catch(() => null)
      if (item?.url) {
        const r = await hooks.openLesson(source.series_id, item.id).catch(() => ({ opened: 'none' as const }))
        if (r.opened !== 'none') return true
      }
    }
    const url = httpUrl(source.url)
    if (!url) return false
    await shell.openExternal(positionLink(url, positionMs))
    return true
  }

  ipcMain.handle('sources:seek' satisfies InvokeChannel, async (e, req: unknown): Promise<SeekResult> => {
    if (!(await sourcesOn())) throw expected(notulaError('invalid-input', 'Sources is off.'))
    const { noteId, positionMs, bringForward: wantsForward } = seekRequest(req)
    const source = await ctx.storage.getNoteSource(noteId)
    if (!source) throw expected(notulaError('not-found', 'This note has no video.'))
    // Never from the side window: it sits beside the player on purpose.
    const forward = wantsForward && ctx.windows.kindOf(e.sender) === 'main'
    const t = target(noteId, source.canonical_key)
    if (t) {
      const result = await readerSeek(t.session.appId, positionMs)
      log('info', 'sources:seek', { result, app: !!t.track.playback.app, forward })
      if (result === 'ok') {
        if (forward && t.session.hwnd) bringForward(t.session.hwnd)
        return 'ok'
      }
      if (result === 'refused') {
        // The player can't seek: the link at that time instead.
        const url = httpUrl(source.url)
        if (url) await shell.openExternal(positionLink(url, positionMs))
        return 'refused'
      }
      // `gone`: as if no session played.
    }
    if (!(await openLesson(source, positionMs))) throw expected(notulaError('not-found', 'This lesson has no link to open.'))
    pending = { noteId, key: source.canonical_key, positionMs, until: Date.now() + PENDING_SEEK_MS }
    if (!timer) {
      timer = setInterval(checkPending, PENDING_CHECK_MS)
      timer.unref()
    }
    log('info', 'sources:seek', { result: 'opened', forward })
    return 'opened'
  })

  // ---------- Export lessons ----------

  let exporting = false

  async function pickParent(): Promise<string | null> {
    // Dev builds only: NOTULA_DEV_DIALOG_DIR answers the picker, for scripted checks.
    const devDir = ctx.isDev ? process.env['NOTULA_DEV_DIALOG_DIR'] : undefined
    if (devDir) return devDir
    const options: Electron.OpenDialogOptions = {
      title: 'Choose where to export the lessons',
      buttonLabel: 'Export here',
      properties: ['openDirectory', 'createDirectory']
    }
    const win = ctx.windows.main() ?? BrowserWindow.getFocusedWindow()
    const res = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    return res.canceled ? null : (res.filePaths[0] ?? null)
  }

  /** `<Course> <date>` inside `parent`, ` (2)`… on a clash; never an existing folder. */
  async function newCourseFolder(parent: string, title: string): Promise<string> {
    const now = new Date()
    for (let n = 1; n <= 999; n++) {
      const dir = join(parent, courseExportFolderName(title, now, n))
      try {
        await mkdir(dir)
        return dir
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      }
    }
    throw new Error('too many exports with the same name in this folder')
  }

  /** The storage worker's export folder name, which it requires of a root. */
  function scratchRootName(at = new Date()): string {
    const p = (n: number): string => String(n).padStart(2, '0')
    return `Notula Markdown export ${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())} ${p(at.getHours())}.${p(at.getMinutes())}`
  }

  /** The course's folder is the export's root: its notes' `relDir` becomes '' when nothing else is there. */
  function rooted(refs: ExportNoteRef[]): ExportNoteRef[] {
    if (refs.some((r) => !r.relDir)) return refs
    const counts = new Map<string, number>()
    for (const r of refs) counts.set(r.relDir!, (counts.get(r.relDir!) ?? 0) + 1)
    const main = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
    return refs.map((r) => (r.relDir === main ? { ...r, relDir: '' } : r))
  }

  async function countFiles(dir: string): Promise<number> {
    let n = 0
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      n += entry.isDirectory() ? await countFiles(join(dir, entry.name)) : 1
    }
    return n
  }

  ipcMain.handle('sources:export-series' satisfies InvokeChannel, async (_e, req: unknown): Promise<InvokeRes<'sources:export-series'>> => {
    if (!(await sourcesOn())) throw expected(notulaError('invalid-input', 'Sources is off.'))
    const seriesId = (req as { seriesId?: unknown } | null)?.seriesId
    if (typeof seriesId !== 'string' || !seriesId || seriesId.length > 200) throw expected(notulaError('invalid-input', 'seriesId is required.'))
    if ((await ctx.storage.status()).state !== 'ready') throw expected(notulaError('invalid-input', 'Not available while Notula is recovering your data.'))
    const series = await ctx.storage.getSeries(seriesId)
    if (!series) throw expected(notulaError('not-found', 'No such course.'))
    if (exporting) throw expected(notulaError('busy', 'An export is already running.'))
    exporting = true
    let scratch: string | null = null
    try {
      const noteIds = new Set((await ctx.storage.listNoteSources({ seriesId })).map((s) => s.note_id))
      const refs = rooted((await ctx.storage.listExportNotes({ includeTrash: false, format: 'markdown' })).filter((r) => noteIds.has(r.id)))
      if (refs.length === 0) throw expected(notulaError('not-found', 'This course has no notes to export yet.'))
      const parent = await pickParent()
      if (!parent) return null
      if (!(await stat(parent).catch(() => null))?.isDirectory()) throw expected(notulaError('invalid-input', 'That folder no longer exists.'))

      // The worker writes only inside its own export folder; the copy lands in a new course folder.
      scratch = join(ctx.userDataPath, 'tmp', `lessons-${randomUUID()}`)
      const root = join(scratch, scratchRootName())
      await mkdir(root, { recursive: true })
      let problems = 0
      for (let i = 0; i < refs.length; i += EXPORT_BATCH) {
        const res = await ctx.storage.writeExportNotes({ root, notes: refs.slice(i, i + EXPORT_BATCH), markdown: true, transcripts: true, format: 'markdown' })
        problems += res.errors.length
      }
      const dest = await newCourseFolder(parent, series.title)
      await cp(root, dest, { recursive: true, force: false, errorOnExist: true })
      const files = await countFiles(dest)
      log('info', 'sources:export-series', { notes: refs.length, files, problems })
      if (!(ctx.isDev && process.env['NOTULA_DEV_DIALOG_DIR'])) {
        const err = await shell.openPath(dest)
        if (err) log('warn', 'sources:export-series-reveal-failed', { failed: true })
      }
      return { folder: dest, files }
    } finally {
      exporting = false
      if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => undefined)
    }
  })
}
