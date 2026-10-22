// SPDX-License-Identifier: Apache-2.0
// Series and filing at creation.
//
// - Series, in order: the draft's playlist or course, else its channel (identification sets the
//   channel hint `youtube:channel:<lower-cased name>` for YouTube videos with no playlist or
//   course). The note is linked to its series whatever `sources.autoFile` says; filing needs it on.
// - Folders, two levels at most: a course or playlist gets a top-level folder. Channel folders
//   live under **Videos**, a top-level folder created on first use (`sources.videosFolder`). If
//   the user nests Videos inside another folder, channel folders go top-level. A paused channel
//   (ungrouped, or its folder deleted) files its videos into Videos itself; a paused course or
//   playlist files nothing.
// - Notula never renames, moves or deletes a user's folder. Series and folders are linked by id;
//   deleting a series folder pauses the series (storage trigger) and no folder is recreated.
// - Filing goes through add-to-folder with source `series_rule`.
// - Ungroup (a channel folder): its notes go back to Videos and the series is `paused`.
// - Rule offer: a source note filed by hand into another folder asks once per series: *File future
//   videos from <series> here?* Yes points the series at that folder.
// Writes are serialized, so two notes of a new series never create two folders. Logs carry counts.

import { notulaError } from '@shared/errors'
import type { Folder, FoldersState } from '@shared/types/folders'
import type { Settings } from '@shared/types/settings'
import type { CanonicalKey, LessonOrigin, LessonState, SeriesHint, SourceDraft, SourceSeries } from '@shared/types/sources'
import type { MainContext } from '../context'
import { log } from '../log'
import { resolveLesson } from './series'

const VIDEOS_TITLE = 'Videos'
/** The folders repo's title cap. */
const MAX_FOLDER_TITLE = 500
/** A larger batch in one change is an import or a merge, not someone filing by hand. */
const MANUAL_FILING_MAX = 5

export interface LessonFields {
  lesson_number: number | null
  lesson_label: string | null
  lesson_state: LessonState
  lesson_origin: LessonOrigin | null
}

/** The series a draft belongs to (playlist, course, custom, else its channel). */
export function seriesHintOf(draft: SourceDraft): SeriesHint | null {
  if (draft.series) return draft.series
  if (draft.provider === 'youtube' && draft.channel?.trim()) {
    const name = draft.channel.trim()
    return { kind: 'channel', provider: 'youtube', canonicalKey: `youtube:channel:${name.toLowerCase()}`, title: name, index: null, section: null }
  }
  return null
}

export function seriesKeyOf(draft: SourceDraft): CanonicalKey | null {
  return seriesHintOf(draft)?.canonicalKey ?? null
}

function folderTitle(t: string): string {
  const s = t.trim() || 'Untitled series'
  return s.length > MAX_FOLDER_TITLE ? s.slice(0, MAX_FOLDER_TITLE).trimEnd() : s
}

function seriesTitle(hint: SeriesHint, draft: SourceDraft): string {
  return hint.title?.trim() || (hint.kind === 'channel' ? draft.channel?.trim() : null) || draft.site || 'Untitled series'
}

/** The lesson a draft carries, as `note_sources` columns. */
function draftLesson(draft: SourceDraft, series: SourceSeries | null): LessonFields {
  const l = draft.lesson
  if (!l) return { lesson_number: null, lesson_label: null, lesson_state: 'pending', lesson_origin: null }
  const origin: LessonOrigin | null =
    l.state !== 'numbered' ? null : draft.detectedVia === 'extension' ? 'extension' : series?.kind === 'playlist' ? 'playlist' : 'catalog'
  return { lesson_number: l.number, lesson_label: l.label, lesson_state: l.state, lesson_origin: origin }
}

export class SourceFiling {
  private queue: Promise<unknown> = Promise.resolve()
  /** `<folderId>:<noteId>` memberships Notula added itself (not a hand filing). */
  private readonly own = new Set<string>()
  /** Folder → note ids, to see what a change added. Null until taken. */
  private membership: Map<string, Set<string>> | null = null
  private ruleCard = false

