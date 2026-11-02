// SPDX-License-Identifier: Apache-2.0
// Dev-only check for the window read's parsing half (src/main/media/lesson-read.ts). Runs the
// synthetic accessibility trees in scripts/dev/fixtures/lesson-read/ (`<site>-*.json`: the nodes
// the reader sends, as [depth, type, name], and the expected fields) through the parser. No
// PowerShell, no browser, no window is read.
//
// Run:  node scripts/dev/lesson-read-check.mjs     every fixture; exits 1 on a failure
//
// Each result must hold only the five lesson fields, and never a name a fixture marks PRIVATE.
//
// The TypeScript sources load through Node's type stripping; the resolve hook maps `@shared/…`
// and extensionless relative imports to their `.ts` files.

import { readdirSync, readFileSync } from 'node:fs'
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
    return r.url.endsWith('.ts') ? { ...r, format: 'module-typescript' } : r
  }
})

const { nodesFromRecord, parseLessonRead, readAgain } = await import(pathToFileURL(resolve(root, 'src/main/media/lesson-read.ts')).href)

const FIXTURES = resolve(root, 'scripts/dev/fixtures/lesson-read')
const FIELDS = ['heading', 'course', 'breadcrumb', 'section', 'item']
const SITES = new Set(['circle', 'hubla', 'generic'])

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

function eq(a, b, what) {
  check(JSON.stringify(a) === JSON.stringify(b), `${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`)
}

function group(name, fn) {
  current = name
  const before = failures
  fn()
  console.log(`${failures === before ? 'ok  ' : 'FAIL'} ${name}`)
}

const files = readdirSync(FIXTURES)
  .filter((f) => f.endsWith('.json'))
  .sort()

group('fixtures exist for every site', () => {
  for (const site of SITES) check(files.some((f) => f.startsWith(`${site}-`)), `a ${site}-*.json fixture`)
})

for (const f of files) {
  group(f, () => {
    const fx = JSON.parse(readFileSync(resolve(FIXTURES, f), 'utf8'))
    check(SITES.has(fx.site) && f.startsWith(`${fx.site}-`), 'the file name starts with its site')
    const nodes = nodesFromRecord(fx.nodes)
    check(Array.isArray(nodes) && nodes.length === fx.nodes.length, 'every node parses')
    const got = parseLessonRead(fx.site, nodes)
    eq(got, fx.expect, 'the lesson fields')
    if (got) eq(Object.keys(got), FIELDS, 'only the five fields, in order')
    check(!JSON.stringify(got).includes('PRIVATE'), 'nothing else from the page')
  })
}

group('the reader record: malformed nodes are skipped, no page is null', () => {
  eq(nodesFromRecord(null), null, 'no Document in the window')
  const nodes = nodesFromRecord([[1, 'Text', '  two   spaces '], [1, 'Image', 'x'], ['1', 'Text', 'y'], [-1, 'Text', 'z'], [2, 'Button'], 'junk'])
  eq(nodes, [{ depth: 1, type: 'Text', name: 'two spaces' }], 'only well-formed nodes of the four types, whitespace collapsed')
  eq(parseLessonRead('circle', []), null, 'an empty page')
})

group('the second read: only when the page may still be building (review R2 #12)', () => {
  const filler = (n) => Array.from({ length: n }, (_, i) => [4, 'Text', `Filler ${i}`])
  const circle = JSON.parse(readFileSync(resolve(FIXTURES, 'circle-lesson.json'), 'utf8'))
  const full = nodesFromRecord([...circle.nodes, ...filler(40)])
  eq(readAgain(full, parseLessonRead('circle', full)), false, 'a heading on a page of many nodes: final')
  const topBarOnly = nodesFromRecord([[3, 'Button', 'aula anterior'], [3, 'Text', 'Example Course'], [3, 'Button', 'Próximo aula'], ...filler(60)])
  const partial = parseLessonRead('circle', topBarOnly)
  check(partial !== null && partial.heading === null, 'the fixture: a course name, no heading')
  eq(readAgain(topBarOnly, partial), true, 'a partial read without a heading: read again')
  eq(readAgain(nodesFromRecord(filler(5)), null), true, 'a sparse page: read again')
  eq(readAgain(null, null), true, 'no page yet: read again')
  const big = nodesFromRecord(filler(500))
  eq(readAgain(big, parseLessonRead('generic', big)), false, 'a full page the parser knows nothing in: final, no second fetch')
  const small = nodesFromRecord([[3, 'Group', 'Video Player - Lesson']])
  eq(readAgain(small, parseLessonRead('generic', small)), true, 'a heading among very few nodes: read again')
})

group('a field is capped at 200 characters', () => {
  const long = 'x'.repeat(300)
  const got = parseLessonRead('generic', nodesFromRecord([[3, 'Group', `Video Player - ${long}`]]))
  eq(got?.heading?.length, 200, 'heading capped')
})

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
