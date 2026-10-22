// SPDX-License-Identifier: Apache-2.0
// The popup: status, Enable on this site, Link this tab, Read this lesson's transcript,
// Mark this moment. The first run explains what is sent before anything is sent.
// Permission requests happen here, inside the click, because the browser needs the user's gesture.

import { EXT_BRIDGE } from '../lib/protocol'
import { applyI18n, t } from '../lib/i18n'
import type { PopupConnection, PopupRequest, PopupState, TranscriptReply } from '../lib/messages'
import { PLAYER_ORIGIN_PATTERNS, hostOf, needsPlayers } from '../lib/sites'

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T
const POLL_MS = 1_000
const RECENT_MS = 60_000

let tabId: number | null = null
let state: PopupState | null = null

function ask<T>(req: PopupRequest): Promise<T> {
  return chrome.runtime.sendMessage(req) as Promise<T>
}

const CONNECTION_TEXT: Record<PopupConnection, string> = {
  setup: 'connSetup',
  idle: 'connIdle',
  connecting: 'connConnecting',
  connected: 'connConnected',
  'off-in-notula': 'connOffInNotula',
  'not-running': 'connNotRunning',
  'host-missing': 'connHostMissing',
  'host-forbidden': 'connHostForbidden',
  'host-failed': 'connHostFailed',
  'app-outdated': 'connAppOutdated',
  'extension-outdated': 'connExtensionOutdated'
}

function markText(m: NonNullable<PopupState['lastMark']>): string {
  if (m.ok && m.position) return t('markOk', m.position)
  switch (m.reason) {
    case 'held':
      return m.position ? t('markHeld', m.position) : t('markNoAnswer')
    case 'no-media':
      return t('markNoMedia')
    case 'no-position':
      return t('markNoPosition')
    case 'no-answer':
      return t('markNoAnswer')
    default:
      return m.reason && m.reason in CONNECTION_TEXT ? t(CONNECTION_TEXT[m.reason as PopupConnection]) : t('markNoAnswer')
  }
}

function render(s: PopupState): void {
  state = s
  const setup = s.connection === 'setup'
  $('setup').hidden = !setup
  $('main').hidden = setup
  if (setup) return

  $('connection').textContent =
    s.connection === 'connected' && s.appVersion ? t('connConnectedVersion', s.appVersion) : t(CONNECTION_TEXT[s.connection])
  const dot = $('dot')
  dot.className = 'dot'
  if (s.connection === 'connected') dot.classList.add('on')
  else if (!['idle', 'connecting'].includes(s.connection)) dot.classList.add('bad')
  $('connection-actions').hidden = !['not-running', 'host-failed', 'host-missing', 'host-forbidden'].includes(s.connection)
  $('open-notula').hidden = s.connection !== 'not-running'

  const host = s.site.origin ? hostOf(s.site.origin) : ''
  const siteText: Record<PopupState['site']['access'], string> = {
    youtube: t('siteYoutube'),
    on: t('siteOn', host),
    linked: t('siteLinked'),
    off: t('siteOff'),
    unsupported: t('siteUnsupported')
  }
  $('site').textContent = siteText[s.site.access]
  $('site-actions').hidden = s.site.access !== 'off'
  $('site-off').hidden = s.site.access !== 'on'
  $('incognito').hidden = !s.incognitoPaused
  $('captions-hint').hidden = !s.captionsHint
  $('transcript').hidden = !s.canReadTranscript

  const tr = s.transcript
  if (tr && Date.now() - tr.at < RECENT_MS) {
    $('transcript-result').textContent = tr.sent ? t('transcriptSent', String(tr.count)) : t('transcriptHeld', String(tr.count))
  }
  const m = s.lastMark
  $('mark-result').textContent = m && Date.now() - m.at < RECENT_MS ? markText(m) : ''
}

async function refresh(): Promise<void> {
  try {
    render(await ask<PopupState>({ k: 'popup:state', tabId }))
  } catch {
    // The service worker is restarting; the next poll catches up.
  }
}

async function init(): Promise<void> {
  applyI18n()
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  tabId = tab?.id ?? null

  const commands = await chrome.commands.getAll().catch(() => [])
  const shortcut = commands.find((c) => c.name === EXT_BRIDGE.command)?.shortcut
  $('shortcut').textContent = shortcut || t('shortcutNone')

  $('accept').addEventListener('click', async () => {
    await ask({ k: 'popup:accept' })
    await refresh()
  })
  $('retry').addEventListener('click', () => void ask({ k: 'popup:connect' }).then(refresh))

  $('enable-site').addEventListener('click', () => {
    const origin = state?.site.origin
    if (!origin) return
    const players = needsPlayers(state?.adapter ?? null)
    const origins = [`${origin}/*`, ...(players ? PLAYER_ORIGIN_PATTERNS : [])]
    // The popup may close while the browser's prompt is up; the service worker then finishes the
    // job from permissions.onAdded and needs to know which tab to start in.
    void ask({ k: 'popup:site-pending', origin, tabId }).catch(() => null)
    // Called straight from the click: the browser shows its own prompt naming these sites.
    void chrome.permissions.request({ origins }).then(async (granted) => {
      if (granted) await ask({ k: 'popup:site-on', origin, tabId })
      await refresh()
    })
  })
  $('disable-site').addEventListener('click', async () => {
    const origin = state?.site.origin
    if (!origin) return
    await ask({ k: 'popup:site-off', origin })
    await refresh()
  })
  $('link-tab').addEventListener('click', async () => {
    if (tabId === null) return
    await ask({ k: 'popup:link-tab', tabId })
    await refresh()
  })
  $('read-transcript').addEventListener('click', async () => {
    if (tabId === null) return
    const button = $<HTMLButtonElement>('read-transcript')
    button.disabled = true
    $('transcript-result').textContent = t('transcriptReading')
    const r = await ask<TranscriptReply>({ k: 'popup:transcript', tabId }).catch(() => null)
    button.disabled = false
    if (!r || r.status === 'failed') $('transcript-result').textContent = t('transcriptFailed')
    else if (r.status === 'none') $('transcript-result').textContent = t('transcriptNone')
    await refresh()
  })
  $('mark').addEventListener('click', async () => {
    const button = $<HTMLButtonElement>('mark')
    button.disabled = true
    $('mark-result').textContent = t('marking')
    await ask({ k: 'popup:mark' }).catch(() => null)
    button.disabled = false
    await refresh()
  })

  // Opening the popup is one of the moments the extension connects.
  await ask({ k: 'popup:connect' }).catch(() => null)
  await refresh()
  setInterval(() => void refresh(), POLL_MS)
}

void init()
