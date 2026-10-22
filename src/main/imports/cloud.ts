// SPDX-License-Identifier: Apache-2.0
// Cloud transcription of an imported recording (confirmed
// against the providers' public docs on 2026-10-16). The original file goes unchanged to the user's
// provider, from main, with the user's key and diarization requested; nothing else is sent.
//
// - Deepgram: `POST https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true&punctuate=true
//   &diarize=true&utterances=true&language=<code|multi>`, `Authorization: Token <key>`, the raw file
//   as the body with its audio content type. One request uploads and transcribes.
// - AssemblyAI: `POST /v2/upload` (raw bytes, `application/octet-stream`) → `upload_url`, then
//   `POST /v2/transcript` `{ audio_url, speaker_labels: true, language_code | language_detection }`,
//   polled with `GET /v2/transcript/<id>` every 5 s until `completed` or `error`, with no cap
//   while the provider reports progress. `authorization: <key>`. EU host `api.eu.assemblyai.com`.
// - 401/403 → "Your <provider> key was rejected."; other provider errors carry their message.
// Results become one chunk per speaker turn, with the provider's speaker labels kept as `spk`.

import { createReadStream } from 'node:fs'
import { Readable } from 'node:stream'
import { net } from 'electron'
import { IMPORT_LIMITS } from '@shared/types/recordings'
import type { CloudAsrProviderId, ProviderWord } from '@shared/types/transcript'
import type { MainContext } from '../context'
import { log } from '../log'
import { devAsrHttpBase } from '../transcription/providers/dev-endpoint'

const DEEPGRAM = 'https://api.deepgram.com'
const ASSEMBLYAI = { default: 'https://api.assemblyai.com', eu: 'https://api.eu.assemblyai.com' }
/** A safety stop for a provider that never finishes (there is no cap while it reports progress). */
const POLL_LIMIT_MS = 6 * 3_600_000

export class ImportFailure extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ImportFailure'
  }
}

export interface CloudTurn {
  startMs: number
  endMs: number
  text: string
  words: ProviderWord[]
}

export interface CloudResult {
  provider: CloudAsrProviderId
  model: string
  language: string
  turns: CloudTurn[]
}

const CONTENT_TYPES: Record<string, string> = { '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.wav': 'audio/wav' }

function providerName(p: CloudAsrProviderId): string {
  return p === 'deepgram' ? 'Deepgram' : 'AssemblyAI'
}

/** The file as a request body; `onSent` fires once the last byte left. */
function fileBody(path: string, onSent: () => void): ReadableStream<Uint8Array> {
  const stream = createReadStream(path, { highWaterMark: 1_048_576 })
  stream.once('end', onSent)
  return Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>
}

async function errorText(res: Response): Promise<string> {
  try {
    const text = await res.text()
    try {
      const j = JSON.parse(text) as Record<string, unknown>
      const m = j['err_msg'] ?? j['error'] ?? j['message']
      if (typeof m === 'string' && m.trim()) return m.trim().slice(0, 300)
    } catch {
      // Plain text.
    }
    return text.trim().slice(0, 300)
  } catch {
    return ''
  }
}

async function check(res: Response, provider: CloudAsrProviderId): Promise<void> {
  if (res.ok) return
  if (res.status === 401 || res.status === 403) throw new ImportFailure(`Your ${providerName(provider)} key was rejected.`)
  const msg = await errorText(res)
  throw new ImportFailure(msg || `${providerName(provider)} returned an error (HTTP ${res.status}).`)
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t)
        reject(new ImportFailure('cancelled'))
      },
      { once: true }
    )
  })
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

// ---------- Deepgram ----------

