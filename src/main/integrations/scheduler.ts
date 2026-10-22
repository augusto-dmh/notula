// SPDX-License-Identifier: Apache-2.0
// The local scheduler: folder rules
// run once per (rule, note) behind the run-row guard; due rows send; retryable failures
// come back at 1 min, 5 min, 30 min and 2 h; a 7-day catch-up at launch; paused while
// offline or in local-only mode. It runs only while Notula runs.

import { net } from 'electron'
import { INTEGRATION_POLICY, type IntegrationDelivery } from '@shared/types/integrations'
import type { MainContext } from '../context'
import type { IntegrationPlugin } from '../integration-plugins'
import { log } from '../log'
import { LOCAL_ONLY_REASON } from '../privacy'
import type { NewIntegrationDelivery } from '../storage/api'
import { latestSummaryPanel } from './content'
import { matchRecords } from './providers/attio'
import type { IntegrationsService } from './service'

const NO_RECORDS = 'Not saved to Attio: no records match this meeting'

export class IntegrationsScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null
  private nextAt = Infinity
  private ticking: Promise<void> | null = null
  private again = false
  private stopped = false
  private ready = false

  constructor(
    private readonly ctx: MainContext,
    private readonly svc: IntegrationsService
  ) {
    svc.wake = (atMs?: number) => this.wake(atMs)
    // The local-only module releases a held send.
    ctx.bus.on('integrations:wake', () => this.wake())
  }

  /** Storage is open: recover, expire, catch up. */
  async start(): Promise<void> {
    if (this.ready) return
    this.ready = true
    await this.svc.recoverInterrupted()
    const expired = await this.ctx.storage.expireIntegrationDeliveries(new Date(Date.now() - INTEGRATION_POLICY.catchUpMs).toISOString())
    if (expired) log('info', 'integrations:expired', { count: expired })
    this.wake()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  /** Run soon (or at `atMs`), coalescing. */
  wake(atMs?: number): void {
    if (this.stopped || !this.ready) return
    const at = Math.max(Date.now() + 250, atMs ?? 0)
    if (at >= this.nextAt) return
    if (this.timer) clearTimeout(this.timer)
    this.nextAt = at
    this.timer = setTimeout(() => {
      this.timer = null
      this.nextAt = Infinity
      void this.tick()
    }, at - Date.now())
  }

  private async tick(): Promise<void> {
    if (this.ticking) {
      this.again = true
      return this.ticking
    }
    this.ticking = this.run()
      .catch((err: unknown) => log('error', 'integrations:tick-failed', { err: err instanceof Error ? err.name : 'error' }))
      .finally(() => {
        this.ticking = null
        if (this.again) {
          this.again = false
          this.wake()
        }
      })
    return this.ticking
  }

  private async run(): Promise<void> {
    if (this.stopped) return
    const now = Date.now()
    const due = await this.ctx.storage.dueIntegrationDeliveries(new Date(now).toISOString(), 50)
    if (await this.svc.localOnly()) {
      if (due.length) log('info', 'integrations:held', { count: due.length, reason: LOCAL_ONLY_REASON })
      for (const d of due.filter((d) => d.status === 'scheduled')) await this.svc.process(d.id)
      this.wake(now + INTEGRATION_POLICY.tickMs)
      return
    }
    if (!net.isOnline()) {
      log('info', 'integrations:paused', { reason: 'offline' })
      this.wake(now + INTEGRATION_POLICY.tickMs)
      return
    }
    await this.runRules(now)
    for (const d of due) if (!this.stopped) await this.svc.process(d.id)
    // Keep the 60 s heartbeat while anything is still due (failed retries, held rows).
    const left = await this.ctx.storage.dueIntegrationDeliveries(new Date(Date.now() + INTEGRATION_POLICY.scheduleRetriesMs[3]).toISOString(), 1)
    if (left.length) {
      const at = left[0]?.nextAttemptAt ? Date.parse(left[0].nextAttemptAt) : now
      this.wake(Math.max(now + 1_000, Math.min(at, now + INTEGRATION_POLICY.tickMs)))
    }
  }

  /** Folder rules: every (rule, note) the storage query says has not run. */
  private async runRules(now: number): Promise<void> {
    const pending = await this.ctx.storage.pendingAutomationNotes(new Date(now - INTEGRATION_POLICY.catchUpMs).toISOString())
    if (!pending.length) return
    const automations = await this.ctx.storage.listIntegrationAutomations({ enabledOnly: true })
    const runIds = new Set(await this.ctx.settings.get('integrations.zapier.folderRunIds'))
    for (const { automationId, noteId } of pending) {
      if (this.stopped) return
      const a = automations.find((x) => x.id === automationId)
      if (!a) continue
      try {
        await this.runRule(a, noteId, runIds)
      } catch (err) {
        // Not claimed: the next tick tries again.
        log('warn', 'integrations:rule-deferred', { provider: a.provider, automationId, err: err instanceof Error ? err.message.slice(0, 40) : 'error' })
      }
    }
  }

  private async runRule(a: Awaited<ReturnType<MainContext['storage']['listIntegrationAutomations']>>[number], noteId: string, runIds: Set<string>): Promise<void> {
    const plugin = this.svc.plugin(a.provider)
    if (plugin) return this.runPluginRule(a, noteId, plugin)
    if (a.provider !== 'slack' && a.provider !== 'zapier' && a.provider !== 'attio') return
    // The folder's master switch gates every Zapier rule; nothing is claimed while it is off.
    if (a.provider === 'zapier' && !runIds.has(a.folderId)) return
    const panel = latestSummaryPanel(await this.ctx.storage.listPanels(noteId))
    if (!panel) return
    const base = { provider: a.provider, automationId: a.id, noteId, panelId: panel.id, trigger: 'folder' as const, status: 'pending' as const, nextAttemptAt: new Date().toISOString() }
    let rows: NewIntegrationDelivery[] = []
    let result: 'queued' | 'no_targets' = 'queued'
    if (a.provider === 'slack' || a.provider === 'zapier') {
      const dest = a.destinationId ? (await this.ctx.storage.listIntegrationDestinations({ ids: [a.destinationId] }))[0] : undefined
      if (!dest || (a.provider === 'zapier' && dest.trigger !== 'folder')) result = 'no_targets'
      else rows = [{ ...base, destinationId: dest.id, targetKey: dest.externalId ?? '' }]
    } else {
      const token = await this.svc.credential('attio')
      if (!token) return
      const note = await this.ctx.storage.getNote(noteId)
      if (!note) return
      const types = a.options.objectTypes?.length ? a.options.objectTypes : ['companies' as const]
      const matched = await matchRecords(this.ctx, note, token, types, 50)
      rows = matched.map((m) => ({ ...base, destinationId: null, targetKey: m.id }))
      if (!rows.length) {
        // One visible row carries "no records found" to the panel, the toast and Recent deliveries.
        result = 'no_targets'
        rows = [{ ...base, destinationId: null, targetKey: '' }]
      }
    }
    const claim = await this.ctx.storage.claimAutomationRun(a.id, noteId, result, rows)
    if (!claim.created) return
    log('info', 'integrations:rule-ran', { provider: a.provider, automationId: a.id, deliveries: claim.deliveries.length, result })
    if (result === 'no_targets') {
      for (const d of claim.deliveries) {
        const row: IntegrationDelivery = await this.ctx.storage.updateIntegrationDelivery(d.id, { status: 'failed', nextAttemptAt: null, errorCode: 'no_records', errorMessage: NO_RECORDS })
        this.svc.pushDelivery(row)
      }
      return
    }
    for (const d of claim.deliveries) {
      this.svc.pushDelivery(d)
      await this.svc.process(d.id)
    }
  }

  /** A plug-in's folder rule maps the note to its targets; the same once-only claim. */
  private async runPluginRule(a: Awaited<ReturnType<MainContext['storage']['listIntegrationAutomations']>>[number], noteId: string, plugin: IntegrationPlugin): Promise<void> {
    if (!plugin.folderTargets) return
    const targets = await plugin.folderTargets(this.ctx, noteId, a)
    const rows: NewIntegrationDelivery[] = targets.map((r) => ({ ...r, provider: a.provider, automationId: a.id, noteId, trigger: 'folder' as const }))
    const claim = await this.ctx.storage.claimAutomationRun(a.id, noteId, rows.length ? 'queued' : 'no_targets', rows)
    if (!claim.created) return
    log('info', 'integrations:rule-ran', { provider: a.provider, automationId: a.id, deliveries: claim.deliveries.length, result: rows.length ? 'queued' : 'no_targets' })
    for (const d of claim.deliveries) {
      this.svc.pushDelivery(d)
      await this.svc.process(d.id)
    }
  }
}
