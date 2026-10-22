// SPDX-License-Identifier: Apache-2.0
// A series folder's series view: catalog order, watched %, pending and guessed flags, Import
// catalog, Duplicates with Merge, Ungroup. Shown on the folder page of a folder a series owns.
//
// - Lessons in catalog order (`sources:get-series`); an item without a note reads "Not watched".
//   Each watched lesson shows its watched % (span coverage over duration) and when it was last
//   watched. A lesson without a number shows "—" and "No number"; a number taken from the title
//   shows "Guessed". The notes the catalog doesn't cover follow.
// - Import catalog (course, playlist and custom series), Delete catalog, and Ungroup (an active
//   channel: its notes go back to Videos, through the sources core).
// - Duplicates: notes sharing a source, oldest first; Merge folds a newer one into the oldest.
// Nothing renders while Sources is off or the folder has no series. It follows `sources:changed`.

import { useCallback, useEffect, useMemo, useState, type JSX } from 'react'
import { parseError } from '@shared/errors'
import { formatPosition } from '@shared/lib/position'
import type { SeriesDetail, SeriesKind, SeriesLesson, SeriesListItem } from '@shared/types/sources'
import { navigate } from '../../../app/navigation'
import { showToast } from '../../../app/toast'
import { isMissingHandler, trySources, useSourcesStatus } from '../note/source-store'
import { ConfirmDialog, ImportCatalogDialog, MergeDialog, plural, type MergeCandidate } from './series-dialogs'
import './series.css'

/** Lessons shown before "Show all". */
const FIRST_ROWS = 12
const REFRESH_DELAY_MS = 250

const KIND_LABEL: Record<SeriesKind, string> = {
  course: 'Course',
  playlist: 'Playlist',
  channel: 'Channel',
  custom: 'Series'
}

type Load = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; item: SeriesListItem; detail: SeriesDetail }

type Dialog =
  | { kind: 'import' }
  | { kind: 'delete-catalog' }
  | { kind: 'ungroup' }
  | { kind: 'merge'; older: MergeCandidate; newer: MergeCandidate }
  | null

function formatDay(iso: string | null): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' })
}

function openNote(noteId: string): void {
  navigate(`/meeting/${encodeURIComponent(noteId)}?opened_from=list_page`)
}

function LessonRow({ lesson, showNumber }: { lesson: SeriesLesson; showNumber: boolean }): JSX.Element {
  const watched = lesson.noteId !== null
  const last = formatDay(lesson.lastWatchedAt)
  const flags: JSX.Element[] = []
  // A channel has no lesson numbers, so its videos carry no number flags.
  if (showNumber && watched && lesson.lessonState === 'pending') {
    flags.push(
      <span key="pending" className="series-flag series-flag--pending" title="Import a catalog to number this lesson">
        No number
      </span>
    )
  }
  if (showNumber && watched && lesson.lessonState === 'guessed') {
    flags.push(
      <span key="guessed" className="series-flag series-flag--guessed" title="Taken from the title. A catalog replaces it.">
        Guessed
      </span>
    )
  }
  const meta = [
    lesson.durationMs ? formatPosition(lesson.durationMs) : null,
    watched ? (lesson.watchedPercent !== null ? `${Math.round(lesson.watchedPercent)}% watched` : 'Watched') : 'Not watched',
    last ? `last ${last}` : null
  ].filter(Boolean)

  const body = (
    <>
      {showNumber ? <span className="series-lesson__number">{lesson.number ?? '—'}</span> : null}
      <span className="series-lesson__title">{lesson.title}</span>
      {flags}
      <span className="series-lesson__meta">{meta.join(' · ')}</span>
    </>
  )
  return (
    <li className={`series-lesson${watched ? '' : ' is-unwatched'}`}>
      {lesson.noteId ? (
        <button type="button" className="series-lesson__button" onClick={() => openNote(lesson.noteId as string)}>
          {body}
        </button>
      ) : (
        <div className="series-lesson__button is-static">{body}</div>
      )}
    </li>
  )
}

