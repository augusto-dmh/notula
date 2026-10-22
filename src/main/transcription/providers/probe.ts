// SPDX-License-Identifier: Apache-2.0
// `asr:test`: one connection attempt with the stored key, closed at once. Errors
// carry the HTTP status or the socket message, never the key.

import WebSocket from 'ws'
import { log } from '../../log'

const PROBE_TIMEOUT_MS = 8_000

export function probeSocket(opts: {
  name: string
  url: string
  headers: Record<string, string> | null
  extraHeaders?: Record<string, string>
  goodbye: unknown
}): Promise<{ ok: boolean; error?: string }> {
  if (!opts.headers) return Promise.resolve({ ok: false, error: 'No key is set for this provider.' })
  return new Promise((resolve) => {
    let settled = false
    const ws = new WebSocket(opts.url, {
      headers: { ...opts.headers, ...opts.extraHeaders },
      handshakeTimeout: PROBE_TIMEOUT_MS
    })
    const finish = (r: { ok: boolean; error?: string }): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      log(r.ok ? 'info' : 'warn', 'asr:test', { provider: opts.name, ok: r.ok, error: r.error ?? '' })
      resolve(r)
    }
    const timer = setTimeout(() => {
      ws.terminate()
      finish({ ok: false, error: 'The provider did not answer in time.' })
    }, PROBE_TIMEOUT_MS)
    ws.on('unexpected-response', (_req, res) => {
      const status = res.statusCode ?? 0
      res.resume()
      ws.terminate()
      finish({
        ok: false,
        error: status === 401 || status === 403 ? `The provider refused the key (HTTP ${status}).` : `HTTP ${status}`
      })
    })
    ws.on('open', () => {
      ws.send(JSON.stringify(opts.goodbye))
      setTimeout(() => ws.close(1000), 200)
      finish({ ok: true })
    })
    ws.on('close', (code, reason) => {
      if (!settled) finish({ ok: false, error: reason.toString('utf8') || `Closed with code ${code}.` })
    })
    ws.on('error', (err) => finish({ ok: false, error: err.message }))
  })
}
