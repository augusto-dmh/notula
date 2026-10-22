// SPDX-License-Identifier: Apache-2.0
// The interception rule for both LLM clients: a 2xx response whose content type is
// `text/html` is a captive portal,
// a filtering proxy or a TLS-inspecting gateway answering for the API host, never the API.

import { log } from '../log'

export class LlmInterceptedError extends Error {
  constructor(readonly host: string) {
    super(`${host} sent a web page, not an AI response. Check the URL or any network filter.`)
    this.name = 'LlmInterceptedError'
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return 'The AI provider'
  }
}

/** Throws LlmInterceptedError (and logs the host only) for a 2xx `text/html` response. */
export function checkIntercepted(res: Response, url: string): void {
  if (!res.ok) return
  const type = res.headers.get('content-type') ?? ''
  if (!/^\s*text\/html\b/i.test(type)) return
  const host = hostOf(res.url || url)
  log('warn', 'llm:network-intercepted', { host })
  throw new LlmInterceptedError(host)
}

/** A `fetch` that applies the rule; the Anthropic SDK takes it as its `fetch` option. */
export const interceptingFetch: typeof fetch = async (input, init) => {
  const res = await fetch(input, init)
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  checkIntercepted(res, url)
  return res
}
