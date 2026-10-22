// SPDX-License-Identifier: Apache-2.0
// The integration layer: credentials
// and masked statuses, destinations, the outbox state machine (with `uncertain`), Undo
// through `scheduled` rows, and the local-only guard. The scheduler lives in scheduler.ts.
//
// Secrets never leave this module except into a provider request: replies carry masked
// values only, and log lines carry provider, delivery id, status, code and attempt.

import { randomUUID } from 'node:crypto'
import { net } from 'electron'
import { notulaError } from '@shared/errors'
import type { PushChannel } from '@shared/ipc'
import {
  INTEGRATION_POLICY,
  SLACK_WEBHOOK_PREFIX,
  ZAPIER_HOOK_PREFIX,
  type IntegrationCredentialInput,
  type IntegrationDelivery,
  type IntegrationDestination,
  type IntegrationDestinationInput,
  type IntegrationProvider,
  type IntegrationSearchQuery,
  type IntegrationSearchResult,
  type IntegrationShareContent,
  type IntegrationShareRequest,
  type IntegrationState,
  type IntegrationStatus
} from '@shared/types/integrations'
import type { Note } from '@shared/types/notes'
import { STRUCTURED_SECRET_PREFIX, type SecretId } from '@shared/types/settings'
import type { MainContext } from '../context'
import { expected } from '../ipc-expected'
import { log } from '../log'
import { egressBlocked, LOCAL_ONLY_REASON } from '../privacy'
import type { IntegrationPlugin, IntegrationSendOutcome } from '../integration-plugins'
import type { IntegrationDestinationRow, NewIntegrationDelivery } from '../storage/api'
import { contentFromMarkdown, latestSummaryPanel, panelMarkdown, sanitizeContent } from './content'
import { matchRecords } from './providers/attio'
import { affinity } from './providers/affinity'
import { attio } from './providers/attio'
import { hubspot } from './providers/hubspot'
import { notion } from './providers/notion'
import { slack } from './providers/slack'
import type { ProviderClient, SendOutcome, ValidateResult } from './providers/types'
import { zapier } from './providers/zapier'

/**
 * The providers this layer builds in. The plug-in providers (`salesforce`, `pipedrive`, `ashby`,
 * `dropbox`, `webhook`, `gmail`, `outlook`) are served through `ctx.integrationPlugins`: status and
 * validate, set-credential, search, share, the outbox executor, folder targets and disconnect all
 * consult the registered plug-in, inside this layer's outbox, ledger and local-only rules.
 */
export type BuiltInProvider = 'slack' | 'notion' | 'hubspot' | 'attio' | 'affinity' | 'zapier'
export const PROVIDERS: readonly BuiltInProvider[] = ['slack', 'notion', 'hubspot', 'attio', 'affinity', 'zapier']
const CLIENTS: Record<BuiltInProvider, ProviderClient> = { slack, notion, hubspot, attio, affinity, zapier }

type CredentialProvider = Exclude<BuiltInProvider, 'zapier'>
const CREDENTIAL: Record<CredentialProvider, { id: SecretId; kind: IntegrationCredentialInput['kind'] }> = {
  slack: { id: 'integration.slack.bot', kind: 'slack-bot-token' },
  notion: { id: 'integration.notion', kind: 'notion-token' },
  hubspot: { id: 'integration.hubspot', kind: 'hubspot-token' },
  attio: { id: 'integration.attio', kind: 'attio-token' },
  affinity: { id: 'integration.affinity', kind: 'affinity-key' }
}

export const LOCAL_ONLY_COPY = 'Integrations are off while Local-only mode is on.'
const DELIVERY_STATES_CANCELLABLE = new Set(['scheduled', 'pending'])

/** The stored credential: the value plus its last validation (a structured secret). */
interface StoredCredential {
  v: string
  state: Extract<IntegrationState, 'connected' | 'invalid' | 'unreachable'>
  label: string | null
  detail: string | null
  at: string | null
  meta?: Record<string, string>
}

function encode(c: StoredCredential): string {
  return STRUCTURED_SECRET_PREFIX + Buffer.from(JSON.stringify(c), 'utf8').toString('base64url')
}

function decode(raw: string | null): StoredCredential | null {
  if (!raw) return null
  if (!raw.startsWith(STRUCTURED_SECRET_PREFIX)) return { v: raw, state: 'connected', label: null, detail: null, at: null }
  try {
    const o = JSON.parse(Buffer.from(raw.slice(STRUCTURED_SECRET_PREFIX.length), 'base64url').toString('utf8')) as StoredCredential
    return typeof o?.v === 'string' && o.v ? o : null
  } catch {
    return null
  }
}

export function mask(value: string | null): string | null {
  return value ? `••••${value.slice(-4)}` : null
}

function bad(message: string): Error {
  return expected(notulaError('invalid-input', message))
}

export function isProvider(v: unknown): v is BuiltInProvider {
  return typeof v === 'string' && (PROVIDERS as readonly string[]).includes(v)
}

export function needProvider(v: unknown): BuiltInProvider {
  if (!isProvider(v)) throw bad('Unknown integration.')
  return v
}

/** A built-in provider, or one a plug-in is registered for. */
export function needAnyProvider(ctx: MainContext, v: unknown): IntegrationProvider {
  if (isProvider(v)) return v
  if (typeof v === 'string' && ctx.integrationPlugins.get(v as IntegrationProvider)) return v as IntegrationProvider
  throw bad('Unknown integration.')
}

