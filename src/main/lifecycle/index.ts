// SPDX-License-Identifier: Apache-2.0
// registerLifecycle(): close-to-tray, soft Quit / Quit Completely / Restart, the jump
// list and dock menu, launch arguments, deep links and UiStateApi, with their `app:*` and
// `deeplink:*` IPC.
//
// - Close hides the main window. Only a real quit closes it: `before-quit` (Quit
//   Completely, Restart, an update install, system shutdown) marks the app as quitting
//   for real, and the teardown then runs through the normal path: capture drains in
//   `before-quit`, index.ts closes storage in `will-quit`, the meeting windows are destroyed.
// - The tray, menus, jump list and dock call the actions below; they never quit or
//   restart on their own.
// - Deep links: the build's own scheme only. A link that arrives before the main
//   window's listener is mounted (a cold start) waits as the one pending event the
//   renderer fetches with `deeplink:get-pending`; that call is also the signal that the
//   renderer can take pushes.
//
// Handlers and pushes write their channel literal.

import { resolve } from 'node:path'
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  powerMonitor,
  screen,
  type MessageBoxOptions,
  type Rectangle,
  type Task,
  type WebContents
} from 'electron'
import type { InvokeChannel, InvokeRes, PushChannel, SendChannel } from '@shared/ipc'
import {
  APP_TASK_ARG_PREFIX,
  DEEP_LINK_SCHEME,
  DEEP_LINK_SCHEME_DEV,
  type AppTask,
  type DeepLinkEvent,
  type DeepLinkUnsupported
} from '@shared/types/app'
import type { CalendarEvent, CreationOrigin, NewNoteRequest } from '@shared/types/notes'
import type { SettingsSection } from '@shared/types/settings'
import type { LifecycleHooks, MainContext, UiStateApi } from '../context'
import { log } from '../log'
import { checkForUpdatesNow } from '../updater/state'
import type { Windows } from '../windows'
import { DuplicateGuard, eventKey, findSchemeUrl, parseDeepLink } from './deeplinks'
import { relaunchArgs } from './relaunch'
import { resourcePath } from './resources'

const isMac = process.platform === 'darwin'
const isWindows = process.platform === 'win32'

/** macOS: leaving full screen animates; hiding before it ends leaves a black space. */
const LEAVE_FULL_SCREEN_MS = 750
/** How long an action waits for the main window's renderer before it is dropped. */
const READY_WAIT_MS = 10_000
/** A startup plan gives up waiting for the first paint after this long. */
const FIRST_PAINT_WAIT_MS = 10_000
const APP_TASKS: readonly AppTask[] = ['settings', 'restart', 'quit', 'quit-completely', 'background']

/** The scheme this build registers and accepts. */
export const deepLinkScheme = (): string => (app.isPackaged ? DEEP_LINK_SCHEME : DEEP_LINK_SCHEME_DEV)

// ---------- module state (shared with the tray, updater, menus and preferences) ----------

interface Bound {
  ctx: MainContext
  windows: Windows
}

let bound: Bound | null = null
const quitState = { forReal: false, installingUpdate: false, restartPending: false }
let dialogOpen = false

/** The main window's renderer has mounted its deep-link listener since its last load. */
let rendererReady = false
let pending: DeepLinkEvent | null = null
const readyQueue: { label: string; expires: number; run(wc: WebContents): void }[] = []
const unsupportedQueue: DeepLinkUnsupported[] = []
const rawGuard = new DuplicateGuard(2_000)
const eventGuard = new DuplicateGuard(1_000)

/** How the next main window shows itself: the post-update restore, or a `quit` task cold start. */
export interface StartupWindowPlan {
  bounds?: Rectangle
  visible: boolean
  focused: boolean
}
let startupPlan: StartupWindowPlan | null = null

/** The updater's restore and the `quit` task use it before the window exists. */
export function setStartupWindowPlan(plan: StartupWindowPlan): void {
  startupPlan = startupPlan ? { ...plan, visible: plan.visible && startupPlan.visible } : plan
}

/** Main's close button hides the window unless one of these holds. */
function allowMainWindowClose(): boolean {
  return quitState.forReal || quitState.installingUpdate || (quitState.restartPending && !app.isPackaged)
}

