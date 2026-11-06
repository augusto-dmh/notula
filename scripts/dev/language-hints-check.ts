// SPDX-License-Identifier: Apache-2.0
// Dev-only check for the language hints' source (hintSource in src/main/transcription/languages.ts)
// and the saved list's shape (normalizeLanguageList in src/shared/types/languages.ts). Pure: no
// settings store, no provider, no network.
// Run: node scripts/dev/language-hints-check.ts   (Node's type stripping; exits 1 on a failure)

import { registerHooks } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

// The app's `@shared/…` alias, resolved the way the build does.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('@shared/')) {
      return next(pathToFileURL(resolve(root, 'src/shared', `${specifier.slice('@shared/'.length)}.ts`)).href, context)
    }
    return next(specifier, context)
  }
})

const { hintSource } = await import('../../src/main/transcription/languages.ts')
const { MULTI_LANGUAGE_SETS, normalizeLanguageList } = await import('../../src/shared/types/languages.ts')

const SET = MULTI_LANGUAGE_SETS['nova-3']
let failed = 0

function check(name: string, got: readonly string[] | null, want: readonly string[] | null): void {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`)
}

check("stored ['fr'] with OS pt-BR gives ['fr']", hintSource(['fr'], ['pt-BR'], SET), ['fr'])
check('stored [] gives none', hintSource([], ['pt-BR', 'en-US'], SET), [])
check("never saved with OS pt-BR, en-US gives ['pt', 'en']", hintSource(null, ['pt-BR', 'en-US'], SET), ['pt', 'en'])
check('a stored code outside the set is dropped', hintSource(['fr', 'nn', 'de'], [], SET), ['fr', 'de'])
check('stored order is kept', hintSource(['ja', 'de', 'fr'], [], SET), ['ja', 'de', 'fr'])

const twelve = ['de', 'en', 'es', 'fr', 'it', 'ja', 'ko', 'nl', 'pl', 'pt', 'ru', 'sv']
check('12 stored codes give at most 10', hintSource(twelve, [], SET), twelve.slice(0, 10))

check('a save drops duplicates and orders by name', normalizeLanguageList(['pt', 'EN', 'fr', 'pt']), ['en', 'fr', 'pt'])
check('a save keeps at most 10', normalizeLanguageList(twelve).length === 10 ? [] : null, [])
check('an emptied list stays a list', normalizeLanguageList([]), [])

if (failed) {
  console.log(`\n${failed} failed`)
  process.exit(1)
}
console.log('\nall passed')
