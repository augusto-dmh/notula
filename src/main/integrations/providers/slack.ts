// SPDX-License-Identifier: Apache-2.0
// Slack: bot token (auth.test, conversations.list,
// chat.postMessage) or incoming webhooks. Messages come from blockkit.ts.

import type { IntegrationSearchResult } from '@shared/types/integrations'
import { log } from '../../log'
import { buildMessages } from '../blockkit'
import { meetingStart, noteTitle, previewDate } from '../content'
import { integrationsHttp, parseBody, type HttpResult } from '../http'
import { asString, failure, type ProviderClient, type SendOutcome, type ValidateResult } from './types'

const COPY = {
  network: 'Couldn’t reach Slack. Check your connection and try again.',
  busy: 'Slack is busy. Try again in a minute.',
  other: 'Couldn’t send to Slack. Try again.'
}

const AUTH_ERRORS = new Set(['invalid_auth', 'not_authed', 'account_inactive', 'token_revoked'])

function channelName(label: string): string {
  return label.replace(/^#/, '')
}

/** Slack errors → the text the user sees. */
function slackError(code: string, channel: string, webhook: boolean): Extract<SendOutcome, { ok: false }> {
  const c = `#${channelName(channel)}`
  if (code === 'not_in_channel' || code === 'channel_not_found') return { ok: false, retry: 'never', code, message: `Add your Notula app to ${c} first, then try again.` }
  if (code === 'is_archived' || code === 'channel_is_archived') return { ok: false, retry: 'never', code, message: `${c} is archived.` }
  if (AUTH_ERRORS.has(code)) return { ok: false, retry: 'never', code, message: 'Your Slack token isn’t working. Update it in Settings.' }
  if (code === 'missing_scope') return { ok: false, retry: 'never', code, message: 'Your Slack app is missing a permission. Add the scopes listed in Settings and reinstall it.' }
  if (['restricted_action', 'action_prohibited', 'posting_to_general_channel_denied'].includes(code)) {
    return { ok: false, retry: 'never', code, message: `Slack didn’t allow posting to ${c}.` }
  }
  if (code === 'no_service' || (webhook && code === 'no_active_hooks')) {
    return { ok: false, retry: 'never', code, message: 'This Slack webhook no longer works. Remove it and add a new one.', disconnect: true }
  }
  if (['invalid_blocks', 'invalid_blocks_format', 'msg_blocks_too_long', 'invalid_payload', 'msg_too_long', 'no_text'].includes(code)) {
    return { ok: false, retry: 'never', code, message: 'Slack couldn’t read this message. Try shortening it.' }
  }
  if (code === 'ratelimited' || code === 'rate_limited') return { ok: false, retry: 'auto', code: 'rate_limited', message: COPY.busy }
  return { ok: false, retry: 'never', code: code || 'slack_error', message: COPY.other }
}

interface Channel {
  id: string
  name: string
  is_private: boolean
  is_archived: boolean
  is_member: boolean
}

let channelCache: { token: string; at: number; channels: Channel[] } | null = null

async function listChannels(token: string, refresh: boolean): Promise<Channel[]> {
  if (!refresh && channelCache && channelCache.token === token && Date.now() - channelCache.at < 5 * 60_000) return channelCache.channels
  const channels: Channel[] = []
  let cursor = ''
  for (let page = 0; page < 10; page++) {
    const r = await integrationsHttp.fetch('https://slack.com/api/conversations.list', {
      kind: 'read',
      headers: { Authorization: `Bearer ${token}` },
      query: { types: 'public_channel,private_channel', exclude_archived: true, limit: 200, ...(cursor ? { cursor } : {}) },
      pace: { key: 'slack:read', intervalMs: 1_000 }
    })
    if (!r.ok) throw new Error(r.kind === 'http' ? `http_${r.status}` : r.kind)
    const body = parseBody(r.text)
    if (body['ok'] !== true) throw new Error(asString(body['error']) ?? 'slack_error')
    for (const c of Array.isArray(body['channels']) ? (body['channels'] as Record<string, unknown>[]) : []) {
      const id = asString(c['id'])
      if (!id) continue
      channels.push({
        id,
        name: asString(c['name']) ?? id,
        is_private: c['is_private'] === true,
        is_archived: c['is_archived'] === true,
        is_member: c['is_member'] === true
      })
    }
    cursor = asString((body['response_metadata'] as Record<string, unknown> | undefined)?.['next_cursor']) ?? ''
    if (!cursor) break
  }
  channelCache = { token, at: Date.now(), channels }
  return channels
}

async function post(token: string | null, webhookUrl: string | null, channel: string, payload: Record<string, unknown>): Promise<HttpResult> {
  if (webhookUrl) {
    return integrationsHttp.fetchUrl(webhookUrl, { kind: 'write', method: 'POST', json: payload, pace: { key: `slack:hook:${channel}`, intervalMs: 1_100 } })
  }
  return integrationsHttp.fetch('https://slack.com/api/chat.postMessage', {
    kind: 'write',
    method: 'POST',
    headers: { Authorization: `Bearer ${token ?? ''}` },
    json: payload,
    pace: { key: `slack:channel:${channel}`, intervalMs: 1_100 }
  })
}

export const slack: ProviderClient = {
  id: 'slack',

  async validate(_ctx, token): Promise<ValidateResult> {
    const r = await integrationsHttp.fetch('https://slack.com/api/auth.test', {
      kind: 'read',
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      pace: { key: 'slack:read', intervalMs: 1_000 }
    })
    const unreachable: ValidateResult = { state: 'unreachable', accountLabel: null, detail: 'Couldn’t reach Slack. Check your connection and try again.' }
    if (!r.ok) {
      if (r.kind === 'http' && (r.status === 401 || r.status === 403)) return { state: 'invalid', accountLabel: null, detail: 'Slack didn’t accept this token. Check it and try again.' }
      return unreachable
    }
    const body = parseBody(r.text)
    if (body['ok'] === true) {
      const team = asString(body['team']) ?? 'Slack'
      return { state: 'connected', accountLabel: team, detail: null, meta: { teamId: asString(body['team_id']) ?? '' } }
    }
    const err = asString(body['error']) ?? ''
    if (AUTH_ERRORS.has(err)) return { state: 'invalid', accountLabel: null, detail: 'Slack didn’t accept this token. Check it and try again.' }
    return unreachable
  },

  async search(_ctx, q, token): Promise<IntegrationSearchResult[]> {
    const channels = await listChannels(token, !q.query)
    const needle = (q.query ?? '').trim().toLowerCase()
    return channels
      .filter((c) => !c.is_archived && (!c.is_private || c.is_member))
      .filter((c) => !needle || c.name.toLowerCase().includes(needle))
      .sort((a, b) => Number(b.is_member) - Number(a.is_member) || a.name.localeCompare(b.name))
      .slice(0, 500)
      .map((c) => ({
        provider: 'slack',
        kind: 'channel',
        id: c.id,
        label: c.name,
        subtitle: null,
        suggested: false,
        extra: { isPrivate: c.is_private, isMember: c.is_member }
      }))
  },

  async send(_ctx, job): Promise<SendOutcome> {
    const dest = job.destination
    if (!dest) return { ok: false, retry: 'never', code: 'no_destination', message: 'Pick a Slack channel first.' }
    const webhook = dest.kind === 'slack-webhook'
    if (webhook && !job.destinationSecret) return { ok: false, retry: 'never', code: 'no_webhook', message: 'This Slack webhook no longer works. Remove it and add a new one.' }
    if (!webhook && !job.credential) return { ok: false, retry: 'never', code: 'not_authed', message: 'Your Slack token isn’t working. Update it in Settings.' }
    const channel = webhook ? dest.id : dest.externalId ?? ''
    const title = noteTitle(job.note)
    const messages = buildMessages(job.content.markdown || job.content.text, title, previewDate(meetingStart(job.note)))
    const name = job.note.people?.creator?.name?.trim()
    let username: string | undefined = webhook ? undefined : name ? `${name} (with Notula)` : 'Notula'
    let first: string | null = null
    for (const m of messages) {
      const payload: Record<string, unknown> = webhook ? { text: m.text, blocks: m.blocks } : { channel, text: m.text, blocks: m.blocks, ...(username ? { username } : {}) }
      let r = await post(job.credential, webhook ? job.destinationSecret : null, channel, payload)
      // Without chat:write.customize, retry once without the username.
      if (!webhook && r.ok && username && asString(parseBody(r.text)['error']) === 'missing_scope') {
        username = undefined
        delete payload['username']
        r = await post(job.credential, null, channel, payload)
      }
      if (!r.ok) {
        if (r.kind === 'http') {
          const code = webhook ? r.text.trim().slice(0, 60) : asString(parseBody(r.text)['error']) ?? ''
          if (code && /^[a-z_]+$/.test(code) && r.status !== 429 && r.status < 500) return slackError(code, dest.label, webhook)
        }
        return failure(r, COPY)
      }
      if (!webhook) {
        const body = parseBody(r.text)
        if (body['ok'] !== true) {
          const code = asString(body['error']) ?? 'slack_error'
          log('warn', 'integrations:slack-error', { deliveryId: job.delivery.id, code })
          return slackError(code, dest.label, false)
        }
        first ??= `${channel}:${asString(body['ts']) ?? ''}`
      } else if (r.text.trim() !== 'ok') {
        return slackError(r.text.trim().slice(0, 60), dest.label, true)
      }
    }
    return { ok: true, externalId: first, externalUrl: null }
  }
}
