// SPDX-License-Identifier: Apache-2.0
// Transcription languages.

/** The supported display languages: code → name, `en` first (32 entries). */
export const TRANSCRIPTION_LANGUAGE_NAMES: Record<string, string> = {
  en: 'English',
  es: 'Spanish',
  fr: 'French',
  de: 'German',
  it: 'Italian',
  pt: 'Portuguese',
  tr: 'Turkish',
  nl: 'Dutch',
  sv: 'Swedish',
  no: 'Norwegian',
  da: 'Danish',
  fi: 'Finnish',
  hi: 'Hindi',
  vi: 'Vietnamese',
  ar: 'Arabic',
  he: 'Hebrew',
  ja: 'Japanese',
  ur: 'Urdu',
  zh: 'Mandarin',
  ru: 'Russian',
  ko: 'Korean',
  ca: 'Catalan',
  gl: 'Galician',
  ro: 'Romanian',
  et: 'Estonian',
  fa: 'Persian',
  yue: 'Cantonese',
  af: 'Afrikaans',
  mr: 'Marathi',
  zu: 'Zulu',
  xh: 'Xhosa',
  nn: 'Norwegian Nynorsk'
}

/** OS base codes mapped before any lookup. */
export const LANGUAGE_ALIASES: Record<string, string> = { nb: 'no' }

const UNIVERSAL_PRO_SET: readonly string[] = Object.keys(TRANSCRIPTION_LANGUAGE_NAMES)

/** Each multilingual model's supported base codes (the fallback capability table). */
export const MULTI_LANGUAGE_SETS: Record<
  'nova-3' | 'nova-3-mega' | 'universal-3-5-pro' | 'universal-3-6-pro',
  readonly string[]
> = {
  // Deepgram's published `language=multi` list for nova-3, as base codes: Flemish is `nl`, and
  // Cantonese (`zh-HK` there) is `yue`.
  'nova-3': [
    'af', 'ar', 'be', 'bn', 'bs', 'bg', 'ca', 'zh', 'yue', 'hr', 'cs', 'da', 'nl', 'en', 'et', 'fi', 'fr',
    'gl', 'de', 'el', 'gu', 'he', 'hi', 'hu', 'id', 'it', 'ja', 'kn', 'ko', 'lv', 'lt', 'mk', 'ms', 'mr',
    'no', 'fa', 'pl', 'pt', 'ro', 'ru', 'sr', 'sk', 'sl', 'es', 'sv', 'tl', 'ta', 'te', 'th', 'tr', 'uk',
    'vi', 'xh', 'zu'
  ],
  'nova-3-mega': [
    'af', 'ar', 'be', 'bn', 'bs', 'bg', 'ca', 'zh', 'yue', 'hr', 'cs', 'da', 'nl', 'en', 'et', 'fi', 'fr',
    'gl', 'de', 'el', 'gu', 'he', 'hi', 'hu', 'id', 'it', 'ja', 'kn', 'ko', 'lv', 'lt', 'mk', 'ms', 'ml',
    'mr', 'no', 'fa', 'pl', 'pt', 'ro', 'ru', 'sr', 'sk', 'sl', 'es', 'sw', 'sv', 'tl', 'ta', 'te', 'th',
    'tr', 'uk', 'vi', 'xh', 'zu'
  ],
  'universal-3-5-pro': UNIVERSAL_PRO_SET,
  'universal-3-6-pro': UNIVERSAL_PRO_SET
}

/** Words a language needs before it counts as language evidence. */
export const FALLBACK_MIN_WORDS = 10

/** The most languages `transcription.languages` keeps. */
export const MAX_TRANSCRIPTION_LANGUAGES = 10

const intlNames = (() => {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' })
  } catch {
    return null
  }
})()

/** A base code's English display name: the table's name first, then the platform's, then the code. */
export function languageDisplayName(code: string): string {
  const named = TRANSCRIPTION_LANGUAGE_NAMES[code]
  if (named) return named
  try {
    return intlNames?.of(code) ?? code
  } catch {
    return code
  }
}

/** Codes ordered by display name. */
export function byDisplayName(codes: readonly string[]): string[] {
  return [...codes].sort((a, b) => languageDisplayName(a).localeCompare(languageDisplayName(b), 'en'))
}

/**
 * A `transcription.languages` list as saved: lower-case codes without duplicates,
 * at most 10 (the first 10 given), ordered by display name.
 */
export function normalizeLanguageList(codes: readonly string[]): string[] {
  const out: string[] = []
  for (const c of codes) {
    const code = c.trim().toLowerCase()
    if (code && !out.includes(code)) out.push(code)
  }
  return byDisplayName(out.slice(0, MAX_TRANSCRIPTION_LANGUAGES))
}
