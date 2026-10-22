// SPDX-License-Identifier: Apache-2.0
// Home: "Coming up". Main runs the
// query (`calendar:upcoming`); this block renders the page, the header, the keys, the rows,
// Start now and the empty states, and re-queries on `calendar:changed`, `notes:changed` and
// each minute.

import { useCallback, useEffect, useMemo, useRef, useState, type JSX, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { UPCOMING_PAGE, type UpcomingEvent, type UpcomingPage } from '@shared/types/calendar'
import { IconCalendar, IconChevronLeft, IconSettings } from '../../app/icons'
import { navigate } from '../../app/navigation'
import { debugLog, isTextTarget } from '../../app/platform'
import { useCaptureState } from '../capture'
import { DemoComingUpRow } from '../demo'
import { NuxTip } from '../nux'
import { startNewNote } from '../new-note'
import { eventEndMs, eventStartMs, formatRange, qualifies, usePrefs } from './store'
import './calendar.css'

/** Opening a note saves the page; returning home restores it once. */
let rememberedPage: number | null = null

const SETTINGS_PATH = '/settings?section=calendar'

function localDateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function parseDateKey(key: string): Date {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1)
}

type RowStatus = 'transcribing' | 'now' | 'soon' | null

function statusOf(e: UpcomingEvent, now: number, transcribingNoteId: string | null): RowStatus {
  if (e.noteId && e.noteId === transcribingNoteId) return 'transcribing'
  const start = eventStartMs(e.event)
  const end = eventEndMs(e.event)
  if (start === null) return null
  if (start <= now && (end === null || end > now)) return 'now'
  if (start > now && start - now <= UPCOMING_PAGE.soonMs) return 'soon'
  return null
}

const PREFIX: Record<Exclude<RowStatus, null>, string> = { transcribing: 'Transcribing', now: 'Now', soon: 'Starting soon' }

function ChevronRight({ size = 16 }: { size?: number }): JSX.Element {
  return (
    <span style={{ display: 'inline-grid', transform: 'scaleX(-1)' }}>
      <IconChevronLeft size={size} />
    </span>
  )
}

