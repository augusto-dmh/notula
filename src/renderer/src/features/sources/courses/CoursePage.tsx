// SPDX-License-Identifier: Apache-2.0
// A course page: header and menu, progress, Next lesson, the lessons in list order by section,
// Needs a lesson, Duplicates and Merge.
//
// - Drawn from one `sources:get-course` (the course view): no call per row.
// - The menu: Course settings, Export lessons…, Refresh from playlist (playlist courses), Remove from Courses.
//   Remove keeps notes, folder and lesson list, and its toast offers Undo.
// - A lesson row with a note opens the note; one without opens the lesson (in its course app
//   when the course has one).
// - Needs a lesson lists automatic notes whose lesson is pending or guessed, each with the picker.
// It follows `sources:courses-changed` and `sources:changed`, debounced.

import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import { formatPosition } from '@shared/lib/position'
import type { CourseView, SeriesLesson } from '@shared/types/sources'
import { IconCheck } from '../../../app/icons'
import { navigate } from '../../../app/navigation'
import { showToast } from '../../../app/toast'
import { IconDots } from '../../folders/icons'
import { ActionMenu, type ActionMenuAnchor, type ActionMenuEntry } from '../../note-page/ActionMenu'
import { Duplicates } from '../series/SeriesFolderPanel'
import { ImportCatalogDialog, MergeDialog, type MergeCandidate } from '../series/series-dialogs'
import { AddCourseSheet } from './AddCourseSheet'
import { exportLessons } from './export-lessons'
import { failure, lessonLabel, openLesson, plural, removeCourseWithUndo } from './helpers'
import { LessonPicker } from './LessonPicker'
import './courses.css'

const REFRESH_DELAY_MS = 250
/** Lessons shown before "Show all". */
const FIRST_ROWS = 40

type Load = { status: 'loading' } | { status: 'error'; message: string } | { status: 'gone' } | { status: 'ready'; view: CourseView }

type Dialog = { kind: 'settings' } | { kind: 'list' } | { kind: 'merge'; older: MergeCandidate; newer: MergeCandidate } | null

function openNote(noteId: string): void {
  navigate(`/meeting/${encodeURIComponent(noteId)}?opened_from=list_page`)
}

function LessonState({ lesson }: { lesson: SeriesLesson }): JSX.Element {
  if (lesson.noteId && lesson.finished) {
    return (
      <span className="course-lesson__state is-done">
        Notes <IconCheck size={13} />
      </span>
    )
  }
  if (lesson.noteId) {
    return <span className="course-lesson__state">{lesson.watchedPercent !== null ? `${Math.round(lesson.watchedPercent)}% watched` : 'Notes'}</span>
  }
  return <span className="course-lesson__state is-unwatched">Not watched</span>
}

function LessonRow({ seriesId, lesson }: { seriesId: string; lesson: SeriesLesson }): JSX.Element {
  const body = (
    <>
      <span className="series-lesson__number">{lesson.number ?? '—'}</span>
      <span className="series-lesson__title">{lesson.title}</span>
      <span className="course-lesson__meta">
        {lesson.durationMs ? <span className="course-lesson__duration">{formatPosition(lesson.durationMs)}</span> : null}
        <LessonState lesson={lesson} />
      </span>
    </>
  )
  const id = `course-lesson-${lesson.catalogItemId ?? lesson.noteId ?? lesson.title}`
  let action: (() => void) | null = null
  let hint: string | undefined
  if (lesson.noteId) {
    const noteId = lesson.noteId
    action = () => openNote(noteId)
    hint = 'Open the note'
  } else if (lesson.catalogItemId) {
    const itemId = lesson.catalogItemId
    action = () => void openLesson(seriesId, itemId)
    hint = 'Open the lesson'
  }
  return (
    <li className={`series-lesson course-lesson${lesson.noteId ? '' : ' is-unwatched'}`}>
      {action ? (
        <button type="button" id={id} className="series-lesson__button course-lesson__button" title={hint} onClick={action}>
          {body}
        </button>
      ) : (
        <div className="series-lesson__button course-lesson__button is-static">{body}</div>
      )}
    </li>
  )
}

