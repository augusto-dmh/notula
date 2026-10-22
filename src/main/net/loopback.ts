// SPDX-License-Identifier: Apache-2.0
// Loopback tests shared by privacy.ts and the egress layer. Kept apart from
// egress.ts so privacy.ts can use them without an import cycle; egress.ts re-exports both.

import { isIP } from 'node:net'

/** True for localhost names and loopback addresses (127.0.0.0/8, ::1 and IPv4-mapped forms). */
export function isLoopbackHost(host: string): boolean {
  let h = host.trim().toLowerCase()
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1)
  if (h.endsWith('.')) h = h.slice(0, -1)
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  if (h === '::1' || h === '0:0:0:0:0:0:0:1') return true
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h)
  if (mapped) h = mapped[1] ?? ''
  return isIP(h) === 4 && h.split('.')[0] === '127'
}

export function isLoopbackUrl(url: string): boolean {
  try {
    return isLoopbackHost(new URL(url).hostname)
  } catch {
    return false
  }
}
