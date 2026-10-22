// SPDX-License-Identifier: Apache-2.0
// Network Doctor. Keys never appear in a report. The diagnosis, the audience question, the
// copied report and the IT request are computed by the panel from the report.

import type { IsoTime } from './common'

export type NetDoctorFeature = 'transcription' | 'ai' | 'models' | 'updates'

/** The check outcome codes; `intercepted` means a network filter answered with its own page. */
export type NetDoctorOutcome =
  | 'reachable'
  | 'dns_failed'
  | 'dns_timeout'
  | 'dns_private_address'
  | 'connection_failed'
  | 'connection_timeout'
  | 'tls_untrusted'
  | 'tls_intercepted_trusted'
  | 'unexpected_html'
  | 'access_denied'
  | 'unexpected_response'
  | 'stream_ok'
  | 'stream_held_back'
  | 'stream_slow_start'
  | 'stream_cut_short'
  | 'stream_untested'
  | 'asr_key_rejected'
  | 'websocket_connected'
  | 'websocket_refused'
  | 'websocket_blocked_upgrade'
  | 'websocket_dropped'
  | 'probe_error'
  | 'intercepted'

export type NetDoctorCheckStatus = 'REACHABLE' | 'INCREMENTAL' | 'IMPAIRED' | 'BLOCKED' | 'NOT VERIFIED'

export type NetDoctorFeatureStatus = 'CONNECTION CHECKS PASSED' | 'DEGRADED' | 'CONNECTION FAILED' | 'NOT VERIFIED'

export type NetDoctorDiagnosis =
  | 'captive_portal'
  | 'dns_filter'
  | 'dns_failure'
  | 'tls_inspection'
  | 'stream_buffering'
  | 'stream_delivery'
  | 'websocket_blocked'
  | 'connection_failed'
  /** Notula. */
  | 'credentials'
  | 'inconclusive'

export interface NetDoctorCheck {
  feature: NetDoctorFeature
  label: string
  host: string
  /** No query secrets. */
  target: string
  probe: 'dns' | 'tls' | 'https' | 'stream' | 'websocket'
  required: boolean
  outcome: NetDoctorOutcome
  status: NetDoctorCheckStatus
  detail: string | null
  tlsIssuer: string | null
  proxy: string | null
  stack: 'electron-net' | 'node'
  durationMs: number
}

export interface NetDoctorReport {
  startedAt: IsoTime
  finishedAt: IsoTime
  appVersion: string
  platform: NodeJS.Platform
  cancelled: boolean
  checks: NetDoctorCheck[]
  features: { feature: NetDoctorFeature; label: string; symptom: string; required: boolean; status: NetDoctorFeatureStatus }[]
}

export const NETDOCTOR_LIMITS = {
  runMs: 120_000,
  dnsMs: 8_000,
  tlsMs: 8_000,
  httpsMs: 15_000,
  streamConnectMs: 35_000,
  websocketMs: 12_000,
  websocketStableMs: 1_000,
  proxyResolveMs: 5_000,
  firewallHintMs: 20_000,
  autoProbeMs: 5_000
} as const
