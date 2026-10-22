// SPDX-License-Identifier: Apache-2.0
// Meeting reminders: which events qualify,
// when reminders are scheduled and cancelled, the content and the actions. The card,
// the stack and the show-time suppression rules belong to the notification windows (notify/).
//
// Each pass schedules every eligible event in the window, not just the next one, so two
// meetings that start close together both get their reminder.

import { app, type BrowserWindow } from 'electron'
import { detectConferenceLink, type ConferenceLink } from '@shared/lib/conference'
import type { PushChannel } from '@shared/ipc'
import { REMINDER, REMINDER_COLOR_DEFAULT } from '@shared/types/calendar'
import type { CalendarEvent, NewNoteRequest } from '@shared/types/notes'
import type { NotificationAction } from '@shared/types/notify'
import type { MainContext } from '../context'
import { log } from '../log'

const DAY_MS = 86_400_000
/** The dev trigger's card stays up this long. */
const DEV_TRIGGER_HIDE_MS = 30 * 60_000

interface Scheduled {
  startMs: number
  notifId: string
}

export interface ReminderDeps {
  myEmails(): Promise<string[]>
  join(url: string): Promise<boolean>
}

function isSelf(a: { self?: unknown; email?: unknown } | null | undefined, mine: ReadonlySet<string>): boolean {
  return !!a && (a.self === true || (typeof a.email === 'string' && mine.has(a.email.trim().toLowerCase())))
}

/** Not declined, an id, a timed start and end, a title, at least one attendee. */
export function qualifiesForReminder(ev: CalendarEvent | null | undefined, mine: ReadonlySet<string>): ev is CalendarEvent {
  if (!ev || typeof ev.id !== 'string' || !ev.id) return false
  if (!ev.start?.dateTime || !ev.end?.dateTime) return false
  if (typeof ev.summary !== 'string' || !ev.summary.trim()) return false
  const attendees = Array.isArray(ev.attendees) ? ev.attendees : []
  if (attendees.length === 0) return false
  return !attendees.some((a) => isSelf(a, mine) && a.responseStatus === 'declined')
}

const startOf = (ev: CalendarEvent): number => Date.parse(String(ev.start?.dateTime ?? ''))
const endOf = (ev: CalendarEvent): number => Date.parse(String(ev.end?.dateTime ?? ''))

export class ReminderScheduler {
  /** The "scheduled" set: in memory, empty on each launch. */
  private readonly scheduled = new Map<string, Scheduled>()
  private running: Promise<void> | null = null
  private again = false

  constructor(
    private readonly ctx: MainContext,
    private readonly deps: ReminderDeps
  ) {}

  /** Passes at start, on `calendar:changed`, every 10 minutes and on resume. */
  start(): void {
    this.ctx.bus.on('calendar:changed', () => void this.pass('calendar-changed'))
    this.ctx.bus.on('power:resumed', () => void this.pass('resume'))
    setInterval(() => void this.pass('interval'), REMINDER.passMs).unref?.()
    void this.pass('startup')
  }

  /** One pass at a time; a request during one runs once after it. */
  pass(reason: string): Promise<void> {
    if (this.running) {
      this.again = true
      return this.running
    }
    this.running = this.run(reason)
      .catch((err: unknown) => log('warn', 'calendar:reminder-pass-failed', { reason, err: err instanceof Error ? err.message : 'error' }))
      .finally(() => {
        this.running = null
        if (this.again) {
          this.again = false
          void this.pass('coalesced')
        }
      })
    return this.running
  }

  private async events(fromMs: number, toMs: number): Promise<CalendarEvent[]> {
    return this.ctx.storage.listEventsInRange({ from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() })
  }

  /** Today's and tomorrow's deduped timed events, plus anything still in the late window. */
  private async todayAndTomorrow(now: number): Promise<CalendarEvent[]> {
    const day = new Date(now)
    day.setHours(0, 0, 0, 0)
    return this.events(Math.min(day.getTime(), now - REMINDER.lateLimitMs), day.getTime() + 2 * DAY_MS)
  }

  private async run(reason: string): Promise<void> {
    const status = await this.ctx.storage.status()
    if (status.state !== 'ready') return
    const now = Date.now()
    const events = await this.todayAndTomorrow(now)
    const byId = new Map(events.map((e) => [e.id, e]))
    const showing = new Set(this.ctx.notify.visible().map((p) => p.id))

    // Cancel stale reminders first.
    for (const [eventId, r] of [...this.scheduled]) {
      const ev = byId.get(eventId)
      if (!ev) {
        this.ctx.notify.hide(r.notifId)
        this.scheduled.delete(eventId)
        log('info', 'calendar:reminder-cancelled', { why: 'event-deleted' })
        continue
      }
      if (startOf(ev) !== r.startMs) {
        if (!showing.has(r.notifId)) this.ctx.notify.hide(r.notifId)
        this.scheduled.delete(eventId)
        log('info', 'calendar:reminder-cancelled', { why: 'event-rescheduled' })
      } else if (r.startMs < now - DAY_MS) {
        this.scheduled.delete(eventId)
      }
    }

    // Every qualifying event inside the window.
    const mine = new Set(await this.deps.myEmails())
    let count = 0
    for (const ev of events) {
      if (!qualifiesForReminder(ev, mine) || this.scheduled.has(ev.id)) continue
      const until = startOf(ev) - now
      if (!(until < REMINDER.windowMs && until > -REMINDER.lateLimitMs)) continue
      await this.schedule(ev, mine, until, null)
      count++
    }
    if (count) log('info', 'calendar:reminders-scheduled', { reason, count })
  }

