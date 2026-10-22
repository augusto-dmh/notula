// SPDX-License-Identifier: Apache-2.0
// Calendar secrets: `calendar.source.<id>` (the ICS URL, or the OAuth tokens),
// `calendar.google.client` and `calendar.microsoft.client`. Values are JSON, stored
// base64url-encoded so they pass the secrets store's printable-ASCII rule. Plaintext
// lives only here, only while a request needs it; nothing is logged or sent to a renderer.

import type { OAuthCalendarProvider } from '@shared/types/calendar'
import type { SecretId } from '@shared/types/settings'
import type { MainContext } from '../context'

/** The secrets store accepts at most this many characters. */
const MAX_SECRET_CHARS = 8_192

export interface IcsSecret {
  kind: 'ics'
  url: string
}

export interface TokenSecret {
  kind: 'oauth'
  refreshToken: string
  /** Kept when it fits; otherwise only in memory. */
  accessToken?: string
  /** ms since the epoch. */
  expiresAt?: number
}

export type SourceSecret = IcsSecret | TokenSecret

export interface OAuthClient {
  clientId: string
  /** Google desktop clients only. */
  clientSecret?: string
}

const sourceSecretId = (sourceId: string): SecretId => `calendar.source.${sourceId}`
const clientSecretId = (provider: OAuthCalendarProvider): SecretId =>
  provider === 'google' ? 'calendar.google.client' : 'calendar.microsoft.client'

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

function decode<T>(raw: string | null): T | null {
  if (!raw) return null
  try {
    return JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as T
  } catch {
    return null
  }
}

export async function readSourceSecret(ctx: MainContext, sourceId: string): Promise<SourceSecret | null> {
  const v = decode<SourceSecret>(await ctx.secrets.get(sourceSecretId(sourceId)))
  if (v?.kind === 'ics' && typeof v.url === 'string') return v
  if (v?.kind === 'oauth' && typeof v.refreshToken === 'string' && v.refreshToken) return v
  return null
}

export async function writeSourceSecret(ctx: MainContext, sourceId: string, value: SourceSecret): Promise<void> {
  let text = encode(value)
  if (text.length > MAX_SECRET_CHARS && value.kind === 'oauth') {
    // A large access token stays in memory only; the refresh token is what must persist.
    text = encode({ kind: 'oauth', refreshToken: value.refreshToken } satisfies TokenSecret)
  }
  if (text.length > MAX_SECRET_CHARS) throw new Error('calendar secret too large')
  await ctx.secrets.set(sourceSecretId(sourceId), text)
}

export async function clearSourceSecret(ctx: MainContext, sourceId: string): Promise<void> {
  await ctx.secrets.clear(sourceSecretId(sourceId))
}

export async function readClient(ctx: MainContext, provider: OAuthCalendarProvider): Promise<OAuthClient | null> {
  const v = decode<OAuthClient>(await ctx.secrets.get(clientSecretId(provider)))
  return v && typeof v.clientId === 'string' && v.clientId ? v : null
}

export async function writeClient(ctx: MainContext, provider: OAuthCalendarProvider, client: OAuthClient | null): Promise<void> {
  if (!client) {
    await ctx.secrets.clear(clientSecretId(provider))
    return
  }
  await ctx.secrets.set(clientSecretId(provider), encode(client))
}
