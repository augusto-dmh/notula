// SPDX-License-Identifier: Apache-2.0
// Course apps, the pure half: the reader's `apps` record (browser shortcuts with an --app-id, and
// the folder names under each profile's Web Applications folder) → installed web apps, and one
// media-session app id → its mapping. No Electron and type-only imports, so the dev harness
// (scripts/dev/media-replay.mjs) loads it directly.
//
// Measured app ids (Chrome 156, Edge 156 shortcuts and windows):
// - Chrome: `Chrome._crx_<id>`, where <id> can be the 32-letter app id with one contiguous run
//   removed (the OS caps each part of an AppUserModel ID). A window of another profile adds
//   `.<profile>` parts after it.
// - Edge: `MSEdge._crx__<id>`, shortened the same way, or `<host>-<hash>_<publisher>!App`.

import type { AppMapping } from '../../shared/types/sources'

export type AppBrowser = AppMapping['browser']

/** A browser shortcut that launches a web app. */
export interface AppShortcut {
  name: string
  browser: AppBrowser
  profile: string | null
  appId: string
  /** Edge's `--app-url`: its host only. */
  host: string | null
  aumid: string | null
}

/** `<User Data>\<profile>\Web Applications\_crx_<appId>` (Edge: `_crx__<appId>`). */
export interface AppFolder {
  browser: AppBrowser
  profile: string
  appId: string
}

export interface AppInventory {
  shortcuts: AppShortcut[]
  folders: AppFolder[]
}

/** The OS app ids of the browsers themselves (never web apps). */
const BROWSER_IDS: Readonly<Record<string, AppBrowser>> = { Chrome: 'chrome', MSEdge: 'edge' }

const SHORT_ID = /^(Chrome|MSEdge)\._crx_+([a-z]+)/
const EDGE_HOST_ID = /^([a-z0-9-]+(?:\.[a-z0-9-]+)+)-[a-z0-9]+_[a-z0-9]+!App$/i
/** The shortest id part that may stand for an app id (one run removed from 32 letters). */
const MIN_SHORT = 8

function str(v: unknown, max = 2_000): string {
  return typeof v === 'string' ? v.slice(0, max) : ''
}

function browserOfExe(exe: string): AppBrowser | null {
  const e = exe.toLowerCase()
  if (e === 'chrome_proxy.exe' || e === 'chrome.exe') return 'chrome'
  if (e === 'msedge_proxy.exe' || e === 'msedge.exe') return 'edge'
  return null
}

/** `--name=value` or `--name="value with spaces"`. */
function arg(args: string, name: string): string | null {
  const m = new RegExp(`(?:^|\\s)--${name}=(?:"([^"]*)"|(\\S+))`).exec(args)
  const v = m ? (m[1] ?? m[2] ?? '') : ''
  return v.trim() || null
}

function hostOf(url: string | null): string | null {
  if (!url) return null
  try {
    const u = new URL(url)
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.hostname.toLowerCase() || null : null
  } catch {
    return null
  }
}

/** One shortcut of the reader's record; null unless it launches a browser web app. */
export function parseShortcut(name: string, exe: string, args: string, aumid: string | null): AppShortcut | null {
  const browser = browserOfExe(exe)
  const appId = arg(args, 'app-id')
  if (!browser || !appId || !/^[a-z]{16,64}$/.test(appId)) return null
  return {
    name: name.replace(/\.lnk$/i, '').trim(),
    browser,
    profile: arg(args, 'profile-directory'),
    appId,
    host: browser === 'edge' ? hostOf(arg(args, 'app-url')) : null,
    aumid: aumid?.trim() || null
  }
}

/** A `Web Applications` folder name → its app id. */
export function folderAppId(browser: AppBrowser, folder: string): string | null {
  const m = (browser === 'edge' ? /^_crx__([a-z]{16,64})$/ : /^_crx_([a-z]{16,64})$/).exec(folder)
  return m ? (m[1] ?? null) : null
}

