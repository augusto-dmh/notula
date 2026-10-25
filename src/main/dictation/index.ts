// SPDX-License-Identifier: Apache-2.0
// registerDictation(): system-wide voice typing:
// the shortcut (its applier goes to `ctx.shortcuts`), the pill window, recognition through
// `ctx.speech`, formatting and paste; the `dictation:*` IPC.
//
// - Gates: Labs `voiceTyping.enabled` and the page's `dictation.enabled`, on Windows
//   and macOS. Nothing is registered, forked or captured unless both are on ("armed").
// - Shortcut: Electron `globalShortcut`, toggle mode only (`holdMode: false`).
//   A press starts a hands-free recording; a second press within 400 ms is the double-tap
//   and changes nothing; presses within 300 ms of the previous one are repeats and are
//   ignored; the next press finishes. Escape is registered only while recording, to cancel.
//   The applier goes to `ctx.shortcuts`; the shortcut setter validates through it.
// - The pill (kind `dictation-pill`) exists hidden while armed, shows inactive while the
//   state is not `idle`, never takes focus, and captures the microphone (start push → audio sends).
// - Session: language, foreground app and category, screen context (600 ms), keyterms,
//   `ctx.speech` recognizer, failed-audio file (NAU1) when retention is on, the attempt
//   row; finish → recognize → format (`dictation-format`) → deliver (./delivery.ts).
// - While a session is active: the power-save blocker while recording, and bus
//   `update:delay` (`dictationActive`) every second.
// - Retention sweeps 5 min after start, hourly, and on a retention change; Retry re-reads
//   the stored audio.
// - Chat voice input: its own recognizer per session id, audio on
//   the same audio channel from the main window, plain text back, never formatted or pasted.
// - The dictation bar: the pill's always-visible bar
//   mode (./dictation-bar.ts), hold and hands-free chords through the key hook (./hook.ts and the
//   pure ./chord-machine.ts), and Start or stop recording on `shortcuts.recordToggle`. A session
//   starts the mic at once and buffers audio until the recognizer exists (a hold is short);
//   with the hook available, Esc comes from the hook instead of a global Escape registration.
//   The Ctrl+Shift+Space toggle stays registered as the fallback.

import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { app, globalShortcut, ipcMain, net, powerSaveBlocker, screen, systemPreferences, type BrowserWindow } from 'electron'
import type { InvokeChannel, InvokeRes, PushChannel, SendChannel } from '@shared/ipc'
import { notulaError } from '@shared/errors'
import {
  DICTATION_DEFAULT_SHORTCUT,
  DICTATION_LIMITS as L,
  type DictationAttempt,
  type DictationDeliveryFailure,
  type DictationFailureReason,
  type DictationMicError,
  type DictationRetention,
  type DictationState,
  type DictationStatus
} from '@shared/types/dictation'
import { DICTATION_BAR_LIMITS, parseChord, shortcutLabel, type DictationBarAction } from '@shared/types/dictation-bar'
import type { Settings } from '@shared/types/settings'
import type { AsrProviderId } from '@shared/types/transcript'
import type { MainContext } from '../context'
import { FramedWriter, randomKey, readFramed } from '../crypto/blobs'
import { showMainWindow } from '../lifecycle'
import { log } from '../log'
import { RecognizerError, type SpeechRecognizer } from '../transcription/api'
import { buildContextBlock, buildKeyterms } from './context'
import { deliver } from './delivery'
import { Desk, type DeskContext } from './desk'
import type { ChordEffect } from './chord-machine'
import { DictationBar } from './dictation-bar'
import { formatDictation, styleFor } from './format'
import { HookShortcuts } from './hook'
import { classifyTarget, type Target } from './targets'

const PLATFORM_OK = process.platform === 'win32' || process.platform === 'darwin'
const RETENTION_MS: Record<Exclude<DictationRetention, 'off'>, number> = { '24h': 86_400_000, '7d': 7 * 86_400_000, '14d': 14 * 86_400_000 }
const SHORTCUT_TAKEN = 'This shortcut is used by another app.'
const AUTO_DISMISS_MS = 5_000

interface Session {
  id: string
  createdAt: string
  language: string
  target: Target
  startContext: DeskContext | null
  keyterms: string[]
  screenTerms: string[]
  recognizer: SpeechRecognizer | null
  writer: FramedWriter | null
  audioKey: Buffer | null
  speechMs: number
  audioBytes: number
  meter: SpeechMeter
  cancelled: boolean
  finishing: boolean
  failed: DictationFailureReason | null
  /** False while a hold chord is down (push-to-talk); true for toggles, clicks and locks. */
  handsFree: boolean
  /** Audio that arrived before the recognizer existed. */
  pending: Buffer[]
  /** Settles when the start sequence ends (ready, failed or abandoned). */
  setup: Promise<void>
}

/** The level meter over 20 ms frames: adaptive floor, 150 ms warm-up, 120 ms of continuous loud frames. */
class SpeechMeter {
  private floor = 1
  private elapsed = 0
  private loudRun = 0
  speechMs = 0
  feed(pcm: Buffer): void {
    const frame = 640 // 20 ms of 16 kHz s16le
    for (let off = 0; off + frame <= pcm.length; off += frame) {
      let sum = 0
      for (let i = off; i < off + frame; i += 2) {
        const v = pcm.readInt16LE(i) / 32_768
        sum += v * v
      }
      const rms = Math.sqrt(sum / (frame / 2))
      const level = Math.max(0, Math.min(1, (20 * Math.log10(rms + 1e-9) + 60) / 60))
      this.elapsed += 20
      if (this.elapsed <= 150) {
        this.floor = Math.min(this.floor, level)
        continue
      }
      const loud = level > Math.max(this.floor + 0.2, 0.15)
      this.floor = loud ? this.floor : this.floor * 0.95 + level * 0.05
      if (loud) {
        this.loudRun += 20
        if (this.loudRun >= 120) this.speechMs += this.loudRun === 120 ? 120 : 20
      } else this.loudRun = 0
    }
  }
}

