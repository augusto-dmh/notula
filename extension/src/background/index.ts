// SPDX-License-Identifier: Apache-2.0
// The service worker: the only part that can talk to Notula over native messaging. It holds
// the tab state, merges frame reports, owns the native port and applies the privacy gates.
// MV3 wakes it on events, so every listener is registered synchronously at the top level.

import { isObj, oneOf } from '../lib/check'
import { adapterFor } from '../lib/keys'
import {
  parseContentMessage,
  parseTrack,
  type PopupConnection,
  type PopupRequest,
  type PopupState,
  type TranscriptReply
} from '../lib/messages'
import { EXT_BRIDGE } from '../lib/protocol'
import { readSettings, writeSettings, type ExtSettings } from '../lib/settings'
import { isYouTubeOrigin, needsPlayers, originOf } from '../lib/sites'
import { bridge, ensureConnected, initBridge, restoreBridge, touchIdle } from './bridge'
import { count } from './counters'
import { getLastMark, markMoment, onMarkAck } from './mark'
import { forgetTab, needsCaptionsHint, onCaptionsRequest, onOutlineRequest } from './requests'
import { disableSite, enableSite, onPermissionsAdded, onPermissionsRemoved, reconcileSites, startYouTubeMain } from './sites'
import {
  admit,
  anyPlaying,
  flushAll,
  gates,
  getTab,
  goneStopped,
  initTabs,
  onAudible,
  onChapters,
  onFrameReport,
  onPageReport,
  onTabLoading,
  onTabRemoved,
  onTrack,
  tabAllowed,
  tabPlaying
} from './tabs'

let settings: ExtSettings | null = null
/** Tabs linked once from the popup (activeTab), by tab id → origin. */
const linked = new Map<number, string>()
let lastTranscript: PopupState['transcript'] = null
/** The tab a site was turned on from, so the reader starts there at once (popup:site-pending). */
const pendingSite = new Map<string, { tabId: number; at: number }>()

async function loadSettings(): Promise<ExtSettings> {
  settings = await readSettings()
  gates.allowIncognito = settings.allowIncognito
  gates.captions = settings.captions
  return settings
}

const started = (async () => {
  await Promise.all([initTabs(), restoreBridge(), loadSettings()])
  try {
    const s = await chrome.storage.session.get('linked')
    if (isObj(s.linked)) {
      for (const [id, origin] of Object.entries(s.linked)) if (typeof origin === 'string') linked.set(Number(id), origin)
    }
  } catch {
    // Nothing linked yet.
  }
})()

function saveLinked(): void {
  void chrome.storage.session.set({ linked: Object.fromEntries(linked) }).catch(() => undefined)
}

initBridge({
  onReady: flushAll,
  onMessage(msg) {
    if (msg.type === 'captions.request') void onCaptionsRequest(msg)
    else if (msg.type === 'outline.request') void onOutlineRequest(msg)
    else if (msg.type === 'mark.ack') onMarkAck(msg)
  },
  wantsConnection: anyPlaying,
  beforeIdleClose: goneStopped,
  async allowed() {
    await started
    return settings?.disclosureAccepted ?? false
  }
})

/** The reader may report from this tab: YouTube, a site the user turned on, or a linked tab. */
function hasAccess(tab: chrome.tabs.Tab | undefined): boolean {
  if (!tab || tab.id === undefined) return false
  const origin = originOf(tab.url)
  if (!origin) return false
  if (isYouTubeOrigin(origin)) return true
  if (settings?.sites.includes(origin)) return true
  return linked.get(tab.id) === origin
}

