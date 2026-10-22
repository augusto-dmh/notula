// SPDX-License-Identifier: Apache-2.0
// registerUpdater(): electron-updater with the build-time feed `__NOTULA_UPDATE_FEED_URL__`
// and the `update:*` IPC; consumes the bus `update:delay`.
//
// - Feed: `none` for an empty URL, a dev build, or macOS (builds are unsigned, so macOS
//   could never install). With `none` nothing is ever checked or downloaded and nothing
//   errors; the tray reads "Latest version".
// - Checks at startup and every 10 min until a download completes. Packaged builds
//   download on their own; never a downgrade, differential download off, and no auth
//   or device headers: electron-updater's per-install `x-user-staging-id`
//   (and its `.updaterId` file) is replaced by a fixed id that is never sent. Machine
//   policy `UpdatesDisabled` skips every check.
// - Installing on its own follows the install rules (without the virtual-webcam rule): a delay request (2 s window),
//   capturing, tray-only (yes), focused (no), viewing a meeting note (no), else yes.
//   Re-evaluated every 60 s after a download.
// - Install: the "updating" mark (close stops hiding), the flag file, a 1 s wait, then
//   quit into the installer. The next launch restores the window from the flag file.
//
// Handlers and pushes write their channel literal.

import { execFile } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, ipcMain, type Rectangle } from 'electron'
import { autoUpdater, type ProgressInfo, type UpdateInfo } from 'electron-updater'
import { notulaError } from '@shared/errors'
import type { InvokeChannel, InvokeRes, PushChannel, SendChannel } from '@shared/ipc'
import { APP_ID, type UpdateBlockReason, type UpdateDelayReason, type UpdateState, type UpdateChannel } from '@shared/types/app'
import type { MainContext } from '../context'
import { markInstallingUpdate, setStartupWindowPlan } from '../lifecycle'
import { log } from '../log'
import { egressBlocked, LOCAL_ONLY_REASON } from '../privacy'
import { bindUpdaterActions, getUpdateState, onUpdateState, setUpdateState } from './state'

const CHECK_INTERVAL_MS = 10 * 60_000
const FIRST_CHECK_DELAY_MS = 5_000
const INSTALL_RECHECK_MS = 60_000
const DELAY_WINDOW_MS = 2_000
const INSTALL_WAIT_MS = 1_000
const POLICY_READ_TIMEOUT_MS = 5_000
const FLAG_FILE = 'installing-update.json'
const DELAY_REASONS: readonly UpdateDelayReason[] = ['chatActive', 'dictationActive']
/** Stands in for electron-updater's staging id: one shared rollout bucket, never sent. */
const SHARED_STAGING_ID = '00000000-0000-4000-8000-000000000000'
const STAGING_HEADER = 'x-user-staging-id'

type InstallMode = 'manual' | 'instant' | 'background'

interface InstallFlag {
  mode: InstallMode
  wasVisible: boolean
  wasFocused: boolean
  bounds: Rectangle | null
  source: 'builtIn' | 'managed'
  /** The version being installed (for the log on the next launch). */
  version: string | null
}

// ---------- managed policy ----------

const WIN_POLICY_KEY = 'HKLM\\SOFTWARE\\Policies\\Notula'
/** macOS keeps machine-managed preferences per bundle id. */
const MAC_POLICY_FILE = `/Library/Managed Preferences/${APP_ID}.plist`
/** The policy's value name, the same in the registry key and in the managed preferences. */
const POLICY_VALUE = 'UpdatesDisabled'
const REG_VALUE = new RegExp(`${POLICY_VALUE}\\s+(REG_DWORD|REG_SZ)\\s+(\\S+)`, 'i')

function run(file: string, args: string[]): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: POLICY_READ_TIMEOUT_MS, windowsHide: true }, (err, stdout) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0
      resolve({ code, stdout: String(stdout) })
    })
  })
}

/** `1`/`true` disables, `0`/`false` enables; missing or invalid means enabled (invalid is logged). */
function policyValue(raw: unknown): boolean {
  if (raw === undefined || raw === null) return false
  if (raw === true || raw === 1 || raw === '1' || raw === 'true') return true
  if (raw === false || raw === 0 || raw === '0' || raw === 'false') return false
  log('warn', 'update:policy-invalid', { value: String(raw).slice(0, 40) })
  return false
}