async function deepgram(ctx: MainContext, file: { path: string; ext: string }, language: string, signal: AbortSignal, onSent: () => void): Promise<CloudResult> {
  const key = await ctx.secrets.get('asr.deepgram')
  if (!key) throw new ImportFailure('No Deepgram key is set.')
  const q = new URLSearchParams()
  q.set('model', 'nova-3')
  q.set('smart_format', 'true')
  q.set('punctuate', 'true')
  q.set('diarize', 'true')
  q.set('utterances', 'true')
  q.set('language', language === 'multi' ? 'multi' : language)
  const url = `${devAsrHttpBase('deepgram') ?? DEEPGRAM}/v1/listen?${q.toString()}`
  const res = await net.fetch(url, {
    method: 'POST',
    headers: { Authorization: `Token ${key}`, 'Content-Type': CONTENT_TYPES[file.ext] ?? 'application/octet-stream' },
    body: fileBody(file.path, onSent),
    signal,
    duplex: 'half'
  } as RequestInit)
  await check(res, 'deepgram')
  const json = (await res.json()) as Record<string, unknown>
  const results = (json['results'] ?? {}) as Record<string, unknown>
  const utterances = Array.isArray(results['utterances']) ? (results['utterances'] as Record<string, unknown>[]) : []
  const toWord = (w: Record<string, unknown>): ProviderWord => ({
    w: String(w['punctuated_word'] ?? w['word'] ?? ''),
    s_ms: Math.round(num(w['start']) * 1000),
    e_ms: Math.round(num(w['end']) * 1000),
    conf: num(w['confidence']),
    ...(typeof w['speaker'] === 'number' ? { spk: w['speaker'] } : {}),
    ...(typeof w['speaker_confidence'] === 'number' ? { spk_conf: w['speaker_confidence'] } : {})
  })
  let turns: CloudTurn[] = utterances
    .map((u) => ({
      startMs: Math.round(num(u['start']) * 1000),
      endMs: Math.round(num(u['end']) * 1000),
      text: String(u['transcript'] ?? '').trim(),
      words: (Array.isArray(u['words']) ? (u['words'] as Record<string, unknown>[]) : []).map(toWord)
    }))
    .filter((t) => t.text)
  if (!turns.length) {
    // No utterances: one turn per speaker change over the channel's words.
    const channel = ((results['channels'] as Record<string, unknown>[] | undefined)?.[0] ?? {}) as Record<string, unknown>
    const alt = ((channel['alternatives'] as Record<string, unknown>[] | undefined)?.[0] ?? {}) as Record<string, unknown>
    const words = (Array.isArray(alt['words']) ? (alt['words'] as Record<string, unknown>[]) : []).map(toWord)
    turns = splitTurns(words)
  }
  const detected = (((results['channels'] as Record<string, unknown>[] | undefined)?.[0] ?? {}) as Record<string, unknown>)['detected_language']
  return { provider: 'deepgram', model: 'nova-3', language: typeof detected === 'string' ? detected : language, turns }
}

// ---------- AssemblyAI ----------

