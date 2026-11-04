// SPDX-License-Identifier: Apache-2.0
// The lesson picker on a note's lesson label: the course's lessons in order, a search field, Not a
// lesson of this course, and Another course.
//
// - A lesson sets it (`numbered`, origin `manual`) through `sources:set-lesson`; main retitles
//   the note while its title is still the generated one, and remembers the pick by URL.
// - Not a lesson of this course takes the course and lesson off the source (the note goes Home).
// - Another course… lists the other courses; a pick moves the note there without a lesson.
// - Every change offers Undo in its toast, which sets the lesson back.
// A popover placed under its anchor and kept inside the window, so it fits the side window.
// Escape or a click outside closes it; arrow keys move through the list.

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX, type KeyboardEvent } from 'react'
import type { SeriesLesson } from '@shared/types/sources'
import { formatPosition } from '@shared/lib/position'
import { showToast } from '../../../app/toast'
import { byLastWatched, refreshCourses, useCourses } from './courses-store'
import { failure, lessonLabel } from './helpers'
import './courses.css'

export interface LessonPickerProps {
  noteId: string
  seriesId: string
  /** The label it opens from; the picker is placed under it. */
  anchor: HTMLElement | null
  onClose(): void
}

const WIDTH = 320
const EDGE = 8
const GAP = 6

type Load = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; lessons: SeriesLesson[]; current: SeriesLesson | null }

/** A row's number column: "Lesson 12". A lesson's label is its section, which heads its group. */
function rowLabel(l: SeriesLesson): string {
  return lessonLabel(null, l.number) ?? '—'
}

