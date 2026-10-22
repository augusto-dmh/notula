// SPDX-License-Identifier: Apache-2.0
// The browser extension's desktop side: the per-user pipe server,
// auth and protocol, the extension provider, and the host files and HKCU keys written only while
// `sources.extension.enabled` is on.
//
// The provider publishes bus `media:extension`, `media:extension-captions`, `sources:mark` and
// `sources:playback` with provider `extension`, and follows bus `sources:feed` for the desktop
// mode. It owns `ext-bridge:get-status`, `ext-bridge:set-enabled`, `ext-bridge:repair` and push
// `ext-bridge:status-changed`.
//
// - Registration (install.ts) happens only when the user turns the switch on, and is undone when
//   it goes off; the NSIS uninstaller deletes the two keys too (installer.nsh). While on, the
//   files and keys are checked and rewritten at start, so a moved install heals itself.
// - The pipe listens only while Sources and the switch are both on, on Windows. With it closed the
//   relay tells the extension Notula isn't running, and the extension backs off.
// - Optional: with the switch off, nothing here writes, listens or publishes anything.
// - Dev builds only: NOTULA_DEV_EXT_REGISTRY_ROOT (a key under HKCU\Software\NotulaDevTest) replaces
//   the real keys, and NOTULA_DEV_EXT_REGISTRY_DRY_RUN=1 only logs the reg.exe calls.
// Logs carry state names and counts only.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, ipcMain } from 'electron'
import { notulaError } from '@shared/errors'
import type { InvokeChannel, InvokeRes, PushChannel } from '@shared/ipc'
import { EXT_BRIDGE, type ExtBridgeState, type ExtBridgeStatus } from '@shared/types/extension-protocol'
import type { Settings, SettingKey } from '@shared/types/settings'
import type { MainContext } from '../../context'
import { log } from '../../log'
import hostLauncher from './host/notula-ext-host.cmd?raw'
import hostScript from './host/notula-ext-host.cjs?raw'
import { checkHost, installHost, keysNameHost, removeHost, type HostCheck, type HostInstall } from './install'
import { allowedOrigins } from './origins'
import { ExtensionProvider, type BrowserSeen } from './provider'
import { BridgeServer } from './server'

/** The files written to `<userData>\ext-bridge\` (EXT_BRIDGE), like the companion CLI's. */
export const HOST_FILES = { launcher: hostLauncher, script: hostScript } as const

const SEEN_FILE = 'seen.json'
const SEEN_MAX = 10
const CHECK_TTL_MS = 30_000
/** Settings that move the mode, the policy or the snapshots. */
const PROVIDER_KEYS: readonly SettingKey[] = [
  'sources.detect',
  'sources.extensionPreferred',
  'sources.extension.allowIncognito',
  'sources.extension.captions',
  'sources.extension.coursePages',
  'sources.videoCaptions',
  'privacy.localOnly'
]

