// SPDX-License-Identifier: Apache-2.0
// Small helpers shared by the automations, Customer calls, webhooks and transcription-rules modules.

import { notulaError } from '@shared/errors'
import type { MainContext } from '../context'
import { expected } from '../ipc-expected'

export const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
export const bad = (m: string): Error => expected(notulaError('invalid-input', m))

export const HOSTNAME = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/
export const EMAIL = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/

export function domainOf(email: string): string {
  const at = email.lastIndexOf('@')
  return at < 0 ? '' : email.slice(at + 1).trim().toLowerCase()
}

/** A domain list entry: trimmed, a leading `@` removed, lowercased; null unless it looks like a hostname. */
export function normDomain(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const d = v.trim().replace(/^@/, '').toLowerCase()
  return HOSTNAME.test(d) ? d : null
}

export function normEmail(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const e = v.trim().toLowerCase()
  return EMAIL.test(e) && e.length <= 320 ? e : null
}

/** Runs `fn` once storage is ready (now, or on the first `storage:status` ready). */
export function onStorageReady(ctx: MainContext, fn: () => void): void {
  let done = false
  const go = (): void => {
    if (done) return
    done = true
    fn()
  }
  ctx.bus.on('storage:status', (s) => {
    if (s.state === 'ready') go()
  })
  void ctx.storage
    .status()
    .then((s) => {
      if (s.state === 'ready') go()
    })
    .catch(() => undefined)
}

/**
 * The internal domains: `transcriptionRules.internalDomains`,
 * else the user's own non-free-mail domains (profile and OAuth accounts).
 */
export async function internalDomains(ctx: MainContext): Promise<string[]> {
  const listed = await ctx.settings.get('transcriptionRules.internalDomains')
  if (listed.length) return listed
  return ownDomains(ctx)
}

/** The domains of "my emails", without free-mail domains. */
export async function ownDomains(ctx: MainContext): Promise<string[]> {
  const [mine, generic] = await Promise.all([ctx.calendar.myEmails().catch(() => [] as string[]), ctx.settings.get('people.genericEmailDomains').catch(() => [] as string[])])
  const free = new Set(generic.map((d) => d.toLowerCase()))
  return [...new Set(mine.map(domainOf).filter((d) => d && !free.has(d)))]
}

export function underDomain(domain: string, list: readonly string[]): boolean {
  return list.some((x) => domain === x || domain.endsWith(`.${x}`))
}