/** The updater marks the install, so the window's close is no longer a hide. */
export function markInstallingUpdate(): void {
  quitState.installingUpdate = true
}

function logAction(event: string, data?: Record<string, unknown>): void {
  log('info', event, data)
}

// ---------- the main window ----------

/** Shows, restores and focuses the main window, creating it if needed. */
export function showMainWindow(): BrowserWindow | null {
  if (!bound) return null
  if (isMac) void app.dock?.show()
  return bound.windows.showMain()
}

async function leaveFullScreen(win: BrowserWindow): Promise<void> {
  if (!isMac || !win.isFullScreen()) return
  win.setFullScreen(false)
  await new Promise((r) => setTimeout(r, LEAVE_FULL_SCREEN_MS))
}

/** Hides the main window into the tray (close button, soft Quit). */
async function hideMainWindow(reason: string, opts: { hideDock: boolean }): Promise<void> {
  const win = bound?.windows.main()
  if (win && !win.isDestroyed()) {
    await leaveFullScreen(win)
    if (!win.isDestroyed()) win.hide()
  }
  if (isMac && opts.hideDock) app.dock?.hide()
  logAction('lifecycle:hidden', { reason })
}

/** A message box, attached to the visible main window or standalone. */
async function ask(options: MessageBoxOptions, attach: boolean): Promise<number | null> {
  if (dialogOpen) return null
  dialogOpen = true
  try {
    const win = bound?.windows.main()
    const parent = attach && win && win.isVisible() && !win.isMinimized() ? win : null
    const { response } = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options)
    return response
  } finally {
    dialogOpen = false
  }
}

const Q1: MessageBoxOptions = {
  type: 'warning',
  message: 'Stop transcribing?',
  detail: 'Closing Notula will stop transcription.',
  buttons: ['Quit', 'Cancel'],
  defaultId: 0,
  cancelId: 1,
  noLink: true
}

const Q2: MessageBoxOptions = {
  type: 'question',
  message: 'Quit Notula?',
  detail: 'Reminders and voice typing stop until you open it again.',
  buttons: ['Quit', 'Cancel'],
  defaultId: 0,
  cancelId: 1,
  noLink: true
}

// ---------- actions ----------

/**
 * Quit (CmdOrCtrl+Q, the tray, the jump-list Quit task): Q1 while transcribing, then the stop
 * (`window_closed`) and hide. Notula keeps running in the tray.
 */
export async function softQuit(source: string): Promise<void> {
  if (!bound) {
    app.quit()
    return
  }
  const { ctx } = bound
  logAction('lifecycle:quit', { source })
  if (ctx.capture.isCapturing()) {
    const answer = await ask(Q1, true)
    if (answer !== 0) return
    void ctx.capture.stop('window_closed').catch((err: unknown) => log('error', 'lifecycle:quit-stop-failed', { err }))
  }
  await hideMainWindow(`quit:${source}`, { hideDock: true })
}

/**
 * Quit Completely: Q1 while transcribing, otherwise Q2; Quit runs the full teardown.
 * The jump-list Quit Completely task keeps its promise of no confirmation and skips Q2:
 * launched from the taskbar with the window hidden, the box was easy to miss. Q1 still asks.
 */
export async function quitCompletely(source: string): Promise<void> {
  logAction('lifecycle:quit-completely', { source })
  const capturing = bound?.ctx.capture.isCapturing() ?? false
  if (capturing || !source.startsWith('task:')) {
    const answer = await ask(capturing ? Q1 : Q2, false)
    if (answer !== 0) return
  }
  quitState.forReal = true
  app.quit()
}

/**
 * Restart: the restart mark, a relaunch with the filtered
 * arguments, then the teardown. No confirmation, also while transcribing: the
 * stop runs through the drained `before-quit` path, so the transcript is kept.
 */
export function restartApp(source: string): void {
  const args = relaunchArgs(process.argv.slice(1), app.isPackaged, [DEEP_LINK_SCHEME, DEEP_LINK_SCHEME_DEV])
  logAction('lifecycle:restart', { source, argCount: args.length })
  quitState.restartPending = true
  quitState.forReal = true
  app.relaunch({ args })
  app.quit()
}

