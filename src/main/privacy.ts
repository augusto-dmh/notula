// SPDX-License-Identifier: Apache-2.0
// The local-only guard.
//
// Every call that leaves the machine first awaits `egressBlocked(ctx, target)` and, when it is
// blocked, does nothing and logs LOCAL_ONLY_REASON. Newer code goes through `egressFetch` /
// `assertEgress` (net/egress.ts), which call this. The guard is off unless `privacy.localOnly`
// is on; the user-facing switch is `privacy:set-local-only`.

import type { AsrProviderId } from '@shared/types/transcript'
import type { MainContext } from './context'
import { isLoopbackUrl } from './net/loopback'

export type EgressKind =
  | 'llm'
  | 'asr'
  | 'integration'
  | 'mcp-server'
  | 'favicon'
  | 'gravatar'
  | 'calendar'
  | 'update'
  | 'model-download'
  | 'mcp-client'
  | 'diagnostics'
  | 'handoff'
  | 'local-api'
  // Content sources: oEmbed and yt-dlp search and metadata; video captions; the yt-dlp download
  // and updates. Checked before spawning yt-dlp, since the socket guard doesn't cover children.
  | 'source-lookup'
  | 'source-captions'
  | 'source-tools'

export type EgressTarget =
  | { kind: 'llm' }
  | { kind: 'asr'; provider: AsrProviderId }
  | { kind: Exclude<EgressKind, 'llm' | 'asr'> }

export const LOCAL_ONLY_REASON = 'local-only mode'

/**
 * False unless `privacy.localOnly` is on. Then: an LLM call is blocked unless `llm.provider` is
 * `local` and `llm.local.baseUrl`'s host is loopback; an ASR call unless its provider is
 * `local`; every other kind always.
 */
export async function egressBlocked(ctx: Pick<MainContext, 'settings'>, target: EgressTarget): Promise<boolean> {
  if (!(await ctx.settings.get('privacy.localOnly'))) return false
  switch (target.kind) {
    case 'llm':
      return (await ctx.settings.get('llm.provider')) !== 'local' || !isLoopbackUrl(await ctx.settings.get('llm.local.baseUrl'))
    case 'asr':
      return target.provider !== 'local'
    default:
      return true
  }
}

let localOnlyCache = false

/** The synchronous view of `privacy.localOnly` (the socket guard and the request filter). */
export function isLocalOnly(): boolean {
  return localOnlyCache
}

/** index.ts only: at start-up and on every `settings:changed` that carries `privacy.localOnly`. */
export function setLocalOnlyCache(on: boolean): void {
  localOnlyCache = on
}
