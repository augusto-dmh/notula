// SPDX-License-Identifier: Apache-2.0
// The end strip on a lesson's note, shown once per finish: Finished, how much was watched, Next
// lesson, and Generate notes when the course's `on_end` is `button`.
//
// - Only for a note of a course, once its lesson is finished (watched ≥ 90 %) and it isn't
//   recording. ✕ hides it until the lesson is finished again (a later watch).
// - Next ›: the lesson after this one in list order, opened in its course app when there is one.
// - Generate notes: `on_end = button` and no lesson notes yet. Update lesson notes: lesson notes
//   exist and the lesson was watched again after they were written. Neither runs by itself.

import { useEffect, useState, type JSX } from 'react'
import { formatPosition } from '@shared/lib/position'
import { SOURCES_LIMITS, type CourseNextLesson, type NoteSourceView } from '@shared/types/sources'
import { IconClose } from '../../../app/icons'
import { showToast } from '../../../app/toast'
import { flushStampedProjection } from '../../../editor/source-position'
import { useCaptureState } from '../../capture'
import { regenerate, usePanels } from '../../enhance'
import { useNoteGenerating } from '../../enhance/store'
import { usePrefs } from '../../settings/prefs-store'
import { isMac } from '../../../app/platform'
import { trySources } from '../note/source-store'
import { useCourses } from './courses-store'
import { failure, lessonLabel, openLesson } from './helpers'
import './courses.css'

const DISMISSED_KEY = 'courses.endStrip.dismissed'
const DISMISSED_MAX = 200

/** Finishes the user closed, by note: the last-watched time they closed it at. */
function readDismissed(): Record<string, string> {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? '{}')
    return v && typeof v === 'object' ? (v as Record<string, string>) : {}
  } catch {
    return {}
  }
}

function dismiss(noteId: string, at: string): void {
  try {
    const all = { ...readDismissed(), [noteId]: at }
    const keys = Object.keys(all)
    for (const k of keys.slice(0, Math.max(0, keys.length - DISMISSED_MAX))) delete all[k]
    localStorage.setItem(DISMISSED_KEY, JSON.stringify(all))
  } catch {
    // Storage full or unavailable: the strip just shows again next time.
  }
}

function useNoteSource(noteId: string, enabled: boolean): NoteSourceView | null {
  const [view, setView] = useState<NoteSourceView | null>(null)
  useEffect(() => {
    if (!enabled) {
      setView(null)
      return
    }
    let seq = 0
    const load = (): void => {
      const mine = ++seq
      void trySources('sources:get-for-note-failed', () => window.notula.sources.getForNote({ noteId })).then((v) => mine === seq && setView(v))
    }
    load()
    return window.notula.sources.onChanged(({ noteIds }) => {
      if (noteIds.includes(noteId)) load()
    })
  }, [noteId, enabled])
  return view
}

/** The lesson after this note's lesson, in list order. */
function useNextLesson(seriesId: string | null, noteId: string, enabled: boolean): CourseNextLesson | null {
  const [next, setNext] = useState<CourseNextLesson | null>(null)
  useEffect(() => {
    setNext(null)
    if (!enabled || !seriesId) return
    let alive = true
    void trySources('sources:get-series-failed', () => window.notula.sources.getSeries({ seriesId })).then((d) => {
      if (!alive || !d) return
      const listed = d.lessons.filter((l) => l.catalogItemId !== null)
      const i = listed.findIndex((l) => l.noteId === noteId)
      const n = i >= 0 ? listed[i + 1] : undefined
      setNext(n?.catalogItemId ? { catalogItemId: n.catalogItemId, number: n.number, title: n.title, url: n.url } : null)
    })
    return () => {
      alive = false
    }
  }, [seriesId, noteId, enabled])
  return next
}

export function EndStrip({ noteId }: { noteId: string }): JSX.Element | null {
  const prefs = usePrefs()
  const enabled = !isMac && prefs?.['sources.enabled'] === true
  const view = useNoteSource(noteId, enabled)
  const courses = useCourses()
  const capture = useCaptureState()
  const { panels } = usePanels(noteId)
  const generating = useNoteGenerating(noteId)
  const [closedAt, setClosedAt] = useState<string | null>(() => readDismissed()[noteId] ?? null)
  const [busy, setBusy] = useState(false)

  const course = view?.series ? (courses?.find((c) => c.id === view.series?.id) ?? null) : null
  const percent = view?.watched.percent ?? null
  const lastAt = view?.watched.lastWatchedAt ?? null
  const finished = percent !== null && percent >= SOURCES_LIMITS.finishedPercent
  const recording = capture.transcribingNoteId === noteId
  const visible = enabled && !!course && finished && !recording && !!lastAt && closedAt !== lastAt
  const next = useNextLesson(course?.id ?? null, noteId, visible)

  if (!visible || !view || !course || !lastAt) return null

  const duration = view.source.duration_ms
  const watchedMs = duration && percent !== null ? Math.round((duration * Math.min(100, percent)) / 100) : null
  const text = ['Finished', watchedMs !== null ? `${formatPosition(watchedMs)} watched (${Math.round(percent ?? 0)}%)` : `${Math.round(percent ?? 0)}% watched`].join(' · ')
  const latest = panels[0] ?? null
  const showGenerate = course.on_end === 'button' && panels.length === 0
  const showUpdate = !!latest && latest.created_at < lastAt
  const nextLabel = next ? (lessonLabel(null, next.number) ?? next.title) : null

  const generate = async (): Promise<void> => {
    setBusy(true)
    try {
      await flushStampedProjection(noteId)
      await window.notula.enhance.generate({ noteId })
    } catch (err) {
      showToast({ kind: 'error', title: 'Couldn’t generate notes', description: failure(err, 'generate notes') })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="course-end-dock">
      <div className="course-end" role="status" aria-label="Lesson finished">
        <span className="course-end__text">{text}</span>
        <span className="course-end__actions">
          {showGenerate ? (
            <button type="button" id="course-end-generate" className="n-btn n-btn--sm n-btn--primary" disabled={busy || generating} onClick={() => void generate()}>
              {generating ? 'Generating…' : 'Generate notes'}
            </button>
          ) : null}
          {showUpdate ? (
            <button type="button" id="course-end-update" className="n-btn n-btn--sm" disabled={generating} onClick={() => regenerate(noteId, latest?.id)}>
              {generating ? 'Updating…' : 'Update lesson notes'}
            </button>
          ) : null}
          {next ? (
            <button
              type="button"
              id="course-end-next"
              className="n-btn n-btn--sm n-btn--ghost course-end__next"
              title={next.title}
              onClick={() => void openLesson(course.id, next.catalogItemId)}
            >
              Next: {nextLabel} ›
            </button>
          ) : null}
          <button
            type="button"
            id="course-end-close"
            className="n-icon-btn n-icon-btn--sm"
            aria-label="Hide this until the lesson is finished again"
            onClick={() => {
              dismiss(noteId, lastAt)
              setClosedAt(lastAt)
            }}
          >
            <IconClose size={13} />
          </button>
        </span>
      </div>
    </div>
  )
}