/** Runs `fn` with the main renderer once its listeners are mounted (or drops it after 10 s). */
function whenRendererReady(label: string, fn: (wc: WebContents) => void): void {
  if (!bound) return
  const win = bound.windows.main()
  if (win && rendererReady && !win.webContents.isDestroyed()) {
    fn(win.webContents)
    return
  }
  readyQueue.push({ label, expires: Date.now() + READY_WAIT_MS, run: fn })
  if (!win) showMainWindow()
}

function flushReady(wc: WebContents): void {
  const now = Date.now()
  for (const item of readyQueue.splice(0)) {
    if (item.expires < now) {
      log('info', 'lifecycle:action-expired', { label: item.label })
      continue
    }
    try {
      item.run(wc)
    } catch (err) {
      log('error', 'lifecycle:action-failed', { label: item.label, err })
    }
  }
  for (const u of unsupportedQueue.splice(0)) wc.send('deeplink:unsupported' satisfies PushChannel, u)
}

/**
 * Opens Settings. `section` undefined is the app menu's request: the renderer
 * keeps the current page when Settings is already open. The tray, jump list and dock
 * pass `preferences`. With no loaded main window, the request waits as the
 * pending `show-settings` event ("a window opens on home, then jumps").
 */
export function openSettingsSection(section: SettingsSection | undefined, source: string): void {
  if (!bound) return
  logAction('lifecycle:show-settings', { section: section ?? null, source })
  const win = showMainWindow()
  if (win && !win.webContents.isLoading() && rendererReady) {
    win.webContents.send('settings:open' satisfies PushChannel, section === undefined ? {} : { section })
    return
  }
  deliverEvent({ type: 'show-settings', data: { page: section ?? 'preferences' } }, source)
}

/**
 * A new note from main (tray, dock, menu). While capturing, the window shows the
 * blocked toast instead. Notes from the menu, the tray's New Note and the dock
 * auto-start transcription; a tray event row only when its join link opened.
 */
export function requestNewNote(origin: CreationOrigin, opts: { autoTranscribe: boolean; event?: CalendarEvent }): void {
  if (!bound) return
  const { ctx } = bound
  if (ctx.capture.isCapturing()) {
    const win = showMainWindow()
    win?.webContents.send('notes:new-blocked' satisfies PushChannel)
    log('info', 'lifecycle:new-note-blocked', { origin, noteId: ctx.capture.currentNoteId() })
    return
  }
  const request: NewNoteRequest = {
    creationSource: origin,
    autoTranscribe: opts.autoTranscribe,
    ...(opts.event ? { event: opts.event } : {})
  }
  showMainWindow()
  whenRendererReady(`new-note:${origin}`, (wc) => wc.send('notes:new-requested' satisfies PushChannel, request))
}

// ---------- deep links ----------

/** Pushes the event, or keeps it as the one pending event (a newer one replaces it). */
function deliverEvent(event: DeepLinkEvent, source: string): void {
  if (!bound) return
  if (eventGuard.check(eventKey(event))) {
    log('info', 'deeplink:duplicate-event', { type: event.type, source })
    return
  }
  const win = showMainWindow()
  if (win && rendererReady && !win.webContents.isDestroyed()) {
    win.webContents.send('deeplink:received' satisfies PushChannel, event)
    log('info', 'deeplink:dispatched', { type: event.type, source })
    return
  }
  if (pending) log('info', 'deeplink:pending-replaced', { type: pending.type })
  pending = event
  log('info', 'deeplink:pending', { type: event.type, source })
}

function pushUnsupported(u: DeepLinkUnsupported): void {
  const win = bound?.windows.main()
  if (win && rendererReady && !win.webContents.isDestroyed()) {
    win.webContents.send('deeplink:unsupported' satisfies PushChannel, u)
    return
  }
  unsupportedQueue.splice(0, unsupportedQueue.length, u)
}

