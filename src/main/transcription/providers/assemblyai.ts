// SPDX-License-Identifier: Apache-2.0
// AssemblyAI Universal Streaming v3, with the service's own parameter and message names.
// Auth (per AssemblyAI's public docs): the raw API key goes in the `Authorization` header
// with no scheme.

import type { AssemblyAiMultilingualModel, AssemblyAiRegion } from '@shared/types/settings'
import type { AsrProviderId } from '@shared/types/transcript'
import type { SecretsApi, SettingsApi } from '../../context'
import { log } from '../../log'
import { cleanKeywords } from '../keywords'
import { cloudLanguage } from '../languages'
import { CloudConnection, num, str } from './connection'
import { devAsrEndpoint } from './dev-endpoint'
import { probeSocket } from './probe'
import type { AsrConnectOptions, AsrProvider, AsrResult, AsrWord } from './types'

const ENDPOINTS: Record<AssemblyAiRegion, string> = {
  edge: 'wss://streaming.assemblyai.com/v3/ws',
  us: 'wss://streaming.us.assemblyai.com/v3/ws',
  eu: 'wss://streaming.eu.assemblyai.com/v3/ws'
}
const VERSION_HEADER = { 'AssemblyAI-Version': '2025-05-12' }
const LIVENESS_MS = 10_000
const PARTIAL_DEBOUNCE_MS = 500
const TERMINATION_WAIT_MS = 5_000

interface AssemblyDeps {
  secrets: SecretsApi
  settings: SettingsApi
}

/**
 * English uses the English streaming model; `multi` uses the multilingual model the
 * user chose in settings, with language detection.
 */
function speechModel(language: string, multi: AssemblyAiMultilingualModel): string {
  return language === 'multi' ? multi : 'universal-streaming-english'
}

/** The universal-3.x-pro models are the ones that diarize. */
function isProModel(model: string): boolean {
  return /^universal-3-\d+-pro$/.test(model)
}

interface UrlOptions {
  region: AssemblyAiRegion
  language: string
  model: string
  keyterms: string[]
  speakerLabels: boolean
}

function buildUrl(o: UrlOptions): string {
  const q = new URLSearchParams()
  q.set('sample_rate', '16000')
  q.set('format_turns', 'true')
  q.set('filter_profanity', 'false')
  q.set('speech_model', o.model)
  if (o.language === 'multi') q.set('language_detection', 'true')
  // Only while Notula diarization is on, and only on a model that supports it.
  if (o.speakerLabels) q.set('speaker_labels', 'true')
  // A Heartbeat every 5 s keeps the 10 s liveness watchdog quiet through silence.
  q.set('session_heartbeat', 'true')
  if (o.keyterms.length) q.set('keyterms_prompt', JSON.stringify(o.keyterms))
  return `${devAsrEndpoint('assemblyai') ?? ENDPOINTS[o.region] ?? ENDPOINTS.edge}?${q.toString()}`
}

/** A provider speaker label (a number, or a letter) as a stable number per connection. */
function speakerIndex(map: Map<string, number>, raw: unknown): number | undefined {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  if (typeof raw !== 'string' || !raw) return undefined
  let n = map.get(raw)
  if (n === undefined) {
    n = map.size
    map.set(raw, n)
  }
  return n
}

async function authHeaders(secrets: SecretsApi): Promise<Record<string, string> | null> {
  const key = await secrets.get('asr.assemblyai')
  return key ? { Authorization: key, ...VERSION_HEADER } : null
}

class AssemblyConnection extends CloudConnection {
  readonly providerId: AsrProviderId = 'assemblyai'
  /** AssemblyAI wants roughly real-time pacing; replay at 5×. */
  readonly replayIntervalMs = 20
  private partialTimer: NodeJS.Timeout | null = null
  private pendingPartial: AsrResult | null = null
  private terminated: (() => void) | null = null
  private readonly speakers = new Map<string, number>()

  constructor(
    readonly model: string,
    private readonly opts: UrlOptions,
    secrets: SecretsApi,
    source: string
  ) {
    super(
      {
        name: `assemblyai:${source}`,
        url: () => buildUrl(opts),
        headers: () => authHeaders(secrets),
        minDelayMs: 200,
        maxDelayMs: 500,
        capDelayMs: 500
      },
      LIVENESS_MS
    )
  }

  updateKeywords(terms: string[]): void {
    this.opts.keyterms = cleanKeywords(terms)
    this.socket.sendJson({ type: 'UpdateConfiguration', keyterms_prompt: this.opts.keyterms })
  }

  protected override onSocketClose(): void {
    this.flushPartial()
  }

