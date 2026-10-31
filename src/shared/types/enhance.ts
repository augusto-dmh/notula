// SPDX-License-Identifier: Apache-2.0
// AI-enhanced notes, titles and LLM providers (F-enhance-*).

import type { IsoTime } from './common'
import type { GeneratedLine } from './panels'

export type LlmProviderId = 'anthropic' | 'openai' | 'local'
export type CloudLlmProviderId = 'anthropic' | 'openai'

/**
 * The "Google Gemini" preset of the OpenAI-compatible provider (its key is the
 * `llm.openai` key). Recommended and preselected in onboarding. `model` is only the
 * fallback: saving a key picks the newest Flash the key can use (`newestFlashModel`),
 * since Google retires Flash versions for new keys while older ones still run.
 */
export const GEMINI_PRESET = {
  baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
  model: 'gemini-3.8-flash',
  host: 'generativelanguage.googleapis.com'
} as const

/**
 * The newest generally available Gemini Flash in a model list, or null. Only
 * `gemini-<version>-flash` and its pinned `-NNN` builds count: any other suffix
 * (preview, exp, lite, image, tts, live and the like) is a pre-release or a
 * special-purpose model. Versions compare numerically (3.10 is newer than 3.9), and
 * at one version the bare id, which tracks the stable build, wins over a pinned one.
 */
export function newestFlashModel(ids: readonly string[]): string | null {
  let best: { id: string; version: number[]; pin: number } | null = null
  for (const raw of ids) {
    const id = raw.replace(/^models\//, '')
    const m = /^gemini-(\d+(?:\.\d+)*)-flash(?:-(\d+))?$/.exec(id)
    if (!m) continue
    const version = (m[1] ?? '').split('.').map(Number)
    // No pin sorts above every pinned build.
    const pin = m[2] === undefined ? Number.POSITIVE_INFINITY : Number(m[2])
    if (!best || compareVersions(version, best.version) > 0 || (compareVersions(version, best.version) === 0 && pin > best.pin)) {
      best = { id, version, pin }
    }
  }
  return best?.id ?? null
}

function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/** A provider's answer that the model it was asked for is no longer available. */
export interface RetiredModel {
  /** The model the failing call asked for. */
  model: string
  /** The provider's own message. */
  reason: string
  /** The model the provider named instead, or null when it named none. */
  replacement: string | null
}

const RETIRED_HINT =
  /\b(?:no longer (?:available|supported|offered)|(?:has been|was|is) (?:retired|deprecated|discontinued|shut down|decommissioned))\b/i
// The named id must hold a digit or a hyphen, so "use another model" names nothing.
const REPLACEMENT_HINT =
  /\b(?:use|switch to|migrate to|upgrade to)\s+(?:the\s+)?(?:model\s+)?[`'"“]?(?:models\/)?([a-z0-9](?=[\w.:-]*[\d-])[\w.:-]*[a-z0-9])/i

/**
 * Reads a provider error for "this model is retired": null when the message doesn't say
 * so, else the replacement it names (null when none, or when it names the same model).
 */
export function parseRetiredModel(message: string, model: string): Omit<RetiredModel, 'model' | 'reason'> | null {
  if (!RETIRED_HINT.test(message)) return null
  const named = REPLACEMENT_HINT.exec(message)?.[1] ?? null
  const replacement = named && named !== model.replace(/^models\//, '') ? named : null
  return { replacement }
}

export const OPENAI_DEFAULT_BASE_URL = 'https://api.openai.com/v1'

/** Whether an OpenAI-compatible base URL is the Gemini preset's host. */
export function isGeminiBaseUrl(url: string): boolean {
  try {
    return new URL(url).hostname === GEMINI_PRESET.host
  } catch {
    return false
  }
}

export type EnhanceErrorCode =
  | 'no-model'
  | 'missing-key'
  | 'provider-error'
  | 'refusal'
  | 'empty-response'
  | 'timeout'
  | 'interrupted'
  | 'unknown-template'
  | 'blank-template'
  | 'note-not-found'

export interface GenerateRequest {
  noteId: string
  templateSlug?: string
  /** Retry or open-generate into that panel. */
  panelId?: string
  /** The editor's current markdown. */
  notesMarkdown?: string
  auto?: boolean
  overrideVariables?: Record<string, string>
}

export interface RewriteRequest {
  noteId: string
  panelId: string
  instructions: string
}

/**
 * main → renderer generation events. `done` marks the end of a generation.
 */
export type EnhanceEvent = { noteId: string; panelId: string } & (
  | { type: 'panel_id' }
  | { type: 'completion'; delta: string }
  | { type: 'ai_line_map'; lines: GeneratedLine[] }
  | { type: 'ydoc'; originalContent: string; ydocState: null; ydocVersion: number }
  | { type: 'error'; code: EnhanceErrorCode; message: string }
  | { type: 'done'; ok: boolean }
)

export interface ActiveGeneration {
  panelId: string
  text: string
  startedAt: IsoTime
}

export type TitleSkipReason =
  | 'transcript-too-short'
  | 'already-titled'
  | 'not-owner'
  | 'contains-newline'
  | 'empty-result'
  | 'no-model'

export interface TitleResult {
  status: 'saved' | 'skipped' | 'rejected' | 'error'
  title?: string
  reason?: TitleSkipReason | (string & {})
}

export const DEFAULT_TEMPLATE_SLUG = 'standard-notes'
export const USER_TEMPLATE_PROMPT_SLUG = 'custom-template-notes'
export const BLANK_TEMPLATE_SLUG = 'blank'
export const SUGGESTED_ACTIONS_SLUG = 'recap-next-steps'
/** Built-in slugs that resolve to the default template. */
export const BUILTIN_SUMMARY_SLUGS = [
  'notes-led-long',
  'notes-led-short',
  'notes-led-investor-short',
  'notes-led-tiny'
] as const
export const TITLE_PROMPT_SLUG = 'note-title'
export const MEETING_END_PROMPT_SLUG = 'meeting-end-check'

/** Retired model id → its replacement. Empty for now. */
export const MODEL_ALIASES: Record<string, string> = {}

/** The chat model selection meaning "the provider's settings model" (`chat.model.*`). */
export const CHAT_MODEL_AUTO = 'auto'
