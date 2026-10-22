// SPDX-License-Identifier: Apache-2.0
// Network Doctor's layered probes:
// DNS with `dns.lookup`, TLS with Node `tls`, HTTPS through Node fetch or Electron `net`,
// and the WebSocket upgrade through `ws`, the transcription client's own stack. A probe
// never sends audio, and never returns or logs a header value.

import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { connect as tlsConnect, type PeerCertificate } from 'node:tls'
import { net, session } from 'electron'
import WebSocket from 'ws'
import type { NetDoctorOutcome } from '@shared/types/netdoctor'

export interface LayerResult {
  outcome: NetDoctorOutcome
  detail: string | null
  /** For https probes: the HTTP status, when one came back. */
  status?: number
}

/** A promise that rejects with `timeout` after `ms`, or on `signal`. */
function withTimeout<T>(p: Promise<T>, ms: number, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new Error('cancelled'))
    }
    if (signal.aborted) onAbort()
    signal.addEventListener('abort', onAbort, { once: true })
    p.then(
      (v) => {
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        resolve(v)
      },
      (err: unknown) => {
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        reject(err)
      }
    )
  })
}

// ---------- addresses ----------

function privateV4(a: string): boolean {
  const p = a.split('.').map(Number)
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false
  const [o1, o2, o3] = p as [number, number, number, number]
  return (
    o1 === 0 ||
    o1 === 10 ||
    o1 === 127 ||
    (o1 === 100 && o2 >= 64 && o2 <= 127) ||
    (o1 === 169 && o2 === 254) ||
    (o1 === 172 && o2 >= 16 && o2 <= 31) ||
    (o1 === 192 && o2 === 0 && o3 === 0) ||
    (o1 === 192 && o2 === 0 && o3 === 2) ||
    (o1 === 192 && o2 === 168) ||
    (o1 === 198 && (o2 === 18 || o2 === 19)) ||
    (o1 === 198 && o2 === 51 && o3 === 100) ||
    (o1 === 203 && o2 === 0 && o3 === 113) ||
    o1 >= 224
  )
}

/** The non-public address ranges. */
export function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 4) return privateV4(address)
  const a = address.toLowerCase()
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a)
  if (mapped) return privateV4(mapped[1]!)
  return (
    a === '::' ||
    a === '::1' ||
    a.startsWith('fc') ||
    a.startsWith('fd') ||
    /^fe[89ab]/.test(a) ||
    a.startsWith('ff') ||
    a.startsWith('2001:db8:')
  )
}

// ---------- DNS ----------

export async function probeDns(
  host: string,
  opts: { timeoutMs: number; signal: AbortSignal; privateExpected: boolean; family?: 4 }
): Promise<LayerResult & { addresses: string[]; allPrivate: boolean }> {
  try {
    const answers = await withTimeout(lookup(host, { all: true, ...(opts.family ? { family: opts.family } : {}) }), opts.timeoutMs, opts.signal)
    const addresses = answers.map((a) => a.address)
    const allPrivate = addresses.length > 0 && addresses.every(isPrivateAddress)
    if (allPrivate && !opts.privateExpected) {
      return { outcome: 'dns_private_address', detail: 'Every answer was a private address.', addresses, allPrivate }
    }
    return {
      outcome: 'reachable',
      detail: allPrivate ? 'private address (expected for a local endpoint)' : null,
      addresses,
      allPrivate
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (message === 'cancelled') throw err
    return { outcome: message === 'timeout' ? 'dns_timeout' : 'dns_failed', detail: shortError(err), addresses: [], allPrivate: false }
  }
}

// ---------- TLS ----------

export interface TlsResult extends LayerResult {
  /** Set when the certificate is present but not trusted by Node's store. */
  untrustedIssuer: string | null
  protocol: string | null
}

function issuerName(cert: PeerCertificate | undefined): string {
  const issuer = cert?.issuer as { O?: string | string[]; CN?: string | string[] } | undefined
  const pick = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v)
  return pick(issuer?.O) ?? pick(issuer?.CN) ?? 'an unrecognized certificate authority'
}

