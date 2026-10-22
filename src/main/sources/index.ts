// SPDX-License-Identifier: Apache-2.0
// registerSources(): content sources in main.
//
// It owns the `sources:*` IPC not listed below (status, Recently played, create and continue,
// get, link, update, unlink, search, ungroup, grant, dismiss-hint), the first-use grant, the
// `source-detected` card and its own gates (offer.ts), filing at creation (filing.ts), the
// position feed and spans (feed.ts, spans.ts), the next item, and end of watching. It consumes bus
// `sources:playback`, calls `identify()`, `choosePlan()` and `renderSourceTitle()`, and publishes
// bus `sources:noted` and `sources:feed`.
//
// - Take notes / Continue: the card asks the renderer's new-note flow (`notes:new-requested` with
//   `source`), which calls `sources:create-note`. Main creates or continues the note, links the
//   source, files it, binds the feed, then in the background runs the lookups (when granted) and
//   asks the transcript plan (`choosePlan`). Choosing a plan never starts capture: the user
//   starts it, and a source note's capture is system audio only. A guess key never
//   continues a note without a confirm.
// - A source title change (a guess resolved, an edit) renames the note only while its title still
//   equals the title the source gave it.
// - `sources:changed` follows storage changes of the source tables; a write of the stamped
//   projection alone is not pushed back (the renderer wrote it, and it changes on every save).
//
// Nothing runs while `sources.enabled` is off or off Windows. Each part registers its own
// channels through the calls below; keep them. Logs: state names and counts only.

import { app, ipcMain } from 'electron'
import { notulaError } from '@shared/errors'
import type { InvokeChannel, InvokeRes, PushChannel } from '@shared/ipc'
import { peopleForNote } from '@shared/lib/people'
import type { ExtPage } from '@shared/types/extension-protocol'
import { parseSourceUrl } from '@shared/lib/source-key'
import type { CreationSource, NewNoteRequest } from '@shared/types/notes'
import type { Settings, SettingKey } from '@shared/types/settings'
import type {
  Grant,
  NoteSource,
  Playback,
  SourceConfidence,
  SourceDraft,
  SourceHint,
  SourceMute,
  SourceNoteRequest,
  SourcesStatus
} from '@shared/types/sources'
import type { MainContext } from '../context'
import { openSettingsSection, showMainWindow } from '../lifecycle'
import { log } from '../log'
import { detectorStatus, mediaFeed, onDetectorStatus } from '../media'
import { matchedFields } from '../media/match'
import type { NoteSourceUpdate } from '../storage/api'
import { egressBlocked } from '../privacy'
import { registerBackfill } from './backfill'
import { registerSourcesExtension } from './extension'
import { SourceFeed } from './feed'
import { SourceFiling, seriesKeyOf } from './filing'
import { identify, searchSources } from './identify'
import { isGuessKey, SourceOffers } from './offer'
import { choosePlan, registerTranscriptPlan } from './plan'
import { registerSeries } from './series'
import { renderSourceTitle } from './titles'
import { registerSourceTools, toolsStatus } from './tools'
import {
  createRequest,
  grantRequest,
  hintRequest,
  linkRequest,
  noteIdRequest,
  patchRequest,
  searchRequest,
  seriesIdRequest
} from './validate'

const NOTE_TABLES = ['note_sources', 'source_spans']
const SERIES_TABLES = ['source_series', 'series_catalog_items']
const FOLDER_MEMBERSHIP_TABLE = 'folder_notes'
/** Settings whose change moves `sources:get-status`. */
const STATUS_KEYS: readonly SettingKey[] = [
  'sources.enabled',
  'sources.detect',
  'sources.readHistory',
  'sources.onlineLookups',
  'sources.grantAsked',
  'sources.ytDlp',
  'privacy.localOnly'
]
const MAX_DISMISSED_HINTS = 500
/** A stamped-projection write is not pushed back while its change arrives within this time. */
const QUIET_STAMP_MS = 2_000
const CONFIDENCE_RANK: Record<SourceConfidence, number> = { guess: 0, high: 1, exact: 2 }

/** The stored `created_via` is the platform (as notes:create does). */
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