export function UpcomingMeetings(): JSX.Element {
  const [page, setPage] = useState<number>(() => {
    const p = rememberedPage ?? 0
    rememberedPage = null
    return p
  })
  const [data, setData] = useState<UpcomingPage | null>(null)
  const [failed, setFailed] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const capture = useCaptureState()
  const prefs = usePrefs()
  const request = useRef(0)
  const pageRef = useRef(page)
  pageRef.current = page

  const load = useCallback(async (p: number): Promise<void> => {
    const id = ++request.current
    try {
      const next = await window.notula.calendar.upcoming({ page: p })
      if (id !== request.current) return
      setData(next)
      setFailed(false)
      setNow(Date.now())
      // A page that emptied out (events passed) steps back.
      if (p > 0 && next.dayGroups.every((g) => g.events.length === 0)) setPage((cur) => (cur === p ? p - 1 : cur))
    } catch (err) {
      if (id !== request.current) return
      setFailed(true)
      debugLog('coming-up-failed', { err: String(err) })
    }
  }, [])

  // Mounting asks for a refresh (`home-view`).
  useEffect(() => {
    void window.notula.calendar.refresh({ trigger: 'home-view' }).catch(() => undefined)
  }, [])

  useEffect(() => {
    void load(page)
  }, [load, page])

  // Re-query on `calendar:changed`, on note changes and on each minute boundary.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const soon = (): void => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => void load(pageRef.current), 150)
    }
    const offCalendar = window.notula.calendar.onChanged(soon)
    const offNotes = window.notula.notes.onChanged((c) => {
      if (c.tables.includes('documents') || c.tables.includes('note_panels') || c.tables.includes('calendar_events')) soon()
    })
    let minute: ReturnType<typeof setTimeout>
    const arm = (): void => {
      minute = setTimeout(() => {
        void load(pageRef.current)
        arm()
      }, 60_000 - (Date.now() % 60_000) + 50)
    }
    arm()
    return () => {
      offCalendar()
      offNotes()
      if (timer) clearTimeout(timer)
      clearTimeout(minute)
    }
  }, [load])

  const hasNext = data?.hasNextPage ?? false
  const anyListed = data?.hasAnyEvents ?? false

  // → / l, ← / h, t while home is shown and focus is not in a text field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || isTextTarget(e.target)) return
      if (document.querySelector('[role="dialog"], [aria-modal="true"]')) return
      if ((e.key === 'ArrowRight' || e.key === 'l') && hasNext) {
        e.preventDefault()
        setPage((p) => p + 1)
      } else if ((e.key === 'ArrowLeft' || e.key === 'h') && pageRef.current > 0) {
        e.preventDefault()
        setPage((p) => Math.max(0, p - 1))
      } else if (e.key === 't' || e.key === 'T') {
        if (pageRef.current !== 0) {
          e.preventDefault()
          setPage(0)
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [hasNext])

  const mine = useMemo(() => {
    const e = prefs?.['profile.email']?.trim().toLowerCase()
    return new Set(e ? [e] : [])
  }, [prefs])

  const rows = useMemo(() => (data ? data.dayGroups.flatMap((g) => g.events) : []), [data])
  /** The first row that can Start now gets the primary style. */
  const primaryStartId = useMemo(() => {
    for (const r of rows) {
      const s = statusOf(r, now, capture.transcribingNoteId)
      if ((s === 'now' || s === 'soon') && qualifies(r.event, mine)) return r.event.id
    }
    return null
  }, [rows, now, capture.transcribingNoteId, mine])

  const openRow = (e: UpcomingEvent): void => {
    rememberedPage = page
    if (e.noteId) {
      navigate(`/meeting/${encodeURIComponent(e.noteId)}?opened_from=homescreen_document`)
      return
    }
    debugLog('home-event-clicked')
    void startNewNote({ creationSource: 'home_event', event: e.event, autoTranscribe: false, openSource: 'home_event' })
  }

  const startNow = (e: UpcomingEvent): void => {
    rememberedPage = page
    debugLog('home-start-clicked')
    void startNewNote({ creationSource: 'home_start_button', event: e.event, autoTranscribe: true, openSource: 'home_start_button' })
  }

  const today = localDateKey(new Date(now))
  const todayLabel = new Date(now).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'long' })
  const pageEmpty = !!data && data.dayGroups.every((g) => g.events.length === 0)

  return (
    <section className="coming-up nt-upcoming" aria-labelledby="coming-up-heading">
      <div className="nt-upcoming__header">
        <h2 id="coming-up-heading" className="home__section-title nt-upcoming__title">
          Coming up
        </h2>
        <div className="nt-upcoming__tools">
          {page > 0 ? (
            <span className="n-tooltip" data-tooltip={`${todayLabel} · T`}>
              <button type="button" className="n-btn n-btn--ghost n-btn--sm" onClick={() => setPage(0)} aria-keyshortcuts="T">
                Today
              </button>
            </span>
          ) : null}
          {anyListed ? (
            <>
              <span className="n-tooltip" data-tooltip="Back · ←">
                <button
                  type="button"
                  className="n-icon-btn n-icon-btn--sm"
                  aria-label="Back"
                  disabled={page === 0}
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                >
                  <IconChevronLeft size={16} />
                </button>
              </span>
              <span className="n-tooltip" data-tooltip="Forward · →">
                <button type="button" className="n-icon-btn n-icon-btn--sm" aria-label="Forward" disabled={!hasNext} onClick={() => setPage((p) => p + 1)}>
                  <ChevronRight size={16} />
                </button>
              </span>
            </>
          ) : null}
          <span className="n-tooltip n-tooltip--end" data-tooltip="Calendar settings">
            <button type="button" className="n-icon-btn n-icon-btn--sm" aria-label="Calendar settings" onClick={() => navigate(SETTINGS_PATH)}>
              <IconSettings size={15} />
            </button>
          </span>
        </div>
      </div>

      {!data ? (
        failed ? (
          <div className="nt-upcoming__quiet">
            <IconCalendar size={16} /> Upcoming meetings couldn’t be loaded.
          </div>
        ) : (
          <div className="nt-upcoming__skeleton" aria-busy="true">
            <div className="n-skeleton" style={{ height: 44 }} />
            <div className="n-skeleton" style={{ height: 44 }} />
          </div>
        )
      ) : (
        <div className="nt-upcoming__days">
          {data.dayGroups.map((g) => (
            <DayGroup
              key={g.date}
              date={g.date}
              isToday={g.date === today}
              events={g.events}
              now={now}
              transcribingNoteId={capture.transcribingNoteId}
              primaryStartId={primaryStartId}
              mine={mine}
              lead={
                g.date === today && data.page === 0 ? (
                  <>
                    {/* The demo-meeting tip. */}
                    <NuxTip id="demo-meeting" />
                    <DemoComingUpRow demoStarted={prefs?.['onboarding.demoStarted'] !== false} />
                  </>
                ) : null
              }
              empty={
                g.events.length === 0 && g.date === today && data.page === 0 ? (
                  pageEmpty ? (
                    !data.hasSources || data.calendarError ? (
                      <div className="nt-upcoming__card">
                        <div>
                          <div className="nt-upcoming__card-title">Connect your calendar</div>
                          <div className="nt-upcoming__card-body">Connect a calendar to see your upcoming meetings here and start notes in one click.</div>
                        </div>
                        <button type="button" className="n-btn n-btn--sm" onClick={() => navigate(SETTINGS_PATH)}>
                          Connect calendar
                        </button>
                      </div>
                    ) : (
                      <div className="nt-upcoming__card">
                        <div>
                          <div className="nt-upcoming__card-title">No upcoming events</div>
                          <div className="nt-upcoming__card-body">Check your visible calendars</div>
                        </div>
                        <button type="button" className="n-btn n-btn--sm" onClick={() => navigate(SETTINGS_PATH)}>
                          Calendar settings
                        </button>
                      </div>
                    )
                  ) : (
                    <div className="nt-upcoming__none">{data.anyEarlierToday ? 'No more events today' : 'No events today'}</div>
                  )
                ) : null
              }
              onOpen={openRow}
              onStart={startNow}
            />
          ))}
        </div>
      )}
    </section>
  )
}

