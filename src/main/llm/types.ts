// SPDX-License-Identifier: Apache-2.0
// The LLM provider interface. Main-only: keys never leave main, and
// the renderer sees generation only as `enhance:event` and `chat:event` pushes.
//
// Ten purposes, each with an effort and an output budget of at
// least 2,000 tokens (Opus 5.5 always thinks), and image input
// (`acceptsImages`). The adapters implement both.

import type { LlmProviderId } from '@shared/types/enhance'

/** `folder-suggest`: non-streaming (`complete`); Anthropic effort `low`. */
export type LlmPurpose =
  | 'summary'
  | 'title'
  | 'meeting-end'
  | 'rewrite'
  | 'chat'
  | 'folder-suggest'
  | 'speaker-names'
  | 'action-items'
  | 'meeting-classify'
  | 'attachment-digest'
  | 'email-draft'
  | 'follow-up-rewrite'
  | 'prep-brief'
  | 'screen-snapshot'
  | 'slack-summary'
  | 'dictation-format'
  | 'recurring-recap'
  | 'live-context'
  | 'live-context-answer'
  | 'reminder-draft'
  | 'template-feedback'
  | 'user-context'
  | 'dispatch-classify'
  | 'dispatch-select'

/** An image for a model that accepts images (base64 content blocks in the adapters). */
export interface LlmImage {
  mimeType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'
  data: Buffer
}

export interface LlmRequest {
  purpose: LlmPurpose
  system: string
  user: string
  maxTokens: number
  /** Overrides the settings model for this call (the chat title uses the chat's resolved model). */
  model?: string
  /** Images after the user text. A provider that does not accept them throws LlmImagesUnsupportedError. */
  images?: LlmImage[]
  /** OpenAI-compatible only; the Anthropic adapter ignores it. */
  temperature?: number
}

export type LlmStopReason = 'end' | 'max_tokens' | 'refusal'

export type LlmStreamEvent = { type: 'text'; delta: string } | { type: 'stop'; reason: LlmStopReason }

export type LlmUnavailableReason = 'no-key' | 'no-model' | 'unreachable'

export type LlmAvailability = { ok: true } | { ok: false; reason: LlmUnavailableReason }

// ---------- chat ----------

/** A client tool. `inputSchema` is the JSON Schema of its arguments. */
export interface LlmToolDef {
  name: string
  description: string
  inputSchema: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
    additionalProperties?: false
  }
}

export interface LlmToolCall {
  id: string
  name: string
  args: Record<string, unknown>
}

/**
 * One turn of a chat transcript. Inside one answer the transcript is append-only:
 * an assistant turn carries the provider's `replay` (Anthropic: the final message
 * content, thinking blocks included) and is followed by every tool result of that
 * round. Earlier answers are rebuilt as plain text.
 */
export type LlmChatMessage =
  /** `images` on user turns (chat files). */
  | { role: 'user'; content: string; images?: LlmImage[] }
  | { role: 'assistant'; content: string; toolCalls: LlmToolCall[]; replay?: unknown }
  | { role: 'tool'; toolCallId: string; name: string; content: string; isError?: boolean }

export interface LlmChatRequest {
  purpose: 'chat'
  /** Byte-identical for every round of one answer. */
  system: string
  messages: LlmChatMessage[]
  /** Byte-identical for every round of one answer; `[]` for the no-tools retry. */
  tools: LlmToolDef[]
  maxTokens: number
  model?: string
}

export type LlmChatEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_call_start'; id: string; name: string }
  | { type: 'tool_args_chunk'; id: string; argsDelta: string }
  /** `args` null = unparsable or truncated arguments; the call is never run. */
  | { type: 'tool_call_end'; id: string; args: Record<string, unknown> | null }
  | {
      type: 'stop'
      reason: 'end' | 'max_tokens' | 'refusal' | 'tool_use'
      /** What the next round replays as this assistant turn. */
      replay?: unknown
      /** The model that answered (after any server-side fallback). */
      model: string
    }

/**
 * Thrown by `chat` when the provider or model rejects tool calling (an HTTP 400/422
 * about tools or functions, or tool-call-shaped text from a server that ignored
 * `tools`). The chat engine retries once without tools and records the pair in the
 * main-only setting `chat.noTools`.
 */
