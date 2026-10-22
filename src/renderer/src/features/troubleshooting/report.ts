// SPDX-License-Identifier: Apache-2.0
// Network Doctor's panel logic: outcome
// texts, the diagnosis, the copied report and the IT request, computed from main's report.
// Pure: no React and no IPC.

import type {
  NetDoctorCheck,
  NetDoctorCheckStatus,
  NetDoctorDiagnosis,
  NetDoctorFeatureStatus,
  NetDoctorOutcome,
  NetDoctorReport
} from '@shared/types/netdoctor'

/** Main marks supplementary rows with this label suffix (netdoctor/index.ts). */
export const SUPPLEMENTARY_SUFFIX = ' (supplementary)'

export function isSupplementary(c: NetDoctorCheck): boolean {
  return c.label.endsWith(SUPPLEMENTARY_SUFFIX)
}

export function isPass(status: NetDoctorCheckStatus): boolean {
  return status === 'REACHABLE' || status === 'INCREMENTAL'
}

/** The text for each check outcome; `intercepted` means a network filter answered with its own page. */
export const OUTCOME_TEXT: Record<NetDoctorOutcome, string> = {
  reachable: 'Connection succeeded',
  dns_failed: 'DNS lookup failed',
  dns_timeout: 'DNS lookup timed out',
  dns_private_address: 'DNS returned a private address',
  connection_failed: 'Connection failed',
  connection_timeout: 'Connection timed out',
  tls_untrusted: 'Certificate could not be verified',
  tls_intercepted_trusted: 'Trusted TLS inspection detected',
  unexpected_html: 'Received an unexpected web page',
  access_denied: 'Request was denied',
  unexpected_response: 'The server sent an unexpected response',
  stream_ok: 'Response streamed normally',
  stream_held_back: 'Response buffering detected',
  stream_slow_start: 'Response started slowly',
  stream_cut_short: 'Stream ended before completing',
  stream_untested: 'Streaming could not be tested',
  asr_key_rejected: 'Transcription credential request failed',
  websocket_connected: 'WebSocket connection succeeded',
  websocket_refused: 'WebSocket connection succeeded',
  websocket_blocked_upgrade: 'WebSocket connection was blocked',
  websocket_dropped: 'WebSocket disconnected immediately',
  probe_error: 'The check could not complete',
  intercepted: 'A network filter returned its own page'
}

export const PILL: Record<NetDoctorFeatureStatus, 'ok' | 'degraded' | 'blocked' | 'not verified'> = {
  'CONNECTION CHECKS PASSED': 'ok',
  DEGRADED: 'degraded',
  'CONNECTION FAILED': 'blocked',
  'NOT VERIFIED': 'not verified'
}

export type Audience = 'self' | 'it'

export interface DiagnosisCopy {
  explanation: string
  steps: string[]
}

/** Notula's explanations and steps for each class. */
export const DIAGNOSIS: Record<NetDoctorDiagnosis, DiagnosisCopy> = {
  captive_portal: {
    explanation:
      'A web page came back where the service should have answered. A sign-in page (hotel, airport or guest Wi-Fi) or a web filter is usually in the way.',
    steps: [
      'Open a browser and finish any network sign-in page.',
      'If you use a web filter or security app, allow the hosts listed below.',
      'Run the check again.'
    ]
  },
  dns_filter: {
    explanation: 'A DNS filter on your network or computer is blocking the addresses Notula needs, so it can’t find its services.',
    steps: [
      'Check DNS filtering or ad-blocking (a filtering DNS service, a router setting or a security app) and allow the hosts listed below.',
      'Try another network to compare.',
      'Run the check again.'
    ]
  },
  dns_failure: {
    explanation: 'This computer couldn’t look up the service’s address.',
    steps: ['Check that you’re connected to the internet.', 'Turn off a VPN or proxy for a moment, or try another network.', 'Run the check again.']
  },
  tls_inspection: {
    explanation: 'Something on this network is intercepting secure connections with a certificate this computer doesn’t trust.',
    steps: [
      'If your organization inspects HTTPS traffic, the hosts listed below need an exception or its certificate installed.',
      'Check security software that scans HTTPS connections.',
      'Run the check again.'
    ]
  },
  stream_buffering: {
    explanation: 'A proxy or security app is holding streamed answers until they finish, so live results arrive late.',
    steps: ['Turn off response buffering in your proxy or security app for the hosts listed below.', 'Run the check again.']
  },
  stream_delivery: {
    explanation: 'Streamed responses start very late or stop before they finish.',
    steps: ['Check proxies or security apps that hold or cut long-running responses.', 'Run the check again.']
  },
  websocket_blocked: {
    explanation: 'Live transcription uses a WebSocket connection, and something on this network blocks or cuts it.',
    steps: [
      'Allow WebSocket (wss://) connections to the hosts listed below in your firewall or proxy.',
      'Turn off a VPN or proxy for a moment to compare.',
      'Run the check again.'
    ]
  },
  connection_failed: {
    explanation: 'This computer couldn’t open a connection to the service.',
    steps: ['Check your internet connection and firewall.', 'Turn off a VPN or proxy for a moment, or try another network.', 'Run the check again.']
  },
  credentials: {
    explanation: 'Your provider answered, but rejected the API key.',
    steps: [
      'Open Settings → AI providers and re-enter the key.',
      'Check the key’s permissions and billing with the provider.',
      'Run the check again.'
    ]
  },
  inconclusive: {
    explanation: 'No network problem was confirmed. If something still isn’t working, run the check again, or copy the report.',
    steps: ['Run the check again.']
  }
}

