// SPDX-License-Identifier: Apache-2.0
// The calendar sync service:
// sources, one refresh per source at a time (coalesced), the event filter, the
// per-source write, the note follow-up, and the OAuth connect / reconnect / disconnect.
//
// Feed URLs and tokens stay in this process: secrets in, sanitized rows out.

import { randomUUID } from 'node:crypto'
import { notulaError } from '@shared/errors'
import type { CalendarGrant } from '@shared/types/calendar'
import type {
  CalendarErrorType,
  CalendarInfo,
  CalendarSource,
  CalendarSourcesState,
  OAuthCalendarProvider
} from '@shared/types/calendar'
import { CALENDAR_SYNC } from '@shared/types/calendar'
import type { CalendarEvent } from '@shared/types/notes'
import type { MainContext } from '../context'
import { log } from '../log'
import { egressBlocked, LOCAL_ONLY_REASON } from '../privacy'
import type { CalendarSourceRow } from '../storage/api'
import { fetchIcs, IcsError, normalizeFeedUrl } from './ics'
import { parseIcsOffMain } from './ics-host'
import type { ParsedFeed } from './ics-parse'
import { connectOAuth, grantsFromScope, OAuthError, refreshOAuth, revokeGoogle } from './oauth'
import { googleCalendars, googleEvents, graphAccountEmail, graphCalendars, graphEvents, type ProviderCalendar } from './providers'
import {
  clearSourceSecret,
  readClient,
  readSourceSecret,
  writeClient,
  writeSourceSecret,
  type OAuthClient
} from './secrets'

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const GRANTS: readonly CalendarGrant[] = ['calendar-write', 'mail-read', 'mail-send', 'files-read']
const CLIENT_VALUE = /^[\x21-\x7E]{1,512}$/

export type RefreshTrigger =
  | 'init'
  | 'polling'
  | 'window-visible'
  | 'home-view'
  | 'manual'
  | 'settings'
  | 'online'
  | 'resume'
  | 'connect'
  | 'visibility'

export function publicSource(row: CalendarSourceRow): CalendarSource {
  const { httpEtag: _etag, httpLastModified: _modified, ...pub } = row
  return pub
}

/** Not cancelled, timed, titled, not declined by the user, with an id; by start. */
export function keepForStore(events: CalendarEvent[], mine: ReadonlySet<string>): CalendarEvent[] {
  return events
    .filter((ev) => {
      if (!ev || typeof ev.id !== 'string' || !ev.id) return false
      if (ev['status'] === 'cancelled') return false
      if (!ev.start?.dateTime || !ev.end?.dateTime) return false
      if (typeof ev.summary !== 'string' || !ev.summary.trim()) return false
      const attendees = Array.isArray(ev.attendees) ? ev.attendees : []
      const declined = attendees.some(
        (a) => a && (a.self === true || (typeof a.email === 'string' && mine.has(a.email.toLowerCase()))) && a.responseStatus === 'declined'
      )
      return !declined
    })
    .sort((a, b) => Date.parse(String(a.start?.dateTime)) - Date.parse(String(b.start?.dateTime)))
}

function syncWindow(): { fromMs: number; toMs: number } {
  const now = Date.now()
  return { fromMs: now - CALENDAR_SYNC.windowBackMs, toMs: now + CALENDAR_SYNC.windowAheadMs }
}

/**
 * The ICS expansion window: the sync window widened to whole local days, so one expansion
 * covers every refresh of that day and an unchanged feed needs none until midnight.
 */
function icsWindow(): { fromMs: number; toMs: number } {
  const day = new Date()
  day.setHours(0, 0, 0, 0)
  const midnight = day.getTime()
  return { fromMs: midnight - CALENDAR_SYNC.windowBackMs, toMs: midnight + CALENDAR_SYNC.windowAheadMs + 86_400_000 }
}

/** SHA-256 of a feed body, hex; WebCrypto runs it off the event loop. */
async function bodyHash(bytes: Uint8Array): Promise<string> {
  return Buffer.from(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)).toString('hex')
}

/** Refresh triggers that re-expand an unchanged feed anyway: the user asked, or a calendar came back. */
const FORCED_ICS_TRIGGERS: readonly RefreshTrigger[] = ['manual', 'visibility']

function icsCalendarId(sourceId: string): string {
  return `ics:${sourceId}:calendar`
}

