// SPDX-License-Identifier: Apache-2.0
// The Anthropic BYOK provider, through the official SDK.
//
// Adapter rules, checked against @anthropic-ai/sdk 0.131.0:
// - Streaming via `beta.messages.stream`, then `finalMessage()` for the stop reason.
//   The beta namespace is required: `fallbacks` only exists on the beta params.
// - No `thinking` parameter. Opus 5.5 always thinks (disabling it is a 400); depth is
//   set with `output_config.effort` instead, explicitly, because its default is medium.
// - Server-side fallbacks (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`)
//   only for the models that accept them. A mid-stream fallback continues from the
//   partial text, so the deltas concatenate into one answer.
// - `stop_reason === 'refusal'` (the whole fallback chain declined) is checked before
//   any content is used, and becomes error code `refusal`.
//
// Chat:
// - `tool_choice` is always `auto` (`any` / `tool` are a 400 on Opus 5.5). Every tool
//   carries `eager_input_streaming: true`, so its input streams as it is written; the
//   adapter keeps the raw `input_json_delta` text per block and parses it strictly at
//   `content_block_stop`. Anything that is not one JSON object becomes `args: null`.
// - Inside one answer the transcript is append-only: an assistant turn replays
//   `finalMessage().content` verbatim (thinking blocks included), and each round's
//   tool results travel together in one user message. If the API still answers 400 on
//   a replayed prefix, the thinking blocks are stripped and the request is sent once more.
// - `contextWindow()` is the Models API's `max_input_tokens`, cached per model id.
//
// The effort comes from `PURPOSE_EFFORT`; images travel as
// base64 `image` blocks after the user text (every `claude-*` model accepts them); a 2xx
// `text/html` answer is an intercepting network, never the API (intercept.ts).

