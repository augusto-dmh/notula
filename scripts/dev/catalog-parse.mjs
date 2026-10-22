// SPDX-License-Identifier: Apache-2.0
// Dev-only harness for series catalogs. Checks the catalog grammar, the
// lesson-number title patterns, catalog matching, lesson resolution at creation, renumbering on
// import, and the title cleanup against fixtures written from the facts of
// a real note history: a stretch of notes titled Aula 28–31 that are really
// lessons 29–32 (lesson 28 had no note), a lesson titled with no number at all, a catalog pasted
// by hand with sections, and per-section numbering. The course names and titles are invented.
//
// Run:  node scripts/dev/catalog-parse.mjs              every case; exits 1 on a failure
//       node scripts/dev/catalog-parse.mjs <file.md>    parses a catalog file and prints counts
//
// The TypeScript sources load through Node's type stripping; the resolve hook below maps
// `@shared/…` and extensionless relative imports to their `.ts` files.

import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

registerHooks({
  resolve(specifier, context, next) {
    let r
    if (specifier.startsWith('@shared/')) r = next(pathToFileURL(resolve(root, 'src/shared', `${specifier.slice(8)}.ts`)).href, context)
    else if (specifier.startsWith('.') && context.parentURL?.endsWith('.ts') && !/\.[cm]?[jt]s$/.test(specifier)) r = next(new URL(`${specifier}.ts`, context.parentURL).href, context)
    else r = next(specifier, context)
    // The package has no "type": the sources are ES modules in TypeScript.
    return r.url.endsWith('.ts') ? { ...r, format: 'module-typescript' } : r
  }
})

const src = (p) => pathToFileURL(resolve(root, p)).href
const C = await import(src('src/main/sources/catalog.ts'))
const { renderSourceTitle, matchTitle } = await import(src('src/main/sources/titles.ts'))

// ---------- a tiny runner ----------

let failures = 0
let checks = 0
let current = ''

function check(cond, what) {
  checks++
  if (!cond) {
    failures++
    console.log(`  FAIL [${current}] ${what}`)
  }
}

function eq(actual, expected, what) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  check(a === e, `${what}: expected ${e}, got ${a}`)
}

function test(name, fn) {
  current = name
  const before = failures
  try {
    fn()
  } catch (err) {
    failures++
    console.log(`  FAIL [${name}] threw: ${err?.stack ?? err}`)
  }
  console.log(`${failures === before ? 'ok  ' : 'FAIL'} ${name}`)
}

// ---------- one file ----------

if (process.argv[2]) {
  const parsed = C.parseCatalog(readFileSync(process.argv[2], 'utf8'))
  const numbered = parsed.items.filter((i) => i.number !== null).length
  const withUrl = parsed.items.filter((i) => i.url).length
  const withDuration = parsed.items.filter((i) => i.duration_ms !== null).length
  console.log(
    JSON.stringify({ items: parsed.items.length, sections: parsed.sections, skippedLines: parsed.skippedLines, renumbered: parsed.renumbered, overLimit: parsed.overLimit, numbered, withUrl, withDuration })
  )
  process.exit(0)
}

// ---------- fixtures (invented; shaped like the facts in history.md) ----------

// A course outline pasted from a lesson page: `#`/`##` sections, `Aula <n>` numbers, a mix of
// durations and links, a front-matter block, a rule, a table and a quote that aren't lessons.
const COURSE = `---
course: Arquitetura de Software Corporativo
---
# Arquitetura de Software Corporativo

## Módulo 6 · Persistência
Aula 27 - Repositórios e unidades de trabalho (18:40)
Aula 28 - Módulos de infraestrutura: banco de dados (22:05) https://academy.example.org/c/arq/sections/600/lessons/9028
Aula 29 - Camada de persistência e migrations — 1:02:13
Aula 30 - Transações entre módulos 14:09

---

## Módulo 7 · Integração
- Aula 31 - Eventos de integração e outbox [Assistir](https://academy.example.org/c/arq/sections/700/lessons/9031)
- Aula 32 - Consistência eventual na prática (25:30)
- [ ] Aula 33 - Contratos entre módulos

| Aula | Título | Duração |
|---|---|---|
> Material de apoio na aba Arquivos.

## Módulo 12 · Escalando
Aula 65 - Coesão e granularidade com módulos de subdomínio (31:47)
`

