// SPDX-License-Identifier: Apache-2.0
// Steps 1 and 2 of identification: the browser's tab strip and, when the playing
// tab is the selected one, its address bar. Reads only; never switches, focuses or clicks.

import { hostIs, parseSourceUrl } from '@shared/lib/source-key'
import type { BrowserId } from '@shared/types/sources'
import { log } from '../log'
import { mediaReader } from './host'
import { BROWSER_PROCESS, siteFromLabel, tabFacts, windowFacts } from './lines'

export interface LocatedTab {
  privateWindow: boolean | 'unknown'
  /** The window title's profile segment (mapped to a History profile by identify). */
  profileName: string | null
  siteLabel: string | null
  site: string | null
  /** The tab carried the audio marker (otherwise matched on the title prefix alone). */
  audio: boolean
  selected: boolean
  /** The address bar's URL, only for a selected matched tab. */
  url: string | null
}

/**
 * The playback's tab: the one whose name starts with the title and carries the audio marker;
 * otherwise the only match, then the selected one, then the first. Null when the reader isn't
 * running or no tab matches.
 */
export async function locateTab(browser: BrowserId, title: string, wantAddress: boolean): Promise<LocatedTab | null> {
  const t0 = Date.now()
  const matches = await mediaReader.locate(BROWSER_PROCESS[browser], title, wantAddress)
  if (!matches) return null
  const facts = matches.flatMap((m) => {
    const f = tabFacts(m.tab, title)
    return f ? [{ m, f }] : []
  })
  log('debug', 'media:locate', { matches: facts.length, audio: facts.filter((x) => x.f.audio).length, ms: Date.now() - t0 })
  const pick = facts.find((x) => x.f.audio) ?? (facts.length === 1 ? facts[0] : undefined) ?? facts.find((x) => x.m.sel) ?? facts[0]
  if (!pick) return null
  const w = windowFacts(browser, pick.m.window)
  const labelSite = siteFromLabel(pick.f.siteLabel)
  let parsed = pick.m.sel && pick.m.addr ? parseSourceUrl(pick.m.addr) : null
  // Text being typed in the address bar isn't the page: a URL must agree with the tab's site.
  if (parsed && labelSite && labelSite.includes('.') && !hostIs(parsed.host, labelSite) && !hostIs(labelSite, parsed.host)) parsed = null
  return {
    privateWindow: w.privateWindow,
    profileName: w.profileName,
    siteLabel: pick.f.siteLabel,
    site: parsed?.host ?? labelSite,
    audio: pick.f.audio,
    selected: pick.m.sel,
    url: parsed ? parsed.url : null
  }
}
