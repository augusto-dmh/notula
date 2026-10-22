// SPDX-License-Identifier: Apache-2.0
// Dev builds only (`!app.isPackaged`): `NOTULA_DEV_N_HARNESS=<noteId>|new` exercises the
// notes and AI main-only seams once storage is ready, for a smoke run without a meeting:
// - `ctx.attachments.addNoteImage` with a screen-share context, not counted (the snapshot path);
// - `ctx.enhance.autoGenerate` with a scripted transcript and a fallback summary (the
//   demo's path): with no usable LLM the fallback becomes the panel; with one, the summary
//   prompt carries the snapshot descriptions.
// Results are log lines only. Packaged builds ignore the variable.

import { app, nativeImage } from 'electron'
import type { MainContext } from '../context'
import { log } from '../log'

const SCRIPT = Array.from(
  { length: 40 },
  (_, i) => `Speaker ${(i % 3) + 1}: Line ${i + 1} of the scripted meeting about the pilot, its pricing tiers and the next steps we agreed.`
).join('\n')

export function runDevHarness(ctx: MainContext): void {
  const target = !app.isPackaged ? process.env['NOTULA_DEV_N_HARNESS']?.trim() : ''
  if (!target) return
  let ran = false
  const run = async (): Promise<void> => {
    if (ran) return
    ran = true
    let noteId = target
    try {
      if (target === 'new') {
        const note = await ctx.storage.createNote({ origin: 'unknown', title: 'Dev harness meeting', transcribe: false, created_via: 'desktop' })
        noteId = note.id
      }
      // A flat 640 × 360 BGRA bitmap, encoded as PNG by main.
      const image = nativeImage.createFromBitmap(Buffer.alloc(640 * 360 * 4, 0x9a), { width: 640, height: 360 })
      const record = await ctx.attachments.addNoteImage(
        noteId,
        { bytes: image.toPNG(), mimeType: 'image/png', fileName: 'shared-screen.png' },
        {
          screenShareContext: { captured_at: new Date().toISOString(), description: 'A slide titled Q3 pricing tiers with three columns.', model: 'dev-harness' },
          countTowardLimit: false
        }
      )
      log('info', 'dev-harness:snapshot-added', { noteId, attachmentId: record.id, width: record.width, height: record.height })
      const result = await ctx.enhance.autoGenerate(noteId, { transcriptText: SCRIPT, fallbackMarkdown: '## Example summary\n\n- This summary is the fallback.' })
      log('info', 'dev-harness:auto-generate', { noteId, panelId: result?.panelId ?? null })
    } catch (err) {
      log('error', 'dev-harness:failed', { noteId, err: err instanceof Error ? err.message : String(err) })
    }
  }
  ctx.bus.on('storage:status', (s) => {
    if (s.state === 'ready') setTimeout(() => void run(), 1_500)
  })
  void ctx.storage
    .status()
    .then((s) => {
      if (s.state === 'ready') setTimeout(() => void run(), 1_500)
    })
    .catch(() => undefined)
}