/** A plug-in's executor outcome in the layer's terms (`uncertain` is never retried). */
function fromPlugin(o: IntegrationSendOutcome): SendOutcome {
  if (o.status === 'sent') return { ok: true, externalId: o.externalId ?? null, externalUrl: o.externalUrl ?? null }
  if (o.status === 'uncertain') return { ok: false, retry: 'uncertain', code: 'uncertain', message: o.errorMessage }
  return { ok: false, retry: o.retryable ? 'auto' : 'never', code: o.errorCode, message: o.errorMessage }
}

type PluginState = Pick<IntegrationStatus, 'state' | 'accountLabel' | 'detail'> & { at: string | null }

function hookSecretId(d: Pick<IntegrationDestination, 'id' | 'kind'>): SecretId | null {
  if (d.kind === 'slack-webhook') return `integration.slack.webhook.${d.id}`
  if (d.kind === 'zapier-hook') return `integration.zapier.hook.${d.id}`
  return null
}

/** A user-pasted URL with the provider's prefix, nothing else around it. */
function hookUrl(value: unknown, prefix: string, copy: string): string {
  const v = typeof value === 'string' ? value.trim() : ''
  let ok = v.startsWith(prefix) && v.length <= 2_000
  try {
    const u = new URL(v)
    ok &&= u.protocol === 'https:' && !u.username && !u.password && !u.hash
  } catch {
    ok = false
  }
  if (!ok) throw bad(copy)
  return v
}

export interface DeliveryEvents {
  onDelivery(d: IntegrationDelivery): void
}

export class IntegrationsService {
  /** Content handed over by a manual send, kept while its rows are open (never stored). */
  private readonly contents = new Map<string, IntegrationShareContent>()
  private readonly checking = new Set<IntegrationProvider>()
  private readonly running = new Set<string>()
  /** Each plug-in's last validation, for this app session. */
  private readonly pluginStates = new Map<IntegrationProvider, PluginState>()
  wake: (atMs?: number) => void = () => {}

  constructor(private readonly ctx: MainContext) {}

  // ---------- pushes ----------

  pushChanged(provider: IntegrationProvider): void {
    for (const wc of this.ctx.windows.targets()) wc.send('integrations:changed' satisfies PushChannel, { provider })
  }

  pushDelivery(d: IntegrationDelivery): void {
    for (const wc of this.ctx.windows.targets()) wc.send('integrations:delivery' satisfies PushChannel, d)
  }

  localOnly(): Promise<boolean> {
    return egressBlocked(this.ctx, { kind: 'integration' })
  }

  // ---------- credentials and status ----------

  private async stored(p: BuiltInProvider): Promise<StoredCredential | null> {
    if (p === 'zapier') return null
    return decode(await this.ctx.secrets.get(CREDENTIAL[p].id))
  }

  async credential(p: BuiltInProvider): Promise<string | null> {
    return (await this.stored(p))?.v ?? null
  }

  plugin(p: IntegrationProvider): IntegrationPlugin | null {
    return isProvider(p) ? null : this.ctx.integrationPlugins.get(p)
  }

  /** The cached validation, else one now (a plug-in answers from its stored state when it can). */
  private async pluginStatus(p: IntegrationProvider, fresh: boolean): Promise<IntegrationStatus> {
    const plugin = this.plugin(p)
    const blockedByLocalOnly = await this.localOnly()
    let st = this.pluginStates.get(p) ?? null
    if (plugin && (fresh || !st) && !this.checking.has(p)) {
      this.checking.add(p)
      try {
        const r = await plugin.validate(this.ctx)
        st = { state: r.state, accountLabel: r.accountLabel, detail: r.detail, at: new Date().toISOString() }
      } catch {
        st = { state: 'unreachable', accountLabel: st?.accountLabel ?? null, detail: null, at: new Date().toISOString() }
      } finally {
        this.checking.delete(p)
      }
      this.pluginStates.set(p, st)
    }
    const state = !plugin ? 'not_configured' : this.checking.has(p) ? 'checking' : (st?.state ?? 'not_configured')
    return {
      provider: p,
      state,
      accountLabel: plugin ? (st?.accountLabel ?? null) : null,
      maskedCredential: null,
      lastValidatedAt: st?.at ?? null,
      detail: blockedByLocalOnly && state !== 'not_configured' ? LOCAL_ONLY_COPY : (st?.detail ?? null),
      blockedByLocalOnly
    }
  }

  async status(p: IntegrationProvider): Promise<IntegrationStatus> {
    if (!isProvider(p)) return this.pluginStatus(p, false)
    const blockedByLocalOnly = await this.localOnly()
    const base = { provider: p, blockedByLocalOnly }
    if (p === 'zapier' || (p === 'slack' && (await this.ctx.settings.get('integrations.slack.mode')) === 'webhook')) {
      const kind = p === 'zapier' ? 'zapier-hook' : 'slack-webhook'
      const dests = (await this.ctx.storage.listIntegrationDestinations({ provider: p })).filter((d) => d.kind === kind)
      const n = dests.length
      return {
        ...base,
        state: n ? 'connected' : 'not_configured',
        accountLabel: n ? `${n} ${p === 'zapier' ? (n === 1 ? 'workflow' : 'workflows') : n === 1 ? 'channel' : 'channels'}` : null,
        maskedCredential: null,
        lastValidatedAt: null,
        detail: blockedByLocalOnly ? LOCAL_ONLY_COPY : null
      }
    }
    const c = await this.stored(p)
    if (!c) return { ...base, state: 'not_configured', accountLabel: null, maskedCredential: null, lastValidatedAt: null, detail: null }
    return {
      ...base,
      state: this.checking.has(p) ? 'checking' : c.state,
      accountLabel: c.label,
      maskedCredential: mask(c.v),
      lastValidatedAt: c.at,
      detail: blockedByLocalOnly ? LOCAL_ONLY_COPY : c.detail
    }
  }

