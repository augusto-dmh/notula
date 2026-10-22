// SPDX-License-Identifier: Apache-2.0
// What every provider client implements, and the shared mapping from an HTTP result to
// a delivery outcome (the integrations' request policy).

import type {
  IntegrationDelivery,
  IntegrationProvider,
  IntegrationSearchQuery,
  IntegrationSearchResult,
  IntegrationShareContent,
  IntegrationState
} from '@shared/types/integrations'
import type { Note } from '@shared/types/notes'
import type { MainContext } from '../../context'
import type { IntegrationDestinationRow } from '../../storage/api'
import type { HttpResult } from '../http'

export interface ValidateResult {
  state: Extract<IntegrationState, 'connected' | 'invalid' | 'unreachable'>
  accountLabel: string | null
  detail: string | null
  /** Non-secret facts kept with the credential (Slack team id, Affinity domain). */
  meta?: Record<string, string>
}

export interface SendJob {
  delivery: IntegrationDelivery
  destination: IntegrationDestinationRow | null
  note: Note
  content: IntegrationShareContent
  /** The provider credential (bot token, API key), when the provider has one. */
  credential: string | null
  /** The destination's webhook or hook URL, when it has one. */
  destinationSecret: string | null
  /** Zapier: the include-transcript and event facts the payload needs. */
  test: boolean
}

export type SendOutcome =
  | { ok: true; externalId?: string | null; externalUrl?: string | null }
  | {
      ok: false
      /** `auto`: the scheduler retries (1 min … 2 h); `never`: failed; `uncertain`: shown, never retried. */
      retry: 'auto' | 'never' | 'uncertain'
      code: string
      message: string
      /** Mark the destination `disconnected` (dead webhook, deleted target). */
      disconnect?: boolean
      retryAfterMs?: number
    }

export interface ProviderClient {
  id: IntegrationProvider
  validate(ctx: MainContext, credential: string): Promise<ValidateResult>
  search?(ctx: MainContext, q: IntegrationSearchQuery, credential: string): Promise<IntegrationSearchResult[]>
  send(ctx: MainContext, job: SendJob): Promise<SendOutcome>
}

export interface ProviderCopy {
  network: string
  busy: string
  other: string
  /** Status → copy for the provider's 4xx table. */
  status?: Partial<Record<number, string>>
}

/** The policy's outcome for a failed exchange; provider tables refine the 4xx copy. */
export function failure(r: Exclude<HttpResult, { ok: true }>, copy: ProviderCopy): Extract<SendOutcome, { ok: false }> {
  switch (r.kind) {
    case 'network':
      return { ok: false, retry: 'auto', code: 'network', message: copy.network }
    case 'uncertain':
      return {
        ok: false,
        retry: 'uncertain',
        code: r.code === 'timeout' ? 'timeout' : 'connection-reset',
        message: 'Notula can’t tell whether this arrived. Check, then try again if it’s missing.'
      }
    case 'rate_limited':
      return { ok: false, retry: 'auto', code: 'rate_limited', message: copy.busy, retryAfterMs: r.retryAfterMs }
    case 'http': {
      if (r.status === 429) return { ok: false, retry: 'auto', code: 'rate_limited', message: copy.busy, ...(r.retryAfterMs !== null ? { retryAfterMs: r.retryAfterMs } : {}) }
      if (r.status === 502 || r.status === 503 || r.status === 504) return { ok: false, retry: 'auto', code: `http_${r.status}`, message: copy.network }
      return { ok: false, retry: 'never', code: `http_${r.status}`, message: copy.status?.[r.status] ?? copy.other }
    }
  }
}

/** The validation outcome for an identity call that failed. */
export function validationFailure(r: Exclude<HttpResult, { ok: true }>, invalidCopy: string, unreachableCopy: string): ValidateResult {
  if (r.kind === 'http' && (r.status === 401 || r.status === 403)) return { state: 'invalid', accountLabel: null, detail: invalidCopy }
  return { state: 'unreachable', accountLabel: null, detail: unreachableCopy }
}

export function asString(v: unknown): string | null {
  return typeof v === 'string' && v ? v : typeof v === 'number' ? String(v) : null
}
