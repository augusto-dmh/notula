// SPDX-License-Identifier: Apache-2.0
// The options page: the first-run explanation, sites turned on, the captions and private
// window switches, the shortcut, and links to Notula and the privacy policy. It opens on install
// so the explanation comes before anything is sent.

import { EXT_BRIDGE } from '../lib/protocol'
import { applyI18n, shortcutsUrl, t } from '../lib/i18n'
import type { PopupRequest } from '../lib/messages'
import { readSettings, writeSettings } from '../lib/settings'
import { hostOf } from '../lib/sites'

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T

function ask(req: PopupRequest): Promise<unknown> {
  return chrome.runtime.sendMessage(req)
}

async function render(): Promise<void> {
  const s = await readSettings()
  $('accept').hidden = s.disclosureAccepted
  $('accepted').hidden = !s.disclosureAccepted
  $<HTMLInputElement>('captions').checked = s.captions
  $<HTMLInputElement>('incognito').checked = s.allowIncognito
  $('incognito-browser').hidden = !s.allowIncognito || (await chrome.extension.isAllowedIncognitoAccess().catch(() => false))

  const list = $('sites')
  list.replaceChildren()
  for (const origin of s.sites) {
    const li = document.createElement('li')
    const name = document.createElement('span')
    name.textContent = hostOf(origin)
    const off = document.createElement('button')
    off.textContent = t('turnOff')
    off.setAttribute('aria-label', t('turnOffSite', hostOf(origin)))
    off.addEventListener('click', async () => {
      await ask({ k: 'popup:site-off', origin })
      await render()
    })
    li.append(name, off)
    list.append(li)
  }
  $('sites-empty').hidden = s.sites.length > 0
}

async function init(): Promise<void> {
  applyI18n()
  const commands = await chrome.commands.getAll().catch(() => [])
  $('shortcut').textContent = commands.find((c) => c.name === EXT_BRIDGE.command)?.shortcut || t('shortcutNone')

  $('accept').addEventListener('click', async () => {
    await ask({ k: 'popup:accept' })
    await render()
  })
  $<HTMLInputElement>('captions').addEventListener('change', async (ev) => {
    await writeSettings({ captions: (ev.target as HTMLInputElement).checked })
    await render()
  })
  $<HTMLInputElement>('incognito').addEventListener('change', async (ev) => {
    await writeSettings({ allowIncognito: (ev.target as HTMLInputElement).checked })
    await render()
  })
  $('change-shortcut').addEventListener('click', () => void chrome.tabs.create({ url: shortcutsUrl() }))
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings) void render()
  })
  await render()
}

void init()