  async statuses(p?: IntegrationProvider): Promise<IntegrationStatus[]> {
    return Promise.all((p ? [p] : PROVIDERS).map((x) => this.status(x)))
  }

  async setCredential(input: IntegrationCredentialInput): Promise<IntegrationStatus> {
    const plugin = this.plugin(needAnyProvider(this.ctx, input?.provider))
    if (plugin) {
      if (!plugin.setCredential || !plugin.credentialKinds.includes(input.kind)) throw bad('That credential doesn’t belong to this integration.')
      await plugin.setCredential(this.ctx, input)
      log('info', 'integrations:credential-saved', { provider: plugin.provider })
      if (await this.localOnly()) {
        log('info', 'integrations:validate-skipped', { provider: plugin.provider, reason: LOCAL_ONLY_REASON })
        this.pushChanged(plugin.provider)
        return this.status(plugin.provider)
      }
      await this.ctx.storage.setIntegrationAutomationsEnabled(plugin.provider, true).catch(() => 0)
      return this.validate(plugin.provider)
    }
    const p = needProvider(input?.provider)
    if (p === 'zapier') throw bad('Zapier workflows are added as Catch Hook URLs.')
    if (input.kind !== CREDENTIAL[p].kind) throw bad('That credential doesn’t belong to this integration.')
    const value = typeof input.value === 'string' ? input.value.trim() : ''
    if (!value) throw bad('Paste your credential first.')
    if (!/^[\x21-\x7E]{8,4000}$/.test(value)) throw bad('That doesn’t look like a valid credential. Copy it again and paste only the credential.')
    if (p === 'slack' && !value.startsWith('xoxb-')) throw bad('Paste the Bot User OAuth Token. It starts with xoxb-.')
    await this.save(p, { v: value, state: 'unreachable', label: null, detail: null, at: null })
    log('info', 'integrations:credential-saved', { provider: p })
    if (await this.localOnly()) {
      log('info', 'integrations:validate-skipped', { provider: p, reason: LOCAL_ONLY_REASON })
      this.pushChanged(p)
      return this.status(p)
    }
    // Re-enable rules a disconnect turned off, now that there is a credential again.
    await this.ctx.storage.setIntegrationAutomationsEnabled(p, true).catch(() => 0)
    return this.validate(p)
  }

  private async save(p: CredentialProvider, c: StoredCredential): Promise<void> {
    await this.ctx.secrets.set(CREDENTIAL[p].id, encode(c))
  }

  async validate(p: IntegrationProvider): Promise<IntegrationStatus> {
    if (!isProvider(p)) {
      if (await this.localOnly()) {
        log('info', 'integrations:validate-skipped', { provider: p, reason: LOCAL_ONLY_REASON })
        return this.status(p)
      }
      const st = await this.pluginStatus(p, true)
      log('info', 'integrations:validated', { provider: p, state: st.state })
      this.pushChanged(p)
      return st
    }
    if (p === 'zapier' || this.checking.has(p)) return this.status(p)
    const c = await this.stored(p)
    if (!c) return this.status(p)
    if (await this.localOnly()) {
      log('info', 'integrations:validate-skipped', { provider: p, reason: LOCAL_ONLY_REASON })
      return this.status(p)
    }
    this.checking.add(p)
    this.pushChanged(p)
    let r: ValidateResult
    try {
      r = await CLIENTS[p].validate(this.ctx, c.v)
    } catch {
      r = { state: 'unreachable', accountLabel: null, detail: null }
    } finally {
      this.checking.delete(p)
    }
    const latest = await this.stored(p)
    // The credential changed or was removed while the check ran: keep the newer one.
    if (latest?.v === c.v) {
      await this.save(p, { v: c.v, state: r.state, label: r.accountLabel ?? (r.state === 'unreachable' ? c.label : null), detail: r.detail, at: new Date().toISOString(), meta: r.meta ?? c.meta })
      if (p === 'affinity' && r.state === 'connected' && r.meta?.['domain'] !== undefined) {
        await this.ctx.settings.set('integrations.affinity.domain', r.meta['domain'] ?? '')
      }
    }
    log('info', 'integrations:validated', { provider: p, state: r.state })
    this.pushChanged(p)
    return this.status(p)
  }

  /** Removal: a provider's secrets and destinations go, its rules are disabled; or one destination. */
  async remove(p: IntegrationProvider, destinationId?: string): Promise<void> {
    if (!isProvider(p)) {
      if (!destinationId) {
        await this.plugin(p)?.disconnect(this.ctx)
        await this.ctx.storage.setIntegrationAutomationsEnabled(p, false)
        this.pluginStates.delete(p)
      }
      const { deleted } = await this.ctx.storage.deleteIntegrationDestinations(destinationId ? { provider: p, id: destinationId } : { provider: p })
      log('info', 'integrations:removed', { provider: p, destinations: deleted.length, all: !destinationId })
      this.pushChanged(p)
      return
    }
    const { deleted } = await this.ctx.storage.deleteIntegrationDestinations(destinationId ? { provider: p, id: destinationId } : { provider: p })
    for (const d of deleted) {
      const sid = hookSecretId(d)
      if (sid) await this.ctx.secrets.clear(sid)
    }
    if (!destinationId) {
      if (p !== 'zapier') await this.ctx.secrets.clear(CREDENTIAL[p].id)
      await this.ctx.storage.setIntegrationAutomationsEnabled(p, false)
      if (p === 'affinity') await this.ctx.settings.set('integrations.affinity.domain', '')
      if (p === 'zapier') await this.ctx.settings.set('integrations.zapier.folderRunIds', [])
    }
    log('info', 'integrations:removed', { provider: p, destinations: deleted.length, all: !destinationId })
    this.pushChanged(p)
  }

