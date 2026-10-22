// SPDX-License-Identifier: Apache-2.0
// The notula-ics utility process entry. It decodes, parses and
// expands one ICS feed per request, so that work never runs on main, which relays
// capture audio and drives the ASR sockets. No network, no storage: bytes in,
// mapped events out. Main forks it on demand (ics-host.ts) and ends it when idle.

import { IcsError } from './ics'
import { parseIcs, type ParsedFeed } from './ics-parse'

/** main → worker. */
export interface IcsParseRequest {
  id: number
  bytes: Uint8Array
  sourceId: string
  calendarId: string
  myEmails: string[]
  window: { fromMs: number; toMs: number }
}

/** worker → main. `reason` of an internal failure never quotes feed content. */
export type IcsParseReply =
  | { id: number; ok: true; feed: ParsedFeed }
  | { id: number; ok: false; type: IcsError['type'] | 'internal'; reason: string }

const port = process.parentPort

port.on('message', (e: { data: IcsParseRequest }) => {
  const req = e.data
  let reply: IcsParseReply
  try {
    const text = new TextDecoder('utf-8').decode(req.bytes)
    const feed = parseIcs(text, {
      sourceId: req.sourceId,
      calendarId: req.calendarId,
      myEmails: new Set(req.myEmails),
      window: req.window
    })
    reply = { id: req.id, ok: true, feed }
  } catch (err) {
    reply =
      err instanceof IcsError
        ? { id: req.id, ok: false, type: err.type, reason: err.reason }
        : { id: req.id, ok: false, type: 'internal', reason: err instanceof Error ? err.name : 'error' }
  }
  port.postMessage(reply)
})
