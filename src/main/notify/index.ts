// SPDX-License-Identifier: Apache-2.0
// registerNotify(): Notula-drawn notification windows (not OS notifications, so cards look and
// act the same on every platform); the `notify:*` IPC; returns `ctx.notify`.
//
// One always-on-top window per card, stacked top-right on the primary display
// (no follow-cursor). A request waits for its show delay, then passes
// the show-time checks. The payload reaches its window through
// `notify:get-payload` (by `webContents.id`), never through the URL.

import { randomUUID } from 'node:crypto'
import { app, ipcMain, screen, type BrowserWindow, type WebContents } from 'electron'
import type { InvokeChannel, InvokeRes, PushChannel, SendChannel, SendPayload } from '@shared/ipc'
import type { LastTimeRecap, NotificationAction, NotificationPayload, NotificationVariant } from '@shared/types/notify'
import { NOTIFICATION_GAP, NOTIFICATION_WIDTH, RECAP_LIMITS } from '@shared/types/notify'
import { SOURCE_CARD_ACTIONS } from '@shared/types/sources'
import type { MainContext, NotificationRequest, NotifyApi } from '../context'
import { log } from '../log'
import { keepTransparent, reapplyTransparent, watchMainWindow } from '../bubble/main-window'

/** The card draws inside a 12 px transparent margin, so the window is content + 24. */
const MARGIN = 12
const DEFAULT_CONTENT_HEIGHT = 80
const MIN_CONTENT_HEIGHT = 24
const MENU_OPEN_MIN_CONTENT_HEIGHT = 400
/** Right edge 4 px inside the work area (x = right − 408); first top 4 px below it. */
const EDGE_INSET = 4
const ANIMATE_OUT_MS = 300
/** A meeting that started more than this long ago no longer gets a card (show-time rule 4). */
const STALE_MS = 4 * 60_000
/** After a resume, queued reminders move to 58 s before the start. */
const REMINDER_LEAD_MS = 58_000
const DAY_MS = 86_400_000

const ACTIONS: readonly NotificationAction[] = [
  'click',
  'join_meeting',
  'start_note',
  'hide',
  'block',
  'unblock',
  'mute_app_notifications',
  'open_settings'
]

interface Entry {
  id: string
  req: NotificationRequest
  payload: NotificationPayload
  state: 'queued' | 'showing' | 'leaving'
  win: BrowserWindow | null
  wcId: number | null
  queueTimer: ReturnType<typeof setTimeout> | null
  hideTimer: ReturnType<typeof setTimeout> | null
  hideAt: number | null
  contentHeight: number
  menuOpen: boolean
  arrival: number
}

/** When a card of each variant last appeared (the detected-meeting 2-minute rate limit). */
const lastShown = new Map<NotificationVariant, number>()

/** For the detected-meeting rules (meetings/detect.ts): ms since the epoch, 0 = never. */
export function lastShownAt(variant: NotificationVariant): number {
  return lastShown.get(variant) ?? 0
}

function toPayload(id: string, req: NotificationRequest): NotificationPayload {
  return {
    id,
    variant: req.variant,
    title: req.title,
    body: req.body,
    calendarEventId: req.calendarEventId ?? null,
    joinUrl: req.joinUrl ?? null,
    conferenceProvider: req.conferenceProvider ?? null,
    micAppId: req.micAppId ?? null,
    micAppName: req.micAppName ?? null,
    autoStart: req.autoStart === true,
    countdownMs: req.countdownMs ?? null,
    calendarColor: req.calendarColor ?? null,
    location: req.location ?? null,
    shownAt: new Date().toISOString(),
    detail: req.detail ?? null,
    // The recap arrives from a decorator; info cards carry at most 3 buttons.
    lastTime: null,
    infoActions: req.variant === 'info' ? (req.infoActions ?? []).slice(0, 3) : [],
    source: req.variant === 'source-detected' ? (req.source ?? null) : null
  }
}