/** A draft whose URL a known provider recognises takes that provider's key. */
function normalizeDraft(d: SourceDraft): SourceDraft {
  const parsed = d.url ? parseSourceUrl(d.url) : null
  if (!parsed) return d
  return {
    ...d,
    canonicalKey: parsed.canonicalKey,
    provider: parsed.provider,
    url: parsed.url,
    kind: d.kind === 'lesson' || d.kind === 'live' ? d.kind : parsed.kind,
    site: d.site ?? parsed.host,
    series: d.series ?? parsed.series
  }
}

/** A playback for a lookup that didn't start from one (the Link dialog). Memory only. */
function playbackOf(d: SourceDraft, noteId: string): Playback {
  return {
    id: `manual:${noteId}`,
    provider: 'manual',
    browser: 'edge',
    tabKey: null,
    title: d.title,
    artist: d.channel,
    status: 'stopped',
    positionMs: null,
    durationMs: d.durationMs,
    rate: 1,
    updatedAt: Date.now(),
    live: d.live,
    ad: false,
    privateWindow: false,
    url: d.url,
    site: d.site,
    state: 'noted',
    playedMs: 0
  }
}

export function registerSources(ctx: MainContext): void {
  // Each part's own channels: tools, transcript plan, series, backfill, extension.
  registerSourceTools(ctx)
  registerTranscriptPlan(ctx)
  registerSeries(ctx)
  registerBackfill(ctx)
  registerSourcesExtension(ctx)

  const { storage, bus } = ctx
  const supported = process.platform === 'win32'
  let settings: Settings | null = null
  let active = false
  let extensionConnected = false
  /** The extension's course-page facts by tab, from the latest `media:extension` snapshot. */
  const extensionPages = new Map<string, ExtPage>()
  /** Notes whose last write was the stamped projection alone (not pushed back). */
  const quiet = new Map<string, number>()

  const current = (): Settings => {
    if (!settings) throw notulaError('storage-unavailable', 'Settings are not loaded yet')
    return settings
  }

  // ---------- settings writes (serialized: list settings are read-modify-write) ----------

  let settingsQueue: Promise<unknown> = Promise.resolve()
  function writeSettings(fn: (s: Settings) => Promise<void>): Promise<void> {
    const run = settingsQueue.then(async () => fn(await ctx.settings.getAll()))
    settingsQueue = run.catch(() => undefined)
    return run
  }

  const addToList = (key: 'sources.muted' | 'sources.dismissedHints', value: string, cap: number): Promise<void> =>
    writeSettings(async (s) => {
      const list = s[key] as string[]
      if (list.includes(value)) return
      const next = [...list, value].slice(-cap)
      await ctx.settings.set(key, next as Settings[typeof key])
    })

  const hintDismissed = (hint: SourceHint, key: string): boolean => !!settings?.['sources.dismissedHints'].includes(`${hint}:${key}`)

  async function setGrant(g: { readHistory?: boolean; onlineLookups?: boolean }): Promise<Grant> {
    await writeSettings(async () => {
      if (g.readHistory !== undefined) await ctx.settings.set('sources.readHistory', g.readHistory)
      if (g.onlineLookups !== undefined) await ctx.settings.set('sources.onlineLookups', g.onlineLookups)
      await ctx.settings.set('sources.grantAsked', true)
    })
    const s = await ctx.settings.getAll()
    log('info', 'sources:grant', { readHistory: s['sources.readHistory'], onlineLookups: s['sources.onlineLookups'] })
    return { readHistory: s['sources.readHistory'], onlineLookups: s['sources.onlineLookups'], asked: s['sources.grantAsked'] }
  }

  // ---------- the parts ----------

  const filing = new SourceFiling(ctx, {
    settings: current,
    setSetting: (key, value) => writeSettings(async () => void (await ctx.settings.set(key, value))),
    hintDismissed: (hint, key) => hintDismissed(hint, key),
    dismissHint: (hint, key) => addToList('sources.dismissedHints', `${hint}:${key}`, MAX_DISMISSED_HINTS)
  })

  // The feed and the offer reference each other through these late-bound views.
  let offers: SourceOffers | null = null
  const feed = new SourceFeed(ctx, {
    settings: current,
    tracks: () => offers?.current() ?? [],
    watchingEnded: (noteId) => void offerGenerate(noteId).catch((err: unknown) => log('warn', 'sources:generate-offer-failed', { err }))
  })
  offers = new SourceOffers(ctx, {
    settings: current,
    feed,
    requestNote,
    grant: async (allow) => void (await setGrant({ readHistory: allow, onlineLookups: allow })),
    mute: (m: SourceMute) => addToList('sources.muted', m, 200),
    openSettings: () => openSettingsSection('sources', 'source-card'),
    seriesKeyOf,
    pageOf: (p) => (p.tabKey && settings?.['sources.extension.coursePages'] ? (extensionPages.get(p.tabKey) ?? null) : null)
  })
  const offer = offers

  /** The card's Take notes / Continue / Switch note: the renderer's sources branch takes it. */
  function requestNote(req: SourceNoteRequest): void {
    const request: NewNoteRequest = { creationSource: 'video_detected', autoTranscribe: false, openSource: 'notification', source: req }
    const win = showMainWindow()
    if (!win || win.isDestroyed()) {
      log('warn', 'sources:note-request-no-window')
      return
    }
    const send = (): void => {
      if (!win.isDestroyed()) win.webContents.send('notes:new-requested' satisfies PushChannel, request)
    }
    if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send)
    else send()
    log('info', 'sources:note-requested', { mode: req.mode })
  }

  /** End of watching: the note offers Generate notes; a card when it isn't on screen. */
  async function offerGenerate(noteId: string): Promise<void> {
    if (ctx.ui.viewingNoteId() === noteId && ctx.ui.mainWindowFocused()) return
    const e = await storage.noteEmptiness(noteId)
    if (!e || e.deleted || (e.chunk_count === 0 && e.notes_text_length === 0)) return
    ctx.notify.show({
      variant: 'info',
      title: 'The video ended',
      body: 'Transcription stopped. Open the note to generate notes.',
      infoActions: [{ id: 'open', label: 'Open note' }],
      showDelayMs: 0,
      hideAfterMs: 60_000,
      quietWhileRecording: true,
      allowDuringOnboarding: false,
      onAction: (a) => {
        if (a !== 'info:open') return
        const main = showMainWindow()
        main?.webContents.send('deeplink:received' satisfies PushChannel, { type: 'show-note', data: { documentId: noteId, openSource: 'notification' } })
      }
    })
  }

  // ---------- status ----------

  function status(): SourcesStatus {
    const s = settings
    const enabled = !!s?.['sources.enabled'] && supported
    return {
      enabled,
      supported,
      detector: enabled && s?.['sources.detect'] ? detectorStatus() : { state: 'off', reason: null, lastStep: null },
      grant: { readHistory: !!s?.['sources.readHistory'], onlineLookups: !!s?.['sources.onlineLookups'], asked: !!s?.['sources.grantAsked'] },
      tools: toolsStatus(),
      extensionConnected
    }
  }

  function pushStatus(): void {
    const payload = status()
    for (const wc of ctx.windows.targets()) wc.send('sources:status-changed' satisfies PushChannel, payload)
  }

  function requireActive(): void {
    if (!active) throw notulaError('invalid-input', 'Sources is off')
  }

  function reconcile(): void {
    const want = supported && !!settings?.['sources.enabled']
    if (want === active) return
    active = want
    log('info', 'sources:active', { on: want })
    offer.setActive(want)
    feed.setActive(want)
    if (want) {
      void filing.start()
      // The provider may have published before we were on.
      offer.onSnapshot('media-session', mediaFeed.playbacks())
    } else {
      filing.stop()
      quiet.clear()
    }
  }

  async function loadSettings(): Promise<void> {
    settings = await ctx.settings.getAll()
    reconcile()
    pushStatus()
  }

  // ---------- creating, continuing and linking ----------

  async function fillPeople(noteId: string): Promise<void> {
    try {
      const [name, email, myEmails] = await Promise.all([ctx.settings.get('profile.name'), ctx.settings.get('profile.email'), ctx.calendar.myEmails()])
      const people = peopleForNote({ event: null, profile: { name: name.trim(), email: email.trim() }, myEmails })
      await storage.updateNote(noteId, { people })
    } catch (err) {
      log('warn', 'sources:people-fill-failed', { err })
    }
  }

  /** The `note_sources` row of a draft, with its series and lesson. */
  async function sourceRow(noteId: string, draft: SourceDraft, generatedTitle: string | null) {
    const { series, lesson } = await filing.linkSeries(draft)
    return {
      series,
      input: {
        note_id: noteId,
        kind: draft.kind,
        provider: draft.provider,
        canonical_key: draft.canonicalKey,
        url: draft.url,
        title: draft.title,
        channel: draft.channel,
        duration_ms: draft.durationMs,
        live: draft.live,
        series_id: series?.id ?? null,
        ...lesson,
        confidence: draft.confidence,
        detected_via: draft.detectedVia,
        generated_title: generatedTitle
      }
    }
  }

  /** The note follows its source's title while the user hasn't renamed it. */
  async function followTitle(noteId: string, before: NoteSource, after: NoteSource): Promise<void> {
    const title = renderSourceTitle({ title: after.title, channel: after.channel, provider: after.provider, site: null })
    if (!title || title === before.generated_title) return
    const note = await storage.getNote(noteId)
    if (!note || (note.title ?? '') !== (before.generated_title ?? '')) return
    await storage.updateNote(noteId, { title })
    await storage.updateNoteSource(noteId, { generated_title: title })
  }

  const URL_TITLE = /^https?:\/\//i

  /** Steps 5–7 of identification after Take notes, Continue or a link, when granted. */
  async function lookup(noteId: string, draft: SourceDraft, playbackId: string | null): Promise<void> {
    if (!current()['sources.onlineLookups']) return
    const playback = (playbackId ? offer.track(playbackId)?.playback : null) ?? playbackOf(draft, noteId)
    const result = await identify(ctx, playback, { stage: 'lookup', draft })
    const cur = await storage.getNoteSource(noteId)
    if (!result || !cur) return
    const d = normalizeDraft(result.draft)
    const better = CONFIDENCE_RANK[d.confidence] > CONFIDENCE_RANK[cur.confidence] || (CONFIDENCE_RANK[d.confidence] === CONFIDENCE_RANK[cur.confidence] && !cur.url && !!d.url)
    const patch: NoteSourceUpdate = {}
    if (d.canonicalKey !== cur.canonical_key && (better || isGuessKey(cur.canonical_key))) {
      Object.assign(patch, { canonical_key: d.canonicalKey, provider: d.provider, kind: d.kind, url: d.url, confidence: d.confidence, detected_via: d.detectedVia })
    } else if (better) {
      Object.assign(patch, { confidence: d.confidence, detected_via: d.detectedVia, ...(cur.url ? {} : { url: d.url }) })
    }
    // A link by URL stores the URL as its title until a lookup names the video.
    const placeholder = !cur.title.trim() || cur.title === cur.url || URL_TITLE.test(cur.title)
    if ((better || placeholder) && d.title && d.title !== cur.title && !URL_TITLE.test(d.title)) patch.title = d.title
    if (d.channel && !cur.channel) patch.channel = d.channel
    if (d.durationMs !== null && cur.duration_ms === null) patch.duration_ms = d.durationMs
    if (better && d.live !== cur.live) patch.live = d.live
    if (result.enrichment) patch.enrichment = result.enrichment
    // The series a source only shows once looked up (a channel for a link by URL): linked, not filed.
    if (!cur.series_id) {
      const { series, lesson } = await filing.linkSeries({ ...d, channel: patch.channel ?? cur.channel ?? d.channel })
      if (series) Object.assign(patch, { series_id: series.id }, cur.lesson_state === 'pending' && cur.lesson_number === null ? lesson : {})
    }
    // The playlist as yt-dlp reads it: its name, and the video's position, which beats the URL's
    // `index` (YouTube's URL said 4 for the 3rd item) and numbers a lesson
    // whose URL had none. A catalog or manual number is never touched.
    const pl = result.enrichment?.playlist
    if (pl && cur.series_id) {
      const unnumbered = cur.lesson_state === 'pending' && cur.lesson_number === null
      if (pl.index && (cur.lesson_origin === 'playlist' || unnumbered) && cur.lesson_number !== pl.index) {
        Object.assign(patch, { lesson_number: pl.index, lesson_state: 'numbered', lesson_origin: 'playlist' })
      }
      if (pl.title) await filing.nameSeries(cur.series_id, pl.title, d.site)
    }
    if (Object.keys(patch).length === 0) return
    const next = await storage.updateNoteSource(noteId, patch)
    log('info', 'sources:lookup-applied', { keyChanged: next.canonical_key !== cur.canonical_key, confidence: next.confidence, enriched: result.enrichment?.state ?? null })
    if (playbackId) offer.updateDraft(playbackId, d)
    if (next.canonical_key !== cur.canonical_key) feed.keyChanged(noteId)
    await followTitle(noteId, cur, next)
  }

  /** The transcript plan. A decision is stored while the row still says `pending`. */
  async function plan(noteId: string): Promise<void> {
    const source = await storage.getNoteSource(noteId)
    if (!source) return
    const decision = await choosePlan(ctx, source)
    log('info', 'sources:plan', { plan: decision.plan })
    if (decision.plan === 'pending') return
    const now = await storage.getNoteSource(noteId)
    if (now?.transcript_plan === 'pending') await storage.updateNoteSource(noteId, { transcript_plan: decision.plan })
  }

  function afterNoted(noteId: string, source: NoteSource, draft: SourceDraft, playbackId: string | null, created: boolean): void {
    if (playbackId) offer.noted(playbackId, noteId)
    feed.prefer(noteId, playbackId)
    bus.emit('sources:noted', { noteId, canonicalKey: source.canonical_key, playbackId, created })
    if (playbackId) {
      // Docked beside the browser, as the user's meeting placement allows.
      void ctx.windowModes.set('side', { focus: true, reason: 'join' }).catch((err: unknown) => log('warn', 'sources:dock-failed', { err }))
    }
    const enrichDone = source.enrichment?.state === 'done' && !isGuessKey(source.canonical_key)
    const background = async (): Promise<void> => {
      if (!enrichDone) await lookup(noteId, draft, playbackId).catch((err: unknown) => log('warn', 'sources:lookup-failed', { err }))
    }
    void plan(noteId).catch((err: unknown) => log('warn', 'sources:plan-failed', { err }))
    void background()
  }

  async function createNote(raw: unknown): Promise<InvokeRes<'sources:create-note'>> {
    requireActive()
    const r = createRequest(raw)
    const draft = normalizeDraft(r.draft)
    if (r.mode === 'continue') {
      if (isGuessKey(draft.canonicalKey)) throw notulaError('invalid-input', 'A guessed source can’t continue a note')
      const noteId = r.noteId as string
      const note = await storage.getNote(noteId)
      if (!note || note.deleted_at) throw notulaError('not-found', 'That note is no longer there')
      let source = await storage.getNoteSource(noteId)
      if (source && source.canonical_key !== draft.canonicalKey) throw notulaError('invalid-input', 'That note has another source')
      if (!source) source = await storage.createNoteSource((await sourceRow(noteId, draft, null)).input)
      log('info', 'sources:continued', { confidence: source.confidence })
      afterNoted(noteId, source, draft, r.playbackId, false)
      return { noteId, source, created: false }
    }
    const title = renderSourceTitle(draft) || draft.title
    const note = await storage.createNote({ origin: r.playbackId ? 'video_detected' : 'source_linked', title, created_via: creationSource() })
    let source: NoteSource
    let row: Awaited<ReturnType<typeof sourceRow>>
    try {
      row = await sourceRow(note.id, draft, title)
      source = await storage.createNoteSource(row.input)
    } catch (err) {
      // No half-made note: the note without its source goes to Trash.
      await storage.trashNote(note.id).catch(() => undefined)
      throw err
    }
    await fillPeople(note.id)
    await filing.fileNote(note.id, row.series).catch((err: unknown) => log('warn', 'sources:filing-failed', { err }))
    log('info', 'sources:created', { kind: source.kind, confidence: source.confidence, series: row.series?.kind ?? null })
    afterNoted(note.id, source, draft, r.playbackId, true)
    return { noteId: note.id, source, created: true }
  }

  async function link(raw: unknown): Promise<InvokeRes<'sources:link'>> {
    requireActive()
    const r = linkRequest(raw)
    let draft = normalizeDraft(r.draft)
    // A manual link with a URL is exact.
    if (draft.url) draft = { ...draft, confidence: 'exact', detectedVia: draft.detectedVia === 'search' || draft.detectedVia === 'extension' ? draft.detectedVia : 'manual' }
    const note = await storage.getNote(r.noteId)
    if (!note || note.deleted_at) throw notulaError('not-found', 'That note is no longer there')
    const before = await storage.getNoteSource(r.noteId)
    const title = renderSourceTitle(draft) || draft.title
    // An untitled note, or one still titled by its previous source, takes the new title.
    const takesTitle = !(note.title ?? '').trim() || (before !== null && (note.title ?? '') === (before.generated_title ?? ''))
    const { input } = await sourceRow(r.noteId, draft, takesTitle ? title : (before?.generated_title ?? null))
    const source = await storage.createNoteSource(input, { replace: true })
    if (takesTitle && note.title !== title) await storage.updateNote(r.noteId, { title })
    log('info', 'sources:linked', { replaced: before !== null, confidence: source.confidence })
    feed.sourcesChanged([r.noteId])
    void lookup(r.noteId, draft, null).catch((err: unknown) => log('warn', 'sources:lookup-failed', { err }))
    return source
  }

  async function update(raw: unknown): Promise<InvokeRes<'sources:update'>> {
    requireActive()
    const { noteId, patch } = patchRequest(raw)
    const keys = Object.keys(patch)
    if (keys.length === 1 && keys[0] === 'notes_md_stamped') quiet.set(noteId, Date.now())
    const cur = await storage.getNoteSource(noteId)
    if (!cur) throw notulaError('not-found', 'This note has no source')
    const full: NoteSourceUpdate = { ...patch }
    if (patch.lesson_number !== undefined) {
      // A number the user typed is manual and never overwritten.
      full.lesson_state = patch.lesson_number !== null ? 'numbered' : 'pending'
      full.lesson_origin = patch.lesson_number !== null ? 'manual' : null
    }
    if (patch.url !== undefined && patch.url !== null && patch.url !== cur.url) {
      const parsed = parseSourceUrl(patch.url)
      if (parsed) {
        Object.assign(full, { url: parsed.url, canonical_key: parsed.canonicalKey, provider: parsed.provider, kind: cur.kind === 'lesson' || cur.kind === 'live' ? cur.kind : parsed.kind })
      }
      Object.assign(full, { confidence: 'exact', detected_via: 'manual' })
    }
    if (patch.series_id && !(await storage.getSeries(patch.series_id))) throw notulaError('not-found', 'No such series')
    const next = await storage.updateNoteSource(noteId, full)
    if (next.canonical_key !== cur.canonical_key) feed.keyChanged(noteId)
    if (patch.title !== undefined && patch.title !== cur.title) await followTitle(noteId, cur, next)
    if (keys.some((k) => k !== 'notes_md_stamped')) log('info', 'sources:updated', { fields: keys.length })
    return next
  }

  // ---------- IPC ----------

  ipcMain.handle('sources:get-status' satisfies InvokeChannel, (): InvokeRes<'sources:get-status'> => status())

  ipcMain.handle('sources:list-playing' satisfies InvokeChannel, (): InvokeRes<'sources:list-playing'> => (active ? offer.playing() : []))

  ipcMain.handle('sources:create-note' satisfies InvokeChannel, (_e, req: unknown) => createNote(req))

  ipcMain.handle('sources:get-for-note' satisfies InvokeChannel, async (_e, req: unknown): Promise<InvokeRes<'sources:get-for-note'>> => {
    const { noteId } = noteIdRequest(req)
    if (!active) return null
    return storage.getNoteSourceView(noteId)
  })

  ipcMain.handle('sources:link' satisfies InvokeChannel, (_e, req: unknown) => link(req))

  ipcMain.handle('sources:update' satisfies InvokeChannel, (_e, req: unknown) => update(req))

  ipcMain.handle('sources:unlink' satisfies InvokeChannel, async (_e, req: unknown): Promise<InvokeRes<'sources:unlink'>> => {
    requireActive()
    const { noteId } = noteIdRequest(req)
    const removed = await storage.deleteNoteSource(noteId)
    log('info', 'sources:unlinked', { removed })
    feed.sourcesChanged([noteId])
  })

  ipcMain.handle('sources:search' satisfies InvokeChannel, async (_e, req: unknown): Promise<InvokeRes<'sources:search'>> => {
    requireActive()
    const { query } = searchRequest(req)
    if (!current()['sources.onlineLookups']) throw notulaError('invalid-input', 'Online lookups are off')
    if (await egressBlocked(ctx, { kind: 'source-lookup' })) throw notulaError('invalid-input', 'Local-only mode is on')
    const drafts = await searchSources(ctx, query)
    log('info', 'sources:searched', { results: drafts.length })
    return drafts.map((draft) => ({
      draft,
      matched: matchedFields({ id: draft.canonicalKey, url: draft.url ?? '', title: draft.title, channel: draft.channel, durationMs: draft.durationMs, live: draft.live }, { title: query })
    }))
  })

  ipcMain.handle('sources:ungroup-series' satisfies InvokeChannel, (_e, req: unknown): Promise<InvokeRes<'sources:ungroup-series'>> => {
    requireActive()
    return filing.ungroup(seriesIdRequest(req).seriesId)
  })

  ipcMain.handle('sources:grant' satisfies InvokeChannel, (_e, req: unknown): Promise<InvokeRes<'sources:grant'>> => {
    if (!supported) throw notulaError('invalid-input', 'Sources is not available here')
    return setGrant(grantRequest(req))
  })

  ipcMain.handle('sources:dismiss-hint' satisfies InvokeChannel, async (_e, req: unknown): Promise<InvokeRes<'sources:dismiss-hint'>> => {
    const { hint, key } = hintRequest(req)
    await addToList('sources.dismissedHints', `${hint}:${key}`, MAX_DISMISSED_HINTS)
  })

  // ---------- bus and storage ----------

  bus.on('settings:changed', ({ keys, settings: s }) => {
    settings = s
    if (keys.some((k) => k === 'sources.enabled')) reconcile()
    if (keys.some((k) => STATUS_KEYS.includes(k))) pushStatus()
  })

  bus.on('storage:status', (s) => {
    if (s.state === 'ready' && !settings) void loadSettings().catch((err: unknown) => log('warn', 'sources:settings-load-failed', { err }))
  })

  bus.on('sources:playback', ({ provider, playbacks }) => offer.onSnapshot(provider, playbacks))
  bus.on('ui:viewing-note', () => {
    if (active) feed.reselect()
  })
  bus.on('capture:started', () => {
    if (active) feed.captureChanged()
  })
  bus.on('capture:stopped', () => {
    if (active) feed.captureChanged()
  })
  bus.on('sources:mark', (e) => feed.mark(e))
  bus.on('media:extension', (snap) => {
    extensionPages.clear()
    for (const p of snap.pages) extensionPages.set(p.tab, p)
    const connected = snap.covered.length > 0
    if (connected === extensionConnected) return
    extensionConnected = connected
    pushStatus()
  })
  onDetectorStatus(() => pushStatus())

  let membershipQueue: Promise<void> = Promise.resolve()
  storage.onChange((change) => {
    if (!active) return
    const noteSide = change.tables.some((t) => NOTE_TABLES.includes(t))
    const seriesSide = change.tables.some((t) => SERIES_TABLES.includes(t))
    if (change.tables.includes(FOLDER_MEMBERSHIP_TABLE)) {
      const folderIds = change.ids
      membershipQueue = membershipQueue.then(() => filing.foldersChanged(folderIds)).catch((err: unknown) => log('warn', 'sources:rule-check-failed', { err }))
    }
    if (!noteSide && !seriesSide) return
    // Ids of one family each when only one changed; both lists otherwise (the renderer filters).
    let noteIds = noteSide ? change.ids : []
    const seriesIds = seriesSide ? change.ids : []
    if (noteSide) {
      const now = Date.now()
      const onlySources = change.tables.every((t) => t === 'note_sources')
      noteIds = noteIds.filter((id) => {
        const at = quiet.get(id)
        if (at === undefined) return true
        quiet.delete(id)
        return !(onlySources && now - at <= QUIET_STAMP_MS)
      })
      feed.sourcesChanged(noteIds)
    }
    if (noteIds.length === 0 && seriesIds.length === 0) return
    const payload = { noteIds, seriesIds }
    for (const wc of ctx.windows.targets()) wc.send('sources:changed' satisfies PushChannel, payload)
  })

  app.on('before-quit', () => void feed.shutdown().catch(() => undefined))

  void loadSettings().catch((err: unknown) => log('warn', 'sources:settings-load-failed', { err }))
}