export function probeTls(host: string, port: number, opts: { timeoutMs: number; signal: AbortSignal }): Promise<TlsResult> {
  return new Promise((resolve, reject) => {
    let settled = false
    const socket = tlsConnect({
      host,
      port,
      ...(isIP(host) ? {} : { servername: host }),
      rejectUnauthorized: false,
      ALPNProtocols: ['http/1.1']
    })
    const finish = (r: TlsResult | Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      opts.signal.removeEventListener('abort', onAbort)
      socket.destroy()
      if (r instanceof Error) reject(r)
      else resolve(r)
    }
    const onAbort = (): void => finish(new Error('cancelled'))
    opts.signal.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(
      () => finish({ outcome: 'connection_timeout', detail: 'The TLS handshake timed out.', untrustedIssuer: null, protocol: null }),
      opts.timeoutMs
    )
    socket.once('secureConnect', () => {
      const cert = socket.getPeerCertificate()
      const present = !!cert && Object.keys(cert).length > 0
      finish({
        outcome: 'reachable',
        detail: null,
        untrustedIssuer: present && !socket.authorized ? issuerName(cert) : null,
        protocol: socket.getProtocol()
      })
    })
    socket.once('error', (err) => finish({ ...classifyError(err), untrustedIssuer: null, protocol: null }))
  })
}

// ---------- errors ----------

function errorText(err: unknown): string {
  const parts: string[] = []
  let e: unknown = err
  for (let i = 0; i < 3 && e; i++) {
    if (e instanceof Error) {
      parts.push(e.message)
      const code = (e as { code?: unknown }).code
      if (typeof code === 'string') parts.push(code)
      e = (e as { cause?: unknown }).cause
    } else {
      parts.push(String(e))
      break
    }
  }
  return parts.join(' ')
}

export function shortError(err: unknown): string {
  return errorText(err).slice(0, 200)
}

/** Certificate errors are TLS, name errors DNS, the rest TCP. */
export function classifyError(err: unknown): LayerResult {
  const text = errorText(err)
  if (/cert|ssl|tls|self[- ]signed|unable to verify|issuer|ERR_CERT|handshake failure/i.test(text) && !/timed? ?out/i.test(text)) {
    return { outcome: 'tls_untrusted', detail: shortError(err) }
  }
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo|NAME_NOT_RESOLVED|ERR_NAME/i.test(text)) return { outcome: 'dns_failed', detail: shortError(err) }
  if (/timeout|timed out|ETIMEDOUT|ERR_TIMED_OUT|CONNECT_TIMEOUT/i.test(text)) return { outcome: 'connection_timeout', detail: shortError(err) }
  return { outcome: 'connection_failed', detail: shortError(err) }
}

// ---------- HTTPS ----------

export type HttpsExpect = 'llm' | 'file' | 'feed'

/** One request through the chosen stack; the response body is never read. */
export async function probeHttps(
  url: string,
  opts: {
    stack: 'node' | 'electron-net'
    method: 'GET' | 'HEAD'
    headers: Record<string, string>
    expect: HttpsExpect
    timeoutMs: number
    signal: AbortSignal
  }
): Promise<LayerResult> {
  const signal = AbortSignal.any([opts.signal, AbortSignal.timeout(opts.timeoutMs)])
  let res: Response
  try {
    const init: RequestInit = { method: opts.method, headers: opts.headers, redirect: 'follow', cache: 'no-store', signal }
    res = opts.stack === 'electron-net' ? await net.fetch(url, init) : await fetch(url, init)
  } catch (err) {
    if (opts.signal.aborted) throw new Error('cancelled')
    if (signal.aborted) return { outcome: 'connection_timeout', detail: 'The request timed out.' }
    return classifyError(err)
  }
  void res.body?.cancel().catch(() => undefined)
  const type = (res.headers.get('content-type') ?? '').toLowerCase()
  const html = type.includes('text/html')
  const status = res.status
  if (res.ok && html) {
    // A web page came back where the API was expected (a captive portal or filter).
    return { outcome: 'intercepted', detail: `${new URL(res.url || url).host} sent a web page, maybe a Wi-Fi login or filter`, status }
  }
  if (opts.expect === 'llm' && (status === 401 || status === 403)) return { outcome: 'access_denied', detail: `HTTP ${status}`, status }
  if (html) return { outcome: 'unexpected_html', detail: `HTTP ${status} with a web page`, status }
  const okStatus = opts.expect === 'file' ? status === 200 : res.ok
  if (!okStatus) return { outcome: 'unexpected_response', detail: `HTTP ${status}`, status }
  return { outcome: 'reachable', detail: `HTTP ${status}`, status }
}