function icsKey(hash: string, window: { fromMs: number }, mine: ReadonlySet<string>): string {
  return `${hash}|${window.fromMs}|${[...mine].sort().join(',')}`
}

function sentence(reason: string): string {
  return reason ? reason.charAt(0).toUpperCase() + reason.slice(1) : reason
}

export class CalendarService {
  private readonly running = new Map<string, Promise<void>>()
  private readonly again = new Set<string>()
  private readonly removed = new Set<string>()
  private readonly icsCache = new Map<string, { bytes: Uint8Array; hash: string; etag: string | null; lastModified: string | null }>()
  /** What each ICS source's stored events were last written from: body hash, window, my emails. */
  private readonly icsWritten = new Map<string, string>()
  private readonly tokens = new Map<string, { accessToken: string; expiresAt: number }>()
  private connecting = false

  constructor(
    private readonly ctx: MainContext,
    private readonly changed: (sourceIds: string[]) => void
  ) {}

  // ---------- reads ----------

  /** `profile.email`, every OAuth account email and every ICS "my email": lower-cased, unique. */
  async myEmails(): Promise<string[]> {
    const out = new Set<string>()
    try {
      const email = (await this.ctx.settings.get('profile.email')).trim().toLowerCase()
      if (email) out.add(email)
    } catch {
      // Settings unavailable: the sources still count.
    }
    for (const s of await this.liveSources()) {
      for (const e of [s.accountEmail, s.myEmail]) {
        const v = e?.trim().toLowerCase()
        if (v) out.add(v)
      }
    }
    return [...out]
  }

  private async liveSources(): Promise<CalendarSourceRow[]> {
    try {
      return await this.ctx.storage.listCalendarSources()
    } catch {
      return []
    }
  }

  async state(): Promise<CalendarSourcesState> {
    const sources = (await this.ctx.storage.listCalendarSources()).map((s) =>
      this.running.has(s.id) ? { ...publicSource(s), status: 'syncing' as const } : publicSource(s)
    )
    const [google, microsoft] = await Promise.all([readClient(this.ctx, 'google'), readClient(this.ctx, 'microsoft')])
    return { sources, oauthClients: { google: google !== null, microsoft: microsoft !== null } }
  }

  async calendars(): Promise<CalendarInfo[]> {
    return this.ctx.storage.listCalendars()
  }

  // ---------- ICS ----------

  async addIcs(input: { url: unknown; label?: unknown; myEmail?: unknown }): Promise<CalendarSource> {
    const fail = (reason: string): Error => notulaError('invalid-input', `Couldn't read this calendar: ${reason}`)
    const label = typeof input.label === 'string' ? input.label.trim().slice(0, 200) : ''
    const myEmail = typeof input.myEmail === 'string' ? input.myEmail.trim().toLowerCase() : ''
    if (myEmail && (!EMAIL.test(myEmail) || myEmail.length > 320)) throw notulaError('invalid-input', 'That email address doesn’t look right')
    let feed
    let parsed: ParsedFeed
    let fetched: { bytes: Uint8Array; hash: string; etag: string | null; lastModified: string | null; insecure: boolean }
    const window = icsWindow()
    const id = randomUUID()
    const mine = new Set([...(await this.myEmails()), ...(myEmail ? [myEmail] : [])])
    try {
      feed = normalizeFeedUrl(input.url)
      const res = await fetchIcs(feed.url, null)
      if (res.status !== 'ok') throw new IcsError('fetch_failed', 'the server sent no calendar')
      fetched = { ...res, hash: await bodyHash(res.bytes) }
      parsed = await parseIcsOffMain(res.bytes, { sourceId: id, calendarId: icsCalendarId(id), myEmails: mine, window })
    } catch (err) {
      if (err instanceof IcsError) {
        log('info', 'calendar:ics-add-failed', { type: err.type, host: feed?.host ?? null })
        throw fail(err.reason)
      }
      log('warn', 'calendar:ics-add-failed', { type: 'internal', host: feed?.host ?? null })
      throw fail('the calendar could not be read')
    }

    // Read and parsed: only now is anything saved.
    await writeSourceSecret(this.ctx, id, { kind: 'ics', url: feed.url })
    const now = new Date().toISOString()
    let row: CalendarSourceRow
    try {
      row = await this.ctx.storage.upsertCalendarSource({
        id,
        kind: 'ics',
        label: label || parsed.name || feed.host,
        accountEmail: null,
        grants: [],
        myEmail: myEmail || null,
        urlHost: feed.host,
        // An https address that redirects to plain http is not encrypted either.
        insecure: feed.insecure || fetched.insecure,
        status: 'ok',
        errorType: null,
        lastSyncedAt: now,
        lastError: null,
        createdAt: now,
        httpEtag: fetched.etag,
        httpLastModified: fetched.lastModified
      })
    } catch (err) {
      await clearSourceSecret(this.ctx, id).catch(() => undefined)
      throw err
    }
    this.icsCache.set(id, fetched)
    try {
      await this.writeIcs(row, parsed, mine)
      this.icsWritten.set(id, icsKey(fetched.hash, window, mine))
    } catch (err) {
      log('warn', 'calendar:ics-first-write-failed', { err })
    }
    log('info', 'calendar:ics-added', { host: feed.host, insecure: feed.insecure, events: parsed.events.length, skipped: parsed.skipped })
    this.changed([id])
    return publicSource(row)
  }

