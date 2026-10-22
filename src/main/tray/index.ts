// SPDX-License-Identifier: Apache-2.0
// registerTray(): the tray icon and menu.
//
// Rows, in order: event groups · Open Notula · New Note · Settings · the version ·
// the update rows · Troubleshooting ▸ Record Performance Trace (10s) (Windows) · Quit ·
// Restart Notula (Windows) · Quit Completely, or Quit Options
// on macOS while the menu-bar title is on. No account rows. While Voice typing is armed,
// "Show dictation bar" toggles the dictation bar and ends a snooze.
//
// - Events come from main (`ctx.calendar.listEvents`), never from a renderer push,
//   so the tray works before any window has loaded. Until calendar sync ships, a dev
//   build can read fixture events from the JSON file named by `NOTULA_DEV_TRAY_EVENTS`.
// - The menu rebuilds on preference, calendar and update-state changes and on every
//   minute boundary (labels such as "Starts in 5m" and the macOS menu-bar title).
// - The `tray_*` analytics are local debug lines only.

import { readFileSync } from 'node:fs'
import { app, Menu, nativeImage, screen, Tray, type MenuItemConstructorOptions, type NativeImage } from 'electron'
import type { UpdateState } from '@shared/types/app'
import type { CalendarEvent } from '@shared/types/notes'
import type { SettingKey } from '@shared/types/settings'
import type { MainContext } from '../context'
import { openSettingsSection, quitCompletely, requestNewNote, restartApp, showMainWindow, softQuit } from '../lifecycle'
import { resourcePath } from '../lifecycle/resources'
import { log } from '../log'
import { isLocalOnly } from '../privacy'
import { checkForUpdatesNow, getUpdateState, installUpdateNow, onUpdateState } from '../updater/state'
import { startTrace } from '../diagnostics'
import {
  filterEvents,
  groupEvents,
  highlightedEvent,
  menuBarTitle,
  rowLabel,
  rowSublabel,
  startOfDay,
  toTrayEvents,
  type JoinProvider,
  type TrayEvent
} from './events'

const isMac = process.platform === 'darwin'
const isWindows = process.platform === 'win32'
const JUST_CHECKED_MS = 60_000
const TRAY_SETTING_KEYS: readonly SettingKey[] = [
  'tray.showUpcomingEventInMenuBar',
  'calendar.filterPersonalEvents',
  'profile.email',
  'voiceTyping.enabled',
  'dictation.enabled',
  'dictationBar.enabled',
  'dictationBar.snoozeUntil'
]

function debug(event: string, data?: Record<string, unknown>): void {
  log('debug', event, data)
}

function trayIcon(): NativeImage {
  const image = nativeImage.createFromPath(resourcePath(isMac ? 'trayTemplate.png' : 'tray.ico'))
  if (image.isEmpty()) log('warn', 'tray:icon-missing')
  if (isMac) image.setTemplateImage(true)
  return image
}

const joinIcons = new Map<JoinProvider, NativeImage | null>()
function joinIcon(provider: JoinProvider | null): NativeImage | null {
  if (!provider) return null
  if (!joinIcons.has(provider)) {
    const image = nativeImage.createFromPath(resourcePath(`join-${provider.replace('_', '-')}.png`))
    joinIcons.set(provider, image.isEmpty() ? null : image)
  }
  return joinIcons.get(provider) ?? null
}

/**
 * Dev only: fixture events while `ctx.calendar` has none. Each entry is a Google-style
 * event; `startInMinutes` / `durationMinutes` place it relative to the moment the file
 * is read (once per launch), so the 5- and 10-minute rules can be checked by hand.
 */
function loadFixtureEvents(isDev: boolean): CalendarEvent[] {
  const file = isDev ? process.env['NOTULA_DEV_TRAY_EVENTS'] : undefined
  if (!file) return []
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown
    if (!Array.isArray(raw)) return []
    const now = Date.now()
    return raw.flatMap((item, i): CalendarEvent[] => {
      if (!item || typeof item !== 'object') return []
      const ev = { id: `fixture-${i}`, ...(item as Record<string, unknown>) } as CalendarEvent & {
        startInMinutes?: unknown
        durationMinutes?: unknown
      }
      if (typeof ev.startInMinutes === 'number') {
        const start = now + ev.startInMinutes * 60_000
        const minutes = typeof ev.durationMinutes === 'number' ? ev.durationMinutes : 30
        ev.start = { dateTime: new Date(start).toISOString() }
        ev.end = { dateTime: new Date(start + minutes * 60_000).toISOString() }
      }
      return [ev]
    })
  } catch (err) {
    log('warn', 'tray:fixture-unreadable', { err })
    return []
  }
}

