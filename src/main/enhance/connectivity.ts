// SPDX-License-Identifier: Apache-2.0
// Waiting for the network after a wake: for a cloud LLM, up to 100 probes of the
// configured provider's host, each with a 3 s timeout, 1 s apart and growing ×1.5 up
// to 10 s. Any HTTP answer counts as online. A local model needs no network.

import { net } from 'electron'
import type { MainContext } from '../context'
import { log } from '../log'

const ATTEMPTS = 100
const PROBE_TIMEOUT_MS = 3_000
const FIRST_DELAY_MS = 1_000
const BACKOFF = 1.5
const MAX_DELAY_MS = 10_000
const ANTHROPIC_HOST = 'https://api.anthropic.com'

function originOf(url: string): string | null {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin : null
  } catch {
    return null
  }
}

async function probe(origin: string): Promise<boolean> {
  try {
    await net.fetch(origin, { method: 'HEAD', signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
    return true
  } catch {
    return false
  }
}

/**
 * Resolves true once the provider's host answers (at once for a local model), false
 * after the last attempt or when `cancelled()` turns true between attempts.
 */
export async function waitForProviderHost(ctx: MainContext, cancelled: () => boolean): Promise<boolean> {
  const settings = await ctx.settings.getAll()
  const provider = settings['llm.provider']
  if (provider === 'local') return true
  const origin = provider === 'anthropic' ? ANTHROPIC_HOST : originOf(settings['llm.openai.baseUrl'])
  if (!origin) return true
  let delay = FIRST_DELAY_MS
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    if (cancelled()) return false
    if (await probe(origin)) {
      if (attempt > 1) log('info', 'enhance:provider-reachable', { attempts: attempt })
      return true
    }
    await new Promise((r) => setTimeout(r, delay))
    delay = Math.min(MAX_DELAY_MS, delay * BACKOFF)
  }
  log('warn', 'enhance:provider-unreachable', { attempts: ATTEMPTS })
  return false
}