  private async writeIcs(src: CalendarSourceRow, parsed: ParsedFeed, mine: ReadonlySet<string>): Promise<void> {
    const calendarId = icsCalendarId(src.id)
    await this.ctx.storage.replaceCalendars(
      src.id,
      [{ id: calendarId, sourceId: src.id, name: parsed.name ?? src.label, color: parsed.color, primary: true, accessRole: 'reader' }],
      { visibleIds: [calendarId] }
    )
    const kept = keepForStore(parsed.events, mine)
    // A feed ical.js rejected is only partly read: what it holds is added or updated, but
    // nothing is deleted on its say-so.
    const written = await this.ctx.storage.replaceSourceEvents(src.id, kept, { calendarIds: parsed.complete ? [calendarId] : [] })
    if (kept.length) await this.ctx.storage.followEventUpdates(kept)
    if (!parsed.complete) log('warn', 'calendar:ics-partial-no-delete', { host: src.urlHost, skipped: parsed.skipped })
    log('debug', 'calendar:ics-written', { host: src.urlHost, ...written, kept: kept.length, complete: parsed.complete })
  }

  /**
   * One ICS refresh. A 304, or a body identical to the last one, is a successful sync with
   * no change: when the stored events were written from that body for today's
   * window and the same "my emails", nothing is parsed or written, and only the sync time
   * moves. Returns false for such a refresh that changed nothing visible.
   */
  private async syncIcs(src: CalendarSourceRow, mine: ReadonlySet<string>, trigger: RefreshTrigger): Promise<boolean> {
    const secret = await readSourceSecret(this.ctx, src.id)
    if (!secret || secret.kind !== 'ics') {
      await this.mark(src, { status: 'error', errorType: 'invalid_feed', lastError: 'The feed address is missing. Remove the feed and add it again.' })
      return true
    }
    const cached = this.icsCache.get(src.id) ?? null
    try {
      const res = await fetchIcs(secret.url, cached ? { etag: cached.etag, lastModified: cached.lastModified } : null)
      // Settings shows "Not encrypted (http)" for what the feed travels over now, typed
      // address or final redirect hop.
      const insecure = normalizeFeedUrl(secret.url).insecure || res.insecure
      if (insecure && !src.insecure) log('warn', 'calendar:ics-insecure-redirect', { host: src.urlHost })
      let body = cached
      if (res.status === 'ok') {
        const hash = await bodyHash(res.bytes)
        body = { bytes: res.bytes, hash, etag: res.etag, lastModified: res.lastModified }
        this.icsCache.set(src.id, body)
      }
      if (!body) throw new IcsError('fetch_failed', 'the server sent no calendar')
      const window = icsWindow()
      const key = icsKey(body.hash, window, mine)
      if (this.icsWritten.get(src.id) === key && !FORCED_ICS_TRIGGERS.includes(trigger)) {
        await this.mark(src, {
          status: 'ok',
          errorType: null,
          lastError: null,
          lastSyncedAt: new Date().toISOString(),
          httpEtag: body.etag,
          httpLastModified: body.lastModified,
          insecure
        })
        log('debug', 'calendar:ics-unchanged', { host: src.urlHost, notModified: res.status === 'not-modified' })
        return src.status !== 'ok' || src.insecure !== insecure
      }
      this.icsWritten.delete(src.id)
      const parsed = await parseIcsOffMain(body.bytes, { sourceId: src.id, calendarId: icsCalendarId(src.id), myEmails: mine, window })
      await this.writeIcs(src, parsed, mine)
      this.icsWritten.set(src.id, key)
      await this.mark(src, {
        status: 'ok',
        errorType: null,
        lastError: null,
        lastSyncedAt: new Date().toISOString(),
        httpEtag: body.etag,
        httpLastModified: body.lastModified,
        insecure
      })
    } catch (err) {
      if (!(err instanceof IcsError)) throw err
      log('info', 'calendar:ics-sync-failed', { host: src.urlHost, type: err.type })
      await this.mark(src, { status: 'error', errorType: err.type, lastError: sentence(err.reason) })
    }
    return true
  }