import Anthropic from '@anthropic-ai/sdk'
import type {
  BetaContentBlockParam,
  BetaMessageParam,
  BetaMessageStreamParams,
  BetaTool,
  BetaToolResultBlockParam
} from '@anthropic-ai/sdk/resources/beta/messages/messages'
import { app } from 'electron'
import { enhanceError, EnhanceError } from '../enhance/errors'
import { log } from '../log'
import { interceptingFetch, LlmInterceptedError } from './intercept'
import {
  LlmImagesUnsupportedError,
  PURPOSE_EFFORT,
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

const FALLBACK_BETA = 'server-side-fallback-2026-07-01'
/** Pinned, so ANTHROPIC_BASE_URL in the environment can never redirect the user's key. */
const API_BASE_URL = 'https://api.anthropic.com'
/** The SDK's own timeout covers the request until the response starts streaming. */
const REQUEST_TIMEOUT_MS = 185_000
const TEST_TIMEOUT_MS = 20_000
/** How long a context-window lookup may take before the settings value applies. */
const MODELS_TIMEOUT_MS = 10_000
/** The SDK's message when a streamed tool input is not valid JSON. */
const TOOL_JSON_ERROR = /^Unable to parse tool parameter JSON/

/** `llm:list-models` for Anthropic is a static list. */
export const ANTHROPIC_MODELS = [
  'claude-opus-5-5',
  'claude-sonnet-5-5',
  'claude-haiku-5-5',
  'claude-fable-5-1',
  'claude-opus-5',
  'claude-sonnet-5',
  'claude-opus-4-8'
] as const

/** Models that accept the `"default"` fallbacks form on the Claude API. */
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1', 'claude-fable-5', 'claude-sonnet-5-5'])

/** `output_config.effort` is rejected by the 4.5-and-older Sonnet and Haiku models. */
function supportsEffort(model: string): boolean {
  return /^claude-(opus|sonnet|haiku|fable|mythos)-[5-9]/.test(model) || /^claude-(opus-4-[6-9]|sonnet-4-6)/.test(model)
}

/** Every Claude model reads images. */
function modelAcceptsImages(model: string): boolean {
  return model.startsWith('claude-')
}

/** The user text, then each image as a base64 block. */
function userContent(text: string, images: LlmImage[] | undefined): string | BetaContentBlockParam[] {
  if (!images?.length) return text
  return [
    { type: 'text', text: text || ' ' },
    ...images.map(
      (img): BetaContentBlockParam => ({ type: 'image', source: { type: 'base64', media_type: img.mimeType, data: img.data.toString('base64') } })
    )
  ]
}

/**
 * Dev builds only: `NOTULA_DEV_ANTHROPIC_BASE_URL` points the adapter at a local mock of
 * the Messages API for a smoke run. Packaged builds always use the pinned host.
 */
function apiBaseUrl(): string {
  if (app.isPackaged) return API_BASE_URL
  const dev = process.env['NOTULA_DEV_ANTHROPIC_BASE_URL']?.trim()
  return dev ? dev.replace(/\/+$/, '') : API_BASE_URL
}

/** `max_input_tokens` per model id, for the life of the process. */
const contextWindows = new Map<string, number>()

/** The API's own error message (never the key), cut short. */
function apiErrorDetail(err: InstanceType<typeof Anthropic.APIError>): string {
  const body = err.error as { error?: { message?: unknown } } | undefined
  const msg = body?.error?.message
  return typeof msg === 'string' ? msg.slice(0, 200) : ''
}

/** Maps SDK errors to the generation error codes; never includes the key. */
function mapError(err: unknown): Error {
  if (err instanceof EnhanceError) return err
  if (err instanceof Anthropic.APIUserAbortError) {
    const e = new Error('The request was cancelled.')
    e.name = 'AbortError'
    return e
  }
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return enhanceError('missing-key', 'Anthropic rejected the API key.')
  }
  if (err instanceof Anthropic.NotFoundError) {
    return enhanceError('no-model', 'Anthropic does not offer the selected model.')
  }
  if (err instanceof Anthropic.RateLimitError) {
    return enhanceError('provider-error', 'Anthropic is rate limiting this key. Try again in a moment.')
  }
  if (err instanceof LlmInterceptedError) return enhanceError('provider-error', err.message)
  if (err instanceof Anthropic.APIConnectionError && err.cause instanceof LlmInterceptedError) {
    return enhanceError('provider-error', err.cause.message)
  }
  if (err instanceof Anthropic.APIConnectionTimeoutError) {
    return enhanceError('timeout', 'Anthropic took too long. Try again.')
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return enhanceError('provider-error', 'Could not reach Anthropic. Check your connection.')
  }
  if (err instanceof Anthropic.BadRequestError) {
    const detail = apiErrorDetail(err)
    return enhanceError('provider-error', `Anthropic rejected the request${detail ? `: ${detail}` : '.'}`)
  }
  if (err instanceof Anthropic.APIError) {
    return enhanceError('provider-error', `Anthropic returned an error (${err.status ?? 'no status'}).`)
  }
  return err instanceof Error ? err : new Error(String(err))
}

function stopReason(reason: string | null): LlmStopReason {
  if (reason === 'refusal') return 'refusal'
  if (reason === 'max_tokens' || reason === 'model_context_window_exceeded') return 'max_tokens'
  return 'end'
}

