// SPDX-License-Identifier: Apache-2.0
// registerPreferences(): the main-side preference effects and their IPC.
//
// - `settings:open` (send) opens that Settings section in the main window through the
//   lifecycle, which shows and focuses it, or opens it first.
// - Theme: the renderer sends `app:set-theme` at startup and on every
//   change; main sets `nativeTheme.themeSource` and the main window's background. Main
//   also reads `ui.theme` once at startup so the first window opens with the right
//   background instead of flashing the other one. Only the main window is painted: the
//   bubble and notification windows are transparent.
// - Open at login: the OS login item is the source of truth. The
//   first packaged launch turns it on once and records `app.openAtLoginInitialized`,
//   so turning it off sticks.
//
// Handlers and pushes write their channel literal.

import { app, ipcMain, nativeTheme } from 'electron'
import type { InvokeChannel, InvokeRes, SendChannel } from '@shared/ipc'
import type { SettingsSection, ThemeSetting } from '@shared/types/settings'
import type { MainContext } from '../context'
import { openSettingsSection } from '../lifecycle'
import { log } from '../log'

/** The `--bg` token of each theme in the renderer's styles.css. */
const WINDOW_BACKGROUND = { light: '#fafaf9', dark: '#161615' } as const

const THEMES: readonly ThemeSetting[] = ['system', 'light', 'dark']
const SECTIONS: readonly SettingsSection[] = [
  'preferences',
  'ai',
  'profile',
  'calendar',
  'notifications',
  'dev',
  'keyboard-shortcuts',
  'speaker-tags',
  'voice-typing',
  'integrations',
  'connectors',
  'labs',
  'troubleshooting',
  'about',
  'feedback',
  'automations',
  'meeting-notice',
  'transcription-rules'
]

type Resolved = keyof typeof WINDOW_BACKGROUND

function isTheme(v: unknown): v is ThemeSetting {
  return typeof v === 'string' && (THEMES as readonly string[]).includes(v)
}

function resolvedFromNative(): Resolved {
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
}

/** Paints the main window only; secondary windows keep their transparent background. */
function paintMainWindow(ctx: MainContext, resolved: Resolved): void {
  const win = ctx.windows.main()
  if (win && !win.isDestroyed()) win.setBackgroundColor(WINDOW_BACKGROUND[resolved])
}

function applyTheme(ctx: MainContext, theme: ThemeSetting, resolved?: Resolved): void {
  nativeTheme.themeSource = theme
  paintMainWindow(ctx, resolved ?? resolvedFromNative())
}

// ---------- open at login ----------

const loginItemsSupported = process.platform === 'win32' || process.platform === 'darwin'

/**
 * In a dev build on Windows the login item must launch `electron.exe <app path>`,
 * not bare Electron; reading uses the same path and args so the state matches.
 */
function loginItemTarget(): { path?: string; args?: string[] } {
  if (process.platform !== 'win32' || app.isPackaged) return {}
  return { path: process.execPath, args: [app.getAppPath()] }
}

function readOpenAtLogin(): boolean {
  if (!loginItemsSupported) return false
  const s = app.getLoginItemSettings(loginItemTarget())
  // Windows: an entry the user disabled in Task Manager doesn't launch, so it reads off.
  if (process.platform === 'win32') return s.openAtLogin && s.executableWillLaunchAtLogin
  return s.openAtLogin
}

function writeOpenAtLogin(enabled: boolean): void {
  if (!loginItemsSupported) {
    log('info', 'prefs:open-at-login-unsupported', { platform: process.platform })
    return
  }
  app.setLoginItemSettings({ openAtLogin: enabled, enabled, ...loginItemTarget() })
  log('info', 'prefs:open-at-login-set', { enabled })
}

/**
 * The first packaged launch turns launch at login on once, unless it
 * is already on. The flag is written either way, and only once storage can keep it:
 * otherwise every launch would turn it back on. `NOTULA_DEV_FIRST_LAUNCH=1` runs the
 * rule in a dev build, to check it by hand.
 */
