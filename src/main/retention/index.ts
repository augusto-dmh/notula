// SPDX-License-Identifier: Apache-2.0
// Transcript retention: the `retention:*` IPC and the retention timers.
//
// - Main owns the timers: only main knows which note is being captured, and the purge
//   skips it. At start-up (storage ready) and every 24 h, a due `retention.pendingHours` is
//   promoted, then `storage.purgeTranscripts` runs in batches of 200 until done. A 15 min check also
//   promotes a pending period at its effective time and shows the notice card 24 h before it.
// - Arming: a change that deletes more (Off → a period, or a shorter one) needs
//   `confirmed: true` and waits a one-week cooldown as `retention.pendingHours`; the current
//   period keeps applying meanwhile. A change that deletes less applies at once and clears it.
// - Never silent: every run writes a `retention_runs` row and a log line with counts and note ids.
//   Storage in recovery or read-only skips the run and logs why.
// - Manual section delete (`transcript:delete-sections`) uses the same repo, is refused while
//   that note is being captured, and pushes `transcript:changed` with the removed ids.
// - Dev only (unpackaged): `NOTULA_DEV_NOW=<ISO time>` shifts this module's clock to that time at
//   start-up, so a test can reach a cooldown's end without waiting a week.

import { randomUUID } from 'node:crypto'
import { app, ipcMain } from 'electron'
import { notulaError } from '@shared/errors'
import type { InvokeChannel, InvokeReq, InvokeRes, PushChannel } from '@shared/ipc'
import type { IsoTime } from '@shared/types/common'
import {
  RETENTION_LIMITS,
  RETENTION_OPTIONS,
  type RetentionHours,
  type RetentionPreview,
  type RetentionRun,
  type RetentionState
} from '@shared/types/retention'
import type { TranscriptChanged } from '@shared/types/transcript'
import type { MainContext } from '../context'
import { expected } from '../ipc-expected'
import { openSettingsSection } from '../lifecycle'
import { log } from '../log'
import { startVHarness, vHarness, vHarnessOn } from '../voiceprint/harness'

const HOUR_MS = 3_600_000
const CHECK_EVERY_MS = 15 * 60_000
const MAX_BATCHES = 500
const VALID_HOURS = RETENTION_OPTIONS.map((o) => o.hours).filter((h): h is RetentionHours => h !== null)

function devOffsetMs(): number {
  const raw = process.env.NOTULA_DEV_NOW
  if (app.isPackaged || !raw) return 0
  const t = Date.parse(raw)
  return Number.isFinite(t) ? t - Date.now() : 0
}

function isHours(v: unknown): v is RetentionHours {
  return VALID_HOURS.includes(v as RetentionHours)
}