  // ---------- OAuth ----------

  async setClient(input: { provider: unknown; clientId: unknown; clientSecret?: unknown }): Promise<void> {
    const provider = this.provider(input.provider)
    const clientId = typeof input.clientId === 'string' ? input.clientId.trim() : ''
    if (!clientId) {
      await writeClient(this.ctx, provider, null)
      log('info', 'calendar:oauth-client-cleared', { provider })
    } else {
      if (!CLIENT_VALUE.test(clientId)) throw notulaError('invalid-input', 'The client ID contains spaces or unusual characters')
      const client: OAuthClient = { clientId }
      if (provider === 'google') {
        const secret = typeof input.clientSecret === 'string' ? input.clientSecret.trim() : ''
        if (secret && !CLIENT_VALUE.test(secret)) throw notulaError('invalid-input', 'The client secret contains spaces or unusual characters')
        if (secret) client.clientSecret = secret
      }
      await writeClient(this.ctx, provider, client)
      log('info', 'calendar:oauth-client-set', { provider, withSecret: !!client.clientSecret })
    }
    this.changed([])
    void this.refreshAll('settings')
  }

  async connect(input: { provider: unknown; sourceId?: unknown }): Promise<CalendarSource> {
    const provider = this.provider(input.provider)
    // No sign-in while local-only is on.
    if (await egressBlocked(this.ctx, { kind: 'calendar' })) throw notulaError('provider-error', LOCAL_ONLY_REASON)
    // One flow at a time: claimed before the first await.
    if (this.connecting) throw notulaError('busy', 'A calendar connection is already in progress')
    this.connecting = true
    try {
      const client = await readClient(this.ctx, provider)
      if (!client) throw notulaError('missing-key', 'Add a client ID first')
      const sources = await this.ctx.storage.listCalendarSources()
      let existing: CalendarSourceRow | undefined
      if (typeof input.sourceId === 'string' && input.sourceId) {
        existing = sources.find((s) => s.id === input.sourceId && s.kind === provider)
        if (!existing) throw notulaError('not-found', 'That account is no longer connected')
      }
      // A reconnect asks again for the grants the account holds, so they survive it.
      const tokens = await connectOAuth(provider, client, { grants: existing?.grants ?? [], incremental: !!existing?.grants.length, loginHint: existing?.accountEmail ?? null })
      const email =
        provider === 'google'
          ? (await googleCalendars('connect', tokens.accessToken)).accountEmail
          : await graphAccountEmail(tokens.accessToken)
      if (!existing && email) {
        existing = sources.find((s) => s.kind === provider && s.accountEmail?.toLowerCase() === email.toLowerCase())
      }
      const id = existing?.id ?? randomUUID()
      this.removed.delete(id)
      await writeSourceSecret(this.ctx, id, {
        kind: 'oauth',
        refreshToken: tokens.refreshToken,
        accessToken: tokens.accessToken,
        expiresAt: tokens.expiresAt
      })
      this.tokens.set(id, { accessToken: tokens.accessToken, expiresAt: tokens.expiresAt })
      const now = new Date().toISOString()
      let row: CalendarSourceRow
      try {
        row = await this.ctx.storage.upsertCalendarSource({
          id,
          kind: provider,
          label: email ?? (provider === 'google' ? 'Google Calendar' : 'Outlook Calendar'),
          accountEmail: email,
          // Kept on a reconnect: the upsert never writes grants.
          grants: [],
          myEmail: null,
          urlHost: null,
          insecure: false,
          status: 'ok',
          errorType: null,
          lastSyncedAt: existing?.lastSyncedAt ?? null,
          lastError: null,
          createdAt: existing?.createdAt ?? now,
          httpEtag: null,
          httpLastModified: null
        })
      } catch (err) {
        // A new account's tokens would have no source row to own them: they are
        // cleared, and Google's revoked, as addIcs clears its feed URL. A reconnect keeps
        // its existing row, which owns the new tokens.
        if (!existing) {
          this.tokens.delete(id)
          await clearSourceSecret(this.ctx, id).catch(() => undefined)
          if (provider === 'google') await revokeGoogle(tokens.refreshToken)
          log('warn', 'calendar:connect-source-write-failed', { provider })
        }
        throw err
      }
      // The held set is what the token response says was granted.
      if (existing && tokens.scope !== null) {
        const granted = grantsFromScope(provider, tokens.scope)
        if (granted.join() !== row.grants.join()) {
          await this.ctx.storage.setCalendarSourceGrants(id, granted)
          row = { ...row, grants: granted }
        }
      }
      log('info', 'calendar:account-connected', { provider, reconnect: !!existing })
      this.changed([id])
      void this.refreshSource(id, 'connect')
      return publicSource(row)
    } catch (err) {
      if (err instanceof OAuthError) {
        log('info', 'calendar:connect-failed', { provider, kind: err.kind, status: err.status ?? null })
        throw notulaError('provider-error', err.kind === 'timeout' ? 'Connection timed out' : err.kind === 'denied' ? 'Access was not granted' : err.message)
      }
      throw err
    } finally {
      this.connecting = false
    }
  }

