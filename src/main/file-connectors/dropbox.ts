// SPDX-License-Identifier: Apache-2.0
// The Dropbox plug-in: the user's own Dropbox app (PKCE, no
// secret), a loopback listener on the fixed port 47616 (the redirect URI must match exactly),
// short-lived access tokens refreshed with the offline refresh token, and validation through
// `users/get_current_account`. The app key and the tokens are secrets (`integration.dropbox.client`,
// `integration.dropbox.tokens`, structured values); none reaches a log or a renderer.
//
// It is served through the integration layer: `integrations:set-credential` stores the app key,
// `integrations:connect-oauth` (registered by integrations-plus) runs the flow, and Disconnect deletes
// both secrets. Dropbox has no outbox sends: `send()` refuses.

import { createHash, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { app, shell } from 'electron'
import { notulaError } from '@shared/errors'
import { DROPBOX } from '@shared/types/integrations'
import { STRUCTURED_SECRET_PREFIX } from '@shared/types/settings'
import type { MainContext } from '../context'
import type { IntegrationPlugin } from '../integration-plugins'
import { expected } from '../ipc-expected'
import { log } from '../log'
import { devUrl, exchange, providerHttp } from '../calendar-write/http'

const SCOPES = 'files.metadata.read files.content.read account_info.read'
const OAUTH_TIMEOUT_MS = 300_000
const APP_KEY = /^[a-z0-9]{8,64}$/i

interface DropboxTokens {
  accessToken: string
  refreshToken: string
  expiresAt: number
  accountLabel: string | null
}

const encode = (v: unknown): string => STRUCTURED_SECRET_PREFIX + Buffer.from(JSON.stringify(v), 'utf8').toString('base64url')
function decode<T>(raw: string | null): T | null {
  if (!raw?.startsWith(STRUCTURED_SECRET_PREFIX)) return null
  try {
    return JSON.parse(Buffer.from(raw.slice(STRUCTURED_SECRET_PREFIX.length), 'base64url').toString('utf8')) as T
  } catch {
    return null
  }
}

async function appKey(ctx: MainContext): Promise<string | null> {
  const v = decode<{ appKey?: unknown }>(await ctx.secrets.get('integration.dropbox.client'))
  return typeof v?.appKey === 'string' && v.appKey ? v.appKey : null
}

async function tokens(ctx: MainContext): Promise<DropboxTokens | null> {
  const v = decode<DropboxTokens>(await ctx.secrets.get('integration.dropbox.tokens'))
  return v && typeof v.refreshToken === 'string' && v.refreshToken ? v : null
}

const page = (title: string, body: string): string =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>body{font:15px/1.5 system-ui,'Segoe UI',sans-serif;display:grid;place-items:center;min-height:90vh;margin:0;color:#1b1b19;background:#fafaf9}main{text-align:center;max-width:28rem}h1{font-size:20px;margin:0 0 .5rem}p{margin:0;color:#5c5c57}</style></head><body><main><h1>${title}</h1><p>${body}</p></main></body></html>`

async function tokenCall(ctx: MainContext, form: Record<string, string>): Promise<Record<string, unknown>> {
  const http = providerHttp(ctx, 'integration', 'dropbox')
  const x = await exchange(() =>
    http.fetch('https://api.dropboxapi.com/oauth2/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(form).toString()
    })
  )
  if (x.ok) return x.body
  if (x.kind === 'local-only') throw expected(notulaError('provider-error', 'local-only mode'))
  if (x.kind === 'http' && x.body['error'] === 'invalid_grant') throw expected(notulaError('provider-error', 'Dropbox signed you out. Connect again.'))
  if (x.kind === 'http') throw expected(notulaError('provider-error', 'Dropbox didn’t accept the app key. Check it and try again.'))
  throw expected(notulaError('provider-error', 'Couldn’t reach Dropbox. Check your connection and try again.'))
}

async function account(ctx: MainContext, accessToken: string): Promise<{ ok: boolean; status: number; label: string | null }> {
  const http = providerHttp(ctx, 'integration', 'dropbox')
  const x = await exchange(() => http.fetch('https://api.dropboxapi.com/2/users/get_current_account', { method: 'POST', headers: { authorization: `Bearer ${accessToken}` } }))
  if (x.ok) return { ok: true, status: 200, label: typeof x.body['email'] === 'string' ? x.body['email'] : null }
  return { ok: false, status: x.kind === 'http' ? x.status : 0, label: null }
}

/** A valid access token (refreshed 60 s before expiry). Throws when Dropbox is not connected. */
export async function dropboxToken(ctx: MainContext): Promise<string> {
  const t = await tokens(ctx)
  const key = await appKey(ctx)
  if (!t || !key) throw expected(notulaError('missing-key', 'Connect Dropbox in Settings ▸ Connectors first.'))
  if (t.expiresAt - 60_000 > Date.now()) return t.accessToken
  const body = await tokenCall(ctx, { grant_type: 'refresh_token', refresh_token: t.refreshToken, client_id: key })
  const accessToken = typeof body['access_token'] === 'string' ? body['access_token'] : ''
  if (!accessToken) throw expected(notulaError('provider-error', 'Dropbox signed you out. Connect again.'))
  const next: DropboxTokens = { ...t, accessToken, expiresAt: Date.now() + (Number(body['expires_in']) || 14_400) * 1000 }
  await ctx.secrets.set('integration.dropbox.tokens', encode(next))
  return accessToken
}

export async function dropboxLabel(ctx: MainContext): Promise<{ connected: boolean; label: string | null; hasKey: boolean }> {
  const t = await tokens(ctx)
  return { connected: !!t, label: t?.accountLabel ?? null, hasKey: !!(await appKey(ctx)) }
}

export function dropboxPlugin(): IntegrationPlugin {
  let pending: { server: Server; reject(e: Error): void } | null = null

  const cancel = (): void => {
    if (!pending) return
    const p = pending
    pending = null
    p.reject(expected(notulaError('provider-error', 'Connection cancelled')))
    p.server.close()
  }

  return {
    provider: 'dropbox',
    credentialKinds: ['oauth-client'],
    async validate(ctx) {
      const t = await tokens(ctx)
      if (!t) return { state: 'not_configured', accountLabel: null, detail: (await appKey(ctx)) ? 'App key saved. Connect to finish.' : null }
      try {
        const r = await account(ctx, await dropboxToken(ctx))
        if (r.ok) {
          if (r.label !== t.accountLabel) await ctx.secrets.set('integration.dropbox.tokens', encode({ ...(await tokens(ctx)), accountLabel: r.label }))
          return { state: 'connected', accountLabel: r.label, detail: null }
        }
        return r.status === 401 ? { state: 'invalid', accountLabel: t.accountLabel, detail: 'Dropbox signed you out. Connect again.' } : { state: 'unreachable', accountLabel: t.accountLabel, detail: null }
      } catch {
        return { state: 'unreachable', accountLabel: t.accountLabel, detail: null }
      }
    },
    async setCredential(ctx, input) {
      const v = typeof input.value === 'string' ? input.value.trim() : ''
      if (!APP_KEY.test(v)) throw expected(notulaError('invalid-input', 'Paste the App key from your Dropbox app’s Settings tab.'))
      await ctx.secrets.set('integration.dropbox.client', encode({ appKey: v }))
    },
    async connectOAuth(ctx) {
      const key = await appKey(ctx)
      if (!key) throw expected(notulaError('missing-key', 'Paste your Dropbox App key first.'))
      if (pending) throw expected(notulaError('busy', 'A Dropbox connection is already in progress'))
      const state = randomBytes(32).toString('base64url')
      const verifier = randomBytes(48).toString('base64url')
      const challenge = createHash('sha256').update(verifier).digest('base64url')
      const redirectUri = `http://127.0.0.1:${DROPBOX.callbackPort}${DROPBOX.callbackPath}`
      let resolveCode!: (code: string) => void
      let rejectCode!: (e: Error) => void
      const result = new Promise<string>((res, rej) => {
        resolveCode = res
        rejectCode = rej
      })
      result.catch(() => undefined)
      const handler = (req: IncomingMessage, res: ServerResponse): void => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        if (req.method !== 'GET' || url.pathname !== DROPBOX.callbackPath) {
          res.writeHead(404).end()
          return
        }
        if (url.searchParams.get('state') !== state) {
          res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' }).end(page('Something went wrong', 'This sign-in link is no longer valid. Return to Notula and try again.'))
          return
        }
        const code = url.searchParams.get('code')
        if (!code) {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page('Dropbox not connected', 'Notula did not get access to Dropbox. You can close this tab.'))
          rejectCode(expected(notulaError('provider-error', 'Access was not granted')))
          return
        }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page('Dropbox connected', 'You can close this tab and return to Notula.'))
        resolveCode(code)
      }
      const server = createServer(handler)
      await new Promise<void>((resolve, reject) => {
        server.once('error', () => reject(expected(notulaError('busy', `Port ${DROPBOX.callbackPort} is in use. Close the app using it and try again.`))))
        server.listen(DROPBOX.callbackPort, '127.0.0.1', () => resolve())
      })
      pending = { server, reject: rejectCode }
      const timer = setTimeout(() => rejectCode(expected(notulaError('provider-error', 'Connection timed out'))), OAUTH_TIMEOUT_MS)
      try {
        const params = new URLSearchParams({
          client_id: key,
          response_type: 'code',
          redirect_uri: redirectUri,
          code_challenge: challenge,
          code_challenge_method: 'S256',
          token_access_type: 'offline',
          scope: SCOPES,
          state
        })
        const authorizeUrl = `https://www.dropbox.com/oauth2/authorize?${params.toString()}`
        // Dev builds with the provider mock: the browser step is a plain request (no browser).
        const mocked = !app.isPackaged && devUrl(authorizeUrl) !== authorizeUrl
        if (mocked) void providerHttp(ctx, 'integration', 'dropbox').fetchUrl(devUrl(authorizeUrl), { redirect: 'follow' }).then((r) => r.body?.cancel()).catch(() => undefined)
        else await shell.openExternal(authorizeUrl)
        log('info', 'dropbox:oauth-browser-opened', {})
        const code = await result
        const body = await tokenCall(ctx, { grant_type: 'authorization_code', code, code_verifier: verifier, client_id: key, redirect_uri: redirectUri })
        const accessToken = typeof body['access_token'] === 'string' ? body['access_token'] : ''
        const refreshToken = typeof body['refresh_token'] === 'string' ? body['refresh_token'] : ''
        if (!accessToken || !refreshToken) throw expected(notulaError('provider-error', 'Dropbox returned no sign-in. Try again.'))
        const who = await account(ctx, accessToken)
        await ctx.secrets.set('integration.dropbox.tokens', encode({ accessToken, refreshToken, expiresAt: Date.now() + (Number(body['expires_in']) || 14_400) * 1000, accountLabel: who.label } satisfies DropboxTokens))
        log('info', 'dropbox:connected', {})
      } finally {
        clearTimeout(timer)
        if (pending?.server === server) pending = null
        server.close()
      }
    },
    cancelOAuth: cancel,
    async send() {
      return { status: 'failed', retryable: false, errorCode: 'read_only', errorMessage: 'Dropbox is read-only in Notula.' }
    },
    async disconnect(ctx) {
      await ctx.secrets.clear('integration.dropbox.tokens')
      await ctx.secrets.clear('integration.dropbox.client')
      log('info', 'dropbox:disconnected', {})
    }
  }
}