export function createAnthropicProvider(opts: { model: string; getKey(): Promise<string | null> }): LlmProvider {
  const model = opts.model.trim()

  /** A request with images to a model that can't read them fails before any network call. */
  function checkImages(req: LlmRequest | LlmChatRequest): void {
    const images = 'messages' in req ? req.messages.some((m) => m.role === 'user' && (m.images?.length ?? 0) > 0) : (req.images?.length ?? 0) > 0
    const use = req.model?.trim() || model
    if (images && !modelAcceptsImages(use)) throw new LlmImagesUnsupportedError('anthropic', use)
  }

  async function client(timeout = REQUEST_TIMEOUT_MS): Promise<Anthropic> {
    const apiKey = await opts.getKey()
    if (!apiKey) throw enhanceError('missing-key', 'No Anthropic API key is set.')
    // logLevel 'off': ANTHROPIC_LOG must not make the SDK print requests from main.
    return new Anthropic({ apiKey, baseURL: apiBaseUrl(), timeout, maxRetries: 2, logLevel: 'off', fetch: interceptingFetch })
  }

  function params(req: LlmRequest): BetaMessageStreamParams {
    const use = req.model?.trim() || model
    const fallback = FALLBACK_MODELS.has(use)
    return {
      model: use,
      max_tokens: req.maxTokens,
      system: req.system,
      messages: [{ role: 'user', content: userContent(req.user, req.images) }],
      ...(supportsEffort(use) ? { output_config: { effort: PURPOSE_EFFORT[req.purpose] } } : {}),
      ...(fallback ? { betas: [FALLBACK_BETA], fallbacks: 'default' as const } : {})
    }
  }

  function chatParams(req: LlmChatRequest, stripThinking: boolean): BetaMessageStreamParams {
    const use = req.model?.trim() || model
    const fallback = FALLBACK_MODELS.has(use)
    const tools: BetaTool[] = req.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema,
      eager_input_streaming: true
    }))
    return {
      model: use,
      max_tokens: req.maxTokens,
      system: req.system,
      messages: toAnthropicMessages(req.messages, stripThinking),
      ...(tools.length > 0 ? { tools, tool_choice: { type: 'auto' as const } } : {}),
      ...(supportsEffort(use) ? { output_config: { effort: PURPOSE_EFFORT.chat } } : {}),
      ...(fallback ? { betas: [FALLBACK_BETA], fallbacks: 'default' as const } : {})
    }
  }

  async function* stream(req: LlmRequest, signal: AbortSignal, onActivity?: () => void): AsyncIterable<LlmStreamEvent> {
    checkImages(req)
    const c = await client()
    const s = c.beta.messages.stream(params(req), { signal })
    try {
      for await (const event of s) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          if (event.delta.text) yield { type: 'text', delta: event.delta.text }
        } else {
          onActivity?.()
        }
      }
      const message = await s.finalMessage()
      yield { type: 'stop', reason: stopReason(message.stop_reason) }
    } catch (err) {
      throw mapError(err)
    }
  }

  async function complete(req: LlmRequest, signal: AbortSignal): Promise<string> {
    checkImages(req)
    try {
      const c = await client()
      const message = await c.beta.messages.stream(params(req), { signal }).finalMessage()
      if (message.stop_reason === 'refusal') throw enhanceError('refusal', 'The model declined this request.')
      return message.content.map((b) => (b.type === 'text' ? b.text : '')).join('')
    } catch (err) {
      throw mapError(err)
    }
  }

  async function* chat(req: LlmChatRequest, signal: AbortSignal, onActivity?: () => void): AsyncIterable<LlmChatEvent> {
    checkImages(req)
    const c = await client()
    const hasReplayedThinking = req.messages.some((m) => m.role === 'assistant' && replayHasThinking(m.replay))
    let stripThinking = false
    for (;;) {
      let started = false
      // Content block index → the tool call it carries and its raw input so far.
      const tools = new Map<number, { id: string; json: string }>()
      try {
        const s = c.beta.messages.stream(chatParams(req, stripThinking), { signal })
        for await (const event of s) {
          started = true
          if (event.type === 'content_block_start') {
            if (event.content_block.type === 'tool_use') {
              tools.set(event.index, { id: event.content_block.id, json: '' })
              yield { type: 'tool_call_start', id: event.content_block.id, name: event.content_block.name }
            } else {
              onActivity?.()
            }
          } else if (event.type === 'content_block_delta') {
            if (event.delta.type === 'text_delta') {
              if (event.delta.text) yield { type: 'text', delta: event.delta.text }
            } else if (event.delta.type === 'input_json_delta') {
              const tool = tools.get(event.index)
              if (tool && event.delta.partial_json) {
                tool.json += event.delta.partial_json
                yield { type: 'tool_args_chunk', id: tool.id, argsDelta: event.delta.partial_json }
              } else {
                onActivity?.()
              }
            } else {
              onActivity?.()
            }
          } else if (event.type === 'content_block_stop') {
            const tool = tools.get(event.index)
            if (tool) yield { type: 'tool_call_end', id: tool.id, args: parseArgs(tool.json) }
            else onActivity?.()
          } else {
            onActivity?.()
          }
        }
        const message = await s.finalMessage()
        // The caller reads the stop reason before it trusts any tool call.
        if (message.stop_reason === 'refusal') {
          log('info', 'chat:anthropic-refusal', { model: message.model, category: message.stop_details?.category ?? null })
        }
        yield { type: 'stop', reason: chatStopReason(message.stop_reason), replay: message.content, model: message.model }
        return
      } catch (err) {
        if (!started && !stripThinking && hasReplayedThinking && err instanceof Anthropic.BadRequestError) {
          // A replayed prefix the API no longer accepts (preserved thinking): once more without it.
          log('warn', 'chat:anthropic-strip-thinking-retry', { status: err.status })
          stripThinking = true
          continue
        }
        if (err instanceof Anthropic.AnthropicError && !(err instanceof Anthropic.APIError) && TOOL_JSON_ERROR.test(err.message)) {
          // Logged without the input itself, which may quote the user's notes.
          log('warn', 'chat:anthropic-tool-json-invalid', {})
          throw enhanceError('provider-error', 'The model sent tool input that could not be read. Try again.')
        }
        throw mapError(err)
      }
    }
  }

  async function contextWindow(): Promise<number | null> {
    if (!model) return null
    const cached = contextWindows.get(model)
    if (cached) return cached
    try {
      const info = await (await client(MODELS_TIMEOUT_MS)).models.retrieve(model, undefined, {
        signal: AbortSignal.timeout(MODELS_TIMEOUT_MS)
      })
      const n = info.max_input_tokens
      if (typeof n === 'number' && Number.isFinite(n) && n > 0) {
        contextWindows.set(model, n)
        return n
      }
    } catch (err) {
      log('info', 'chat:anthropic-context-window-unavailable', { model, err: mapError(err).message })
    }
    return null
  }

  return {
    id: 'anthropic',
    model,
    available: async (): Promise<LlmAvailability> => {
      if (!model) return { ok: false, reason: 'no-model' }
      return (await opts.getKey()) ? { ok: true } : { ok: false, reason: 'no-key' }
    },
    stream,
    complete,
    listModels: async () => [...ANTHROPIC_MODELS],
    test: async (signal) => {
      if (!model) throw enhanceError('no-model', 'Choose an Anthropic model first.')
      try {
        // Proves the key and that the model exists, without spending tokens.
        await (await client(TEST_TIMEOUT_MS)).models.retrieve(model, undefined, { signal })
      } catch (err) {
        throw mapError(err)
      }
    },
    chat,
    contextWindow,
    // Every claude-* model accepts images.
    acceptsImages: async () => modelAcceptsImages(model)
  }
}

