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

import type { LlmProviderId } from '@shared/types/enhance'
import { enhanceError, EnhanceError } from '../enhance/errors'
import { checkIntercepted, LlmInterceptedError } from './intercept'
import {
  LlmImagesUnsupportedError,
  LlmToolsUnsupportedError,
  type LlmAvailability,
  type LlmChatEvent,
  type LlmChatMessage,
  type LlmChatRequest,
  type LlmImage,
  type LlmProvider,
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

async function errorFromResponse(id: Options['id'], res: Response): Promise<EnhanceError> {
  let detail = ''
  try {
    const body = (await res.json()) as { error?: { message?: unknown } | string; message?: unknown }
    const msg = typeof body.error === 'string' ? body.error : (body.error?.message ?? body.message)
    if (typeof msg === 'string') detail = msg.slice(0, MAX_ERROR_CHARS)
  } catch {
    // Not JSON: the status says enough.
  }
  if (res.status === 401 || res.status === 403) {
    return enhanceError('missing-key', `${label(id)} rejected the API key.`)
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

  function body(req: LlmRequest, stream: boolean): string {
    return JSON.stringify({
      model: req.model?.trim() || model,
      messages: [
        { role: 'system', content: req.system },
        { role: 'user', content: userContent(req.user, req.images) }
      ],
      stream,
      ...(typeof req.temperature === 'number' ? { temperature: req.temperature } : {}),
      [tokenField(baseUrl)]: req.maxTokens
    })
  }

  async function post(req: LlmRequest, stream: boolean, signal: AbortSignal): Promise<Response> {
    if (!baseUrl) throw enhanceError('no-model', 'No base URL is set for this provider.')
    if (!model && !req.model?.trim()) throw enhanceError('no-model', 'No model is selected for this provider.')
    let res: Response
    try {
      res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: await headers(),
        body: body(req, stream),
        signal: AbortSignal.any([signal, AbortSignal.timeout(CONNECT_TIMEOUT_MS)])
      })
    } catch (err) {
      throw networkError(opts.id, baseUrl, err)
    }
    if (!res.ok) throw await errorFromResponse(opts.id, res)
    try {
      checkIntercepted(res, `${baseUrl}/chat/completions`)
    } catch (err) {
      throw networkError(opts.id, baseUrl, err)
    }
    return res
  }

  function chatBody(req: LlmChatRequest, use: string): string {
    const tools = req.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.inputSchema }
    }))
    return JSON.stringify({
      model: use,
      messages: [{ role: 'system', content: req.system }, ...toOpenAiMessages(req.messages)],
      stream: true,
      ...(tools.length > 0 ? { tools, tool_choice: 'auto' } : {}),
      [tokenField(baseUrl)]: req.maxTokens
    })
  }

  async function* chat(req: LlmChatRequest, signal: AbortSignal, onActivity?: () => void): AsyncIterable<LlmChatEvent> {
    checkImages(req)
    const use = req.model?.trim() || model
    if (!baseUrl) throw enhanceError('no-model', 'No base URL is set for this provider.')
    if (!use) throw enhanceError('no-model', 'No model is selected for this provider.')
    const withTools = req.tools.length > 0
    let res: Response
    try {
      res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: await headers(),
        body: chatBody(req, use),
        signal: AbortSignal.any([signal, AbortSignal.timeout(CONNECT_TIMEOUT_MS)])
      })
    } catch (err) {
      throw networkError(opts.id, baseUrl, err)
    }
    if (!res.ok) {
      if (withTools && (res.status === 400 || res.status === 422)) {
        const text = await res.text().catch(() => '')
        if (TOOL_ERROR_HINT.test(text)) throw new LlmToolsUnsupportedError(opts.id, use)
        throw await errorFromResponse(opts.id, new Response(text, { status: res.status }))
      }
      throw await errorFromResponse(opts.id, res)
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
    let text = ''
    // With tools offered, text that opens like a tool call is held back until the end:
    // a server that ignored `tools` may be writing the call out.
    let held: string | null = null
    try {
      for await (const data of sseData(res.body)) {
        if (data === '[DONE]') break
        let chunk: { model?: string; choices?: ChatChoice[]; error?: { message?: string } }
        try {
          chunk = JSON.parse(data) as typeof chunk
        } catch {
          continue
        }
        if (chunk.error) {
          throw enhanceError('provider-error', (chunk.error.message ?? 'The stream reported an error.').slice(0, MAX_ERROR_CHARS))
        }
        if (typeof chunk.model === 'string' && chunk.model) answeredBy = chunk.model
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
    yield { type: 'stop', reason, replay, model: answeredBy }
  }

  async function* stream(req: LlmRequest, signal: AbortSignal, onActivity?: () => void): AsyncIterable<LlmStreamEvent> {
    checkImages(req)
    const res = await post(req, true, signal)
    if (!res.body) throw enhanceError('provider-error', `${label(opts.id)} sent an empty response.`)
    const think = new ThinkFilter()
    let finish: string | null | undefined
    try {
      for await (const data of sseData(res.body)) {
        if (data === '[DONE]') break
        let chunk: { choices?: ChatChoice[]; error?: { message?: string } }
        try {
          chunk = JSON.parse(data) as typeof chunk
        } catch {
          continue
        }
        if (chunk.error) {
          throw enhanceError('provider-error', (chunk.error.message ?? 'The stream reported an error.').slice(0, MAX_ERROR_CHARS))
        }
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
    yield { type: 'stop', reason: stopReason(finish) }
  }

  async function complete(req: LlmRequest, signal: AbortSignal): Promise<string> {
    checkImages(req)
    const res = await post(req, false, signal)
    let json: { choices?: ChatChoice[] }
    try {
      json = (await res.json()) as typeof json
    } catch (err) {
      throw networkError(opts.id, baseUrl, err)
    }
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
    if (!res.ok) throw await errorFromResponse(opts.id, res)
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
