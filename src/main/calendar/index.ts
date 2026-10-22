// SPDX-License-Identifier: Apache-2.0
// registerCalendar(): calendar sync without a server.
// Owns the `calendar:*` IPC and `people:participants`, the refresh triggers, the reminder scheduler, the join
// routine and the Gravatar request gate; emits bus `calendar:changed` and
// returns `ctx.calendar` (the final CalendarApi).

import { app, ipcMain, Menu, MenuItem, net, session, type BrowserWindow } from 'electron'
import { notulaError } from '@shared/errors'
import type { InvokeChannel, InvokeRes, PushChannel, SendChannel, SendPayload } from '@shared/ipc'
import { CALENDAR_SYNC } from '@shared/types/calendar'
import type { CalendarEvent } from '@shared/types/notes'
import type { CalendarApi, MainContext } from '../context'
import { log } from '../log'
import { registerRequestFilter } from '../net/egress'
import { joinCall } from './join'
import { ReminderScheduler } from './reminders'
import { CalendarService, type RefreshTrigger } from './service'

const MAX_RANGE_MS = 62 * 86_400_000
const PARTICIPANTS_LIMIT = 5

function iso(v: unknown, what: string): string {
  const ms = typeof v === 'string' ? Date.parse(v) : NaN
  if (Number.isNaN(ms)) throw notulaError('invalid-input', `${what} must be an ISO time`)
  return new Date(ms).toISOString()
}

function isSelf(a: { self?: unknown; email?: unknown } | null | undefined, mine: ReadonlySet<string>): boolean {
  return !!a && (a.self === true || (typeof a.email === 'string' && mine.has(a.email.trim().toLowerCase())))
}

/** The user is the organizer or creator, or an attendee (`self` or one of "my emails"). */
function attends(ev: CalendarEvent, mine: ReadonlySet<string>): boolean {
  const organizer = ev['organizer'] as { email?: unknown; self?: unknown } | undefined
  const creator = ev['creator'] as { email?: unknown; self?: unknown } | undefined
  if (isSelf(organizer, mine) || isSelf(creator, mine)) return true
  return (Array.isArray(ev.attendees) ? ev.attendees : []).some((a) => isSelf(a, mine))
}