// The notes as their titles were typed while watching: 28–31 are really 29–32, and one lesson
// had no number yet.
const NOTES = [
  { note_id: 'n28', title: '[Curso] Arquitetura de Software Corporativo - Aula 28 - Camada de persistência e migrations' },
  { note_id: 'n29', title: '[Curso] Arquitetura de Software Corporativo - Aula 29 - Transações entre módulos' },
  { note_id: 'n30', title: '[Curso] Arquitetura de Software Corporativo - Aula 30 - Eventos de integração e outbox' },
  { note_id: 'n31', title: '[Curso] Arquitetura de Software Corporativo - Aula 31 - Consistência eventual na prática' },
  { note_id: 'nX', title: '[Curso] Arquitetura de Software Corporativo - Aula (SEM NUMERO AINDA) - Coesão e granularidade com módulos de subdomínio' }
]

// ---------- grammar ----------

test('grammar: sections, numbers, durations, links, skipped lines', () => {
  const p = C.parseCatalog(COURSE)
  eq(p.items.length, 8, 'items')
  eq(p.sections, 3, 'sections with items')
  eq(p.renumbered, false, 'explicit numbers kept')
  eq(p.overLimit, false, 'under the limit')
  eq(
    p.items.map((i) => i.number),
    [27, 28, 29, 30, 31, 32, 33, 65],
    'numbers'
  )
  eq(p.items[0].title, 'Repositórios e unidades de trabalho', 'title without number and duration')
  eq(p.items[0].duration_ms, (18 * 60 + 40) * 1000, '(mm:ss)')
  eq(p.items[0].section, 'Módulo 6 · Persistência', 'section from ##')
  eq(p.items[1].url, 'https://academy.example.org/c/arq/sections/600/lessons/9028', 'bare URL at the end')
  check(typeof p.items[1].canonical_key === 'string' && p.items[1].canonical_key.length > 0, 'a URL gives a canonical key')
  eq(p.items[1].title, 'Módulos de infraestrutura: banco de dados', 'title keeps its colon')
  eq(p.items[2].duration_ms, (1 * 3600 + 2 * 60 + 13) * 1000, 'bare hh:mm:ss')
  eq(p.items[2].title, 'Camada de persistência e migrations', 'em dash before the duration trimmed')
  eq(p.items[3].duration_ms, (14 * 60 + 9) * 1000, 'trailing mm:ss')
  eq(p.items[4].url, 'https://academy.example.org/c/arq/sections/700/lessons/9031', 'Markdown link URL')
  eq(p.items[4].title, 'Eventos de integração e outbox', 'a Markdown link label is not the title')
  eq(p.items[4].section, 'Módulo 7 · Integração', 'list items under a section')
  eq(p.items[6].title, 'Contratos entre módulos', 'task-list marker stripped')
  eq(p.items[7].section, 'Módulo 12 · Escalando', 'a later section')
  // Front matter (3 lines), the rule, the table (2 rows) and the quote.
  eq(p.skippedLines, 7, 'skipped lines')
})

test('grammar: number forms 12. / 12) / 12 - / Lesson 12, URL anywhere', () => {
  const p = C.parseCatalog(
    [
      '12. Introduction to queues',
      '13) Retries and backoff (07:30)',
      '14 - https://www.youtube.com/watch?v=AbCdEfGhIjK Idempotent consumers',
      'Lesson 15: Dead-letter queues 1:05:00',
      '',
      '   ',
      '16 – Poison messages',
      '17. [Ordering guarantees](https://example.org/course/lesson-17)'
    ].join('\n')
  )
  eq(
    p.items.map((i) => [i.number, i.title]),
    [
      [12, 'Introduction to queues'],
      [13, 'Retries and backoff'],
      [14, 'Idempotent consumers'],
      [15, 'Dead-letter queues'],
      [16, 'Poison messages'],
      [17, 'Ordering guarantees']
    ],
    'numbers and titles'
  )
  eq(p.items[5].url, 'https://example.org/course/lesson-17', 'a Markdown link that is the whole title')
  eq(p.items[2].canonical_key, 'youtube:AbCdEfGhIjK', 'YouTube URL in the middle gives the video key')
  eq(p.items[3].duration_ms, 3_900_000, 'h:mm:ss')
  eq(p.skippedLines, 0, 'blank lines are ignored, not skipped')
})

test('grammar: no numbers → the order numbers the items', () => {
  const p = C.parseCatalog('# Playlist\n- Welcome\n- Setting up\n- First steps (04:00)\n')
  eq(
    p.items.map((i) => i.number),
    [1, 2, 3],
    'order numbers'
  )
  eq(p.renumbered, true, 'renumbered')
})