  // ---------- incremental grants ----------

  /** The account's held grants; [] for an ICS or unknown source. */
  async grants(sourceId: string): Promise<CalendarGrant[]> {
    const src = (await this.liveSources()).find((s) => s.id === sourceId)
    return src && src.kind !== 'ics' ? src.grants : []
  }

  /**
   * Re-runs the loopback + PKCE consent for this account
   * with the read scope and the held grants plus or minus `grant`. The new tokens replace the
   * account's `calendar.source.<id>` secret, and the held set becomes what the token
   * response's granted scopes cover. A turn-off asks without the grant; Google keeps the old grant
   * on the account until the user revokes it there. Rejects `provider-error: Access was not granted`
   * when the grant was asked for and not given, `provider-error: Connection timed out` on the
   * 5-minute timeout.
   */
  async setGrant(sourceId: unknown, grant: unknown, enabled: unknown): Promise<CalendarSource> {
    if (typeof sourceId !== 'string' || !sourceId) throw notulaError('invalid-input', 'sourceId is required')
    if (typeof grant !== 'string' || !GRANTS.includes(grant as CalendarGrant)) throw notulaError('invalid-input', 'Unknown permission')
    if (typeof enabled !== 'boolean') throw notulaError('invalid-input', 'enabled is required')
    const g = grant as CalendarGrant
    const src = (await this.liveSources()).find((s) => s.id === sourceId)
    if (!src) throw notulaError('not-found', 'That account is no longer connected')
    if (src.kind === 'ics') throw notulaError('invalid-input', 'Calendar feeds are read-only')
    if (await egressBlocked(this.ctx, { kind: 'calendar' })) throw notulaError('provider-error', LOCAL_ONLY_REASON)
    if (src.grants.includes(g) === enabled) return publicSource(src)
    if (this.connecting) throw notulaError('busy', 'A calendar connection is already in progress')
    this.connecting = true
    const provider = src.kind as OAuthCalendarProvider
    const wanted = enabled ? [...src.grants, g] : src.grants.filter((x) => x !== g)
    try {
      const client = await readClient(this.ctx, provider)
      if (!client) throw notulaError('missing-key', 'Add a client ID first')
      const tokens = await connectOAuth(provider, client, { grants: wanted, incremental: enabled, loginHint: src.accountEmail })
      if (src.accountEmail) {
        const email = provider === 'google' ? (await googleCalendars('connect', tokens.accessToken)).accountEmail : await graphAccountEmail(tokens.accessToken)
        if (email && email.toLowerCase() !== src.accountEmail.toLowerCase()) {
          // Another account signed in: its tokens must not replace this one's.
          if (provider === 'google') await revokeGoogle(tokens.refreshToken)
          throw notulaError('provider-error', `Sign in as ${src.accountEmail} to change this account's permissions`)
        }
      }
      if (this.removed.has(src.id)) throw notulaError('not-found', 'That account is no longer connected')
      await writeSourceSecret(this.ctx, src.id, { kind: 'oauth', refreshToken: tokens.refreshToken, accessToken: tokens.accessToken, expiresAt: tokens.expiresAt })
      this.tokens.set(src.id, { accessToken: tokens.accessToken, expiresAt: tokens.expiresAt })
      // No scope in the reply: the provider granted what was asked (Google omits it only then).
      const granted = tokens.scope !== null ? grantsFromScope(provider, tokens.scope) : wanted
      // A turn-off never keeps the grant on Notula's side, whatever the reply says.
      const held = enabled ? granted : granted.filter((x) => x !== g)
      await this.ctx.storage.setCalendarSourceGrants(src.id, held)
      log('info', 'calendar:grant-changed', { provider, grant: g, enabled, held: held.length })
      this.changed([src.id])
      if (enabled && !held.includes(g)) throw notulaError('provider-error', 'Access was not granted')
      return publicSource({ ...src, grants: held })
    } catch (err) {
      if (err instanceof OAuthError) {
        log('info', 'calendar:grant-failed', { provider, grant: g, kind: err.kind, status: err.status ?? null })
        throw notulaError('provider-error', err.kind === 'timeout' ? 'Connection timed out' : err.kind === 'denied' ? 'Access was not granted' : err.message)
      }
      throw err
    } finally {
      this.connecting = false
    }
  }