  // ---------- destinations ----------

  private async publicDestination(d: IntegrationDestinationRow): Promise<IntegrationDestination> {
    const { secret_id: sid, ...rest } = d
    let masked: string | null = null
    if (sid) masked = mask(await this.ctx.secrets.get(sid as SecretId).catch(() => null))
    return { ...rest, maskedSecret: masked }
  }

  async listDestinations(p: IntegrationProvider): Promise<IntegrationDestination[]> {
    const rows = await this.ctx.storage.listIntegrationDestinations({ provider: p })
    return Promise.all(rows.map((d) => this.publicDestination(d)))
  }

  async saveDestination(input: IntegrationDestinationInput): Promise<IntegrationDestination> {
    const p = needProvider(input?.provider)
    const kinds: Record<BuiltInProvider, IntegrationDestination['kind'][]> = {
      slack: ['slack-channel', 'slack-webhook'],
      notion: ['notion-target'],
      zapier: ['zapier-hook'],
      hubspot: [],
      attio: [],
      affinity: []
    }
    if (!kinds[p].includes(input.kind)) throw bad('This integration has no such destination.')
    const label = typeof input.label === 'string' ? input.label.trim().slice(0, 200) : ''
    const existing = input.id
      ? (await this.ctx.storage.listIntegrationDestinations({ provider: p, ids: [input.id] }))[0]
      : input.kind === 'slack-channel'
        ? (await this.ctx.storage.listIntegrationDestinations({ provider: 'slack' })).find((d) => d.kind === 'slack-channel' && d.externalId === input.externalId)
        : undefined
    if (input.id && !existing) throw expected(notulaError('not-found', 'That destination no longer exists.'))
    const id = existing?.id ?? randomUUID()
    const sid = hookSecretId({ id, kind: input.kind })
    let secret: string | null = null
    if (input.kind === 'slack-webhook') {
      if (!label.replace(/^#/, '')) throw bad('Enter the channel’s name.')
      if (input.secretValue !== undefined || !existing) {
        secret = hookUrl(input.secretValue, SLACK_WEBHOOK_PREFIX, `Paste a Slack webhook URL. It starts with ${SLACK_WEBHOOK_PREFIX}`)
      }
    } else if (input.kind === 'zapier-hook') {
      if (input.secretValue !== undefined || !existing) {
        secret = hookUrl(input.secretValue, ZAPIER_HOOK_PREFIX, `Paste a Zapier Catch Hook URL. It starts with ${ZAPIER_HOOK_PREFIX}`)
      }
      if (input.trigger !== 'share' && input.trigger !== 'folder') throw bad('Choose when this workflow runs.')
    } else {
      if (typeof input.externalId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(input.externalId)) throw bad('Pick a destination first.')
    }
    const o = input.options ?? {}
    const options: IntegrationDestination['options'] =
      input.kind === 'notion-target'
        ? {
            notionTargetType: o.notionTargetType === 'data_source' ? 'data_source' : 'page',
            ...(typeof o.notionTitleProperty === 'string' ? { notionTitleProperty: o.notionTitleProperty.slice(0, 200) } : {}),
            notionDateProperty: typeof o.notionDateProperty === 'string' && o.notionDateProperty ? o.notionDateProperty.slice(0, 200) : null,
            ...(typeof o.notionUrl === 'string' && /^https:\/\/(www\.)?notion\.so\//.test(o.notionUrl) ? { notionUrl: o.notionUrl } : {})
          }
        : input.kind === 'slack-channel'
          ? { slackIsPrivate: o.slackIsPrivate === true }
          : input.kind === 'zapier-hook'
            ? { zapierIncludeTranscript: o.zapierIncludeTranscript === true }
            : {}
    if (secret && sid) await this.ctx.secrets.set(sid, secret)
    const row = await this.ctx.storage.upsertIntegrationDestination({
      id,
      provider: p,
      kind: input.kind,
      label: input.kind === 'slack-webhook' || input.kind === 'slack-channel' ? label.replace(/^#/, '') || label : label || existing?.label || 'Untitled workflow',
      externalId: input.kind === 'notion-target' || input.kind === 'slack-channel' ? (input.externalId ?? null) : null,
      trigger: input.kind === 'zapier-hook' ? (input.trigger ?? 'share') : null,
      // A new URL or target revives a disconnected destination.
      status: secret || input.kind === 'notion-target' ? 'ok' : existing?.status ?? 'ok',
      lastError: secret ? null : existing?.lastError ?? null,
      options,
      maskedSecret: null,
      secret_id: sid,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString()
    })
    if (input.kind === 'notion-target') {
      // One target: the new pick replaces any other.
      for (const d of await this.ctx.storage.listIntegrationDestinations({ provider: 'notion' })) {
        if (d.id !== row.id) await this.ctx.storage.deleteIntegrationDestinations({ provider: 'notion', id: d.id })
      }
    }
    log('info', 'integrations:destination-saved', { provider: p, kind: input.kind, destinationId: row.id })
    this.pushChanged(p)
    return this.publicDestination(row)
  }

  /** Bot-mode channels become destinations the first time a note goes there. */
  private async channelDestination(channelId: string, label: string): Promise<IntegrationDestinationRow> {
    const all = await this.ctx.storage.listIntegrationDestinations({ provider: 'slack' })
    const hit = all.find((d) => d.kind === 'slack-channel' && d.externalId === channelId)
    if (hit && (!label || hit.label === label.replace(/^#/, ''))) return hit
    await this.saveDestination({ id: hit?.id, provider: 'slack', kind: 'slack-channel', label: label || hit?.label || channelId, externalId: channelId })
    const again = await this.ctx.storage.listIntegrationDestinations({ provider: 'slack' })
    const row = again.find((d) => d.kind === 'slack-channel' && d.externalId === channelId)
    if (!row) throw expected(notulaError('internal', 'Couldn’t save the Slack channel.'))
    return row
  }

  // ---------- search ----------

  async search(q: IntegrationSearchQuery): Promise<IntegrationSearchResult[]> {
    const any = needAnyProvider(this.ctx, q?.provider)
    if (await this.localOnly()) {
      log('info', 'integrations:search-skipped', { provider: any, reason: LOCAL_ONLY_REASON })
      throw bad(LOCAL_ONLY_COPY)
    }
    const plugin = this.plugin(any)
    if (plugin) {
      if (!plugin.search) return []
      const query = typeof q.query === 'string' ? q.query.slice(0, 256) : undefined
      return plugin.search(this.ctx, {
        provider: any,
        ...(query !== undefined ? { query } : {}),
        ...(typeof q.noteId === 'string' ? { noteId: q.noteId } : {}),
        ...(Array.isArray(q.kinds) ? { kinds: q.kinds } : {})
      })
    }
    const p = needProvider(any)
    const client = CLIENTS[p]
    if (!client.search) return []
    const cred = await this.credential(p)
    if (!cred) throw expected(notulaError('missing-key', 'Connect this integration in Settings first.'))
    const query = typeof q.query === 'string' ? q.query.slice(0, 256) : undefined
    try {
      return await client.search(this.ctx, { provider: p, ...(query !== undefined ? { query } : {}), ...(typeof q.noteId === 'string' ? { noteId: q.noteId } : {}) }, cred)
    } catch (err) {
      const code = err instanceof Error ? err.message.slice(0, 40) : 'error'
      log('warn', 'integrations:search-failed', { provider: p, code })
      if (code === 'http_401' || code === 'http_403') throw expected(notulaError('provider-error', 'Your credential isn’t working. Update it in Settings.'))
      if (code === 'org_cap') throw expected(notulaError('provider-error', 'Your Affinity account has reached its monthly API limit.'))
      throw expected(notulaError('provider-error', 'Couldn’t search records right now. Try again in a moment.'))
    }
  }

  // ---------- share ----------

  private async contentFor(note: Note, panelId: string | null): Promise<{ content: IntegrationShareContent; panelId: string | null } | null> {
    const panels = await this.ctx.storage.listPanels(note.id)
    const panel = (panelId ? panels.find((p) => p.id === panelId && !p.deleted_at) : null) ?? latestSummaryPanel(panels)
    const md = panelMarkdown(panel ?? null)
    return panel && md ? { content: contentFromMarkdown(md), panelId: panel.id } : null
  }

  async share(req: IntegrationShareRequest): Promise<{ deliveryIds: string[] }> {
    const any = needAnyProvider(this.ctx, req?.provider)
    if (typeof req.noteId !== 'string' || !req.noteId) throw bad('noteId is required.')
    if (await this.localOnly()) {
      log('info', 'integrations:share-blocked', { provider: any, reason: LOCAL_ONLY_REASON })
      throw bad(LOCAL_ONLY_COPY)
    }
    const plugin = this.plugin(any)
    if (plugin) return this.sharePlugin(plugin, req)
    const p = needProvider(any)
    const note = await this.ctx.storage.getNote(req.noteId)
    if (!note) throw expected(notulaError('not-found', 'This note no longer exists.'))
    const panelId = typeof req.panelId === 'string' && req.panelId ? req.panelId : null
    const given = sanitizeContent(req.content)
    const resolved = given ? { content: given, panelId } : await this.contentFor(note, panelId)
    if (!resolved) throw bad('This note has no summary to send yet.')
    if (p !== 'zapier' && !(p === 'slack' && (await this.ctx.settings.get('integrations.slack.mode')) === 'webhook') && !(await this.credential(p))) {
      throw expected(notulaError('missing-key', 'Connect this integration in Settings first.'))
    }
    const targets = Array.isArray(req.targets) ? req.targets.filter((t) => t && typeof t.id === 'string' && t.id && t.id.length <= 200).slice(0, 50) : []
    const destIds = Array.isArray(req.destinationIds) ? req.destinationIds.filter((x): x is string => typeof x === 'string').slice(0, 50) : []
    const policyDelay = p === 'attio' ? INTEGRATION_POLICY.undoMs.attio : p === 'zapier' ? INTEGRATION_POLICY.undoMs.zapier : 0
    const delay = typeof req.delayMs === 'number' && Number.isFinite(req.delayMs) ? Math.max(0, Math.min(15_000, Math.round(req.delayMs))) : policyDelay
    const due = new Date(Date.now() + delay).toISOString()
    const base: Omit<NewIntegrationDelivery, 'destinationId' | 'targetKey'> = {
      provider: p,
      automationId: null,
      noteId: note.id,
      panelId: resolved.panelId,
      trigger: 'manual',
      status: delay > 0 ? 'scheduled' : 'pending',
      nextAttemptAt: due
    }
    const rows: NewIntegrationDelivery[] = []
    if (p === 'slack' || p === 'zapier') {
      const all = await this.ctx.storage.listIntegrationDestinations({ provider: p })
      for (const id of destIds) {
        const d = all.find((x) => x.id === id)
        if (!d) throw expected(notulaError('not-found', 'That destination no longer exists.'))
        if (p === 'zapier' && d.trigger !== 'share') throw bad('This workflow runs for folders, not from the Share menu.')
        rows.push({ ...base, destinationId: d.id, targetKey: d.externalId ?? '' })
      }
      if (p === 'slack') {
        for (const t of targets.filter((t) => t.kind === 'channel')) {
          if (!/^[A-Z0-9]{1,30}$/i.test(t.id)) throw bad('Pick a Slack channel.')
          const d = await this.channelDestination(t.id, String(t.label ?? ''))
          rows.push({ ...base, destinationId: d.id, targetKey: t.id })
        }
      }
    } else if (p === 'notion') {
      const d = (await this.ctx.storage.listIntegrationDestinations({ provider: 'notion' }))[0]
      if (!d) throw bad('Pick where Notula saves notes in Settings first.')
      rows.push({ ...base, destinationId: d.id, targetKey: d.externalId ?? '' })
    } else if (p === 'attio') {
      for (const t of targets) {
        if (!/^(people|companies|deals):[A-Za-z0-9-]{1,80}$/.test(t.id)) throw bad('Pick Attio records to save to.')
        rows.push({ ...base, destinationId: null, targetKey: t.id })
      }
    } else {
      const allowed = p === 'hubspot' ? ['contact', 'company', 'deal'] : ['person', 'organization']
      const parts = targets.filter((t) => allowed.includes(t.kind) && /^\d{1,30}$/.test(t.id)).map((t) => `${t.kind}:${t.id}`)
      if (!parts.length) throw bad(p === 'affinity' ? 'Choose a person or an organization in Affinity first' : 'Pick HubSpot records to save to.')
      rows.push({ ...base, destinationId: null, targetKey: parts.join(',') })
    }
    if (!rows.length) throw bad('Pick where to send this note.')
    const created = await this.ctx.storage.createIntegrationDeliveries(rows)
    for (const d of created) {
      this.contents.set(d.id, resolved.content)
      this.pushDelivery(d)
    }
    log('info', 'integrations:share', { provider: p, deliveries: created.length, delayMs: delay })
    if (delay > 0) this.wake(Date.now() + delay)
    else for (const d of created) await this.process(d.id)
    return { deliveryIds: created.map((d) => d.id) }
  }

  /** The plug-in maps the request to deliveries; they join this outbox like any other. */
  private async sharePlugin(plugin: IntegrationPlugin, req: IntegrationShareRequest): Promise<{ deliveryIds: string[] }> {
    if (!plugin.share) throw bad('This integration can’t send notes from here.')
    const note = await this.ctx.storage.getNote(req.noteId)
    if (!note) throw expected(notulaError('not-found', 'This note no longer exists.'))
    const rows = (await plugin.share(this.ctx, req)).slice(0, 100)
    if (!rows.length) throw bad('Pick where to send this note.')
    const given = sanitizeContent(req.content)
    const created = await this.ctx.storage.createIntegrationDeliveries(rows.map((r) => ({ ...r, provider: plugin.provider, noteId: r.noteId || note.id })))
    for (const d of created) {
      if (given) this.contents.set(d.id, given)
      this.pushDelivery(d)
    }
    log('info', 'integrations:share', { provider: plugin.provider, deliveries: created.length })
    for (const d of created) {
      if (d.status === 'scheduled' && d.nextAttemptAt) this.wake(Date.parse(d.nextAttemptAt) || Date.now())
    }
    for (const d of created) if (d.status === 'pending') await this.process(d.id)
    return { deliveryIds: created.map((d) => d.id) }
  }

  /** Content handed over with a plug-in share (never stored), for its executor. */
  shareContent(deliveryId: string): IntegrationShareContent | null {
    return this.contents.get(deliveryId) ?? null
  }

  /**
   * `ctx.integrations.folderSend`: the provider's folder path for notes the user picked
   * (Customer calls "Sync <n> notes"). User-initiated, so `trigger` is `manual` and no run row is
   * claimed; at most 100 notes per call.
   */
  async folderSend(q: { provider: IntegrationProvider; folderId: string; noteIds: string[] }): Promise<{ deliveryIds: string[] }> {
    const p = needAnyProvider(this.ctx, q?.provider)
    if (typeof q.folderId !== 'string' || !q.folderId) throw bad('folderId is required.')
    const noteIds = Array.isArray(q.noteIds) ? [...new Set(q.noteIds.filter((x): x is string => typeof x === 'string' && !!x))].slice(0, 100) : []
    if (!noteIds.length) return { deliveryIds: [] }
    if (await this.localOnly()) {
      log('info', 'integrations:share-blocked', { provider: p, reason: LOCAL_ONLY_REASON })
      throw bad(LOCAL_ONLY_COPY)
    }
    const a = (await this.ctx.storage.listIntegrationAutomations({ folderId: q.folderId, provider: p })).find((x) => x.enabled)
    if (!a) throw bad('This folder isn’t connected to that integration.')
    const plugin = this.plugin(p)
    if (plugin && !plugin.folderTargets) throw bad('This integration has no folder sync.')
    const rows: NewIntegrationDelivery[] = []
    for (const noteId of noteIds) {
      const panel = latestSummaryPanel(await this.ctx.storage.listPanels(noteId))
      const base = { provider: p, automationId: a.id, noteId, panelId: panel?.id ?? null, trigger: 'manual' as const, status: 'pending' as const, nextAttemptAt: new Date().toISOString() }
      if (plugin?.folderTargets) {
        for (const r of await plugin.folderTargets(this.ctx, noteId, a)) rows.push({ ...r, provider: p, noteId, automationId: a.id, trigger: 'manual' })
      } else if (p === 'slack' || p === 'zapier') {
        const dest = panel && a.destinationId ? (await this.ctx.storage.listIntegrationDestinations({ ids: [a.destinationId] }))[0] : undefined
        if (dest) rows.push({ ...base, destinationId: dest.id, targetKey: dest.externalId ?? '' })
      } else if (p === 'attio') {
        const token = panel ? await this.credential('attio') : null
        const note = token ? await this.ctx.storage.getNote(noteId) : null
        if (!token || !note) continue
        const types = a.options.objectTypes?.length ? a.options.objectTypes : ['companies' as const]
        for (const m of await matchRecords(this.ctx, note, token, types, 50)) rows.push({ ...base, destinationId: null, targetKey: m.id })
      }
    }
    if (!rows.length) return { deliveryIds: [] }
    const created = await this.ctx.storage.createIntegrationDeliveries(rows)
    for (const d of created) this.pushDelivery(d)
    log('info', 'integrations:folder-send', { provider: p, notes: noteIds.length, deliveries: created.length })
    for (const d of created) await this.process(d.id)
    return { deliveryIds: created.map((d) => d.id) }
  }

  async testDestination(destinationId: string): Promise<IntegrationDelivery> {
    if (typeof destinationId !== 'string' || !destinationId) throw bad('destinationId is required.')
    const d = (await this.ctx.storage.listIntegrationDestinations({ ids: [destinationId] }))[0]
    if (!d || (d.kind !== 'zapier-hook' && d.kind !== 'slack-webhook')) throw expected(notulaError('not-found', 'That destination no longer exists.'))
    if (await this.localOnly()) throw bad(LOCAL_ONLY_COPY)
    // The most recent summarized note.
    const page = await this.ctx.storage.listNotes({ scope: 'own', limit: 25 })
    let picked: { note: Note; content: IntegrationShareContent; panelId: string | null } | null = null
    for (const item of page.items) {
      const note = await this.ctx.storage.getNote(item.id)
      const c = note ? await this.contentFor(note, null) : null
      if (note && c) {
        picked = { note, ...c }
        break
      }
    }
    if (!picked) throw bad('Summarize a note first, then send a test.')
    const content = d.kind === 'slack-webhook' ? contentFromMarkdown('Test message from Notula. Notes you send to this channel will look like this.') : picked.content
    const [row] = await this.ctx.storage.createIntegrationDeliveries([
      {
        provider: d.provider,
        destinationId: d.id,
        automationId: null,
        noteId: picked.note.id,
        panelId: picked.panelId,
        targetKey: '',
        trigger: 'test',
        status: 'pending',
        nextAttemptAt: new Date().toISOString()
      }
    ])
    if (!row) throw expected(notulaError('internal', 'Couldn’t start the test.'))
    this.contents.set(row.id, content)
    this.pushDelivery(row)
    await this.process(row.id)
    return this.row(row.id)
  }

  // ---------- the state machine ----------

  row(id: string): Promise<IntegrationDelivery> {
    return this.ctx.storage.updateIntegrationDelivery(id, {})
  }

  private async update(id: string, patch: Parameters<MainContext['storage']['updateIntegrationDelivery']>[1]): Promise<IntegrationDelivery> {
    const d = await this.ctx.storage.updateIntegrationDelivery(id, patch)
    this.pushDelivery(d)
    return d
  }

  async cancel(id: string): Promise<IntegrationDelivery> {
    if (typeof id !== 'string' || !id) throw bad('deliveryId is required.')
    const d = await this.row(id)
    if (!DELIVERY_STATES_CANCELLABLE.has(d.status) || this.running.has(id)) throw bad('This was already sent or is being sent.')
    this.contents.delete(id)
    log('info', 'integrations:cancelled', { provider: d.provider, deliveryId: id })
    return this.update(id, { status: 'cancelled', nextAttemptAt: null })
  }

  async retry(id: string): Promise<IntegrationDelivery> {
    if (typeof id !== 'string' || !id) throw bad('deliveryId is required.')
    const d = await this.row(id)
    if (!['failed', 'uncertain', 'cancelled'].includes(d.status)) throw bad('This doesn’t need a retry.')
    if (await this.localOnly()) throw bad(LOCAL_ONLY_COPY)
    await this.update(id, { status: 'pending', nextAttemptAt: new Date().toISOString(), errorCode: null, errorMessage: null })
    await this.process(id)
    return this.row(id)
  }

  /** One attempt at a due delivery. Never throws. */
  async process(id: string): Promise<void> {
    if (this.running.has(id)) return
    this.running.add(id)
    try {
      await this.attempt(id)
    } catch (err) {
      log('error', 'integrations:process-failed', { deliveryId: id, err: err instanceof Error ? err.name : 'error' })
    } finally {
      this.running.delete(id)
    }
  }

  private async attempt(id: string): Promise<void> {
    const d = await this.row(id)
    if (!['scheduled', 'pending', 'failed'].includes(d.status) || !d.nextAttemptAt) return
    if (Date.parse(d.nextAttemptAt) > Date.now() + 500) return
    if (await this.localOnly()) {
      log('info', 'integrations:held', { provider: d.provider, deliveryId: id, reason: LOCAL_ONLY_REASON })
      if (d.status === 'scheduled') await this.update(id, { status: 'pending' })
      return
    }
    if (!net.isOnline()) {
      log('info', 'integrations:held', { provider: d.provider, deliveryId: id, reason: 'offline' })
      return
    }
    const note = await this.ctx.storage.getNote(d.noteId)
    if (!note) {
      this.contents.delete(id)
      await this.update(id, { status: 'cancelled', nextAttemptAt: null, errorCode: 'note_deleted', errorMessage: null })
      return
    }
    // A plug-in's `destination_id` may name its own record (a webhook endpoint, a mail account).
    const plugin = this.plugin(d.provider)
    if (plugin) {
      await this.attemptPlugin(plugin, d)
      return
    }
    const dest = d.destinationId ? (await this.ctx.storage.listIntegrationDestinations({ ids: [d.destinationId] }))[0] ?? null : null
    if (d.destinationId && !dest) {
      await this.update(id, { status: 'failed', nextAttemptAt: null, errorCode: 'destination_removed', errorMessage: 'This destination was removed.' })
      return
    }
    const cached = this.contents.get(id)
    const content = cached ?? (await this.contentFor(note, d.panelId))?.content ?? null
    if (!content) {
      await this.update(id, { status: 'failed', nextAttemptAt: null, errorCode: 'no_content', errorMessage: 'This note has no summary to send.' })
      return
    }
    const attempts = d.attempts + 1
    await this.update(id, { status: 'sending', attempts })
    const sid = dest?.secret_id ? (dest.secret_id as SecretId) : null
    const [credential, destinationSecret] = await Promise.all([isProvider(d.provider) ? this.credential(d.provider) : Promise.resolve(null), sid ? this.ctx.secrets.get(sid) : Promise.resolve(null)])
    let out: SendOutcome
    try {
      if (!isProvider(d.provider)) throw new Error('no built-in client')
      out = await CLIENTS[d.provider].send(this.ctx, { delivery: d, destination: dest, note, content, credential, destinationSecret, test: d.trigger === 'test' })
    } catch {
      // A thrown client error after `sending` cannot prove nothing left: uncertain.
      out = { ok: false, retry: 'uncertain', code: 'client_error', message: 'Notula can’t tell whether this arrived. Check, then try again if it’s missing.' }
    }
    await this.settle(d, attempts, out, dest)
  }

  /** A plug-in's executor inside this policy: one attempt with a 60 s cap, the same ledger. */
  private async attemptPlugin(plugin: IntegrationPlugin, d: IntegrationDelivery): Promise<void> {
    const attempts = d.attempts + 1
    const row = await this.update(d.id, { status: 'sending', attempts })
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), 60_000)
    let out: SendOutcome
    try {
      out = fromPlugin(await plugin.send(this.ctx, row, ctl.signal))
    } catch {
      // A thrown executor after `sending` cannot prove nothing left: uncertain.
      out = { ok: false, retry: 'uncertain', code: 'client_error', message: 'Notula can’t tell whether this arrived. Check, then try again if it’s missing.' }
    } finally {
      clearTimeout(timer)
    }
    await this.settle(d, attempts, out, null)
  }

  /** The outcome of one attempt into the row: sent, a scheduled retry, failed or uncertain. */
  private async settle(d: IntegrationDelivery, attempts: number, out: SendOutcome, dest: IntegrationDestinationRow | null): Promise<void> {
    const id = d.id
    const now = new Date().toISOString()
    if (out.ok) {
      this.contents.delete(id)
      await this.update(id, { status: 'sent', nextAttemptAt: null, sentAt: now, externalId: out.externalId ?? null, externalUrl: out.externalUrl ?? null, errorCode: null, errorMessage: null })
      if (dest && dest.status !== 'ok') await this.markDestination(dest, 'ok', null)
      log('info', 'integrations:sent', { provider: d.provider, deliveryId: id, attempt: attempts })
      return
    }
    if (out.disconnect && dest) await this.markDestination(dest, 'disconnected', out.message)
    const schedule = INTEGRATION_POLICY.scheduleRetriesMs
    const auto = out.retry === 'auto' && d.provider !== 'notion' && attempts <= schedule.length
    const wait = auto ? Math.max(schedule[attempts - 1] ?? 0, out.retryAfterMs ?? 0) : 0
    await this.update(id, {
      status: out.retry === 'uncertain' ? 'uncertain' : 'failed',
      nextAttemptAt: auto ? new Date(Date.now() + wait).toISOString() : null,
      errorCode: out.code.slice(0, 60),
      errorMessage: out.message
    })
    if (out.retry !== 'auto' || !auto) this.contents.delete(id)
    log(out.retry === 'uncertain' ? 'warn' : 'info', 'integrations:not-sent', { provider: d.provider, deliveryId: id, attempt: attempts, code: out.code.slice(0, 60), outcome: out.retry })
    if (auto) this.wake(Date.now() + wait)
  }

  private async markDestination(d: IntegrationDestinationRow, status: IntegrationDestination['status'], lastError: string | null): Promise<void> {
    await this.ctx.storage.upsertIntegrationDestination({ ...d, status, lastError })
    this.pushChanged(d.provider)
  }

  /** At launch: a row left `sending` by a crash may have arrived. */
  async recoverInterrupted(): Promise<void> {
    const rows = await this.ctx.storage.listIntegrationDeliveries({ statuses: ['sending'], limit: 200 })
    for (const d of rows) {
      await this.update(d.id, { status: 'uncertain', nextAttemptAt: null, errorCode: 'interrupted', errorMessage: 'Notula closed while sending this, so it can’t tell whether it arrived.' })
    }
  }
}
