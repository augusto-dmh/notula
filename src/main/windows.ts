// SPDX-License-Identifier: Apache-2.0
// The main window, the secondary-window factory and the WindowsApi
// push targets. These are the only two `new BrowserWindow` sites in Notula, and both
// keep literal `contextIsolation: true, sandbox: true, nodeIntegration: false`.
//
// The factory serves every secondary kind the same way, with `devTools: !app.isPackaged`.
// The main window's minimum size is 500 × 400; its frame stays native.
//
// `setContentLocked` hides the content windows while Notula is locked, and `setAppIcon`
// applies the tinted app icon to every window.

import { join } from 'node:path'
import { app, BrowserWindow, nativeImage, shell, type NativeImage, type WebContents } from 'electron'
import type { SecondaryKind, SecondaryWindowOptions, WindowsApi } from './context'
import { resourcePath } from './lifecycle/resources'

export type { SecondaryKind, SecondaryWindowOptions } from './context'

/** The secondary kinds that show note content and hide while Notula is locked. */
export const CONTENT_SECONDARY_KINDS: readonly SecondaryKind[] = [
  'bubble-transcript',
  'quick-ask',
  'captions',
  'demo',
  'snapshot-picker',
  'meeting-dock',
  'live-context',
  'reminder-cards'
]

export interface Windows extends WindowsApi {
  /** Creates the main window, or shows and focuses the existing one. */
  showMain(): BrowserWindow
}

function isHttpUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

export function createWindows(): Windows {
  let mainWindow: BrowserWindow | null = null
  /** `webContents.id` → kind, for every live secondary window. */
  const secondaryKinds = new Map<number, SecondaryKind>()
  /** While locked, the content windows hidden by the lock (or asked to show), re-shown on unlock. */
  let contentLocked = false
  const hiddenByLock = new Map<BrowserWindow, 'show' | 'showInactive'>()
  /** The tinted app icon for every window; null = the default. */
  let appIcon: NativeImage | null = null

  // Packaged: the exe's own icon (resources/icon/icon.ico via electron-builder). Dev runs show the
  // same art from the resources folder instead of Electron's icon.
  let defaultImage: NativeImage | null = null
  const defaultIcon = (): NativeImage => {
    if (defaultImage) return defaultImage
    const own = app.isPackaged ? null : nativeImage.createFromPath(resourcePath('icon/icon.ico'))
    defaultImage = own && !own.isEmpty() ? own : nativeImage.createFromPath(process.execPath)
    return defaultImage
  }

  function createMainWindow(): BrowserWindow {
    const win = new BrowserWindow({
      width: 1200,
      height: 800,
      // WINDOW_GEOMETRY.minWidth / minHeight.
      minWidth: 500,
      minHeight: 400,
      show: false,
      title: 'Notula',
      backgroundColor: '#111111',
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        // The hidden main window still hosts the capture engine and computes the bubble
        // document, so its timers and IPC must not be throttled.
        backgroundThrottling: false
      }
    })

    win.once('ready-to-show', () => win.show())
    win.on('closed', () => {
      if (mainWindow === win) mainWindow = null
    })
    if (appIcon || !app.isPackaged) win.setIcon(appIcon ?? defaultIcon())

    // External links open in the default browser, never inside the app window.
    win.webContents.setWindowOpenHandler(({ url }) => {
      void shell.openExternal(url)
      return { action: 'deny' }
    })

    if (process.env['ELECTRON_RENDERER_URL']) {
      void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
    } else {
      void win.loadFile(join(__dirname, '../renderer/index.html'))
    }
    return win
  }

  /** A bubble, notification or any other secondary window at its hash route, hidden until shown. */
  function createSecondary(opts: SecondaryWindowOptions): BrowserWindow {
    const { kind, route, ...options } = opts
    const win = new BrowserWindow({
      ...options,
      show: false,
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        devTools: !app.isPackaged
      }
    })
    const id = win.webContents.id
    secondaryKinds.set(id, kind)
    win.on('closed', () => {
      secondaryKinds.delete(id)
      hiddenByLock.delete(win)
    })
    if (appIcon || !app.isPackaged) win.setIcon(appIcon ?? defaultIcon())

    // A content window never shows while Notula is locked; it shows on unlock instead.
    if (CONTENT_SECONDARY_KINDS.includes(kind)) {
      const show = win.show.bind(win)
      const showInactive = win.showInactive.bind(win)
      win.show = () => {
        if (contentLocked) hiddenByLock.set(win, 'show')
        else show()
      }
      win.showInactive = () => {
        if (contentLocked) hiddenByLock.set(win, 'showInactive')
        else showInactive()
      }
    }

    win.webContents.setWindowOpenHandler(({ url }) => {
      if (isHttpUrl(url)) void shell.openExternal(url)
      return { action: 'deny' }
    })
    // A secondary window never leaves its route.
    win.webContents.on('will-navigate', (e) => e.preventDefault())

    const hash = route.startsWith('/') ? route : `/${route}`
    const devUrl = process.env['ELECTRON_RENDERER_URL']
    if (devUrl) {
      void win.loadURL(`${devUrl}#${hash}`)
    } else {
      void win.loadFile(join(__dirname, '../renderer/index.html'), { hash })
    }
    return win
  }

  const main = (): BrowserWindow | null => (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null)

  return {
    main,
    targets: (): WebContents[] =>
      BrowserWindow.getAllWindows()
        .filter((w) => !w.isDestroyed() && !w.webContents.isDestroyed())
        .map((w) => w.webContents),
    createSecondary,
    kindOf: (wc) => {
      const m = main()
      if (m && !m.webContents.isDestroyed() && m.webContents.id === wc.id) return 'main'
      return secondaryKinds.get(wc.id) ?? null
    },
    setContentLocked: (locked) => {
      if (locked === contentLocked) return
      if (locked) {
        for (const win of BrowserWindow.getAllWindows()) {
          if (win.isDestroyed() || win.webContents.isDestroyed()) continue
          const kind = secondaryKinds.get(win.webContents.id)
          if (!kind || !CONTENT_SECONDARY_KINDS.includes(kind) || !win.isVisible()) continue
          hiddenByLock.set(win, win.isFocused() ? 'show' : 'showInactive')
          win.hide()
        }
        contentLocked = true
        return
      }
      contentLocked = false
      const toShow = [...hiddenByLock]
      hiddenByLock.clear()
      for (const [win, how] of toShow) {
        if (win.isDestroyed()) continue
        if (how === 'show') win.show()
        else win.showInactive()
      }
    },
    setAppIcon: (image) => {
      appIcon = image
      const icon = image ?? defaultIcon()
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.setIcon(icon)
      }
    },
    showMain: () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        if (mainWindow.isMinimized()) mainWindow.restore()
        // A window hidden by close-to-tray comes back too.
        if (!mainWindow.isVisible()) mainWindow.show()
        mainWindow.focus()
        return mainWindow
      }
      mainWindow = createMainWindow()
      return mainWindow
    }
  }
}