function NeedsLesson({ view }: { view: CourseView }): JSX.Element | null {
  const [picking, setPicking] = useState<{ noteId: string; anchor: HTMLElement } | null>(null)
  if (view.needsLesson.length === 0) return null
  const titleOf = new Map(view.detail.lessons.filter((l) => l.noteId).map((l) => [l.noteId as string, l.title]))
  return (
    <section className="course-needs" aria-labelledby="course-needs-title">
      <h3 className="series-panel__subtitle" id="course-needs-title">
        Needs a lesson
      </h3>
      <ul className="course-needs__list">
        {view.needsLesson.map((n) => (
          <li key={n.noteId} className="course-needs__row">
            <button type="button" id={`course-needs-open-${n.noteId}`} className="course-needs__title" onClick={() => openNote(n.noteId)}>
              {titleOf.get(n.noteId) ?? 'Untitled note'}
            </button>
            <span className="course-needs__state">{n.state === 'guessed' && n.label ? `${n.label}?` : 'Not sure which lesson'}</span>
            <button
              type="button"
              id={`course-needs-pick-${n.noteId}`}
              className="n-btn n-btn--sm"
              aria-haspopup="dialog"
              aria-expanded={picking?.noteId === n.noteId}
              onClick={(e) => setPicking(picking?.noteId === n.noteId ? null : { noteId: n.noteId, anchor: e.currentTarget })}
            >
              Pick lesson
            </button>
          </li>
        ))}
      </ul>
      {picking ? <LessonPicker noteId={picking.noteId} seriesId={view.detail.series.id} anchor={picking.anchor} onClose={() => setPicking(null)} /> : null}
    </section>
  )
}