/** The update rows: the update state, then the check row. */
function updateRows(s: UpdateState, now: number): MenuItemConstructorOptions[] {
  const rows: MenuItemConstructorOptions[] = []
  const d = s.download
  if (d.state === 'downloading') {
    rows.push({ label: `Downloading v${d.version} (${d.percent}%)`, enabled: false })
  } else if (d.state === 'downloaded') {
    rows.push({
      label: `Install Latest Version (v${d.version})`,
      enabled: !s.installing,
      click: () => {
        debug('tray:item-clicked', { item: 'install' })
        void installUpdateNow('tray').catch((err: unknown) => log('warn', 'tray:install-failed', { err }))
      }
    })
  } else if (s.feed === 'none' || s.lastCheck?.available === false) {
    // With no feed there is nothing newer to find, so it reads "Latest version".
    const at = s.lastCheck ? Date.parse(s.lastCheck.at) : Number.NaN
    const justChecked = !s.lastCheck?.available && now - at < JUST_CHECKED_MS
    rows.push({ label: `Latest version${justChecked ? ' (just checked!)' : ''}`, enabled: false })
  }
  if (!s.packaged) {
    rows.push({ label: 'Not packaged', enabled: false })
  } else if (s.checking) {
    rows.push({ label: 'Checking for updates...', enabled: false })
  } else {
    rows.push({
      label: 'Check for updates',
      click: () => {
        debug('tray:item-clicked', { item: 'check-for-updates' })
        checkForUpdatesNow('tray')
      }
    })
  }
  return rows
}

