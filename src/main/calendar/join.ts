// SPDX-License-Identifier: Apache-2.0
// Joining a call: the protocol allow-list,
// the `<…>` strip, the Zoom app preference (cached 10 min), and `shell.openExternal`
// only, never inside a window. Logs carry the host, never the link (it may hold a passcode).

import { app, shell } from 'electron'
import { zoomAppUrl } from '@shared/lib/conference'
import { CALENDAR_SYNC } from '@shared/types/calendar'
import { log } from '../log'

const ALLOWED = new Set(['http:', 'https:', 'zoommtg:'])

let zoomCheck: { at: number; installed: boolean } | null = null

/** Windows: the `zoommtg` URL class; macOS: the Zoom bundle. Both through Electron. */
function zoomInstalled(): boolean {
  if (zoomCheck && Date.now() - zoomCheck.at < CALENDAR_SYNC.zoomAppCacheMs) return zoomCheck.installed
  let installed = false
  try {
    installed = app.getApplicationNameForProtocol('zoommtg://').trim().length > 0
  } catch {
    installed = false
  }
  zoomCheck = { at: Date.now(), installed }
  return installed
}

async function open(url: string, what: string): Promise<boolean> {
  try {
    await shell.openExternal(url)
    return true
  } catch {
    log('warn', 'calendar:join-open-failed', { what })
    return false
  }
}

/** The `calendar:join` routine: resolves whether a link was opened. */
export async function joinCall(raw: unknown): Promise<boolean> {
  if (typeof raw !== 'string') return false
  let text = raw.trim()
  if (text.startsWith('<') && text.endsWith('>')) text = text.slice(1, -1).trim()
  let u: URL
  try {
    u = new URL(text)
  } catch {
    log('warn', 'calendar:join-rejected', { reason: 'unparseable' })
    return false
  }
  if (!ALLOWED.has(u.protocol)) {
    log('warn', 'calendar:join-rejected', { reason: 'protocol', protocol: u.protocol.slice(0, 20) })
    return false
  }
  const host = u.hostname.toLowerCase()
  if (u.protocol === 'zoommtg:') return open(u.toString(), 'zoom-app')
  const zoom = zoomAppUrl(u.toString())
  if (zoom && zoomInstalled()) {
    if (await open(zoom, 'zoom-app')) {
      log('info', 'calendar:joined', { via: 'zoom-app' })
      return true
    }
  }
  const opened = await open(u.toString(), 'browser')
  if (opened) log('info', 'calendar:joined', { via: 'browser', host })
  return opened
}