  protected onMessage(msg: Record<string, unknown>): void {
    this.markAlive()
    switch (msg['type']) {
      case 'Begin':
        log('info', 'asr:assemblyai-begin', { id: str(msg['id']) })
        return
      case 'Turn':
        this.onTurn(msg)
        return
      case 'Termination':
        this.terminated?.()
        return
      case 'Error':
        this.emit('error', {
          kind: 'provider',
          message: `${str(msg['error']) || 'Provider error'}${msg['error_code'] ? ` (${String(msg['error_code'])})` : ''}`
        })
        return
      default:
        // Heartbeat, SpeakerRevision, Silence and SpeechStarted only count as liveness.
        return
    }
  }

  private onTurn(msg: Record<string, unknown>): void {
    const endOfTurn = msg['end_of_turn'] === true
    const formatted = msg['turn_is_formatted'] === true
    // The formatted end-of-turn follows; skip the unformatted one.
    if (endOfTurn && !formatted) return
    const words: AsrWord[] = Array.isArray(msg['words'])
      ? (msg['words'] as Record<string, unknown>[]).map((w) => {
          const spk = speakerIndex(this.speakers, w['speaker'])
          return {
            w: str(w['text']),
            s_ms: num(w['start']),
            e_ms: num(w['end']),
            conf: num(w['confidence']),
            ...(spk !== undefined ? { spk } : {}),
            ...(typeof w['speaker_confidence'] === 'number' ? { spk_conf: w['speaker_confidence'] } : {})
          }
        })
      : []
    const first = words[0]
    const last = words[words.length - 1]
    const result: AsrResult = {
      segmentKey: `${this.socketGen}:${num(msg['turn_order'])}`,
      isFinal: endOfTurn,
      text: str(msg['transcript']),
      startMs: first ? first.s_ms : 0,
      endMs: last ? last.e_ms : 0,
      baseEpochMs: this.anchor(),
      words,
      ...(typeof msg['language_code'] === 'string' ? { language: msg['language_code'] } : {}),
      ...(typeof msg['end_of_turn_confidence'] === 'number'
        ? { turnEndScore: msg['end_of_turn_confidence'] }
        : {})
    }
    if (result.isFinal) {
      // A final supersedes any partial still waiting in the debounce.
      if (this.pendingPartial?.segmentKey === result.segmentKey) this.pendingPartial = null
      else this.flushPartial()
      if (this.partialTimer && !this.pendingPartial) {
        clearTimeout(this.partialTimer)
        this.partialTimer = null
      }
      this.emit('result', result)
      return
    }
    // Partials are debounced to 500 ms, with a maximum wait of 500 ms.
    if (this.pendingPartial && this.pendingPartial.segmentKey !== result.segmentKey) this.flushPartial()
    this.pendingPartial = result
    if (!this.partialTimer) this.partialTimer = setTimeout(() => this.flushPartial(), PARTIAL_DEBOUNCE_MS)
  }

  private flushPartial(): void {
    if (this.partialTimer) clearTimeout(this.partialTimer)
    this.partialTimer = null
    const p = this.pendingPartial
    this.pendingPartial = null
    if (p) this.emit('result', p)
  }

  protected async gracefulClose(waitMs: number): Promise<void> {
    if (!this.socket.isOpen()) return
    const done = new Promise<void>((resolve) => {
      this.terminated = resolve
    })
    this.socket.sendJson({ type: 'Terminate' }, false)
    await Promise.race([done, new Promise<void>((r) => setTimeout(r, Math.min(TERMINATION_WAIT_MS, waitMs)))])
    this.flushPartial()
  }
}

export function createAssemblyAiProvider(deps: AssemblyDeps): AsrProvider {
  return {
    id: 'assemblyai',
    kind: 'cloud',
    available: async () =>
      (await deps.secrets.get('asr.assemblyai')) ? { ok: true } : { ok: false, reason: 'no-key' },
    model: async (language) => speechModel(cloudLanguage(language), await deps.settings.get('asr.assemblyai.multilingualModel')),
    connect: async (o: AsrConnectOptions) => {
      const opts = { ...o, language: cloudLanguage(o.language) }
      const region = await deps.settings.get('asr.assemblyai.region')
      const model = speechModel(opts.language, await deps.settings.get('asr.assemblyai.multilingualModel'))
      const speakerLabels = isProModel(model) && (await deps.settings.get('transcription.diarization'))
      const conn = new AssemblyConnection(
        model,
        { region, language: opts.language, model, keyterms: cleanKeywords(opts.keywords), speakerLabels },
        deps.secrets,
        opts.source
      )
      return conn.start()
    },
    test: async () => {
      const region = await deps.settings.get('asr.assemblyai.region')
      return probeSocket({
        name: 'assemblyai:test',
        url: buildUrl({ region, language: 'en', model: 'universal-streaming-english', keyterms: [], speakerLabels: false }),
        headers: await authHeaders(deps.secrets),
        goodbye: { type: 'Terminate' }
      })
    }
  }
}
