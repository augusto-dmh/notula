// SPDX-License-Identifier: Apache-2.0
// OpenAI-compatible chat completions over `fetch` with SSE parsing (no `openai` SDK).
// One implementation serves two providers:
// - `openai`: a cloud endpoint with the user's key ('llm.openai'), base URL from settings;
// - `local`:  no key, an OpenAI-compatible localhost server (e.g. Ollama).
//
// Chat: `tools` as `function` tools with `tool_choice: 'auto'`, streamed.
// `delta.tool_calls[i]` (id, name, argument chunks) become the tool-call events, and
// `finish_reason: 'tool_calls'` becomes `stop{tool_use}`. A replayed assistant turn
// carries its `tool_calls`, then one `{ role: 'tool' }` message per result. A server
// that rejects tools (400/422 naming tools or functions), or ignores them and writes a
// tool call as text, throws `LlmToolsUnsupportedError`; the chat engine then retries
// without tools.
//
// Images travel as `image_url` data-URL parts after the user
// text, only while the provider's "This model accepts images" setting is on; `temperature`
// is sent when a purpose sets it; a 2xx `text/html` answer is an intercepting network
// (intercept.ts).

import { GEMINI_PRESET, newestFlashModel, parseRetiredModel, type LlmProviderId } from '@shared/types/enhance'
import { enhanceError, EnhanceError } from '../enhance/errors'
import { log } from '../log'
import { checkIntercepted, LlmInterceptedError } from './intercept'
import { noteRetiredModel } from './retired'
import { openAiUsage } from './usage'
import {
  LlmImagesUnsupportedError,
  LlmToolsUnsupportedError,
  PURPOSE_EFFORT,
  type LlmAvailability,
  type LlmChatEvent,
  type LlmChatMessage,
  type LlmChatRequest,
  type LlmImage,
  type LlmProvider,
  type LlmPurpose,
  type LlmRequest,
  type LlmStopReason,
  type LlmStreamEvent
} from './types'

const CONNECT_TIMEOUT_MS = 185_000
const SHORT_TIMEOUT_MS = 15_000
const MAX_ERROR_CHARS = 200

interface Options {
  id: Extract<LlmProviderId, 'openai' | 'local'>
  baseUrl: string
  model: string
  /** null for the local provider. */
  getKey: (() => Promise<string | null>) | null
  /** `llm.openai.acceptsImages` / `llm.local.acceptsImages`. */
  acceptsImages: boolean
}

interface ToolCallDelta {
  index?: number
  id?: string
  type?: string
  function?: { name?: string; arguments?: string }
}

interface ChatChoice {
  delta?: {
    content?: string | null
    reasoning_content?: string | null
    reasoning?: string | null
    tool_calls?: ToolCallDelta[] | null
  }
  message?: { content?: string | null; refusal?: string | null }
  finish_reason?: string | null
}

/** What a replayed assistant turn sends back: its text and its calls with the raw arguments. */
interface OpenAiReplay {
  content: string
  toolCalls: { id: string; name: string; arguments: string }[]
}