function Duplicates({ detail, onMerge }: { detail: SeriesDetail; onMerge(older: MergeCandidate, newer: MergeCandidate): void }): JSX.Element | null {
  const [notes, setNotes] = useState<Record<string, MergeCandidate>>({})
  const ids = useMemo(() => detail.duplicates.flatMap((d) => d.noteIds), [detail])

  useEffect(() => {
    let stale = false
    void Promise.all(ids.map((id) => window.notula.notes.get({ id }).catch(() => null))).then((rows) => {
      if (stale) return
      const next: Record<string, MergeCandidate> = {}
      for (const n of rows) if (n) next[n.id] = { noteId: n.id, title: n.title?.trim() || 'Untitled note', createdAt: n.created_at }
      setNotes(next)
    })
    return () => {
      stale = true
    }
  }, [ids])

  if (detail.duplicates.length === 0) return null
  return (
    <section className="series-dupes" aria-label="Duplicates">
      <h3 className="series-panel__subtitle">Duplicates</h3>
      <p className="series-dupes__hint">These notes are linked to the same video or lesson. Merge keeps the oldest note.</p>
      {detail.duplicates.map((group) => {
        const lesson = detail.lessons.find((l) => l.canonicalKey === group.canonicalKey)
        const [first, ...rest] = group.noteIds.map((id) => notes[id]).filter((n): n is MergeCandidate => !!n)
        return (
          <div key={group.canonicalKey} className="series-dupes__group">
            <p className="series-dupes__lesson">{lesson?.title ?? first?.title ?? 'Same source'}</p>
            <ul className="series-dupes__notes">
              {first ? (
                <li className="series-dupes__note">
                  <button type="button" className="series-dupes__open" onClick={() => openNote(first.noteId)}>
                    {first.title}
                  </button>
                  <span className="series-dupes__date">{formatDay(first.createdAt)} · oldest</span>
                </li>
              ) : null}
              {rest.map((n) => (
                <li key={n.noteId} className="series-dupes__note">
                  <button type="button" className="series-dupes__open" onClick={() => openNote(n.noteId)}>
                    {n.title}
                  </button>
                  <span className="series-dupes__date">{formatDay(n.createdAt)}</span>
                  {first ? (
                    <button type="button" className="n-btn n-btn--sm" aria-label={`Merge “${n.title}” into the oldest note`} onClick={() => onMerge(first, n)}>
                      Merge
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        )
      })}
    </section>
  )
}

export function SeriesFolderPanelView({ folderId }: { folderId: string }): JSX.Element | null {
  const { status } = useSourcesStatus()
  const enabled = !!status?.enabled
  const [load, setLoad] = useState<Load | null>(null)
  const [showAll, setShowAll] = useState(false)
  const [dialog, setDialog] = useState<Dialog>(null)

  const refresh = useCallback(async (): Promise<void> => {
    const list = await trySources('series-list-failed', () => window.notula.sources.listSeries())
    const item = list?.find((s) => s.folder_id === folderId) ?? null
    if (!item) {
      setLoad(null)
      return
    }
    try {
      const detail = await window.notula.sources.getSeries({ seriesId: item.id })
      setLoad(detail ? { status: 'ready', item, detail } : null)
    } catch (err) {
      setLoad(isMissingHandler(err) ? null : { status: 'error', message: parseError(err).message })
    }
  }, [folderId])

  useEffect(() => {
    setLoad(null)
    setShowAll(false)
    if (!enabled) return
    let timer: ReturnType<typeof setTimeout> | null = null
    void refresh()
    const off = window.notula.sources.onChanged(() => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => void refresh(), REFRESH_DELAY_MS)
    })
    return () => {
      off()
      if (timer) clearTimeout(timer)
    }
  }, [enabled, refresh])

  if (!enabled || !load) return null
  if (load.status === 'loading') return null
  if (load.status === 'error') {
    return (
      <section className="series-panel" aria-label="Series">
        <p className="series-panel__error" role="alert">
          Couldn’t load the lessons. {load.message}
        </p>
        <button type="button" className="n-btn n-btn--sm" onClick={() => void refresh()}>
          Try again
        </button>
      </section>
    )
  }

  const { item, detail } = load
  const series = detail.series
  const lessons = detail.lessons
  const watched = lessons.filter((l) => l.noteId !== null).length
  const lastWatched = formatDay(item.lastWatchedAt)
  const numbers = series.kind !== 'channel'
  const canImport = series.kind !== 'channel'
  const canUngroup = series.kind === 'channel' && series.state === 'active'
  const visible = showAll ? lessons : lessons.slice(0, FIRST_ROWS)
  const reload = (): void => void refresh()

  const summary = [
    KIND_LABEL[series.kind],
    item.catalogCount > 0 ? `${watched.toLocaleString()} of ${plural(lessons.length, 'lesson', 'lessons')} watched` : plural(item.noteCount, 'note', 'notes'),
    numbers && item.pendingCount > 0 ? `${item.pendingCount.toLocaleString()} without a number` : null,
    lastWatched ? `last watched ${lastWatched}` : null,
    series.state === 'paused' ? 'Paused' : null
  ].filter(Boolean)

  // Section headings appear where the section changes.
  let section: string | null = null
  const rows: JSX.Element[] = []
  for (const [i, lesson] of visible.entries()) {
    if (lesson.section && lesson.section !== section) {
      rows.push(
        <li key={`s-${i}`} className="series-section" aria-hidden="true">
          {lesson.section}
        </li>
      )
    }
    section = lesson.section
    rows.push(<LessonRow key={lesson.catalogItemId ?? lesson.noteId ?? `l-${i}`} lesson={lesson} showNumber={numbers} />)
  }

  return (
    <section className="series-panel" aria-label={`${KIND_LABEL[series.kind]}: ${series.title}`}>
      <header className="series-panel__head">
        <div className="series-panel__heading">
          <h2 className="series-panel__title">{numbers ? 'Lessons' : 'Videos'}</h2>
          <p className="series-panel__summary">{summary.join(' · ')}</p>
        </div>
        <div className="series-panel__actions">
          {canImport ? (
            <button type="button" className="n-btn n-btn--sm" onClick={() => setDialog({ kind: 'import' })}>
              Import catalog…
            </button>
          ) : null}
          {canImport && item.catalogCount > 0 ? (
            <button type="button" className="n-btn n-btn--sm n-btn--ghost" onClick={() => setDialog({ kind: 'delete-catalog' })}>
              Delete catalog…
            </button>
          ) : null}
          {canUngroup ? (
            <button type="button" className="n-btn n-btn--sm n-btn--ghost" onClick={() => setDialog({ kind: 'ungroup' })}>
              Ungroup…
            </button>
          ) : null}
        </div>
      </header>

      {lessons.length > 0 ? (
        <ul className="series-lessons" aria-label={numbers ? 'Lessons' : 'Videos'}>
          {rows}
        </ul>
      ) : (
        <p className="series-panel__empty">No lessons yet. Import a catalog to see the whole course in order.</p>
      )}
      {lessons.length > FIRST_ROWS ? (
        <button type="button" className="n-btn n-btn--sm n-btn--ghost series-panel__more" onClick={() => setShowAll((v) => !v)}>
          {showAll ? 'Show fewer' : `Show all ${lessons.length.toLocaleString()} lessons`}
        </button>
      ) : null}

      <Duplicates detail={detail} onMerge={(older, newer) => setDialog({ kind: 'merge', older, newer })} />

      {dialog?.kind === 'import' ? <ImportCatalogDialog series={series} catalogCount={item.catalogCount} onClose={() => setDialog(null)} onDone={reload} /> : null}
      {dialog?.kind === 'delete-catalog' ? (
        <ConfirmDialog
          title="Delete this catalog?"
          body={`The list of ${plural(item.catalogCount, 'lesson', 'lessons')} goes. Your notes and their lesson numbers stay.`}
          confirm="Delete catalog"
          busyLabel="Deleting…"
          danger
          action={async () => {
            await window.notula.sources.deleteCatalog({ seriesId: series.id, confirmed: true })
            showToast({ kind: 'success', title: 'Catalog deleted', durationMs: 3_000 })
            reload()
          }}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog?.kind === 'ungroup' ? (
        <ConfirmDialog
          title="Ungroup this channel?"
          body="Its notes move back to Videos, and new notes from this channel go there too. This folder stays."
          confirm="Ungroup"
          busyLabel="Ungrouping…"
          action={async () => {
            await window.notula.sources.ungroupSeries({ seriesId: series.id })
            showToast({ kind: 'success', title: 'Channel ungrouped', durationMs: 3_000 })
            reload()
          }}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog?.kind === 'merge' ? <MergeDialog older={dialog.older} newer={dialog.newer} onClose={() => setDialog(null)} onDone={reload} /> : null}
    </section>
  )
}
