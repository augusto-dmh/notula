// SPDX-License-Identifier: Apache-2.0
// The notula-convert process, seen from main. Forked on demand with a
// 1 GB heap, ended after 60 s idle. Each request gets 60 s; one that outlives it kills
// the process (a stuck PDF must not hold the next file) and fails.

import { join } from 'node:path'
import { utilityProcess, type UtilityProcess } from 'electron'
import { ATTACHMENT_LIMITS } from '@shared/types/attachments'
import { log } from '../log'
import type { ConvertKind, ConvertReply, ConvertRequest } from './convert-protocol'

const IDLE_MS = 60_000

type Pending = { resolve(r: ConvertReply): void; timer: NodeJS.Timeout }

let proc: UtilityProcess | null = null
let idleTimer: NodeJS.Timeout | null = null
let nextId = 0
const pending = new Map<number, Pending>()

function spawn(): UtilityProcess {
  const child = utilityProcess.fork(join(__dirname, 'convert.js'), [], {
    serviceName: 'notula-convert',
    execArgv: ['--max-old-space-size=1024']
  })
  child.on('message', (r: ConvertReply) => {
    const p = pending.get(r.id)
    if (!p) return
    pending.delete(r.id)
    clearTimeout(p.timer)
    p.resolve(r)
    armIdle()
  })
  child.on('exit', (code) => {
    if (proc === child) proc = null
    if (code !== 0) log('warn', 'attachments:convert-process-exited', { code })
    for (const [id, p] of pending) {
      clearTimeout(p.timer)
      p.resolve({ id, ok: false, error: 'The file could not be read.' })
    }
    pending.clear()
  })
  log('info', 'attachments:convert-process-started', { pid: child.pid ?? null })
  return child
}

function armIdle(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = null
  if (pending.size > 0) return
  idleTimer = setTimeout(() => {
    idleTimer = null
    if (pending.size === 0 && proc) {
      proc.kill()
      proc = null
    }
  }, IDLE_MS)
}

type Unsent = ConvertRequest extends infer R ? (R extends ConvertRequest ? Omit<R, 'id'> : never) : never

function send(req: Unsent): Promise<ConvertReply> {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = null
  proc ??= spawn()
  const child = proc
  const id = ++nextId
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      log('warn', 'attachments:convert-timeout', { op: req.op })
      if (proc === child) {
        proc = null
        child.kill()
      }
      resolve({ id, ok: false, error: 'Reading the file took too long.' })
    }, ATTACHMENT_LIMITS.convertTimeoutMs)
    pending.set(id, { resolve, timer })
    child.postMessage({ ...req, id } as ConvertRequest)
  })
}

/** A PDF's page count, or an error message. */
export async function pdfPageCount(bytes: Uint8Array): Promise<{ ok: true; pages: number } | { ok: false; error: string }> {
  const r = await send({ op: 'pdf-pages', bytes })
  return r.ok && typeof r.pageCount === 'number' ? { ok: true, pages: r.pageCount } : { ok: false, error: r.ok ? 'no page count' : r.error }
}

/** The file's markdown, or an error message (shown as `File rejected: <error>`). */
export async function convertToMarkdown(
  kind: ConvertKind,
  name: string,
  bytes: Uint8Array
): Promise<{ ok: true; markdown: string; pageCount: number | null } | { ok: false; error: string }> {
  const r = await send({ op: 'convert', kind, name, bytes, sheetMaxRows: ATTACHMENT_LIMITS.sheetMaxRows })
  if (!r.ok) return { ok: false, error: r.error }
  return { ok: true, markdown: r.markdown ?? '', pageCount: typeof r.pageCount === 'number' ? r.pageCount : null }
}

/** At quit: nothing is lost (conversions are recomputed on demand). */
export function stopConvertProcess(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = null
  proc?.kill()
  proc = null
}