async function onContentMessage(raw: unknown, sender: chrome.runtime.MessageSender): Promise<void> {
  await started
  const tab = sender.tab
  if (!tab || !hasAccess(tab) || !settings?.disclosureAccepted) return
  if (!admit(tab)) return
  const msg = parseContentMessage(raw)
  if (!msg) {
    count('content:invalid')
    return
  }
  switch (msg.k) {
    case 'report': {
      const { started: began } = onFrameReport(tab, sender.frameId ?? 0, msg)
      if (began || (msg.event === 'play' && anyPlaying())) void ensureConnected('play')
      return
    }
    case 'page':
      if ((sender.frameId ?? 0) === 0) onPageReport(tab, msg)
      return
    case 'chapters':
      onChapters(tab, msg)
      return
    case 'captions':
      onTrack(tab, msg)
      return
    case 'miss': {
      const site = originOf(tab.url)?.replace(/^https:\/\/(www\.)?/, '') ?? 'unknown'
      count(`adapter-miss:${site}:${msg.field}`)
      return
    }
  }
}

function parsePopupRequest(v: unknown): PopupRequest | undefined {
  if (!isObj(v)) return undefined
  const tabId = typeof v.tabId === 'number' && Number.isInteger(v.tabId) && v.tabId >= 0 ? v.tabId : null
  const origin = typeof v.origin === 'string' && /^https:\/\/[a-z0-9.-]+$/.test(v.origin) ? v.origin : null
  const k = oneOf(v.k, [
    'popup:state',
    'popup:mark',
    'popup:accept',
    'popup:connect',
    'popup:site-pending',
    'popup:site-on',
    'popup:site-off',
    'popup:link-tab',
    'popup:transcript'
  ] as const)
  switch (k) {
    case 'popup:state':
      return { k, tabId }
    case 'popup:mark':
    case 'popup:accept':
    case 'popup:connect':
      return { k }
    case 'popup:site-pending':
    case 'popup:site-on':
      return origin ? { k, origin, tabId } : undefined
    case 'popup:site-off':
      return origin ? { k, origin } : undefined
    case 'popup:link-tab':
    case 'popup:transcript':
      return tabId !== null ? { k, tabId } : undefined
    default:
      return undefined
  }
}

async function popupState(tabId: number | null): Promise<PopupState> {
  await started
  const s = settings ?? (await loadSettings())
  const tab = tabId !== null ? await chrome.tabs.get(tabId).catch(() => null) : null
  const origin = originOf(tab?.url)
  const e = tabId !== null ? getTab(tabId) : undefined
  const adapter = e?.frames.get(0)?.report.adapter ?? (tab?.url ? adapterFor(tab.url) : null)
  const access: PopupState['site']['access'] = !origin
    ? 'unsupported'
    : isYouTubeOrigin(origin)
      ? 'youtube'
      : s.sites.includes(origin)
        ? 'on'
        : tabId !== null && linked.get(tabId) === origin
          ? 'linked'
          : 'off'
  const playing = !!e && tabPlaying(e)
  let connection: PopupConnection = bridge.connection
  if (!s.disclosureAccepted) connection = 'setup'
  return {
    connection,
    appVersion: bridge.appVersion,
    site: { origin, access },
    adapter,
    playing,
    incognitoPaused: !!e && playing && !tabAllowed(e),
    captionsHint: tabId !== null && needsCaptionsHint(tabId),
    canReadTranscript: adapter === 'circle' && (access === 'on' || access === 'linked') && s.captions,
    lastMark: getLastMark(),
    transcript: lastTranscript
  }
}

/** Read this lesson's transcript: one click on the page's button, on request. */
async function readTranscript(tabId: number): Promise<TranscriptReply> {
  let raw: unknown
  try {
    raw = await chrome.tabs.sendMessage(tabId, { k: 'transcript' }, { frameId: 0 })
  } catch {
    return { status: 'failed' }
  }
  if (isObj(raw) && raw.status === 'none') return { status: 'none' }
  const track = isObj(raw) && raw.status === 'ok' && isObj(raw.track) ? parseTrack(raw.track) : undefined
  const tab = await chrome.tabs.get(tabId).catch(() => null)
  if (!track || !tab || !hasAccess(tab)) return { status: 'failed' }
  // Cached for the tab; sent now if this tab is the feed, else when Notula asks for it.
  const e = onTrack(tab, track)
  const sent = !!e && e.tracksSent.has(`${track.video}|${track.lang}|${track.source}`)
  lastTranscript = { count: track.cues.length, sent, at: Date.now() }
  return { status: 'ok', count: track.cues.length }
}

