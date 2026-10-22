// SPDX-License-Identifier: Apache-2.0
// "Nothing leaves this machine" and data usage, with their `privacy:*` IPC.
//
// - The switch (`privacy:set-local-only`) is the only control of `privacy.localOnly`.
//   Turning on is refused while a capture uses a cloud ASR provider; otherwise it saves the
//   providers, sets both to local, stamps the time and sets `privacy.localOnly` last. The other
//   modules react to `settings:changed` (LLM requests, calendar sync, MCP, updates, …), and
//   index.ts arms the catch-all layer.
// - Turning off is a protected change (device lock), holds the due integration sends first
//   (so nothing queued while local-only goes out unasked), and restores a provider only when
//   the user ticked its box.
// - Data usage is computed here from settings, secret presence and storage listings, never from
//   secret values.
// - Content sources (Labs, Windows) add their hosts once online lookups are allowed: oEmbed on
//   www.youtube.com and vimeo.com, yt-dlp's own YouTube traffic, and the managed yt-dlp's
//   downloads from GitHub releases.

import { ipcMain } from 'electron'
import { notulaError } from '@shared/errors'
import type { InvokeChannel, InvokeReq, InvokeRes, PushChannel } from '@shared/ipc'
import type { LlmProviderId } from '@shared/types/enhance'
import type { IntegrationProvider } from '@shared/types/integrations'
import {
  LOCAL_ONLY_COPY,
  type DataUsage,
  type DataUsageDestination,
  type LocalOnlyStatus,
  type LocalOnlyWarning
} from '@shared/types/local-only'
import type { Settings } from '@shared/types/settings'
import { LOCAL_ASR_MODELS, type AsrProviderId } from '@shared/types/transcript'
import { getLocalModels } from '../asr/instance'
import type { MainContext } from '../context'
import { expected } from '../ipc-expected'
import { log } from '../log'
import { isLoopbackUrl } from '../net/loopback'

const THIS_COMPUTER = 'this computer'

const ASR_NAMES: Record<AsrProviderId, string> = { deepgram: 'Deepgram', assemblyai: 'AssemblyAI', local: 'Local transcription' }
const LLM_NAMES: Record<LlmProviderId, string> = { anthropic: 'Anthropic', openai: 'OpenAI-compatible', local: 'Local model' }

/** Integrations with a credential of their own, and where they send. */
const INTEGRATION_SECRETS: { provider: IntegrationProvider; secret: Parameters<MainContext['secrets']['has']>[0]; name: string; host: string }[] = [
  { provider: 'slack', secret: 'integration.slack.bot', name: 'Slack', host: 'slack.com' },
  { provider: 'notion', secret: 'integration.notion', name: 'Notion', host: 'api.notion.com' },
  { provider: 'hubspot', secret: 'integration.hubspot', name: 'HubSpot', host: 'api.hubapi.com' },
  { provider: 'attio', secret: 'integration.attio', name: 'Attio', host: 'api.attio.com' },
  { provider: 'affinity', secret: 'integration.affinity', name: 'Affinity', host: 'api.affinity.co' },
  { provider: 'salesforce', secret: 'integration.salesforce.tokens', name: 'Salesforce', host: 'your Salesforce org' },
  { provider: 'pipedrive', secret: 'integration.pipedrive', name: 'Pipedrive', host: 'api.pipedrive.com' },
  { provider: 'ashby', secret: 'integration.ashby', name: 'Ashby', host: 'api.ashbyhq.com' }
]
/** Destinations that carry their own address (webhooks), by provider. */
const DESTINATION_PROVIDERS: Partial<Record<IntegrationProvider, { name: string; host: string }>> = {
  slack: { name: 'Slack', host: 'hooks.slack.com' },
  zapier: { name: 'Zapier', host: 'hooks.zapier.com' },
  webhook: { name: 'Webhooks', host: 'your webhook addresses' }
}

function hostOf(url: string | null | undefined): string {
  try {
    return new URL(url ?? '').hostname || 'unknown'
  } catch {
    return 'unknown'
  }
}

