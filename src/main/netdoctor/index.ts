// SPDX-License-Identifier: Apache-2.0
// registerNetDoctor(): the Network Doctor; its `netdoctor:*` IPC
// and the automatic probe on bus `transcription:failover-exhausted`.
//
// - Targets come from settings at run time: the user's ASR and LLM providers, the
//   first model-manifest URL and the update feed. Never a host the user does not use.
// - Each endpoint runs DNS, then TLS, then its real request, stopping at the first failure;
//   endpoints run in parallel. The primary request uses the stack the feature
//   really uses (transcription: `ws` over Node sockets; LLM clients: Node fetch; model
//   downloads and the feed: Electron `net`), plus the other stack as a supplementary row
//   that never decides a feature's status.
// - Single flight, Cancel, the 120 s cap and progress. Probes run in main as
//   async I/O. Keys stay in main: never in the report or the log.
// - Local-only mode: nothing that would leave this machine is probed.
// - The automatic probe runs once per app session when a source's failover
//   is exhausted, and only writes a local log line.
//
// Handlers and pushes write their channel literal.

import { app, ipcMain } from 'electron'
import { notulaError } from '@shared/errors'
import type { InvokeChannel, PushChannel } from '@shared/ipc'
import {
  NETDOCTOR_LIMITS as L,
  type NetDoctorCheck,
  type NetDoctorCheckStatus,
  type NetDoctorFeature,
  type NetDoctorFeatureStatus,
  type NetDoctorOutcome,
  type NetDoctorReport
} from '@shared/types/netdoctor'
import type { AsrProviderId } from '@shared/types/transcript'
import type { MainContext } from '../context'
import { log } from '../log'
import { egressBlocked, LOCAL_ONLY_REASON } from '../privacy'
import { classifyError, probeDns, probeHttps, probeTls, probeWebSocket, proxyRoute, shortError, type LayerResult } from './probes'
import { buildTargets, FEATURE_LABELS, FEATURE_SYMPTOMS, type Target } from './targets'

/** Marks a supplementary row; the panel and the report read it from the label. */
export const SUPPLEMENTARY_SUFFIX = ' (supplementary)'

const PASS = new Set<NetDoctorCheckStatus>(['REACHABLE', 'INCREMENTAL'])

export function statusOf(outcome: NetDoctorOutcome): NetDoctorCheckStatus {
  switch (outcome) {
    case 'reachable':
    case 'tls_intercepted_trusted':
    case 'websocket_connected':
    case 'websocket_refused':
    case 'stream_untested':
      return 'REACHABLE'
    case 'stream_ok':
      return 'INCREMENTAL'
    case 'stream_held_back':
    case 'stream_slow_start':
    case 'stream_cut_short':
      return 'IMPAIRED'
    case 'unexpected_response':
    case 'probe_error':
    case 'asr_key_rejected':
      return 'NOT VERIFIED'
    default:
      return 'BLOCKED'
  }
}

function makeCheck(t: Target, r: LayerResult, extra: Partial<NetDoctorCheck> & Pick<NetDoctorCheck, 'probe' | 'durationMs'>): NetDoctorCheck {
  return {
    feature: t.feature,
    label: t.label,
    host: t.host,
    target: t.target,
    required: t.required,
    outcome: r.outcome,
    status: statusOf(r.outcome),
    detail: r.detail,
    tlsIssuer: null,
    proxy: null,
    stack: t.stack,
    ...extra
  }
}

