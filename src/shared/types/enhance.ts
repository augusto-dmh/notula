// SPDX-License-Identifier: Apache-2.0
// AI-enhanced notes, titles and LLM providers (F-enhance-*).

import type { IsoTime } from './common'
import type { GeneratedLine } from './panels'

export type LlmProviderId = 'anthropic' | 'openai' | 'local'
export type CloudLlmProviderId = 'anthropic' | 'openai'

/**
 * The "Google Gemini" preset of the OpenAI-compatible provider (its key is the
 * `llm.openai` key). Recommended and preselected in onboarding.
 */
export const GEMINI_PRESET = {
  baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
  model: 'gemini-2.5-flash',
  host: 'generativelanguage.googleapis.com'
} as const

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
