// SPDX-License-Identifier: Apache-2.0
// The input window of models whose provider reports none, and the character budgets the
// post-summary features and the attachment digest derive from a window. Pure: no
// Electron, no logger. Only those two budgets use the lookup; chat keeps its own setting
// and `contextWindow()` keeps reporting what the provider reports.

/** Model families with a published input window, in tokens. A new family is one line. */
const KNOWN_WINDOWS: readonly { pattern: RegExp; tokens: number }[] = [
  // gemini-<major>[.<minor>]-(flash|flash-lite|pro) from 1.5 on, then -preview/-latest/-exp and a
  // date or build. 1.0 had a far smaller window, so it stays unknown.
  { pattern: /^gemini-(?:1\.5|(?:[2-9]|[1-9]\d+)(?:\.\d+)?)-(?:flash|flash-lite|pro)(?:-(?:preview|latest|exp))?(?:-[\d][\d-]*)?$/, tokens: 1_048_576 }
]

/** The known input window of `model` in tokens, or null. A `<vendor>/` or `models/` prefix is ignored. */
export function knownInputWindow(model: string): number | null {
  const id = model.trim().toLowerCase().replace(/^.*\//, '')
  for (const w of KNOWN_WINDOWS) if (w.pattern.test(id)) return w.tokens
  return null
}

/** Without a known window: a conservative 32k-token model. */
const DEFAULT_WINDOW_TOKENS = 32_000

/** The transcript gets at most half the window, at about 3.5 characters per token. */
const TRANSCRIPT_SHARE = 0.5
const CHARS_PER_TOKEN = 3.5
const MIN_TRANSCRIPT_CHARS = 4_000
const MAX_TRANSCRIPT_CHARS = 600_000

export function transcriptBudgetChars(windowTokens: number | null): number {
  const window = windowTokens ?? DEFAULT_WINDOW_TOKENS
  return Math.min(MAX_TRANSCRIPT_CHARS, Math.max(MIN_TRANSCRIPT_CHARS, Math.floor(window * TRANSCRIPT_SHARE * CHARS_PER_TOKEN)))
}

/** About 4 characters per token; three per token keeps room for the answer. */
const DIGEST_CHARS_PER_TOKEN = 3
const MIN_DIGEST_CHARS = 8_000
const MAX_DIGEST_CHARS = 400_000

export function digestBudgetChars(windowTokens: number | null): number {
  const window = windowTokens ?? DEFAULT_WINDOW_TOKENS
  return Math.min(MAX_DIGEST_CHARS, Math.max(MIN_DIGEST_CHARS, window * DIGEST_CHARS_PER_TOKEN))
}
