// SPDX-License-Identifier: Apache-2.0
// The local URL safety check for MCP servers, enforced in
// main on every connect and on every redirect, failing closed.
//
// - `https` is required, except plain `http` to a loopback host (local servers).
// - Always refused: the metadata hosts, link-local, unspecified, broadcast, multicast and
//   reserved ranges (including IPv4-mapped IPv6, normalised to IPv4).
// - Private ranges pass only with the connection's "on my local network" box.
// - Names resolve through the OS resolver, A and AAAA; every address must pass.

import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { MCP_BLOCKED_HOSTS } from '@shared/types/mcp'

export class UrlRefused extends Error {
  constructor(readonly detail: string) {
    super('Notula can’t use this URL.')
    this.name = 'UrlRefused'
  }
}

type Range = 'loopback' | 'private' | 'public' | 'refused'

function v4Parts(ip: string): number[] {
  return ip.split('.').map((p) => Number(p))
}

function classifyV4(ip: string): Range {
  const [a = 0, b = 0, c = 0] = v4Parts(ip)
  if (a === 127) return 'loopback'
  if (a === 0) return 'refused' // unspecified / "this network"
  if (a === 10) return 'private'
  if (a === 172 && b >= 16 && b <= 31) return 'private'
  if (a === 192 && b === 168) return 'private'
  if (a === 100 && b >= 64 && b <= 127) return 'private'
  if (a === 169 && b === 254) return 'refused' // link-local, cloud metadata
  if (a >= 224) return 'refused' // multicast, reserved, broadcast
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return 'refused'
  if (a === 198 && (b === 18 || b === 19)) return 'refused'
  if (a === 198 && b === 51 && c === 100) return 'refused'
  if (a === 203 && b === 0 && c === 113) return 'refused'
  return 'public'
}

function expandV6(ip: string): number[] | null {
  let s = ip.toLowerCase()
  const zone = s.indexOf('%')
  if (zone >= 0) s = s.slice(0, zone)
  // A trailing dotted quad (IPv4-mapped or compatible).
  const m = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(s)
  if (m) {
    const [a = 0, b = 0, c = 0, d = 0] = v4Parts(m[2]!)
    s = `${m[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
  }
  const halves = s.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0
  const parts = [...head, ...Array(Math.max(0, fill)).fill('0'), ...tail]
  if (parts.length !== 8) return null
  const out = parts.map((p) => parseInt(p, 16))
  return out.some((n) => !Number.isFinite(n) || n < 0 || n > 0xffff) ? null : out
}

function classifyV6(ip: string): Range {
  const w = expandV6(ip)
  if (!w) return 'refused'
  const [w0 = 0, , , , , w5 = 0, w6 = 0, w7 = 0] = w
  const zeroTo = (n: number): boolean => w.slice(0, n).every((x) => x === 0)
  if (zeroTo(8)) return 'refused' // ::
  if (zeroTo(7) && w7 === 1) return 'loopback' // ::1
  if (zeroTo(5) && w5 === 0xffff) return classifyV4(`${w6 >> 8}.${w6 & 0xff}.${w7 >> 8}.${w7 & 0xff}`)
  if ((w0 & 0xffc0) === 0xfe80) return 'refused' // link-local
  if ((w0 & 0xff00) === 0xff00) return 'refused' // multicast
  if ((w0 & 0xfe00) === 0xfc00) return 'private' // unique local
  if (w0 === 0x2001 && w[1] === 0x0db8) return 'refused' // documentation
  if (zeroTo(1) || (w0 & 0xe000) !== 0x2000) return 'refused' // reserved: only 2000::/3 is global unicast
  return 'public'
}

export function classifyIp(ip: string): Range {
  const v = isIP(ip)
  if (v === 4) return classifyV4(ip)
  if (v === 6) return classifyV6(ip)
  return 'refused'
}

function rangeAllowed(range: Range, allowPrivate: boolean): string | null {
  if (range === 'refused') return 'That address range is never allowed.'
  if (range === 'private' && !allowPrivate) return 'This is a private network address. Tick "This server is on my local network" to allow it.'
  return null
}

/** Throws UrlRefused with a detail line naming the reason. */
export async function checkServerUrl(raw: string, opts: { allowPrivateNetwork: boolean }): Promise<URL> {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new UrlRefused('The URL could not be read.')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new UrlRefused('Only https:// URLs are allowed.')
  if (url.username || url.password) throw new UrlRefused('URLs with a user name or password are not allowed.')
  const host = url.hostname.toLowerCase().replace(/\.+$/, '').replace(/^\[|\]$/g, '')
  if (!host) throw new UrlRefused('The URL has no host.')
  if ((MCP_BLOCKED_HOSTS as readonly string[]).includes(host)) throw new UrlRefused('That host is never allowed.')
  let addresses: string[]
  if (isIP(host)) addresses = [host]
  else if (host === 'localhost') addresses = ['127.0.0.1']
  else {
    try {
      const found = await lookup(host, { all: true, verbatim: true })
      addresses = found.map((a) => a.address)
    } catch {
      throw new UrlRefused(`${host} could not be resolved.`)
    }
    if (!addresses.length) throw new UrlRefused(`${host} could not be resolved.`)
  }
  const ranges = addresses.map(classifyIp)
  for (const r of ranges) {
    const problem = rangeAllowed(r, opts.allowPrivateNetwork)
    if (problem) throw new UrlRefused(problem)
  }
  if (url.protocol === 'http:' && !ranges.every((r) => r === 'loopback')) {
    throw new UrlRefused('Plain http:// is allowed only for servers on this computer. Use https://.')
  }
  return url
}

type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

/**
 * A fetch for the SDK transports: checks the URL before every request and follows up to
 * five redirects by hand, checking each target, so a redirect can never reach a refused
 * address. The check runs right before each request (DNS can change between them).
 */
export function guardedFetch(opts: { allowPrivateNetwork: boolean }): FetchFn {
  return async (input, init) => {
    let url = input instanceof Request ? input.url : String(input)
    let req: RequestInit = { ...(init ?? {}), redirect: 'manual' }
    for (let hop = 0; hop <= 5; hop++) {
      await checkServerUrl(url, opts)
      const res = await fetch(url, req)
      if (res.status < 300 || res.status >= 400 || !res.headers.get('location')) return res
      const next = new URL(res.headers.get('location')!, url).toString()
      // 303, or a 301/302 after a POST, turns into a GET without a body (fetch's own rule).
      const method = (req.method ?? 'GET').toUpperCase()
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
        const { body: _body, ...rest } = req
        req = { ...rest, method: 'GET' }
      }
      // A redirect to another origin drops the bearer token.
      if (new URL(next).origin !== new URL(url).origin) {
        const h = new Headers(req.headers)
        h.delete('authorization')
        req = { ...req, headers: h }
      }
      url = next
    }
    throw new UrlRefused('Too many redirects.')
  }
}