  constructor(
    private readonly ctx: MainContext,
    private readonly hooks: {
      settings(): Settings
      setSetting<K extends 'sources.videosFolder'>(key: K, value: Settings[K]): Promise<void>
      hintDismissed(hint: 'file-rule', key: string): boolean
      dismissHint(hint: 'file-rule', key: string): Promise<void>
    }
  ) {}

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn)
    this.queue = run.catch(() => undefined)
    return run
  }

  /** The draft's series (found or created) and the lesson fields, before the source is stored. */
  linkSeries(draft: SourceDraft): Promise<{ series: SourceSeries | null; lesson: LessonFields }> {
    return this.serial(async () => {
      const hint = seriesHintOf(draft)
      let series: SourceSeries | null = null
      if (hint) {
        const r = await this.ctx.storage.upsertSeries({ kind: hint.kind, provider: hint.provider, canonical_key: hint.canonicalKey, title: seriesTitle(hint, draft) })
        series = r.series
        if (r.created) log('info', 'sources:series-created', { kind: series.kind })
      }
      let lesson = draftLesson(draft, series)
      if (series && series.kind !== 'channel') {
        // The catalog wins over the draft's own number; a manual number is never touched here.
        const resolved = await resolveLesson(this.ctx, series.id, draft).catch((err: unknown) => {
          log('warn', 'sources:resolve-lesson-failed', { err })
          return null
        })
        if (resolved) lesson = { lesson_number: resolved.number, lesson_label: resolved.label, lesson_state: resolved.state, lesson_origin: resolved.origin }
      }
      return { series, lesson }
    })
  }

  /**
   * A series created before its name was known (a playlist is titled by the site until the lookup
   * reads the playlist) takes `title`, and so does its folder while the folder still has the old
   * name. A series or folder the user renamed is left alone.
   */
  nameSeries(seriesId: string, title: string, site: string | null): Promise<void> {
    return this.serial(async () => {
      const series = await this.ctx.storage.getSeries(seriesId)
      const next = title.trim()
      if (!series || !next || series.kind === 'channel') return
      const old = series.title.trim()
      if (old && old !== site && old !== 'Untitled series') return
      if (old === next) return
      await this.ctx.storage.updateSeries(seriesId, { title: next })
      if (series.folder_id) {
        const folder = (await this.ctx.storage.listFolders()).folders.find((f) => f.id === series.folder_id)
        if (folder && folder.title === folderTitle(old)) await this.ctx.storage.updateFolder(folder.id, { title: folderTitle(next) })
      }
      log('info', 'sources:series-named', { kind: series.kind })
    })
  }

  /** Files a new source note into its series' folder (creating it on first use). Null = not filed. */
  fileNote(noteId: string, series: SourceSeries | null): Promise<string | null> {
    return this.serial(async () => {
      const s = this.hooks.settings()
      if (!series || !s['sources.autoFile']) return null
      const current = await this.ctx.storage.getSeries(series.id)
      if (!current) return null
      const folders = await this.ctx.storage.listFolders()
      const folderId = await this.folderFor(current, folders, s)
      if (!folderId) return null
      this.own.add(`${folderId}:${noteId}`)
      await this.ctx.storage.addNotesToFolder(folderId, [noteId], 'series_rule')
      log('info', 'sources:filed', { kind: current.kind })
      return folderId
    })
  }

  private async folderFor(series: SourceSeries, state: FoldersState, s: Settings): Promise<string | null> {
    const byId = new Map(state.folders.map((f) => [f.id, f]))
    if (series.kind === 'channel') {
      const videos = await this.videosFolder(byId, s)
      if (series.state !== 'active') return videos?.id ?? null
      if (series.folder_id && byId.has(series.folder_id)) return series.folder_id
      // Channel folders go top-level when the user nested Videos.
      const parentId = videos && videos.parent_id === null ? videos.id : null
      const folder = await this.ctx.storage.createFolder({ title: folderTitle(series.title), parentId })
      await this.ctx.storage.updateSeries(series.id, { folder_id: folder.id })
      log('info', 'sources:series-folder-created', { kind: series.kind, nested: parentId !== null })
      return folder.id
    }
    if (series.state !== 'active') return null
    if (series.folder_id) return byId.has(series.folder_id) ? series.folder_id : null
    const folder = await this.ctx.storage.createFolder({ title: folderTitle(series.title) })
    await this.ctx.storage.updateSeries(series.id, { folder_id: folder.id })
    log('info', 'sources:series-folder-created', { kind: series.kind, nested: false })
    return folder.id
  }

  /** Videos, created on first use (again if the user deleted it). */
  private async videosFolder(byId: Map<string, Folder>, s: Settings): Promise<Folder | null> {
    const id = s['sources.videosFolder']
    const existing = id ? byId.get(id) : undefined
    if (existing) return existing
    const folder = await this.ctx.storage.createFolder({ title: VIDEOS_TITLE })
    byId.set(folder.id, folder)
    await this.hooks.setSetting('sources.videosFolder', folder.id)
    log('info', 'sources:videos-folder-created', {})
    return folder
  }

  /** Ungroup: a channel's notes go back to Videos, and the series is paused. */
  ungroup(seriesId: string): Promise<SourceSeries> {
    return this.serial(async () => {
      const series = await this.ctx.storage.getSeries(seriesId)
      if (!series) throw notulaError('not-found', 'No such series')
      if (series.kind === 'channel') {
        const notes = (await this.ctx.storage.listNoteSources({ seriesId })).map((n) => n.note_id)
        const folders = await this.ctx.storage.listFolders()
        const byId = new Map(folders.folders.map((f) => [f.id, f]))
        const videos = await this.videosFolder(byId, this.hooks.settings())
        if (videos && notes.length) {
          for (const n of notes) this.own.add(`${videos.id}:${n}`)
          await this.ctx.storage.addNotesToFolder(videos.id, notes, 'series_rule')
        }
        if (series.folder_id && byId.has(series.folder_id) && series.folder_id !== videos?.id) {
          const inFolder = new Set(folders.membership[series.folder_id] ?? [])
          for (const n of notes) if (inFolder.has(n)) await this.ctx.storage.removeNoteFromFolder(series.folder_id, n)
        }
        log('info', 'sources:ungrouped', { notes: notes.length })
      }
      return this.ctx.storage.pauseSeries(seriesId)
    })
  }

  // ---------- the rule offer ----------

  /** Takes the membership picture the rule offer compares against. */
  async start(): Promise<void> {
    try {
      const state = await this.ctx.storage.listFolders()
      this.membership = new Map(Object.entries(state.membership).map(([f, ids]) => [f, new Set(ids)]))
    } catch {
      this.membership = null
    }
  }

  stop(): void {
    this.membership = null
    this.own.clear()
  }

  /** `folder_notes` changed in these folders: a hand filing of a source note may ask the rule. */
  async foldersChanged(folderIds: string[]): Promise<void> {
    const before = this.membership
    if (!before) return
    const state = await this.ctx.storage.listFolders()
    const after = new Map(Object.entries(state.membership).map(([f, ids]) => [f, new Set(ids)]))
    this.membership = after
    for (const folderId of folderIds) {
      const was = before.get(folderId) ?? new Set<string>()
      const added = [...(after.get(folderId) ?? [])].filter((n) => !was.has(n))
      const manual = added.filter((n) => !this.own.delete(`${folderId}:${n}`))
      if (manual.length === 0 || manual.length > MANUAL_FILING_MAX) continue
      const folder = state.folders.find((f) => f.id === folderId)
      if (!folder) continue
      for (const noteId of manual) {
        if (await this.maybeOfferRule(noteId, folder)) return
      }
    }
  }

  private async maybeOfferRule(noteId: string, folder: Folder): Promise<boolean> {
    if (this.ruleCard) return false
    const source = await this.ctx.storage.getNoteSource(noteId)
    if (!source?.series_id) return false
    const series = await this.ctx.storage.getSeries(source.series_id)
    if (!series || series.folder_id === folder.id) return false
    if (series.kind === 'channel' && folder.id === this.hooks.settings()['sources.videosFolder']) return false
    if (this.hooks.hintDismissed('file-rule', series.id)) return false
    // Asked once per series, whatever the answer.
    await this.hooks.dismissHint('file-rule', series.id)
    this.ruleCard = true
    const noun = series.kind === 'course' ? 'lessons' : 'videos'
    log('info', 'sources:rule-offered', { kind: series.kind })
    this.ctx.notify.show({
      variant: 'info',
      title: `File future ${noun} here?`,
      body: `File future ${noun} from “${series.title}” in ${folder.title}.`,
      infoActions: [
        { id: 'yes', label: 'File here' },
        { id: 'no', label: 'Not now' }
      ],
      showDelayMs: 0,
      hideAfterMs: 60_000,
      quietWhileRecording: false,
      allowDuringOnboarding: false,
      lastMomentCheck: async () => {
        this.ruleCard = false
        return true
      },
      onAction: (a) => {
        this.ruleCard = false
        if (a !== 'info:yes') return
        void this.serial(() => this.ctx.storage.updateSeries(series.id, { folder_id: folder.id, state: 'active' }))
          .then(() => log('info', 'sources:rule-accepted', { kind: series.kind }))
          .catch((err: unknown) => log('warn', 'sources:rule-failed', { err }))
      }
    })
    return true
  }
}