export function CoursePage({ seriesId }: { seriesId: string }): JSX.Element | null {
  const [load, setLoad] = useState<Load>({ status: 'loading' })
  const [dialog, setDialog] = useState<Dialog>(null)
  const [menu, setMenu] = useState<ActionMenuAnchor | null>(null)
  const [showAll, setShowAll] = useState(false)
  const menuButton = useRef<HTMLButtonElement>(null)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const view = await window.notula.sources.getCourse({ seriesId })
      setLoad(view ? { status: 'ready', view } : { status: 'gone' })
    } catch (err) {
      setLoad({ status: 'error', message: failure(err, 'load the course') })
    }
  }, [seriesId])

  useEffect(() => {
    setLoad({ status: 'loading' })
    setShowAll(false)
    let timer: ReturnType<typeof setTimeout> | null = null
    const later = (): void => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => void refresh(), REFRESH_DELAY_MS)
    }
    void refresh()
    const offCourses = window.notula.sources.onCoursesChanged(({ seriesIds }) => {
      if (seriesIds.length === 0 || seriesIds.includes(seriesId)) later()
    })
    const offChanged = window.notula.sources.onChanged(later)
    return () => {
      offCourses()
      offChanged()
      if (timer) clearTimeout(timer)
    }
  }, [seriesId, refresh])

  if (load.status === 'loading' || load.status === 'gone') return null
  if (load.status === 'error') {
    return (
      <section className="series-panel course-page" aria-label="Course">
        <p className="series-panel__error" role="alert">
          {load.message}
        </p>
        <button type="button" id="course-retry" className="n-btn n-btn--sm" onClick={() => void refresh()}>
          Try again
        </button>
      </section>
    )
  }

  const { view } = load
  const { detail } = view
  const series = detail.series
  const reload = (): void => void refresh()
  const total = detail.lessonsTotal
  const done = detail.lessonsWithNotes
  const percent = total > 0 ? Math.round((done / total) * 100) : 0
  const next = detail.nextLesson
  const listed = detail.lessons.filter((l) => l.catalogItemId !== null)
  const loose = detail.lessons.filter((l) => l.catalogItemId === null)
  const visible = showAll ? listed : listed.slice(0, FIRST_ROWS)

  const remove = (): void => void removeCourseWithUndo(series)

  const refreshList = async (): Promise<void> => {
    try {
      const r = await window.notula.sources.refreshCatalog({ seriesId })
      showToast({ kind: 'success', title: 'Lesson list refreshed', description: `${plural(r.items, 'lesson', 'lessons')}.`, durationMs: 4_000 })
      reload()
    } catch (err) {
      showToast({ kind: 'error', title: 'Couldn’t refresh the lesson list', description: failure(err, 'refresh the lesson list') })
    }
  }

  const entries: ActionMenuEntry[] = [
    { kind: 'item', id: 'course-settings', label: 'Course settings', onSelect: () => setDialog({ kind: 'settings' }) },
    { kind: 'item', id: 'course-export', label: 'Export lessons…', onSelect: () => void exportLessons(seriesId) },
    ...(series.kind === 'playlist'
      ? [{ kind: 'item' as const, id: 'course-refresh', label: 'Refresh from playlist', onSelect: () => void refreshList() }]
      : []),
    ...(total === 0 ? [{ kind: 'item' as const, id: 'course-add-list', label: 'Add lesson list…', onSelect: () => setDialog({ kind: 'list' }) }] : []),
    { kind: 'divider', id: 'course-divider' },
    { kind: 'item', id: 'course-remove', label: 'Remove from Courses', danger: true, onSelect: remove }
  ]

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
    rows.push(<LessonRow key={lesson.catalogItemId ?? `l-${i}`} seriesId={seriesId} lesson={lesson} />)
  }

  return (
    <section className="series-panel course-page" aria-label={`Course: ${series.title}`}>
      <header className="course-page__head">
        <div className="series-panel__heading">
          <h2 className="series-panel__title">{series.title}</h2>
          <p className="series-panel__summary">{view.playsIn ?? 'Not linked yet. Notula links it the first time a lesson plays.'}</p>
        </div>
        <button
          ref={menuButton}
          type="button"
          id="course-menu"
          className="n-icon-btn n-icon-btn--sm"
          aria-label="Course options"
          aria-haspopup="menu"
          aria-expanded={menu !== null}
          onClick={(e) => setMenu(menu ? null : { rect: e.currentTarget.getBoundingClientRect(), align: 'end' })}
        >
          <IconDots size={16} />
        </button>
      </header>

      {total > 0 ? (
        <div className="course-progress">
          <p className="course-progress__text">
            {done.toLocaleString()} of {plural(total, 'lesson', 'lessons')} with notes
          </p>
          <div className="course-progress__bar" role="progressbar" aria-label="Lessons with notes" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done}>
            <span style={{ width: `${percent}%` }} />
          </div>
        </div>
      ) : null}

      {next ? (
        <div className="course-next">
          <div className="course-next__text">
            <span className="course-next__label">Next lesson</span>
            <span className="course-next__title">
              {lessonLabel(null, next.number) ? `${lessonLabel(null, next.number)} · ` : ''}
              {next.title}
            </span>
          </div>
          <button type="button" id="course-open-next" className="n-btn n-btn--sm" onClick={() => void openLesson(seriesId, next.catalogItemId)}>
            Open lesson
          </button>
        </div>
      ) : null}

      <NeedsLesson view={view} />

      {listed.length > 0 ? (
        <ul className="series-lessons" aria-label="Lessons">
          {rows}
        </ul>
      ) : (
        <div className="course-page__empty">
          <p className="series-panel__empty">No lesson list yet. Add one to see the whole course in order.</p>
          <button type="button" id="course-add-list" className="n-btn n-btn--sm" onClick={() => setDialog({ kind: 'list' })}>
            Add lesson list…
          </button>
        </div>
      )}
      {listed.length > FIRST_ROWS ? (
        <button type="button" id="course-show-all" className="n-btn n-btn--sm n-btn--ghost series-panel__more" onClick={() => setShowAll((v) => !v)}>
          {showAll ? 'Show fewer' : `Show all ${listed.length.toLocaleString()} lessons`}
        </button>
      ) : null}

      {loose.length > 0 ? (
        <section aria-labelledby="course-loose-title">
          <h3 className="series-panel__subtitle" id="course-loose-title">
            Not in the lesson list
          </h3>
          <ul className="series-lessons">
            {loose.map((l, i) => (
              <LessonRow key={l.noteId ?? `n-${i}`} seriesId={seriesId} lesson={l} />
            ))}
          </ul>
        </section>
      ) : null}

      <Duplicates detail={detail} onMerge={(older, newer) => setDialog({ kind: 'merge', older, newer })} />

      {menu ? (
        <ActionMenu
          label="Course options"
          anchor={menu}
          entries={entries}
          owner={menuButton.current}
          onClose={(refocus) => {
            setMenu(null)
            if (refocus) menuButton.current?.focus()
          }}
        />
      ) : null}
      {dialog?.kind === 'settings' ? (
        <AddCourseSheet
          mode="settings"
          seriesId={seriesId}
          onClose={(r) => {
            setDialog(null)
            if (r) reload()
          }}
        />
      ) : null}
      {dialog?.kind === 'list' ? <ImportCatalogDialog series={series} catalogCount={0} lessonList onClose={() => setDialog(null)} onDone={reload} /> : null}
      {dialog?.kind === 'merge' ? <MergeDialog older={dialog.older} newer={dialog.newer} onClose={() => setDialog(null)} onDone={reload} /> : null}
    </section>
  )
}
