// SPDX-License-Identifier: Apache-2.0
// Dev builds only (`!app.isPackaged`): `NOTULA_DEV_ASR_URL` replaces the cloud ASR
// endpoint, so a smoke run can point Notula at a local mock provider (for
// example `ws://127.0.0.1:18081/v1/listen`). Only the scheme, host and path are
// taken from it: the provider's own query string and auth headers stay as they are.
// Packaged builds ignore the variable.

import { app } from 'electron'
import type { CloudAsrProviderId } from '@shared/types/transcript'
import { log } from '../../log'

let logged = false
let httpLogged = false

/**
 * For imports: `NOTULA_DEV_ASR_HTTP_URL` replaces the scheme and host of the providers'
 * pre-recorded REST endpoints (dev builds only), so imports can be exercised against a local
 * mock. The provider's own path, query and auth headers stay as they are.
 */
export function devAsrHttpBase(provider: CloudAsrProviderId): string | null {
  if (app.isPackaged) return null
  const raw = process.env['NOTULA_DEV_ASR_HTTP_URL']?.trim()
  if (!raw) return null
  let url: URL | null = null
  try {
    url = new URL(raw)
  } catch {
    url = null
  }
  if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
    if (!httpLogged) log('warn', 'asr:dev-http-endpoint-ignored', { reason: 'not an http(s) URL' })
    httpLogged = true
    return null
  }
  const base = `${url.protocol}//${url.host}`
  if (!httpLogged) log('info', 'asr:dev-http-endpoint', { provider, base })
  httpLogged = true
  return base
}

export function devAsrEndpoint(provider: CloudAsrProviderId): string | null {
  if (app.isPackaged) return null
  const raw = process.env['NOTULA_DEV_ASR_URL']?.trim()
  if (!raw) return null
  let url: URL | null = null
  try {
    url = new URL(raw)
  } catch {
    url = null
  }
  if (!url || (url.protocol !== 'ws:' && url.protocol !== 'wss:')) {
    if (!logged) log('warn', 'asr:dev-endpoint-ignored', { reason: 'not a ws:// or wss:// URL' })
    logged = true
    return null
  }
  const endpoint = `${url.protocol}//${url.host}${url.pathname}`
  if (!logged) log('info', 'asr:dev-endpoint', { provider, endpoint })
  logged = true
  return endpoint
}
