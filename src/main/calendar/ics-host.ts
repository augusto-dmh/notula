// SPDX-License-Identifier: Apache-2.0
/// <reference types="electron-vite/node" />
// The notula-ics utility process, seen from main. ICS parsing and
// recurrence expansion run there, never on main: a feed of a few MB with old recurring
// series, or with TZIDs the feed doesn't define, used to block main for seconds to
// minutes, stalling the capture audio relay and every IPC.
//
// One process, forked on the first parse and ended after a minute idle. Parses run one at
// a time, in order. A parse that outlives its budget kills the process and fails as
// `invalid_feed`, so the refresh deletes nothing.

import { utilityProcess, type UtilityProcess } from 'electron'
import icsWorkerPath from './ics-worker?modulePath'
import { log } from '../log'
import { IcsError } from './ics'
import type { ParsedFeed, ParseOptions } from './ics-parse'
import type { IcsParseReply, IcsParseRequest } from './ics-worker'

const PARSE_BUDGET_MS = 20_000
const IDLE_MS = 60_000

let proc: UtilityProcess | null = null
let idleTimer: NodeJS.Timeout | null = null
let nextId = 0
let queue: Promise<unknown> = Promise.resolve()

/** Parses a feed body in the notula-ics process; rejects with an `IcsError` on any failure. */
export function parseIcsOffMain(bytes: Uint8Array, opts: ParseOptions): Promise<ParsedFeed> {
  const run = queue.then(() => parseOne(bytes, opts))
  queue = run.catch(() => undefined)
  return run
}

function spawn(): UtilityProcess {
  const child = utilityProcess.fork(icsWorkerPath, [], { serviceName: 'notula-ics' })
  child.on('exit', (code) => {
    if (proc === child) proc = null
    if (code !== 0) log('warn', 'calendar:ics-process-exited', { code })
  })
  return child
}

function end(child: UtilityProcess): void {
  if (proc === child) proc = null
  child.kill()
}

function parseOne(bytes: Uint8Array, opts: ParseOptions): Promise<ParsedFeed> {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = null
  const child = proc ?? (proc = spawn())
  const id = ++nextId
  const started = Date.now()
  return new Promise<ParsedFeed>((resolve, reject) => {
    const settle = (): void => {
      clearTimeout(budget)
      child.off('message', onMessage)
      child.off('exit', onExit)
      if (proc === child) {
        idleTimer = setTimeout(() => {
          idleTimer = null
          end(child)
        }, IDLE_MS)
        idleTimer.unref?.()
      }
    }
    const budget = setTimeout(() => {
      end(child)
      settle()
      log('warn', 'calendar:ics-parse-over-budget', { ms: PARSE_BUDGET_MS, bytes: bytes.byteLength })
      reject(new IcsError('invalid_feed', 'the calendar took too long to read'))
    }, PARSE_BUDGET_MS)
    const onMessage = (reply: IcsParseReply): void => {
      if (reply.id !== id) return
      settle()
      if (reply.ok) {
        for (const w of reply.feed.warnings) log('warn', w.event, w.data)
        log('debug', 'calendar:ics-parsed', { ms: Date.now() - started, bytes: bytes.byteLength, events: reply.feed.events.length })
        resolve(reply.feed)
      } else if (reply.type === 'internal') {
        log('warn', 'calendar:ics-parse-failed', { error: reply.reason })
        reject(new IcsError('invalid_feed', 'the calendar could not be read'))
      } else {
        reject(new IcsError(reply.type, reply.reason))
      }
    }
    const onExit = (code: number): void => {
      settle()
      reject(new IcsError('invalid_feed', code === 0 ? 'the calendar could not be read' : 'the calendar is too large to read'))
    }
    child.on('message', onMessage)
    child.on('exit', onExit)
    child.postMessage({
      id,
      bytes,
      sourceId: opts.sourceId,
      calendarId: opts.calendarId,
      myEmails: [...opts.myEmails],
      window: opts.window
    } satisfies IcsParseRequest)
  })
}