/** A valid action for this card, including `info:<id>` for one of its own buttons. */
function isCardAction(e: { payload: NotificationPayload }, action: unknown): action is NotificationAction {
  if (typeof action !== 'string') return false
  if (action.startsWith('info:')) return e.payload.infoActions.some((a) => `info:${a.id}` === action)
  if (action.startsWith('source:')) {
    return e.payload.variant === 'source-detected' && (SOURCE_CARD_ACTIONS as readonly string[]).includes(action.slice('source:'.length))
  }
  return (ACTIONS as readonly string[]).includes(action)
}

type Decorator = Parameters<NotifyApi['registerDecorator']>[0]

function eventStartMs(req: NotificationRequest): number | null {
  if (!req.eventStart) return null
  const t = Date.parse(req.eventStart)
  return Number.isFinite(t) ? t : null
}

export function registerNotify(ctx: MainContext): NotifyApi {
  const entries = new Map<string, Entry>()
  let arrivals = 0
  /** The recap decorator; awaited for scheduled-meeting cards, capped. */
  const decorators = new Set<Decorator>()

  async function decorate(e: Entry): Promise<void> {
    if (decorators.size === 0 || e.req.variant !== 'scheduled-meeting') return
    const req = { ...e.req, id: e.id }
    const results = [...decorators].map((d) =>
      d(req).catch((err: unknown) => {
        log('warn', 'notify:decorator-failed', { err })
        return {} as { lastTime?: LastTimeRecap | null }
      })
    )
    const cap = new Promise<'cap'>((r) => setTimeout(() => r('cap'), RECAP_LIMITS.decorateWaitMs))
    const all = Promise.all(results)
    const done = await Promise.race([all, cap])
    if (done === 'cap') return
    let lastTime: LastTimeRecap | null = null
    for (const r of done) if (r.lastTime) lastTime = r.lastTime
    if (lastTime) e.payload = { ...e.payload, lastTime }
  }

  const showing = (): Entry[] =>
    [...entries.values()].filter((e) => e.state !== 'queued' && e.win).sort((a, b) => a.arrival - b.arrival)

  const contentHeightOf = (e: Entry): number =>
    e.menuOpen ? Math.max(e.contentHeight, MENU_OPEN_MIN_CONTENT_HEIGHT) : e.contentHeight

  /** Top-right column, arrival order, 12 px between cards. */
  function reflow(): void {
    const area = screen.getPrimaryDisplay().workArea
    const x = area.x + area.width - (NOTIFICATION_WIDTH + EDGE_INSET)
    let y = area.y + EDGE_INSET
    for (const e of showing()) {
      const content = contentHeightOf(e)
      if (e.win && !e.win.isDestroyed()) {
        e.win.setBounds({ x, y, width: NOTIFICATION_WIDTH, height: content + 2 * MARGIN })
      }
      // The windows' transparent margins overlap, so the visible gap is 12 px.
      y += content + NOTIFICATION_GAP
    }
  }

  function destroy(e: Entry): void {
    if (e.queueTimer) clearTimeout(e.queueTimer)
    if (e.hideTimer) clearTimeout(e.hideTimer)
    e.queueTimer = null
    e.hideTimer = null
    entries.delete(e.id)
    if (e.win && !e.win.isDestroyed()) e.win.destroy()
    e.win = null
  }

  function drop(e: Entry, reason: string): void {
    log('info', 'notify:dropped', { variant: e.req.variant, reason })
    destroy(e)
  }

  /** Animate out for 300 ms, then destroy and reflow. */
  function hide(id: string): void {
    const e = entries.get(id)
    if (!e) return
    if (e.state === 'queued') {
      destroy(e)
      return
    }
    if (e.state === 'leaving') return
    e.state = 'leaving'
    if (e.hideTimer) clearTimeout(e.hideTimer)
    e.hideTimer = null
    const wc = e.win && !e.win.isDestroyed() ? e.win.webContents : null
    if (wc && !wc.isDestroyed()) wc.send('notify:animate-out' satisfies PushChannel, { id })
    setTimeout(() => {
      destroy(e)
      log('debug', 'notify:hidden', { variant: e.req.variant })
      reflow()
    }, ANIMATE_OUT_MS)
  }

  function armHide(e: Entry, at: number | null): void {
    if (e.hideTimer) clearTimeout(e.hideTimer)
    e.hideTimer = null
    e.hideAt = at
    if (at === null) return
    e.hideTimer = setTimeout(() => hide(e.id), Math.max(0, at - Date.now()))
  }

  /** The show-time checks (no sign-in rule: Notula has no accounts). Null = show. */
  async function blockedReason(e: Entry): Promise<string | null> {
    const { req } = e
    if (ctx.ui.inOnboarding() && !req.allowDuringOnboarding) return 'onboarding'
    const start = eventStartMs(req)
    if (req.variant === 'scheduled-meeting' && req.calendarEventId && start !== null) {
      // `meeting_notification_skip_rescheduled_meetings` on: gone or moved → drop.
      const events = await ctx.calendar.listEvents({
        from: new Date(start - DAY_MS).toISOString(),
        to: new Date(start + DAY_MS).toISOString()
      })
      const ev = events.find((x) => x.id === req.calendarEventId)
      const evStart = ev ? Date.parse(ev.start?.dateTime ?? ev.start?.date ?? '') : NaN
      if (!ev) return 'event-gone'
      if (evStart !== start) return 'event-moved'
    }
    if (start !== null && Date.now() - start > STALE_MS) return 'stale'
    const capturing = ctx.capture.currentNoteId()
    if (capturing) {
      if (req.quietWhileRecording) return 'transcribing'
      if (req.calendarEventId) {
        const note = await ctx.storage.getNote(capturing)
        if (note?.linked_event?.id === req.calendarEventId) return 'transcribing-this-meeting'
      }
    }
    // Rule 6: the user is looking at this event (`calendar:viewing-event`, only while the
    // main window is visible).
    if (req.calendarEventId && ctx.calendar.viewingEventId() === req.calendarEventId) return 'viewing-event'
    const s = await ctx.settings.getAll()
    // Source cards have their own gates (sources/offer.ts); the calendar-card mute doesn't apply.
    if (req.variant === 'source-detected') return null
    if (req.variant !== 'detected-meeting' && s['notifications.scheduledBlocked']) return 'scheduled-blocked'
    if (req.variant === 'detected-meeting' && s['notifications.autoDetectedBlocked']) return 'auto-detected-blocked'
    return null
  }

  async function due(e: Entry): Promise<void> {
    e.queueTimer = null
    if (entries.get(e.id) !== e) return
    try {
      if (e.req.quietWhileRecording && ctx.capture.isCapturing()) return drop(e, 'transcribing')
      if (e.req.lastMomentCheck && !(await e.req.lastMomentCheck())) return drop(e, 'last-moment-check')
      const reason = await blockedReason(e)
      if (entries.get(e.id) !== e) return
      if (reason) return drop(e, reason)
    } catch (err) {
      log('warn', 'notify:check-failed', { variant: e.req.variant, err })
      return drop(e, 'check-failed')
    }
    await decorate(e)
    if (entries.get(e.id) !== e) return
    // A card already on screen for the same event and variant is replaced.
    if (e.req.calendarEventId) {
      for (const other of showing()) {
        if (other.req.variant === e.req.variant && other.req.calendarEventId === e.req.calendarEventId) hide(other.id)
      }
    }
    display(e)
  }

  function display(e: Entry): void {
    const win = ctx.windows.createSecondary({
      kind: 'notification',
      route: '/notification',
      title: 'Notification',
      width: NOTIFICATION_WIDTH,
      height: DEFAULT_CONTENT_HEIGHT + 2 * MARGIN,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      roundedCorners: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      ...(process.platform === 'darwin' ? { type: 'panel' } : {})
    })
    e.win = win
    e.wcId = win.webContents.id
    e.state = 'showing'
    e.arrival = ++arrivals
    e.payload = { ...e.payload, shownAt: new Date().toISOString() }
    keepTransparent(win)
    // Over full-screen apps, on every workspace (on-top level 1).
    win.setAlwaysOnTop(true, 'screen-saver', 1)
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    if (process.platform === 'darwin') win.setHiddenInMissionControl(true)
    win.on('closed', () => {
      if (entries.get(e.id) === e) entries.delete(e.id)
      if (e.hideTimer) clearTimeout(e.hideTimer)
      reflow()
    })
    reflow()
    // Armed now, so a window that never finishes loading still goes away.
    armHide(e, e.req.hideAfterMs !== null ? Date.now() + e.req.hideAfterMs : null)
    win.once('ready-to-show', () => {
      if (win.isDestroyed() || e.state !== 'showing') return
      reapplyTransparent(win)
      win.showInactive()
      lastShown.set(e.req.variant, Date.now())
      // No telemetry: a local line instead of `notification_appeared`.
      log('info', 'notify:appeared', { variant: e.req.variant, card: 'v1' })
      reflow()
    })
  }

  function handleAction(e: Entry, action: NotificationAction): void {
    log('info', 'notify:action', { variant: e.req.variant, action })
    switch (action) {
      case 'hide':
        break
      case 'block':
      case 'unblock':
        void ctx.settings
          .set('notifications.scheduledBlocked', action === 'block')
          .catch((err: unknown) => log('warn', 'notify:block-failed', { err }))
        break
      case 'mute_app_notifications': {
        const appId = e.req.micAppId
        if (!appId) break
        void ctx.settings
          .get('notifications.silencedAppIds')
          .then((ids) => (ids.includes(appId) ? undefined : ctx.settings.set('notifications.silencedAppIds', [...ids, appId])))
          .catch((err: unknown) => log('warn', 'notify:silence-failed', { err }))
        break
      }
      case 'open_settings': {
        const main = ctx.windows.main()
        if (main) {
          if (main.isMinimized()) main.restore()
          main.show()
          main.focus()
          main.webContents.send('settings:open' satisfies PushChannel, { section: 'notifications' })
        }
        break
      }
      default:
        try {
          e.req.onAction(action)
        } catch (err) {
          log('error', 'notify:on-action-failed', { variant: e.req.variant, action, err })
        }
    }
    // Every action dismisses the card.
    hide(e.id)
  }

  const bySender = (wcId: number, id: unknown): Entry | null => {
    if (typeof id !== 'string') return null
    const e = entries.get(id)
    // A window may only speak for its own card.
    return e && e.wcId === wcId ? e : null
  }

  ipcMain.handle('notify:get-payload' satisfies InvokeChannel, (event): InvokeRes<'notify:get-payload'> => {
    for (const e of entries.values()) if (e.wcId === event.sender.id && e.state !== 'queued') return e.payload
    return null
  })

  ipcMain.on('notify:action' satisfies SendChannel, (event, raw: SendPayload<'notify:action'>) => {
    const action = raw?.action
    const e = bySender(event.sender.id, raw?.id)
    if (!e) {
      log('warn', 'notify:action-for-missing-notification', { action: typeof action === 'string' ? action.slice(0, 40) : null })
      return
    }
    if (!isCardAction(e, action)) {
      log('warn', 'notify:action-invalid')
      return
    }
    if (e.state === 'leaving') return
    // While Notula is locked, acting on a card first unlocks (hiding never needs it).
    if (action !== 'hide' && ctx.deviceLock.isLocked()) {
      void ctx.deviceLock
        .requestUnlock()
        .then((ok) => {
          if (ok && entries.get(e.id) === e && e.state !== 'leaving') handleAction(e, action)
        })
        .catch((err: unknown) => log('warn', 'notify:unlock-failed', { err }))
      return
    }
    handleAction(e, action)
  })

  ipcMain.on('notify:content-height' satisfies SendChannel, (event, raw: SendPayload<'notify:content-height'>) => {
    const e = bySender(event.sender.id, raw?.id)
    const h = raw?.height
    if (!e || typeof h !== 'number' || !Number.isFinite(h)) return
    const next = Math.max(MIN_CONTENT_HEIGHT, Math.min(800, Math.round(h)))
    if (next === e.contentHeight) return
    e.contentHeight = next
    reflow()
  })

  ipcMain.on('notify:menu-open' satisfies SendChannel, (event, raw: SendPayload<'notify:menu-open'>) => {
    const e = bySender(event.sender.id, raw?.id)
    if (!e || typeof raw?.open !== 'boolean' || e.menuOpen === raw.open) return
    e.menuOpen = raw.open
    reflow()
  })

  // After a resume every card is checked again.
  ctx.bus.on('power:resumed', () => {
    const now = Date.now()
    for (const e of [...entries.values()]) {
      const start = eventStartMs(e.req)
      if (e.state === 'showing') {
        if (start !== null) {
          if (now - start > STALE_MS) hide(e.id)
          else armHide(e, start + STALE_MS)
        } else if (e.hideAt !== null && e.hideAt <= now) {
          hide(e.id)
        }
      } else if (e.state === 'queued' && start !== null) {
        if (now - start > STALE_MS) {
          drop(e, 'stale-after-resume')
          continue
        }
        if (e.queueTimer) clearTimeout(e.queueTimer)
        e.queueTimer = setTimeout(() => void due(e), Math.max(0, start - REMINDER_LEAD_MS - now))
      }
    }
  })

  screen.on('display-added', () => reflow())
  screen.on('display-removed', () => reflow())
  screen.on('display-metrics-changed', () => reflow())

  const destroyAll = (): void => {
    for (const e of [...entries.values()]) destroy(e)
  }
  app.on('will-quit', destroyAll)
  // Without a main window nothing may keep the app alive (the app quits on last close).
  watchMainWindow(ctx, { attached: () => undefined, closed: destroyAll })

  const api: NotifyApi = {
    show: (req) => {
      const id = req.id ?? randomUUID()
      const old = entries.get(id)
      if (old) destroy(old)
      const e: Entry = {
        id,
        req,
        payload: toPayload(id, req),
        state: 'queued',
        win: null,
        wcId: null,
        queueTimer: null,
        hideTimer: null,
        hideAt: null,
        contentHeight: DEFAULT_CONTENT_HEIGHT,
        menuOpen: false,
        arrival: 0
      }
      entries.set(id, e)
      e.queueTimer = setTimeout(() => void due(e), Math.max(0, req.showDelayMs))
      log('debug', 'notify:queued', { variant: req.variant, delayMs: req.showDelayMs })
      return id
    },
    hide,
    visible: () => showing().filter((e) => e.state === 'showing').map((e) => e.payload),
    registerDecorator: (d) => {
      decorators.add(d)
      return () => {
        decorators.delete(d)
      }
    },
    cardWebContents: (id): WebContents | null => {
      const win = entries.get(id)?.win
      return win && !win.isDestroyed() && !win.webContents.isDestroyed() ? win.webContents : null
    }
  }
  showDevFixtures(api)
  return api
}