test('grammar: numbering that restarts per section → the order numbers the items', () => {
  const p = C.parseCatalog('## Part 1\n1. Alpha topic\n2. Beta topic\n## Part 2\n1. Gamma topic\n2. Delta topic\n')
  eq(
    p.items.map((i) => i.number),
    [1, 2, 3, 4],
    'continuous numbers'
  )
  eq(
    p.items.map((i) => i.section),
    ['Part 1', 'Part 1', 'Part 2', 'Part 2'],
    'sections kept'
  )
  eq(p.renumbered, true, 'renumbered')
})

test('grammar: 2,000 items at most', () => {
  const lines = Array.from({ length: 2001 }, (_, i) => `${i + 1}. Lesson title number ${i + 1}`)
  eq(C.parseCatalog(lines.slice(0, 2000).join('\n')).overLimit, false, '2,000 is fine')
  eq(C.parseCatalog(lines.join('\n')).overLimit, true, '2,001 is over')
})

test('grammar: punctuation-only lines and fences are skipped', () => {
  const p = C.parseCatalog('```\n1. Inside a fence\n```\n***\n— — —\n1. Real lesson\n')
  eq(p.items.length, 1, 'one item')
  eq(p.items[0].title, 'Real lesson', 'the real lesson')
})

// ---------- title patterns ----------

test('title patterns: guessed numbers', () => {
  const cases = [
    ['[Curso] Arquitetura - Aula 28 - Camada de persistência', 28],
    ['Lesson 3: Queues', 3],
    ['Class 7 — Caching', 7],
    ['12. Intro to indexes', 12],
    ['Live Q&A #4', 4],
    ['Aula nº 9 - Tópico', 9],
    ['[Curso] IA no Dia a Dia - Aula (SEM NUMERO AINDA) - Revisão de código', null],
    ['Monolito modular - Edição 2025', null],
    ['Top 10 tips for SQL', null],
    ['12:30 standup recap', null],
    ['Classroom management', null]
  ]
  for (const [title, n] of cases) eq(C.guessLessonNumber(title), n, title)
})

// ---------- matching and resolution ----------

const CATALOG = C.parseCatalog(COURSE).items

test('history P3: notes titled 28–31 resolve to catalog lessons 29–32', () => {
  const got = NOTES.slice(0, 4).map((n) => C.lessonFor(CATALOG, { canonicalKey: `title:academy.example.org:${n.note_id}`, url: null, title: n.title }))
  eq(
    got.map((l) => [l.number, l.state, l.fromCatalog]),
    [
      [29, 'numbered', true],
      [30, 'numbered', true],
      [31, 'numbered', true],
      [32, 'numbered', true]
    ],
    'catalog numbers win over the typed ones'
  )
  eq(got[0].label, 'Módulo 6 · Persistência', 'section as the label')
})

test('history P5: an unnumbered lesson is pending, then numbered by the catalog', () => {
  const draft = { canonicalKey: 'title:academy.example.org:x', url: null, title: NOTES[4].title, lesson: null }
  eq(C.draftLesson([], draft), { number: null, label: null, state: 'pending', origin: null }, 'no catalog: pending')
  eq(C.draftLesson(CATALOG, draft), { number: 65, label: 'Módulo 12 · Escalando', state: 'numbered', origin: 'catalog' }, 'catalog: 65')
})

test('resolution at creation: guessed without a catalog, catalog wins, playlist numbers stand', () => {
  const typed = { canonicalKey: 'title:academy.example.org:a', url: null, title: NOTES[0].title, lesson: null }
  eq(C.draftLesson([], typed), { number: 28, label: null, state: 'guessed', origin: null }, 'Aula 28 guessed')
  const playlist = {
    canonicalKey: 'youtube:ZZZZZZZZZZZ',
    url: 'https://www.youtube.com/watch?v=ZZZZZZZZZZZ',
    title: 'Something else entirely',
    lesson: { number: 4, label: null, state: 'numbered' }
  }
  eq(C.draftLesson(CATALOG, playlist), null, 'no catalog match: keep the playlist number')
  const byUrl = { ...playlist, canonicalKey: CATALOG[1].canonical_key, url: CATALOG[1].url, title: 'Unrelated title' }
  eq(C.draftLesson(CATALOG, byUrl)?.number, 28, 'catalog by key wins over the playlist number')
  const guessedDraft = { canonicalKey: 'title:x:y', url: null, title: 'No number here', lesson: { number: 7, label: null, state: 'guessed' } }
  eq(C.draftLesson([], guessedDraft), null, "the draft's own guess stands")
})

