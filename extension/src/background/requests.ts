// SPDX-License-Identifier: Apache-2.0
// Notula's requests about a tab: `captions.request` (in caption order) and `outline.request`.
// Both are answered from the tab's content script; nothing here reaches the network.

import type { ExtCaptionsRequest, ExtCaptionsUnavailable, ExtOutlineRequest } from '../lib/protocol'
import { parseCaptionsReply, parseOutline } from '../lib/messages'
import { bridge, send } from './bridge'
import { count } from './counters'
import { captionsAllowed, findByKey, markAsked, mediaFrameId, onTrack, sendTrack, tabAllowed } from './tabs'

const hints = new Set<number>()

/** Tabs where captions need the player's token: the popup shows its hint. */
export function needsCaptionsHint(tabId: number): boolean {
  return hints.has(tabId)
}

function langMatches(lang: string, wanted: string[]): boolean {
  if (!wanted.length) return true
  const base = lang.toLowerCase().split('-')[0]
  return wanted.some((w) => w.toLowerCase() === lang.toLowerCase() || w.toLowerCase().split('-')[0] === base)
}

export async function onCaptionsRequest(req: ExtCaptionsRequest): Promise<void> {
  const unavailable = (reason: ExtCaptionsUnavailable['reason']): void => {
    send({ type: 'captions-unavailable', tab: req.tab, video: req.video, reason })
  }
  const e = findByKey(req.tab)
  if (!e || !tabAllowed(e) || req.tab !== bridge.feedTab || !captionsAllowed()) return unavailable('policy')
  if (e.video !== req.video) return unavailable('no-track')

  const cached = e.tracks.find((t) => t.video === req.video && langMatches(t.lang, req.langs))
  if (cached) {
    e.tracksSent.delete(`${cached.video}|${cached.lang}|${cached.source}`)
    if (!sendTrack(e, cached)) unavailable('failed')
    return
  }

  const youtube = e.frames.get(0)?.report.adapter === 'youtube'
  let raw: unknown
  try {
    raw = await chrome.tabs.sendMessage(
      e.tabId,
      { k: 'captions', video: req.video, langs: req.langs, replay: bridge.policy.captions_replay },
      { frameId: youtube ? 0 : mediaFrameId(e) }
    )
  } catch {
    return unavailable('failed')
  }
  const reply = parseCaptionsReply(raw)
  if (!reply) {
    count('content:invalid-reply')
    return unavailable('failed')
  }
  if (reply.status === 'unavailable') {
    if (reply.reason === 'token-required') hints.add(e.tabId)
    return unavailable(reply.reason)
  }
  hints.delete(e.tabId)
  const tab = await chrome.tabs.get(e.tabId).catch(() => null)
  if (!tab) return unavailable('failed')
  // onTrack caches it and sends it to the feed tab.
  onTrack(tab, reply.track)
}

export async function onOutlineRequest(req: ExtOutlineRequest): Promise<void> {
  const e = findByKey(req.tab)
  if (!e || !tabAllowed(e) || !bridge.policy.outline) return
  let raw: unknown
  try {
    raw = await chrome.tabs.sendMessage(e.tabId, { k: 'outline' }, { frameId: 0 })
  } catch {
    return
  }
  const items = parseOutline(raw)
  if (!items) {
    count('content:invalid-reply')
    return
  }
  markAsked(e)
  send({ type: 'outline', tab: e.key, items })
}

export function forgetTab(tabId: number): void {
  hints.delete(tabId)
}
