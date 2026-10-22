// SPDX-License-Identifier: Apache-2.0
// Dev-only check for Whisper's language lock, its script filter under `multi` and the
// word-level filter for stray wrong-script words (src/main/asr/language-lock.ts). Feeds
// synthetic decode results to the pure lock; no model, no audio.
// Run: node scripts/dev/language-lock-check.ts   (Node's type stripping; exits 1 on a failure)

import { foreignScriptShare, LanguageLock, normalizeLanguage, type LockDecision } from '../../src/main/asr/language-lock.ts'

type Final = [lang: string | undefined, text: string, audioMs: number]

interface Case {
  name: string
  finals: Final[]
  /** The decision expected from the final that completes the evidence, or null. */
  locks: Partial<LockDecision> | null
  /** After the finals: texts the filter must drop, and texts it must keep. */
  drops?: string[]
  keeps?: string[]
  /** After the finals: [input, expected] for the word-level filter (`clean`). */
  cleans?: [string, string][]
}

const PT = 'hoje vamos falar sobre o arquivo de configuração do agente'
const CASES: Case[] = [
  {
    name: 'three Portuguese finals lock pt; the benchmark burst is dropped, Portuguese kept',
    finals: [
      ['pt', PT, 4_000],
      ['pt', 'e sobre as boas práticas para escrever instruções', 3_500],
      ['pt', 'depois da aula vocês vão receber um cupom', 3_000]
    ],
    locks: { language: 'pt', evidence: 3, votes: 3 },
    drops: ['Стой им агодом на меня', 'Привет как дела', 'Γεια σου κόσμε τι κάνεις', '你好世界今天我们讨论', 'مرحبا بالعالم'],
    keeps: ['Și-a reuată', 'O arquivo AGENTS.md define as instruções', 'Ok, 2026.', '', '...', 'cupom de 20% para o curso'],
    cleans: [
      // Stray wrong-script words seen in real lecture transcripts.
      ['Tu cria o que? Uma task da... Тески. Quanto mais', 'Tu cria o que? Uma task da... Quanto mais'],
      ['belongs to coort... 이 tu roda os testes', 'belongs to coort... tu roda os testes'],
      ['Sempre dê um checklist. И O gate que ele vai rodar', 'Sempre dê um checklist. O gate que ele vai rodar'],
      ['e aí ele falou Привет. Depois veio o resto', 'e aí ele falou. Depois veio o resto'],
      ['o cupom de 20% (скидка) vale hoje', 'o cupom de 20% vale hoje'],
      ['a taskТески foi feita ontem', 'a task foi feita ontem'],
      ['custa 50 ₽ ou R$ 10 по-русски agora', 'custa 50 ₽ ou R$ 10 agora'],
      ['vamos usar o 東京 e o αβ no exemplo', 'vamos usar o e o no exemplo'],
      // Latin-script text is never touched.
      ['O arquivo AGENTS.md define as instruções', 'O arquivo AGENTS.md define as instruções'],
      ['Și-a reuată,  ok', 'Și-a reuată,  ok'],
      ['', '']
    ]
  },
  {
    name: 'a mixed burst that is mostly Latin stays (same script is never dropped)',
    finals: [
      ['pt', PT, 4_000],
      ['pt', PT, 4_000],
      ['pt', PT, 4_000]
    ],
    locks: { language: 'pt' },
    keeps: ['Și-a reuată, ele disse que o curso é ótimo e vai ter um cupom Стой'],
    cleans: [['Și-a reuată, ele disse que o curso é ótimo e vai ter um cupom Стой', 'Și-a reuată, ele disse que o curso é ótimo e vai ter um cupom']]
  },
  {
    name: 'the majority wins over one misdetected final',
    finals: [
      ['pt', PT, 4_000],
      ['ru', 'Стой им агодом на меня', 9_000],
      ['pt', PT, 4_000]
    ],
    locks: { language: 'pt', evidence: 3, votes: 2 }
  },
  {
    name: 'short finals are not evidence (Whisper guesses wildly on "Obrigado.")',
    finals: [
      ['en', 'Obrigado.', 900],
      ['es', 'Sí, sí.', 700],
      ['pt', PT, 4_000],
      ['pt', PT, 4_000]
    ],
    locks: null
  },
  {
    name: '20 s of evidence audio locks before 3 finals',
    finals: [
      ['en', 'we went over the release plan and the open questions', 12_000],
      ['en', 'and good practices for writing clear instructions', 9_000]
    ],
    locks: { language: 'en', evidence: 2, evidenceAudioMs: 21_000 }
  },
  {
    name: 'a tie goes to the language with more audio',
    finals: [
      ['es', 'hoy vamos a hablar del archivo', 5_000],
      ['pt', PT, 8_000],
      ['en', 'and good practices for writing clear instructions', 2_000]
    ],
    locks: { language: 'pt', votes: 1 }
  },
  {
    name: 'a Russian session drops Latin text and Chinese, keeps Cyrillic',
    finals: [
      ['<|ru|>', 'сегодня мы поговорим о файле конфигурации', 4_000],
      ['ru', 'и о хороших практиках написания инструкций', 4_000],
      ['ru', 'после занятия вы получите скидку на курс', 4_000]
    ],
    locks: { language: 'ru' },
    drops: ['Today we are going to talk about it', '你好世界今天我们讨论'],
    keeps: ['сегодня мы поговорим о AGENTS.md', 'Ok'],
    cleans: [
      ['сегодня мы поговорим о AGENTS.md 你好', 'сегодня мы поговорим о AGENTS.md'],
      ['это Ok и всё', 'это Ok и всё']
    ]
  },
  {
    name: 'a Japanese session keeps kana and kanji, drops Cyrillic',
    finals: [
      ['ja', '今日は 設定 ファイル について 話します', 4_000],
      ['ja', 'そして 良い 書き方 について も 話します', 4_000],
      ['ja', '授業 の 後 で クーポン を 送ります ね', 4_000]
    ],
    locks: { language: 'ja' },
    drops: ['Стой им агодом на меня'],
    keeps: ['ファイル の AGENTS.md を 見て ください'],
    cleans: [
      ['ファイル について 話します Да', 'ファイル について 話します'],
      ['設定ファイルДаです', '設定ファイルです'],
      ['ファイル の AGENTS.md を 見て ください', 'ファイル の AGENTS.md を 見て ください']
    ]
  },
  {
    name: 'no language reported: never locks, never drops',
    finals: [
      [undefined, PT, 4_000],
      [undefined, PT, 4_000],
      [undefined, PT, 4_000]
    ],
    locks: null,
    keeps: ['Стой им агодом на меня'],
    cleans: [['ele falou Привет', 'ele falou Привет']]
  }
]