/** An `apps` record → the inventory. Null for any other record. */
export function inventoryFromRecord(rec: Record<string, unknown>): AppInventory | null {
  if (rec['ev'] !== 'apps') return null
  const shortcuts: AppShortcut[] = []
  for (const s of Array.isArray(rec['shortcuts']) ? (rec['shortcuts'] as unknown[]).slice(0, 500) : []) {
    if (!s || typeof s !== 'object') continue
    const o = s as Record<string, unknown>
    const p = parseShortcut(str(o['name'], 300), str(o['exe'], 100), str(o['args'], 4_000), str(o['aumid'], 300) || null)
    if (p) shortcuts.push(p)
  }
  const folders: AppFolder[] = []
  for (const f of Array.isArray(rec['folders']) ? (rec['folders'] as unknown[]).slice(0, 500) : []) {
    if (!f || typeof f !== 'object') continue
    const o = f as Record<string, unknown>
    const browser = o['browser'] === 'chrome' || o['browser'] === 'edge' ? o['browser'] : null
    const profile = str(o['profile'], 200)
    const appId = browser ? folderAppId(browser, str(o['folder'], 100)) : null
    if (browser && profile && appId) folders.push({ browser, profile, appId })
  }
  return { shortcuts, folders }
}

/** True when `short` is `full`, or `full` with one contiguous run removed. */
export function isShortenedOf(short: string, full: string): boolean {
  if (short === full) return true
  if (short.length < MIN_SHORT || short.length >= full.length) return false
  for (let i = 0; i <= short.length; i++) {
    if (full.startsWith(short.slice(0, i)) && full.endsWith(short.slice(i))) return true
  }
  return false
}

/** The site an Edge app id starts with (`app.example.org-<hash>_<publisher>!App`). */
export function hostFromAppId(appUserModelId: string): string | null {
  const m = EDGE_HOST_ID.exec(appUserModelId)
  return m ? (m[1] ?? '').toLowerCase() || null : null
}

/** The id a shortcut's app is reported under: its own AppUserModel ID, or the plain browser form. */
function idOf(s: AppShortcut): string {
  return s.aumid ?? `${s.browser === 'chrome' ? 'Chrome._crx_' : 'MSEdge._crx__'}${s.appId}`
}

/** Every installed web app, one row per app id. */
export function listFromInventory(inv: AppInventory): AppMapping[] {
  const out = new Map<string, AppMapping>()
  for (const s of inv.shortcuts) {
    const id = idOf(s)
    if (out.has(id)) continue
    out.set(id, mapFromInventory(inv, id))
  }
  return [...out.values()]
}

function unmapped(appUserModelId: string, browser: AppBrowser, host: string | null = null): AppMapping {
  return { appUserModelId, browser, profile: null, appId: null, name: null, host, state: 'unmapped' }
}

/**
 * One app id → its mapping. `ignored` for a browser's own id or an id no browser app carries;
 * `unmapped` when several apps or profiles fit, or none does for a browser-shaped id.
 */
export function mapFromInventory(inv: AppInventory, appUserModelId: string): AppMapping {
  const own = BROWSER_IDS[appUserModelId]
  if (own) return { ...unmapped(appUserModelId, own), state: 'ignored' }
  const exact = inv.shortcuts.filter((s) => s.aumid === appUserModelId)
  const short = SHORT_ID.exec(appUserModelId)
  let browser: AppBrowser | null = exact[0]?.browser ?? null
  let appIds: Set<string>
  if (exact.length) {
    appIds = new Set(exact.map((s) => s.appId))
  } else if (short) {
    browser = short[1] === 'Chrome' ? 'chrome' : 'edge'
    const part = short[2] ?? ''
    const b = browser
    appIds = new Set([...inv.shortcuts.filter((s) => s.browser === b).map((s) => s.appId), ...inv.folders.filter((f) => f.browser === b).map((f) => f.appId)].filter((id) => isShortenedOf(part, id)))
  } else {
    return { ...unmapped(appUserModelId, 'edge'), state: 'ignored' }
  }
  const idHost = hostFromAppId(appUserModelId)
  if (!browser || appIds.size !== 1) return unmapped(appUserModelId, browser ?? 'edge', idHost)
  const appId = [...appIds][0] ?? ''
  const b = browser
  const shortcuts = (exact.length ? exact : inv.shortcuts.filter((s) => s.browser === b && s.appId === appId))
  // Several profiles holding the app can't be told apart.
  const profiles = new Set([...shortcuts.map((s) => s.profile), ...inv.folders.filter((f) => f.browser === b && f.appId === appId).map((f) => f.profile)].filter((p): p is string => !!p))
  if (profiles.size > 1 && !exact.length) return unmapped(appUserModelId, b, idHost)
  const sc = shortcuts[0] ?? null
  const profile = sc?.profile ?? (profiles.size === 1 ? ([...profiles][0] ?? null) : null)
  return {
    appUserModelId,
    browser: b,
    profile,
    appId,
    name: sc?.name || null,
    host: idHost ?? sc?.host ?? null,
    state: 'mapped'
  }
}