function DayGroup({
  date,
  isToday,
  events,
  now,
  transcribingNoteId,
  primaryStartId,
  mine,
  lead,
  empty,
  onOpen,
  onStart
}: {
  date: string
  isToday: boolean
  events: UpcomingEvent[]
  now: number
  transcribingNoteId: string | null
  primaryStartId: string | null
  mine: ReadonlySet<string>
  /** The demo row, first in today's group. */
  lead: JSX.Element | null
  empty: JSX.Element | null
  onOpen(e: UpcomingEvent): void
  onStart(e: UpcomingEvent): void
}): JSX.Element {
  const d = parseDateKey(date)
  return (
    <div className={`nt-day${isToday ? ' is-today' : ''}`}>
      <div className="nt-day__label" aria-label={d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}>
        <span className="nt-day__num">{d.getDate()}</span>
        <span className="nt-day__month">{d.toLocaleDateString(undefined, { month: 'long' })}</span>
        <span className="nt-day__weekday">{d.toLocaleDateString(undefined, { weekday: 'short' })}</span>
      </div>
      <div className="nt-day__rows">
        {lead}
        {events.length === 0
          ? empty
          : events.map((e) => (
              <EventRow
                key={e.event.id}
                item={e}
                now={now}
                transcribingNoteId={transcribingNoteId}
                primary={primaryStartId === e.event.id}
                mine={mine}
                onOpen={onOpen}
                onStart={onStart}
              />
            ))}
      </div>
    </div>
  )
}

function EventRow({
  item,
  now,
  transcribingNoteId,
  primary,
  mine,
  onOpen,
  onStart
}: {
  item: UpcomingEvent
  now: number
  transcribingNoteId: string | null
  primary: boolean
  mine: ReadonlySet<string>
  onOpen(e: UpcomingEvent): void
  onStart(e: UpcomingEvent): void
}): JSX.Element {
  const status = statusOf(item, now, transcribingNoteId)
  const highlighted = status === 'now' || status === 'soon'
  const start = eventStartMs(item.event)
  const end = eventEndMs(item.event)
  const title = typeof item.event.summary === 'string' && item.event.summary.trim() ? item.event.summary : 'Untitled'
  const canStart = highlighted && qualifies(item.event, mine)
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (e.target !== e.currentTarget) return
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onOpen(item)
    }
  }
  return (
    <div
      role="button"
      tabIndex={0}
      className={`nt-event${highlighted ? ' is-highlighted' : ''}`}
      onClick={() => onOpen(item)}
      onKeyDown={onKeyDown}
    >
      <span className="nt-event__bar" style={{ background: item.color }} aria-hidden="true" />
      <span className="nt-event__text">
        <span className="nt-event__title">{title}</span>
        <span className="nt-event__meta">
          {status ? (
            <>
              <span className={`nt-event__status nt-event__status--${status}`}>{PREFIX[status]}</span>
              <span aria-hidden="true"> · </span>
            </>
          ) : null}
          {start !== null ? formatRange(start, end) : null}
        </span>
      </span>
      {canStart ? (
        <button
          type="button"
          className={`n-btn n-btn--sm ${primary ? 'n-btn--primary' : 'nt-btn-soft'}`}
          onClick={(e) => {
            e.stopPropagation()
            onStart(item)
          }}
        >
          Start now
        </button>
      ) : null}
    </div>
  )
}
