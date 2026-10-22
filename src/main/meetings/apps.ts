// SPDX-License-Identifier: Apache-2.0
// B-internal app tables: raw ids the OS
// reports → the shared app ids of MEETING_APPS. Only main reads them.

import { basename } from 'node:path'
import type { MicApp } from '@shared/types/meetings'
import { MEETING_APPS } from '@shared/types/meetings'

/** macOS helper bundle ids → the parent app. */
const MAC_HELPERS: Record<string, string> = {
  'com.google.Chrome.helper': 'com.google.Chrome',
  'com.google.Chrome.beta.helper': 'com.google.Chrome.beta',
  'us.zoom.ZoomHybridConf': 'us.zoom.xos',
  'us.zoom.ZoomPhone': 'us.zoom.xos',
  'com.tinyspeck.slackmacgap.helper': 'com.tinyspeck.slackmacgap',
  'company.thebrowser.browser.helper': 'company.thebrowser.Browser',
  'company.thebrowser.dia.helper': 'company.thebrowser.dia',
  'Cisco-Systems.Spark': 'com.cisco.webexmeetingsapp',
  'com.microsoft.teams2.modulehost': 'com.microsoft.teams2',
  'com.apple.WebKit.GPU': 'com.apple.Safari',
  'io.aircall.phone.helper': 'io.aircall.phone',
  'io.aircall.workspace.helper': 'io.aircall.phone',
  'com.apple.avconferenced': 'com.apple.FaceTime',
  'com.microsoft.edgemac.helper': 'com.microsoft.edgemac',
  'com.brave.Browser.helper': 'com.brave.Browser',
  'net.imput.helium.helper': 'net.imput.helium',
  'ai.perplexity.comet.helper': 'ai.perplexity.comet',
  'com.hnc.Discord.helper.Renderer': 'com.hnc.Discord',
  'com.vivaldi.Vivaldi.helper': 'com.vivaldi.Vivaldi',
  'com.openai.atlas.web.helper': 'com.openai.atlas',
  'com.electron.dialpad.helper': 'com.electron.dialpad',
  'com.electron.uberconference.helper': 'com.electron.uberconference',
  'com.gather.Gather.helper': 'com.gather.Gather',
  'com.gather.GatherV2.helper': 'com.gather.GatherV2',
  'com.operasoftware.Opera.helper': 'com.operasoftware.Opera',
  'com.clickup.desktop-app.helper': 'com.clickup.desktop-app',
  'com.larksuite.larkApp.helper': 'com.larksuite.larkApp'
}

/** Windows executable basenames (lower-case) → app ids. */
const WINDOWS_EXES: Record<string, string> = {
  'chrome.exe': 'com.google.Chrome',
  'firefox.exe': 'org.mozilla.firefox',
  'zoom.exe': 'us.zoom.xos',
  'slack.exe': 'com.tinyspeck.slackmacgap',
  'arc.exe': 'company.thebrowser.Browser',
  'webex.exe': 'com.cisco.webexmeetingsapp',
  'ms-teams.exe': 'com.microsoft.teams2',
  'msteamsvdi.exe': 'com.microsoft.teams2',
  'teams.exe': 'com.microsoft.teams2',
  'safari.exe': 'com.apple.Safari',
  'whatsapp.exe': 'net.whatsapp.WhatsApp',
  'whatsapp.root.exe': 'net.whatsapp.WhatsApp',
  '8x8 work.exe': 'com.electron.8x8---virtual-office',
  'aircall.exe': 'io.aircall.phone',
  'aircall workspace.exe': 'io.aircall.phone',
  'msedge.exe': 'com.microsoft.edgemac',
  'voovmeetingapp.exe': 'com.tencent.tencentmeeting',
  'tuple.exe': 'app.tuple.app',
  'brave.exe': 'com.brave.Browser',
  'discord.exe': 'com.hnc.Discord',
  'comet.exe': 'ai.perplexity.comet',
  'vivaldi.exe': 'com.vivaldi.Vivaldi',
  'zen.exe': 'app.zen-browser.zen',
  'dialpad.exe': 'com.electron.dialpad',
  'dialpadmeetings.exe': 'com.electron.uberconference',
  'gather.exe': 'com.gather.Gather',
  'gatherv2.exe': 'com.gather.GatherV2',
  'opera.exe': 'com.operasoftware.Opera',
  'clickup.exe': 'com.clickup.desktop-app',
  'lark.exe': 'com.larksuite.larkApp'
}

/** Windows packaged app families (consent-store subkeys) → app ids. */
const WINDOWS_PACKAGES: Record<string, string> = {
  MSTeams_8wekyb3d8bbwe: 'com.microsoft.teams2',
  MicrosoftTeams_8wekyb3d8bbwe: 'com.microsoft.teams2'
}

/** The consent store names a desktop app by its path with `#` for `\`. */
function consentKeyOf(path: string): string {
  return path.replaceAll('\\', '#').toLowerCase()
}

/** Notula's own executable never counts as a meeting app. */
const OWN_EXE = consentKeyOf(process.execPath)

/**
 * Raw ids from the micmon worker → known apps, each once, in report order. Windows
 * ids are `n:<path key>` (desktop) or `p:<package family>`; macOS ids are bundle ids.
 * Unknown ids go to `unknown`.
 */
export function mapRawIds(raw: readonly string[], platform: NodeJS.Platform, unknown: Set<string>): MicApp[] {
  const out: MicApp[] = []
  const seen = new Set<string>()
  const add = (appId: string | undefined, rawId: string): void => {
    const name = appId ? MEETING_APPS[appId] : undefined
    if (!appId || !name) {
      unknown.add(rawId)
      return
    }
    if (seen.has(appId)) return
    seen.add(appId)
    out.push({ appId, name })
  }
  for (const id of raw) {
    if (platform === 'win32') {
      if (id.startsWith('n:')) {
        const key = id.slice(2)
        if (key.toLowerCase() === OWN_EXE) continue
        add(WINDOWS_EXES[basename(key.replaceAll('#', '/')).toLowerCase()], id)
      } else if (id.startsWith('p:')) {
        add(WINDOWS_PACKAGES[id.slice(2)], id)
      }
    } else {
      add(MEETING_APPS[id] ? id : MAC_HELPERS[id], id)
    }
  }
  return out
}

/**
 * The meeting app behind a Windows process, from its exe and its ancestors' (new Teams
 * captures from msedgewebview2.exe under ms-teams.exe). Null when none is a known app.
 */
export function windowsMeetingAppOfExes(exes: readonly string[]): MicApp | null {
  for (const exe of exes) {
    const appId = WINDOWS_EXES[exe.toLowerCase()]
    const name = appId ? MEETING_APPS[appId] : undefined
    if (appId && name) return { appId, name }
  }
  return null
}