async function initOpenAtLogin(ctx: MainContext): Promise<void> {
  const firstLaunchRule = app.isPackaged || (ctx.isDev && process.env['NOTULA_DEV_FIRST_LAUNCH'] === '1')
  if (!firstLaunchRule || !loginItemsSupported) return
  if ((await ctx.storage.status()).state !== 'ready') return
  if (await ctx.settings.get('app.openAtLoginInitialized')) return
  const already = readOpenAtLogin()
  if (!already) writeOpenAtLogin(true)
  await ctx.settings.set('app.openAtLoginInitialized', true)
  log('info', 'prefs:open-at-login-initialized', { alreadyOn: already })
}

// ---------- registration ----------

export function registerPreferences(ctx: MainContext): void {
  // Theme at startup: the stored choice, before the first window is shown.
  let startupTheme: ThemeSetting | null = null
  // `browser-window-created` fires inside the constructor, before the windows module
  // records its main window, so the check waits a tick.
  app.on('browser-window-created', (_e, win) =>
    setImmediate(() => {
      if (!startupTheme || win.isDestroyed() || ctx.windows.kindOf(win.webContents) !== 'main') return
      win.setBackgroundColor(WINDOW_BACKGROUND[resolvedFromNative()])
    })
  )
  void ctx.settings
    .get('ui.theme')
    .then((theme) => {
      startupTheme = isTheme(theme) ? theme : 'system'
      applyTheme(ctx, startupTheme)
    })
    .catch((err: unknown) => log('warn', 'prefs:startup-theme-failed', { err }))

  // With `system`, follow the OS while the renderer catches up.
  nativeTheme.on('updated', () => {
    if (nativeTheme.themeSource === 'system') paintMainWindow(ctx, resolvedFromNative())
  })

  ipcMain.on('app:set-theme' satisfies SendChannel, (_e, p: unknown) => {
    const theme = (p as { theme?: unknown } | null)?.theme
    const resolved = (p as { resolved?: unknown } | null)?.resolved
    if (!isTheme(theme) || (resolved !== 'light' && resolved !== 'dark')) {
      log('warn', 'prefs:set-theme-invalid')
      return
    }
    startupTheme = theme
    applyTheme(ctx, theme, resolved)
  })

  ipcMain.handle('app:get-open-at-login' satisfies InvokeChannel, (): InvokeRes<'app:get-open-at-login'> => {
    try {
      return readOpenAtLogin()
    } catch (err) {
      log('error', 'prefs:open-at-login-read-failed', { err })
      return false
    }
  })

  ipcMain.on('app:set-open-at-login' satisfies SendChannel, (_e, p: unknown) => {
    const enabled = (p as { enabled?: unknown } | null)?.enabled
    if (typeof enabled !== 'boolean') {
      log('warn', 'prefs:set-open-at-login-invalid')
      return
    }
    const apply = (): void => {
      try {
        writeOpenAtLogin(enabled)
      } catch (err) {
        log('error', 'prefs:open-at-login-write-failed', { err })
      }
    }
    if (enabled) {
      apply()
      return
    }
    // Turning open at login off is a protected change; a denial leaves it on.
    void ctx.deviceLock
      .confirmProtectedChange('openAtLogin')
      .then((ok) => {
        if (ok) apply()
        else log('info', 'prefs:open-at-login-off-denied')
      })
      .catch((err: unknown) => log('warn', 'prefs:open-at-login-confirm-failed', { err }))
  })

  // settings:open (send) → that section in the main window (the lifecycle shows
  // and focuses it, or opens it first). A section-less request keeps an open Settings page.
  ipcMain.on('settings:open' satisfies SendChannel, (_e, p: unknown) => {
    const section = (p as { section?: unknown } | null)?.section
    if (section !== undefined && !(SECTIONS as readonly unknown[]).includes(section)) {
      log('warn', 'prefs:settings-open-invalid')
      return
    }
    openSettingsSection(section as SettingsSection | undefined, 'renderer')
  })

  void initOpenAtLogin(ctx).catch((err: unknown) => log('error', 'prefs:open-at-login-init-failed', { err }))
}