/** One URL from the OS (second instance, `open-url`, or the cold-start arguments). */
async function handleUrl(raw: string, source: string): Promise<void> {
  if (rawGuard.check(raw)) {
    log('info', 'deeplink:duplicate-url', { source })
    return
  }
  const result = parseDeepLink(raw, deepLinkScheme(), app.isPackaged)
  if (!result) return
  if (!result.ok) {
    log('warn', 'deeplink:unsupported', { reason: result.reason, source })
    showMainWindow()
    pushUnsupported({ url: raw.slice(0, 500), reason: result.reason })
    return
  }
  let event = result.event
  if (event.type === 'new-note' && result.eventId && bound) {
    // `event` is accepted only when it names a local calendar event.
    const found = await bound.ctx.calendar.getEvent(result.eventId).catch((err: unknown) => {
      log('warn', 'deeplink:event-lookup-failed', { err })
      return null
    })
    if (!found) {
      const reason = 'calendar event not found'
      log('warn', 'deeplink:unsupported', { reason, source })
      pushUnsupported({ url: raw.slice(0, 500), reason })
      return
    }
    event = { type: 'new-note', data: { ...event.data, event: found } }
  }
  deliverEvent(event, source)
}

// ---------- launch arguments and tasks ----------

function taskFrom(argv: readonly string[]): AppTask | null {
  for (const a of argv) {
    if (!a.startsWith(APP_TASK_ARG_PREFIX)) continue
    const task = a.slice(APP_TASK_ARG_PREFIX.length)
    if ((APP_TASKS as readonly string[]).includes(task)) return task as AppTask
    log('warn', 'lifecycle:unknown-task', { task: task.slice(0, 40) })
  }
  return null
}

function runTask(task: AppTask, source: string): void {
  logAction('lifecycle:task', { task, source })
  switch (task) {
    case 'settings':
      openSettingsSection('preferences', `task:${source}`)
      return
    case 'restart':
      restartApp(`task:${source}`)
      return
    case 'quit':
      void softQuit(`task:${source}`)
      return
    case 'quit-completely':
      void quitCompletely(`task:${source}`)
      return
    case 'background':
      // index.ts kept the first instance's window closed; a second
      // instance with it (the MCP shim starting Notula again) changes nothing.
      return
  }
}

function onLaunchArgs(argv: string[], source: 'first-instance' | 'second-instance'): void {
  const task = taskFrom(argv)
  if (source === 'first-instance') {
    // A cold start runs its task or link once the app is up.
    if (task === 'quit') {
      setStartupWindowPlan({ visible: false, focused: false })
      if (isMac) app.dock?.hide()
      logAction('lifecycle:task', { task, source })
    } else if (task === 'background') {
      // Tray only, no window (index.ts step 7) and no Dock icon until a window opens.
      if (isMac) app.dock?.hide()
      logAction('lifecycle:task', { task, source })
    } else if (task) {
      setImmediate(() => runTask(task, source))
    } else {
      const url = findSchemeUrl(argv, deepLinkScheme())
      if (url) void handleUrl(url, 'cold-start')
    }
    return
  }
  // A second instance (Windows jump list or link): tasks return early.
  if (task) {
    runTask(task, source)
    return
  }
  const url = findSchemeUrl(argv, deepLinkScheme())
  showMainWindow()
  if (url) void handleUrl(url, 'second-instance')
}

// ---------- OS integration ----------

function registerProtocol(): void {
  const scheme = deepLinkScheme()
  try {
    let ok: boolean
    if (app.isPackaged) {
      ok = app.setAsDefaultProtocolClient(scheme)
    } else {
      // A dev launcher (`electron .`) passes the app path so the OS relaunches the right entry.
      const entry = process.argv[1]
      ok = entry ? app.setAsDefaultProtocolClient(scheme, process.execPath, [resolve(entry)]) : false
    }
    log('info', 'deeplink:registered', { scheme, ok })
  } catch (err) {
    log('error', 'deeplink:register-failed', { scheme, err })
  }
}

