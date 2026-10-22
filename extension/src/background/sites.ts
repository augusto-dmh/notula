// SPDX-License-Identifier: Apache-2.0
// Sites the reader runs on besides YouTube. The popup asks the browser for the site's
// origin on the user's click (a permission request needs that click); this module then registers
// the reader for it with `scripting.registerContentScripts`, and unregisters it when the user
// turns the site off or removes the access in the browser.
//
// Player origins are one shared registration, kept while any site that needs them is on.
//
// The YouTube main-world script (youtube-main.ts wraps the page's fetch and XHR to see the caption
// files the player downloads) is registered here too, only once the first-run explanation is
// accepted, and unregistered if that acceptance goes away. Before that, YouTube pages
// run only the isolated reader, which changes nothing on the page.

import { readSettings, writeSettings } from '../lib/settings'
import { PLAYER_ORIGIN_PATTERNS, scriptIdFor } from '../lib/sites'

const READER = 'content/reader.js'
const PLAYERS_ID = 'players'
const YOUTUBE_MAIN = 'content/youtube-main.js'
const YOUTUBE_MAIN_ID = 'youtube-main'
const YOUTUBE_PATTERNS = ['https://www.youtube.com/*', 'https://m.youtube.com/*']

function siteScript(origin: string): chrome.scripting.RegisteredContentScript {
  return {
    id: scriptIdFor(origin),
    matches: [`${origin}/*`],
    js: [READER],
    allFrames: true,
    runAt: 'document_idle',
    persistAcrossSessions: true
  }
}

function playersScript(): chrome.scripting.RegisteredContentScript {
  return {
    id: PLAYERS_ID,
    matches: [...PLAYER_ORIGIN_PATTERNS],
    js: [READER],
    allFrames: true,
    runAt: 'document_idle',
    persistAcrossSessions: true
  }
}

function youtubeMainScript(): chrome.scripting.RegisteredContentScript {
  return {
    id: YOUTUBE_MAIN_ID,
    matches: YOUTUBE_PATTERNS,
    js: [YOUTUBE_MAIN],
    allFrames: true,
    runAt: 'document_start',
    persistAcrossSessions: true,
    world: 'MAIN'
  }
}

async function registered(): Promise<Set<string>> {
  const list = await chrome.scripting.getRegisteredContentScripts()
  return new Set(list.map((s) => s.id))
}

async function hasOrigins(patterns: readonly string[]): Promise<boolean> {
  return chrome.permissions.contains({ origins: [...patterns] })
}

/** After the popup's permission request succeeded. */
export async function enableSite(origin: string, withPlayers: boolean, tabId: number | null): Promise<boolean> {
  if (!(await hasOrigins([`${origin}/*`]))) return false
  const s = await readSettings()
  const players = withPlayers && (await hasOrigins(PLAYER_ORIGIN_PATTERNS))
  await writeSettings({
    sites: [...s.sites, origin],
    playerSites: players ? [...s.playerSites, origin] : s.playerSites
  })
  await reconcileSites()
  if (tabId !== null) {
    // Start reading now, without a reload. A frame we can't reach is skipped by the browser.
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: [READER] }).catch(() => undefined)
  }
  return true
}

export async function disableSite(origin: string): Promise<void> {
  const s = await readSettings()
  const playerSites = s.playerSites.filter((o) => o !== origin)
  await writeSettings({ sites: s.sites.filter((o) => o !== origin), playerSites })
  await chrome.permissions.remove({ origins: [`${origin}/*`] }).catch(() => false)
  if (!playerSites.length) await chrome.permissions.remove({ origins: [...PLAYER_ORIGIN_PATTERNS] }).catch(() => false)
  await reconcileSites()
}

/**
 * Access was added: by the popup's request (the popup can close while the browser's prompt is
 * up, so its own follow-up may never arrive), or by the user in the browser's site-access menu.
 * Either way, a granted https origin becomes a site the reader runs on.
 */
export async function onPermissionsAdded(added: chrome.permissions.Permissions, tabFor: (origin: string) => number | null): Promise<void> {
  const patterns = added.origins ?? []
  const players = PLAYER_ORIGIN_PATTERNS.every((p) => patterns.includes(p))
  const s = await readSettings()
  for (const p of patterns) {
    if ((PLAYER_ORIGIN_PATTERNS as readonly string[]).includes(p)) continue
    const m = /^https:\/\/([a-z0-9.-]+)\/\*$/.exec(p)
    if (!m) continue
    const origin = `https://${m[1]}`
    if (s.sites.includes(origin)) continue
    await enableSite(origin, players, tabFor(origin))
  }
}

/** The browser's access list changed under us (the user removed a site in its settings). */
export async function onPermissionsRemoved(removed: chrome.permissions.Permissions): Promise<void> {
  const origins = new Set((removed.origins ?? []).map((p) => p.replace(/\/\*$/, '')))
  const s = await readSettings()
  const sites = s.sites.filter((o) => !origins.has(o))
  const playersGone = PLAYER_ORIGIN_PATTERNS.some((p) => (removed.origins ?? []).includes(p))
  const playerSites = playersGone ? [] : s.playerSites.filter((o) => !origins.has(o))
  if (sites.length !== s.sites.length || playerSites.length !== s.playerSites.length) {
    await writeSettings({ sites, playerSites })
  }
  await reconcileSites()
}

/** Makes the registrations match the settings and the access the browser actually grants. */
export async function reconcileSites(): Promise<void> {
  const s = await readSettings()
  const have = await registered()
  const want = new Map<string, chrome.scripting.RegisteredContentScript>()
  const kept: string[] = []
  for (const origin of s.sites) {
    if (!(await hasOrigins([`${origin}/*`]))) continue
    kept.push(origin)
    want.set(scriptIdFor(origin), siteScript(origin))
  }
  const playerSites = s.playerSites.filter((o) => kept.includes(o))
  if (playerSites.length && (await hasOrigins(PLAYER_ORIGIN_PATTERNS))) want.set(PLAYERS_ID, playersScript())
  if (s.disclosureAccepted) want.set(YOUTUBE_MAIN_ID, youtubeMainScript())
  if (kept.length !== s.sites.length || playerSites.length !== s.playerSites.length) {
    await writeSettings({ sites: kept, playerSites })
  }
  const stale = [...have].filter((id) => !want.has(id))
  if (stale.length) await chrome.scripting.unregisterContentScripts({ ids: stale }).catch(() => undefined)
  const fresh = [...want.values()].filter((sc) => !have.has(sc.id))
  if (fresh.length) await chrome.scripting.registerContentScripts(fresh).catch(() => undefined)
}

/**
 * Just accepted: YouTube tabs already open get the main-world script now, without a reload (it
 * runs once per page). The isolated reader there takes the first channel it hears.
 */
export async function startYouTubeMain(): Promise<void> {
  await reconcileSites()
  const open = await chrome.tabs.query({ url: YOUTUBE_PATTERNS }).catch(() => [] as chrome.tabs.Tab[])
  for (const tab of open) {
    if (tab.id === undefined) continue
    await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: [YOUTUBE_MAIN], world: 'MAIN' }).catch(() => undefined)
  }
}
