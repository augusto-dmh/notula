// SPDX-License-Identifier: Apache-2.0
// Quick ask: the #/quick-ask window, the main
// window's hand-off listener and the Labs row.

import { createElement, useEffect, type JSX } from 'react'
import { navigate } from '../../app/navigation'
import { debugLog } from '../../app/platform'
import { QuickAskLabsRowView } from './QuickAskLabsRow'
import { QuickAskRootView } from './QuickAskRoot'

/** `#/quick-ask`. */
export function QuickAskRoot(): JSX.Element {
  return createElement(QuickAskRootView)
}

/**
 * A new library chat on `/chat` with surface `quick_ask`. The `global`
 * selection is cleared so the send creates a new thread, and the full-screen chat skips
 * its default thread while the question is pending.
 */
function handOff(message: string): void {
  // Loaded lazily, so the panel window's own chunk stays small (the main window has chat loaded already).
  void import('../chat').then(({ askPage, selectThread }) => {
    selectThread('global', null)
    askPage(message, 'quick_ask')
    navigate('/chat')
  })
}

/** Takes the pending message once; null when another call already took it. */
async function take(): Promise<void> {
  try {
    const m = await window.notula.quickAsk.getPending()
    if (m?.message.trim()) handOff(m.message)
  } catch (err) {
    debugLog('quick-ask:take-failed', { err: String(err) })
  }
}

/** App host: takes `quick-ask:send-chat-message` and the pending queue (`quick-ask:get-pending`). */
export function QuickAskListener(): null {
  useEffect(() => {
    // A cold window takes a message submitted before it mounted.
    void take()
    return window.notula.quickAsk.onMessage(() => void take())
  }, [])
  return null
}

/** Settings ▸ Labs: the custom quick-ask row (its shortcut and failure message). */
export function QuickAskLabsRow(): JSX.Element {
  return createElement(QuickAskLabsRowView)
}