/** One endpoint: DNS → TLS → the real request, stopping at the first failure. */
async function probeTarget(ctx: MainContext, t: Target, signal: AbortSignal): Promise<NetDoctorCheck[]> {
  const started = Date.now()
  const elapsed = (): number => Date.now() - started

  // No probes at all while Nothing leaves this machine is on.
  if (await egressBlocked(ctx, { kind: 'diagnostics' })) {
    log('info', 'netdoctor:skipped', { host: t.host, reason: LOCAL_ONLY_REASON })
    return [makeCheck(t, { outcome: 'probe_error', detail: 'Not run: Nothing leaves this machine is on' }, { probe: 'dns', durationMs: 0 })]
  }
  if (t.credentialMissing) {
    return [
      makeCheck(
        t,
        { outcome: 'asr_key_rejected', detail: 'No API key is set for this provider (ASR_KEY_MISSING).' },
        { probe: 'websocket', durationMs: 0 }
      )
    ]
  }

  const proxy = await proxyRoute(t.url.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:'), L.proxyResolveMs, signal)
  const dns = await probeDns(t.host, { timeoutMs: L.dnsMs, signal, privateExpected: t.privateExpected })
  if (dns.outcome !== 'reachable') return [makeCheck(t, dns, { probe: 'dns', proxy, durationMs: elapsed() })]

  let untrustedIssuer: string | null = null
  if (t.tls) {
    const tls = await probeTls(t.host, t.port, { timeoutMs: L.tlsMs, signal })
    if (tls.outcome !== 'reachable') return [makeCheck(t, tls, { probe: 'tls', proxy, durationMs: elapsed() })]
    untrustedIssuer = tls.untrustedIssuer
  }

  let primary: LayerResult
  try {
    primary =
      t.kind === 'websocket'
        ? await probeWebSocket(t.url, {
            headers: t.headers,
            fingerprintHeader: t.fingerprintHeader,
            goodbye: t.goodbye,
            timeoutMs: L.websocketMs,
            stableMs: L.websocketStableMs,
            signal
          })
        : await probeHttps(t.url, { stack: t.stack, method: t.method, headers: t.headers, expect: t.expect, timeoutMs: L.httpsMs, signal })
  } catch (err) {
    if (signal.aborted) throw err
    primary = { outcome: 'probe_error', detail: `Couldn’t run this check. Try again. Details: ${shortError(err)}` }
  }
  if (dns.detail && primary.outcome === 'reachable') primary = { ...primary, detail: dns.detail }
  // A certificate Node does not trust. A passing answer means the system trusts the
  // inspecting authority (Electron `net` reads the OS store); a failing one is untrusted.
  if (untrustedIssuer && statusOf(primary.outcome) === 'REACHABLE') {
    primary = { outcome: 'tls_intercepted_trusted', detail: `Trusted TLS inspection by ${untrustedIssuer}` }
  }
  const checks = [
    makeCheck(t, primary, {
      probe: t.kind === 'websocket' ? 'websocket' : 'https',
      proxy,
      durationMs: elapsed(),
      tlsIssuer: untrustedIssuer
    })
  ]

  if (t.supplementary && t.kind === 'https') {
    const other = t.stack === 'node' ? 'electron-net' : 'node'
    const supStarted = Date.now()
    let sup: LayerResult
    try {
      sup = await probeHttps(t.url, { stack: other, method: t.method, headers: t.headers, expect: t.expect, timeoutMs: L.httpsMs, signal })
    } catch (err) {
      if (signal.aborted) throw err
      sup = classifyError(err)
    }
    checks.push({
      ...makeCheck(t, sup, { probe: 'https', proxy, durationMs: Date.now() - supStarted, tlsIssuer: untrustedIssuer }),
      label: `${t.label}${SUPPLEMENTARY_SUFFIX}`,
      required: false,
      stack: other
    })
  }
  return checks
}

/** A feature's status from its primary checks only. */
function rollUp(checks: NetDoctorCheck[], impacts: Map<string, string>): NetDoctorReport['features'] {
  const features: NetDoctorReport['features'] = []
  for (const feature of Object.keys(FEATURE_LABELS) as NetDoctorFeature[]) {
    const primary = checks.filter((c) => c.feature === feature && !c.label.endsWith(SUPPLEMENTARY_SUFFIX))
    if (primary.length === 0) continue
    const required = primary.some((c) => c.required)
    let status: NetDoctorFeatureStatus
    if (primary.every((c) => PASS.has(c.status))) status = 'CONNECTION CHECKS PASSED'
    else if (primary.some((c) => c.required && c.status === 'BLOCKED')) status = 'CONNECTION FAILED'
    else if (primary.some((c) => c.status === 'BLOCKED' || c.status === 'IMPAIRED')) status = 'DEGRADED'
    else status = 'NOT VERIFIED'
    const failing = primary.filter((c) => !PASS.has(c.status))
    const requiredFailed = failing.some((c) => c.required)
    const symptom =
      failing.length === 0 || requiredFailed
        ? FEATURE_SYMPTOMS[feature]
        : [...new Set(failing.map((c) => impacts.get(c.label) ?? FEATURE_SYMPTOMS[feature]))].join(' ')
    features.push({ feature, label: FEATURE_LABELS[feature], symptom, required, status })
  }
  return features
}

export function registerNetDoctor(ctx: MainContext): void {
  let running: AbortController | null = null

  async function run(onProgress: (completed: number, total: number) => void): Promise<NetDoctorReport> {
    if (running) throw notulaError('busy', 'A network check is already running.')
    const controller = new AbortController()
    running = controller
    const startedAt = new Date().toISOString()
    try {
      const targets = await buildTargets(ctx)
      const impacts = new Map(targets.map((t) => [t.label, t.impact]))
      let completed = 0
      onProgress(0, targets.length)
      const all: NetDoctorCheck[][] = []
      const work = Promise.all(
        targets.map(async (t, i) => {
          try {
            all[i] = await probeTarget(ctx, t, controller.signal)
          } catch (err) {
            if (controller.signal.aborted) return
            all[i] = [makeCheck(t, { outcome: 'probe_error', detail: `Couldn’t run this check. Try again. Details: ${shortError(err)}` }, { probe: 'dns', durationMs: 0 })]
          }
          completed += 1
          if (!controller.signal.aborted) onProgress(completed, targets.length)
        })
      )
      let capTimer: NodeJS.Timeout | null = null
      const cap = new Promise<'cap'>((resolve) => {
        capTimer = setTimeout(() => resolve('cap'), L.runMs)
      })
      const cancelled = new Promise<'cancelled'>((resolve) =>
        controller.signal.addEventListener('abort', () => resolve('cancelled'), { once: true })
      )
      const outcome = await Promise.race([work.then(() => 'done' as const), cap, cancelled])
      if (capTimer) clearTimeout(capTimer)
      if (outcome === 'cap') {
        controller.abort()
        log('warn', 'netdoctor:timed-out', { ms: L.runMs })
        throw notulaError('internal', `The network check timed out after ${Math.round(L.runMs / 1000)} s. Try again.`)
      }
      const checks = all.filter(Boolean).flat()
      const report: NetDoctorReport = {
        startedAt,
        finishedAt: new Date().toISOString(),
        appVersion: app.getVersion(),
        platform: process.platform,
        cancelled: outcome === 'cancelled',
        checks,
        features: outcome === 'cancelled' ? [] : rollUp(checks, impacts)
      }
      // A local log line only, with no keys and no query strings.
      log('info', 'network-check-results', {
        cancelled: report.cancelled,
        checks: checks.map((c) => ({ host: c.host, label: c.label, outcome: c.outcome, ms: c.durationMs, proxy: c.proxy }))
      })
      return report
    } finally {
      if (running === controller) running = null
    }
  }

  ipcMain.handle('netdoctor:run' satisfies InvokeChannel, (e) =>
    run((completed, total) => {
      if (!e.sender.isDestroyed()) e.sender.send('netdoctor:progress' satisfies PushChannel, { completed, total })
    })
  )

  ipcMain.handle('netdoctor:cancel' satisfies InvokeChannel, () => {
    if (running) {
      log('info', 'netdoctor:cancelled')
      running.abort()
    }
  })

  // ---------- the automatic probe: once per app session, log only ----------
  let autoProbeDone = false
  ctx.bus.on('transcription:failover-exhausted', (e) => {
    if (autoProbeDone) return
    autoProbeDone = true
    void autoProbe(ctx, e.providers).catch((err: unknown) =>
      log('warn', 'asr-network-check-failed', { err: shortError(err) })
    )
  })
}

/** Proxy environment variables, by name, with any credentials and paths dropped. */
function proxyEnvironment(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy']) {
    const v = process.env[name]
    if (!v) continue
    try {
      const u = new URL(v)
      out[name] = `${u.protocol}//${u.host}`
    } catch {
      out[name] = name.toLowerCase().startsWith('no_proxy') ? '[set]' : '[redacted]'
    }
  }
  return out
}