export function registerRetention(ctx: MainContext): void {
  const offset = devOffsetMs()
  if (offset) log('info', 'retention:dev-clock', { offsetMs: offset })
  const now = (): number => Date.now() + offset
  const iso = (t: number): IsoTime => new Date(t).toISOString()

  let running: Promise<void> | null = null
  let lastDailyAt = 0
  let startupDone = false

  async function lastRun(): Promise<RetentionRun | null> {
    try {
      return (await ctx.storage.listRetentionRuns(1))[0] ?? null
    } catch {
      return null
    }
  }

  async function state(): Promise<RetentionState> {
    const s = await ctx.settings.getAll()
    return {
      hours: isHours(s['retention.transcriptHours']) ? s['retention.transcriptHours'] : null,
      pendingHours: isHours(s['retention.pendingHours']) ? s['retention.pendingHours'] : null,
      effectiveAt: typeof s['retention.effectiveAt'] === 'string' ? s['retention.effectiveAt'] : null,
      lastRun: await lastRun()
    }
  }

  async function push(): Promise<RetentionState> {
    const st = await state()
    for (const wc of ctx.windows.targets()) wc.send('retention:changed' satisfies PushChannel, st)
    return st
  }

  function skipIds(): string[] {
    const id = ctx.capture.currentNoteId()
    return id ? [id] : []
  }

  async function storageReady(): Promise<string | null> {
    try {
      const st = await ctx.storage.status()
      return st.state === 'ready' ? null : st.state
    } catch (err) {
      return err instanceof Error ? err.message : 'unavailable'
    }
  }

  /** Promotes a pending period whose cooldown has ended. True when it did. */
  async function promoteDue(): Promise<boolean> {
    const s = await ctx.settings.getAll()
    const pending = s['retention.pendingHours']
    const at = s['retention.effectiveAt']
    if (!isHours(pending) || typeof at !== 'string' || Date.parse(at) > now()) return false
    await ctx.settings.set('retention.transcriptHours', pending)
    await ctx.settings.set('retention.pendingHours', null)
    await ctx.settings.set('retention.effectiveAt', null)
    await ctx.settings.set('retention.noticeShownFor', null)
    log('info', 'retention:period-applied', { hours: pending })
    return true
  }

  async function runPurge(trigger: RetentionRun['trigger']): Promise<void> {
    const why = await storageReady()
    if (why) {
      log('warn', 'retention:run-skipped', { reason: `storage ${why}` })
      return
    }
    await promoteDue()
    const hours = await ctx.settings.get('retention.transcriptHours')
    if (!isHours(hours)) return
    const olderThan = iso(now() - hours * HOUR_MS)
    const total = { notes: 0, sections: 0, recordings: 0, bytes: 0, noteIds: [] as string[], errors: [] as string[] }
    for (let i = 0; i < MAX_BATCHES; i++) {
      // The note being captured is re-read before every batch.
      const r = await ctx.storage.purgeTranscripts({ olderThan, skipNoteIds: skipIds(), batch: RETENTION_LIMITS.batchNotes })
      total.notes += r.notes
      total.sections += r.sections
      total.recordings += r.recordings
      total.bytes += r.bytes
      total.noteIds.push(...r.noteIds)
      total.errors.push(...r.errors)
      if (!r.more) break
    }
    const run: RetentionRun = {
      id: randomUUID(),
      ran_at: iso(now()),
      period_hours: hours,
      notes: total.notes,
      sections: total.sections,
      recordings: total.recordings,
      bytes_freed: total.bytes,
      note_ids: total.noteIds,
      errors: total.errors,
      trigger
    }
    await ctx.storage.recordRetentionRun(run)
    log('info', 'retention:run', {
      trigger,
      periodHours: hours,
      olderThan,
      notes: run.notes,
      sections: run.sections,
      recordings: run.recordings,
      bytesFreed: run.bytes_freed,
      noteIds: run.note_ids,
      errors: run.errors.length
    })
    await push()
  }

  function purge(trigger: RetentionRun['trigger']): Promise<void> {
    if (running) return running
    running = runPurge(trigger)
      .catch((err: unknown) => log('warn', 'retention:run-failed', { trigger, err }))
      .finally(() => {
        running = null
      })
    return running
  }

  async function preview(hours: RetentionHours, effectiveAtMs: number): Promise<RetentionPreview> {
    const olderThan = iso(effectiveAtMs - hours * HOUR_MS)
    const p = await ctx.storage.previewRetention({ olderThan, skipNoteIds: skipIds() })
    return { ...p, effectiveAt: iso(effectiveAtMs) }
  }

  /** The card about 24 h before a pending period takes effect, once per effective time. */
  async function maybeNotice(): Promise<void> {
    const s = await ctx.settings.getAll()
    const pending = s['retention.pendingHours']
    const at = s['retention.effectiveAt']
    if (!isHours(pending) || typeof at !== 'string' || s['retention.noticeShownFor'] === at) return
    const atMs = Date.parse(at)
    if (!Number.isFinite(atMs) || atMs - now() > RETENTION_LIMITS.noticeBeforeMs || atMs <= now()) return
    if (await storageReady()) return
    const p = await preview(pending, atMs)
    await ctx.settings.set('retention.noticeShownFor', at)
    log('info', 'retention:notice', { notes: p.notes, effectiveAt: at })
    ctx.notify.show({
      variant: 'info',
      title: 'Transcript auto-deletion starts tomorrow',
      body: `${p.notes} ${p.notes === 1 ? 'transcript' : 'transcripts'} will be deleted.`,
      infoActions: [{ id: 'review', label: 'Review' }],
      showDelayMs: 0,
      hideAfterMs: null,
      quietWhileRecording: false,
      allowDuringOnboarding: false,
      onAction: (a) => {
        if (a === 'info:review') openSettingsSection('preferences', 'retention-notice')
      }
    })
  }

  async function check(): Promise<void> {
    try {
      await maybeNotice()
      const s = await ctx.settings.getAll()
      const at = s['retention.effectiveAt']
      const due = isHours(s['retention.pendingHours']) && typeof at === 'string' && Date.parse(at) <= now()
      if (!startupDone) {
        if (await storageReady()) return
        startupDone = true
        lastDailyAt = Date.now()
        await purge('startup')
      } else if (due || Date.now() - lastDailyAt >= RETENTION_LIMITS.everyMs) {
        lastDailyAt = Date.now()
        await purge('daily')
      }
    } catch (err) {
      log('warn', 'retention:check-failed', { err })
    }
  }

  // Start-up: once storage is ready (it may still be opening), then the periodic check.
  ctx.bus.on('storage:status', (st) => {
    if (st.state === 'ready' && !startupDone) void check()
  })
  setTimeout(() => void check(), 5_000).unref()
  setInterval(() => void check(), CHECK_EVERY_MS).unref()

  if (vHarnessOn()) {
    vHarness.purge = purge
    vHarness.notice = maybeNotice
    startVHarness(ctx)
  }

  // ---------- IPC (literal channels) ----------

  ipcMain.handle('retention:get' satisfies InvokeChannel, (): Promise<RetentionState> => state())

  ipcMain.handle(
    'retention:preview' satisfies InvokeChannel,
    async (_e, req: InvokeReq<'retention:preview'>): Promise<InvokeRes<'retention:preview'>> => {
      if (!isHours(req?.hours)) throw expected(notulaError('invalid-input', 'Choose a period.'))
      return preview(req.hours, now() + RETENTION_LIMITS.cooldownMs)
    }
  )

  ipcMain.handle(
    'retention:set' satisfies InvokeChannel,
    async (_e, req: InvokeReq<'retention:set'>): Promise<InvokeRes<'retention:set'>> => {
      const hours = req?.hours === null ? null : isHours(req?.hours) ? req.hours : undefined
      if (hours === undefined) throw expected(notulaError('invalid-input', 'Choose a period.'))
      const current = await ctx.settings.get('retention.transcriptHours')
      const currentHours = isHours(current) ? current : null
      const deletesMore = hours !== null && (currentHours === null || hours < currentHours)
      if (deletesMore) {
        if (req.confirmed !== true) throw expected(notulaError('invalid-input', 'Confirm the change first.'))
        const at = iso(now() + RETENTION_LIMITS.cooldownMs)
        await ctx.settings.set('retention.pendingHours', hours)
        await ctx.settings.set('retention.effectiveAt', at)
        await ctx.settings.set('retention.noticeShownFor', null)
        log('info', 'retention:armed', { hours, from: currentHours, effectiveAt: at })
      } else {
        await ctx.settings.set('retention.transcriptHours', hours)
        await ctx.settings.set('retention.pendingHours', null)
        await ctx.settings.set('retention.effectiveAt', null)
        await ctx.settings.set('retention.noticeShownFor', null)
        log('info', 'retention:applied', { hours, from: currentHours })
      }
      return push()
    }
  )

  ipcMain.handle('retention:cancel-pending' satisfies InvokeChannel, async (): Promise<RetentionState> => {
    await ctx.settings.set('retention.pendingHours', null)
    await ctx.settings.set('retention.effectiveAt', null)
    await ctx.settings.set('retention.noticeShownFor', null)
    log('info', 'retention:pending-cancelled')
    return push()
  })

  ipcMain.handle('retention:get-log' satisfies InvokeChannel, (): Promise<RetentionRun[]> =>
    ctx.storage.listRetentionRuns(RETENTION_LIMITS.logRuns)
  )

  ipcMain.handle(
    'transcript:delete-sections' satisfies InvokeChannel,
    async (_e, req: InvokeReq<'transcript:delete-sections'>): Promise<InvokeRes<'transcript:delete-sections'>> => {
      const noteId = typeof req?.noteId === 'string' ? req.noteId : ''
      const ids = Array.isArray(req?.chunkIds) ? [...new Set(req.chunkIds.filter((i): i is string => typeof i === 'string' && i !== ''))] : []
      if (!noteId || !ids.length) throw expected(notulaError('invalid-input', 'Select at least one transcript section.'))
      if (req.confirmed !== true) throw expected(notulaError('invalid-input', 'Confirm the delete first.'))
      if (ids.length > RETENTION_LIMITS.sectionDeleteMax) {
        throw expected(
          notulaError(
            'invalid-input',
            `You can delete up to ${RETENTION_LIMITS.sectionDeleteMax} sections at a time. You selected ${ids.length}.`
          )
        )
      }
      if (ctx.capture.isCapturing() && ctx.capture.currentNoteId() === noteId) {
        throw expected(notulaError('busy', 'Stop the transcript first'))
      }
      const r = await ctx.storage.deleteTranscriptSections(noteId, ids)
      log('info', 'transcript:sections-deleted', { noteId, deleted: r.deleted })
      if (r.deleted) {
        const p: TranscriptChanged = { noteId, upserted: [], removedIds: ids }
        for (const wc of ctx.windows.targets()) wc.send('transcript:changed' satisfies PushChannel, p)
        ctx.bus.emit('transcript:changed', p)
      }
      return r
    }
  )
}
