// SPDX-License-Identifier: Apache-2.0
// Screen guide: an overlay that shows how to grant a system permission, and the helper that finds Settings.

import { spawn, type ChildProcess } from 'node:child_process'
import { app, ipcMain, nativeImage, screen, shell, systemPreferences, type BrowserWindow, type Rectangle } from 'electron'
import type { InvokeChannel, InvokeRes, PushChannel, SendChannel, SendPayload } from '@shared/ipc'
import type { Rect } from '@shared/types/common'
import { SCREEN_GUIDE, type ScreenGuideLayout } from '@shared/types/snapshots'
import type { MainContext } from '../context'
import { log } from '../log'
import { setScreenGuideOpener } from './guide'

interface Watch {
  active: boolean
  hasModal: boolean
  frame: Rect | null
  modal: Rect | null
}

const GAP = 20
const INSIDE = 8
const TOP = 70
const MARGIN = 12
const WATCHER_LIFETIME_MS = SCREEN_GUIDE.pollMaxMs + 60_000

/** JXA: the System Settings main window, frontmost state and a sheet-like second window. */
function watcherScript(lifetimeMs: number): string {
  return `
ObjC.import('Foundation'); ObjC.import('AppKit'); ObjC.import('CoreGraphics');
var out = $.NSFileHandle.fileHandleWithStandardOutput;
function emit(s) { out.writeData($(s + '\\n').dataUsingEncoding($.NSUTF8StringEncoding)); }
function overlaps(a, b) { return a.X < b.X + b.Width && b.X < a.X + a.Width && a.Y < b.Y + b.Height && b.Y < a.Y + a.Height; }
var last = ''; var end = Date.now() + ${Math.round(lifetimeMs)};
while (Date.now() < end) {
  var apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier('com.apple.systempreferences');
  var pid = apps.count > 0 ? apps.objectAtIndex(0).processIdentifier : 0;
  var front = $.NSWorkspace.sharedWorkspace.frontmostApplication;
  var frontPid = front ? front.processIdentifier : -1;
  var list = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, 0))) || [];
  var main = null, modal = null;
  for (var i = 0; i < list.length; i++) {
    var w = list[i];
    if (!pid || w.kCGWindowOwnerPID !== pid || w.kCGWindowLayer !== 0 || !w.kCGWindowBounds) continue;
    var b = w.kCGWindowBounds;
    if (b.Width < 200 || b.Height < 120) continue;
    if (!main) main = b; else if (!modal && overlaps(main, b)) modal = b;
  }
  var rec = JSON.stringify({ type: 'window-frame', pid: pid, active: pid !== 0 && pid === frontPid, hasModal: !!modal,
    frame: main ? { x: main.X, y: main.Y, width: main.Width, height: main.Height } : null,
    modal: modal ? { x: modal.X, y: modal.Y, width: modal.Width, height: modal.Height } : null });
  if (rec !== last) { emit(rec); last = rec; }
  delay(${SCREEN_GUIDE.watcherMs / 1000});
}
`
}

function appIdentity(): { name: string; bundle: string | null } {
  // The bundle is the executable path up to `/Contents/`; in development, Electron's bundle.
  const i = process.execPath.indexOf('.app/Contents/')
  if (i < 0) return { name: 'Notula', bundle: null }
  const bundle = process.execPath.slice(0, i + 4)
  return { name: app.isPackaged ? (bundle.split('/').pop() ?? 'Notula.app').replace(/\.app$/, '') : 'Notula', bundle }
}

