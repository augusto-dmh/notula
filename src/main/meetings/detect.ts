// SPDX-License-Identifier: Apache-2.0
// The "Meeting detected" card (a Notula-drawn notification window, not an OS notification).
// Called whenever the number of detected apps changes.

import type { BrowserWindow } from 'electron'
import type { PushChannel } from '@shared/ipc'
import type { MicApp } from '@shared/types/meetings'
import { CALL_KIND_APPS } from '@shared/types/meetings'
import type { CalendarEvent } from '@shared/types/notes'
import type { MainContext } from '../context'
import { log } from '../log'
import { lastShownAt } from '../notify'

const SHOW_DELAY_MS = 2_000
const LIFETIME_MS = 120_000
const RATE_LIMIT_MS = 120_000
const COUNTDOWN_MS = 20_000
/** An event is current when it started at most 15 min ago and is ongoing or starts within 90 s. */
const EVENT_STARTED_MAX_MS = 15 * 60_000
const EVENT_SOON_MS = 90_000

function titleFor(app: MicApp): string {
  if ((CALL_KIND_APPS.call as readonly string[]).includes(app.appId)) return 'Call detected'
  if ((CALL_KIND_APPS.huddle as readonly string[]).includes(app.appId)) return 'Huddle detected'
  return 'Meeting detected'
}

function timeOf(t: CalendarEvent['start']): number | null {
  const raw = t?.dateTime ?? t?.date
  if (!raw) return null
  const ms = Date.parse(raw)
  return Number.isFinite(ms) ? ms : null
}

/** "start - end", time only, in the app locale. */
function timeRange(start: number, end: number | null): string {
  const f = (ms: number): string => new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  return end !== null ? `${f(start)} - ${f(end)}` : f(start)
}

/** The user organizes, created or attends the event (`self`, or one of "my emails"). */
function attends(ev: CalendarEvent, mine: ReadonlySet<string>): boolean {
  const me = (p: unknown): boolean => {
    const o = p as { self?: unknown; email?: unknown } | null | undefined
    return !!o && (o.self === true || (typeof o.email === 'string' && mine.has(o.email.trim().toLowerCase())))
  }
  return me(ev['organizer']) || me(ev['creator']) || (Array.isArray(ev.attendees) ? ev.attendees : []).some(me)
}

/**
 * The card's event, among every attended event that is active (started at most
 * 15 min ago and still on, or starting within 90 s): the next one to start, else the one
 * that started last, as the tray picks. The first running event by
 * start used to shadow a newer one, and an event not started yet never qualified, so
 * joining a call a minute early gave an unlinked note.
 */
async function currentEvent(ctx: MainContext): Promise<{ event: CalendarEvent; start: number; end: number | null } | null> {
  try {
    const now = Date.now()
    const [events, emails] = await Promise.all([
      ctx.calendar.listEvents({ from: new Date(now - EVENT_STARTED_MAX_MS).toISOString(), to: new Date(now + EVENT_SOON_MS).toISOString() }),
      ctx.calendar.myEmails()
    ])
    const mine = new Set(emails)
    const active = events.flatMap((event) => {
      const start = timeOf(event.start)
      if (start === null || event['status'] === 'cancelled' || !attends(event, mine)) return []
      const end = timeOf(event.end)
      const ok = now - start <= EVENT_STARTED_MAX_MS && start - now <= EVENT_SOON_MS && (end === null || end > now)
      return ok ? [{ event, start, end }] : []
    })
    const next = active.filter((c) => c.start > now).sort((a, b) => a.start - b.start)[0]
    return next ?? active.sort((a, b) => b.start - a.start)[0] ?? null
  } catch (err) {
    log('warn', 'meetings:current-event-failed', { err })
    return null
  }
}

export class DetectedMeetingNotifier {
  /** Calendar events that already had a card: never repeated. */
  private readonly shownEvents = new Set<string>()

  constructor(
    private readonly ctx: MainContext,
    private readonly currentApps: () => MicApp[]
  ) {}

  /**
   * Why no card may show now, or null. `eventId` is the current event, if any. At show
   * time (`atShow`) the event was already claimed by this card, so that rule is skipped.
   */
  private async skipReason(app: MicApp, eventId: string | null, atShow = false): Promise<string | null> {
    const s = await this.ctx.settings.getAll()
    if (this.ctx.ui.inOnboarding()) return 'onboarding'
    if (s['notifications.silencedAppIds'].includes(app.appId)) return 'silenced'
    if (s['notifications.autoDetectedBlocked']) return 'blocked'
    if (Date.now() - lastShownAt('detected-meeting') < RATE_LIMIT_MS) return 'rate-limited'
    if (this.ctx.capture.isCapturing()) return 'transcribing'
    if (!atShow && eventId && this.shownEvents.has(eventId)) return 'event-already-shown'
    if (!eventId && this.ctx.notify.visible().some((p) => p.variant === 'detected-meeting' && !p.calendarEventId)) {
      return 'another-showing'
    }
    return null
  }

  async onAppsChanged(apps: MicApp[], previous: MicApp[]): Promise<void> {
    if (apps.length <= previous.length) return
    const before = new Set(previous.map((a) => a.appId))
    const app = apps.find((a) => !before.has(a.appId))
    if (!app) return
    const current = await currentEvent(this.ctx)
    const eventId = current?.event.id ?? null
    const skip = await this.skipReason(app, eventId)
    if (skip) {
      log('info', 'meetings:card-skipped', { app: app.appId, reason: skip })
      return
    }
    const autoStart = await this.ctx.settings.get('meetings.autostartDetected')
    const event = current?.event ?? null
    if (eventId) this.shownEvents.add(eventId)
    this.ctx.notify.show({
      variant: 'detected-meeting',
      title: event?.summary?.trim() || titleFor(app),
      body: current ? timeRange(current.start, current.end) : app.name,
      calendarEventId: eventId,
      eventStart: current ? new Date(current.start).toISOString() : null,
      micAppId: app.appId,
      micAppName: app.name,
      autoStart,
      countdownMs: COUNTDOWN_MS,
      showDelayMs: SHOW_DELAY_MS,
      hideAfterMs: LIFETIME_MS,
      quietWhileRecording: true,
      allowDuringOnboarding: false,
      // Re-checked after the 2 s delay: the app still holds the mic and the rules still pass.
      lastMomentCheck: async () => {
        if (!this.currentApps().some((a) => a.appId === app.appId)) return false
        const late = await this.skipReason(app, eventId, true)
        if (late) log('info', 'meetings:card-skipped', { app: app.appId, reason: late, atShow: true })
        return late === null
      },
      onAction: (action) => {
        if (action === 'click' || action === 'start_note') this.startNote(event)
      }
    })
  }

  /** Click and Open create a transcribing note (the stored source stays the platform). */
  private startNote(event: CalendarEvent | null): void {
    const main: BrowserWindow | null = this.ctx.windows.main()
    if (!main) {
      log('warn', 'meetings:start-note-no-window')
      return
    }
    if (main.isMinimized()) main.restore()
    main.show()
    main.focus()
    // Dock Notula beside the meeting while
    // "Reposition Notula for meetings" is on.
    void this.ctx.windowModes
      .set('side', { focus: true, reason: 'join' })
      .catch((err: unknown) => log('warn', 'meetings:side-mode-failed', { err }))
    main.webContents.send('notes:new-requested' satisfies PushChannel, {
      creationSource: 'unscheduled_meeting_alert',
      autoTranscribe: true,
      ...(event ? { event } : {})
    })
    log('info', 'meetings:note-requested', { withEvent: event !== null })
  }
}