export const IT_STEPS = [
  'Send your IT team the hosts and problems listed in the attached report.',
  'Run the check again after they make the changes.'
]

/** Primary checks that did not pass, required ones when there are any. */
export function failingChecks(report: NetDoctorReport): NetDoctorCheck[] {
  const failing = report.checks.filter((c) => !isSupplementary(c) && !isPass(c.status))
  const required = failing.filter((c) => c.required)
  return required.length > 0 ? required : failing
}

export function diagnose(report: NetDoctorReport): NetDoctorDiagnosis {
  const failing = failingChecks(report)
  if (failing.length === 0) return 'inconclusive'
  const codes = new Set(failing.map((c) => c.outcome))
  // With the user's own keys, a 401 or 403 is a key problem, not a network problem.
  if ([...codes].every((c) => c === 'access_denied')) return 'credentials'
  const has = (...o: NetDoctorOutcome[]): boolean => o.some((x) => codes.has(x))
  if (has('unexpected_html', 'intercepted')) return 'captive_portal'
  if (has('dns_private_address')) return 'dns_filter'
  if (has('dns_failed', 'dns_timeout')) return 'dns_failure'
  if (has('tls_untrusted')) return 'tls_inspection'
  if (has('stream_held_back')) return 'stream_buffering'
  if (has('stream_slow_start', 'stream_cut_short')) return 'stream_delivery'
  if (has('websocket_blocked_upgrade', 'websocket_dropped')) return 'websocket_blocked'
  if (has('connection_failed', 'connection_timeout', 'access_denied')) {
    const transcription = failing.some((c) => c.feature === 'transcription' && c.required)
    return transcription ? 'websocket_blocked' : 'connection_failed'
  }
  return 'inconclusive'
}

export function attentionCount(report: NetDoctorReport): number {
  return report.features.filter((f) => f.status !== 'CONNECTION CHECKS PASSED').length
}

export function headline(report: NetDoctorReport): string {
  const n = attentionCount(report)
  if (n === 0) return 'All tested network connections succeeded.'
  return `${n} network ${n === 1 ? 'area needs' : 'areas need'} attention`
}

function diagnosticCode(c: NetDoctorCheck): string {
  switch (c.outcome) {
    case 'probe_error':
      return 'PROBE_ERROR'
    case 'asr_key_rejected':
      return 'ASR_KEY_MISSING'
    case 'unexpected_response':
      return 'RESPONSE_UNVERIFIED'
    default:
      return c.outcome.toUpperCase()
  }
}

/** The network change a failing check asks for (used in the report and the IT request). */
function remediation(c: NetDoctorCheck): string | null {
  switch (c.outcome) {
    case 'websocket_blocked_upgrade':
    case 'websocket_dropped':
      return `Allow WebSocket (wss://) upgrades to ${c.host}.`
    case 'tls_untrusted':
      return `Exempt ${c.host} from HTTPS inspection, or install the inspecting certificate on this device.`
    case 'dns_private_address':
      return `Stop DNS filtering or overriding ${c.host}.`
    case 'unexpected_html':
    case 'intercepted':
      return `Let ${c.host} through without a sign-in or block page.`
    case 'dns_failed':
    case 'dns_timeout':
    case 'connection_failed':
    case 'connection_timeout':
      return `Allow outbound HTTPS to ${c.host}.`
    default:
      return null
  }
}

function method(c: NetDoctorCheck): string {
  if (c.probe === 'websocket') return 'Node WebSocket'
  if (c.probe === 'dns') return 'DNS lookup'
  if (c.probe === 'tls') return 'TLS handshake'
  return c.stack === 'electron-net' ? 'Electron network fetch' : 'Node fetch'
}