let failures = 0
function expect(ok: boolean, what: string): void {
  if (ok) return
  failures++
  console.log(`      ✗ ${what}`)
}

for (const c of CASES) {
  const lock = new LanguageLock()
  const failuresBefore = failures
  let decision: LockDecision | null = null
  for (const [lang, text, ms] of c.finals) {
    // Before the lock nothing is filtered; the filter only answers once locked.
    expect(!lock.rejects(text) || lock.language !== null, `rejected "${text}" before the lock`)
    expect(lock.language !== null || lock.clean(text).text === text, `cleaned "${text}" before the lock`)
    decision = lock.observe(lang, text, ms) ?? decision
  }
  if (c.locks === null) {
    expect(decision === null && lock.language === null, `expected no lock, got ${JSON.stringify(decision)}`)
  } else {
    expect(decision !== null, 'expected a lock, got none')
    for (const [k, v] of Object.entries(c.locks)) {
      expect(decision?.[k as keyof LockDecision] === v, `${k}: expected ${String(v)}, got ${String(decision?.[k as keyof LockDecision])}`)
    }
    expect(lock.observe('ru', 'это не должно изменить язык сессии', 30_000) === null, 'a later final changed the lock')
  }
  for (const t of c.drops ?? []) expect(lock.rejects(t), `kept "${t}" (foreign share ${foreignScriptShare(t, lock.language ?? '').toFixed(2)})`)
  for (const t of c.keeps ?? []) expect(!lock.rejects(t), `dropped "${t}" (foreign share ${foreignScriptShare(t, lock.language ?? '').toFixed(2)})`)
  for (const [input, want] of c.cleans ?? []) {
    const got = lock.clean(input)
    expect(got.text === want && (got.removed > 0) === (want !== input), `clean "${input}": expected "${want}", got "${got.text}" (${got.removed} removed)`)
  }
  console.log(`${failures === failuresBefore ? 'PASS' : 'FAIL'}  ${c.name}${decision ? `  → ${JSON.stringify(decision)}` : ''}`)
}

expect(normalizeLanguage('<|pt|>') === 'pt' && normalizeLanguage('PT') === 'pt' && normalizeLanguage('yue') === 'yue', 'normalizeLanguage codes')
expect(normalizeLanguage('') === null && normalizeLanguage(undefined) === null && normalizeLanguage('<|nospeech|>') === null, 'normalizeLanguage rejects')
console.log(failures ? `\n${failures} expectation(s) failed` : '\nall cases passed')
process.exit(failures ? 1 : 0)