async function autoProbe(ctx: MainContext, providers: AsrProviderId[]): Promise<void> {
  const targets = (await buildTargets(ctx)).filter((t) => t.egress?.kind === 'asr' && providers.includes(t.egress.provider))
  const signal = new AbortController().signal
  const results: Record<string, unknown>[] = []
  for (const t of targets) {
    if (t.egress && (await egressBlocked(ctx, t.egress))) continue
    const timed = async <T>(fn: () => Promise<T>): Promise<{ ms: number; value: T | null; error: string | null }> => {
      const s = Date.now()
      try {
        const value = await fn()
        return { ms: Date.now() - s, value, error: null }
      } catch (err) {
        return { ms: Date.now() - s, value: null, error: shortError(err) }
      }
    }
    const dns = await timed(() => probeDns(t.host, { timeoutMs: L.autoProbeMs, signal, privateExpected: false, family: 4 }))
    const proxy = await timed(() => proxyRoute(`https://${t.host}/`, L.autoProbeMs, signal))
    const tls = await timed(() => probeTls(t.host, t.port, { timeoutMs: L.autoProbeMs, signal }))
    const head = await timed(() =>
      probeHttps(`https://${t.host}/`, { stack: 'node', method: 'HEAD', headers: {}, expect: 'feed', timeoutMs: L.autoProbeMs, signal })
    )
    const ws = t.credentialMissing
      ? { ms: 0, value: { outcome: 'asr_key_rejected', detail: null }, error: null }
      : await timed(() =>
          probeWebSocket(t.url, {
            headers: t.headers,
            fingerprintHeader: t.fingerprintHeader,
            goodbye: t.goodbye,
            timeoutMs: L.autoProbeMs,
            stableMs: L.websocketStableMs,
            signal
          })
        )
    results.push({
      provider: t.label,
      host: t.host,
      dns: { ms: dns.ms, outcome: dns.value?.outcome ?? null, private: dns.value?.allPrivate ?? null, error: dns.error },
      proxy: proxy.value,
      tls: { ms: tls.ms, outcome: tls.value?.outcome ?? null, protocol: tls.value?.protocol ?? null, untrustedIssuer: tls.value?.untrustedIssuer ?? null },
      head: { ms: head.ms, outcome: head.value?.outcome ?? null, status: head.value?.status ?? null },
      websocket: { ms: ws.ms, outcome: ws.value?.outcome ?? null, error: ws.error }
    })
  }
  log('info', 'asr-network-check', { trigger: 'fallbacks-used-up', proxyEnv: proxyEnvironment(), results })
}
