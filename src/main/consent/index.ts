// SPDX-License-Identifier: Apache-2.0
// The meeting notice: its `consent:*` IPC, the start gate and the chat-post helper.
//
// - The trigger lives in main, so leaving the note neither cancels nor misses it: the feature
//   on, the note capturing, exactly one supported meeting app in the mic list with its channel on,
//   a final `system` chunk when "Wait for someone else to speak" is on, and no outcome recorded for
//   the note yet (one post per note, across pause and resume). Meet counts when a browser is in the
//   list and the note's event has a Google Meet link. Two apps at once → the clipboard path with
//   `several-meeting-windows`.
// - Windows, Zoom and Teams: `chat-post.ps1`, the message on stdin. One run at
//   a time (a new one supersedes), 10 min budget inside the helper, 13 min watchdog here, stop =
//   close stdin then kill 5 s later; stopping the transcript cancels it. Everything else, and every
//   fallback, is the clipboard path with a "Notice copied" card.
// - Records go to `consent_posts`, never the text. "Post again" is always user-initiated.
// - Deferred start: a start gate that holds while a supported app is present, posts at once,
//   and releases on `success`, `confirmed` or Start now. It ends on stop, quit, sleep, the app gone
//   for 3 s, or another note's start.

import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, clipboard, ipcMain } from 'electron'
import { notulaError } from '@shared/errors'
import type { InvokeChannel, InvokeReq, InvokeRes, PushChannel } from '@shared/ipc'
import { detectConferenceLink } from '@shared/lib/conference'
import {
  CONSENT_DEFAULT_MESSAGE,
  CONSENT_LIMITS,
  type ConsentChannel,
  type ConsentReason,
  type ConsentStatus,
  type ConsentStatusValue
} from '@shared/types/consent'
import type { MicApp } from '@shared/types/meetings'
import type { ConsentPostRow } from '../storage/api'
import type { MainContext } from '../context'
import { expected } from '../ipc-expected'
import { log } from '../log'
import { BROWSER_IDS, MEET_PWA, TEAMS_ID, ZOOM_ID } from './apps'
import helperSource from './chat-post.ps1?raw'

const APP_LABEL: Record<ConsentChannel, string> = { zoom: 'Zoom', teams: 'Microsoft Teams', meet: 'Google Meet' }
const PENDING_POLL_MS = 500

type HelperEvent =
  | { event: 'waiting'; for: 'chat-field' | 'draft' }
  | { event: 'hint' }
  | { event: 'result'; status: 'success' | 'failure' | 'unavailable' | 'cancelled'; reason?: ConsentReason; pasted?: boolean }

interface Run {
  noteId: string
  channel: ConsentChannel
  proc: ChildProcess
  hintCard: string | null
  done: boolean
  watchdog: NodeJS.Timeout
  killTimer: NodeJS.Timeout | null
}

