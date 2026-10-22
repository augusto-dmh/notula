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
  'nova-3': ['en', 'es', 'fr', 'de', 'hi', 'ru', 'pt', 'ja', 'it', 'nl'],
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
