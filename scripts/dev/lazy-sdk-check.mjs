// SPDX-License-Identifier: Apache-2.0
// Dev-only check on the `npm run build` output (unminified): the MCP SDK, the Anthropic SDK
// and electron-updater must load at first use, never while main starts. The unminified
// bundle prints a top-level require as a statement at column 0
// (`let x = require("…")`); a deferred one sits indented inside its loader function.
// Run: npm run build && node scripts/dev/lazy-sdk-check.mjs   (exits 1 on a failure)

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// An optional argument points at another main output folder.
const OUT = process.argv[2] ?? join(import.meta.dirname, '..', '..', 'out', 'main')
const DEFERRED = /require\((["'])(@anthropic-ai\/sdk|@modelcontextprotocol\/sdk|electron-updater)(\/[^"']*)?\1\)/

const index = join(OUT, 'index.js')
if (!existsSync(index)) {
  console.log('FAIL out/main/index.js is missing: run `npm run build` first')
  process.exit(1)
}
const chunks = existsSync(join(OUT, 'chunks')) ? readdirSync(join(OUT, 'chunks')).filter((f) => f.endsWith('.js')).map((f) => join(OUT, 'chunks', f)) : []

let failed = 0
const deferred = new Map()
for (const file of [index, ...chunks]) {
  const lines = readFileSync(file, 'utf8').split('\n')
  if (lines.some((l) => l.length > 20_000)) {
    console.log(`FAIL ${file} looks minified: run the check on \`npm run build\` output, not a release build`)
    failed++
    continue
  }
  lines.forEach((line, i) => {
    const m = DEFERRED.exec(line)
    if (!m) return
    const name = m[2] + (m[3] ?? '')
    if (/^\S/.test(line)) {
      console.log(`FAIL top-level require of ${name} at ${file}:${i + 1}`)
      failed++
    } else {
      deferred.set(name, (deferred.get(name) ?? 0) + 1)
    }
  })
}
for (const [name, n] of [...deferred].sort()) console.log(`ok   ${name}: ${n} deferred require${n === 1 ? '' : 's'}`)
for (const pkg of ['@anthropic-ai/sdk', '@modelcontextprotocol/sdk', 'electron-updater']) {
  if (![...deferred.keys()].some((k) => k.startsWith(pkg))) console.log(`note ${pkg}: no require found in the main bundle`)
}
if (failed) {
  console.log(`${failed} failed`)
  process.exit(1)
}
console.log('all passed')