// ---------- WebSocket ----------

export function probeWebSocket(
  url: string,
  opts: {
    headers: Record<string, string>
    fingerprintHeader: string | null
    goodbye: unknown
    timeoutMs: number
    stableMs: number
    signal: AbortSignal
  }
): Promise<LayerResult> {
  return new Promise((resolve, reject) => {
    let settled = false
    let opened = false
    let stableTimer: NodeJS.Timeout | null = null
    const ws = new WebSocket(url, { headers: opts.headers, handshakeTimeout: opts.timeoutMs, followRedirects: false })
    const finish = (r: LayerResult | Error): void => {
      if (settled) return
      settled = true
      if (stableTimer) clearTimeout(stableTimer)
      opts.signal.removeEventListener('abort', onAbort)
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify(opts.goodbye))
        } catch {
          // closing anyway
        }
        ws.close(1000)
        setTimeout(() => ws.terminate(), 500)
      } else {
        ws.terminate()
      }
      if (r instanceof Error) reject(r)
      else resolve(r)
    }
    const onAbort = (): void => finish(new Error('cancelled'))
    opts.signal.addEventListener('abort', onAbort, { once: true })

    ws.on('unexpected-response', (_req, res) => {
      const status = res.statusCode ?? 0
      const type = String(res.headers['content-type'] ?? '').toLowerCase()
      const fingerprint = opts.fingerprintHeader ? res.headers[opts.fingerprintHeader] !== undefined : false
      const dgError = res.headers['dg-error']
      res.resume()
      if (status === 401 || status === 403) {
        finish({ outcome: 'access_denied', detail: `HTTP ${status}${dgError ? `: “${String(dgError).slice(0, 120)}”` : ''}` })
      } else if (status >= 200 && status < 300 && type.includes('text/html')) {
        finish({ outcome: 'intercepted', detail: `${new URL(url).host} sent a web page, maybe a Wi-Fi login or filter` })
      } else if (status >= 400 && type.includes('text/html')) {
        finish({ outcome: 'unexpected_html', detail: `HTTP ${status} with a web page` })
      } else if (status >= 400 && fingerprint) {
        finish({ outcome: 'websocket_refused', detail: `HTTP ${status}${dgError ? `: “${String(dgError).slice(0, 120)}”` : ''}` })
      } else if (status >= 400) {
        finish({ outcome: 'unexpected_response', detail: `HTTP ${status}` })
      } else {
        finish({ outcome: 'websocket_blocked_upgrade', detail: `HTTP ${status}` })
      }
    })
    ws.on('open', () => {
      opened = true
      // Stay open for the 1 s stability window, then close without sending audio.
      stableTimer = setTimeout(() => finish({ outcome: 'websocket_connected', detail: null }), opts.stableMs)
    })
    ws.on('close', (code) => {
      if (!opened) return
      finish(
        code === 1006
          ? { outcome: 'websocket_dropped', detail: 'Closed with code 1006 right after opening.' }
          : { outcome: 'websocket_refused', detail: `Closed by the provider with code ${code}.` }
      )
    })
    ws.on('error', (err) => {
      if (opts.signal.aborted) return finish(new Error('cancelled'))
      const text = errorText(err)
      if (/handshake has timed out/i.test(text)) finish({ outcome: 'connection_timeout', detail: 'The connection timed out.' })
      else finish(classifyError(err))
    })
  })
}

// ---------- proxy ----------

/** `direct`, `proxy` or `unknown` from the session's proxy resolver, within `timeoutMs`. */
export async function proxyRoute(url: string, timeoutMs: number, signal: AbortSignal): Promise<string> {
  try {
    const rule = (await withTimeout(session.defaultSession.resolveProxy(url), timeoutMs, signal)).trim().toUpperCase()
    if (rule === 'DIRECT') return 'direct'
    if (/^(PROXY|HTTPS|SOCKS)/.test(rule)) return 'proxy'
    return 'unknown'
  } catch (err) {
    if (err instanceof Error && err.message === 'cancelled') throw err
    return 'unknown'
  }
}