// ---------- chat helpers ----------

function chatStopReason(reason: string | null): 'end' | 'max_tokens' | 'refusal' | 'tool_use' {
  if (reason === 'tool_use') return 'tool_use'
  return stopReason(reason)
}

/** Strict: the whole streamed input must be one JSON object; '' (no input) is `{}`. */
function parseArgs(json: string): Record<string, unknown> | null {
  if (json.trim() === '') return {}
  try {
    const v: unknown = JSON.parse(json)
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function isThinkingBlock(b: unknown): boolean {
  const type = (b as { type?: unknown } | null)?.type
  return type === 'thinking' || type === 'redacted_thinking'
}

function replayHasThinking(replay: unknown): boolean {
  return Array.isArray(replay) && replay.some(isThinkingBlock)
}

/**
 * The chat transcript as Messages API turns. An assistant turn with `replay` is sent
 * back verbatim; consecutive tool results become one user message.
 */
function toAnthropicMessages(messages: LlmChatMessage[], stripThinking: boolean): BetaMessageParam[] {
  const out: BetaMessageParam[] = []
  let results: BetaToolResultBlockParam[] = []
  const flush = (): void => {
    if (results.length === 0) return
    out.push({ role: 'user', content: results })
    results = []
  }
  for (const m of messages) {
    if (m.role === 'tool') {
      results.push({ type: 'tool_result', tool_use_id: m.toolCallId, content: m.content, ...(m.isError ? { is_error: true } : {}) })
      continue
    }
    flush()
    if (m.role === 'user') {
      out.push({ role: 'user', content: userContent(m.content, m.images) })
    } else if (Array.isArray(m.replay)) {
      const blocks = (m.replay as BetaContentBlockParam[]).filter((b) => !stripThinking || !isThinkingBlock(b))
      out.push({ role: 'assistant', content: blocks.length > 0 ? blocks : [{ type: 'text', text: m.content || '…' }] })
    } else {
      const blocks: BetaContentBlockParam[] = []
      if (m.content) blocks.push({ type: 'text', text: m.content })
      for (const call of m.toolCalls) blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.args })
      out.push({ role: 'assistant', content: blocks.length > 0 ? blocks : [{ type: 'text', text: '…' }] })
    }
  }
  flush()
  return out
}