async function readPolicyDisabled(): Promise<boolean> {
  try {
    if (process.platform === 'win32') {
      const r = await run('reg', ['query', WIN_POLICY_KEY, '/v', POLICY_VALUE])
      if (r.code !== 0) return false
      const m = REG_VALUE.exec(r.stdout)
      if (!m) return policyValue('unreadable')
      const value = m[1]!.toUpperCase() === 'REG_DWORD' ? Number.parseInt(m[2]!, 16) : m[2]!.toLowerCase()
      return policyValue(value)
    }
    if (process.platform === 'darwin' && existsSync(MAC_POLICY_FILE)) {
      const r = await run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', MAC_POLICY_FILE])
      if (r.code !== 0) return false
      return policyValue((JSON.parse(r.stdout) as Record<string, unknown>)[POLICY_VALUE])
    }
  } catch (err) {
    log('warn', 'update:policy-read-failed', { err })
  }
  return false
}

// ---------- the flag file ----------

function flagPath(ctx: MainContext): string {
  return join(ctx.userDataPath, FLAG_FILE)
}

/** First launch after an update: log it, delete the flag, and plan the window's restore. */
function restoreAfterUpdate(ctx: MainContext): void {
  const file = flagPath(ctx)
  if (!existsSync(file)) return
  let flag: Partial<InstallFlag> = {}
  try {
    const raw = readFileSync(file, 'utf8').trim()
    // Current JSON, or a plain mode string (the fallback write).
    flag = raw.startsWith('{') ? (JSON.parse(raw) as Partial<InstallFlag>) : { mode: raw as InstallMode }
  } catch (err) {
    log('warn', 'update:flag-unreadable', { err })
  }
  try {
    rmSync(file, { force: true })
  } catch (err) {
    log('error', 'update:flag-delete-failed', { err })
  }
  log('info', 'update:installed', { version: app.getVersion(), from: flag.version ?? null, mode: flag.mode ?? null })
  if (typeof flag.wasVisible !== 'boolean') return
  setStartupWindowPlan({
    ...(flag.bounds ? { bounds: flag.bounds } : {}),
    visible: flag.wasVisible,
    focused: flag.wasFocused === true
  })
}

// ---------- registration ----------