/** Text that is a tool call a server wrote out instead of using `tool_calls`. */
const TOOL_TEXT_LEAD = /^(\{|\[\s*\{|<tool_call>|\[TOOL_CALLS\]|```(?:json)?\s*\{)/
const TOOL_ERROR_HINT = /\b(tools?|tool_choice|function[s_]?|function calling)\b/i
/** A 400 about the output budget (errorFromResponse puts the status in the message). */
/** A 400 naming `stream_options`: the server takes no usage request on a stream. */
const STREAM_OPTIONS_HINT = /\bstream_options\b/i
const TOKEN_LIMIT_HINT = /\(400\).*\b(max_tokens|max_completion_tokens|max_output_tokens|output limit|token limit)\b/i

function label(id: Options['id']): string {
  return id === 'local' ? 'The local model' : 'The AI provider'
}

function trimSlash(url: string): string {
  return url.trim().replace(/\/+$/, '')
}

function stopReason(finish: string | null | undefined): LlmStopReason {
  if (finish === 'length') return 'max_tokens'
  if (finish === 'content_filter') return 'refusal'
  return 'end'
}

/** Newer OpenAI models reject `max_tokens`; other compatible servers expect it. */
function tokenField(baseUrl: string): 'max_completion_tokens' | 'max_tokens' {
  try {
    return new URL(baseUrl).hostname === 'api.openai.com' ? 'max_completion_tokens' : 'max_tokens'
  } catch {
    return 'max_tokens'
  }
}

/**
 * Gemini's compatible endpoint thinks at full depth unless told otherwise, which can outlast a
 * short task's budget (voice typing allows 10 s). It takes the purpose's effort as
 * `reasoning_effort`; other servers get nothing, since some reject the field.
 */
function effortField(baseUrl: string, effort: 'minimal' | 'low' | 'medium' | 'high'): { reasoning_effort?: string } {
  return isGemini(baseUrl) ? { reasoning_effort: effort } : {}
}

function isGemini(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname === GEMINI_PRESET.host
  } catch {
    return false
  }
}

/**
 * Short tasks a person waits on. Even at `low`, Gemini's Flash models think for several
 * seconds, which outlasts voice typing's 10 s budget; these ask for `minimal`.
 */
const QUICK_PURPOSES: ReadonlySet<LlmPurpose> = new Set<LlmPurpose>(['dictation-format', 'dictation-learn', 'off-record-check'])

/**
 * The quick tasks also run on the key's newest Flash-Lite, Gemini's lightest model, while
 * notes and chat keep the chosen one. Looked up from the model list once an hour per base URL;
 * null when the key lists none or the lite model failed (then the chosen model is used).
 */
const QUICK_MODEL_TTL_MS = 60 * 60_000
const quickModels = new Map<string, { model: string | null; at: number }>()
/** `baseUrl|model` pairs that refused `minimal`; they get `low`. */
const minimalRejected = new Set<string>()
/** Base URLs that refused `stream_options`; their streams are sent without it from then on. */
const streamOptionsRejected = new Set<string>()

/**
 * Drops a leading `<think>…</think>` block, which many local reasoning models write
 * into the content itself. Anything else passes through unchanged.
 */
class ThinkFilter {
  private state: 'start' | 'thinking' | 'pass' = 'start'
  private buffer = ''

  push(delta: string): string {
    if (this.state === 'pass') return delta
    this.buffer += delta
    if (this.state === 'start') {
      const lead = this.buffer.trimStart()
      if (lead.startsWith('<think>')) {
        this.state = 'thinking'
        this.buffer = lead.slice('<think>'.length)
      } else if ('<think>'.startsWith(lead)) {
        return ''
      } else {
        this.state = 'pass'
        const out = this.buffer
        this.buffer = ''
        return out
      }
    }
    const end = this.buffer.indexOf('</think>')
    if (end === -1) {
      // Keep only enough to recognize a closing tag split across deltas.
      this.buffer = this.buffer.slice(-('</think>'.length - 1))
      return ''
    }
    this.state = 'pass'
    const out = this.buffer.slice(end + '</think>'.length).trimStart()
    this.buffer = ''
    return out
  }

  /** What is left at the end: an unclosed think block is dropped. */
  end(): string {
    const out = this.state === 'start' ? this.buffer : ''
    this.buffer = ''
    return out
  }
}

/** `model` is the model the request asked for, or null for a call that names none (the list). */
async function errorFromResponse(id: Options['id'], res: Response, model: string | null): Promise<EnhanceError> {
  let detail = ''
  try {
    const json = (await res.json()) as unknown
    // Some compatible servers wrap the error object in a one-item array.
    const body = (Array.isArray(json) ? json[0] : json) as { error?: { message?: unknown } | string; message?: unknown } | null
    const msg = typeof body?.error === 'string' ? body.error : (body?.error?.message ?? body?.message)
    if (typeof msg === 'string') detail = msg.slice(0, MAX_ERROR_CHARS)
  } catch {
    // Not JSON: the status says enough.
  }
  if (res.status === 401 || res.status === 403) {
    return enhanceError('missing-key', `${label(id)} rejected the API key.`)
  }
  // Settings ▸ AI offers the switch, whichever task hit it.
  const retired = model && detail ? parseRetiredModel(detail, model) : null
  if (retired && model) {
    noteRetiredModel(id, { model, reason: detail, replacement: retired.replacement })
    return enhanceError('no-model', detail)
  }
  if (res.status === 404) {
    return enhanceError('no-model', detail || `${label(id)} does not offer the selected model, or the base URL is wrong.`)
  }
  return enhanceError('provider-error', `${label(id)} returned an error (${res.status})${detail ? `: ${detail}` : '.'}`)
}

function networkError(id: Options['id'], baseUrl: string, err: unknown): Error {
  if (err instanceof EnhanceError) return err
  if (err instanceof LlmInterceptedError) return enhanceError('provider-error', err.message)
  if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
    const e = new Error('The request was cancelled.')
    e.name = 'AbortError'
    return e
  }
  return enhanceError(
    'provider-error',
    id === 'local' ? `Could not reach the local model at ${baseUrl}.` : `Could not reach ${baseUrl}. Check your connection.`
  )
}

/** Yields each SSE `data:` payload; comments and other fields are skipped. */
async function* sseData(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const decoder = new TextDecoder()
  let buffer = ''
  const reader = body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true })
      let nl: number
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).replace(/\r$/, '')
        buffer = buffer.slice(nl + 1)
        if (line.startsWith('data:')) yield line.slice(5).trimStart()
      }
      if (done) {
        if (buffer.startsWith('data:')) yield buffer.slice(5).trimStart()
        return
      }
    }
  } finally {
    reader.releaseLock()
  }
}

export function createOpenAiCompatibleProvider(opts: Options): LlmProvider {
  const baseUrl = trimSlash(opts.baseUrl)
  const model = opts.model.trim()

  /** A request with images while the setting is off fails before any network call. */
  function checkImages(req: LlmRequest | LlmChatRequest): void {
    const images =
      'messages' in req
        ? req.messages.some((m) => m.role === 'user' && (m.images?.length ?? 0) > 0)
        : (req.images?.length ?? 0) > 0
    if (images && !opts.acceptsImages) throw new LlmImagesUnsupportedError(opts.id, req.model?.trim() || model)
  }

  async function headers(): Promise<Record<string, string>> {
    const h: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' }
    if (opts.getKey) {
      const key = await opts.getKey()
      if (!key) throw enhanceError('missing-key', 'No API key is set for this provider.')
      h['Authorization'] = `Bearer ${key}`
    }
    return h
  }

  function body(req: LlmRequest, stream: boolean, withUsage: boolean): string {
    return JSON.stringify({
      model: req.model?.trim() || model,
      messages: [
        { role: 'system', content: req.system },
        { role: 'user', content: userContent(req.user, req.images) }
      ],
      stream,
      ...(withUsage ? { stream_options: { include_usage: true } } : {}),
      ...(typeof req.temperature === 'number' ? { temperature: req.temperature } : {}),
      ...effortField(baseUrl, minimalFor(req) ? 'minimal' : PURPOSE_EFFORT[req.purpose]),
      [tokenField(baseUrl)]: req.maxTokens
    })
  }

  // A model that rejects `minimal` gets `low` from then on, across providers built later (see post).
  const used = (req: LlmRequest): string => req.model?.trim() || model
  const minimalFor = (req: LlmRequest): boolean =>
    QUICK_PURPOSES.has(req.purpose) && isGemini(baseUrl) && !minimalRejected.has(`${baseUrl}|${used(req)}`)

  /** A quick task on Gemini runs on the newest Flash-Lite, when the key lists one. */
  async function quickModel(req: LlmRequest, signal: AbortSignal): Promise<LlmRequest> {
    if (req.model?.trim() || !QUICK_PURPOSES.has(req.purpose) || !isGemini(baseUrl)) return req
    const hit = quickModels.get(baseUrl)
    let lite = hit && Date.now() - hit.at < QUICK_MODEL_TTL_MS ? hit.model : undefined
    if (lite === undefined) {
      try {
        lite = newestFlashModel(await listModels(AbortSignal.any([signal, AbortSignal.timeout(3_000)])), 'flash-lite')
      } catch {
        lite = null
      }
      quickModels.set(baseUrl, { model: lite, at: Date.now() })
      log('info', 'llm:quick-model', { provider: opts.id, model: lite })
    }
    return lite ? { ...req, model: lite } : req
  }

  /** Once per base URL for the process: its streams go without `stream_options` and report no usage. */
  function rejectStreamOptions(): void {
    if (streamOptionsRejected.has(baseUrl)) return
    streamOptionsRejected.add(baseUrl)
    log('info', 'llm:usage-unsupported', { provider: opts.id })
  }

  /** The reply, and the model id actually sent (a quick task may run on a lighter one). */
  async function post(given: LlmRequest, stream: boolean, signal: AbortSignal): Promise<{ res: Response; sent: string }> {
    if (!baseUrl) throw enhanceError('no-model', 'No base URL is set for this provider.')
    if (!model && !given.model?.trim()) throw enhanceError('no-model', 'No model is selected for this provider.')
    const req = await quickModel(given, signal)
    const withUsage = stream && !streamOptionsRejected.has(baseUrl)
    let res: Response
    try {
      res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: await headers(),
        body: body(req, stream, withUsage),
        signal: AbortSignal.any([signal, AbortSignal.timeout(CONNECT_TIMEOUT_MS)])
      })
    } catch (err) {
      throw networkError(opts.id, baseUrl, err)
    }
    if (!res.ok && res.status === 400 && (minimalFor(req) || withUsage)) {
      const text = await res.text().catch(() => '')
      if (minimalFor(req) && /reasoning|thinking/i.test(text)) {
        minimalRejected.add(`${baseUrl}|${used(req)}`)
        log('info', 'llm:minimal-effort-unsupported', { provider: opts.id, model: used(req) })
        return post(given, stream, signal)
      }
      if (withUsage && STREAM_OPTIONS_HINT.test(text)) {
        rejectStreamOptions()
        return post(given, stream, signal)
      }
      res = new Response(text, { status: res.status })
    }
    // The lite model failed outright (retired, or not open to this key): the chosen model takes over.
    if (!res.ok && req !== given && (res.status === 400 || res.status === 403 || res.status === 404)) {
      quickModels.set(baseUrl, { model: null, at: Date.now() })
      log('info', 'llm:quick-model-failed', { provider: opts.id, model: used(req), status: res.status })
      return post(given, stream, signal)
    }
    if (!res.ok) throw await errorFromResponse(opts.id, res, used(req))
    try {
      checkIntercepted(res, `${baseUrl}/chat/completions`)
    } catch (err) {
      throw networkError(opts.id, baseUrl, err)
    }
    return { res, sent: used(req) }
  }

  function chatBody(req: LlmChatRequest, use: string, withUsage: boolean): string {
    const tools = req.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.inputSchema }
    }))
    return JSON.stringify({
      model: use,
      messages: [{ role: 'system', content: req.system }, ...toOpenAiMessages(req.messages)],
      stream: true,
      ...(withUsage ? { stream_options: { include_usage: true } } : {}),
      ...(tools.length > 0 ? { tools, tool_choice: 'auto' } : {}),
      ...effortField(baseUrl, PURPOSE_EFFORT.chat),
      [tokenField(baseUrl)]: req.maxTokens
    })
  }

  async function* chat(req: LlmChatRequest, signal: AbortSignal, onActivity?: () => void): AsyncIterable<LlmChatEvent> {
    checkImages(req)
    const use = req.model?.trim() || model
    if (!baseUrl) throw enhanceError('no-model', 'No base URL is set for this provider.')
    if (!use) throw enhanceError('no-model', 'No model is selected for this provider.')
    const withTools = req.tools.length > 0
    const withUsage = !streamOptionsRejected.has(baseUrl)
    let res: Response
    try {
      res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: await headers(),
        body: chatBody(req, use, withUsage),
        signal: AbortSignal.any([signal, AbortSignal.timeout(CONNECT_TIMEOUT_MS)])
      })
    } catch (err) {
      throw networkError(opts.id, baseUrl, err)
    }
    if (!res.ok && res.status === 400 && withUsage) {
      const text = await res.text().catch(() => '')
      if (STREAM_OPTIONS_HINT.test(text)) {
        rejectStreamOptions()
        yield* chat(req, signal, onActivity)
        return
      }
      res = new Response(text, { status: res.status })
    }
    if (!res.ok) {
      if (withTools && (res.status === 400 || res.status === 422)) {
        const text = await res.text().catch(() => '')
        if (TOOL_ERROR_HINT.test(text)) throw new LlmToolsUnsupportedError(opts.id, use)
        throw await errorFromResponse(opts.id, new Response(text, { status: res.status }), use)
      }
      throw await errorFromResponse(opts.id, res, use)
    }
    try {
      checkIntercepted(res, `${baseUrl}/chat/completions`)
    } catch (err) {
      throw networkError(opts.id, baseUrl, err)
    }
    if (!res.body) throw enhanceError('provider-error', `${label(opts.id)} sent an empty response.`)

    const think = new ThinkFilter()
    // index → the call being streamed; arguments accumulate as raw text.
    const calls = new Map<number, { id: string; name: string; args: string; started: boolean }>()
    let finish: string | null | undefined
    let answeredBy = use
    let usage: unknown
    let text = ''
    // With tools offered, text that opens like a tool call is held back until the end:
    // a server that ignored `tools` may be writing the call out.
    let held: string | null = null
    try {
      for await (const data of sseData(res.body)) {
        if (data === '[DONE]') break
        let chunk: { model?: string; choices?: ChatChoice[]; usage?: unknown; error?: { message?: string } }
        try {
          chunk = JSON.parse(data) as typeof chunk
        } catch {
          continue
        }
        if (chunk.error) {
          throw enhanceError('provider-error', (chunk.error.message ?? 'The stream reported an error.').slice(0, MAX_ERROR_CHARS))
        }
        if (typeof chunk.model === 'string' && chunk.model) answeredBy = chunk.model
        // The usage chunk comes last, with an empty `choices` list.
        if (chunk.usage) usage = chunk.usage
        const choice = chunk.choices?.[0]
        if (!choice) {
          onActivity?.()
          continue
        }
        if (choice.finish_reason) finish = choice.finish_reason
        let active = false
        for (const d of choice.delta?.tool_calls ?? []) {
          active = true
          const index = typeof d.index === 'number' ? d.index : calls.size
          let call = calls.get(index)
          if (!call) {
            call = { id: d.id || `call_${index}_${Date.now().toString(36)}`, name: '', args: '', started: false }
            calls.set(index, call)
          }
          if (d.id && !call.started) call.id = d.id
          if (d.function?.name) call.name += call.started ? '' : d.function.name
          if (!call.started && call.name) {
            call.started = true
            yield { type: 'tool_call_start', id: call.id, name: call.name }
          }
          const chunkArgs = d.function?.arguments
          if (chunkArgs) {
            call.args += chunkArgs
            if (call.started) yield { type: 'tool_args_chunk', id: call.id, argsDelta: chunkArgs }
          }
        }
        const content = choice.delta?.content
        const delta = content ? think.push(content) : ''
        if (delta) {
          if (held !== null) {
            held += delta
          } else if (withTools && text.trim() === '' && calls.size === 0 && TOOL_TEXT_LEAD.test((text + delta).trimStart())) {
            held = delta
          } else {
            text += delta
            yield { type: 'text', delta }
          }
        } else if (!active) {
          onActivity?.()
        }
      }
    } catch (err) {
      if (err instanceof LlmToolsUnsupportedError) throw err
      throw networkError(opts.id, baseUrl, err)
    }
    const rest = think.end()
    if (rest) {
      if (held !== null) held += rest
      else {
        text += rest
        yield { type: 'text', delta: rest }
      }
    }
    if (held !== null) {
      if (calls.size === 0 && looksLikeToolCall(held, req.tools.map((t) => t.name))) {
        throw new LlmToolsUnsupportedError(opts.id, use)
      }
      text += held
      yield { type: 'text', delta: held }
    }
    const replay: OpenAiReplay = { content: text, toolCalls: [] }
    for (const call of calls.values()) {
      if (!call.started) {
        // A call whose name never arrived cannot be run or replayed.
        continue
      }
      replay.toolCalls.push({ id: call.id, name: call.name, arguments: call.args })
      yield { type: 'tool_call_end', id: call.id, args: parseArgs(call.args) }
    }
    const reason: 'end' | 'max_tokens' | 'refusal' | 'tool_use' =
      finish === 'length'
        ? 'max_tokens'
        : finish === 'content_filter'
          ? 'refusal'
          : replay.toolCalls.length > 0
            ? 'tool_use'
            : 'end'
    log('info', 'llm:usage', { purpose: req.purpose, provider: opts.id, model: use, ...openAiUsage(usage) })
    yield { type: 'stop', reason, replay, model: answeredBy }
  }

  async function* stream(req: LlmRequest, signal: AbortSignal, onActivity?: () => void): AsyncIterable<LlmStreamEvent> {
    checkImages(req)
    const { res, sent } = await post(req, true, signal)
    if (!res.body) throw enhanceError('provider-error', `${label(opts.id)} sent an empty response.`)
    const think = new ThinkFilter()
    let finish: string | null | undefined
    let usage: unknown
    try {
      for await (const data of sseData(res.body)) {
        if (data === '[DONE]') break
        let chunk: { choices?: ChatChoice[]; usage?: unknown; error?: { message?: string } }
        try {
          chunk = JSON.parse(data) as typeof chunk
        } catch {
          continue
        }
        if (chunk.error) {
          throw enhanceError('provider-error', (chunk.error.message ?? 'The stream reported an error.').slice(0, MAX_ERROR_CHARS))
        }
        // The usage chunk comes last, with an empty `choices` list.
        if (chunk.usage) usage = chunk.usage
        const choice = chunk.choices?.[0]
        if (!choice) {
          onActivity?.()
          continue
        }
        if (choice.finish_reason) finish = choice.finish_reason
        const content = choice.delta?.content
        const text = content ? think.push(content) : ''
        if (text) yield { type: 'text', delta: text }
        else onActivity?.()
      }
    } catch (err) {
      throw networkError(opts.id, baseUrl, err)
    }
    const rest = think.end()
    if (rest) yield { type: 'text', delta: rest }
    log('info', 'llm:usage', { purpose: req.purpose, provider: opts.id, model: sent, ...openAiUsage(usage) })
    yield { type: 'stop', reason: stopReason(finish) }
  }

  async function complete(req: LlmRequest, signal: AbortSignal): Promise<string> {
    checkImages(req)
    const { res, sent } = await post(req, false, signal)
    let json: { choices?: ChatChoice[]; usage?: unknown }
    try {
      json = (await res.json()) as typeof json
    } catch (err) {
      throw networkError(opts.id, baseUrl, err)
    }
    log('info', 'llm:usage', { purpose: req.purpose, provider: opts.id, model: sent, ...openAiUsage(json.usage) })
    const choice = json.choices?.[0]
    if (choice?.finish_reason === 'content_filter' || choice?.message?.refusal) {
      throw enhanceError('refusal', 'The model declined this request.')
    }
    const think = new ThinkFilter()
    return think.push(choice?.message?.content ?? '') + think.end()
  }

  async function listModels(signal: AbortSignal): Promise<string[]> {
    if (!baseUrl) throw enhanceError('no-model', 'No base URL is set for this provider.')
    let res: Response
    try {
      const h = await headers()
      delete h['Content-Type']
      res = await fetch(`${baseUrl}/models`, {
        headers: h,
        signal: AbortSignal.any([signal, AbortSignal.timeout(SHORT_TIMEOUT_MS)])
      })
    } catch (err) {
      throw networkError(opts.id, baseUrl, err)
    }
    if (!res.ok) throw await errorFromResponse(opts.id, res, null)
    try {
      checkIntercepted(res, `${baseUrl}/models`)
    } catch (err) {
      throw networkError(opts.id, baseUrl, err)
    }
    const json = (await res.json().catch(() => ({}))) as { data?: { id?: unknown }[] }
    const ids = (json.data ?? [])
      .map((m) => m.id)
      .filter((m): m is string => typeof m === 'string' && m.length > 0)
      // Gemini lists `models/<id>`; requests take the bare id.
      .map((m) => m.replace(/^models\//, ''))
    return [...new Set(ids)].sort((a, b) => a.localeCompare(b))
  }

  return {
    id: opts.id,
    model,
    available: async (): Promise<LlmAvailability> => {
      if (!baseUrl || !model) return { ok: false, reason: 'no-model' }
      if (opts.getKey && !(await opts.getKey())) return { ok: false, reason: 'no-key' }
      return { ok: true }
    },
    stream,
    complete,
    listModels,
    test: async (signal) => {
      const models = await listModels(signal)
      if (!model) throw enhanceError('no-model', 'Choose a model first.')
      // Some compatible servers list nothing; only a non-empty list can disprove the model.
      if (models.length > 0 && !models.includes(model)) {
        throw enhanceError('no-model', `${label(opts.id)} does not list the model "${model}".`)
      }
      // A listed model can still be closed to this key, so a cloud test also sends one
      // 1-token request. A local server skips it: loading a model on its first call can
      // outlast the test.
      if (opts.id === 'local') return
      try {
        await complete({ purpose: 'title', system: 'Reply with OK.', user: 'OK', maxTokens: 1 }, signal)
      } catch (err) {
        // A complaint about the 1-token budget, or a refusal, still means the model answered.
        if (err instanceof EnhanceError && (err.code === 'refusal' || (err.code === 'provider-error' && TOKEN_LIMIT_HINT.test(err.message)))) {
          return
        }
        throw err
      }
    },
    chat,
    // OpenAI-compatible servers do not report a window: the `chat.contextTokens.*` setting applies.
    contextWindow: async () => null,
    acceptsImages: async () => opts.acceptsImages
  }
}

// ---------- chat helpers ----------

/** The user text, then each image as a data-URL part. */
function userContent(text: string, images: LlmImage[] | undefined): string | Record<string, unknown>[] {
  if (!images?.length) return text
  return [
    { type: 'text', text },
    ...images.map((img) => ({ type: 'image_url', image_url: { url: `data:${img.mimeType};base64,${img.data.toString('base64')}` } }))
  ]
}

/** Strict: the arguments must be one JSON object; '' (no arguments) is `{}`. */
function parseArgs(json: string): Record<string, unknown> | null {
  if (json.trim() === '') return {}
  try {
    const v: unknown = JSON.parse(json)
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** A whole reply that is only a call to one of the offered tools, written as text. */
function looksLikeToolCall(text: string, names: string[]): boolean {
  let t = text.trim()
  t = t.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '')
  t = t.replace(/^<tool_call>\s*/, '').replace(/\s*<\/tool_call>$/, '')
  t = t.replace(/^\[TOOL_CALLS\]\s*/, '')
  let v: unknown
  try {
    v = JSON.parse(t)
  } catch {
    return false
  }
  const first = Array.isArray(v) ? v[0] : v
  if (!first || typeof first !== 'object') return false
  const o = first as Record<string, unknown>
  const fn = (o['function'] as Record<string, unknown> | undefined) ?? o
  const name = fn['name']
  return typeof name === 'string' && names.includes(name) && ('arguments' in fn || 'parameters' in fn || 'args' in fn)
}

/** The chat transcript as chat-completions messages (after the system message). */
function toOpenAiMessages(messages: LlmChatMessage[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  for (const m of messages) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: userContent(m.content, m.images) })
    } else if (m.role === 'tool') {
      out.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.isError ? `Error: ${m.content}` : m.content })
    } else {
      const replay = isReplay(m.replay) ? m.replay : null
      const calls = replay
        ? replay.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } }))
        : m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } }))
      const content = replay ? replay.content : m.content
      out.push({ role: 'assistant', content: content || (calls.length > 0 ? null : ''), ...(calls.length > 0 ? { tool_calls: calls } : {}) })
    }
  }
  return out
}

function isReplay(v: unknown): v is OpenAiReplay {
  const r = v as Partial<OpenAiReplay> | null
  return !!r && typeof r === 'object' && typeof r.content === 'string' && Array.isArray(r.toolCalls)
}