export function registerTray(ctx: MainContext): void {
  let tray: Tray
  try {
    tray = new Tray(trayIcon())
  } catch (err) {
    log('error', 'tray:create-failed', { err })
    return
  }
  // The tooltip says when Nothing leaves this machine is on.
  const setTooltip = (): void => {
    if (!tray.isDestroyed()) tray.setToolTip(isLocalOnly() ? 'Notula · Local only' : 'Notula')
  }
  setTooltip()
  app.on('will-quit', () => {
    if (!tray.isDestroyed()) tray.destroy()
  })

  const fixtures = loadFixtureEvents(ctx.isDev)
  let calendarEvents: CalendarEvent[] = []
  let showTitle = false
  let onlyWithOthers = false
  let ownEmail: string | null = null
  let bar = { armed: false, shown: false }

  // ---- event rows ----

  async function onEventClick(e: TrayEvent, joinable: boolean): Promise<void> {
    let joined = false
    if (joinable && e.joinUrl) {
      try {
        joined = await ctx.calendar.join(e.joinUrl)
      } catch (err) {
        log('warn', 'tray:join-failed', { err })
      }
    }
    debug('tray:event-clicked', { joined, provider: e.provider })
    // Transcription auto-starts only when the join link opened.
    requestNewNote('tray', { autoTranscribe: joined, event: e.event })
  }

  function eventRow(e: TrayEvent, joinable: boolean): MenuItemConstructorOptions {
    const icon = joinable ? joinIcon(e.provider) : null
    return {
      label: rowLabel(e),
      sublabel: rowSublabel(e, app.getLocale(), !!icon),
      ...(icon ? { icon } : {}),
      click: () => void onEventClick(e, joinable)
    }
  }

  function eventSection(events: TrayEvent[], now: Date): MenuItemConstructorOptions[] {
    if (events.length === 0) return []
    const g = groupEvents(events, now, process.platform)
    const groups: MenuItemConstructorOptions[][] = []
    if (g.highlighted) groups.push([{ label: g.highlighted.label, enabled: false }, eventRow(g.highlighted.event, g.highlighted.joinable)])
    if (g.today.length) groups.push([{ label: 'Today', enabled: false }, ...g.today.map((e) => eventRow(e, false))])
    if (g.tomorrow.length) groups.push([{ label: 'Tomorrow', enabled: false }, ...g.tomorrow.map((e) => eventRow(e, false))])
    return groups.flatMap((rows, i) => (i === 0 ? rows : [{ type: 'separator' as const }, ...rows])).concat({ type: 'separator' })
  }

  // ---- the menu ----

  function item(label: string, name: string, click: () => void): MenuItemConstructorOptions {
    return {
      label,
      click: () => {
        debug('tray:item-clicked', { item: name })
        click()
      }
    }
  }

  function currentEvents(now: Date): TrayEvent[] {
    const source = calendarEvents.length > 0 ? calendarEvents : fixtures
    return filterEvents(toTrayEvents(source, ownEmail), now, onlyWithOthers)
  }

  let justCheckedTimer: NodeJS.Timeout | null = null

  function rebuild(): void {
    if (tray.isDestroyed()) return
    const now = new Date()
    const events = currentEvents(now)
    const update = getUpdateState()
    const template: MenuItemConstructorOptions[] = [
      ...eventSection(events, now),
      item('Open Notula', 'open', () => showMainWindow()),
      item('New Note', 'new-note', () => requestNewNote('tray', { autoTranscribe: true })),
      // The meeting dock, while it is on, capturing and hidden.
      ...(ctx.meetingDock.isAvailable()
        ? [item('Show meeting dock', 'show-meeting-dock', () => void ctx.meetingDock.show().catch((err: unknown) => log('warn', 'tray:meeting-dock-failed', { err })))]
        : []),
      ...(bar.armed
        ? [
            {
              label: 'Show the dictation bar',
              type: 'checkbox' as const,
              checked: bar.shown,
              click: () => {
                debug('tray:item-clicked', { item: 'show-dictation-bar' })
                const on = !bar.shown
                void ctx.settings.set('dictationBar.enabled', on).catch((err: unknown) => log('warn', 'tray:setting-failed', { err }))
                if (on) void ctx.settings.set('dictationBar.snoozeUntil', null).catch((err: unknown) => log('warn', 'tray:setting-failed', { err }))
              }
            }
          ]
        : []),
      item('Settings', 'settings', () => openSettingsSection('preferences', 'tray')),
      { label: `Notula v${app.getVersion()}`, enabled: false },
      ...updateRows(update, now.getTime()),
      { type: 'separator' },
      // Troubleshooting: Windows only.
      ...(isWindows
        ? ([
            {
              label: 'Troubleshooting',
              submenu: [
                item('Record Performance Trace (10s)', 'record-trace', () => {
                  void startTrace(ctx, 'tray').catch((err: unknown) => log('info', 'tray:trace-not-started', { err }))
                })
              ]
            },
            { type: 'separator' }
          ] satisfies MenuItemConstructorOptions[])
        : []),
      item('Quit', 'quit', () => void softQuit('tray'))
    ]
    if (isWindows) template.push(item('Restart Notula', 'restart', () => restartApp('tray')), { type: 'separator' })
    if (isMac && showTitle) {
      template.push({
        label: 'Quit Options',
        submenu: [
          item("Hide next meeting from the menu bar", 'hide-menu-bar-events', () => {
            void ctx.settings.set('tray.showUpcomingEventInMenuBar', false).catch((err: unknown) => log('warn', 'tray:setting-failed', { err }))
          }),
          item('Quit Completely', 'quit-completely', () => void quitCompletely('tray'))
        ]
      })
    } else {
      template.push(item('Quit Completely', 'quit-completely', () => void quitCompletely('tray')))
    }
    tray.setContextMenu(Menu.buildFromTemplate(template))

    if (isMac) {
      const display = screen.getAllDisplays()
      const shortTitles = display.length === 1 && display[0]?.internal === true
      tray.setTitle(showTitle ? menuBarTitle(highlightedEvent(events, now), now, shortTitles) : '')
    }

    // The "(just checked!)" suffix lasts 60 s.
    if (justCheckedTimer) clearTimeout(justCheckedTimer)
    justCheckedTimer = null
    const at = update.lastCheck ? Date.parse(update.lastCheck.at) : Number.NaN
    const left = at + JUST_CHECKED_MS - now.getTime()
    if (left > 0) justCheckedTimer = setTimeout(rebuild, left + 50)
  }

  async function loadSettings(): Promise<void> {
    try {
      const s = await ctx.settings.getAll()
      showTitle = s['tray.showUpcomingEventInMenuBar']
      onlyWithOthers = s['calendar.filterPersonalEvents']
      ownEmail = s['profile.email'].trim() || null
      const until = s['dictationBar.snoozeUntil']
      bar = {
        armed: (isWindows || isMac) && s['voiceTyping.enabled'] && s['dictation.enabled'],
        shown: s['dictationBar.enabled'] && (until === null || until <= Date.now())
      }
    } catch (err) {
      log('warn', 'tray:settings-failed', { err })
    }
  }

  async function loadEvents(): Promise<void> {
    const from = startOfDay(new Date())
    const to = new Date(from.getFullYear(), from.getMonth(), from.getDate() + 2)
    try {
      calendarEvents = await ctx.calendar.listEvents({ from: from.toISOString(), to: to.toISOString() })
    } catch (err) {
      log('warn', 'tray:events-failed', { err })
      calendarEvents = []
    }
  }

  async function refresh(): Promise<void> {
    await Promise.all([loadSettings(), loadEvents()])
    rebuild()
  }

  // ---- clicks ----
  tray.on('click', () => {
    debug('tray:clicked')
    if (isWindows) showMainWindow()
    else rebuild()
  })

  // ---- rebuild triggers ----
  ctx.bus.on('settings:changed', ({ keys }) => {
    if (keys.some((k) => TRAY_SETTING_KEYS.includes(k))) void refresh()
    // index.ts updates the local-only cache before this listener runs.
    if (keys.includes('privacy.localOnly')) setTooltip()
  })
  // The meeting dock item follows capture.
  ctx.bus.on('capture:started', () => rebuild())
  ctx.bus.on('capture:stopped', () => rebuild())
  ctx.bus.on('calendar:changed', () => void refresh())
  ctx.bus.on('storage:status', (s) => {
    if (s.state === 'ready') void refresh()
  })
  onUpdateState(() => rebuild())

  // Every minute boundary: the relative labels, the title and the event list.
  const scheduleMinute = (): void => {
    const now = Date.now()
    setTimeout(
      () => {
        void refresh()
        scheduleMinute()
      },
      60_000 - (now % 60_000) + 20
    )
  }
  scheduleMinute()

  rebuild()
  void refresh()
}