  /** The Meet `authuser` email: the event's account (via its source), else the profile email. */
  private async userEmailFor(ev: CalendarEvent): Promise<string | null> {
    const sourceId = /^(?:ics|google|microsoft):([^:]+):/.exec(ev.id)?.[1]
    if (sourceId) {
      const src = (await this.ctx.storage.listCalendarSources()).find((s) => s.id === sourceId)
      if (src?.accountEmail) return src.accountEmail
    }
    const profile = (await this.ctx.settings.get('profile.email')).trim()
    return profile || null
  }

  private async colorFor(ev: CalendarEvent): Promise<string> {
    const calendarId = typeof ev['calendarId'] === 'string' ? ev['calendarId'] : null
    if (!calendarId) return REMINDER_COLOR_DEFAULT
    const cal = (await this.ctx.storage.listCalendars()).find((c) => c.id === calendarId)
    return cal?.color || REMINDER_COLOR_DEFAULT
  }

  private async schedule(ev: CalendarEvent, mine: ReadonlySet<string>, until: number, hideAfterOverride: number | null): Promise<void> {
    const startMs = startOf(ev)
    const link = detectConferenceLink(ev, await this.userEmailFor(ev))
    const time = new Intl.DateTimeFormat(app.getLocale() || undefined, { hour: 'numeric', minute: '2-digit' })
    // Shown 58 s before; hidden 4 min after it appears, or 4 min after the start when late.
    const showDelayMs = hideAfterOverride === null ? Math.max(0, until - REMINDER.leadMs) : 0
    const hideAfterMs = hideAfterOverride ?? (until >= 0 ? REMINDER.lifetimeMs : REMINDER.lifetimeMs + until)
    const location = typeof ev['location'] === 'string' && ev['location'] ? (ev['location'] as string) : null
    const detail = await this.briefHeadline(ev.id)
    const notifId = this.ctx.notify.show({
      id: `calendar-reminder:${ev.id}`,
      variant: 'scheduled-meeting',
      title: (ev.summary as string).trim(),
      body: `${time.format(new Date(startMs))} - ${time.format(new Date(endOf(ev)))}`,
      calendarEventId: ev.id,
      eventStart: new Date(startMs).toISOString(),
      joinUrl: link?.url ?? null,
      conferenceProvider: link?.provider ?? null,
      calendarColor: await this.colorFor(ev),
      location,
      detail,
      showDelayMs,
      hideAfterMs,
      quietWhileRecording: false,
      allowDuringOnboarding: false,
      lastMomentCheck: async () => {
        const current = await this.ctx.storage.getCalendarEvent(ev.id)
        return !!current && startOf(current) === startMs && qualifiesForReminder(current, new Set(await this.deps.myEmails()))
      },
      onAction: (action) => void this.onAction(action, ev, link, detail !== null)
    })
    this.scheduled.set(ev.id, { startMs, notifId })
    log('debug', 'calendar:reminder-queued', { delayMs: showDelayMs, hideAfterMs, withLink: link !== null })
  }

  /** Click joins then takes notes (no note when the join fails); the others do one each. */
  private async onAction(action: NotificationAction, ev: CalendarEvent, link: ConferenceLink | null, brief = false): Promise<void> {
    if (action === 'click') {
      if (link) {
        const opened = await this.deps.join(link.url)
        if (!opened) {
          log('warn', 'calendar:reminder-join-failed')
          return
        }
        this.requestNote(ev, true, brief)
      } else {
        this.requestNote(ev, false, brief)
      }
    } else if (action === 'join_meeting') {
      if (link) await this.deps.join(link.url)
    } else if (action === 'start_note') {
      this.requestNote(ev, false)
    }
  }

  /** `notes:new-requested` to the main window (creation source `notification`, auto-transcribe). */
  /**
   * With briefs on, a meaningful base brief's
   * headline becomes the card's detail line; otherwise the card is unchanged.
   */
  private async briefHeadline(eventId: string): Promise<string | null> {
    try {
      if (!(await this.ctx.settings.get('prepBrief.enabled'))) return null
      const b = await this.ctx.storage.getBrief(eventId)
      if (!b || b.status !== 'completed' || b.worth_showing === false || !b.content?.trim() || b.dismissed_at) return null
      const line = b.headline?.trim() || (b.content.trim().split('\n')[0] ?? '').replace(/^#{1,6}\s+/, '').trim()
      return line ? line.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\*\*/g, '').slice(0, 300) : null
    } catch (err) {
      log('debug', 'calendar:reminder-brief-unavailable', { err })
      return null
    }
  }

  private requestNote(ev: CalendarEvent, joined: boolean, expandBrief = false): void {
    const main: BrowserWindow | null = this.ctx.windows.main()
    if (!main) {
      log('warn', 'calendar:reminder-note-no-window')
      return
    }
    if (main.isMinimized()) main.restore()
    main.show()
    main.focus()
    const request: NewNoteRequest = {
      creationSource: 'notification',
      event: ev,
      autoTranscribe: true,
      ...(joined ? { holdInPersonNotice: true } : {}),
      ...(expandBrief ? { expandBrief: true } : {}),
      openSource: 'notification'
    }
    main.webContents.send('notes:new-requested' satisfies PushChannel, request)
    log('info', 'calendar:reminder-note-requested', { joined })
  }

  /** Dev only: forget the scheduled set and show the next future qualifying event now. */
  async triggerNext(): Promise<void> {
    this.scheduled.clear()
    const now = Date.now()
    const mine = new Set(await this.deps.myEmails())
    const next = (await this.events(now, now + 14 * DAY_MS)).find((ev) => qualifiesForReminder(ev, mine) && startOf(ev) > now)
    if (!next) {
      log('info', 'calendar:dev-reminder-none')
      return
    }
    await this.schedule(next, mine, startOf(next) - now, DEV_TRIGGER_HIDE_MS)
  }
}
