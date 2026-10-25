// SPDX-License-Identifier: Apache-2.0
// The calendar draft card: what `proposeEvent`
// proposed, editable in place (autosaved after 750 ms), and written to the calendar only when the
// user clicks Create event. A missing write permission opens the permission modal first.

import { useEffect, useMemo, useState, type JSX } from 'react'
import type { CalendarSource } from '@shared/types/calendar'
import type { CalendarEventDraft } from '@shared/types/workflow-blocks'
import { navigateToSettings } from '../../app/navigation'
import type { ToolCardProps } from '../../app/slots'
import { showToast } from '../../app/toast'
import { IconAlert, IconCalendar } from '../../app/icons'
import { blockIdOf, useBlock, useThreadBlocks } from '../blocks/useBlock'
import { openExternal } from '../integrations/store'
import { usePrefs } from '../settings/prefs-store'
import { PermissionModal, useOAuthSources } from './grants'
import {
  buildRepeat,
  cardReason,
  COLOR_CHOICES,
  isTimed,
  localDate,
  localTime,
  optionLabel,
  parseRepeat,
  repeatChoices,
  repeatLabel,
  startLabel,
  submitLabel,
  validLink,
  VISIBILITY_CHOICES,
  withRepeat,
  zonedIso,
  zoneLabel,
  type TimeOption
} from './rules'

const LOCAL_ONLY = 'Calendar changes are off while Local-only mode is on.'
const SAVE_FAILED = 'Couldn’t save your changes. Try again.'
const NO_ACCOUNT = 'Connect Google Calendar or Microsoft to create events.'
const LAST_TARGET_KEY = 'notula.calendarWrite.lastTarget'

function readLastTarget(): string | null {
  try {
    return localStorage.getItem(LAST_TARGET_KEY)
  } catch {
    return null
  }
}

function writeLastTarget(id: string): void {
  try {
    localStorage.setItem(LAST_TARGET_KEY, id)
  } catch {
    // A convenience only.
  }
}

/** What main found when an update moves the time: guests busy then, and calendars it couldn't read. */
interface MoveAvailability {
  checked: number
  unknown: string[]
  conflicts: { email: string; name: string }[]
}

const sameOption = (a: TimeOption | undefined | null, b: TimeOption | undefined | null): boolean => !!a && !!b && JSON.stringify(a) === JSON.stringify(b)

function chosen(d: CalendarEventDraft): TimeOption | null {
  return d.selectedTime ?? (d.timeOptions.length === 1 ? (d.timeOptions[0] ?? null) : null)
}

function summaryLine(d: CalendarEventDraft): string {
  const t = chosen(d)
  const first = d.attendees[0]?.email
  return [d.summary || 'Untitled event', t ? optionLabel(t) : null, first ? `${first}${d.attendees.length > 1 ? ` +${d.attendees.length - 1}` : ''}` : null].filter(Boolean).join(' · ')
}

/** A wall clock `HH:MM` of an instant in `tz`. */
function wallTime(ms: number, tz: string): { date: string; time: string } {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      .formatToParts(new Date(ms))
      .map((x) => [x.type, x.value])
  )
  return { date: `${p['year']}-${p['month']}-${p['day']}`, time: `${String(Number(p['hour']) % 24).padStart(2, '0')}:${p['minute']}` }
}