export function registerUpdater(ctx: MainContext): void {
  const feedUrl = __NOTULA_UPDATE_FEED_URL__
  // The beta channel's feed, when the build has one; otherwise beta uses the stable feed.
  const betaFeedUrl = __NOTULA_UPDATE_FEED_URL_BETA__
  const feedFor = (channel: UpdateChannel): string => (channel === 'beta' && betaFeedUrl !== '' ? betaFeedUrl : feedUrl)
  const feed: UpdateState['feed'] =
    feedUrl !== '' && app.isPackaged && process.platform !== 'darwin' ? 'configured' : 'none'
  setUpdateState({ feed, packaged: app.isPackaged, betaAvailable: betaFeedUrl !== '' })
  let channel: UpdateChannel = 'stable'
  /** The channel whose feed served the downloaded update; one from the other channel is ignored. */
  let downloadedFrom: UpdateChannel | null = null

  restoreAfterUpdate(ctx)

  // ---- pushes ----
  onUpdateState((s) => {
    const win = ctx.windows.main()
    if (win && !win.webContents.isDestroyed()) win.webContents.send('update:state' satisfies PushChannel, s)
  })

  // ---- delay requests: from the renderer and from main (chat, dictation) ----
  let delayUntil = 0
  let delayReason: UpdateDelayReason | null = null
  const delay = (reason: unknown): void => {
    if (!(DELAY_REASONS as readonly unknown[]).includes(reason)) {
      log('warn', 'update:delay-invalid')
      return
    }
    delayUntil = Date.now() + DELAY_WINDOW_MS
    delayReason = reason as UpdateDelayReason
  }
  ipcMain.on('update:delay' satisfies SendChannel, (_e, p: unknown) => delay((p as { reason?: unknown } | null)?.reason))
  ctx.bus.on('update:delay', ({ reason }) => delay(reason))

  /** The install rules, without the virtual-webcam rule; the first match decides. */
  function blockReason(): UpdateBlockReason | null {
    if (delayReason && Date.now() < delayUntil) return delayReason
    if (ctx.capture.isCapturing()) return 'capturing'
    const win = ctx.windows.main()
    if (!win || !win.isVisible()) return null
    if (ctx.ui.mainWindowFocused()) return 'focused'
    if (ctx.ui.viewingNoteId() !== null) return 'viewing-meeting'
    return null
  }

  // ---- install ----
  let installTimer: NodeJS.Timeout | null = null

  async function install(mode: InstallMode): Promise<void> {
    const s = getUpdateState()
    if (s.download.state !== 'downloaded') throw notulaError('invalid-input', 'No downloaded version to install')
    if (s.installing) return
    if (installTimer) clearInterval(installTimer)
    installTimer = null
    setUpdateState({ installing: true, installBlockedReason: null })
    markInstallingUpdate()

    const win = ctx.windows.main()
    const flag: InstallFlag = {
      mode,
      wasVisible: !!win && win.isVisible() && !win.isMinimized(),
      wasFocused: ctx.ui.mainWindowFocused(),
      bounds: win ? win.getNormalBounds() : null,
      source: 'builtIn',
      version: s.download.version
    }
    try {
      writeFileSync(flagPath(ctx), JSON.stringify(flag))
    } catch (err) {
      log('warn', 'update:flag-write-failed', { err })
      try {
        writeFileSync(flagPath(ctx), mode)
      } catch (err2) {
        log('error', 'update:flag-fallback-failed', { err: err2 })
      }
    }
    log('info', 'update:installing', { mode, version: s.download.version })
    await new Promise((r) => setTimeout(r, INSTALL_WAIT_MS))
    // Not silent (no flag); the app runs again afterwards.
    autoUpdater.quitAndInstall(false, true)
  }

  let rechecks = 0
  function evaluateInstall(): void {
    if (getUpdateState().download.state !== 'downloaded' || getUpdateState().installing) return
    const reason = blockReason()
    if (reason !== getUpdateState().installBlockedReason) setUpdateState({ installBlockedReason: reason })
    if (!reason) {
      void install(rechecks === 0 ? 'instant' : 'background').catch((err: unknown) =>
        log('error', 'update:install-failed', { err })
      )
      return
    }
    if (rechecks % 10 === 0) log('info', 'update:install-blocked', { reason, rechecks })
    rechecks++
  }

  // ---- checks ----
  let checkTimer: NodeJS.Timeout | null = null

  async function check(source: string): Promise<void> {
    // No checks or downloads while local-only is on.
    const paused = await egressBlocked(ctx, { kind: 'update' })
    if (paused !== getUpdateState().pausedByLocalOnly) setUpdateState({ pausedByLocalOnly: paused })
    if (paused) {
      log('info', 'update:check-skipped', { source, reason: LOCAL_ONLY_REASON })
      return
    }
    if (feed === 'none') {
      log('info', 'update:check-skipped', { source, reason: 'no feed' })
      setUpdateState({ lastCheck: { at: new Date().toISOString(), available: false, version: null } })
      return
    }
    const s = getUpdateState()
    if (s.checking || s.download.state !== 'idle') return
    const policyDisabled = await readPolicyDisabled()
    if (policyDisabled !== s.policyDisabled) setUpdateState({ policyDisabled })
    if (policyDisabled) {
      log('info', 'update:check-skipped', { source, reason: 'policy' })
      return
    }
    log('info', 'update:check', { source })
    try {
      await autoUpdater.checkForUpdates()
    } catch {
      // Logged and reflected by the `error` event; the next periodic check retries.
    }
  }

  bindUpdaterActions({
    check: (source) => void check(source),
    install: (source) => {
      log('info', 'update:install-requested', { source })
      return install('manual')
    }
  })

  ipcMain.handle('update:get-state' satisfies InvokeChannel, (): InvokeRes<'update:get-state'> => getUpdateState())
  ipcMain.handle('update:install' satisfies InvokeChannel, (): Promise<InvokeRes<'update:install'>> => install('manual'))

  // The channel and the local-only pause follow their settings.
  void Promise.all([ctx.settings.get('updates.channel'), egressBlocked(ctx, { kind: 'update' })])
    .then(([c, paused]) => {
      channel = c
      setUpdateState({ channel: c, pausedByLocalOnly: paused })
      if (feed !== 'none' && c === 'beta') autoUpdater.setFeedURL({ provider: 'generic', url: feedFor(c) })
    })
    .catch((err: unknown) => log('warn', 'update:channel-read-failed', { err }))
  ctx.bus.on('settings:changed', (e) => {
    if (e.keys.includes('privacy.localOnly')) {
      void egressBlocked(ctx, { kind: 'update' }).then((paused) => setUpdateState({ pausedByLocalOnly: paused }))
    }
    if (!e.keys.includes('updates.channel') || e.settings['updates.channel'] === channel) return
    channel = e.settings['updates.channel']
    setUpdateState({ channel })
    log('info', 'update:channel-changed', { channel })
    if (feed === 'none') return
    autoUpdater.setFeedURL({ provider: 'generic', url: feedFor(channel) })
    const d = getUpdateState().download
    if (d.state === 'downloaded' && downloadedFrom !== channel) setUpdateState({ download: { state: 'idle' } })
    void check('channel')
  })

  if (feed === 'none') {
    log('info', 'update:no-feed', { packaged: app.isPackaged, platform: process.platform, url: feedUrl !== '' })
    return
  }

  // ---- electron-updater (only with a feed) ----
  autoUpdater.logger = {
    info: (m?: unknown) => log('debug', 'update:lib', { m: String(m) }),
    warn: (m?: unknown) => log('warn', 'update:lib', { m: String(m) }),
    error: (m?: unknown) => log('error', 'update:lib', { m: String(m) }),
    debug: (m: string) => log('debug', 'update:lib', { m })
  }
  autoUpdater.autoDownload = app.isPackaged
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.allowDowngrade = false
  autoUpdater.allowPrerelease = false
  autoUpdater.disableDifferentialDownload = true
  autoUpdater.disableWebInstaller = true
  autoUpdater.requestHeaders = null
  // No device id. These two members are electron-updater 6.8.10 internals
  // (the version is pinned): the staging id it would create and persist per install,
  // and the header that carries it on every feed request.
  const internals = autoUpdater as unknown as {
    stagingUserIdPromise: { value: Promise<string> }
    computeFinalHeaders: (headers: Record<string, string>) => Record<string, string>
  }
  Object.defineProperty(internals, 'stagingUserIdPromise', { value: { value: Promise.resolve(SHARED_STAGING_ID) } })
  internals.computeFinalHeaders = (headers) => {
    const { [STAGING_HEADER]: _dropped, ...rest } = headers
    return rest
  }
  autoUpdater.setFeedURL({ provider: 'generic', url: feedUrl })

  let availableVersion: string | null = null
  autoUpdater.on('checking-for-update', () => setUpdateState({ checking: true, error: null }))
  autoUpdater.on('update-available', (info: UpdateInfo) => {
    availableVersion = info.version
    setUpdateState({ checking: false, lastCheck: { at: new Date().toISOString(), available: true, version: info.version } })
    log('info', 'update:available', { version: info.version })
  })
  autoUpdater.on('update-not-available', () => {
    setUpdateState({ checking: false, lastCheck: { at: new Date().toISOString(), available: false, version: null } })
  })
  autoUpdater.on('download-progress', (p: ProgressInfo) => {
    const percent = Math.max(0, Math.min(100, Math.round(p.percent)))
    const d = getUpdateState().download
    if (d.state === 'downloading' && d.percent === percent) return
    setUpdateState({ download: { state: 'downloading', version: availableVersion ?? '', percent } })
  })
  autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
    downloadedFrom = channel
    setUpdateState({ download: { state: 'downloaded', version: info.version } })
    log('info', 'update:downloaded', { version: info.version })
    // The periodic check stops once an update has downloaded.
    if (checkTimer) clearInterval(checkTimer)
    checkTimer = null
    rechecks = 0
    evaluateInstall()
    installTimer ??= setInterval(evaluateInstall, INSTALL_RECHECK_MS)
  })
  autoUpdater.on('error', (err: Error) => {
    const d = getUpdateState().download
    setUpdateState({
      checking: false,
      error: err.message.slice(0, 300),
      ...(d.state === 'downloading' ? { download: { state: 'idle' as const } } : {})
    })
    log('error', 'update:error', { message: err.message })
  })

  setTimeout(() => void check('startup'), FIRST_CHECK_DELAY_MS)
  checkTimer = setInterval(() => void check('periodic'), CHECK_INTERVAL_MS)
}
