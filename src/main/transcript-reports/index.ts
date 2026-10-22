// SPDX-License-Identifier: Apache-2.0
// Transcript reports: create, list, delete and export.
//
// Local records only: nothing is sent anywhere. A report keeps a snapshot of the reported
// stretch and the ASR context of the note's latest session, so it stays useful after the
// transcript changes. "Export reports…" writes a JSON file to a folder the user picks, after the
// renderer's plaintext confirmation. Logs carry ids and counts, never text.

import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { dialog, ipcMain } from 'electron'
import { notulaError } from '@shared/errors'
import type { InvokeChannel, InvokeReq, InvokeRes } from '@shared/ipc'
import { TRANSCRIPT_REPORT_CATEGORIES, TRANSCRIPT_REPORT_LIMITS, type TranscriptReport } from '@shared/types/transcript-reports'
import type { MainContext } from '../context'
import { expected } from '../ipc-expected'
import { log } from '../log'

const MAX_SELECTION = 5_000

export function registerTranscriptReports(ctx: MainContext): void {
  ipcMain.handle(
    'transcript-report:create' satisfies InvokeChannel,
    async (_e, req: InvokeReq<'transcript-report:create'>): Promise<InvokeRes<'transcript-report:create'>> => {
      const noteId = typeof req?.noteId === 'string' ? req.noteId : ''
      if (!noteId) throw expected(notulaError('invalid-input', 'A note is required.'))
      if (!TRANSCRIPT_REPORT_CATEGORIES.some((c) => c.value === req.category)) {
        throw expected(notulaError('invalid-input', 'Choose an issue type'))
      }
      if (!(await ctx.settings.get('transcriptReport.enabled'))) {
        throw expected(notulaError('invalid-input', 'Report transcript problems is off in Labs.'))
      }
      const chunkIds = Array.isArray(req.chunkIds)
        ? req.chunkIds.filter((i): i is string => typeof i === 'string').slice(0, MAX_SELECTION)
        : undefined
      const comments = typeof req.comments === 'string' ? req.comments.trim().slice(0, TRANSCRIPT_REPORT_LIMITS.commentsMax) : ''
      const [snap, session] = await Promise.all([ctx.storage.reportExcerpt(noteId, chunkIds), ctx.storage.latestSession(noteId)])
      const r = await ctx.storage.createTranscriptReport({
        note_id: noteId,
        category: req.category,
        comments,
        start_timestamp: snap.start,
        end_timestamp: snap.end,
        excerpt_text: snap.text,
        excerpt: snap.excerpt,
        asr_provider: session?.provider ?? null,
        asr_model: session?.model ?? null,
        asr_language: session?.language ?? null,
        asr_local: session?.provider === 'local'
      })
      log('info', 'transcript-report:saved', { id: r.id, noteId, category: r.category, hasRange: snap.start !== null, hasComments: comments !== '' })
      return { id: r.id }
    }
  )

  ipcMain.handle(
    'transcript-report:list' satisfies InvokeChannel,
    (_e, req: InvokeReq<'transcript-report:list'>): Promise<TranscriptReport[]> =>
      ctx.storage.listTranscriptReports(typeof req?.noteId === 'string' && req.noteId ? { noteId: req.noteId } : {})
  )

  ipcMain.handle(
    'transcript-report:delete' satisfies InvokeChannel,
    async (_e, req: InvokeReq<'transcript-report:delete'>): Promise<InvokeRes<'transcript-report:delete'>> => {
      const id = typeof req?.id === 'string' ? req.id : ''
      if (!id) throw expected(notulaError('invalid-input', 'A report is required.'))
      const ok = await ctx.storage.deleteTranscriptReport(id)
      log('info', 'transcript-report:deleted', { id, ok })
      return { ok }
    }
  )

  ipcMain.handle(
    'transcript-report:export' satisfies InvokeChannel,
    async (e, req: InvokeReq<'transcript-report:export'>): Promise<InvokeRes<'transcript-report:export'>> => {
      if (req?.confirmedPlaintext !== true) throw expected(notulaError('invalid-input', 'Confirm the plain-text export first.'))
      const reports = await ctx.storage.listTranscriptReports(typeof req.noteId === 'string' && req.noteId ? { noteId: req.noteId } : {})
      // Dev builds only: NOTULA_DEV_DIALOG_DIR answers the picker, for scripted checks.
      const devDir = ctx.isDev ? process.env['NOTULA_DEV_DIALOG_DIR'] : undefined
      const owner = ctx.windows.main()
      const opts: Electron.OpenDialogOptions = {
        title: 'Export reports',
        buttonLabel: 'Export here',
        properties: ['openDirectory', 'createDirectory']
      }
      const pick = devDir
        ? { canceled: false, filePaths: [devDir] }
        : owner && owner.webContents.id === e.sender.id
          ? await dialog.showOpenDialog(owner, opts)
          : await dialog.showOpenDialog(opts)
      const dir = pick.canceled ? null : pick.filePaths[0]
      if (!dir) return { cancelled: true }
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
      const path = join(dir, `notula-transcript-reports-${stamp}.json`)
      const body = {
        format: 'notula-transcript-reports',
        version: 1,
        exported_at: new Date().toISOString(),
        reports: reports.map((r) => ({
          id: r.id,
          note_id: r.note_id,
          category: r.category,
          comments: r.comments,
          start_timestamp: r.start_timestamp,
          end_timestamp: r.end_timestamp,
          excerpt_text: r.excerpt_text,
          asr: { provider: r.asr_provider, model: r.asr_model, language: r.asr_language, local: r.asr_local },
          created_at: r.created_at
        }))
      }
      await writeFile(path, JSON.stringify(body, null, 2), { encoding: 'utf8', flag: 'wx' })
      log('info', 'transcript-report:exported', { count: reports.length })
      return { path }
    }
  )
}