  /** A token for a held grant, refreshed as needed. Throws `provider-error: <CalendarGrantError>`. */
  async grantToken(sourceId: string, grant: CalendarGrant): Promise<string> {
    const src = (await this.liveSources()).find((s) => s.id === sourceId)
    if (!src || src.kind === 'ics') throw notulaError('provider-error', 'missing_token')
    if (!src.grants.includes(grant)) throw notulaError('provider-error', 'missing_scopes')
    const client = await readClient(this.ctx, src.kind as OAuthCalendarProvider)
    if (!client) throw notulaError('provider-error', 'missing_token')
    try {
      return await this.accessToken(src, client)
    } catch {
      throw notulaError('provider-error', 'missing_token')
    }
  }

  /** The access token, refreshed 60 s before expiry (or now, after a 401). */
  private async accessToken(src: CalendarSourceRow, client: OAuthClient, force = false): Promise<string> {
    const lead = CALENDAR_SYNC.tokenRefreshLeadMs
    const mem = this.tokens.get(src.id)
    if (!force && mem && mem.expiresAt - lead > Date.now()) return mem.accessToken
    const secret = await readSourceSecret(this.ctx, src.id)
    if (!secret || secret.kind !== 'oauth') throw new OAuthError('invalid_grant', 'No sign-in is stored')
    if (!force && secret.accessToken && secret.expiresAt && secret.expiresAt - lead > Date.now()) {
      this.tokens.set(src.id, { accessToken: secret.accessToken, expiresAt: secret.expiresAt })
      return secret.accessToken
    }
    const next = await refreshOAuth(src.kind as OAuthCalendarProvider, client, secret.refreshToken, src.grants)
    if (!this.removed.has(src.id)) {
      await writeSourceSecret(this.ctx, src.id, {
        kind: 'oauth',
        refreshToken: next.refreshToken,
        accessToken: next.accessToken,
        expiresAt: next.expiresAt
      })
    }
    this.tokens.set(src.id, { accessToken: next.accessToken, expiresAt: next.expiresAt })
    log('debug', 'calendar:token-refreshed', { provider: src.kind, rotated: next.refreshToken !== secret.refreshToken })
    return next.accessToken
  }

