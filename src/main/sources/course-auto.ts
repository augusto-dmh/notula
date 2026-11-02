// SPDX-License-Identifier: Apache-2.0
// Courses automation in main: what a recognized playback leads to, and what follows.
//
// - Per eligible playback, from its recognition (`onCourseRecognized`), `decide()` (automation.ts):
//   an automatic start; card mode `course` (on_play = ask, or the device lock), `which-course`
//   (ambiguous), `link-capturing` (a hand-started meeting note captures) or `add-course` (a
//   course-like playback outside Courses); else today's offer. One automatic start per playback;
//   none again after Undo or Stop until its lesson key or title changes. Never in private windows,
//   during onboarding, or while another note captures.
// - The automatic start: continue the non-trashed note with the same lesson key (a new span and
//   a new transcript session), else create one (origin `course_auto`, source, course and lesson,
//   the Lesson template, filed in the course folder). A `pending` or `guessed` lesson never
//   continues another note. The plan (`coursePlan`): captions, video audio started now
//   (`audioSources: ['system']`), or `none` with its reason on the card. The `course-recording`
//   card lives 30 s and never takes focus. No window moves; the main window opens the note only
//   while it shows no note. Bus `sources:auto-started`.
// - Undo: a created note is deleted (not trashed) and its capture stops with `auto_undo`; a
//   continued note loses the new session (hidden as superseded). Allowed while the card lives, or
//   while the note has no user text. Stop: the capture stops, the note stays.
// - Link this note: the capturing hand-started note takes the source, lesson and folder (the
//   title only if it is empty), and its capture drops the microphone with no gap in system audio.
// - The next lesson of the same playback under on_play = record moves the capture to that
//   lesson's note; a playback that plays again after an end-of-watching stop continues its note.
// - `sources:open-lesson`: the course app at the lesson (`chrome_proxy.exe` / `msedge_proxy.exe`),
//   else the default browser. No other window is focused or moved.
// Logs: states, confidences, counts and reasons only.

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { shell } from 'electron'
import { notulaError } from '@shared/errors'
import type { PushChannel } from '@shared/ipc'
import type { NotificationAction } from '@shared/types/notify'
import type { Settings } from '@shared/types/settings'
import type {
  CatalogItem,
  CourseCardAction,
  CourseCardPayload,
  LessonState,
  NoteSource,
  Playback,
  Recognition,
  SourceCardAction,
  SourceDraft,
  SourceNoteRequest,
  SourceSeries
} from '@shared/types/sources'
import { GUESS_KEY_PREFIX, SOURCES_LIMITS } from '@shared/types/sources'
import type { MainContext } from '../context'
import { openSettingsSection } from '../lifecycle'
import { log } from '../log'
import { mapApp } from '../media/apps'
import { guessDraft } from '../media/match'
import { AutoSuppression, decide, isCourseLike, qualifiesForLink, type CapturingNote } from './automation'
import { courseRecognition, onCourseRecognized, type CourseRecognized } from './courses'
import type { SourceFeed } from './feed'
import type { LessonFields } from './filing'
import type { SourceOffers, Track } from './offer'
import { coursePlan, markSystemOnly } from './plan'
import { genericNames, isGenericTitle } from './recognize'
import { renderSourceTitle } from './titles'

/** Today's offer waits this long for a playback's course recognition. */
const RECOGNITION_WAIT_MS = 15_000
/** `sources:auto-started` waits this long for the capture's session id. */
const SESSION_WAIT_MS = 3_000

export interface CourseNoteRequest {
  draft: SourceDraft
  playbackId: string
  series: SourceSeries
  title: string
  lesson: LessonFields
  /** Continue this note; null creates one. */
  continueId: string | null
}

export interface CourseAutoHooks {
  settings(): Settings
  offers: SourceOffers
  feed: SourceFeed
  /** Creates (origin `course_auto`, filed, Lesson template) or continues the note. No window moves. */
  noteFor(req: CourseNoteRequest): Promise<{ noteId: string; source: NoteSource; created: boolean }>
  /** Links a lesson to a note that has no source (Link this note). */
  linkNote(noteId: string, req: Omit<CourseNoteRequest, 'continueId'>): Promise<NoteSource>
  /** Today's Take notes (Just this once). */
  requestNote(req: SourceNoteRequest): void
}