function asrHost(s: Settings): string {
  if (s['asr.provider'] === 'deepgram') return 'api.deepgram.com'
  if (s['asr.provider'] === 'assemblyai') {
    const r = s['asr.assemblyai.region'] as string
    return r === 'eu' ? 'streaming.eu.assemblyai.com' : r === 'us' ? 'streaming.us.assemblyai.com' : 'streaming.assemblyai.com'
  }
  return THIS_COMPUTER
}

function llmHost(provider: LlmProviderId, s: Settings): string {
  if (provider === 'anthropic') return 'api.anthropic.com'
  const url = provider === 'openai' ? s['llm.openai.baseUrl'] : s['llm.local.baseUrl']
  return provider === 'local' && isLoopbackUrl(url) ? THIS_COMPUTER : hostOf(url)
}

function updateFeed(): string {
  return typeof __NOTULA_UPDATE_FEED_URL__ === 'string' ? __NOTULA_UPDATE_FEED_URL__ : ''
}

/** Content sources' destinations: only while Sources is on (Windows) and online lookups are allowed. */
function sourceHosts(s: Settings): Omit<DataUsageDestination, 'active'>[] {
  if (process.platform !== 'win32' || !s['sources.enabled'] || !s['sources.onlineLookups']) return []
  const out: Omit<DataUsageDestination, 'active'>[] = [
    { kind: 'sources', name: 'Video details', detail: 'www.youtube.com', what: 'the link of a video you take notes on, to confirm its title and channel' },
    { kind: 'sources', name: 'Video details', detail: 'vimeo.com', what: 'the link of a video you take notes on, to confirm its title and channel' }
  ]
  if (s['sources.ytDlp'] !== 'off') {
    out.push({ kind: 'sources', name: 'yt-dlp', detail: 'www.youtube.com', what: 'video titles to search for, and requests for video details and captions' })
  }
  if (s['sources.ytDlp'] === 'managed') {
    out.push({
      kind: 'sources',
      name: 'yt-dlp downloads',
      detail: 'github.com, release-assets.githubusercontent.com',
      what: 'the yt-dlp download and weekly update checks; no note content'
    })
  }
  return out
}