  private async syncOAuth(src: CalendarSourceRow, mine: ReadonlySet<string>): Promise<void> {
    const provider = src.kind as OAuthCalendarProvider
    const client = await readClient(this.ctx, provider)
    if (!client) {
      await this.mark(src, { status: 'error', errorType: 'missing_token', lastError: 'The client ID was removed. Add it again, then reconnect.' })
      return
    }
    const expired = (): Promise<void> =>
      this.mark(src, { status: 'error', errorType: 'missing_token', lastError: 'The sign-in has expired. Reconnect to keep syncing.' })
    let token: string
    try {
      token = await this.accessToken(src, client)
    } catch (err) {
      if (err instanceof OAuthError && err.kind === 'invalid_grant') return expired()
      log('info', 'calendar:token-refresh-failed', { provider, kind: err instanceof OAuthError ? err.kind : 'internal' })
      await this.mark(src, { status: 'error', errorType: 'fetch_failed', lastError: 'The calendar service could not be reached' })
      return
    }
    /** One retry after a 401, with a refreshed token. */
    const call = async <T>(fn: (t: string) => Promise<T>): Promise<T> => {
      try {
        return await fn(token)
      } catch (err) {
        if (!(err instanceof OAuthError) || err.kind !== 'unauthorized') throw err
        token = await this.accessToken(src, client, true)
        return fn(token)
      }
    }

    let list: ProviderCalendar[]
    let email = src.accountEmail
    try {
      if (provider === 'google') {
        const r = await call((t) => googleCalendars(src.id, t))
        list = r.calendars
        email = r.accountEmail ?? email
      } else {
        email = (await call((t) => graphAccountEmail(t))) ?? email
        list = await call((t) => graphCalendars(src.id, t, email))
      }
    } catch (err) {
      const kind = err instanceof OAuthError ? err.kind : 'internal'
      log('info', 'calendar:calendar-list-failed', { provider, kind })
      if (kind === 'unauthorized' || kind === 'invalid_grant') return expired()
      if (kind === 'forbidden') {
        await this.mark(src, { status: 'error', errorType: 'missing_scopes', lastError: 'Notula can’t read this calendar. Reconnect and allow calendar access.' })
        return
      }
      await this.mark(src, {
        status: 'error',
        // A network failure or a rate limit is transient: it never asks to reconnect.
        errorType: kind === 'network' || kind === 'rate_limited' ? 'fetch_failed' : 'calendar_list_failed',
        lastError:
          kind === 'network'
            ? 'The calendar service could not be reached'
            : kind === 'rate_limited'
              ? 'The calendar service is busy. Notula will try again.'
              : 'The calendar list could not be read'
      })
      return
    }

    const stored = await this.ctx.storage.replaceCalendars(
      src.id,
      list.map(({ nativeId: _native, ...c }) => c),
      { visibleIds: list.filter((c) => c.primary).map((c) => c.id) }
    )
    const nativeIds = new Map(list.map((c) => [c.id, c.nativeId]))
    const win = syncWindow()
    const events: CalendarEvent[] = []
    const okIds: string[] = []
    let failed = 0
    for (const cal of stored.filter((c) => c.visible)) {
      const nativeId = nativeIds.get(cal.id)
      if (!nativeId) continue
      const target = { id: cal.id, nativeId, primary: cal.primary }
      try {
        events.push(
          ...(await call((t) =>
            provider === 'google' ? googleEvents(src.id, t, target, win) : graphEvents(src.id, t, target, email, win)
          ))
        )
        okIds.push(cal.id)
      } catch (err) {
        const kind = err instanceof OAuthError ? err.kind : 'internal'
        if (kind === 'unauthorized' || kind === 'invalid_grant') return expired()
        failed++
        log('info', 'calendar:events-fetch-failed', { provider, kind })
      }
    }
    // A failed calendar deletes nothing: only the calendars read in full are in scope.
    const kept = keepForStore(events, mine)
    const written = await this.ctx.storage.replaceSourceEvents(src.id, kept, { calendarIds: okIds })
    if (kept.length) await this.ctx.storage.followEventUpdates(kept)
    log('debug', 'calendar:oauth-written', { provider, ...written, kept: kept.length, failed })
    await this.mark(src, {
      label: email ?? src.label,
      accountEmail: email,
      ...(failed
        ? { status: 'error' as const, errorType: 'fetch_failed' as const, lastError: `${failed} calendar${failed === 1 ? '' : 's'} could not be read` }
        : { status: 'ok' as const, errorType: null, lastError: null, lastSyncedAt: new Date().toISOString() })
    })
  }

  // ---------- sources and visibility ----------

  async remove(sourceId: unknown): Promise<void> {
    if (typeof sourceId !== 'string' || !sourceId) throw notulaError('invalid-input', 'sourceId is required')
    const src = (await this.ctx.storage.listCalendarSources()).find((s) => s.id === sourceId)
    if (!src) throw notulaError('not-found', 'That calendar is no longer connected')
    this.removed.add(sourceId)
    if (src.kind === 'google') {
      const secret = await readSourceSecret(this.ctx, sourceId).catch(() => null)
      if (secret?.kind === 'oauth') await revokeGoogle(secret.refreshToken)
    }
    await clearSourceSecret(this.ctx, sourceId)
    this.tokens.delete(sourceId)
    this.icsCache.delete(sourceId)
    this.icsWritten.delete(sourceId)
    const { eventsDeleted } = await this.ctx.storage.removeCalendarSource(sourceId)
    log('info', 'calendar:source-removed', { kind: src.kind, eventsDeleted })
    this.changed([sourceId])
  }

