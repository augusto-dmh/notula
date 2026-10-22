// SPDX-License-Identifier: Apache-2.0
// The extension's own settings, in chrome.storage.local: the sites the user
// turned on, the switches and nothing about pages. Defaults live in code.

import { isObj } from './check'

export interface ExtSettings {
  /** The first-run explanation was read and accepted; nothing is sent before. */
  disclosureAccepted: boolean
  /** Our half of the private-window gate; Notula's `sources.extension.allowIncognito` is the other. */
  allowIncognito: boolean
  /** Send video captions and course transcripts. Notula's policy can still turn them off. */
  captions: boolean
  /** Origins turned on with Enable on this site, as `https://host`. */
  sites: string[]
  /** The sites among them that also asked for the video player origins. */
  playerSites: string[]
}

export const DEFAULT_SETTINGS: ExtSettings = {
  disclosureAccepted: false,
  allowIncognito: false,
  captions: true,
  sites: [],
  playerSites: []
}

const SITES_MAX = 200

export async function readSettings(): Promise<ExtSettings> {
  const raw = await chrome.storage.local.get('settings')
  const s = isObj(raw.settings) ? raw.settings : {}
  const origins = (v: unknown): string[] =>
    Array.isArray(v)
      ? v.filter((x): x is string => typeof x === 'string' && /^https:\/\/[a-z0-9.-]+$/.test(x)).slice(0, SITES_MAX)
      : []
  return {
    disclosureAccepted: typeof s.disclosureAccepted === 'boolean' ? s.disclosureAccepted : DEFAULT_SETTINGS.disclosureAccepted,
    allowIncognito: typeof s.allowIncognito === 'boolean' ? s.allowIncognito : DEFAULT_SETTINGS.allowIncognito,
    captions: typeof s.captions === 'boolean' ? s.captions : DEFAULT_SETTINGS.captions,
    sites: origins(s.sites),
    playerSites: origins(s.playerSites)
  }
}

export async function writeSettings(patch: Partial<ExtSettings>): Promise<ExtSettings> {
  const next = { ...(await readSettings()), ...patch }
  next.sites = [...new Set(next.sites)].slice(0, SITES_MAX)
  next.playerSites = [...new Set(next.playerSites)].filter((o) => next.sites.includes(o))
  await chrome.storage.local.set({ settings: next })
  return next
}