export function registerCalendar(ctx: MainContext): CalendarApi {
  /**
   * Every join path docks Notula beside the meeting
   * after a link opens. `windowModes` applies a `join` reason only while "Reposition" is on.
   */
  const joinAndDock = async (url: unknown): Promise<boolean> => {
    const opened = await joinCall(url)
    if (opened) {
      void ctx.windowModes.set('side', { focus: true, reason: 'join' }).catch((err: unknown) => log('warn', 'calendar:join-side-failed', { err }))
    }
    return opened
  }

  /** The `calendar:changed` push and the bus event, after every calendar write. */
  const changed = (sourceIds: string[]): void => {
    for (const wc of ctx.windows.targets()) {
      if (!wc.isDestroyed()) wc.send('calendar:changed' satisfies PushChannel, { sourceIds })
    }
    ctx.bus.emit('calendar:changed', { sourceIds })
  }
  const service = new CalendarService(ctx, changed)
  let viewingEvent: string | null = null

  const listEvents = async (range: { from: string; to: string }): Promise<CalendarEvent[]> => {
    try {
      return await ctx.storage.listEventsInRange(range)
    } catch (err) {
      log('warn', 'calendar:list-events-failed', { err: err instanceof Error ? err.message.slice(0, 120) : 'error' })
      return []
    }
  }

  const api: CalendarApi = {
    listEvents,
    getEvent: async (id) => {
      try {
        return await ctx.storage.getCalendarEvent(id)
      } catch {
        return null
      }
    },
    currentEvent: async (at) => {
      const now = (at ?? new Date()).getTime()
      const mine = new Set(await service.myEmails())
      const events = await listEvents({ from: new Date(now - 86_400_000).toISOString(), to: new Date(now + 60_000).toISOString() })
      return (
        events.find((ev) => {
          const start = Date.parse(String(ev.start?.dateTime ?? ''))
          const end = Date.parse(String(ev.end?.dateTime ?? ''))
          return start <= now && end > now && ev['status'] !== 'cancelled' && attends(ev, mine)
        }) ?? null
      )
    },
    myEmails: () => service.myEmails(),
    viewingEventId: () => {
      const main = ctx.windows.main()
      return main && main.isVisible() && !main.isMinimized() ? viewingEvent : null
    },
    join: (url) => joinAndDock(url),
    // The re-consent with the read scope and the held grants ± one (Google
    // `include_granted_scopes=true` when adding). `calendar:set-grant` calls it.
    grants: (sourceId) => service.grants(sourceId),
    setGrant: (sourceId, grant, enabled) => service.setGrant(sourceId, grant, enabled),
    accessToken: (sourceId, grant) => service.grantToken(sourceId, grant),
    refreshSource: (sourceId) => {
      void service.refreshSource(sourceId, 'manual')
    }
  }

  // ---------- IPC ----------

  ipcMain.handle('calendar:sources' satisfies InvokeChannel, (): Promise<InvokeRes<'calendar:sources'>> => service.state())

  ipcMain.handle('calendar:add-ics' satisfies InvokeChannel, (_e, raw: unknown): Promise<InvokeRes<'calendar:add-ics'>> => {
    const r = (raw ?? {}) as { url?: unknown; label?: unknown; myEmail?: unknown }
    return service.addIcs({ url: r.url, label: r.label, myEmail: r.myEmail })
  })

  ipcMain.handle('calendar:remove-source' satisfies InvokeChannel, async (_e, raw: unknown): Promise<void> => {
    await service.remove((raw as { sourceId?: unknown } | null)?.sourceId)
  })

  ipcMain.handle('calendar:set-oauth-client' satisfies InvokeChannel, async (_e, raw: unknown): Promise<void> => {
    const r = (raw ?? {}) as { provider?: unknown; clientId?: unknown; clientSecret?: unknown }
    await service.setClient({ provider: r.provider, clientId: r.clientId, clientSecret: r.clientSecret })
  })

  ipcMain.handle('calendar:connect' satisfies InvokeChannel, (_e, raw: unknown): Promise<InvokeRes<'calendar:connect'>> => {
    const r = (raw ?? {}) as { provider?: unknown; sourceId?: unknown }
    // The mini window while the loopback redirect is pending, wide afterwards.
    void ctx.windowModes.set('mini', { reason: 'oauth' }).catch((err: unknown) => log('warn', 'calendar:oauth-mini-failed', { err }))
    return service.connect({ provider: r.provider, sourceId: r.sourceId }).finally(() => {
      void ctx.windowModes.set('wide', { focus: true, reason: 'oauth' }).catch((err: unknown) => log('warn', 'calendar:oauth-wide-failed', { err }))
    })
  })

  ipcMain.handle('calendar:calendars' satisfies InvokeChannel, (): Promise<InvokeRes<'calendar:calendars'>> => service.calendars())

  ipcMain.handle('calendar:set-visible' satisfies InvokeChannel, async (_e, raw: unknown): Promise<void> => {
    const r = (raw ?? {}) as { calendarId?: unknown; visible?: unknown }
    await service.setVisible({ calendarId: r.calendarId, visible: r.visible })
  })

  ipcMain.handle('calendar:reset-visible' satisfies InvokeChannel, async (): Promise<void> => {
    await service.resetVisible()
  })

  ipcMain.handle('calendar:refresh' satisfies InvokeChannel, async (_e, raw: unknown): Promise<void> => {
    const trigger = (raw as { trigger?: unknown } | null)?.trigger
    if (trigger !== 'home-view' && trigger !== 'manual') throw notulaError('invalid-input', 'trigger must be home-view or manual')
    void service.refreshAll(trigger)
  })

  ipcMain.handle('calendar:range' satisfies InvokeChannel, async (_e, raw: unknown): Promise<InvokeRes<'calendar:range'>> => {
    const r = (raw ?? {}) as { from?: unknown; to?: unknown }
    const from = iso(r.from, 'from')
    const to = iso(r.to, 'to')
    const span = Date.parse(to) - Date.parse(from)
    if (span <= 0 || span > MAX_RANGE_MS) throw notulaError('invalid-input', 'the range must be positive and at most 62 days')
    return ctx.storage.listEventsInRange({ from, to })
  })

  ipcMain.handle('calendar:upcoming' satisfies InvokeChannel, async (_e, raw: unknown): Promise<InvokeRes<'calendar:upcoming'>> => {
    const page = (raw as { page?: unknown } | null)?.page
    if (typeof page !== 'number' || !Number.isInteger(page) || page < 0 || page > 10_000) {
      throw notulaError('invalid-input', 'Page must be between 0 and 10,000.')
    }
    const [filterPersonal, myEmails] = await Promise.all([ctx.settings.get('calendar.filterPersonalEvents'), service.myEmails()])
    return ctx.storage.upcomingEvents({ page, now: new Date().toISOString(), filterPersonal, myEmails })
  })

  ipcMain.handle('calendar:join' satisfies InvokeChannel, async (_e, raw: unknown): Promise<InvokeRes<'calendar:join'>> => {
    const url = (raw as { url?: unknown } | null)?.url
    if (typeof url !== 'string' || url.length > 8_192) throw notulaError('invalid-input', 'url must be a string')
    return { opened: await joinAndDock(url) }
  })

  ipcMain.on('calendar:viewing-event' satisfies SendChannel, (event, raw: SendPayload<'calendar:viewing-event'>) => {
    // Only the main window's note page speaks for what the user is viewing.
    if (ctx.windows.kindOf(event.sender) !== 'main') return
    const id = raw?.eventId
    viewingEvent = typeof id === 'string' && id.length > 0 && id.length <= 1_024 ? id : null
  })

  ipcMain.handle('people:participants' satisfies InvokeChannel, async (_e, raw: unknown): Promise<InvokeRes<'people:participants'>> => {
    const r = (raw ?? {}) as { query?: unknown; noteId?: unknown }
    if (typeof r.query !== 'string' || r.query.length > 200) throw notulaError('invalid-input', 'query must be a short string')
    if (r.noteId !== undefined && typeof r.noteId !== 'string') throw notulaError('invalid-input', 'noteId must be a string')
    return ctx.storage.participants({
      query: r.query,
      ...(typeof r.noteId === 'string' && r.noteId ? { noteId: r.noteId } : {}),
      myEmails: await service.myEmails(),
      limit: PARTICIPANTS_LIMIT
    })
  })

  // ---------- triggers ----------

  const refreshAll = (trigger: RefreshTrigger): void => {
    void service.refreshAll(trigger).catch((err: unknown) => log('warn', 'calendar:refresh-failed', { trigger, err }))
  }
  const reminders = new ReminderScheduler(ctx, { myEmails: () => service.myEmails(), join: (url) => joinAndDock(url) })

  let started = false
  const startWhenReady = (): void => {
    if (started) return
    started = true
    refreshAll('init')
    reminders.start()
    setInterval(() => refreshAll('polling'), CALENDAR_SYNC.pollMs).unref?.()
  }
  void ctx.storage
    .status()
    .then((s) => {
      if (s.state === 'ready') startWhenReady()
    })
    .catch(() => undefined)
  ctx.bus.on('storage:status', (s) => {
    if (s.state === 'ready') startWhenReady()
  })

  // Network back: Electron's online state flipping to true, checked every 30 s.
  let online = net.isOnline()
  setInterval(() => {
    const now = net.isOnline()
    if (now && !online && started) refreshAll('online')
    online = now
  }, CALENDAR_SYNC.onlinePollMs).unref?.()

  ctx.bus.on('power:resumed', () => {
    if (started) refreshAll('resume')
  })

  // The main window becoming visible again: show, restore or focus after being hidden.
  const watched = new WeakSet<BrowserWindow>()
  const watch = (win: BrowserWindow): void => {
    if (watched.has(win) || win.isDestroyed() || ctx.windows.main() !== win) return
    watched.add(win)
    let hidden = !win.isVisible() || win.isMinimized()
    const away = (): void => {
      hidden = true
    }
    const back = (): void => {
      if (!hidden) return
      hidden = false
      if (started) refreshAll('window-visible')
    }
    win.on('hide', away)
    win.on('minimize', away)
    win.on('show', back)
    win.on('restore', back)
    win.on('focus', back)
  }
  app.on('browser-window-created', (_e, win) => setImmediate(() => watch(win)))
  const existing = ctx.windows.main()
  if (existing) watch(existing)

  // ---------- Gravatar: no request unless the user opted in ----------

  // Local-only mode blocks Gravatar too (privacy.ts: `gravatar` is always blocked there).
  let gravatar = false
  let localOnly = false
  void Promise.all([ctx.settings.get('people.gravatarEnabled'), ctx.settings.get('privacy.localOnly')])
    .then(([v, lo]) => {
      gravatar = v === true
      localOnly = lo === true
    })
    .catch(() => undefined)
  ctx.bus.on('settings:changed', ({ keys, settings }) => {
    if (keys.includes('people.gravatarEnabled')) gravatar = settings['people.gravatarEnabled'] === true
    if (keys.includes('privacy.localOnly')) {
      const was = localOnly
      localOnly = settings['privacy.localOnly'] === true
      // Resume syncing when local-only turns off.
      if (was && !localOnly) refreshAll('settings')
    }
  })
  // Through the egress registry, because Electron keeps only one onBeforeRequest
  // listener per session and net/egress.ts owns it.
  registerRequestFilter({
    id: 'gravatar',
    urls: ['*://gravatar.com/*', '*://*.gravatar.com/*'],
    decide: () => (!gravatar || localOnly ? 'cancel' : 'pass')
  })

  // ---------- dev only: "Trigger next meeting reminder" ----------

  if (!app.isPackaged) {
    void app.whenReady().then(() => {
      const menu = Menu.getApplicationMenu()
      const view = menu?.items.find((i) => i.label === 'View')?.submenu
      if (!menu || !view) return
      view.append(new MenuItem({ type: 'separator' }))
      view.append(new MenuItem({ label: 'Trigger next meeting reminder', click: () => void reminders.triggerNext() }))
      view.append(new MenuItem({ label: 'Refresh calendars', click: () => refreshAll('manual') }))
      Menu.setApplicationMenu(menu)
    })
  }

  return api
}