export function registerScreenGuide(ctx: MainContext): void {
  /** macOS only; on Windows every channel answers and nothing opens. */
  const mac = process.platform === 'darwin'

  let panel: BrowserWindow | null = null
  let spot: BrowserWindow | null = null
  let ready = new Set<number>()
  let watcher: ChildProcess | null = null
  let watch: Watch | null = null
  let watcherFailed = false
  let phase: ScreenGuideLayout['phase'] = 'permission'
  let poll: ReturnType<typeof setInterval> | null = null
  let restartTimer: ReturnType<typeof setTimeout> | null = null
  let sheetSeen = false
  let dragging = false
  let notifyId: number | null = null

  const alive = (w: BrowserWindow | null): w is BrowserWindow => w !== null && !w.isDestroyed()
  const granted = (): boolean => {
    try {
      return systemPreferences.getMediaAccessStatus('screen') === 'granted'
    } catch {
      return false
    }
  }

  function hideWin(w: BrowserWindow | null): void {
    if (!alive(w)) return
    w.setOpacity(0)
    w.setIgnoreMouseEvents(true)
  }

  function close(why: string): void {
    if (!alive(panel) && !alive(spot) && !watcher) return
    log('info', 'screen-guide:closed', { why })
    if (poll) clearInterval(poll)
    poll = null
    if (restartTimer) clearTimeout(restartTimer)
    restartTimer = null
    if (watcher && watcher.exitCode === null) watcher.kill()
    watcher = null
    if (notifyId !== null) systemPreferences.unsubscribeWorkspaceNotification(notifyId)
    notifyId = null
    for (const w of [panel, spot]) if (alive(w)) w.destroy()
    panel = null
    spot = null
    ready = new Set()
    watch = null
    const main = ctx.windows.main()
    for (const wc of ctx.windows.targets()) wc.send('screen-guide:closed' satisfies PushChannel)
    if (main && !main.isDestroyed()) {
      // Nothing else: the caller re-checks its own permission state.
    }
  }

  /** The panel's place on the display containing System Settings. */
  function layout(): ScreenGuideLayout {
    const frame = watch?.frame ?? null
    const display = frame ? screen.getDisplayMatching(frame) : screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    const wa = display.workArea
    const rel = (r: Rectangle): Rect => ({ x: r.x - display.bounds.x, y: r.y - display.bounds.y, width: r.width, height: r.height })
    const { width, height } = SCREEN_GUIDE.panel
    if (!frame) {
      // Fallback: top right of the work area, 12 px margins.
      const p = { x: wa.x + wa.width - width - MARGIN, y: wa.y + MARGIN, width, height }
      return { phase, settings: null, panel: rel(p), direction: 'inside', restartSheet: null }
    }
    let x: number
    let w: number = width
    let direction: ScreenGuideLayout['direction']
    if (frame.x + frame.width + GAP + width <= wa.x + wa.width) {
      x = frame.x + frame.width + GAP
      direction = 'left'
    } else if (frame.x - GAP - width >= wa.x) {
      x = frame.x - GAP - width
      direction = 'right'
    } else {
      w = Math.min(SCREEN_GUIDE.sidebarMax, width)
      x = frame.x + INSIDE
      direction = 'inside'
    }
    const y = Math.max(wa.y + MARGIN, Math.min(frame.y + TOP, wa.y + wa.height - height - MARGIN))
    return {
      phase,
      settings: rel(frame),
      panel: rel({ x, y, width: w, height }),
      direction,
      restartSheet: phase === 'restart' && watch?.modal ? rel(watch.modal) : null
    }
  }

  function apply(): void {
    if (!alive(panel) || !alive(spot)) return
    const l = layout()
    const frame = watch?.frame ?? null
    const display = frame ? screen.getDisplayMatching(frame) : screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    panel.setBounds({ x: l.panel.x + display.bounds.x, y: l.panel.y + display.bounds.y, width: l.panel.width, height: l.panel.height })
    spot.setBounds(display.bounds)
    for (const w of [panel, spot]) w.webContents.send('screen-guide:layout' satisfies PushChannel, l)
    const bothReady = ready.has(panel.webContents.id) && ready.has(spot.webContents.id)
    const active = watcherFailed ? true : !!watch?.active
    const showPanel = bothReady && active && phase !== 'restart' && (phase === 'dragging' || !watch?.hasModal)
    const showSpot = bothReady && active && !watcherFailed && (phase !== 'restart' || !!watch?.hasModal)
    if (showPanel) {
      panel.setOpacity(1)
      panel.setIgnoreMouseEvents(false)
      if (!panel.isVisible()) panel.showInactive()
    } else hideWin(panel)
    if (showSpot) {
      spot.setOpacity(1)
      if (!spot.isVisible()) spot.showInactive()
    } else hideWin(spot)
    spot.setIgnoreMouseEvents(true)
  }

  function onRecord(line: string): void {
    let r: { type?: unknown; active?: unknown; hasModal?: unknown; frame?: Rect | null; modal?: Rect | null }
    try {
      r = JSON.parse(line) as typeof r
    } catch {
      return
    }
    if (r.type !== 'window-frame') {
      close('watcher-record')
      return
    }
    watch = { active: r.active === true, hasModal: r.hasModal === true, frame: r.frame ?? null, modal: r.modal ?? null }
    if (phase === 'restart') {
      if (watch.hasModal) sheetSeen = true
      else if (sheetSeen && watch.active) {
        close('restart-sheet-dismissed')
        return
      }
    }
    apply()
  }

  function startWatcher(): void {
    watcherFailed = false
    try {
      const child = spawn('/usr/bin/osascript', ['-l', 'JavaScript', '-e', watcherScript(WATCHER_LIFETIME_MS)], { stdio: ['ignore', 'pipe', 'ignore'] })
      watcher = child
      let buf = ''
      child.stdout?.setEncoding('utf8')
      child.stdout?.on('data', (d: string) => {
        buf += d
        let i = buf.indexOf('\n')
        while (i >= 0) {
          const line = buf.slice(0, i).trim()
          buf = buf.slice(i + 1)
          if (line) onRecord(line)
          i = buf.indexOf('\n')
        }
      })
      const failed = (why: string): void => {
        if (watcher !== child) return
        watcher = null
        if (!watch) {
          // Never reported: the fixed placement.
          watcherFailed = true
          log('warn', 'screen-guide:watcher-unavailable', { why })
          apply()
        } else {
          close(`watcher-${why}`)
        }
      }
      child.on('error', () => failed('error'))
      child.on('exit', () => failed('exit'))
    } catch (err) {
      watcherFailed = true
      log('warn', 'screen-guide:watcher-start-failed', { err })
    }
  }

  function enterRestart(): void {
    if (poll) clearInterval(poll)
    poll = null
    // Without a watcher the restart phase is skipped.
    if (watcherFailed || !watch?.active) {
      close('granted')
      return
    }
    phase = 'restart'
    sheetSeen = !!watch.hasModal
    apply()
    restartTimer = setTimeout(() => {
      if (!sheetSeen) close('no-restart-sheet')
    }, SCREEN_GUIDE.restartSheetWaitMs)
  }

  function open(): void {
    if (!mac) return
    close('reopened')
    phase = 'permission'
    sheetSeen = false
    dragging = false
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    const common = {
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      focusable: false,
      movable: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      type: 'panel'
    } as const
    const p = ctx.windows.createSecondary({
      kind: 'screen-guide',
      route: '/screen-guide',
      title: 'Notula Screen Recording',
      width: SCREEN_GUIDE.panel.width,
      height: SCREEN_GUIDE.panel.height,
      ...common
    })
    const s = ctx.windows.createSecondary({
      kind: 'screen-guide-spotlight',
      route: '/screen-guide-spotlight',
      title: 'Notula Screen Recording Spotlight',
      ...display.bounds,
      enableLargerThanScreen: true,
      ...common
    })
    for (const [w, level] of [
      [p, 'pop-up-menu'],
      [s, 'floating']
    ] as const) {
      w.on('page-title-updated', (e) => e.preventDefault())
      w.setAlwaysOnTop(true, level)
      w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
      w.setHiddenInMissionControl(true)
      hideWin(w)
      w.on('closed', () => {
        if (panel === w || spot === w) close('window-closed')
      })
    }
    panel = p
    spot = s
    log('info', 'screen-guide:opened')
    void shell.openExternal(SCREEN_GUIDE.settingsUrl).catch((err: unknown) => {
      log('warn', 'screen-guide:settings-open-failed', { err })
      close('settings-failed')
    })
    startWatcher()
    try {
      notifyId = systemPreferences.subscribeWorkspaceNotification('NSWorkspaceDidActivateApplicationNotification', () => {
        // Another app coming forward hides the guide until the watcher sees Settings again.
        if (watch) watch.active = false
        apply()
      })
    } catch (err) {
      log('debug', 'screen-guide:notification-failed', { err })
    }
    const began = Date.now()
    poll = setInterval(() => {
      if (granted()) enterRestart()
      else if (Date.now() - began > SCREEN_GUIDE.pollMaxMs) close('poll-timeout')
    }, SCREEN_GUIDE.pollMs)
  }

  if (mac) setScreenGuideOpener(open)
  app.on('will-quit', () => close('quit'))

  // ---------- IPC ----------

  ipcMain.on('screen-guide:open' satisfies SendChannel, () => open())

  ipcMain.on('screen-guide:dismiss' satisfies SendChannel, (e) => {
    // Only the panel itself may close the guide.
    if (alive(panel) && e.sender.id === panel.webContents.id) close('dismissed')
  })

  ipcMain.handle('screen-guide:get-config' satisfies InvokeChannel, (e): InvokeRes<'screen-guide:get-config'> => {
    const kind = ctx.windows.kindOf(e.sender)
    if (kind !== 'screen-guide' && kind !== 'screen-guide-spotlight') throw new Error('invalid-input: not a guide window')
    return { appName: mac ? appIdentity().name : 'Notula' }
  })

  ipcMain.on('screen-guide:ready' satisfies SendChannel, (e) => {
    const kind = ctx.windows.kindOf(e.sender)
    if (kind !== 'screen-guide' && kind !== 'screen-guide-spotlight') return
    ready.add(e.sender.id)
    apply()
  })

  ipcMain.on('screen-guide:start-drag' satisfies SendChannel, (e, raw: SendPayload<'screen-guide:start-drag'>) => {
    if (!alive(panel) || e.sender.id !== panel.webContents.id || phase === 'restart' || dragging) return
    const { bundle } = appIdentity()
    if (!bundle) {
      log('warn', 'screen-guide:no-bundle')
      return
    }
    try {
      const url = typeof raw?.iconDataUrl === 'string' && raw.iconDataUrl.length < 1_000_000 ? raw.iconDataUrl : null
      const icon = url ? nativeImage.createFromDataURL(url) : app.isPackaged ? nativeImage.createFromPath(process.execPath) : nativeImage.createEmpty()
      dragging = true
      phase = 'dragging'
      apply()
      e.sender.startDrag({ file: bundle, icon: icon.isEmpty() ? nativeImage.createEmpty() : icon.resize({ width: 48, height: 48 }) })
    } catch (err) {
      log('warn', 'screen-guide:drag-failed', { err })
    } finally {
      dragging = false
      if (phase === 'dragging') {
        phase = 'permission'
        apply()
      }
    }
  })
}