function checkBlock(c: NetDoctorCheck): string[] {
  const lines = [`[${c.status}] ${method(c)} (${c.host}) · ${isSupplementary(c) ? 'supplementary' : c.required ? 'primary, required' : 'primary'}`]
  lines.push(`  ${c.label.replace(SUPPLEMENTARY_SUFFIX, '')}: ${OUTCOME_TEXT[c.outcome]}${c.detail ? ` (${c.detail})` : ''}`)
  lines.push(`  Outcome code: ${c.outcome}`)
  lines.push(`  Measurements: ${c.durationMs} ms`)
  const tech = [c.target, c.proxy ? `route ${c.proxy}` : null, c.tlsIssuer ? `certificate issuer ${c.tlsIssuer}` : null].filter(Boolean)
  lines.push(`  Technical detail: ${tech.join(' · ')}`)
  return lines
}

/** The network report Copy puts on the clipboard. Never contains a key: main never puts one in the report. */
export function reportText(report: NetDoctorReport): string {
  const out = ['Notula network report', '']
  out.push(`Checked at: ${new Date(report.finishedAt).toLocaleString()}`)
  out.push(`App version: ${report.appVersion} · ${report.platform}`)
  const routes = report.checks.filter((c) => !isSupplementary(c) && c.proxy).map((c) => `${c.host}: ${c.proxy}`)
  out.push(`Network path: ${[...new Set(routes)].join(' · ') || 'not resolved'}`)
  out.push('Configured transcription paths:')
  const transcription = report.checks.filter((c) => c.feature === 'transcription' && !isSupplementary(c))
  if (transcription.length === 0) out.push('  none')
  for (const c of transcription) out.push(`  ${c.label}: ${c.target}${c.required ? ' (selected)' : ''}`)
  out.push(`Summary: ${headline(report)}`, '')

  const ws = report.checks.filter((c) => c.probe === 'websocket')
  const http = report.checks.filter((c) => c.probe !== 'websocket')
  if (ws.length > 0) {
    out.push('Live transcription connection methods')
    for (const c of ws) out.push(...checkBlock(c), '')
  }
  if (http.length > 0) {
    out.push('Regular HTTPS fetch methods')
    for (const c of http) out.push(...checkBlock(c), '')
  }

  for (const f of report.features) {
    out.push(`[${f.status}] ${f.label}`)
    out.push(`Possible impact: ${f.symptom}`)
    const failing = report.checks.filter((c) => c.feature === f.feature && !isSupplementary(c) && !isPass(c.status))
    const changes = [...new Set(failing.map(remediation).filter((r): r is string => r !== null))]
    out.push(`Recommended network change(s): ${changes.length > 0 ? changes.join(' ') : 'none'}`)
    for (const c of report.checks.filter((x) => x.feature === f.feature && x.outcome === 'tls_intercepted_trusted')) {
      out.push(`Note: ${c.host} is inspected by ${c.tlsIssuer ?? 'a trusted authority'}, which this computer trusts.`)
    }
    for (const c of failing) out.push(`  ${c.host}: ${OUTCOME_TEXT[c.outcome]} · Diagnostic code: ${diagnosticCode(c)}`)
    out.push('')
  }
  const d = diagnose(report)
  out.push(`Diagnosis: ${d}`, DIAGNOSIS[d].explanation)
  return `${out.join('\n').trim()}\n`
}

/** The request for an IT team: the network changes to make, or a note to run the check again. */
export function itRequestText(report: NetDoctorReport): string {
  const tested = new Date(report.finishedAt).toLocaleString()
  const d = diagnose(report)
  if (d === 'inconclusive' || d === 'credentials') {
    return [
      'Notula network check needs repeating',
      '',
      'No network change is recommended: the check found nothing it could confirm as a network problem.',
      'Run the Notula network check again, ideally on the network where the problem happens.',
      '',
      `Tested: ${tested}`,
      ''
    ].join('\n')
  }
  const failing = report.checks.filter((c) => !isSupplementary(c) && !isPass(c.status))
  const affected = report.features.filter((f) => f.status !== 'CONNECTION CHECKS PASSED').map((f) => f.label)
  const https = [...new Set(failing.filter((c) => remediation(c)?.startsWith('Allow outbound HTTPS')).map((c) => c.host))]
  const other = [...new Set(failing.map(remediation).filter((r): r is string => r !== null && !r.startsWith('Allow outbound HTTPS')))]
  const changes = [...(https.length > 0 ? [`Allow outbound HTTPS (port 443) to: ${https.join(', ')}.`] : []), ...other]
  return [
    'Notula network change request',
    '',
    'Affected features',
    ...affected.map((a) => `- ${a}`),
    '',
    'Changes needed',
    ...(changes.length > 0 ? changes : ['Review the attached Notula network report; the failing hosts are listed there.']).map((c) => `- ${c}`),
    '',
    'After making changes',
    '- Ask them to run the Notula network check again to confirm the fix.',
    '- If it still fails, ask them for the Notula network report.',
    '',
    `Tested: ${tested}`,
    ''
  ].join('\n')
}
