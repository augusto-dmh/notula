// SPDX-License-Identifier: Apache-2.0
// Whisper's language lock under `multi`. Per-segment auto-detection let unclear audio
// switch a Portuguese lecture into Russian and Romanian for one burst, so the worker
// detects once, then decodes the rest of the session in that language:
// - evidence: finals with at least 4 words, each with the language Whisper reported;
// - lock: after 3 such finals, or 20 s of their audio, on the language most of them
//   had (ties: the one with more audio);
// - safety net, once locked: a final or partial whose letters are mostly in a script the
//   locked language doesn't use (Cyrillic, Greek, CJK, Arabic… in a Latin session, and
//   the reverse) is dropped, from 4 such letters (a lone "Ok" in a Russian session stays).
//   Text in the same script is never dropped.
// - word by word: in what is kept, a word written in a script the session doesn't
//   keep is removed ("Uma task da... Тески. Quanto" → "Uma task da... Quanto"), and the
//   spaces and punctuation it leaves collapse. Latin words stay in sessions of non-Latin
//   languages (code, product names); digits and symbols always stay. Inside a word only
//   the foreign letters go, so unspaced CJK or Thai text keeps its own script.
// Pure: no sherpa, no process, so `scripts/dev/language-lock-check.ts` can drive it.

/** A final counts as evidence from this many words. */
export const EVIDENCE_MIN_WORDS = 4
/** Lock after this many evidence finals… */
export const LOCK_AFTER_FINALS = 3
/** …or this much evidence audio, whichever comes first. */
export const LOCK_AFTER_AUDIO_MS = 20_000
/** Drop when more than this share of the letters is in a foreign script… */
const FOREIGN_SCRIPT_SHARE = 0.5
/** …and there are at least this many of them. */
const FOREIGN_MIN_LETTERS = 4

/** Each script by its Unicode Script property names. A letter in none of them is 'other', never foreign. */
const SCRIPT_PROPS = {
  latin: ['Latin'],
  cyrillic: ['Cyrillic'],
  greek: ['Greek'],
  han: ['Han'],
  kana: ['Hiragana', 'Katakana'],
  hangul: ['Hangul'],
  arabic: ['Arabic'],
  hebrew: ['Hebrew'],
  devanagari: ['Devanagari'],
  bengali: ['Bengali'],
  gurmukhi: ['Gurmukhi'],
  gujarati: ['Gujarati'],
  tamil: ['Tamil'],
  telugu: ['Telugu'],
  kannada: ['Kannada'],
  malayalam: ['Malayalam'],
  sinhala: ['Sinhala'],
  thai: ['Thai'],
  lao: ['Lao'],
  khmer: ['Khmer'],
  myanmar: ['Myanmar'],
  tibetan: ['Tibetan'],
  georgian: ['Georgian'],
  armenian: ['Armenian'],
  ethiopic: ['Ethiopic']
} as const
type Script = keyof typeof SCRIPT_PROPS | 'other'
const ALL_SCRIPTS = Object.keys(SCRIPT_PROPS) as (keyof typeof SCRIPT_PROPS)[]

/** The inside of a regex character class matching any letter of `scripts`. */
function charClass(scripts: (keyof typeof SCRIPT_PROPS)[]): string {
  return scripts.flatMap((sc) => SCRIPT_PROPS[sc].map((p) => `\\p{Script=${p}}`)).join('')
}

const SCRIPTS = ALL_SCRIPTS.map((sc) => [sc, new RegExp(`[${charClass([sc])}]`, 'u')] as const)

/** Whisper language codes whose writing is not Latin; every other language is Latin. */
const NON_LATIN: [Script[], string[]][] = [
  [['cyrillic'], ['ru', 'uk', 'be', 'bg', 'mk', 'kk', 'mn', 'tt', 'ba', 'tg']],
  [['cyrillic', 'latin'], ['sr']],
  [['greek'], ['el']],
  [['han'], ['zh', 'yue']],
  [['han', 'kana'], ['ja']],
  [['hangul', 'han'], ['ko']],
  [['arabic'], ['ar', 'fa', 'ur', 'ps', 'sd']],
  [['hebrew'], ['he', 'yi']],
  [['devanagari'], ['hi', 'mr', 'ne', 'sa']],
  [['bengali'], ['bn', 'as']],
  [['gurmukhi'], ['pa']],
  [['gujarati'], ['gu']],
  [['tamil'], ['ta']],
  [['telugu'], ['te']],
  [['kannada'], ['kn']],
  [['malayalam'], ['ml']],
  [['sinhala'], ['si']],
  [['thai'], ['th']],
  [['lao'], ['lo']],
  [['khmer'], ['km']],
  [['myanmar'], ['my']],
  [['tibetan'], ['bo']],
  [['georgian'], ['ka']],
  [['armenian'], ['hy']],
  [['ethiopic'], ['am']]
]
const LANGUAGE_SCRIPTS = new Map(NON_LATIN.flatMap(([scripts, codes]) => codes.map((code) => [code, scripts] as const)))

