// SPDX-License-Identifier: Apache-2.0
// Network Doctor's target list, built from settings at
// run time: the user's own providers only. Nothing is probed for a
// provider that is neither selected nor keyed. Keys go in headers exactly as the real
// clients send them, and never into a target string.

import { app } from 'electron'
import { isGeminiBaseUrl } from '@shared/types/enhance'
import type { NetDoctorFeature } from '@shared/types/netdoctor'
import type { Settings } from '@shared/types/settings'
import { MODEL_MANIFEST } from '../asr/manifest'
import type { MainContext } from '../context'
import type { EgressTarget } from '../privacy'
import type { HttpsExpect } from './probes'

export interface Target {
  feature: NetDoctorFeature
  label: string
  host: string
  port: number
  /** What the report shows: scheme, host and path, no query secrets. */
  target: string
  /** What is requested (may carry the provider's non-secret query). */
  url: string
  kind: 'websocket' | 'https'
  tls: boolean
  method: 'GET' | 'HEAD'
  /** Never reported or logged. */
  headers: Record<string, string>
  /** A transcription probe needs a key main does not have (`asr_key_rejected`). */
  credentialMissing: boolean
  required: boolean
  /** A private DNS answer is expected (local endpoints, user-entered hosts). */
  privateExpected: boolean
  stack: 'node' | 'electron-net'
  expect: HttpsExpect
  /** The other stack is tried too, as a supplementary row. */
  supplementary: boolean
  fingerprintHeader: string | null
  goodbye: unknown
  egress: EgressTarget | null
  /** The `impact` sentence used when only optional checks fail. */
  impact: string
}

export const FEATURE_LABELS: Record<NetDoctorFeature, string> = {
  transcription: 'Meeting transcription',
  ai: 'AI notes & chat',
  models: 'On-device model downloads',
  updates: 'Updates'
}

export const FEATURE_SYMPTOMS: Record<NetDoctorFeature, string> = {
  transcription: 'Live transcription with your provider may fail or keep reconnecting.',
  ai: 'Summaries, titles and chat may fail or time out.',
  models: 'On-device models can’t be downloaded.',
  updates: 'Notula can’t check for updates.'
}

const ANTHROPIC_BASE = 'https://api.anthropic.com'
const ASSEMBLY_HOSTS: Record<Settings['asr.assemblyai.region'], string> = {
  edge: 'streaming.assemblyai.com',
  us: 'streaming.us.assemblyai.com',
  eu: 'streaming.eu.assemblyai.com'
}

function portOf(u: URL): number {
  if (u.port) return Number(u.port)
  return u.protocol === 'http:' || u.protocol === 'ws:' ? 80 : 443
}

function shown(u: URL): string {
  return `${u.protocol}//${u.host}${u.pathname}`
}