export class LlmToolsUnsupportedError extends Error {
  constructor(
    readonly provider: LlmProviderId,
    readonly model: string,
    message = 'This model does not support tool calling.'
  ) {
    super(message)
    this.name = 'LlmToolsUnsupportedError'
  }
}

/**
 * Thrown before any network call when a request carries images and the provider or
 * model does not accept them.
 */
export class LlmImagesUnsupportedError extends Error {
  constructor(
    readonly provider: LlmProviderId,
    readonly model: string,
    message = 'This model does not accept images.'
  ) {
    super(message)
    this.name = 'LlmImagesUnsupportedError'
  }
}

export interface LlmProvider {
  readonly id: LlmProviderId
  /** The configured model id, '' when none is set. */
  readonly model: string
  available(): Promise<LlmAvailability>
  /**
   * Text deltas, then exactly one `stop`. Any non-text activity from the provider
   * (thinking, keep-alive frames carrying content) calls `onActivity`, so the
   * caller's idle timeout measures a stalled provider, not a thinking one.
   */
  stream(req: LlmRequest, signal: AbortSignal, onActivity?: () => void): AsyncIterable<LlmStreamEvent>
  /** Non-streaming in effect: the whole reply text. A refusal rejects with code `refusal`. */
  complete(req: LlmRequest, signal: AbortSignal): Promise<string>
  /** Model ids this provider offers (`llm:list-models`). */
  listModels(signal: AbortSignal): Promise<string[]>
  /** A cheap round trip that proves the key, the endpoint and the model (`llm:test`). */
  test(signal: AbortSignal): Promise<void>
  /**
   * Chat with provider-native tool calling and streamed tool calls. Exactly one
   * `stop`, last. A provider that rejects tools throws `LlmToolsUnsupportedError`,
   * and nothing else.
   */
  chat(req: LlmChatRequest, signal: AbortSignal, onActivity?: () => void): AsyncIterable<LlmChatEvent>
  /**
   * The model's input context window in tokens. Anthropic: the Models API's
   * `max_input_tokens`, cached per model id. OpenAI-compatible: null (the
   * `chat.contextTokens.*` setting applies).
   */
  contextWindow(): Promise<number | null>
  /**
   * Anthropic `true` for every `claude-*` model; OpenAI-compatible follows
   * `llm.openai.acceptsImages` / `llm.local.acceptsImages`.
   */
  acceptsImages(): Promise<boolean>
}

/** Output budgets: headroom for adaptive thinking on the long tasks. Never below 2,000. */
export const MAX_TOKENS: Record<LlmPurpose, number> = {
  summary: 16_000,
  rewrite: 16_000,
  title: 2_000,
  'meeting-end': 2_000,
  chat: 16_000,
  'folder-suggest': 2_000,
  'speaker-names': 2_000,
  'action-items': 2_000,
  'meeting-classify': 2_000,
  'attachment-digest': 2_000,
  'email-draft': 2_000,
  'follow-up-rewrite': 2_000,
  'prep-brief': 2_000,
  'screen-snapshot': 2_000,
  'slack-summary': 2_000,
  'dictation-format': 8_192,
  'recurring-recap': 2_000,
  'live-context': 2_000,
  'live-context-answer': 2_000,
  'reminder-draft': 2_000,
  'template-feedback': 2_000,
  'user-context': 12_000,
  'dispatch-classify': 2_000,
  'dispatch-select': 4_000
}

/** The Anthropic adapter's `output_config.effort` per purpose. */
export const PURPOSE_EFFORT: Record<LlmPurpose, 'low' | 'medium' | 'high'> = {
  summary: 'medium',
  rewrite: 'medium',
  chat: 'medium',
  title: 'low',
  'meeting-end': 'low',
  'folder-suggest': 'low',
  'speaker-names': 'low',
  'action-items': 'low',
  'meeting-classify': 'low',
  'attachment-digest': 'low',
  'email-draft': 'medium',
  'follow-up-rewrite': 'low',
  'prep-brief': 'low',
  'screen-snapshot': 'low',
  'slack-summary': 'low',
  'dictation-format': 'low',
  'recurring-recap': 'low',
  'live-context': 'low',
  'live-context-answer': 'low',
  'reminder-draft': 'low',
  'template-feedback': 'medium',
  'user-context': 'medium',
  'dispatch-classify': 'low',
  'dispatch-select': 'medium'
}
