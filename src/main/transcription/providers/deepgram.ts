// SPDX-License-Identifier: Apache-2.0
// Deepgram streaming, with the service's own parameter and message names.
// Auth (per Deepgram's public docs): a raw API key goes in
// `Authorization: Token <key>`; `Bearer` is only for short-lived JWTs.

import type { DeepgramMultilingualVersion } from '@shared/types/settings'
import type { AsrProviderId } from '@shared/types/transcript'
import type { SecretsApi, SettingsApi } from '../../context'
import { log } from '../../log'
import { deepgramKeyterms } from '../keywords'
import { cloudLanguage } from '../languages'
import { CloudConnection, num, str } from './connection'
import { devAsrEndpoint } from './dev-endpoint'
import { probeSocket } from './probe'
import type { AsrConnectOptions, AsrProvider, AsrResult, AsrWord } from './types'

const ENDPOINT = 'wss://api.deepgram.com/v1/listen'
const KEEPALIVE_MS = 3_000
const LIVENESS_MS = 30_000
const CLOSE_WAIT_MS = 5_000

interface DeepgramDeps {
  secrets: SecretsApi
  settings: SettingsApi
}

interface UrlOptions {
  model: string
  mipOptOut: boolean
  language: string
  keyterms: string[]
  /** `multi` with nova-3-mega sends `version=58-lang-beta`. */
  version: string | null
}

/** The model version for a session: only `multi` uses the multilingual setting. */
function versionFor(language: string, setting: DeepgramMultilingualVersion): string | null {
  return language === 'multi' && setting === '58-lang-beta' ? '58-lang-beta' : null
}

function buildUrl(o: UrlOptions): string {
  const q = new URLSearchParams()
  q.set('channels', '1')
  q.set('smart_format', 'true')
  q.set('profanity_filter', 'false')
  q.set('interim_results', 'true')
  q.set('model', o.model)
  q.set('encoding', 'linear16')
  q.set('sample_rate', '16000')
  q.set('mip_opt_out', String(o.mipOptOut))
  if (o.language === 'multi') {
    q.set('language', 'multi')
    q.set('endpointing', '100')
  }
  if (o.version) q.set('version', o.version)
  for (const t of o.keyterms) q.append('keyterm', t)
  return `${devAsrEndpoint('deepgram') ?? ENDPOINT}?${q.toString()}`
}

async function authHeaders(secrets: SecretsApi): Promise<Record<string, string> | null> {
  const key = await secrets.get('asr.deepgram')
  return key ? { Authorization: `Token ${key}` } : null
}

class DeepgramConnection extends CloudConnection {
  readonly providerId: AsrProviderId = 'deepgram'
  readonly replayIntervalMs = 0
  private keepAlive: NodeJS.Timeout | null = null
  private segment = 0

  constructor(
    readonly model: string,
    private readonly urlOpts: UrlOptions,
    secrets: SecretsApi,
    source: string
  ) {
    super(
      {
        name: `deepgram:${source}`,
        // Keywords changed mid-session apply at the next connection.
        url: () => buildUrl(urlOpts),
        headers: () => authHeaders(secrets)
      },
      LIVENESS_MS
    )
  }

  updateKeywords(terms: string[]): void {
    this.urlOpts.keyterms = deepgramKeyterms(terms)
  }

  protected override onSocketOpen(): void {
    this.segment = 0
    this.keepAlive = setInterval(() => this.socket.sendJson({ type: 'KeepAlive' }, false), KEEPALIVE_MS)
  }

  protected override onSocketClose(): void {
    if (this.keepAlive) clearInterval(this.keepAlive)
    this.keepAlive = null
  }

  protected onMessage(msg: Record<string, unknown>): void {
    const type = msg['type']
    if (type === 'Metadata') {
      log('info', 'asr:deepgram-metadata', { request_id: str(msg['request_id']) })
      return
    }
    if (type !== 'Results') return
    this.markAlive()
    const channel = msg['channel'] as { alternatives?: unknown[] } | undefined
    const alt = (channel?.alternatives?.[0] ?? {}) as { transcript?: unknown; words?: unknown[] }
    const start = num(msg['start'])
    const duration = num(msg['duration'])
    const isFinal = msg['is_final'] === true
    const words: AsrWord[] = (alt.words ?? []).map((raw) => {
      const w = raw as Record<string, unknown>
      return {
        w: str(w['punctuated_word']) || str(w['word']),
        s_ms: Math.round(num(w['start']) * 1000),
        e_ms: Math.round(num(w['end']) * 1000),
        conf: num(w['confidence']),
        ...(typeof w['speaker'] === 'number' ? { spk: w['speaker'] } : {}),
        ...(typeof w['language'] === 'string' ? { lang: w['language'] } : {})
      }
    })
    const result: AsrResult = {
      // One chunk id per utterance's partials until a final closes it.
      segmentKey: `${this.socketGen}:${this.segment}`,
      isFinal,
      text: str(alt.transcript),
      startMs: Math.round(start * 1000),
      endMs: Math.round((start + duration) * 1000),
      baseEpochMs: this.anchor(),
      words
    }
    if (isFinal) this.segment++
    this.emit('result', result)
  }

  protected async gracefulClose(waitMs: number): Promise<void> {
    if (!this.socket.isOpen()) return
    this.socket.sendJson({ type: 'CloseStream' }, false)
    await this.socket.waitForServerClose(Math.min(CLOSE_WAIT_MS, waitMs))
  }
}

export function createDeepgramProvider(deps: DeepgramDeps): AsrProvider {
  return {
    id: 'deepgram',
    kind: 'cloud',
    available: async () => ((await deps.secrets.get('asr.deepgram')) ? { ok: true } : { ok: false, reason: 'no-key' }),
    model: async (language) => {
      const version = versionFor(cloudLanguage(language), await deps.settings.get('asr.deepgram.multilingualVersion'))
      // The URL still carries nova-3; the record names the variant (its "model id").
      return version ? 'nova-3-mega' : deps.settings.get('asr.deepgram.model')
    },
    connect: async (o: AsrConnectOptions) => {
      const opts = { ...o, language: cloudLanguage(o.language) }
      const model = (await deps.settings.get('asr.deepgram.model')) || 'nova-3'
      const mipOptOut = await deps.settings.get('asr.deepgram.mipOptOut')
      const version = versionFor(opts.language, await deps.settings.get('asr.deepgram.multilingualVersion'))
      const conn = new DeepgramConnection(
        version ? 'nova-3-mega' : model,
        { model, mipOptOut, language: opts.language, keyterms: deepgramKeyterms(opts.keywords), version },
        deps.secrets,
        opts.source
      )
      return conn.start()
    },
    test: async () => {
      const model = (await deps.settings.get('asr.deepgram.model')) || 'nova-3'
      const mipOptOut = await deps.settings.get('asr.deepgram.mipOptOut')
      return probeSocket({
        name: 'deepgram:test',
        url: buildUrl({ model, mipOptOut, language: 'en', keyterms: [], version: null }),
        headers: await authHeaders(deps.secrets),
        goodbye: { type: 'CloseStream' }
      })
    }
  }
}