export function registerConsent(ctx: MainContext): void {
  let micApps: MicApp[] = []
  /** Notes whose final `system` chunk has been seen ("someone else spoke"). */
  const otherSpoke = new Set<string>()
  /** Notes an automatic post has started for in this app session (the DB record is the authority). */
  const started = new Set<string>()
  const waiting = new Map<string, ConsentStatus['waitingFor']>()
  let pending: { noteId: string; channel: ConsentChannel; goneSince: number | null; timer: NodeJS.Timeout } | null = null
  let run: Run | null = null

  // ---------- status ----------

  async function record(noteId: string): Promise<ConsentPostRow | null> {
    try {
      return await ctx.storage.getConsentPost(noteId)
    } catch {
      return null
    }
  }

  async function status(noteId: string): Promise<ConsentStatus | null> {
    const r = await record(noteId)
    const isPending = pending?.noteId === noteId
    const w = waiting.get(noteId) ?? null
    if (!r && !isPending && !w) return null
    return {
      noteId,
      channel: r?.channel ?? (isPending ? pending!.channel : null),
      status: r?.status ?? null,
      reason: r?.reason ?? null,
      at: r?.completed_at ?? r?.attempted_at ?? null,
      pending: isPending,
      waitingFor: w
    }
  }

  async function push(noteId: string): Promise<ConsentStatus> {
    const st = (await status(noteId)) ?? {
      noteId,
      channel: null,
      status: null,
      reason: null,
      at: null,
      pending: false,
      waitingFor: null
    }
    for (const wc of ctx.windows.targets()) wc.send('consent:status-changed' satisfies PushChannel, st)
    return st
  }

  async function save(noteId: string, channel: ConsentChannel | null, value: ConsentStatusValue, reason: ConsentReason | null): Promise<void> {
    const prev = await record(noteId)
    const now = new Date().toISOString()
    const done = value !== 'attempted'
    try {
      await ctx.storage.upsertConsentPost({
        id: prev?.id ?? randomUUID(),
        note_id: noteId,
        channel: channel ?? prev?.channel ?? null,
        status: value,
        reason,
        attempted_at: value === 'attempted' || !prev?.attempted_at ? now : prev.attempted_at,
        completed_at: done ? now : null
      })
    } catch (err) {
      log('warn', 'consent:save-failed', { noteId, err })
    }
    if (value !== 'attempted') waiting.delete(noteId)
    log('info', 'consent:status', { noteId, channel, status: value, reason })
    await push(noteId)
    if ((value === 'success' || value === 'confirmed') && pending?.noteId === noteId) release(noteId, value)
  }

  async function message(): Promise<string> {
    const raw = await ctx.settings.get('consent.message')
    const text = typeof raw === 'string' ? raw.trim().slice(0, CONSENT_LIMITS.messageMax) : ''
    return text || CONSENT_DEFAULT_MESSAGE
  }

  // ---------- which meeting app ----------

  async function hasMeetLink(noteId: string): Promise<boolean> {
    try {
      const note = await ctx.storage.getNote(noteId)
      const event = note?.linked_event
      return !!event && detectConferenceLink(event, null)?.type === 'meet'
    } catch {
      return false
    }
  }

  /** The supported apps in the mic list whose channel is on. */
  async function channels(noteId: string): Promise<ConsentChannel[]> {
    const s = await ctx.settings.getAll()
    const out: ConsentChannel[] = []
    const ids = micApps.map((a) => a.appId)
    if (s['consent.zoom'] && ids.includes(ZOOM_ID)) out.push('zoom')
    if (s['consent.teams'] && ids.includes(TEAMS_ID)) out.push('teams')
    if (s['consent.meet']) {
      const pwa = ids.some((i) => i.endsWith(MEET_PWA))
      if (pwa || (ids.some((i) => BROWSER_IDS.has(i)) && (await hasMeetLink(noteId)))) out.push('meet')
    }
    return out
  }

  function appPresent(channel: ConsentChannel): boolean {
    const ids = micApps.map((a) => a.appId)
    if (channel === 'zoom') return ids.includes(ZOOM_ID)
    if (channel === 'teams') return ids.includes(TEAMS_ID)
    return ids.some((i) => BROWSER_IDS.has(i) || i.endsWith(MEET_PWA))
  }

  // ---------- the clipboard path ----------

  async function copyPath(noteId: string | null, channel: ConsentChannel | null, opts: { recordAs?: ConsentStatusValue; reason?: ConsentReason | null; pasted?: boolean }): Promise<void> {
    const pasted = opts.pasted === true
    if (!pasted) clipboard.writeText(await message())
    if (noteId) await save(noteId, channel, opts.recordAs ?? 'copied', opts.reason ?? null)
    const where = channel ? APP_LABEL[channel] : 'meeting'
    ctx.notify.show({
      variant: 'info',
      title: pasted ? 'Notice pasted' : 'Notice copied',
      body: pasted ? 'Press Enter in the meeting chat to send it.' : `Paste it in the ${where} chat (Ctrl+V or ⌘V) and press Enter.`,
      infoActions: [
        { id: 'done', label: 'Done' },
        { id: 'dismiss', label: 'Dismiss' }
      ],
      showDelayMs: 0,
      hideAfterMs: null,
      quietWhileRecording: false,
      allowDuringOnboarding: false,
      onAction: (a) => {
        if (a === 'info:done' && noteId) void save(noteId, channel, 'confirmed', null)
      }
    })
  }

  // ---------- the Windows helper ----------

  async function helperPath(): Promise<string> {
    const sha = createHash('sha256').update(helperSource).digest('hex')
    const dir = join(ctx.userDataPath, 'helpers')
    const file = join(dir, `consent-post-${sha.slice(0, 8)}.ps1`)
    let current: string | null = null
    try {
      current = createHash('sha256').update(await readFile(file)).digest('hex')
    } catch {
      current = null
    }
    if (current !== sha) {
      await mkdir(dir, { recursive: true })
      await writeFile(file, helperSource, 'utf8')
    }
    return file
  }

  /** Closes stdin (the helper exits as cancelled) and kills it 5 s later. */
  function stopRun(r: Run): void {
    if (r.killTimer) return
    try {
      r.proc.stdin?.end()
    } catch {
      // Already closed.
    }
    r.killTimer = setTimeout(() => {
      try {
        r.proc.kill()
      } catch {
        // Gone.
      }
    }, CONSENT_LIMITS.stopGraceMs)
    r.killTimer.unref()
  }

  async function finishRun(r: Run, ev: Extract<HelperEvent, { event: 'result' }>): Promise<void> {
    if (r.done) return
    r.done = true
    clearTimeout(r.watchdog)
    if (r.hintCard) ctx.notify.hide(r.hintCard)
    if (run === r) run = null
    stopRun(r)
    const reason = ev.reason ?? null
    switch (ev.status) {
      case 'success':
        await save(r.noteId, r.channel, 'success', null)
        return
      case 'cancelled':
        await save(r.noteId, r.channel, 'cancelled', null)
        return
      case 'unavailable':
        await copyPath(r.noteId, r.channel, { recordAs: 'unavailable', reason: 'helper-unavailable' })
        return
      default:
        if (reason === 'composer-partial-text' || reason === 'composer-unreadable') {
          await save(r.noteId, r.channel, 'failure', reason)
          if (ev.pasted) {
            await copyPath(null, r.channel, { pasted: true })
            return
          }
        }
        await copyPath(r.noteId, r.channel, { recordAs: 'failure', reason })
    }
  }

  async function helperPost(noteId: string, channel: 'zoom' | 'teams'): Promise<void> {
    if (run) {
      const old = run
      log('info', 'consent:superseded', { noteId: old.noteId })
      await finishRun(old, { event: 'result', status: 'cancelled' })
    }
    await save(noteId, channel, 'attempted', null)
    let file: string
    try {
      file = await helperPath()
    } catch (err) {
      log('warn', 'consent:helper-write-failed', { err })
      await copyPath(noteId, channel, { recordAs: 'unavailable', reason: 'helper-unavailable' })
      return
    }
    let proc: ChildProcess
    try {
      proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'ignore']
      })
    } catch {
      await copyPath(noteId, channel, { recordAs: 'unavailable', reason: 'helper-unavailable' })
      return
    }
    const r: Run = {
      noteId,
      channel,
      proc,
      hintCard: null,
      done: false,
      killTimer: null,
      watchdog: setTimeout(() => {
        log('warn', 'consent:watchdog', { noteId })
        try {
          proc.kill()
        } catch {
          // Gone.
        }
        void finishRun(r, { event: 'result', status: 'failure', reason: 'timeout' })
      }, CONSENT_LIMITS.watchdogMs)
    }
    run = r
    let buf = ''
    proc.stdout?.setEncoding('utf8')
    proc.stdout?.on('data', (d: string) => {
      buf += d
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (line) onEvent(r, line)
      }
    })
    proc.on('error', () => void finishRun(r, { event: 'result', status: 'unavailable', reason: 'helper-unavailable' }))
    proc.on('close', (code) => {
      if (!r.done) log('warn', 'consent:helper-exited', { noteId, code })
      void finishRun(r, { event: 'result', status: 'failure', reason: 'composer-unreadable' })
    })
    try {
      proc.stdin?.write(
        `${JSON.stringify({
          app: channel,
          message: await message(),
          budgetMs: CONSENT_LIMITS.budgetMs,
          pollMs: CONSENT_LIMITS.fieldPollMs,
          hintMs: CONSENT_LIMITS.openChatHintMs,
          restoreMs: CONSENT_LIMITS.restoreClipboardMs
        })}\n`
      )
    } catch {
      await finishRun(r, { event: 'result', status: 'unavailable', reason: 'helper-unavailable' })
    }
  }

  function onEvent(r: Run, line: string): void {
    let ev: HelperEvent
    try {
      ev = JSON.parse(line) as HelperEvent
    } catch {
      return
    }
    if (ev.event === 'waiting') {
      waiting.set(r.noteId, ev.for)
      void push(r.noteId)
    } else if (ev.event === 'hint' && !r.hintCard && !r.done) {
      r.hintCard = ctx.notify.show({
        variant: 'info',
        title: `Open the ${APP_LABEL[r.channel]} chat to post your notice`,
        body: 'Notula posts it as soon as the chat is open.',
        infoActions: [{ id: 'copy', label: 'Copy instead' }],
        showDelayMs: 0,
        hideAfterMs: null,
        quietWhileRecording: false,
        allowDuringOnboarding: false,
        onAction: (a) => {
          if (a !== 'info:copy' || r.done) return
          r.done = true
          clearTimeout(r.watchdog)
          if (run === r) run = null
          stopRun(r)
          void copyPath(r.noteId, r.channel, {})
        }
      })
    } else if (ev.event === 'result') {
      void finishRun(r, ev)
    }
  }

  async function post(noteId: string, list: ConsentChannel[]): Promise<void> {
    if (list.length > 1) {
      await copyPath(noteId, null, { reason: 'several-meeting-windows' })
      return
    }
    const channel = list[0] ?? null
    if (process.platform === 'win32' && (channel === 'zoom' || channel === 'teams')) {
      await helperPost(noteId, channel)
      return
    }
    await copyPath(noteId, channel, {})
  }

  // ---------- the automatic trigger ----------

  let evaluating = false
  async function maybePost(): Promise<void> {
    if (evaluating) return
    evaluating = true
    try {
      const noteId = ctx.capture.currentNoteId()
      if (!noteId || !ctx.capture.isCapturing() || started.has(noteId) || pending) return
      const s = await ctx.settings.getAll()
      if (!s['consent.enabled']) return
      if (await record(noteId)) {
        started.add(noteId)
        return
      }
      const list = await channels(noteId)
      if (!list.length) return
      if (s['consent.waitForOtherSpeaker'] && !otherSpoke.has(noteId)) {
        if (waiting.get(noteId) !== 'other-speaker') {
          waiting.set(noteId, 'other-speaker')
          void push(noteId)
        }
        return
      }
      started.add(noteId)
      waiting.delete(noteId)
      await post(noteId, list)
    } catch (err) {
      log('warn', 'consent:trigger-failed', { err })
    } finally {
      evaluating = false
    }
  }

  async function seedOtherSpoke(noteId: string): Promise<void> {
    try {
      const chunks = await ctx.storage.getTranscript(noteId)
      if (chunks.some((c) => c.source === 'system' && c.is_final && c.text.trim())) otherSpoke.add(noteId)
    } catch {
      // The live chunks still arrive.
    }
  }

  ctx.bus.on('meetings:mic-apps', (e) => {
    micApps = e.apps
    void maybePost()
  })
  ctx.bus.on('capture:started', (e) => {
    void seedOtherSpoke(e.noteId).then(() => maybePost())
  })
  ctx.bus.on('transcript:changed', (e) => {
    if (!otherSpoke.has(e.noteId) && e.upserted.some((c) => c.source === 'system' && c.is_final && c.text.trim())) {
      otherSpoke.add(e.noteId)
      void maybePost()
    }
  })
  ctx.bus.on('settings:changed', (e) => {
    if (e.keys.some((k) => k.startsWith('consent.'))) void maybePost()
  })
  ctx.bus.on('capture:stopped', (e) => {
    if (run && run.noteId === e.noteId) void finishRun(run, { event: 'result', status: 'cancelled' })
    if (waiting.delete(e.noteId)) void push(e.noteId)
  })

  // ---------- deferred start ----------

  function endPending(why: string, cancelCapture: boolean): void {
    const p = pending
    if (!p) return
    pending = null
    clearInterval(p.timer)
    log('info', 'consent:pending-ended', { noteId: p.noteId, why })
    if (run && run.noteId === p.noteId) void finishRun(run, { event: 'result', status: 'cancelled' })
    if (cancelCapture) ctx.capture.cancelHeldStart(p.noteId, 'start_cancelled')
    void push(p.noteId)
  }

  function release(noteId: string, why: string): void {
    const p = pending
    if (!p || p.noteId !== noteId) return
    pending = null
    clearInterval(p.timer)
    log('info', 'consent:pending-released', { noteId, why })
    ctx.capture.releaseHeldStart(noteId)
    void push(noteId)
  }

  ctx.capture.registerStartGate({
    id: 'consent',
    beforeStart: async ({ noteId }) => {
      const s = await ctx.settings.getAll()
      if (!s['consent.enabled'] || !s['consent.deferTranscription']) return { result: 'proceed' }
      const prev = await record(noteId)
      if (prev && (prev.status === 'success' || prev.status === 'confirmed')) return { result: 'proceed' }
      const list = await channels(noteId)
      if (!list.length) {
        log('info', 'consent:defer-skipped', { noteId, reason: 'meeting_app_absent' })
        return { result: 'proceed' }
      }
      if (pending && pending.noteId !== noteId) endPending('another-note', true)
      const channel = list[0] as ConsentChannel
      const timer = setInterval(() => {
        const p = pending
        if (!p) return
        const held = ctx.capture.heldStart()
        // A stop, or a start on another note, abandoned the held start.
        if (!held || held.noteId !== p.noteId) {
          endPending('superseded', false)
          return
        }
        if (appPresent(p.channel)) p.goneSince = null
        else if (p.goneSince === null) p.goneSince = Date.now()
        else if (Date.now() - p.goneSince >= CONSENT_LIMITS.appGoneMs) endPending('meeting-ended', true)
      }, PENDING_POLL_MS)
      timer.unref()
      pending = { noteId, channel, goneSince: null, timer }
      started.add(noteId)
      log('info', 'consent:pending', { noteId, channel })
      // No speech can be waited for while nothing is captured: post at once.
      setTimeout(() => void post(noteId, list).then(() => push(noteId)), 0)
      return { result: 'hold' }
    }
  })

  ctx.bus.on('power:suspended', () => endPending('sleep', true))
  app.on('before-quit', () => {
    endPending('quit', false)
    if (run) {
      try {
        run.proc.kill()
      } catch {
        // Gone.
      }
    }
  })

  // ---------- IPC (literal channels) ----------

  function noteIdOf(req: { noteId?: unknown } | undefined): string {
    const id = typeof req?.noteId === 'string' ? req.noteId : ''
    if (!id) throw expected(notulaError('invalid-input', 'A note is required.'))
    return id
  }

  ipcMain.handle('consent:get-status' satisfies InvokeChannel, (_e, req: InvokeReq<'consent:get-status'>): Promise<ConsentStatus | null> =>
    status(noteIdOf(req))
  )

  ipcMain.handle(
    'consent:post-now' satisfies InvokeChannel,
    async (_e, req: InvokeReq<'consent:post-now'>): Promise<InvokeRes<'consent:post-now'>> => {
      const noteId = noteIdOf(req)
      if (run && run.noteId === noteId) return push(noteId)
      started.add(noteId)
      waiting.delete(noteId)
      await post(noteId, await channels(noteId))
      return push(noteId)
    }
  )

  ipcMain.handle(
    'consent:copy-message' satisfies InvokeChannel,
    async (_e, req: InvokeReq<'consent:copy-message'>): Promise<InvokeRes<'consent:copy-message'>> => {
      clipboard.writeText(await message())
      const noteId = typeof req?.noteId === 'string' ? req.noteId : ''
      if (noteId) {
        const prev = await record(noteId)
        if (!prev || (prev.status !== 'success' && prev.status !== 'confirmed')) {
          const list = await channels(noteId)
          await save(noteId, list.length === 1 ? (list[0] as ConsentChannel) : null, 'copied', null)
        }
      }
      return { ok: true }
    }
  )

  ipcMain.handle(
    'consent:mark-posted' satisfies InvokeChannel,
    async (_e, req: InvokeReq<'consent:mark-posted'>): Promise<InvokeRes<'consent:mark-posted'>> => {
      const noteId = noteIdOf(req)
      if (run && run.noteId === noteId) await finishRun(run, { event: 'result', status: 'cancelled' })
      await save(noteId, null, 'confirmed', null)
      return push(noteId)
    }
  )

  ipcMain.handle(
    'consent:resolve-pending' satisfies InvokeChannel,
    async (_e, req: InvokeReq<'consent:resolve-pending'>): Promise<void> => {
      const noteId = noteIdOf(req)
      if (pending?.noteId !== noteId) return
      if (req.action === 'start-now') release(noteId, 'start-now')
      else if (req.action === 'cancel') endPending('cancel', true)
      else throw expected(notulaError('invalid-input', 'Unknown action.'))
    }
  )
}