  async setVisible(input: { calendarId: unknown; visible: unknown }): Promise<void> {
    if (typeof input.calendarId !== 'string' || !input.calendarId || typeof input.visible !== 'boolean') {
      throw notulaError('invalid-input', 'calendarId and visible are required')
    }
    const cal = (await this.ctx.storage.listCalendars()).find((c) => c.id === input.calendarId)
    if (!cal) throw notulaError('not-found', 'That calendar is no longer available')
    await this.ctx.storage.setCalendarVisible(cal.id, input.visible)
    this.changed([cal.sourceId])
    if (input.visible) void this.refreshSource(cal.sourceId, 'visibility')
  }

  /** Every account's primary calendar only; ICS calendars stay on. */
  async resetVisible(): Promise<void> {
    const sources = new Map((await this.ctx.storage.listCalendarSources()).map((s) => [s.id, s]))
    const turnedOn = new Set<string>()
    const touched = new Set<string>()
    for (const cal of await this.ctx.storage.listCalendars()) {
      const src = sources.get(cal.sourceId)
      if (!src) continue
      const want = src.kind === 'ics' ? true : cal.primary
      if (want === cal.visible) continue
      await this.ctx.storage.setCalendarVisible(cal.id, want)
      touched.add(cal.sourceId)
      if (want) turnedOn.add(cal.sourceId)
    }
    this.changed([...touched])
    for (const id of turnedOn) void this.refreshSource(id, 'visibility')
  }

  // ---------- refresh ----------

  /** Every live source, except one whose sign-in expired (it waits for Reconnect). */
  async refreshAll(trigger: RefreshTrigger): Promise<void> {
    const sources = await this.liveSources()
    log('debug', 'calendar:refresh', { trigger, sources: sources.length })
    for (const s of sources) {
      if (s.status === 'error' && s.errorType === 'missing_token' && trigger !== 'manual') continue
      void this.refreshSource(s.id, trigger)
    }
  }

  /** One refresh per source at a time; a request during one runs once after it. */
  refreshSource(id: string, trigger: RefreshTrigger): Promise<void> {
    const current = this.running.get(id)
    if (current) {
      this.again.add(id)
      return current
    }
    const run = (async () => {
      try {
        await this.syncOne(id, trigger)
      } catch (err) {
        log('error', 'calendar:sync-failed', { trigger, err: err instanceof Error ? err.message.slice(0, 200) : 'error' })
      } finally {
        this.running.delete(id)
        if (this.again.delete(id)) void this.refreshSource(id, trigger)
      }
    })()
    this.running.set(id, run)
    return run
  }

  private async syncOne(id: string, trigger: RefreshTrigger): Promise<void> {
    // ICS polls, OAuth fetches and token refreshes pause while local-only is on;
    // index.ts refreshes every source when it turns off.
    if (await egressBlocked(this.ctx, { kind: 'calendar' })) {
      log('info', 'calendar:sync-paused', { trigger, reason: LOCAL_ONLY_REASON })
      return
    }
    const src = (await this.ctx.storage.listCalendarSources()).find((s) => s.id === id)
    if (!src || this.removed.has(id)) return
    const mine = new Set(await this.myEmails())
    const started = Date.now()
    const changed = src.kind === 'ics' ? await this.syncIcs(src, mine, trigger) : (await this.syncOAuth(src, mine), true)
    log('debug', 'calendar:synced', { kind: src.kind, trigger, ms: Date.now() - started, changed })
    if (changed) this.changed([id])
  }

  /** Writes the source's status fields; a removed source stays removed. */
  private async mark(
    src: CalendarSourceRow,
    patch: Partial<
      Pick<CalendarSourceRow, 'status' | 'errorType' | 'lastError' | 'lastSyncedAt' | 'httpEtag' | 'httpLastModified' | 'label' | 'accountEmail' | 'insecure'>
    > & {
      errorType?: CalendarErrorType | null
    }
  ): Promise<void> {
    if (this.removed.has(src.id)) return
    await this.ctx.storage.upsertCalendarSource({ ...src, ...patch })
  }

  private provider(v: unknown): OAuthCalendarProvider {
    if (v === 'google' || v === 'microsoft') return v
    throw notulaError('invalid-input', 'provider must be google or microsoft')
  }
}
