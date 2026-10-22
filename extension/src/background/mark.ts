// SPDX-License-Identifier: Apache-2.0
// Mark this moment: the `mark-moment` command (Alt+Shift+M) or the popup
// button. Picks the active tab if it has media, else the tab that played last, reads its position
// fresh from the player's frame, and sends `mark`. Notula appends the stamped paragraph; the
// extension only shows the answer on its badge and in the popup.

import type { ExtMarkAck } from '../lib/protocol'
import { parseContentMessage, type PopupState } from '../lib/messages'
import { bridge, ensureConnected, send } from './bridge'
import { getTab, lastPosition, latestPlaying, mediaFrameId, tabAllowed, type TabEntry } from './tabs'

const READY_WAIT_MS = 7_000
const ACK_WAIT_MS = 5_000
const BADGE_OK_MS = 2_000
const BADGE_FAIL_MS = 5_000

let waiting: ((ack: ExtMarkAck | null) => void) | null = null
let lastMark: PopupState['lastMark'] = null
let badgeTimer: ReturnType<typeof setTimeout> | null = null

export function getLastMark(): PopupState['lastMark'] {
  return lastMark
}

export function onMarkAck(ack: ExtMarkAck): void {
  waiting?.(ack)
  waiting = null
}

async function badge(text: string, color: string, ms: number): Promise<void> {
  if (badgeTimer) clearTimeout(badgeTimer)
  await chrome.action.setBadgeBackgroundColor({ color }).catch(() => undefined)
  await chrome.action.setBadgeText({ text }).catch(() => undefined)
  badgeTimer = setTimeout(() => void chrome.action.setBadgeText({ text: '' }).catch(() => undefined), ms)
}

function hasMedia(e: TabEntry | undefined): e is TabEntry {
  return !!e && tabAllowed(e) && lastPosition(e) !== null
}

/** The player's own position now, asked from its frame; the last report as a fallback. */
async function freshPosition(e: TabEntry): Promise<number | null> {
  try {
    const reply = await chrome.tabs.sendMessage(e.tabId, { k: 'snapshot' }, { frameId: mediaFrameId(e) })
    const r = parseContentMessage(reply)
    if (r?.k === 'report' && r.media) return r.media.current_time
  } catch {
    // The frame went away; use what we have.
  }
  return lastPosition(e)
}

function waitReady(): Promise<boolean> {
  return new Promise((resolve) => {
    const started = Date.now()
    const tick = (): void => {
      if (bridge.ready) return resolve(true)
      const c = bridge.connection
      if (c !== 'connecting' && c !== 'idle' && c !== 'connected') return resolve(false)
      if (Date.now() - started > READY_WAIT_MS) return resolve(false)
      setTimeout(tick, 100)
    }
    tick()
  })
}

export async function markMoment(): Promise<void> {
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => [])
  let e: TabEntry | undefined = active?.id !== undefined ? getTab(active.id) : undefined
  if (!hasMedia(e)) e = latestPlaying() ?? undefined
  const position = hasMedia(e) ? await freshPosition(e) : null

  await ensureConnected('mark')
  if (!(await waitReady())) {
    lastMark = { ok: false, position: null, reason: bridge.connection, at: Date.now() }
    await badge('!', '#B45309', BADGE_FAIL_MS)
    return
  }

  waiting?.(null)
  const ack = await new Promise<ExtMarkAck | null>((resolve) => {
    waiting = resolve
    const sent = send({
      type: 'mark',
      tab: e && position !== null ? e.key : null,
      current_time: position,
      observed_at: Date.now()
    })
    if (!sent) resolve(null)
    setTimeout(() => resolve(null), ACK_WAIT_MS)
  })
  waiting = null
  lastMark = ack
    ? { ok: ack.ok, position: ack.position, reason: ack.reason, at: Date.now() }
    : { ok: false, position: null, reason: 'no-answer', at: Date.now() }
  if (ack?.ok) await badge('✓', '#15803D', BADGE_OK_MS)
  else await badge('!', '#B45309', BADGE_FAIL_MS)
}