function matches(l: SeriesLesson, q: string): boolean {
  if (!q) return true
  const n = q.replace(/^#/, '')
  if (/^\d+$/.test(n)) return String(l.number ?? '') === n || l.title.toLowerCase().includes(q)
  return `${rowLabel(l)} ${l.title} ${l.section ?? ''}`.toLowerCase().includes(q)
}

/** Sets the lesson, with Undo back to what it was. */
async function setLesson(noteId: string, req: { itemId: string | null; seriesId?: string | null }, undo: { itemId: string | null; seriesId: string }, done: string): Promise<boolean> {
  try {
    await window.notula.sources.setLesson({ noteId, ...req })
    refreshCourses()
    // A lesson picked for a note that had none can't go back to "no lesson yet" in the same course.
    const undoable = req.itemId === null || !!req.seriesId || undo.itemId !== null
    showToast({
      kind: 'success',
      title: done,
      durationMs: 8_000,
      action: undoable
        ? {
            label: 'Undo',
            onClick: () =>
              void window.notula.sources
                .setLesson({ noteId, itemId: undo.itemId, seriesId: undo.seriesId })
                .then(refreshCourses)
                .catch((err: unknown) => showToast({ kind: 'error', title: 'Couldn’t undo', description: failure(err, 'undo') }))
          }
        : undefined
    })
    return true
  } catch (err) {
    showToast({ kind: 'error', title: 'Couldn’t change the lesson', description: failure(err, 'change the lesson') })
    return false
  }
}

export function LessonPicker({ noteId, seriesId, anchor, onClose }: LessonPickerProps): JSX.Element | null {
  const ref = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number; width: number; maxHeight: number } | null>(null)
  const [load, setLoad] = useState<Load>({ status: 'loading' })
  const [query, setQuery] = useState('')
  const [view, setView] = useState<'lessons' | 'courses'>('lessons')
  const [busy, setBusy] = useState(false)
  const courses = useCourses()

  useEffect(() => {
    let alive = true
    void window.notula.sources
      .getSeries({ seriesId })
      .then((d) => {
        if (!alive) return
        const lessons = (d?.lessons ?? []).filter((l) => l.catalogItemId !== null)
        const current = d?.lessons.find((l) => l.noteId === noteId && l.catalogItemId !== null) ?? null
        setLoad({ status: 'ready', lessons, current })
      })
      .catch((err: unknown) => alive && setLoad({ status: 'error', message: failure(err, 'load the lessons') }))
    return () => {
      alive = false
    }
  }, [seriesId, noteId])

  useLayoutEffect(() => {
    const place = (): void => {
      const r = anchor?.getBoundingClientRect()
      const width = Math.min(WIDTH, window.innerWidth - EDGE * 2)
      const left = Math.max(EDGE, Math.min((r?.left ?? EDGE) - 4, window.innerWidth - width - EDGE))
      const top = (r?.bottom ?? EDGE) + GAP
      setPos({ left, top, width, maxHeight: Math.max(180, window.innerHeight - top - EDGE) })
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [anchor])

  useEffect(() => {
    searchRef.current?.focus()
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Node
      if (!ref.current?.contains(t) && !anchor?.contains(t)) onClose()
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [anchor, onClose])

  const q = query.trim().toLowerCase()
  const shown = useMemo(() => (load.status === 'ready' ? load.lessons.filter((l) => matches(l, q)) : []), [load, q])
  const others = useMemo(() => byLastWatched((courses ?? []).filter((c) => c.id !== seriesId)), [courses, seriesId])

  const undoTo = { itemId: load.status === 'ready' ? (load.current?.catalogItemId ?? null) : null, seriesId }
  const run = async (req: { itemId: string | null; seriesId?: string | null }, done: string): Promise<void> => {
    setBusy(true)
    const ok = await setLesson(noteId, req, undoTo, done)
    setBusy(false)
    if (ok) {
      onClose()
      anchor?.focus()
    }
  }

  /** Up and down move between the picker's buttons; the search field leads into the list. */
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      if (view === 'courses') setView('lessons')
      else {
        onClose()
        anchor?.focus()
      }
      return
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    const items = Array.from(ref.current?.querySelectorAll<HTMLElement>('[data-pick]') ?? [])
    if (!items.length) return
    e.preventDefault()
    const i = items.indexOf(document.activeElement as HTMLElement)
    const next = e.key === 'ArrowDown' ? (i < 0 ? 0 : Math.min(items.length - 1, i + 1)) : i <= 0 ? -1 : i - 1
    if (next < 0) searchRef.current?.focus()
    else items[next]?.focus()
  }

  if (!pos) return null
  let section: string | null = null
  const current = load.status === 'ready' ? load.current : null

  return (
    <div
      ref={ref}
      className="lesson-picker"
      role="dialog"
      aria-label={view === 'lessons' ? 'Pick the lesson' : 'Move to another course'}
      style={{ left: pos.left, top: pos.top, width: pos.width, maxHeight: pos.maxHeight }}
      onKeyDown={onKeyDown}
    >
      {view === 'lessons' ? (
        <>
          <input
            ref={searchRef}
            id="lesson-picker-search"
            className="n-input lesson-picker__search"
            type="search"
            placeholder="Search lessons or type a number"
            aria-label="Search lessons"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && shown[0]?.catalogItemId) {
                e.preventDefault()
                void run({ itemId: shown[0].catalogItemId }, `Lesson set to ${rowLabel(shown[0])}`)
              }
            }}
          />
          <div className="lesson-picker__list" role="listbox" aria-label="Lessons">
            {load.status === 'loading' ? <p className="lesson-picker__note">Loading…</p> : null}
            {load.status === 'error' ? (
              <p className="lesson-picker__note" role="alert">
                {load.message}
              </p>
            ) : null}
            {load.status === 'ready' && load.lessons.length === 0 ? (
              <p className="lesson-picker__note">This course has no lesson list yet. Add one from the course page.</p>
            ) : null}
            {load.status === 'ready' && load.lessons.length > 0 && shown.length === 0 ? <p className="lesson-picker__note">No lessons match.</p> : null}
            {shown.map((l) => {
              const head =
                !q && l.section && l.section !== section ? (
                  <div key={`s-${l.catalogItemId}`} className="lesson-picker__section" aria-hidden="true">
                    {l.section}
                  </div>
                ) : null
              section = l.section
              const selected = current?.catalogItemId === l.catalogItemId
              return [
                head,
                <button
                  key={l.catalogItemId}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  id={`lesson-picker-item-${l.catalogItemId}`}
                  data-pick
                  disabled={busy}
                  className={`lesson-picker__item${selected ? ' is-current' : ''}`}
                  onClick={() => void run({ itemId: l.catalogItemId }, `Lesson set to ${rowLabel(l)}`)}
                >
                  <span className="lesson-picker__label">{rowLabel(l)}</span>
                  <span className="lesson-picker__title">{l.title}</span>
                  {l.durationMs ? <span className="lesson-picker__meta">{formatPosition(l.durationMs)}</span> : null}
                  {l.noteId && l.noteId !== noteId ? <span className="lesson-picker__meta">Has a note</span> : null}
                </button>
              ]
            })}
          </div>
          <div className="lesson-picker__foot">
            <button
              type="button"
              id="lesson-picker-not-a-lesson"
              data-pick
              disabled={busy}
              className="lesson-picker__action"
              onClick={() => void run({ itemId: null }, 'Removed from this course')}
            >
              Not a lesson of this course
            </button>
            <button type="button" id="lesson-picker-another-course" data-pick disabled={busy} className="lesson-picker__action" onClick={() => setView('courses')}>
              Another course…
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="lesson-picker__head">
            <button type="button" id="lesson-picker-back" className="n-btn n-btn--sm n-btn--ghost" onClick={() => setView('lessons')}>
              Back
            </button>
            <span className="lesson-picker__heading">Move to another course</span>
          </div>
          <div className="lesson-picker__list" role="listbox" aria-label="Courses">
            {others.length === 0 ? <p className="lesson-picker__note">No other courses yet. Add one from Courses in the sidebar.</p> : null}
            {others.map((c) => (
              <button
                key={c.id}
                type="button"
                role="option"
                aria-selected={false}
                id={`lesson-picker-course-${c.id}`}
                data-pick
                disabled={busy}
                className="lesson-picker__item"
                onClick={() => void run({ itemId: null, seriesId: c.id }, `Moved to ${c.title}`)}
              >
                <span className="lesson-picker__title">{c.title}</span>
                {c.playsIn ? <span className="lesson-picker__meta">{c.playsIn}</span> : null}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