export function scriptsOf(language: string): Script[] {
  return LANGUAGE_SCRIPTS.get(language) ?? ['latin']
}

function scriptOf(ch: string): Script {
  for (const [script, re] of SCRIPTS) if (re.test(ch)) return script
  return 'other'
}

/**
 * A run of letters (with their combining marks, joined by a hyphen or an apostrophe)
 * in a script whose words a `language` session doesn't keep: its own scripts and Latin stay.
 */
function foreignRun(language: string): RegExp {
  const kept = new Set<Script>([...scriptsOf(language), 'latin'])
  const letter = `[${charClass(ALL_SCRIPTS.filter((sc) => !kept.has(sc)))}]\\p{M}*`
  return new RegExp(`(?:${letter})+(?:[-'’](?:${letter})+)*`, 'gu')
}

/** Sentence-ending punctuation that a removed word hands to the word before it. */
const SENTENCE_END = /^[.!?…]+$/u

/** Whisper's language as a bare code (`<|pt|>` or `pt` → `pt`); null when unusable. */
export function normalizeLanguage(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const code = raw.replace(/^<\|/, '').replace(/\|>$/, '').trim().toLowerCase()
  return /^[a-z]{2,3}$/.test(code) ? code : null
}

/** Letters of `text` in a script `language` doesn't use, and all its letters. */
function countForeign(text: string, language: string): { foreign: number; letters: number } {
  const own = new Set(scriptsOf(language))
  let letters = 0
  let foreign = 0
  for (const ch of text) {
    if (!/\p{L}/u.test(ch)) continue
    letters++
    const script = scriptOf(ch)
    if (script !== 'other' && !own.has(script)) foreign++
  }
  return { foreign, letters }
}

/** The share of `text`'s letters written in a script `language` doesn't use (0 with no letters). */
export function foreignScriptShare(text: string, language: string): number {
  const { foreign, letters } = countForeign(text, language)
  return letters ? foreign / letters : 0
}

export interface LockDecision {
  language: string
  /** Evidence finals seen, and how many of them had the locked language. */
  evidence: number
  votes: number
  evidenceAudioMs: number
}

export class LanguageLock {
  private readonly seen: { language: string; audioMs: number }[] = []
  private locked: string | null = null
  private foreign: RegExp | null = null

  get language(): string | null {
    return this.locked
  }

  /**
   * One decoded final, before the lock. Returns the decision when this final completes
   * the evidence, else null.
   */
  observe(rawLanguage: unknown, text: string, audioMs: number): LockDecision | null {
    if (this.locked) return null
    const language = normalizeLanguage(rawLanguage)
    if (!language || text.split(/\s+/).filter(Boolean).length < EVIDENCE_MIN_WORDS) return null
    this.seen.push({ language, audioMs })
    const audio = this.seen.reduce((sum, e) => sum + e.audioMs, 0)
    if (this.seen.length < LOCK_AFTER_FINALS && audio < LOCK_AFTER_AUDIO_MS) return null
    const tally = new Map<string, { votes: number; audioMs: number }>()
    for (const e of this.seen) {
      const t = tally.get(e.language) ?? { votes: 0, audioMs: 0 }
      t.votes++
      t.audioMs += e.audioMs
      tally.set(e.language, t)
    }
    let best: { language: string; votes: number; audioMs: number } | null = null
    for (const [lang, t] of tally) {
      if (!best || t.votes > best.votes || (t.votes === best.votes && t.audioMs > best.audioMs)) best = { language: lang, ...t }
    }
    if (!best) return null
    this.locked = best.language
    this.foreign = foreignRun(best.language)
    return { language: best.language, evidence: this.seen.length, votes: best.votes, evidenceAudioMs: Math.round(audio) }
  }

  /** Once locked: true when `text` is mostly in a script the locked language doesn't use. */
  rejects(text: string): boolean {
    if (this.locked === null) return false
    const { foreign, letters } = countForeign(text, this.locked)
    return foreign >= FOREIGN_MIN_LETTERS && foreign / letters > FOREIGN_SCRIPT_SHARE
  }

  /**
   * Once locked: `text` without its words in a script the session doesn't keep, and
   * how many words lost letters. With none, `text` comes back as the same string.
   */
  clean(text: string): { text: string; removed: number } {
    const re = this.foreign
    if (!re || !text.match(re)) return { text, removed: 0 }
    const out: string[] = []
    let removed = 0
    for (const word of text.split(/\s+/).filter(Boolean)) {
      const rest = word.replace(re, '')
      if (rest === word) {
        out.push(word)
        continue
      }
      removed++
      // What's left keeps its letters, digits and symbols. Bare punctuation goes, but a
      // sentence end moves onto the word before it.
      if (/[\p{L}\p{N}\p{S}]/u.test(rest)) out.push(rest)
      else if (SENTENCE_END.test(rest) && out.length && !/\p{P}$/u.test(out[out.length - 1] as string)) out[out.length - 1] += rest
    }
    return { text: out.join(' '), removed }
  }
}