function llmTarget(
  label: string,
  baseUrl: string,
  headers: Record<string, string>,
  required: boolean,
  privateExpected: boolean
): Target | null {
  let u: URL
  try {
    u = new URL(`${baseUrl.replace(/\/+$/, '')}/models`)
  } catch {
    return null
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
  return {
    feature: 'ai',
    label,
    host: u.hostname,
    port: portOf(u),
    target: shown(u),
    url: u.toString(),
    kind: 'https',
    tls: u.protocol === 'https:',
    method: 'GET',
    headers,
    credentialMissing: false,
    required,
    privateExpected,
    stack: 'node',
    expect: 'llm',
    supplementary: true,
    fingerprintHeader: null,
    goodbye: null,
    egress: { kind: 'llm' },
    impact: required ? FEATURE_SYMPTOMS.ai : `${label} can’t be reached if you switch to it.`
  }
}

/** The first URL of the local-ASR model manifest. */
function firstModelUrl(): string | null {
  for (const entry of Object.values(MODEL_MANIFEST)) {
    const url = entry.downloads[0]?.url
    if (url) return url
  }
  return null
}

function feedFile(): string {
  if (process.platform === 'darwin') return 'latest-mac.yml'
  if (process.platform === 'linux') return 'latest-linux.yml'
  return 'latest.yml'
}

export async function buildTargets(ctx: MainContext): Promise<Target[]> {
  const s = await ctx.settings.getAll()
  const targets: Target[] = []

  // ---- transcription ----
  const deepgramKey = await ctx.secrets.get('asr.deepgram')
  if (deepgramKey || s['asr.provider'] === 'deepgram') {
    const q = new URLSearchParams()
    q.set('model', s['asr.deepgram.model'] || 'nova-3')
    q.set('encoding', 'linear16')
    q.set('sample_rate', '16000')
    q.set('mip_opt_out', String(s['asr.deepgram.mipOptOut']))
    const required = s['asr.provider'] === 'deepgram'
    targets.push({
      feature: 'transcription',
      label: 'Deepgram live transcription',
      host: 'api.deepgram.com',
      port: 443,
      target: 'wss://api.deepgram.com/v1/listen',
      url: `wss://api.deepgram.com/v1/listen?${q.toString()}`,
      kind: 'websocket',
      tls: true,
      method: 'GET',
      headers: deepgramKey ? { Authorization: `Token ${deepgramKey}` } : {},
      credentialMissing: !deepgramKey,
      required,
      privateExpected: false,
      stack: 'node',
      expect: 'llm',
      supplementary: false,
      fingerprintHeader: 'dg-request-id',
      goodbye: { type: 'CloseStream' },
      egress: { kind: 'asr', provider: 'deepgram' },
      impact: 'Deepgram can’t be used for transcription if you switch to it.'
    })
  }
  const assemblyKey = await ctx.secrets.get('asr.assemblyai')
  if (assemblyKey || s['asr.provider'] === 'assemblyai') {
    const host = ASSEMBLY_HOSTS[s['asr.assemblyai.region']] ?? ASSEMBLY_HOSTS.edge
    const model = s['asr.language'] === 'multi' ? s['asr.assemblyai.multilingualModel'] : 'universal-streaming-english'
    const q = new URLSearchParams()
    q.set('sample_rate', '16000')
    q.set('format_turns', 'true')
    q.set('speech_model', model)
    const required = s['asr.provider'] === 'assemblyai'
    targets.push({
      feature: 'transcription',
      label: 'AssemblyAI live transcription',
      host,
      port: 443,
      target: `wss://${host}/v3/ws`,
      url: `wss://${host}/v3/ws?${q.toString()}`,
      kind: 'websocket',
      tls: true,
      method: 'GET',
      headers: assemblyKey ? { Authorization: assemblyKey, 'AssemblyAI-Version': '2025-05-12' } : {},
      credentialMissing: !assemblyKey,
      required,
      privateExpected: false,
      stack: 'node',
      expect: 'llm',
      supplementary: false,
      fingerprintHeader: null,
      goodbye: { type: 'Terminate' },
      egress: { kind: 'asr', provider: 'assemblyai' },
      impact: 'AssemblyAI can’t be used for transcription if you switch to it.'
    })
  }

  // ---- AI ----
  const anthropicKey = await ctx.secrets.get('llm.anthropic')
  if (anthropicKey || s['llm.provider'] === 'anthropic') {
    const dev = !app.isPackaged ? process.env['NOTULA_DEV_ANTHROPIC_BASE_URL']?.trim() : undefined
    const base = `${(dev || ANTHROPIC_BASE).replace(/\/+$/, '')}/v1`
    const t = llmTarget(
      'Anthropic API',
      base,
      { ...(anthropicKey ? { 'x-api-key': anthropicKey } : {}), 'anthropic-version': '2023-06-01' },
      s['llm.provider'] === 'anthropic',
      !!dev
    )
    if (t) targets.push(t)
  }
  const openaiKey = await ctx.secrets.get('llm.openai')
  if (openaiKey || s['llm.provider'] === 'openai') {
    const t = llmTarget(
      isGeminiBaseUrl(s['llm.openai.baseUrl']) ? 'Google Gemini API' : 'OpenAI-compatible API',
      s['llm.openai.baseUrl'],
      openaiKey ? { Authorization: `Bearer ${openaiKey}` } : {},
      s['llm.provider'] === 'openai',
      true
    )
    if (t) targets.push(t)
  }
  if (s['llm.provider'] === 'local') {
    const t = llmTarget('Local model server', s['llm.local.baseUrl'], {}, true, true)
    if (t) targets.push({ ...t, supplementary: false })
  }

  // ---- on-device models ----
  const modelUrl = firstModelUrl()
  if (modelUrl) {
    const u = new URL(modelUrl)
    targets.push({
      feature: 'models',
      label: 'Model downloads',
      host: u.hostname,
      port: portOf(u),
      target: shown(u),
      url: u.toString(),
      kind: 'https',
      tls: true,
      method: 'HEAD',
      headers: {},
      credentialMissing: false,
      required: false,
      privateExpected: false,
      stack: 'electron-net',
      expect: 'file',
      supplementary: true,
      fingerprintHeader: null,
      goodbye: null,
      egress: null,
      impact: FEATURE_SYMPTOMS.models
    })
  }

  // ---- updates ----
  const feed = __NOTULA_UPDATE_FEED_URL__
  if (feed) {
    try {
      const u = new URL(`${feed.replace(/\/+$/, '')}/${feedFile()}`)
      targets.push({
        feature: 'updates',
        label: 'Update feed',
        host: u.hostname,
        port: portOf(u),
        target: shown(u),
        url: u.toString(),
        kind: 'https',
        tls: u.protocol === 'https:',
        method: 'HEAD',
        headers: {},
        credentialMissing: false,
        required: false,
        privateExpected: false,
        stack: 'electron-net',
        expect: 'feed',
        supplementary: true,
        fingerprintHeader: null,
        goodbye: null,
        egress: null,
        impact: FEATURE_SYMPTOMS.updates
      })
    } catch {
      // A malformed build-time feed is the updater's to report.
    }
  }
  return targets
}