/** The Windows jump list's four tasks, each launching the app with a task argument. */
function registerJumpList(): void {
  if (!isWindows) return
  const prefix = app.isPackaged ? '' : `"${app.getAppPath()}" `
  const task = (id: AppTask, title: string, description: string, icon: string): Task => ({
    program: process.execPath,
    arguments: `${prefix}${APP_TASK_ARG_PREFIX}${id}`,
    iconPath: resourcePath(icon),
    iconIndex: 0,
    title,
    description
  })
  try {
    const ok = app.setUserTasks([
      task('settings', 'Settings', 'Open Notula settings', 'task-settings.ico'),
      task('restart', 'Restart', 'Restart Notula', 'task-restart.ico'),
      task('quit', 'Quit', 'Quit Notula', 'task-quit.ico'),
      task('quit-completely', 'Quit Completely', 'Quit Notula without confirmation', 'task-quit-completely.ico')
    ])
    log('info', 'lifecycle:jump-list', { ok })
  } catch (err) {
    log('error', 'lifecycle:jump-list-failed', { err })
  }
}

/** The macOS dock menu. */
function registerDockMenu(): void {
  if (!isMac || !app.dock) return
  app.dock.setMenu(
    Menu.buildFromTemplate([
      { label: 'New Note', click: () => requestNewNote('dock_menu', { autoTranscribe: true }) },
      { label: 'Open Notula', click: () => showMainWindow() },
      { label: 'Settings', click: () => openSettingsSection('preferences', 'dock') },
      { type: 'separator' },
      { label: 'Check for updates…', click: () => checkForUpdatesNow('dock') },
      { label: 'Restart Notula', click: () => restartApp('dock') },
      { label: 'Quit Notula Completely', click: () => void quitCompletely('dock') }
    ])
  )
}

/** True when `bounds` still overlaps a display's work area (the restore keeps the window reachable). */
function fitsADisplay(bounds: Rectangle): boolean {
  return screen.getAllDisplays().some(({ workArea: a }) => {
    const w = Math.min(bounds.x + bounds.width, a.x + a.width) - Math.max(bounds.x, a.x)
    const h = Math.min(bounds.y + bounds.height, a.y + a.height) - Math.max(bounds.y, a.y)
    return w >= 100 && h >= 50
  })
}

/**
 * Applies the startup plan to a freshly created main window. Until its first paint,
 * `show` and `focus` are held, so index.ts's `showMain()` and the window's own
 * `ready-to-show` cannot show it; then the plan decides.
 */
function applyStartupPlan(win: BrowserWindow, plan: StartupWindowPlan): void {
  if (plan.bounds && fitsADisplay(plan.bounds)) win.setBounds(plan.bounds)
  const held = win as unknown as { show: () => void; focus: () => void }
  held.show = () => undefined
  held.focus = () => undefined
  let done = false
  const release = (): void => {
    if (done || win.isDestroyed()) return
    done = true
    Reflect.deleteProperty(win, 'show')
    Reflect.deleteProperty(win, 'focus')
    if (!plan.visible) {
      if (isMac) app.dock?.hide()
    } else if (plan.focused) {
      win.show()
    } else {
      win.showInactive()
    }
    log('info', 'lifecycle:startup-plan', { visible: plan.visible, focused: plan.focused, bounds: !!plan.bounds })
  }
  // `ready-to-show` listeners run in order: the window's own `show` first (held), then this.
  win.once('ready-to-show', () => setImmediate(release))
  setTimeout(release, FIRST_PAINT_WAIT_MS)
}

// ---------- registration ----------