export function registerSourcesExtension(ctx: MainContext): void {
  const supported = process.platform === 'win32'
  const dir = join(ctx.userDataPath, EXT_BRIDGE.folder)
  const devBuild = !app.isPackaged
  const origins = allowedOrigins(devBuild)
  const registryRoot = devBuild ? (process.env.NOTULA_DEV_EXT_REGISTRY_ROOT ?? '').replace(/^HKCU\\/i, '') : ''
  const dryRun = devBuild && process.env.NOTULA_DEV_EXT_REGISTRY_DRY_RUN === '1'

  let settings: Settings | null = null
  let listening = false
  let lastCheck: { at: number; check: HostCheck } | null = null
  let installFailed = false
  let seen: Record<string, BrowserSeen> = {}
  let chain: Promise<void> = Promise.resolve()
  /** The switch as the last reconcile saw it: an on → off transition always removes the keys. */
  let wasEnabled = false

  const enabled = (): boolean => supported && !!settings?.['sources.extension.enabled']
  const wantListen = (): boolean => enabled() && !!settings?.['sources.enabled']

  const hostInstall = (): HostInstall => ({
    dir,
    exePath: process.execPath,
    origins,
    launcher: HOST_FILES.launcher,
    script: HOST_FILES.script,
    registryRoot,
    dryRun,
    // Not `key`: the log redacts a field of that name, and the dry run is there to show the path.
    onCommand: dryRun ? (args) => log('info', 'ext-bridge:dry-run', { verb: args[0], regPath: args[1] }) : undefined
  })

  // ---------- browsers seen (not-installed vs waiting) ----------

  const loadSeen = (): void => {
    try {
      const raw: unknown = JSON.parse(readFileSync(join(dir, SEEN_FILE), 'utf8'))
      const out: Record<string, BrowserSeen> = {}
      if (raw && typeof raw === 'object') {
        for (const [brand, v] of Object.entries(raw as Record<string, unknown>).slice(0, SEEN_MAX)) {
          const o = v as Partial<BrowserSeen> | null
          if (brand.length <= 40 && o && typeof o.extVersion === 'string' && typeof o.lastSeenAt === 'number' && (o.store === 'cws' || o.store === 'edge' || o.store === 'dev')) {
            out[brand] = { extVersion: o.extVersion.slice(0, 40), store: o.store, lastSeenAt: o.lastSeenAt }
          }
        }
      }
      seen = out
    } catch {
      seen = {}
    }
  }

  const rememberSeen = (brand: string, info: BrowserSeen): void => {
    seen = { ...seen, [brand]: info }
    const brands = Object.keys(seen)
    if (brands.length > SEEN_MAX) delete seen[brands.sort((a, b) => (seen[a]?.lastSeenAt ?? 0) - (seen[b]?.lastSeenAt ?? 0))[0] as string]
    try {
      if (existsSync(dir)) writeFileSync(join(dir, SEEN_FILE), JSON.stringify(seen))
    } catch {
      // Status only.
    }
  }

  // ---------- status ----------

  const provider = new ExtensionProvider(ctx, {
    settings: () => settings,
    locked: () => ctx.deviceLock.isLocked(),
    appVersion: () => app.getVersion(),
    seen: rememberSeen,
    statusChanged: () => pushStatus()
  })

  const hostBroken = (): boolean => {
    if (installFailed) return true
    const c = lastCheck?.check
    return !!c && (!c.files || Object.values(c.keys).some((ok) => !ok))
  }

  function status(): ExtBridgeStatus {
    if (!enabled()) return { enabled: false, supported, state: 'off', browsers: [], adapterMisses: [] }
    const live = new Map(provider.browsers().map((b) => [b.brand, b]))
    const brands = new Set([...Object.keys(seen), ...live.keys()])
    const browsers: ExtBridgeStatus['browsers'] = [...brands].sort().map((brand) => {
      const l = live.get(brand)
      const s = seen[brand]
      const state: ExtBridgeState = l ? (l.outdated ? 'extension-outdated' : 'connected') : 'waiting'
      return { brand, state, extVersion: l?.extVersion ?? s?.extVersion ?? null, store: l?.store ?? s?.store ?? null, lastSeenAt: l?.lastSeenAt ?? s?.lastSeenAt ?? null }
    })
    let state: ExtBridgeState
    if (hostBroken()) state = 'host-failed'
    else if (browsers.some((b) => b.state === 'connected')) state = 'connected'
    else if (browsers.some((b) => b.state === 'extension-outdated')) state = 'extension-outdated'
    else state = browsers.length ? 'waiting' : 'not-installed'
    return { enabled: true, supported, state, browsers, adapterMisses: provider.adapterMisses() }
  }

  function pushStatus(): void {
    const payload = status()
    for (const wc of ctx.windows.targets()) wc.send('ext-bridge:status-changed' satisfies PushChannel, payload)
  }

  async function check(force: boolean): Promise<void> {
    if (!enabled()) return
    if (!force && lastCheck && Date.now() - lastCheck.at < CHECK_TTL_MS) return
    try {
      lastCheck = { at: Date.now(), check: await checkHost(hostInstall()) }
    } catch {
      lastCheck = null
    }
  }

  // ---------- install, listen, stop ----------

  async function install(): Promise<void> {
    try {
      const r = await installHost(hostInstall())
      installFailed = false
      log('info', 'ext-bridge:installed', { files: r.filesWritten, keys: r.keysWritten, devRoot: registryRoot !== '', dryRun })
    } catch (err) {
      installFailed = true
      log('warn', 'ext-bridge:install-failed', { step: err instanceof Error ? err.message.replace(/^host-install-failed:/, '') : 'unknown' })
      throw err
    } finally {
      await check(true)
    }
  }

  async function uninstall(): Promise<void> {
    const r = await removeHost(hostInstall())
    lastCheck = null
    installFailed = false
    seen = {}
    log('info', 'ext-bridge:removed', { keys: r.keysRemoved, files: r.filesRemoved })
  }

  async function stopListening(): Promise<void> {
    if (!listening) return
    listening = false
    await server.stop()
    provider.reset()
    log('info', 'ext-bridge:stopped')
  }

  /** Brings the listener and the files in line with the settings. Serialized. */
  function reconcile(opts: { reinstall?: boolean; remove?: boolean } = {}): Promise<void> {
    const run = async (): Promise<void> => {
      if (!enabled()) {
        const turnedOff = wasEnabled
        wasEnabled = false
        await stopListening()
        // On → off (here or a settings reset), or leftovers: no files or keys stay behind, even
        // when the folder is already gone (removeHost tolerates missing pieces).
        if (supported && (turnedOff || opts.remove || existsSync(dir))) await uninstall().catch(() => undefined)
        pushStatus()
        return
      }
      wasEnabled = true
      if (opts.reinstall || (wantListen() && !listening)) await install().catch(() => undefined)
      if (wantListen() && !listening) {
        listening = await server.start()
      } else if (!wantListen()) {
        await stopListening()
      }
      provider.refresh()
      pushStatus()
    }
    chain = chain.then(run, run)
    return chain
  }

  const server = new BridgeServer(dir, () => origins, {
    opened: (c) => provider.opened(c),
    message: (c, msg) => provider.message(c, msg),
    closed: (c) => provider.closed(c),
    dropped: (reason) => provider.count(`dropped:${reason}`)
  })

  // ---------- IPC ----------

  const enabledRequest = (raw: unknown): { enabled: boolean } => {
    if (!raw || typeof raw !== 'object' || typeof (raw as { enabled?: unknown }).enabled !== 'boolean') {
      throw notulaError('invalid-input', 'enabled must be true or false')
    }
    return { enabled: (raw as { enabled: boolean }).enabled }
  }

  ipcMain.handle('ext-bridge:get-status' satisfies InvokeChannel, async (): Promise<InvokeRes<'ext-bridge:get-status'>> => {
    await check(false)
    return status()
  })

  ipcMain.handle('ext-bridge:set-enabled' satisfies InvokeChannel, async (_e, raw: unknown): Promise<InvokeRes<'ext-bridge:set-enabled'>> => {
    const { enabled: on } = enabledRequest(raw)
    if (!supported) throw notulaError('invalid-input', 'The browser extension works on Windows only')
    const s = await ctx.settings.getAll()
    settings = s
    if (on) {
      if (!s['sources.enabled']) throw notulaError('invalid-input', 'Turn on Sources first')
      if (origins.length === 0) throw notulaError('invalid-input', 'This build of Notula doesn’t know the published extension yet')
      if (s['sources.extension.enabled']) return status()
      settings = { ...s, 'sources.extension.enabled': true }
      try {
        await install()
      } catch {
        settings = s
        await removeHost(hostInstall()).catch(() => undefined)
        throw notulaError('internal', 'Couldn’t set up the browser extension. Try again.')
      }
      await ctx.settings.set('sources.extension.enabled', true)
      settings = await ctx.settings.getAll()
      loadSeen()
      await reconcile()
      return status()
    }
    if (s['sources.extension.enabled']) {
      await ctx.settings.set('sources.extension.enabled', false)
      settings = await ctx.settings.getAll()
    }
    // Off always removes both keys and the folder, whatever is left of them.
    await reconcile({ remove: true })
    return status()
  })

  ipcMain.handle('ext-bridge:repair' satisfies InvokeChannel, async (): Promise<InvokeRes<'ext-bridge:repair'>> => {
    if (!enabled()) throw notulaError('invalid-input', 'The browser extension is off')
    // Fresh files, keys and token: a stale relay is dropped and the extension reconnects.
    await stopListening()
    await reconcile({ reinstall: true })
    if (installFailed) throw notulaError('internal', 'Couldn’t repair the browser extension. Try again.')
    return status()
  })

  // ---------- settings and quit ----------

  ctx.bus.on('settings:changed', ({ keys, settings: s }) => {
    settings = s
    if (keys.some((k) => k === 'sources.enabled' || k === 'sources.extension.enabled')) void reconcile()
    else if (keys.some((k) => PROVIDER_KEYS.includes(k))) provider.refresh()
  })

  void app.whenReady().then(async () => {
    try {
      settings = await ctx.settings.getAll()
    } catch (err) {
      log('warn', 'ext-bridge:settings-load-failed', { err })
      return
    }
    if (enabled()) loadSeen()
    // Off: nothing is written; a folder left by a crash is removed with its keys, and so are keys
    // that still name this folder after it went (reads only, no write unless one is found).
    if (enabled() || (supported && existsSync(dir))) await reconcile()
    else if (supported && (await keysNameHost(hostInstall()).catch(() => false))) await reconcile({ remove: true })
  })

  // `before-quit` too: the storage close ends with app.exit(), which skips `will-quit`.
  const onQuit = (): void => {
    server.stopNow()
    void provider.shutdown().catch(() => undefined)
  }
  app.on('before-quit', onQuit)
  app.on('will-quit', onQuit)
}