/** A new date, start or end for an option, in its own zone: date and start keep the duration. */
function retime(o: TimeOption, patch: { date?: string; start?: string; end?: string }): TimeOption {
  if (!isTimed(o.start) || !isTimed(o.end)) {
    const date = patch.date ?? localDate(o.start)
    return { start: { date }, end: { date: new Date(Date.parse(`${date}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10) } }
  }
  const tz = o.start.timeZone
  const dur = Date.parse(o.end.dateTime) - Date.parse(o.start.dateTime)
  if (patch.end !== undefined) {
    const date = localDate(o.start)
    let end = Date.parse(zonedIso(date, patch.end, tz))
    if (end <= Date.parse(o.start.dateTime)) end += 86_400_000
    const w = wallTime(end, tz)
    return { start: o.start, end: { dateTime: zonedIso(w.date, w.time, tz), timeZone: tz } }
  }
  const s = Date.parse(zonedIso(patch.date ?? localDate(o.start), patch.start ?? localTime(o.start), tz))
  const w = wallTime(s + dur, tz)
  return { start: { dateTime: zonedIso(patch.date ?? localDate(o.start), patch.start ?? localTime(o.start), tz), timeZone: tz }, end: { dateTime: zonedIso(w.date, w.time, tz), timeZone: tz } }
}

function GuestEditor({ value, onChange, disabled }: { value: CalendarEventDraft['attendees']; onChange(v: CalendarEventDraft['attendees']): void; disabled: boolean }): JSX.Element {
  const [text, setText] = useState('')
  const add = (): void => {
    const parts = text.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean)
    const valid = parts.filter((p) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p))
    if (!valid.length) return
    const have = new Set(value.map((a) => a.email.toLowerCase()))
    onChange([...value, ...valid.filter((v) => !have.has(v.toLowerCase())).map((email) => ({ email }))])
    setText('')
  }
  return (
    <div className="cw-guests">
      {value.length === 0 ? <span className="cw-muted">No guests</span> : null}
      {value.map((a) => (
        <span key={a.email} className="cw-chip">
          {a.resource ? 'Room · ' : ''}
          {a.email}
          {disabled ? null : (
            <button type="button" className="cw-chip__x" aria-label={`Remove ${a.email}`} onClick={() => onChange(value.filter((x) => x !== a))}>
              ×
            </button>
          )}
        </span>
      ))}
      {disabled ? null : (
        <input
          className="cw-guests__input"
          value={text}
          placeholder="Add guests"
          aria-label="Add guests"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault()
              add()
            } else if (e.key === 'Backspace' && !text && value.length) onChange(value.slice(0, -1))
          }}
          onBlur={add}
        />
      )}
    </div>
  )
}

function Field({ label, children }: { label: string; children: JSX.Element | JSX.Element[] | null | (JSX.Element | null)[] }): JSX.Element {
  return (
    <div className="cw-field">
      <span className="cw-field__label">{label}</span>
      <div className="cw-field__body">{children}</div>
    </div>
  )
}

export function CalendarDraftCard({ threadId, toolCall }: ToolCardProps): JSX.Element {
  const blockId = blockIdOf(toolCall.result)
  const h = useBlock<CalendarEventDraft>(blockId, 'calendar_event', SAVE_FAILED)
  const prefs = usePrefs()
  const { sources } = useOAuthSources()
  const siblings = useThreadBlocks(threadId, 'calendar_event')
  const [modalFor, setModalFor] = useState<string | null>(null)
  const [target, setTarget] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [palette, setPalette] = useState<Record<string, string>>({})

  const defaultTarget = useMemo((): CalendarSource | null => {
    const writable = sources.filter((s) => s.grants.includes('calendar-write'))
    const pool = writable.length ? writable : sources
    const last = readLastTarget()
    const profile = prefs?.['profile.email']?.toLowerCase() ?? ''
    return pool.find((s) => s.id === last) ?? pool.find((s) => !!profile && s.accountEmail?.toLowerCase() === profile) ?? pool[0] ?? null
  }, [sources, prefs])

  // The swatches follow the account the event is written to (an edit's own, else "Add to").
  const editCalendar = h.content?.existingEvent?.calendarId ?? null
  const writeSource = editCalendar ? (editCalendar.split(':')[1] ?? null) : (target ?? defaultTarget?.id ?? null)
  const writesToGoogle = editCalendar ? editCalendar.startsWith('google:') : sources.find((s) => s.id === writeSource)?.kind === 'google'
  useEffect(() => {
    if (!writeSource || !writesToGoogle) return
    let live = true
    window.notula.calendar
      .eventColors({ sourceId: writeSource })
      .then((p) => {
        if (live) setPalette(p)
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [writeSource, writesToGoogle])

  if (toolCall.error) {
    return (
      <div className="cw-card cw-card--quiet">
        <div className="cw-head">
          <IconCalendar size={15} />
          <span className="cw-head__title">Couldn’t draft the event</span>
        </div>
        <p className="cw-msg">{toolCall.error}</p>
      </div>
    )
  }
  if (!blockId || !h.content || !h.block) {
    return (
      <div className="cw-card cw-card--quiet" aria-busy="true">
        <div className="cw-head">
          <IconCalendar size={15} />
          <span className="cw-head__title">{h.error ?? 'Drafting event…'}</span>
        </div>
      </div>
    )
  }

  const d = h.content
  const block = h.block
  const ex = block.execution
  const status = ex?.status ?? null
  const isEdit = !!d.existingEvent
  const done = status === 'created' || status === 'updated'
  const dismissed = !!block.dismissed_at
  const locked = done || dismissed || status === 'creating' || h.busy
  const newest = siblings.length ? siblings[siblings.length - 1] : null
  const superseded = !!newest && newest.id !== block.id && !done && !dismissed
  const localOnly = !!prefs?.['privacy.localOnly']
  const targetSource = (target ? sources.find((s) => s.id === target) : null) ?? defaultTarget
  const microsoft = d.existingEvent ? d.existingEvent.calendarId.startsWith('microsoft:') : targetSource?.kind === 'microsoft'
  const conflicts = (toolCall.result as { conflicts?: string[][] } | null)?.conflicts ?? []
  const moved = (toolCall.result as { availability?: MoveAvailability } | null)?.availability ?? null
  const scope = d.existingEvent?.scope ?? null
  const first = d.timeOptions[0]
  const repeat = parseRepeat(d.recurrenceRules)
  const tz = first && isTimed(first.start) ? first.start.timeZone : null

  const set = (patch: Partial<CalendarEventDraft>): void => h.edit({ ...d, ...patch })
  const reason = localOnly ? LOCAL_ONLY : cardReason(d)

  const create = async (granted = false): Promise<void> => {
    if (!targetSource) return
    if (!isEdit && !granted && !targetSource.grants.includes('calendar-write')) {
      setModalFor(targetSource.id)
      return
    }
    const r = await h.execute(isEdit ? undefined : { targetSourceId: targetSource.id })
    if (!r) return
    writeLastTarget(targetSource.id)
    if (!r.failure) return
    if (r.failure.errorCode === 'missing_scopes') setModalFor(targetSource.id)
    else if (r.failure.errorCode === 'missing_token') showToast({ id: 'cw-reconnect', kind: 'error', title: 'Reconnect your calendar to continue.', action: { label: 'Settings', onClick: () => navigateToSettings('calendar') } })
    else if (r.failure.error && r.failure.errorCode !== 'unknown') showToast({ id: `cw-fail-${block.id}`, kind: 'error', title: r.failure.error })
    else if (!r.failure.error) showToast({ kind: 'error', title: 'Notula couldn’t update your calendar. Try again.' })
  }

  // ---------- finished and dismissed states ----------

  if (done || dismissed) {
    const link = typeof ex?.['htmlLink'] === 'string' ? ex['htmlLink'] : null
    const outlook = ex?.['provider'] === 'microsoft'
    return (
      <div className={`cw-card cw-card--done${dismissed ? ' is-dismissed' : ''}`} data-block-id={block.id}>
        <div className="cw-head">
          <IconCalendar size={15} />
          <span className="cw-head__title">{dismissed ? 'Dismissed' : status === 'updated' || isEdit ? 'Updated' : 'Scheduled'}</span>
          {link && !dismissed ? (
            <button type="button" className="cw-link" onClick={() => openExternal(link)}>
              {outlook ? 'Open in Outlook Calendar' : 'Open in Google Calendar'}
            </button>
          ) : null}
        </div>
        <p className="cw-summary">{summaryLine(d)}</p>
      </div>
    )
  }

  const failedTitle = status === 'unknown' ? 'Calendar event status unknown' : status === 'failed' ? (isEdit ? 'Calendar event not updated' : 'Calendar event not created') : null
  const many = sources.filter((s) => s.grants.includes('calendar-write')).length > 1 || (sources.length > 1 && !isEdit)

  return (
    <div className={`cw-card${superseded ? ' is-superseded' : ''}`} data-block-id={block.id}>
      <div className="cw-head">
        <IconCalendar size={15} />
        <span className="cw-head__title">{isEdit ? 'Change event' : 'New event'}</span>
        {superseded ? (
          <button
            type="button"
            className="cw-link"
            onClick={() => document.querySelector(`[data-block-id="${newest?.id ?? ''}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })}
          >
            Go to newest draft
          </button>
        ) : null}
      </div>
      {failedTitle ? (
        <div className={`cw-banner${status === 'unknown' ? ' cw-banner--warn' : ' cw-banner--error'}`} role="status">
          <IconAlert size={14} />
          <div>
            <strong>{failedTitle}</strong>
            {ex?.error ? <span>{ex.error}</span> : null}
          </div>
        </div>
      ) : null}

      <input className="cw-title" value={d.summary} placeholder="Untitled event" aria-label="Title" disabled={locked} onChange={(e) => set({ summary: e.target.value })} />

      <Field label={d.timeOptions.length > 1 ? 'Choose a time' : 'Time'}>
        <div className="cw-times" role="radiogroup" aria-label="Choose a time">
          {d.timeOptions.map((o, i) => {
            const on = sameOption(chosen(d), o)
            const busy = conflicts[i] ?? []
            return (
              <label key={i} className={`cw-time${on ? ' is-on' : ''}`}>
                {d.timeOptions.length > 1 ? (
                  <input type="radio" name={`cw-time-${block.id}`} checked={on} disabled={locked} onChange={() => set({ selectedTime: o })} />
                ) : null}
                <span className="cw-time__text">
                  {optionLabel(o)}
                  {zoneLabel(o) ? <span className="cw-muted"> · {zoneLabel(o)}</span> : null}
                </span>
                {busy.length ? <span className="cw-conflict">Conflicts with {busy[0]}{busy.length > 1 ? ` +${busy.length - 1}` : ''}</span> : null}
              </label>
            )
          })}
        </div>
        {(() => {
          const o = chosen(d)
          if (!o || locked) return null
          const idx = d.timeOptions.findIndex((x) => sameOption(x, o))
          const put = (next: TimeOption): void => {
            const opts = d.timeOptions.map((x, i) => (i === idx ? next : x))
            set({ timeOptions: opts, ...(d.selectedTime ? { selectedTime: next } : {}) })
          }
          return (
            <div className="cw-time-edit">
              <input type="date" className="n-input cw-in" aria-label="Date" value={localDate(o.start)} onChange={(e) => e.target.value && put(retime(o, { date: e.target.value }))} />
              {isTimed(o.start) ? (
                <>
                  <input type="time" className="n-input cw-in" aria-label="Start" value={localTime(o.start)} onChange={(e) => e.target.value && put(retime(o, { start: e.target.value }))} />
                  <span className="cw-muted">–</span>
                  <input type="time" className="n-input cw-in" aria-label="End" value={localTime(o.end)} onChange={(e) => e.target.value && put(retime(o, { end: e.target.value }))} />
                </>
              ) : (
                <span className="cw-muted">All day</span>
              )}
            </div>
          )
        })()}
        {moved && !locked ? (
          <div className="cw-availability">
            {moved.conflicts.slice(0, 5).map((c) => (
              <span key={c.email} className="cw-conflict">
                Busy then: {c.name}
              </span>
            ))}
            {moved.unknown.length ? (
              <span className="cw-muted">
                Couldn’t see {moved.unknown.length} {moved.unknown.length === 1 ? 'guest’s calendar' : 'guests’ calendars'}.
              </span>
            ) : null}
          </div>
        ) : null}
      </Field>

      {(!isEdit || scope === 'series' || scope === 'following') && first && d.timeOptions.length === 1 ? (
        <Field label="Repeat">
          <select
            className="n-input cw-in"
            aria-label="Repeat"
            disabled={locked}
            value={repeatChoices(first.start).some((c) => c.value === repeat.base) ? repeat.base : repeat.base ? '__custom' : ''}
            onChange={(e) => {
              const base = e.target.value
              if (base === '__custom') return
              const rules = withRepeat(d, buildRepeat(base, repeat.count, repeat.until, tz))
              const { recurrenceRules: _r, ...rest } = d
              h.edit(rules ? { ...rest, recurrenceRules: rules } : rest)
            }}
          >
            {repeatChoices(first.start).map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
            {repeat.base && !repeatChoices(first.start).some((c) => c.value === repeat.base) ? <option value="__custom">{repeatLabel(d.recurrenceRules)}</option> : null}
          </select>
          {repeat.base ? (
            <select
              className="n-input cw-in"
              aria-label="Ends"
              disabled={locked}
              value={repeat.count ? 'count' : repeat.until ? 'until' : 'never'}
              onChange={(e) => {
                const v = e.target.value
                const rules = withRepeat(d, buildRepeat(repeat.base, v === 'count' ? (repeat.count ?? 5) : null, v === 'until' ? (repeat.until ?? localDate(first.start)) : null, tz))
                if (rules) set({ recurrenceRules: rules })
              }}
            >
              <option value="never">Never ends</option>
              <option value="count">After a number of times</option>
              <option value="until">Until a date</option>
            </select>
          ) : (
            <></>
          )}
          {repeat.count ? (
            <input
              type="number"
              min={1}
              max={1000}
              className="n-input cw-in cw-in--num"
              aria-label="Times"
              disabled={locked}
              value={repeat.count}
              onChange={(e) => {
                const rules = withRepeat(d, buildRepeat(repeat.base, Number(e.target.value) || 1, null, tz))
                if (rules) set({ recurrenceRules: rules })
              }}
            />
          ) : (
            <></>
          )}
          {repeat.until ? (
            <input
              type="date"
              className="n-input cw-in"
              aria-label="Until"
              disabled={locked}
              value={repeat.until}
              onChange={(e) => {
                const rules = withRepeat(d, buildRepeat(repeat.base, null, e.target.value || null, tz))
                if (rules) set({ recurrenceRules: rules })
              }}
            />
          ) : (
            <></>
          )}
        </Field>
      ) : d.recurrenceRules?.length ? (
        <Field label="Repeat">
          <span className="cw-muted">{repeatLabel(d.recurrenceRules)}</span>
        </Field>
      ) : null}
      {scope === 'series' ? <p className="cw-note">Changes apply to every event in this series.</p> : null}
      {scope === 'following' && first ? (
        <p className="cw-note">
          Starts with the {startLabel(d.existingEvent?.occurrenceStart ?? first.start)} occurrence; earlier ones keep their details. Guests get the new invitation. Notula hasn’t checked
          anyone’s availability for the later dates.
        </p>
      ) : null}

      <Field label="Conferencing">
        <select
          className="n-input cw-in"
          aria-label="Conferencing"
          disabled={locked}
          value={d.conference.kind}
          onChange={(e) => {
            const k = e.target.value
            set({ conference: k === 'googleMeet' ? { kind: 'googleMeet' } : k === 'custom' ? { kind: 'custom', url: d.conference.kind === 'custom' ? d.conference.url : '' } : { kind: 'none' } })
          }}
        >
          <option value="googleMeet">{microsoft ? 'Microsoft Teams' : 'Google Meet'}</option>
          <option value="custom">Custom conferencing</option>
          <option value="none">No conferencing</option>
        </select>
        {d.conference.kind === 'custom' ? (
          <input
            className={`n-input cw-in cw-in--grow${d.conference.url && !validLink(d.conference.url) ? ' is-invalid' : ''}`}
            placeholder="https://"
            aria-label="Meeting link"
            disabled={locked}
            value={d.conference.url}
            onChange={(e) => set({ conference: { kind: 'custom', url: e.target.value } })}
          />
        ) : (
          <></>
        )}
      </Field>

      {microsoft ? null : (
        <Field label="Color">
          <span
            className={`cw-swatch${(d.colorId ?? 'default') === 'default' ? ' cw-swatch--calendar' : ''}`}
            style={(d.colorId ?? 'default') !== 'default' && palette[d.colorId ?? ''] ? { background: palette[d.colorId ?? ''] } : undefined}
            aria-hidden="true"
          />
          <select className="n-input cw-in" aria-label="Color" disabled={locked} value={d.colorId ?? 'default'} onChange={(e) => set({ colorId: e.target.value as NonNullable<CalendarEventDraft['colorId']> })}>
            {COLOR_CHOICES.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </Field>
      )}

      <Field label="Who can see it">
        <select
          className="n-input cw-in"
          aria-label="Who can see it"
          disabled={locked}
          value={d.visibility ?? 'default'}
          onChange={(e) => set({ visibility: e.target.value as NonNullable<CalendarEventDraft['visibility']> })}
        >
          {VISIBILITY_CHOICES.map((v) => (
            <option key={v.id} value={v.id}>
              {v.label}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Guests">
        <GuestEditor value={d.attendees} disabled={locked} onChange={(attendees) => set({ attendees })} />
      </Field>

      {expanded || d.location || d.description ? (
        <>
          <Field label="Location">
            <input className="n-input cw-in cw-in--grow" placeholder="No location" aria-label="Location" disabled={locked} value={d.location ?? ''} onChange={(e) => set({ location: e.target.value })} />
          </Field>
          <Field label="Description">
            <textarea className="n-input cw-desc" rows={3} placeholder="No description" aria-label="Description" disabled={locked} value={d.description} onChange={(e) => set({ description: e.target.value })} />
          </Field>
        </>
      ) : (
        <button type="button" className="cw-more" onClick={() => setExpanded(true)}>
          Add location or description
        </button>
      )}

      {!isEdit && many && sources.length > 1 ? (
        <Field label="Add to">
          <select className="n-input cw-in" aria-label="Add to" disabled={locked} value={targetSource?.id ?? ''} onChange={(e) => setTarget(e.target.value)}>
            {sources.map((s) => (
              <option key={s.id} value={s.id}>
                {s.accountEmail ?? s.label}
              </option>
            ))}
          </select>
        </Field>
      ) : null}

      <div className="cw-foot">
        <button type="button" className="n-btn n-btn--sm n-btn--ghost" disabled={h.busy || status === 'creating'} onClick={() => void h.dismiss()}>
          Dismiss
        </button>
        <span className="cw-foot__spacer" />
        {!sources.length ? (
          <span className="cw-noaccount">
            {NO_ACCOUNT}
            <button type="button" className="n-btn n-btn--sm" onClick={() => navigateToSettings('calendar')}>
              Calendar settings
            </button>
          </span>
        ) : (
          <span className={reason ? 'n-tooltip n-tooltip--end' : undefined} data-tooltip={reason ?? undefined}>
            <button type="button" className="n-btn n-btn--sm n-btn--primary" disabled={!!reason || h.busy || status === 'creating'} onClick={() => void create()}>
              {h.busy || status === 'creating' ? (isEdit ? 'Saving…' : 'Creating…') : status === 'failed' || status === 'unknown' ? 'Try again' : submitLabel(d)}
            </button>
          </span>
        )}
      </div>
      {modalFor ? <PermissionModal sourceId={modalFor} onClose={() => setModalFor(null)} onGranted={() => void create(true)} /> : null}
    </div>
  )
}