export function registerLifecycle(ctx: MainContext, windows: Windows): LifecycleHooks {
  bound = { ctx, windows }

  // ---- UiStateApi ----
  let reportedViewing: string | null = null
  let lastViewing: string | null = null
  let lastInteractionAt = 0
  let onboardingReported: boolean | null = null
  let onboardingDerived = true

  const mainVisible = (): boolean => {
    const win = windows.main()
    return !!win && win.isVisible() && !win.isMinimized()
  }

  const ui: UiStateApi = {
    viewingNoteId: () => (mainVisible() ? reportedViewing : null),
    inOnboarding: () => onboardingReported ?? onboardingDerived,
    mainWindowFocused: () => {
      const win = windows.main()
      return !!win && win.isFocused() && !win.isMinimized()
    },
    lastInteractionAt: () => lastInteractionAt
  }

  const emitViewing = (): void => {
    const next = ui.viewingNoteId()
    if (next === lastViewing) return
    lastViewing = next
    ctx.bus.emit('ui:viewing-note', { noteId: next })
  }

  // Until the renderer's guard reports, derive it from the stored steps.
  void (async () => {
    try {
      const done = (await ctx.settings.get('onboarding.aiProvidersDoneAt')) !== null
      const rec = await ctx.settings.get('permissions.record')
      const permissionsDone = !isMac || (rec.microphone === 'granted' && rec.systemAudio === 'granted')
      onboardingDerived = !(done && permissionsDone)
    } catch (err) {
      log('warn', 'lifecycle:onboarding-derive-failed', { err })
    }
  })()
  ctx.bus.on('ui:onboarding', ({ inOnboarding }) => {
    onboardingReported = inOnboarding
  })

  ipcMain.on('app:viewing-note' satisfies SendChannel, (e, p: unknown) => {
    if (windows.kindOf(e.sender) !== 'main') return
    const noteId = (p as { noteId?: unknown } | null)?.noteId
    if (noteId !== null && (typeof noteId !== 'string' || noteId.length === 0 || noteId.length > 200)) {
      log('warn', 'lifecycle:viewing-note-invalid')
      return
    }
    reportedViewing = noteId
    emitViewing()
  })

  ipcMain.on('app:user-interacted' satisfies SendChannel, (e) => {
    if (windows.kindOf(e.sender) === 'main') lastInteractionAt = Date.now()
  })

  ipcMain.handle('app:relaunch' satisfies InvokeChannel, (): InvokeRes<'app:relaunch'> => {
    restartApp('renderer')
  })

  ipcMain.handle('deeplink:get-pending' satisfies InvokeChannel, (e): InvokeRes<'deeplink:get-pending'> => {
    if (windows.kindOf(e.sender) !== 'main') return null
    const event = pending
    pending = null
    if (event) eventGuard.record(eventKey(event))
    rendererReady = true
    // The listener is up: run what waited for it after this reply.
    setImmediate(() => {
      if (!e.sender.isDestroyed()) flushReady(e.sender)
    })
    return event
  })

  // ---- quitting for real ----
  app.on('before-quit', () => {
    quitState.forReal = true
  })

  // ---- the main window ----
  const adopt = (win: BrowserWindow): void => {
    const plan = startupPlan
    startupPlan = null
    if (plan) applyStartupPlan(win, plan)

    win.on('close', (e) => {
      if (allowMainWindowClose()) return
      e.preventDefault()
      void hideMainWindow('close-button', { hideDock: false })
    })
    win.on('show', () => {
      emitViewing()
      if (isMac) void app.dock?.show()
    })
    win.on('hide', emitViewing)
    win.on('minimize', emitViewing)
    win.on('restore', emitViewing)
    win.on('closed', () => {
      rendererReady = false
      emitViewing()
    })
    // Windows session end: logged, and the teardown starts.
    win.on('session-end', () => {
      log('info', 'lifecycle:session-end')
      quitState.forReal = true
      app.quit()
    })
    win.webContents.on('did-navigate', () => {
      rendererReady = false
    })
    win.webContents.on('render-process-gone', () => {
      rendererReady = false
    })
  }
  // `browser-window-created` fires inside the constructor, before the windows module
  // records its main window, so the check waits a tick.
  app.on('browser-window-created', (_e, win) =>
    setImmediate(() => {
      if (!win.isDestroyed() && windows.kindOf(win.webContents) === 'main') adopt(win)
    })
  )
  const existing = windows.main()
  if (existing) adopt(existing)

  // macOS: the dock icon shows a hidden window again.
  app.on('activate', () => {
    if (windows.main()) showMainWindow()
  })

  // System shutdown runs the same teardown.
  if (!isWindows) {
    // Electron passes an event whose preventDefault delays the shutdown until we quit.
    powerMonitor.on('shutdown', (e?: { preventDefault?: () => void }) => {
      log('info', 'lifecycle:system-shutdown')
      e?.preventDefault?.()
      quitState.forReal = true
      app.quit()
    })
  }

  registerProtocol()
  registerJumpList()
  registerDockMenu()

  return {
    ui,
    onLaunchArgs,
    onOpenUrl: (url) => void handleUrl(url, 'open-url')
  }
}