async function onPopupRequest(req: PopupRequest): Promise<unknown> {
  await started
  switch (req.k) {
    case 'popup:state':
      return popupState(req.tabId)
    case 'popup:connect':
      void ensureConnected('popup')
      return true
    case 'popup:accept':
      await writeSettings({ disclosureAccepted: true })
      await loadSettings()
      await startYouTubeMain()
      void ensureConnected('popup')
      return true
    case 'popup:mark':
      await markMoment()
      return true
    case 'popup:site-pending':
      if (req.tabId !== null) pendingSite.set(req.origin, { tabId: req.tabId, at: Date.now() })
      return true
    case 'popup:site-on': {
      const tab = req.tabId !== null ? await chrome.tabs.get(req.tabId).catch(() => null) : null
      const adapter = tab?.url ? adapterFor(tab.url) : null
      const ok = await enableSite(req.origin, needsPlayers(adapter), req.tabId)
      await loadSettings()
      return ok
    }
    case 'popup:site-off':
      await disableSite(req.origin)
      await loadSettings()
      return true
    case 'popup:link-tab': {
      const tab = await chrome.tabs.get(req.tabId).catch(() => null)
      const origin = originOf(tab?.url)
      if (!origin) return false
      linked.set(req.tabId, origin)
      saveLinked()
      await chrome.scripting
        .executeScript({ target: { tabId: req.tabId, allFrames: true }, files: ['content/reader.js'] })
        .catch(() => undefined)
      return true
    }
    case 'popup:transcript':
      return readTranscript(req.tabId)
  }
}

chrome.runtime.onMessage.addListener((raw, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return undefined
  const fromExtensionPage = !!sender.url && sender.url.startsWith(chrome.runtime.getURL(''))
  if (fromExtensionPage) {
    const req = parsePopupRequest(raw)
    if (!req) return undefined
    void onPopupRequest(req).then(sendResponse, () => sendResponse(null))
    return true
  }
  void onContentMessage(raw, sender)
  return undefined
})

chrome.commands.onCommand.addListener((command) => {
  if (command === EXT_BRIDGE.command) void started.then(markMoment)
})

chrome.tabs.onRemoved.addListener((tabId) => {
  onTabRemoved(tabId)
  forgetTab(tabId)
  if (linked.delete(tabId)) saveLinked()
})

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.audible !== undefined) onAudible(tabId, info.audible)
  if (info.status === 'loading') onTabLoading(tabId)
})

chrome.permissions.onAdded.addListener((added) => {
  void started.then(async () => {
    await onPermissionsAdded(added, (origin) => {
      const p = pendingSite.get(origin)
      pendingSite.delete(origin)
      return p && Date.now() - p.at < 5 * 60_000 ? p.tabId : null
    })
    await loadSettings()
  })
})

chrome.permissions.onRemoved.addListener((removed) => {
  void onPermissionsRemoved(removed).then(loadSettings)
})

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) {
    const accepted = (v: unknown): boolean => isObj(v) && v.disclosureAccepted === true
    // The acceptance went away (storage cleared or reset): the main-world script goes with it.
    if (accepted(changes.settings.oldValue) && !accepted(changes.settings.newValue)) void reconcileSites()
    void loadSettings().then(() => {
      flushAll()
      touchIdle()
    })
  }
})

chrome.runtime.onStartup.addListener(() => {
  void started.then(async () => {
    await reconcileSites()
    // A short hello to learn Notula's mode; it closes again after 5 s if nothing plays.
    await ensureConnected('startup')
  })
})

chrome.runtime.onInstalled.addListener((details) => {
  void started.then(async () => {
    await reconcileSites()
    // The first run explains what is sent before anything is sent.
    if (details.reason === 'install') await chrome.runtime.openOptionsPage().catch(() => undefined)
  })
})