interface AutoNote {
  playbackId: string
  seriesId: string
  created: boolean
  /** The capture session this start opened, when known. */
  sessionId: string | null
  cardId: string | null
  cardUntil: number
  key: string
  title: string
}

/** The lesson's label as cards say it: "Aula 53", the item's title, or the number. */
function lessonLabel(rec: Recognition, item: CatalogItem | null): string {
  if (rec.lesson.label?.trim()) return rec.lesson.label.trim()
  if (rec.lesson.number !== null) return `Lesson ${rec.lesson.number}`
  return item?.title ?? 'this lesson'
}

function dateLabel(d: Date): string {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

/** The course app's launcher, from the browser's own install folders. */
function proxyPath(browser: 'chrome' | 'edge'): string | null {
  const env = process.env
  const roots =
    browser === 'chrome'
      ? [env['ProgramFiles'], env['ProgramFiles(x86)'], env['LOCALAPPDATA']].map((r) => (r ? join(r, 'Google', 'Chrome', 'Application', 'chrome_proxy.exe') : null))
      : [env['ProgramFiles(x86)'], env['ProgramFiles'], env['LOCALAPPDATA']].map((r) => (r ? join(r, 'Microsoft', 'Edge', 'Application', 'msedge_proxy.exe') : null))
  return roots.find((p): p is string => !!p && existsSync(p)) ?? null
}

export class CourseAutomation {
  private active = false
  private readonly suppression = new AutoSuppression()
  private readonly autoNotes = new Map<string, AutoNote>()
  /** The newest automatic note per playback. */
  private readonly byPlayback = new Map<string, string>()
  /** When the running capture started, and whether main started it (an automatic start). */
  private capture: { noteId: string; sessionId: string; at: number; byMain: boolean } | null = null
  private readonly mainStarts = new Set<string>()
  /** When today's offer first asked about a playback (the recognition wait). */
  private readonly firstAsked = new Map<string, number>()
  /** Playbacks a course card was already asked for, with the title it was asked for. */
  private readonly carded = new Map<string, string>()
  private readonly busy = new Set<string>()

  constructor(
    private readonly ctx: MainContext,
    private readonly hooks: CourseAutoHooks
  ) {
    onCourseRecognized((e) => void this.onRecognized(e).catch((err: unknown) => log('warn', 'sources:auto-decide-failed', { err })))
    ctx.bus.on('capture:started', ({ noteId, sessionId }) => {
      this.capture = { noteId, sessionId, at: Date.now(), byMain: this.mainStarts.delete(noteId) }
      const auto = this.autoNotes.get(noteId)
      if (auto && auto.sessionId === null) auto.sessionId = sessionId
    })
    ctx.bus.on('capture:stopped', ({ noteId }) => {
      if (this.capture?.noteId === noteId) this.capture = null
    })
  }

  setActive(on: boolean): void {
    this.active = on
    if (on) return
    this.suppression.clear()
    this.autoNotes.clear()
    this.byPlayback.clear()
    this.firstAsked.clear()
    this.carded.clear()
  }

  // ---------- today's offer ----------

  /** The offer's course gate (offer.ts `courseGate`). */
  courseGate(t: Track): 'wait' | 'skip' | 'go' {
    if (!this.active) return 'go'
    const rec = courseRecognition(t.playback.id)
    const courseLike = this.courseLike(t.playback, t)
    if (rec) return rec.confidence !== 'none' || courseLike ? 'skip' : 'go'
    const first = this.firstAsked.get(t.playback.id) ?? Date.now()
    this.firstAsked.set(t.playback.id, first)
    if (this.firstAsked.size > 200) this.firstAsked.delete(this.firstAsked.keys().next().value as string)
    if (Date.now() - first < RECOGNITION_WAIT_MS) return 'wait'
    // No recognition came (no course in Courses yet): a course-like playback still gets Add course.
    if (courseLike) {
      void this.decideFor(t.playback, { courseId: null, confidence: 'none', lesson: { itemId: null, number: null, label: null, state: 'pending', origin: null }, signals: [] }, false)
      return 'skip'
    }
    return 'go'
  }

  private courseLike(p: Playback, t: Track | null): boolean {
    return isCourseLike({ app: !!p.app, url: t?.draft?.url ?? p.url, site: t?.draft?.site ?? p.site }, this.hooks.settings()['sources.courseHosts'])
  }

  // ---------- the decision ----------

  private async onRecognized(e: CourseRecognized): Promise<void> {
    if (!this.active) return
    await this.decideFor(e.playback, e.recognition, e.immediate)
  }

  private async capturingNote(playbackId: string): Promise<CapturingNote | null> {
    const id = this.ctx.capture.currentNoteId()
    if (!id) return null
    const auto = this.autoNotes.get(id)
    if (auto) return { noteId: id, ownAuto: auto.playbackId === playbackId, linkable: false }
    const [note, source] = await Promise.all([this.ctx.storage.getNote(id).catch(() => null), this.ctx.storage.getNoteSource(id).catch(() => null)])
    const c = this.capture?.noteId === id ? this.capture : null
    const linkable = qualifiesForLink({ captureStartedAt: c?.at ?? null, byHand: !!c && !c.byMain, hasEvent: !!note?.linked_event, hasSource: source !== null }, Date.now())
    return { noteId: id, ownAuto: false, linkable }
  }

  private async decideFor(playback: Playback, rec: Recognition, immediate: boolean): Promise<void> {
    const pid = playback.id
    if (this.busy.has(pid)) return
    this.busy.add(pid)
    try {
      const series = rec.courseId ? await this.ctx.storage.getSeries(rec.courseId) : null
      const item = series && rec.lesson.itemId ? ((await this.ctx.storage.listCatalog(series.id)).find((i) => i.id === rec.lesson.itemId) ?? null) : null
      const track = this.hooks.offers.track(pid)
      const key = this.lessonKey(rec, item, track)
      const suppressed = !this.suppression.allowed(pid, key, playback.title) || (rec.confidence === 'ambiguous' && this.carded.get(pid) === playback.title)
      const capturing = await this.capturingNote(pid)
      const d = decide({
        recognition: rec,
        behavior: series?.registered_at ? { onPlay: series.on_play, onEnd: series.on_end } : null,
        courseLike: this.courseLike(playback, track),
        privateWindow: playback.app ? false : playback.privateWindow,
        onboarding: this.ctx.ui.inOnboarding(),
        locked: this.ctx.deviceLock.isLocked(),
        capturing,
        suppressed
      })
      log('info', 'sources:auto-decided', { decision: d.kind === 'card' ? d.mode : d.kind, reason: d.kind === 'nothing' ? d.reason : null, confidence: rec.confidence, lesson: rec.lesson.state, immediate })
      if (d.kind === 'auto-start' && series) {
        await this.autoStart(playback, rec, series, item, key, capturing?.ownAuto ? capturing.noteId : null)
      } else if (d.kind === 'card') {
        // One card per playback and title.
        if (this.carded.get(pid) === playback.title) return
        this.carded.set(pid, playback.title)
        this.askCard(d.mode, playback, rec, series, item, key, capturing)
      }
    } finally {
      this.busy.delete(pid)
    }
  }

  /** The lesson key for the one-start rule and for continuing: the item's, else the identified key. */
  private lessonKey(rec: Recognition, item: CatalogItem | null, track: Track | null): string {
    if (item?.canonical_key) return item.canonical_key
    const k = track?.draft?.canonicalKey
    if (k && !k.startsWith(GUESS_KEY_PREFIX)) return k
    return `${rec.courseId ?? 'none'}:${rec.lesson.itemId ?? rec.lesson.state}`
  }

  // ---------- the note ----------

  /** The draft of a lesson note: the identified draft (or a guess), filed into the course. */
  private draftFor(playback: Playback, rec: Recognition, series: SourceSeries, item: CatalogItem | null): SourceDraft {
    const track = this.hooks.offers.track(playback.id)
    const base = track?.draft ?? guessDraft(playback, playback.site)
    const realKey = item?.canonical_key ?? (base.canonicalKey.startsWith(GUESS_KEY_PREFIX) ? null : base.canonicalKey)
    return {
      ...base,
      canonicalKey: realKey ?? base.canonicalKey,
      url: item?.url ?? base.url,
      provider: base.provider === 'web' && series.provider !== 'web' ? series.provider : base.provider,
      kind: base.kind === 'live' ? 'live' : 'lesson',
      series: { kind: series.kind, provider: series.provider, canonicalKey: series.canonical_key, title: series.title, index: rec.lesson.number, section: item?.section ?? null },
      lesson: { number: rec.lesson.number, label: rec.lesson.label, state: rec.lesson.state },
      confidence: realKey ? (base.confidence === 'guess' ? 'high' : base.confidence) : base.confidence
    }
  }

  private noteTitle(rec: Recognition, series: SourceSeries, item: CatalogItem | null, draft: SourceDraft): string {
    if (rec.lesson.state !== 'numbered') return `${series.title} · ${dateLabel(new Date())}`
    // A playback whose own title names the lesson (YouTube): the clean source title.
    if (draft.provider === 'youtube') return renderSourceTitle(draft) || draft.title
    return item?.title ?? rec.lesson.label ?? (renderSourceTitle(draft) || draft.title)
  }

  private lessonFields(rec: Recognition): LessonFields {
    return { lesson_number: rec.lesson.number, lesson_label: rec.lesson.label, lesson_state: rec.lesson.state, lesson_origin: rec.lesson.state === 'numbered' ? rec.lesson.origin : null }
  }

  /** The note to continue: same lesson key; never for a `pending` or `guessed` lesson. */
  private async continueTarget(state: LessonState, draft: SourceDraft, series: SourceSeries, rec: Recognition): Promise<string | null> {
    if (state !== 'numbered') return null
    if (!draft.canonicalKey.startsWith(GUESS_KEY_PREFIX)) {
      return (await this.ctx.storage.findNotesBySource(draft.canonicalKey, { limit: 1 }).catch(() => []))[0]?.noteId ?? null
    }
    // A numbered lesson without a URL key: the course's note of that lesson.
    if (rec.lesson.number === null) return null
    const rows = await this.ctx.storage.listNoteSources({ seriesId: series.id }).catch(() => [])
    for (const r of rows.filter((x) => x.lesson_state === 'numbered' && x.lesson_number === rec.lesson.number).sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))) {
      const note = await this.ctx.storage.getNote(r.note_id).catch(() => null)
      if (note && !note.deleted_at) return note.id
    }
    return null
  }

  // ---------- the automatic start ----------

  private async autoStart(playback: Playback, rec: Recognition, series: SourceSeries, item: CatalogItem | null, key: string, switchFrom: string | null): Promise<void> {
    const pid = playback.id
    this.suppression.mark(pid, key, playback.title, 'started')
    const draft = this.draftFor(playback, rec, series, item)
    const title = this.noteTitle(rec, series, item, draft)
    const continueId = await this.continueTarget(rec.lesson.state, draft, series, rec)
    // Its note already records (a new title for the same lesson): nothing more, and no second card.
    if (continueId && continueId === this.ctx.capture.currentNoteId()) {
      log('info', 'sources:auto-start-skipped', { reason: 'already-recording' })
      return
    }
    const { noteId, created } = await this.hooks.noteFor({ draft, playbackId: pid, series, title, lesson: this.lessonFields(rec), continueId })
    const auto: AutoNote = { playbackId: pid, seriesId: series.id, created, sessionId: null, cardId: null, cardUntil: 0, key, title: playback.title }
    this.autoNotes.set(noteId, auto)
    this.byPlayback.set(pid, noteId)
    const { plan, blocked } = await coursePlan(this.ctx, noteId)
    let capturing = false
    if (plan === 'system-audio') {
      this.mainStarts.add(noteId)
      capturing = await this.ctx.capture.startFromMain(noteId, { audioSources: ['system'], switchFrom })
      if (!capturing) this.mainStarts.delete(noteId)
    } else {
      const cur = await this.ctx.storage.getNoteSource(noteId)
      if (cur?.transcript_plan === 'pending') await this.ctx.storage.updateNoteSource(noteId, { transcript_plan: plan })
      // The next lesson with captions: the previous lesson's capture ends.
      if (switchFrom && this.ctx.capture.currentNoteId() === switchFrom) await this.ctx.capture.stop('toggle_off')
    }
    log('info', 'sources:auto-started', { created, plan, blocked, capturing, lesson: rec.lesson.state, confidence: rec.confidence, next: switchFrom !== null })
    this.showRecordingCard(noteId, auto, lessonLabel(rec, item), series.title, plan, blocked)
    this.openIfIdle(noteId)
    const sessionId = plan === 'system-audio' && capturing ? await this.sessionOf(noteId) : null
    this.ctx.bus.emit('sources:auto-started', { noteId, seriesId: series.id, playbackId: pid, sessionId, created, confidence: rec.confidence, lessonState: rec.lesson.state })
  }

  private async sessionOf(noteId: string): Promise<string | null> {
    const until = Date.now() + SESSION_WAIT_MS
    while (Date.now() < until) {
      const s = this.autoNotes.get(noteId)?.sessionId
      if (s) return s
      await new Promise((r) => setTimeout(r, 100))
    }
    return null
  }

  /**
   * Only while the main window is visible and shows no note does it open the new one. Main can't
   * see the route, so "no note on screen" stands for Home, a folder or a course page here.
   */
  private openIfIdle(noteId: string): void {
    const win = this.ctx.windows.main()
    if (!win || win.isDestroyed() || !win.isVisible() || win.isMinimized() || this.ctx.ui.viewingNoteId() !== null) return
    win.webContents.send('deeplink:received' satisfies PushChannel, { type: 'show-note', data: { documentId: noteId, openSource: 'notification' } })
  }

  private showRecordingCard(noteId: string, auto: AutoNote, lesson: string, course: string, plan: CourseCardPayload['plan'], blocked: CourseCardPayload['blocked']): void {
    const payload: CourseCardPayload = { noteId, lesson, course, plan, blocked }
    const line =
      blocked === 'local-only'
        ? 'Transcription is blocked in local-only mode'
        : blocked === 'no-transcription'
          ? 'Transcription isn’t set up'
          : plan === 'captions'
            ? `${course} · captions`
            : `${course} · video audio`
    const id = this.ctx.notify.show({
      variant: 'course-recording',
      title: plan === 'none' ? `Notes for ${lesson}` : `Recording ${lesson}`,
      body: line,
      course: payload,
      showDelayMs: 0,
      hideAfterMs: SOURCES_LIMITS.courseCardLifetimeMs,
      quietWhileRecording: false,
      allowDuringOnboarding: false,
      onAction: (a) => this.onCourseCardAction(noteId, a)
    })
    auto.cardId = id
    auto.cardUntil = Date.now() + SOURCES_LIMITS.courseCardLifetimeMs
  }

  private onCourseCardAction(noteId: string, action: NotificationAction): void {
    if (!action.startsWith('course:')) return
    const a = action.slice('course:'.length) as CourseCardAction
    log('info', 'sources:course-card-action', { action: a })
    switch (a) {
      case 'undo':
        void this.undo(noteId, true).catch((err: unknown) => log('warn', 'sources:undo-failed', { err }))
        break
      case 'stop':
        void this.stop(noteId).catch((err: unknown) => log('warn', 'sources:stop-failed', { err }))
        break
      case 'open-note':
        this.showNote(noteId)
        break
      case 'set-up':
        // Transcription is set up in Settings ▸ AI.
        openSettingsSection('ai', 'course-card')
        break
    }
  }

  private showNote(noteId: string): void {
    const main = this.ctx.windows.main()
    if (!main || main.isDestroyed()) return
    if (main.isMinimized()) main.restore()
    main.show()
    main.webContents.send('deeplink:received' satisfies PushChannel, { type: 'show-note', data: { documentId: noteId, openSource: 'notification' } })
  }

  // ---------- Undo and Stop ----------

  /** `sources:undo-auto`, and the card's Undo. */
  async undo(noteId: string, fromCard = false): Promise<{ deleted: boolean }> {
    const auto = this.autoNotes.get(noteId)
    if (!auto) throw notulaError('invalid-input', 'This note didn’t start by itself, or it can’t be undone anymore.')
    const cardAlive = fromCard || Date.now() < auto.cardUntil
    if (!cardAlive) {
      const e = await this.ctx.storage.noteEmptiness(noteId)
      if (e && e.notes_text_length > 0) throw notulaError('invalid-input', 'This note has your notes now, so it can’t be undone.')
    }
    this.suppression.mark(auto.playbackId, auto.key, auto.title, 'undone')
    this.hooks.feed.forgetStopped(noteId)
    if (auto.cardId) this.ctx.notify.hide(auto.cardId)
    if (this.ctx.capture.currentNoteId() === noteId) await this.ctx.capture.stop('auto_undo')
    this.autoNotes.delete(noteId)
    if (this.byPlayback.get(auto.playbackId) === noteId) this.byPlayback.delete(auto.playbackId)
    if (auto.created) {
      // Deleted, not trashed: Trash first, since permanent deletion requires it.
      await this.ctx.storage.trashNote(noteId)
      await this.ctx.storage.deleteNotePermanently(noteId)
      log('info', 'sources:auto-undone', { created: true })
      return { deleted: true }
    }
    // A continued note loses only the new session: it is hidden from the transcript and prompts.
    const source = await this.ctx.storage.getNoteSource(noteId)
    if (source && auto.sessionId && !source.superseded_session_ids.includes(auto.sessionId)) {
      await this.ctx.storage.updateNoteSource(noteId, { superseded_session_ids: [...source.superseded_session_ids, auto.sessionId] })
    }
    log('info', 'sources:auto-undone', { created: false, session: auto.sessionId !== null })
    return { deleted: false }
  }

  /** The card's Stop: the capture stops, the note stays, and nothing restarts for this playback. */
  private async stop(noteId: string): Promise<void> {
    const auto = this.autoNotes.get(noteId)
    if (auto) this.suppression.mark(auto.playbackId, auto.key, auto.title, 'stopped')
    this.hooks.feed.forgetStopped(noteId)
    if (this.ctx.capture.currentNoteId() === noteId) await this.ctx.capture.stop('toggle_off')
  }

  // ---------- continuing after an end-of-watching stop ----------

  /** The feed saw a note's video play again after its end-of-watching stop. */
  async resumed(noteId: string, playbackId: string): Promise<void> {
    if (!this.active || this.ctx.capture.isCapturing() || this.ctx.ui.inOnboarding() || this.ctx.deviceLock.isLocked()) return
    const auto = this.autoNotes.get(noteId)
    const reason = auto ? this.suppression.reason(auto.playbackId) : null
    if (reason === 'undone' || reason === 'stopped') return
    const source = await this.ctx.storage.getNoteSource(noteId)
    const series = source?.series_id ? await this.ctx.storage.getSeries(source.series_id) : null
    if (!source || !series?.registered_at || series.on_play !== 'record' || source.transcript_plan === 'captions') return
    this.mainStarts.add(noteId)
    const ok = await this.ctx.capture.startFromMain(noteId, { audioSources: ['system'] })
    if (!ok) {
      this.mainStarts.delete(noteId)
      return
    }
    log('info', 'sources:auto-continued', {})
    const sessionId = auto ? await this.sessionOf(noteId) : null
    this.ctx.bus.emit('sources:auto-started', {
      noteId,
      seriesId: series.id,
      playbackId,
      sessionId,
      created: false,
      confidence: courseRecognition(playbackId)?.confidence ?? 'exact',
      lessonState: source.lesson_state
    })
  }

  // ---------- the asking cards ----------

  private askCard(
    mode: 'course' | 'add-course' | 'link-capturing' | 'which-course',
    playback: Playback,
    rec: Recognition,
    series: SourceSeries | null,
    item: CatalogItem | null,
    key: string,
    capturing: CapturingNote | null
  ): void {
    const pid = playback.id
    const lesson = series ? lessonLabel(rec, item) : null
    void (async () => {
      const candidates =
        mode === 'which-course'
          ? (await Promise.all((rec.candidates ?? []).slice(0, SOURCES_LIMITS.courseCandidates).map((id) => this.ctx.storage.getSeries(id))))
              .filter((s): s is SourceSeries => !!s)
              .map((s) => ({ seriesId: s.id, title: s.title }))
          : []
      this.hooks.offers.courseCard({
        playbackId: pid,
        mode,
        title: item?.title ?? playback.title,
        course: series?.title ?? null,
        lesson,
        candidates,
        key: this.hooks.offers.track(pid)?.draft?.canonicalKey ?? key,
        onAnswer: (a) => void this.onAnswer(a, mode, playback, rec, series, item, key, capturing, candidates).catch((err: unknown) => log('warn', 'sources:course-answer-failed', { err }))
      })
    })().catch((err: unknown) => log('warn', 'sources:course-card-failed', { err }))
  }

  private async onAnswer(
    a: SourceCardAction,
    mode: string,
    playback: Playback,
    rec: Recognition,
    series: SourceSeries | null,
    item: CatalogItem | null,
    key: string,
    capturing: CapturingNote | null,
    candidates: { seriesId: string; title: string }[]
  ): Promise<void> {
    const pid = playback.id
    if (a === 'record' && series) return this.autoStart(playback, rec, series, item, key, null)
    if (a === 'link-note' && series && capturing) {
      await this.link(capturing.noteId, pid)
      return
    }
    if (a === 'add-course') {
      // The Add course sheet, opened from this playback (the renderer's route).
      const main = this.ctx.windows.main()
      if (main && !main.isDestroyed()) {
        if (main.isMinimized()) main.restore()
        main.show()
        main.webContents.send('deeplink:received' satisfies PushChannel, { type: 'open', data: { path: `/courses/add?playback=${encodeURIComponent(pid)}` } })
      }
      return
    }
    if (a === 'just-once') {
      const draft = this.hooks.offers.track(pid)?.draft ?? guessDraft(playback, playback.site)
      this.hooks.requestNote({ draft, playbackId: pid, mode: 'new', noteId: null })
      return
    }
    if (a.startsWith('pick-course:') && mode === 'which-course') {
      const pick = candidates[Number(a.slice('pick-course:'.length))]
      if (pick) await this.pickCourse(playback, pick.seriesId)
      return
    }
    // Skip, Keep as is, Not a course: nothing more for this playback and title.
    this.suppression.mark(pid, key, playback.title, 'answered')
  }

  /** Which course is this?: the answer is the playback's course, and its title is learned when not generic. */
  private async pickCourse(playback: Playback, seriesId: string): Promise<void> {
    const series = await this.ctx.storage.getSeries(seriesId)
    if (!series?.registered_at || !series.match) return
    const title = playback.title.replace(/\s+/g, ' ').trim()
    const generic = genericNames({ app: playback.app ? { appUserModelId: playback.app.appUserModelId, mapping: null } : null, history: null, addressBar: null }, [...series.match.hosts, playback.app?.name ?? null])
    if (title && !isGenericTitle(title, generic) && !series.match.titles.includes(title)) {
      await this.ctx.storage.updateCourse(series.id, { match: { ...series.match, titles: [...series.match.titles, title].slice(-SOURCES_LIMITS.learnedTitles) } })
      log('info', 'sources:title-learned', { titles: Math.min(series.match.titles.length + 1, SOURCES_LIMITS.learnedTitles), via: 'which-course' })
    }
    const rec: Recognition = { courseId: series.id, confidence: 'title', lesson: { itemId: null, number: null, label: null, state: 'pending', origin: null }, signals: ['which-course'] }
    this.carded.delete(playback.id)
    await this.decideFor(playback, rec, false)
  }

  // ---------- Link this note ----------

  /** `sources:link-capturing-note`, and the card's Link this note. */
  async link(noteId: string, playbackId: string): Promise<NoteSource> {
    if (this.ctx.capture.currentNoteId() !== noteId) throw notulaError('invalid-input', 'That note isn’t recording anymore.')
    const capturing = await this.capturingNote(playbackId)
    // The card was offered while it qualified; a source or an event since then means no.
    const [note, existing] = await Promise.all([this.ctx.storage.getNote(noteId), this.ctx.storage.getNoteSource(noteId)])
    if (!note || note.deleted_at || existing || note.linked_event || capturing?.ownAuto) throw notulaError('invalid-input', 'This note can’t be linked to the lesson.')
    const rec = courseRecognition(playbackId)
    const track = this.hooks.offers.track(playbackId)
    const series = rec?.courseId ? await this.ctx.storage.getSeries(rec.courseId) : null
    if (!rec || !track || !series) throw notulaError('not-found', 'The lesson isn’t playing anymore.')
    const item = rec.lesson.itemId ? ((await this.ctx.storage.listCatalog(series.id)).find((i) => i.id === rec.lesson.itemId) ?? null) : null
    const draft = this.draftFor(track.playback, rec, series, item)
    const source = await this.hooks.linkNote(noteId, { draft, playbackId, series, title: this.noteTitle(rec, series, item, draft), lesson: this.lessonFields(rec) })
    // Video audio only: the microphone closes, system audio keeps flowing.
    const closed = this.ctx.capture.closeSource(noteId, 'microphone')
    markSystemOnly(noteId)
    const next = source.transcript_plan === 'system-audio' ? source : await this.ctx.storage.updateNoteSource(noteId, { transcript_plan: 'system-audio' })
    this.suppression.mark(playbackId, this.lessonKey(rec, item, track), track.playback.title, 'answered')
    log('info', 'sources:capturing-note-linked', { micClosed: closed, lesson: rec.lesson.state })
    return next
  }

  // ---------- Open lesson ----------

  /** `sources:open-lesson`: the course app at the lesson, else the default browser. */
  async openLesson(seriesId: string, catalogItemId: string): Promise<{ opened: 'app' | 'browser' | 'none' }> {
    const series = await this.ctx.storage.getSeries(seriesId)
    if (!series) throw notulaError('not-found', 'No such course')
    const item = (await this.ctx.storage.listCatalog(seriesId)).find((i) => i.id === catalogItemId)
    if (!item?.url || !/^https?:\/\//i.test(item.url)) {
      log('info', 'sources:open-lesson', { opened: 'none' })
      return { opened: 'none' }
    }
    const app = series.match?.apps[0]
    if (app) {
      const m = await mapApp(app.appUserModelId).catch(() => null)
      const exe = m?.state === 'mapped' && m.profile && m.appId ? proxyPath(m.browser) : null
      if (m && exe && m.profile && m.appId) {
        try {
          const child = spawn(exe, [`--profile-directory=${m.profile}`, `--app-id=${m.appId}`, `--app-launch-url-for-shortcuts-menu-item=${item.url}`], { detached: true, stdio: 'ignore' })
          child.on('error', (err) => log('warn', 'sources:open-lesson-failed', { name: err.name }))
          child.unref()
          log('info', 'sources:open-lesson', { opened: 'app', browser: m.browser })
          return { opened: 'app' }
        } catch (err) {
          log('warn', 'sources:open-lesson-failed', { name: err instanceof Error ? err.name : 'error' })
        }
      }
    }
    await shell.openExternal(item.url)
    log('info', 'sources:open-lesson', { opened: 'browser' })
    return { opened: 'browser' }
  }
}