async function assemblyai(
  ctx: MainContext,
  file: { path: string; ext: string },
  language: string,
  signal: AbortSignal,
  onSent: () => void
): Promise<CloudResult> {
  const key = await ctx.secrets.get('asr.assemblyai')
  if (!key) throw new ImportFailure('No AssemblyAI key is set.')
  const region = await ctx.settings.get('asr.assemblyai.region')
  const base = devAsrHttpBase('assemblyai') ?? (region === 'eu' ? ASSEMBLYAI.eu : ASSEMBLYAI.default)
  const up = await net.fetch(`${base}/v2/upload`, {
    method: 'POST',
    headers: { authorization: key, 'Content-Type': 'application/octet-stream' },
    body: fileBody(file.path, onSent),
    signal,
    duplex: 'half'
  } as RequestInit)
  await check(up, 'assemblyai')
  const uploadUrl = ((await up.json()) as Record<string, unknown>)['upload_url']
  if (typeof uploadUrl !== 'string' || !uploadUrl) throw new ImportFailure('AssemblyAI did not accept the file.')
  const body: Record<string, unknown> = { audio_url: uploadUrl, speaker_labels: true }
  if (language === 'multi') body['language_detection'] = true
  else body['language_code'] = language
  const sub = await net.fetch(`${base}/v2/transcript`, {
    method: 'POST',
    headers: { authorization: key, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal
  })
  await check(sub, 'assemblyai')
  const id = ((await sub.json()) as Record<string, unknown>)['id']
  if (typeof id !== 'string' || !id) throw new ImportFailure('AssemblyAI did not start the transcription.')
  log('info', 'imports:assemblyai-submitted', { region })
  const started = Date.now()
  for (;;) {
    await sleep(IMPORT_LIMITS.assemblyAiPollMs, signal)
    const res = await net.fetch(`${base}/v2/transcript/${encodeURIComponent(id)}`, { headers: { authorization: key }, signal })
    await check(res, 'assemblyai')
    const t = (await res.json()) as Record<string, unknown>
    const status = t['status']
    if (status === 'error') throw new ImportFailure(typeof t['error'] === 'string' && t['error'] ? t['error'] : 'Notula couldn’t transcribe this file. Try again.')
    if (status === 'completed') return assemblyResult(t, language)
    if (Date.now() - started > POLL_LIMIT_MS) throw new ImportFailure('Transcription took too long. Try importing it again.')
  }
}

function assemblyResult(t: Record<string, unknown>, language: string): CloudResult {
  const speakers = new Map<string, number>()
  const spk = (raw: unknown): number | undefined => {
    if (typeof raw === 'number') return raw
    if (typeof raw !== 'string' || !raw) return undefined
    let n = speakers.get(raw)
    if (n === undefined) {
      n = speakers.size
      speakers.set(raw, n)
    }
    return n
  }
  const toWord = (w: Record<string, unknown>): ProviderWord => {
    const s = spk(w['speaker'])
    return {
      w: String(w['text'] ?? ''),
      s_ms: Math.round(num(w['start'])),
      e_ms: Math.round(num(w['end'])),
      conf: num(w['confidence']),
      ...(s !== undefined ? { spk: s } : {})
    }
  }
  const utterances = Array.isArray(t['utterances']) ? (t['utterances'] as Record<string, unknown>[]) : []
  let turns: CloudTurn[] = utterances
    .map((u) => ({
      startMs: Math.round(num(u['start'])),
      endMs: Math.round(num(u['end'])),
      text: String(u['text'] ?? '').trim(),
      words: (Array.isArray(u['words']) ? (u['words'] as Record<string, unknown>[]) : []).map(toWord)
    }))
    .filter((x) => x.text)
  if (!turns.length) turns = splitTurns((Array.isArray(t['words']) ? (t['words'] as Record<string, unknown>[]) : []).map(toWord))
  const model = typeof t['speech_model_used'] === 'string' ? t['speech_model_used'] : typeof t['speech_model'] === 'string' ? t['speech_model'] : 'assemblyai'
  return { provider: 'assemblyai', model, language: typeof t['language_code'] === 'string' ? t['language_code'] : language, turns }
}

/** One turn per run of one speaker (a fallback when the provider gives no utterances). */
function splitTurns(words: ProviderWord[]): CloudTurn[] {
  const out: CloudTurn[] = []
  let cur: CloudTurn | null = null
  let curSpk: number | undefined
  for (const w of words) {
    if (!w.w.trim()) continue
    if (!cur || w.spk !== curSpk) {
      cur = { startMs: w.s_ms, endMs: w.e_ms, text: w.w, words: [w] }
      curSpk = w.spk
      out.push(cur)
      continue
    }
    cur.text = `${cur.text} ${w.w}`
    cur.endMs = Math.max(cur.endMs, w.e_ms)
    cur.words.push(w)
  }
  return out
}

/** Sends the file to the provider and returns its turns. */
export function transcribeInCloud(
  ctx: MainContext,
  provider: CloudAsrProviderId,
  file: { path: string; ext: string },
  language: string,
  signal: AbortSignal,
  onSent: () => void
): Promise<CloudResult> {
  return provider === 'deepgram' ? deepgram(ctx, file, language, signal, onSent) : assemblyai(ctx, file, language, signal, onSent)
}
