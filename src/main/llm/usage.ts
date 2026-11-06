// SPDX-License-Identifier: Apache-2.0
// Token counts from a provider's `usage` object, for the `llm:usage` log line. Pure: the
// adapters call these, then log. A count the provider didn't report is null.

export interface TokenUsage {
  in: number | null
  out: number | null
  reasoning: number | null
  cached: number | null
}

function count(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : null
}

function field(o: unknown, key: string): unknown {
  return o !== null && typeof o === 'object' ? (o as Record<string, unknown>)[key] : undefined
}

/** OpenAI-compatible chat completions: `usage` of the JSON reply or of the stream's last chunk. */
export function openAiUsage(usage: unknown): TokenUsage {
  return {
    in: count(field(usage, 'prompt_tokens')),
    out: count(field(usage, 'completion_tokens')),
    reasoning: count(field(field(usage, 'completion_tokens_details'), 'reasoning_tokens')),
    cached: count(field(field(usage, 'prompt_tokens_details'), 'cached_tokens'))
  }
}

/** Anthropic messages: thinking is counted inside the output, not apart from it. */
export function anthropicUsage(usage: unknown): TokenUsage {
  return {
    in: count(field(usage, 'input_tokens')),
    out: count(field(usage, 'output_tokens')),
    reasoning: null,
    cached: count(field(usage, 'cache_read_input_tokens'))
  }
}
