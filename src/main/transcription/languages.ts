// SPDX-License-Identifier: Apache-2.0
// Transcription languages in main:
// the new-profile default, the providers' declared languages, and the language-aware
// failover choice. Pure: the callers pass settings and configuration in.

import {
  FALLBACK_MIN_WORDS,
  LANGUAGE_ALIASES,
  MULTI_LANGUAGE_SETS,
  TRANSCRIPTION_LANGUAGE_NAMES
} from '@shared/types/languages'
import type {
  AssemblyAiMultilingualModel,
  DeepgramMultilingualVersion,
  TranscriptionLanguage
} from '@shared/types/settings'
import type { AsrProviderId } from '@shared/types/transcript'

export type MultiModel = keyof typeof MULTI_LANGUAGE_SETS

/** An OS or provider language tag reduced to its lower-case base code, `nb` → `no`. */
export function baseCode(tag: string): string {
  const b = tag.trim().toLowerCase().split(/[-_]/)[0] ?? ''
  return LANGUAGE_ALIASES[b] ?? b
}

/** The fixed list of supported non-English codes, used when no provider is configured. */
export const DEFAULT_SUPPORTED_CODES: readonly string[] = Object.keys(TRANSCRIPTION_LANGUAGE_NAMES)

/**
 * The new-profile default: `multi` when any OS language's base code is a
 * supported non-English language of the default provider's multilingual model.
 */
export function defaultLanguageFor(systemLanguages: readonly string[], supported: readonly string[]): TranscriptionLanguage {
  for (const tag of systemLanguages) {
    const b = baseCode(tag)
    if (b && b !== 'en' && supported.includes(b)) return 'multi'
  }
  return 'en'
}

/** The multilingual model each cloud provider uses for `multi` (settings). */
export function deepgramMultiModel(version: DeepgramMultilingualVersion): MultiModel {
  return version === '58-lang-beta' ? 'nova-3-mega' : 'nova-3'
}

export function assemblyMultiModel(model: AssemblyAiMultilingualModel): MultiModel {
  return model
}

/** The languages a provider declares (adapted: AssemblyAI's pro models cover `multi`; local per its model). */
export function declares(provider: AsrProviderId, language: string, localCovers: (l: string) => boolean): boolean {
  if (provider === 'local') return localCovers(language)
  return language === 'en' || language === 'multi' || language === 'pt-BR'
}

/**
 * The language a cloud provider is asked for: `pt-BR` exists for the on-device
 * models, and a cloud provider transcribes it with its multi-language model.
 */
export function cloudLanguage(language: string): string {
  return language === 'pt-BR' ? 'multi' : language
}

export type FallbackReason = 'provider-chosen' | 'language-unclear' | 'no-provider-fits' | 'declared'

export interface FallbackInput {
  language: string
  failed: AsrProviderId
  /** Configured providers the source may move to, in chain order (the failed one excluded). */
  candidates: readonly AsrProviderId[]
  /** Words per base code heard so far in the session. */
  evidence: ReadonlyMap<string, number>
  models: { deepgram: MultiModel; assemblyai: MultiModel }
  localCovers(language: string): boolean
}

/** The required languages: base codes with at least 10 words of evidence. */
export function requiredLanguages(evidence: ReadonlyMap<string, number>): string[] {
  return [...evidence.entries()].filter(([, n]) => n >= FALLBACK_MIN_WORDS).map(([code]) => code)
}

/**
 * The language-aware failover target:
 * - `en`: AssemblyAI when the failing provider is local and AssemblyAI is configured;
 *   otherwise the first other provider that declares the language.
 * - `multi`: Deepgram, then AssemblyAI multilingual, skipping the failed provider; the
 *   first whose model supports every required language wins. Without enough evidence,
 *   the normal order applies; with evidence no model covers, there is no target.
 */
export function pickFallback(i: FallbackInput): { target: AsrProviderId | null; reason: FallbackReason; required: string[] } {
  const usable = i.candidates.filter((p) => p !== i.failed && declares(p, i.language, i.localCovers))
  if (i.language !== 'multi') {
    if (i.failed === 'local' && usable.includes('assemblyai')) return { target: 'assemblyai', reason: 'declared', required: [] }
    return { target: usable[0] ?? null, reason: 'declared', required: [] }
  }
  const required = requiredLanguages(i.evidence)
  if (!required.length) return { target: usable[0] ?? null, reason: 'language-unclear', required }
  for (const p of ['deepgram', 'assemblyai'] as const) {
    if (!usable.includes(p)) continue
    const set = MULTI_LANGUAGE_SETS[i.models[p]]
    if (required.every((code) => set.includes(code))) return { target: p, reason: 'provider-chosen', required }
  }
  return { target: null, reason: 'no-provider-fits', required }
}