test('matching: by key, by URL, exact title, ambiguous title', () => {
  const items = C.parseCatalog(
    [
      '1. Intro https://www.youtube.com/watch?v=AAAAAAAAAAA',
      '2. Setting up the project https://example.org/course/lesson-2',
      '3. Testing basics',
      '4. Testing basics'
    ].join('\n')
  ).items
  eq(C.matchCatalogItem(items, { canonicalKey: 'youtube:AAAAAAAAAAA', url: null, title: 'whatever' })?.number, 1, 'by key')
  eq(C.matchCatalogItem(items, { canonicalKey: null, url: items[1].url, title: 'whatever' })?.number, 2, 'by URL')
  eq(C.matchCatalogItem(items, { canonicalKey: null, url: null, title: 'SETTING UP the project' })?.number, 2, 'by title, case-folded')
  eq(C.matchCatalogItem(items, { canonicalKey: null, url: null, title: 'Testing basics' }), null, 'two items with one title: no match')
  eq(C.matchCatalogItem(items, { canonicalKey: 'title:example.org:intro', url: null, title: 'Unknown' }), null, 'a guess key never matches by key')
})

test('matching: accents and a short title never match as a suffix', () => {
  const items = C.parseCatalog('1. Introdução\n2. Configuração do ambiente local\n').items
  eq(C.matchCatalogItem(items, { canonicalKey: null, url: null, title: 'Curso X - Aula 9 - Introdução' }), null, 'a short title needs an exact match')
  eq(C.matchCatalogItem(items, { canonicalKey: null, url: null, title: 'Curso X - Aula 2 - Configuracao do Ambiente Local' })?.number, 2, 'accent-folded suffix')
  eq(matchTitle('Aula 12 - Configuração'), 'configuracao', 'leading lesson marker dropped')
})

// ---------- renumbering on import ----------

test('import renumbering: pending and guessed change, manual never, earlier catalog follows', () => {
  const base = { canonical_key: 'title:x:y', url: null, lesson_label: null }
  const sources = [
    { ...base, note_id: 'n28', title: NOTES[0].title, lesson_number: 28, lesson_state: 'guessed', lesson_origin: null },
    { ...base, note_id: 'n29', title: NOTES[1].title, lesson_number: 29, lesson_state: 'numbered', lesson_origin: 'manual' },
    { ...base, note_id: 'n30', title: NOTES[2].title, lesson_number: 30, lesson_state: 'numbered', lesson_origin: 'catalog' },
    { ...base, note_id: 'n31', title: NOTES[3].title, lesson_number: 4, lesson_state: 'numbered', lesson_origin: 'playlist' },
    { ...base, note_id: 'nX', title: NOTES[4].title, lesson_number: null, lesson_state: 'pending', lesson_origin: null },
    { ...base, note_id: 'nZ', title: 'A video outside the catalog', lesson_number: null, lesson_state: 'pending', lesson_origin: null }
  ]
  const rows = C.renumberRows(sources, CATALOG)
  eq(
    rows.unsettled.map((r) => [r.noteId, r.lesson_number, r.lesson_state, r.lesson_origin]),
    [
      ['n28', 29, 'numbered', 'catalog'],
      ['nX', 65, 'numbered', 'catalog']
    ],
    'pending and guessed'
  )
  eq(
    rows.fromCatalog.map((r) => [r.noteId, r.lesson_number]),
    [['n30', 31]],
    'an earlier catalog number follows the new catalog'
  )
  check(![...rows.unsettled, ...rows.fromCatalog].some((r) => r.noteId === 'n29' || r.noteId === 'n31'), 'manual and playlist numbers untouched')
})

// ---------- titles ----------

test('titles: deterministic cleanup', () => {
  const t = (title, channel = null, site = null) => renderSourceTitle({ title, channel, provider: 'youtube', site })
  eq(t('(3) The outbox pattern explained - YouTube'), 'The outbox pattern explained', 'count and site suffix')
  eq(t('Night Drive (Official Video)'), 'Night Drive', '(Official Video)')
  eq(t('Night Drive [Official Music Video] - YouTube'), 'Night Drive', 'music video and suffix')
  eq(t('Loosely coupled monoliths | Code Lab', 'Code Lab'), 'Loosely coupled monoliths', 'trailing | channel')
  eq(t('Postgres indexes in practice | DataBits', 'Ana Souza'), 'Postgres indexes in practice | DataBits', 'a brand that is not the channel stays')
  eq(t('(12) Weekly live – YouTube'), 'Weekly live', 'en dash suffix')
  eq(t('   '), '', 'blank stays blank')
  eq(t('- YouTube'), '- YouTube', 'never empty: the raw title comes back')
  eq(t('Talk title - Community Hub', null, 'Community Hub'), 'Talk title', 'site label suffix')
})

console.log(`\n${checks} checks, ${failures} failed`)
process.exit(failures ? 1 : 0)
