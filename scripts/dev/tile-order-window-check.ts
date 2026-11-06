// SPDX-License-Identifier: Apache-2.0
// Dev-only check for Zoom's tile-order version window: runs the comparison block of
// resources/uia/attribution.ps1 (between its `>>> tile-order window` and `<<< tile-order window`
// lines) in a hidden Windows PowerShell, with no meeting app and no UI Automation, and checks the
// bundled resources/uia/zoom-tile-order.json is well formed.
// Run: node scripts/dev/tile-order-window-check.ts   (Node's type stripping; exits 1 on a failure)

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const script = readFileSync(resolve(root, 'resources/uia/attribution.ps1'), 'utf8')
const block = /^# >>> tile-order window.*$([\s\S]*?)^# <<< tile-order window$/m.exec(script)?.[1]
if (!block) {
  console.log('FAIL the tile-order window block is missing from attribution.ps1')
  process.exit(1)
}

interface Case {
  name: string
  version: string
  window: { min: string; max: string | null } | null
  trusted: boolean
}

const OPEN = { min: '7.2.0', max: null }
const CASES: Case[] = [
  { name: '7.1.9 is refused', version: '7.1.9', window: OPEN, trusted: false },
  { name: '7.2.0 is trusted', version: '7.2.0', window: OPEN, trusted: true },
  { name: '7.10.3 is trusted (numeric, not text)', version: '7.10.3', window: OPEN, trusted: true },
  { name: 'a build suffix is ignored', version: '7.3.1 (60123)', window: OPEN, trusted: true },
  { name: 'an empty version is refused', version: '', window: OPEN, trusted: false },
  { name: 'an unparsable version is refused', version: 'unknown', window: OPEN, trusted: false },
  { name: 'max 7.4 refuses 7.5.0', version: '7.5.0', window: { min: '7.2.0', max: '7.4' }, trusted: false },
  { name: 'max 7.4 trusts 7.4.0', version: '7.4.0', window: { min: '7.2.0', max: '7.4' }, trusted: true },
  { name: 'no window trusts nothing', version: '7.3.0', window: null, trusted: false }
]

const ps = [
  block,
  ...CASES.map((c) => {
    const w = c.window ? `([pscustomobject]@{ min = '${c.window.min}'; max = ${c.window.max === null ? '$null' : `'${c.window.max}'`} })` : '$null'
    return `if (In-TileOrderWindow '${c.version}' ${w}) { 'true' } else { 'false' }`
  })
].join('\n')

// Run as a script file, as the reader runs.
const dir = mkdtempSync(join(tmpdir(), 'notula-tile-order-'))
let out: string[]
try {
  const file = join(dir, 'check.ps1')
  writeFileSync(file, ps, 'utf8')
  out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], {
    encoding: 'utf8',
    windowsHide: true
  })
    .trim()
    .split(/\r?\n/)
    .map((l) => l.trim())
} finally {
  rmSync(dir, { recursive: true, force: true })
}

let failed = 0
CASES.forEach((c, i) => {
  const got = out[i] === 'true'
  const ok = out[i] !== undefined && got === c.trusted
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${c.name}${ok ? '' : `: got ${out[i] ?? 'nothing'}`}`)
})

const data: unknown = JSON.parse(readFileSync(resolve(root, 'resources/uia/zoom-tile-order.json'), 'utf8'))
const wellFormed = JSON.stringify(data) === JSON.stringify({ min: '7.2.0', max: null })
if (!wellFormed) failed++
console.log(`${wellFormed ? 'ok  ' : 'FAIL'} zoom-tile-order.json holds { min: "7.2.0", max: null }`)

if (failed) {
  console.log(`\n${failed} failed`)
  process.exit(1)
}
console.log('\nall passed')