export function registerLocalOnly(ctx: MainContext): void {
  /** Every destination Notula would send to with the current configuration. */
  async function destinations(s: Settings): Promise<DataUsageDestination[]> {
    const on = s['privacy.localOnly']
    const out: DataUsageDestination[] = []
    const add = (d: Omit<DataUsageDestination, 'active'>, sendsOut: boolean): void => {
      out.push({ ...d, active: !(on && sendsOut) })
    }
    const llm = s['llm.provider']
    const llmDetail = llmHost(llm, s)
    add(
      { kind: 'llm', name: LLM_NAMES[llm], detail: llmDetail, what: 'transcript and notes, when you generate a summary or chat' },
      llmDetail !== THIS_COMPUTER
    )
    const asr = s['asr.provider']
    add({ kind: 'asr', name: ASR_NAMES[asr], detail: asrHost(s), what: 'meeting audio, while you transcribe' }, asr !== 'local')

    const seen = new Set<string>()
    for (const i of INTEGRATION_SECRETS) {
      if (!(await ctx.secrets.has(i.secret).catch(() => false))) continue
      seen.add(i.provider)
      add({ kind: 'integration', name: i.name, detail: i.host, what: 'the notes you share or send automatically' }, true)
    }
    const dests = await ctx.storage.listIntegrationDestinations().catch(() => [])
    for (const d of dests) {
      const p = DESTINATION_PROVIDERS[d.provider]
      if (!p || seen.has(d.provider) || d.status === 'disabled') continue
      seen.add(d.provider)
      add({ kind: 'integration', name: p.name, detail: p.host, what: 'the notes you share or send automatically' }, true)
    }

    for (const c of await ctx.storage.listCalendarSources().catch(() => [])) {
      const detail = c.kind === 'google' ? 'www.googleapis.com' : c.kind === 'microsoft' ? 'graph.microsoft.com' : (c.urlHost ?? 'unknown')
      add({ kind: 'calendar', name: c.label || c.accountEmail || 'Calendar', detail, what: 'requests for your events; no note content' }, true)
    }

    if (s['mcpClient.enabled']) {
      for (const m of await ctx.storage.listMcpConnections().catch(() => [])) {
        if (!m.enabled) continue
        const local = m.transport === 'stdio' || isLoopbackUrl(m.url ?? '')
        add(
          {
            kind: 'mcp',
            name: m.name,
            detail: m.transport === 'stdio' ? THIS_COMPUTER : hostOf(m.url),
            what: 'what you or the assistant ask its tools, which can quote your notes'
          },
          // A stdio server is a program on this computer, but it may use the network itself.
          !local || m.transport === 'stdio'
        )
      }
    }

    for (const d of sourceHosts(s)) add(d, true)

    const feed = updateFeed()
    if (feed) add({ kind: 'updates', name: 'Update checks', detail: hostOf(feed), what: 'the app version and platform' }, true)
    return out
  }

  async function warnings(s: Settings): Promise<LocalOnlyWarning[]> {
    const w: LocalOnlyWarning[] = []
    try {
      // Any installed speech model will do.
      const models = getLocalModels(ctx)
      if (!LOCAL_ASR_MODELS.some((m) => models.isReady(m.id))) w.push('no-local-asr')
    } catch {
      w.push('no-local-asr')
    }
    if (!s['llm.local.model'].trim()) w.push('no-local-llm')
    if (!isLoopbackUrl(s['llm.local.baseUrl'])) w.push('local-llm-not-loopback')
    return w
  }

  /** What stops when the mode turns on, or resumes when it turns off. */
  async function services(s: Settings): Promise<LocalOnlyStatus['activeServices']> {
    const out: LocalOnlyStatus['activeServices'] = []
    for (const d of await destinations({ ...s, 'privacy.localOnly': false })) {
      if (d.detail === THIS_COMPUTER && d.kind !== 'mcp') continue
      out.push({ kind: d.kind, name: d.kind === 'updates' ? d.name : `${d.name} (${d.detail})` })
    }
    if (s['mcpServer.enabled']) out.push({ kind: 'local-server', name: 'Notula MCP server' })
    if (s['localApi.enabled']) out.push({ kind: 'local-server', name: 'Local API' })
    if (s['companionCli.enabled']) out.push({ kind: 'local-server', name: 'Companion CLI' })
    return out
  }

  async function heldCount(): Promise<number> {
    try {
      return (await ctx.storage.listHeldIntegrationDeliveries()).length
    } catch {
      return 0
    }
  }

  async function status(): Promise<LocalOnlyStatus> {
    const s = await ctx.settings.getAll()
    return {
      enabled: s['privacy.localOnly'],
      changedAt: s['privacy.localOnlyChangedAt'],
      heldSends: await heldCount(),
      warnings: await warnings(s),
      activeServices: await services(s),
      previousProviders: s['privacy.previousProviders']
    }
  }

  async function push(): Promise<void> {
    const st = await status()
    for (const wc of ctx.windows.targets()) wc.send('privacy:local-only-changed' satisfies PushChannel, st)
  }

  // Any change of the mode (or of what it would stop) reaches the open renderers.
  ctx.bus.on('settings:changed', (e) => {
    if (e.keys.some((k) => k === 'privacy.localOnly' || k === 'llm.local.baseUrl' || k === 'llm.local.model')) {
      void push().catch((err: unknown) => log('warn', 'local-only:push-failed', { err }))
    }
  })

  async function turnOn(): Promise<InvokeRes<'privacy:set-local-only'>> {
    const s = await ctx.settings.getAll()
    if (s['privacy.localOnly']) return { ok: true, reason: null }
    if (ctx.capture.isCapturing() && s['asr.provider'] !== 'local') {
      log('info', 'local-only:refused', { reason: 'cloud-transcription-active' })
      return { ok: false, reason: 'cloud-transcription-active' }
    }
    const stopping = await services(s)
    await ctx.settings.set('privacy.previousProviders', { asr: s['asr.provider'], llm: s['llm.provider'] })
    if (s['asr.provider'] !== 'local') await ctx.settings.set('asr.provider', 'local')
    if (s['llm.provider'] !== 'local') await ctx.settings.set('llm.provider', 'local')
    await ctx.settings.set('privacy.localOnlyChangedAt', new Date().toISOString())
    // Last: the guard, the catch-all layer and every reacting module follow this key.
    await ctx.settings.set('privacy.localOnly', true)
    log('info', 'local-only:on', { stopped: stopping.map((x) => x.kind) })
    return { ok: true, reason: null }
  }

  async function turnOff(restore: { asr: boolean; llm: boolean } | undefined): Promise<InvokeRes<'privacy:set-local-only'>> {
    const s = await ctx.settings.getAll()
    if (!s['privacy.localOnly']) return { ok: true, reason: null }
    if (!(await ctx.deviceLock.confirmProtectedChange('privacy.localOnly'))) {
      log('info', 'local-only:off-refused', { reason: 'not-verified' })
      return { ok: false, reason: 'not-verified' }
    }
    // Sends that came due while on never go out on their own.
    const held = await ctx.storage.holdDueIntegrationDeliveries(new Date().toISOString()).catch((err: unknown) => {
      log('error', 'local-only:hold-failed', { err })
      return 0
    })
    const prev = s['privacy.previousProviders']
    if (prev && restore?.asr === true && prev.asr !== 'local') await ctx.settings.set('asr.provider', prev.asr)
    if (prev && restore?.llm === true && prev.llm !== 'local') await ctx.settings.set('llm.provider', prev.llm)
    await ctx.settings.set('privacy.localOnlyChangedAt', new Date().toISOString())
    await ctx.settings.set('privacy.localOnly', false)
    await ctx.settings.set('privacy.previousProviders', null)
    const resumed = await services(await ctx.settings.getAll())
    log('info', 'local-only:off', { resumed: resumed.map((x) => x.kind), held, restoredAsr: restore?.asr === true, restoredLlm: restore?.llm === true })
    return { ok: true, reason: null }
  }

  // ---------- IPC (literal channels) ----------

  ipcMain.handle('privacy:data-usage' satisfies InvokeChannel, async (): Promise<DataUsage> => {
    const s = await ctx.settings.getAll()
    return { localOnly: s['privacy.localOnly'], localOnlySwitchAvailable: true, destinations: await destinations(s) }
  })

  ipcMain.handle('privacy:local-only-status' satisfies InvokeChannel, (): Promise<LocalOnlyStatus> => status())

  let switching: Promise<InvokeRes<'privacy:set-local-only'>> | null = null
  ipcMain.handle(
    'privacy:set-local-only' satisfies InvokeChannel,
    async (_e, req: InvokeReq<'privacy:set-local-only'>): Promise<InvokeRes<'privacy:set-local-only'>> => {
      if (typeof req?.enabled !== 'boolean' || req.confirmed !== true) {
        throw expected(notulaError('invalid-input', 'A confirmed on or off is required.'))
      }
      if (switching) throw expected(notulaError('busy', 'The mode is already changing.'))
      const restore =
        req.restoreProviders && typeof req.restoreProviders === 'object'
          ? { asr: req.restoreProviders.asr === true, llm: req.restoreProviders.llm === true }
          : undefined
      switching = req.enabled ? turnOn() : turnOff(restore)
      try {
        return await switching
      } finally {
        switching = null
      }
    }
  )

  ipcMain.handle('privacy:list-held-sends' satisfies InvokeChannel, () => ctx.storage.listHeldIntegrationDeliveries())

  ipcMain.handle(
    'privacy:release-held-send' satisfies InvokeChannel,
    async (_e, req: InvokeReq<'privacy:release-held-send'>): Promise<InvokeRes<'privacy:release-held-send'>> => {
      const id = typeof req?.deliveryId === 'string' ? req.deliveryId : ''
      const action = req?.action === 'send' || req?.action === 'discard' ? req.action : null
      if (!id || !action) throw expected(notulaError('invalid-input', 'A delivery and an action are required.'))
      if (action === 'send' && (await ctx.settings.get('privacy.localOnly'))) {
        throw expected(notulaError('invalid-input', LOCAL_ONLY_COPY.blocked))
      }
      const d = await ctx.storage.releaseHeldIntegrationDelivery(id, action)
      log('info', 'local-only:held-send', { action, provider: d.provider })
      if (action === 'send') ctx.bus.emit('integrations:wake', { reason: 'held-released' })
      void push().catch(() => undefined)
      return d
    }
  )
}