function asBuffer(pcm: unknown): Buffer | null {
  if (pcm instanceof Uint8Array) return Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)
  return null
}

function recognizerReason(err: unknown): DictationFailureReason {
  if (err instanceof RecognizerError) {
    if (err.reason === 'no-provider') return 'transcription_start'
    return err.reason
  }
  return 'transcription_start'
}

export function registerDictation(ctx: MainContext): void {
  const desk = new Desk()
  let settings: Settings | null = null
  let armed = false
  let registered: string | null = null
  let shortcutError: string | null = null
  let suspended = false
  let pill: BrowserWindow | null = null
  let state: DictationState = { kind: 'idle', ready: false, handsFree: false, reason: null, type: null }
  let session: Session | null = null
  let lastPress = 0
  let startPress = 0
  let dismissTimer: ReturnType<typeof setTimeout> | null = null
  let hovered = false
  let blocker: number | null = null
  let delayTimer: ReturnType<typeof setInterval> | null = null
  const sessionStartedAt = new Date().toISOString()
  const audioDir = join(ctx.userDataPath, 'dictation-audio')
  const chats = new Map<string, { recognizer: SpeechRecognizer; timer: ReturnType<typeof setTimeout> }>()

  const s = <K extends keyof Settings>(k: K, fallback: Settings[K]): Settings[K] => (settings ? settings[k] : fallback)

  // ---------- state and the pill ----------

  const livePill = (): BrowserWindow | null => (pill && !pill.isDestroyed() ? pill : null)

  const placePill = (w: BrowserWindow): void => {
    if (bar.enabled()) return bar.place(w)
    const pinned = !app.isPackaged && !!process.env['NOTULA_DEV_DISPLAY']
    const display = pinned ? screen.getPrimaryDisplay() : screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    const wa = display.workArea
    const { width, height, bottomOffset } = L.pill
    w.setBounds({ x: Math.round(wa.x + (wa.width - width) / 2), y: wa.y + wa.height - height - bottomOffset, width, height })
  }

  const createPill = (): BrowserWindow => {
    const mac = process.platform === 'darwin'
    const w = ctx.windows.createSecondary({
      kind: 'dictation-pill',
      route: '/dictation-pill',
      title: 'Dictation',
      width: L.pill.width,
      height: L.pill.height,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      focusable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      frame: false,
      transparent: true,
      hasShadow: false,
      backgroundColor: '#00000000',
      ...(mac ? { type: 'panel', hiddenInMissionControl: true } : {})
    })
    w.setAlwaysOnTop(true, 'screen-saver')
    w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    w.setContentProtection(true)
    w.setIgnoreMouseEvents(true, { forward: true })
    // The route mounts after the load: the pill's first `dictation-bar:hit-rects` asks for the state.
    w.webContents.on('did-finish-load', () => bar.pageLoaded())
    w.on('closed', () => {
      if (pill === w) pill = null
    })
    return w
  }

  const pushState = (): void => {
    const w = livePill()
    if (w) w.webContents.send('dictation:state' satisfies PushChannel, state)
  }

  const setState = (next: Partial<DictationState> & { kind: DictationState['kind'] }): void => {
    if (dismissTimer) clearTimeout(dismissTimer)
    dismissTimer = null
    state = { ready: false, handsFree: false, reason: null, type: null, ...next }
    pushState()
    const w = livePill()
    if (bar.enabled()) bar.refresh()
    else if (state.kind === 'idle') {
      if (w?.isVisible()) w.hide()
    } else if (w && !w.isVisible()) {
      placePill(w)
      w.showInactive()
    }
    if (state.kind === 'idle' || !w) return
    const persistent = state.kind === 'error' && (state.reason === 'mic_denied' || state.reason === 'mic_missing')
    const ms = state.kind === 'empty' || state.kind === 'copied' ? L.copiedMs : state.kind === 'saved' || state.kind === 'error' ? AUTO_DISMISS_MS : 0
    if (ms && !persistent) armDismiss(ms)
  }

  const armDismiss = (ms: number): void => {
    if (dismissTimer) clearTimeout(dismissTimer)
    dismissTimer = setTimeout(() => {
      dismissTimer = null
      if (hovered) return armDismiss(1_000)
      if (state.kind !== 'recording' && state.kind !== 'processing') setState({ kind: 'idle' })
    }, ms)
  }

  const historyChanged = (): void => {
    for (const wc of ctx.windows.targets()) wc.send('dictation:history-changed' satisfies PushChannel)
  }

  // ---------- activity side effects ----------

  const setActive = (on: boolean): void => {
    if (on && !delayTimer) {
      ctx.bus.emit('update:delay', { reason: 'dictationActive' })
      delayTimer = setInterval(() => ctx.bus.emit('update:delay', { reason: 'dictationActive' }), 1_000)
    } else if (!on && delayTimer && !session && chats.size === 0) {
      clearInterval(delayTimer)
      delayTimer = null
    }
  }

  const setBlocker = (on: boolean): void => {
    if (on && blocker === null) blocker = powerSaveBlocker.start('prevent-app-suspension')
    else if (!on && blocker !== null) {
      if (powerSaveBlocker.isStarted(blocker)) powerSaveBlocker.stop(blocker)
      blocker = null
    }
  }

  // ---------- Escape while recording ----------

  const escapeOn = (want: boolean): void => {
    // The hook reports Esc without taking it from other apps.
    const on = want && !hook.status.available
    if (on) {
      if (!globalShortcut.isRegistered('Escape')) {
        try {
          globalShortcut.register('Escape', () => void cancel('escape'))
        } catch {
          /* Escape is optional; the pill's Cancel still works */
        }
      }
    } else if (globalShortcut.isRegistered('Escape')) globalShortcut.unregister('Escape')
  }

  // ---------- the session ----------

  const capture = (action: 'start' | 'stop' | 'cancel', id: string): void => {
    const w = livePill()
    if (!w) return
    w.webContents.send('dictation:capture' satisfies PushChannel, { action, sessionId: id, microphone: action === 'start' ? s('dictation.microphone', null) : null })
  }

  const language = (): string => {
    const stored = s('dictation.language', null)
    if (stored) return stored
    const asr = s('asr.language', 'en')
    return asr === 'multi' ? 'auto' : asr === 'pt-BR' ? 'pt' : 'en'
  }

  const retention = (): DictationRetention => s('dictation.failedAudioRetention', null) ?? '24h'

  const endSession = (): void => {
    session = null
    hook.setActive(false)
    hook.sessionEnded()
    escapeOn(false)
    setBlocker(false)
    setActive(false)
  }

  const discardAttempt = async (sess: Session): Promise<void> => {
    if (sess.writer) await sess.writer.abort().catch(() => undefined)
    sess.writer = null
    await ctx.storage.deleteDictationAttempts({ ids: [sess.id] }).catch(() => undefined)
  }

  const fail = async (sess: Session, reason: DictationFailureReason): Promise<void> => {
    if (session !== sess || sess.cancelled) return
    sess.failed = reason
    sess.recognizer?.cancel()
    capture('cancel', sess.id)
    const keep = retention() !== 'off' && sess.writer !== null && sess.meter.speechMs >= L.minSpeechMs
    let saved = false
    if (keep && sess.writer) {
      try {
        const r = await sess.writer.close()
        sess.writer = null
        const ttl = RETENTION_MS[retention() as Exclude<DictationRetention, 'off'>] ?? RETENTION_MS['24h']
        await ctx.storage.updateDictationAttempt(sess.id, {
          status: 'failed',
          failure_reason: reason,
          audio_duration_ms: Math.round((r.plainBytes / 32_000) * 1_000),
          audio_purge_at: new Date(Date.parse(sess.createdAt) + ttl).toISOString()
        })
        saved = true
      } catch (err) {
        log('warn', 'dictation:audio-save-failed', { err: err instanceof Error ? err.name : 'error' })
      }
    }
    if (!saved) await discardAttempt(sess)
    log('info', 'dictation:failed', { reason, saved })
    endSession()
    setState(saved ? { kind: 'saved' } : { kind: 'error', reason })
    if (saved) historyChanged()
  }

  const start = (type: 'shortcut' | 'click', handsFree = true): void => {
    if (!armed || session) return
    if (dismissTimer) clearTimeout(dismissTimer)
    const id = randomUUID()
    const lang = language()
    const sess: Session = {
      id,
      createdAt: new Date().toISOString(),
      language: lang,
      target: classifyTarget('', ''),
      startContext: null,
      keyterms: [],
      screenTerms: [],
      recognizer: null,
      writer: null,
      audioKey: null,
      speechMs: 0,
      audioBytes: 0,
      meter: new SpeechMeter(),
      cancelled: false,
      finishing: false,
      failed: null,
      handsFree,
      pending: [],
      setup: Promise.resolve()
    }
    session = sess
    hook.setActive(true)
    escapeOn(true)
    setBlocker(true)
    setActive(true)
    setState({ kind: 'recording', ready: false, handsFree, type })
    log('info', 'dictation:started', { type, handsFree })
    // The mic starts at once; its audio waits in `pending` until the recognizer exists.
    capture('start', id)
    sess.setup = setupSession(sess, type).catch((err: unknown) =>
      log('warn', 'dictation:setup-failed', { err: err instanceof Error ? err.message : String(err) })
    )
  }

  const setupSession = async (sess: Session, type: 'shortcut' | 'click'): Promise<void> => {
    const { id } = sess
    const lang = sess.language

    // Context first (600 ms), so the keyterms reach the recognizer.
    const screenOn = s('voiceTyping.screenContext', false) && s('dictation.screenContext', true)
    const fg = await desk.foreground(L.contextMs).catch(() => null)
    sess.target = classifyTarget(fg?.process ?? '', fg?.title ?? '')
    if (screenOn) sess.startContext = await desk.context(L.contextMs)
    if (session !== sess || sess.cancelled) return
    const terms = buildKeyterms(s('dictation.dictionary', []), sess.startContext, sess.target)
    sess.keyterms = terms.keyterms
    sess.screenTerms = terms.screen

    // The attempt row, with an audio file when retention is on.
    if (retention() !== 'off') {
      try {
        mkdirSync(audioDir, { recursive: true })
        sess.audioKey = randomKey()
        sess.writer = await FramedWriter.create({ path: join(audioDir, id), key: sess.audioKey, id })
      } catch (err) {
        log('warn', 'dictation:audio-open-failed', { err: err instanceof Error ? err.name : 'error' })
        sess.writer = null
        sess.audioKey = null
      }
    }
    try {
      await ctx.storage.createDictationAttempt({
        id,
        created_at: sess.createdAt,
        language: lang,
        audio_key: sess.writer && sess.audioKey ? new Uint8Array(sess.audioKey) : null
      })
    } catch (err) {
      log('warn', 'dictation:attempt-create-failed', { err: err instanceof Error ? err.message : String(err) })
    }
    if (session !== sess || sess.cancelled) return discardAttempt(sess)

    let recognizer: SpeechRecognizer
    try {
      recognizer = ctx.speech.openRecognizer({ purpose: 'dictation', choice: s('dictation.asr', 'auto'), language: lang, keyterms: sess.keyterms })
    } catch (err) {
      return fail(sess, recognizerReason(err))
    }
    sess.recognizer = recognizer
    for (const pcm of sess.pending.splice(0)) {
      recognizer.feed(pcm)
      sess.writer?.append(pcm)
    }
    if (recognizer.provider !== 'local' && !net.isOnline()) return fail(sess, 'offline')
    ctx.speech.setLocalWarm(true)
    const cold = recognizer.provider === 'local' ? L.coldLocalReadyMs : L.readyMs
    const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new RecognizerError('connection_timeout', 'not ready')), cold + 500))
    try {
      await Promise.race([recognizer.ready, timeout])
    } catch (err) {
      return fail(sess, recognizerReason(err))
    }
    if (session !== sess || sess.cancelled || sess.finishing) return
    setState({ kind: 'recording', ready: true, handsFree: sess.handsFree, type })
  }

  const finish = async (): Promise<void> => {
    const sess = session
    if (!sess || sess.finishing || sess.cancelled) return
    sess.finishing = true
    escapeOn(false)
    setState({ kind: 'processing' })
    capture('stop', sess.id)
    setBlocker(false)
    // The pill keeps a 100 ms tail; give its last chunk time to arrive.
    await new Promise((r) => setTimeout(r, 250))
    // A short hold can end before the recognizer is ready: let the start sequence finish.
    await sess.setup
    if (session !== sess || sess.cancelled) return
    // The focused field at release: secure input and no-focus checks for delivery, and the
    // release context when screen context is on. It never leaves the machine otherwise.
    const releaseCtx = desk.context(L.contextMs)
    let raw = ''
    let detected: string | null = null
    let audioMs = 0
    try {
      if (!sess.recognizer) throw new RecognizerError('transcription_start', 'no recognizer')
      const r = await Promise.race([
        sess.recognizer.finish(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new RecognizerError('connection', 'finish timed out')), 60_000))
      ])
      raw = r.text.trim()
      detected = r.language
      audioMs = r.audioMs
    } catch (err) {
      sess.finishing = false
      return fail(sess, recognizerReason(err))
    }
    if (session !== sess || sess.cancelled) return
    const field = await releaseCtx.catch(() => null)
    if (!raw) {
      await discardAttempt(sess)
      endSession()
      if (sess.meter.speechMs >= L.minSpeechMs) setState({ kind: 'empty' })
      else setState({ kind: 'idle' })
      log('info', 'dictation:empty', { speechMs: sess.meter.speechMs })
      return
    }
    const screenOn = s('voiceTyping.screenContext', false) && s('dictation.screenContext', true)
    const contextBlock = screenOn ? buildContextBlock(field?.result === 'captured' ? field : sess.startContext, sess.target, sess.screenTerms) : ''
    const tone = styleFor(s('dictation.styles', { email: null, work: null, casual: null, other: null }), sess.target.category, sess.target.hint)
    const formatted = await formatDictation(ctx, {
      raw,
      tone,
      hint: sess.target.hint,
      language: detected ?? sess.language,
      contextBlock,
      dictionary: s('dictation.dictionary', [])
    })
    if (session !== sess || sess.cancelled) return
    const d = await deliver(desk, formatted.text, field, () => session === sess)
    if (sess.writer) await sess.writer.abort().catch(() => undefined)
    sess.writer = null
    const status = d.outcome
    try {
      await ctx.storage.updateDictationAttempt(sess.id, {
        status,
        failure_reason: d.outcome === 'delivery_failed' ? 'clipboard_failed' : null,
        language: detected ?? sess.language,
        audio_duration_ms: audioMs || Math.round((sess.audioBytes / 32_000) * 1_000),
        text: formatted.text,
        audio_purge_at: null
      })
    } catch (err) {
      log('warn', 'dictation:attempt-update-failed', { err: err instanceof Error ? err.message : String(err) })
    }
    log('debug', 'dictation-done', { outcome: status, path: formatted.path, category: sess.target.category, chars: formatted.text.length })
    endSession()
    historyChanged()
    if (d.outcome === 'pasted') setState({ kind: 'idle' })
    else if (d.outcome === 'clipboard') setState({ kind: 'copied', reason: d.reason as DictationDeliveryFailure })
    else setState({ kind: 'error', reason: 'clipboard_failed' })
  }

  const cancel = async (why: string): Promise<void> => {
    const sess = session
    if (!sess) {
      if (state.kind !== 'idle') setState({ kind: 'idle' })
      return
    }
    if (sess.cancelled) return
    sess.cancelled = true
    sess.recognizer?.cancel()
    capture('cancel', sess.id)
    await discardAttempt(sess)
    endSession()
    setState({ kind: 'idle' })
    log('info', 'dictation:cancelled', { why })
  }

  const onPress = (): void => {
    const now = Date.now()
    if (suspended) return
    const sinceLast = now - lastPress
    lastPress = now
    if (session && !session.finishing) {
      // A second press within 400 ms of the start is the double-tap (still hands-free).
      if (now - startPress < L.doubleTapMs) return
      if (sinceLast < L.repeatIgnoreMs) return
      void finish()
      return
    }
    if (sinceLast < L.repeatIgnoreMs) return
    if (session) return // still processing the previous one
    startPress = now
    start('shortcut')
    hook.sessionStartedElsewhere()
  }

  // ---------- the hook chords ----------

  const onChord = (effects: ChordEffect[]): void => {
    for (const e of effects) {
      log('debug', 'dictation-bar:chord', { effect: e })
      switch (e) {
        case 'start-hold':
        case 'start-hands-free':
          if (!armed || suspended || session) break
          startPress = Date.now()
          start('shortcut', e === 'start-hands-free')
          break
        case 'lock': {
          const sess = session
          if (!sess || sess.finishing || sess.cancelled) break
          sess.handsFree = true
          setState({ kind: 'recording', ready: state.ready, handsFree: true, type: state.type })
          break
        }
        case 'finish':
          void finish()
          break
        case 'discard':
          void cancel('tap')
          break
        case 'cancel':
          void cancel('shortcut')
          break
        case 'record':
          if (armed && !suspended) bar.toggleRecord()
          break
      }
    }
  }

  const pushHookStatus = (): void => {
    for (const wc of ctx.windows.targets()) wc.send('shortcuts:hook-status' satisfies PushChannel, hook.status)
    bar.refresh()
  }

  const hook = new HookShortcuts(desk, onChord, pushHookStatus)

  const effectiveOf = (id: 'dictationHold' | 'dictationHandsFree' | 'recordToggle'): string => {
    try {
      return ctx.shortcuts.effective(id)
    } catch {
      return ''
    }
  }

  const configureHook = (): void => {
    if (!armed) return hook.configure(null)
    hook.configure({
      hold: parseChord(effectiveOf('dictationHold'), process.platform),
      handsFree: parseChord(effectiveOf('dictationHandsFree'), process.platform),
      record: recordViaHook ? parseChord(recordViaHook, process.platform) : null,
      tapMs: DICTATION_BAR_LIMITS.tapMs
    })
  }

  // ---------- Start or stop recording (`shortcuts.recordToggle`) ----------

  // When another app owns the accelerator (Windows' Game Bar holds Win+Alt+M, if the user picks it), the key hook
  // matches it instead: it only observes, so the other app still gets the keys.
  let recordRegistered: string | null = null
  let recordViaHook: string | null = null
  const unregisterRecord = (): void => {
    if (recordRegistered && globalShortcut.isRegistered(recordRegistered)) globalShortcut.unregister(recordRegistered)
    recordRegistered = null
    if (recordViaHook) {
      recordViaHook = null
      configureHook()
    }
  }
  const registerRecord = (accelerator: string): { ok: boolean; error: string | null } => {
    unregisterRecord()
    if (!accelerator) return { ok: true, error: null }
    let ok = false
    try {
      ok = globalShortcut.register(accelerator, () => bar.toggleRecord())
    } catch {
      ok = false
    }
    if (!ok) {
      const chord = parseChord(accelerator, process.platform)
      log('warn', 'dictation-bar:record-register-failed', { accelerator, viaHook: !!chord })
      if (!chord) return { ok: false, error: SHORTCUT_TAKEN }
      recordViaHook = accelerator
      configureHook()
      return { ok: true, error: null }
    }
    recordRegistered = accelerator
    return { ok: true, error: null }
  }

  // ---------- the bar ----------

  const bar = new DictationBar({
    ctx,
    desk,
    pill: () => livePill(),
    dictation: () => state,
    dictate: () => {
      const sess = session
      if (sess && !sess.finishing && !sess.cancelled) return void finish()
      if (sess) return
      if (state.kind === 'error' && state.reason === 'mic_denied') setState({ kind: 'idle' })
      startPress = Date.now()
      start('click')
      hook.sessionStartedElsewhere()
    },
    keytips: () => {
      const hookOk = hook.status.available
      const hold = effectiveOf('dictationHold')
      const handsFree = effectiveOf('dictationHandsFree')
      return {
        dictate: shortcutLabel(hookOk && hold ? hold : (registered ?? effectiveShortcut()), process.platform),
        handsFree: hookOk ? shortcutLabel(handsFree, process.platform) : '',
        record: shortcutLabel(recordRegistered ?? (recordViaHook && hookOk ? recordViaHook : ''), process.platform)
      }
    }
  })

  // ---------- the shortcut ----------

  const unregister = (): void => {
    if (registered && globalShortcut.isRegistered(registered)) globalShortcut.unregister(registered)
    registered = null
  }

  const register = (accelerator: string): { ok: boolean; error: string | null } => {
    unregister()
    let ok = false
    try {
      ok = globalShortcut.register(accelerator, onPress)
    } catch {
      ok = false
    }
    if (!ok) {
      shortcutError = SHORTCUT_TAKEN
      log('warn', 'dictation:shortcut-register-failed', { accelerator })
      return { ok: false, error: SHORTCUT_TAKEN }
    }
    registered = accelerator
    shortcutError = null
    log('info', 'dictation:shortcut-registered', { accelerator })
    return { ok: true, error: null }
  }

  const effectiveShortcut = (): string => {
    try {
      return ctx.shortcuts.effective('dictation')
    } catch {
      return s('dictation.shortcut', null) ?? DICTATION_DEFAULT_SHORTCUT
    }
  }

  const arm = (on: boolean): void => {
    if (on === armed) return
    armed = on
    if (on) {
      if (!livePill()) pill = createPill()
      if (!suspended) {
        register(effectiveShortcut())
        registerRecord(effectiveOf('recordToggle'))
      }
      void desk.start()
      configureHook()
      bar.setArmed(true)
      log('info', 'dictation:armed')
    } else {
      void cancel('disarmed')
      unregister()
      unregisterRecord()
      hook.configure(null)
      bar.setArmed(false)
      escapeOn(false)
      shortcutError = null
      const w = livePill()
      pill = null
      if (w) w.destroy()
      desk.stop()
      ctx.speech.setLocalWarm(false)
      log('info', 'dictation:disarmed')
    }
  }

  const evaluate = (): void => {
    arm(PLATFORM_OK && s('voiceTyping.enabled', true) === true && s('dictation.enabled', true) === true)
  }

  // Hook chords apply on `settings:changed` (configureHook); the record shortcut registers here.
  ctx.shortcuts.registerApplier('dictationHold', async () => ({ ok: true, error: null }))
  ctx.shortcuts.registerApplier('dictationHandsFree', async () => ({ ok: true, error: null }))
  ctx.shortcuts.registerApplier('recordToggle', async (accelerator) => {
    if (!armed || suspended) return { ok: true, error: null }
    const previous = recordRegistered
    const r = registerRecord(accelerator)
    if (!r.ok && previous) registerRecord(previous)
    return r
  })

  ctx.shortcuts.registerApplier('dictation', async (accelerator) => {
    if (!armed) return { ok: true, error: null }
    const previous = registered
    const r = register(accelerator)
    if (!r.ok && previous) register(previous)
    return r
  })

  // ---------- retention sweeps ----------

  const sweep = async (): Promise<void> => {
    const r = retention()
    const cutoff = r === 'off' ? Date.now() : Date.now() - RETENTION_MS[r]
    try {
      const rows = await ctx.storage.listDictationAttempts(1_000)
      const live = session?.id
      const old = rows.filter((a) => a.id !== live && Date.parse(a.created_at) < cutoff)
      const drop = old.filter((a) => !a.text && (a.has_audio || a.status === 'recording' || a.status === 'failed')).map((a) => a.id)
      if (drop.length) await ctx.storage.deleteDictationAttempts({ ids: drop })
      for (const a of old) if (a.text && a.has_audio) await ctx.storage.updateDictationAttempt(a.id, { audio_purge_at: null })
      if (drop.length || old.some((a) => a.text && a.has_audio)) historyChanged()
      log('debug', 'dictation:sweep', { retention: r, removed: drop.length })
    } catch (err) {
      log('warn', 'dictation:sweep-failed', { err: err instanceof Error ? err.message : String(err) })
    }
  }

  let swept = false
  const startSweeps = (): void => {
    if (swept) return
    swept = true
    void ctx.storage.markInterruptedDictations().catch(() => 0)
    setTimeout(() => {
      void sweep()
      setInterval(() => void sweep(), 3_600_000).unref()
    }, 300_000).unref()
  }

  // ---------- settings ----------

  void app.whenReady().then(async () => {
    try {
      settings = await ctx.settings.getAll()
      bar.setSettings(settings)
    } catch (err) {
      log('warn', 'dictation:read-failed', { err: err instanceof Error ? err.message : String(err) })
    }
    evaluate()
    try {
      if ((await ctx.storage.status()).state === 'ready') startSweeps()
    } catch {
      /* storage:status below */
    }
  })
  ctx.bus.on('storage:status', (st) => {
    if (st.state === 'ready') startSweeps()
  })
  ctx.bus.on('settings:changed', (e) => {
    const prev = settings
    settings = e.settings
    bar.setSettings(e.settings)
    if (e.keys.some((k) => k === 'voiceTyping.enabled' || k === 'dictation.enabled')) evaluate()
    if (e.keys.some((k) => k === 'shortcuts.dictationHold' || k === 'shortcuts.dictationHandsFree')) configureHook()
    if (e.keys.includes('shortcuts.recordToggle') && armed && !suspended) {
      const next = effectiveOf('recordToggle')
      if (next !== recordRegistered) registerRecord(next)
    }
    if (e.keys.includes('dictation.shortcut') && armed && !suspended) {
      const next = effectiveShortcut()
      if (next !== registered) register(next)
    }
    if (e.keys.includes('dictation.failedAudioRetention') && prev?.['dictation.failedAudioRetention'] !== e.settings['dictation.failedAudioRetention']) {
      void sweep()
    }
  })
  app.on('will-quit', () => {
    arm(false)
    for (const c of chats.values()) {
      clearTimeout(c.timer)
      c.recognizer.cancel()
    }
    chats.clear()
  })

  // ---------- status ----------

  const asrState = async (): Promise<{ asr: AsrProviderId | null; asrError: 'no-provider' | null }> => {
    const choice = s('dictation.asr', 'auto')
    const provider: AsrProviderId = choice === 'auto' ? s('asr.provider', 'deepgram') : choice
    if (provider === 'local') return { asr: 'local', asrError: null }
    const has = await ctx.secrets.has(provider === 'deepgram' ? 'asr.deepgram' : 'asr.assemblyai').catch(() => false)
    return has ? { asr: provider, asrError: null } : { asr: null, asrError: 'no-provider' }
  }

  ipcMain.handle('dictation:get-status' satisfies InvokeChannel, async (): Promise<InvokeRes<'dictation:get-status'>> => {
    const asr = await asrState()
    const status: DictationStatus = {
      platformSupported: PLATFORM_OK,
      labsEnabled: s('voiceTyping.enabled', true),
      enabled: s('dictation.enabled', true),
      armed,
      shortcut: registered ?? effectiveShortcut(),
      shortcutRegistered: registered !== null,
      shortcutError,
      holdMode: false,
      hook: hook.status,
      ...asr,
      accessibility: process.platform === 'darwin' ? (systemPreferences.isTrustedAccessibilityClient(false) ? 'granted' : 'missing') : 'not-needed'
    }
    return status
  })

  // ---------- the shortcut IPC ----------

  ipcMain.handle('dictation:set-shortcut' satisfies InvokeChannel, async (_e, p: { accelerator: string | null }): Promise<InvokeRes<'dictation:set-shortcut'>> => {
    const accelerator = p?.accelerator ?? null
    const target = accelerator ?? DICTATION_DEFAULT_SHORTCUT
    if (accelerator !== null) {
      if (typeof accelerator !== 'string' || !accelerator.trim()) return { ok: false, error: 'Couldn’t record shortcut. Try again.' }
      if (/^(Alt|Option)\+Space$/i.test(accelerator)) return { ok: false, error: 'Quick ask uses this shortcut.' }
      const problem = ctx.shortcuts.validate('dictation', accelerator)
      if (problem) return { ok: false, error: problem }
    }
    if (armed) {
      const previous = registered
      const r = register(target)
      if (!r.ok) {
        if (previous) register(previous)
        return r
      }
    }
    const stored = accelerator === DICTATION_DEFAULT_SHORTCUT ? null : accelerator
    await ctx.settings.set('dictation.shortcut', stored)
    return { ok: true, error: null }
  })

  ipcMain.on('dictation:suspend-shortcut' satisfies SendChannel, (e, p: { suspended?: unknown }) => {
    if (ctx.windows.kindOf(e.sender) !== 'main') return
    const next = p?.suspended === true
    if (next === suspended) return
    suspended = next
    hook.setSuspended(next)
    if (suspended) {
      unregister()
      unregisterRecord()
    } else if (armed) {
      register(effectiveShortcut())
      registerRecord(effectiveOf('recordToggle'))
    }
  })

  // ---------- the pill ----------

  ipcMain.on('dictation:audio' satisfies SendChannel, (e, p: { sessionId?: unknown; pcm?: unknown }) => {
    const pcm = asBuffer(p?.pcm)
    if (!pcm || typeof p?.sessionId !== 'string') return
    const chat = chats.get(p.sessionId)
    if (chat) {
      if (ctx.windows.kindOf(e.sender) === 'main') chat.recognizer.feed(pcm)
      return
    }
    const sess = session
    if (!sess || sess.id !== p.sessionId || sess.cancelled || ctx.windows.kindOf(e.sender) !== 'dictation-pill') return
    if (!sess.recognizer) {
      // Before the recognizer exists; at most ~60 s.
      if (sess.pending.length < 3_000) sess.pending.push(pcm)
    } else {
      sess.recognizer.feed(pcm)
      sess.writer?.append(pcm)
    }
    sess.audioBytes += pcm.length
    sess.meter.feed(pcm)
  })

  ipcMain.on('dictation:capture-event' satisfies SendChannel, (e, p: { sessionId?: unknown; type?: unknown; error?: unknown }) => {
    if (ctx.windows.kindOf(e.sender) !== 'dictation-pill') return
    const sess = session
    if (!sess || sess.id !== p?.sessionId) return
    if (p.type === 'error') {
      const err = (['mic_denied', 'mic_missing', 'mic_busy', 'mic_lost'] as DictationMicError[]).includes(p.error as DictationMicError)
        ? (p.error as DictationMicError)
        : 'mic_missing'
      void fail(sess, err)
    }
  })

  let lastClick = 0
  ipcMain.on('dictation:pill-action' satisfies SendChannel, (e, p: { action?: unknown; hovered?: unknown }) => {
    if (ctx.windows.kindOf(e.sender) !== 'dictation-pill') return
    switch (p?.action) {
      case 'hover': {
        hovered = p.hovered === true
        if (bar.enabled()) bar.hover(hovered)
        else livePill()?.setIgnoreMouseEvents(!hovered, { forward: true })
        return
      }
      case 'finish':
        void finish()
        return
      case 'cancel':
        void cancel('pill')
        return
      case 'show-settings': {
        setState({ kind: 'idle' })
        const main = showMainWindow() ?? ctx.windows.main()
        main?.webContents.send('settings:open' satisfies PushChannel, { section: 'voice-typing' })
        return
      }
      case 'click': {
        const now = Date.now()
        if (now - lastClick < 300) return
        lastClick = now
        if (state.kind === 'recording') void finish()
        else if (state.kind === 'error' && state.reason === 'mic_denied') {
          // The pill opens the microphone settings itself before sending the click.
          setState({ kind: 'idle' })
        } else if (state.kind === 'idle' || state.kind === 'empty') {
          startPress = now
          start('click')
          hook.sessionStartedElsewhere()
        }
        return
      }
    }
  })

  // ---------- the dictation bar ----------

  const ACTIONS: readonly DictationBarAction[] = ['dictate', 'record', 'notes', 'menu', 'snooze', 'hide', 'reset-position']
  ipcMain.handle('dictation-bar:action' satisfies InvokeChannel, (e, p: { action?: unknown; anchorX?: unknown }): InvokeRes<'dictation-bar:action'> => {
    if (ctx.windows.kindOf(e.sender) !== 'dictation-pill') throw notulaError('invalid-input', 'the bar only')
    const action = p?.action
    if (typeof action !== 'string' || !(ACTIONS as readonly string[]).includes(action)) throw notulaError('invalid-input', 'unknown action')
    const anchorX = typeof p.anchorX === 'number' && Number.isFinite(p.anchorX) ? p.anchorX : undefined
    bar.action(action as DictationBarAction, anchorX)
  })

  ipcMain.on('dictation-bar:menu-pick' satisfies SendChannel, (e, p: { id?: unknown }) => {
    if (ctx.windows.kindOf(e.sender) !== 'dictation-bar-menu') return
    bar.menuPick(typeof p?.id === 'string' ? p.id : null)
  })

  ipcMain.on('dictation-bar:hit-rects' satisfies SendChannel, (e, p: { rects?: unknown }) => {
    if (ctx.windows.kindOf(e.sender) !== 'dictation-pill' || !Array.isArray(p?.rects)) return
    bar.setRects(p.rects as { x: number; y: number; width: number; height: number }[])
  })

  ipcMain.on('dictation-bar:drag' satisfies SendChannel, (e, p: { phase?: unknown; screenX?: unknown }) => {
    if (ctx.windows.kindOf(e.sender) !== 'dictation-pill') return
    const phase = p?.phase
    if ((phase === 'start' || phase === 'move' || phase === 'end') && typeof p.screenX === 'number') bar.drag(phase, p.screenX)
  })

  // ---------- history ----------

  const shown = (a: DictationAttempt): boolean =>
    a.id !== session?.id && (!!a.text || a.has_audio || (a.status === 'recording' && a.created_at < sessionStartedAt) || a.status === 'failed')

  ipcMain.handle('dictation:history-list' satisfies InvokeChannel, async (): Promise<InvokeRes<'dictation:history-list'>> => {
    const rows = await ctx.storage.listDictationAttempts(200)
    return rows.filter(shown)
  })

  ipcMain.handle('dictation:history-delete' satisfies InvokeChannel, async (_e, p: { id: string }): Promise<InvokeRes<'dictation:history-delete'>> => {
    if (typeof p?.id !== 'string') throw notulaError('invalid-input', 'id is required')
    await ctx.storage.deleteDictationAttempts({ ids: [p.id] })
    historyChanged()
  })

  ipcMain.handle('dictation:history-clear' satisfies InvokeChannel, async (_e, p: { confirmed: true }): Promise<InvokeRes<'dictation:history-clear'>> => {
    if (p?.confirmed !== true) throw notulaError('invalid-input', 'confirmation is required')
    const rows = await ctx.storage.listDictationAttempts(1_000)
    const ids = rows.filter((a) => a.id !== session?.id).map((a) => a.id)
    if (ids.length) await ctx.storage.deleteDictationAttempts({ ids })
    historyChanged()
  })

  ipcMain.handle('dictation:history-retry' satisfies InvokeChannel, async (_e, p: { id: string }): Promise<InvokeRes<'dictation:history-retry'>> => {
    const row = typeof p?.id === 'string' ? await ctx.storage.getDictationAttempt(p.id) : null
    if (!row) throw notulaError('not-found', 'That dictation no longer exists.')
    if (!row.audio_key) throw notulaError('invalid-input', 'No audio is stored for this dictation.')
    const recognizer = ctx.speech.openRecognizer({
      purpose: 'dictation',
      choice: s('dictation.asr', 'auto'),
      language: row.language ?? language(),
      keyterms: buildKeyterms(s('dictation.dictionary', []), null, classifyTarget('', '')).keyterms
    })
    let raw = ''
    try {
      await recognizer.ready
      for await (const pcm of readFramed({ path: join(audioDir, row.id), key: Buffer.from(row.audio_key), id: row.id, allowTruncated: true })) {
        recognizer.feed(pcm)
      }
      raw = (await recognizer.finish()).text.trim()
    } catch (err) {
      recognizer.cancel()
      log('info', 'dictation:retry-failed', { reason: err instanceof RecognizerError ? err.reason : 'error' })
      throw notulaError('provider-error', 'Retry failed')
    }
    if (!raw) throw notulaError('provider-error', 'No speech was found. Try dictating again.')
    const formatted = await formatDictation(ctx, { raw, tone: null, hint: null, language: row.language, contextBlock: '', dictionary: s('dictation.dictionary', []) })
    const updated = await ctx.storage.updateDictationAttempt(row.id, { status: 'retried', text: formatted.text, failure_reason: null, audio_purge_at: null })
    historyChanged()
    return updated
  })

  // ---------- chat voice input ----------

  ipcMain.handle('dictation:chat-start' satisfies InvokeChannel, async (e): Promise<InvokeRes<'dictation:chat-start'>> => {
    if (ctx.windows.kindOf(e.sender) !== 'main') throw notulaError('invalid-input', 'chat voice input runs in the main window')
    const recognizer = ctx.speech.openRecognizer({ purpose: 'chat-voice', choice: s('dictation.asr', 'auto'), language: language(), keyterms: s('dictation.dictionary', []) })
    try {
      await recognizer.ready
    } catch (err) {
      recognizer.cancel()
      const reason = err instanceof RecognizerError ? err.reason : 'transcription_start'
      throw notulaError('provider-error', reason === 'offline' ? 'You’re offline' : reason === 'no-provider' ? 'Set up transcription in Settings ▸ AI first.' : 'Couldn’t start. Try again')
    }
    const sessionId = randomUUID()
    const timer = setTimeout(() => {
      const c = chats.get(sessionId)
      if (!c) return
      chats.delete(sessionId)
      c.recognizer.cancel()
      setActive(false)
      log('debug', 'dictation-auto-stopped')
    }, L.chatAutoStopMs + 5_000)
    chats.set(sessionId, { recognizer, timer })
    setActive(true)
    log('debug', 'dictation-began', { surface: 'chat' })
    return { sessionId }
  })

  ipcMain.handle('dictation:chat-stop' satisfies InvokeChannel, async (_e, p: { sessionId: string }): Promise<InvokeRes<'dictation:chat-stop'>> => {
    const c = typeof p?.sessionId === 'string' ? chats.get(p.sessionId) : undefined
    if (!c) throw notulaError('not-found', 'That voice input has ended.')
    chats.delete(p.sessionId)
    clearTimeout(c.timer)
    setActive(false)
    try {
      const r = await c.recognizer.finish()
      log('debug', 'dictation-sent', { surface: 'chat', chars: r.text.length })
      return { text: r.text.trim() }
    } catch {
      log('debug', 'dictation-failed', { surface: 'chat' })
      throw notulaError('provider-error', 'Couldn’t transcribe that. Try again')
    }
  })

  ipcMain.on('dictation:chat-cancel' satisfies SendChannel, (_e, p: { sessionId?: unknown }) => {
    const c = typeof p?.sessionId === 'string' ? chats.get(p.sessionId) : undefined
    if (!c) return
    chats.delete(p.sessionId as string)
    clearTimeout(c.timer)
    c.recognizer.cancel()
    setActive(false)
    log('debug', 'dictation-cancelled', { surface: 'chat' })
  })
}