/**
 * Dev builds only: `NOTULA_DEV_NOTIFY_FIXTURES=<n>` queues n fixture cards 5 s after
 * launch, for the stacking and suppression smoke checks.
 */
function showDevFixtures(api: NotifyApi): void {
  if (app.isPackaged) return
  const n = Math.min(4, Math.max(0, Math.floor(Number(process.env['NOTULA_DEV_NOTIFY_FIXTURES']) || 0)))
  if (!n) return
  const start = new Date(Date.now() + 60_000)
  const end = new Date(start.getTime() + 30 * 60_000)
  const time = (d: Date): string => d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  for (let i = 1; i <= n; i++) {
    api.show({
      variant: i % 2 ? 'scheduled-meeting' : 'detected-meeting',
      title: i % 2 ? `Fixture meeting ${i}` : 'Meeting detected',
      body: i % 2 ? `${time(start)} - ${time(end)}` : 'Fixture app',
      micAppId: i % 2 ? null : 'us.zoom.xos',
      micAppName: i % 2 ? null : 'Zoom',
      joinUrl: i === 1 ? 'https://example.com/fixture' : null,
      conferenceProvider: i === 1 ? 'Zoom' : null,
      countdownMs: i % 2 ? null : 20_000,
      showDelayMs: 5_000 + i * 200,
      hideAfterMs: 120_000,
      quietWhileRecording: false,
      allowDuringOnboarding: false,
      onAction: (action) => log('info', 'notify:fixture-action', { i, action })
    })
  }
}
