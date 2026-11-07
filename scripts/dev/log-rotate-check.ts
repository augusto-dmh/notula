// SPDX-License-Identifier: Apache-2.0
// Dev-only check for the log rotation step (src/main/log-rotate.ts), on temp folders
// under the OS temp dir: under the cap nothing moves; at the cap `app.log` becomes
// `app.1.log`; older files shift and the oldest drops; a target that cannot be replaced
// leaves `app.log` in place and reports failure without throwing.
// Run: node scripts/dev/log-rotate-check.ts   (Node's type stripping; exits 1 on a failure)

import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rotateIfFull, rotateLogFiles } from '../../src/main/log-rotate.ts'

const CAP = 1024
let failed = 0
const dirs: string[] = []

function fresh(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'notula-log-rotate-'))
  dirs.push(dir)
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text)
  return dir
}

function listing(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    out[e.name] = e.isFile() ? readFileSync(join(dir, e.name), 'utf8').slice(0, 12) : '[dir]'
  }
  return out
}

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` ${JSON.stringify(detail)}`}`)
}

const full = 'x'.repeat(CAP)

// Under the cap, nothing moves; a missing file is under it too.
{
  const dir = fresh({ 'app.log': 'current\n', 'app.1.log': 'older\n' })
  const r = rotateIfFull(dir, CAP)
  const l = listing(dir)
  check('under the cap: nothing moves', r === 'under' && Object.keys(l).join() === 'app.1.log,app.log' && l['app.log'] === 'current\n', { r, l })
  const empty = fresh({})
  check('no app.log: under', rotateIfFull(empty, CAP) === 'under' && readdirSync(empty).length === 0)
}

// At the cap, app.log becomes app.1.log; the caller then opens a new app.log.
{
  const dir = fresh({ 'app.log': full })
  const r = rotateIfFull(dir, CAP)
  writeFileSync(join(dir, 'app.log'), '', { flag: 'a' })
  const l = listing(dir)
  check('at the cap: app.log → app.1.log, new app.log', r === 'rotated' && l['app.1.log'] === full.slice(0, 12) && l['app.log'] === '', { r, l })
}

// With app.1…3 present, the oldest is dropped and the others shift.
{
  const dir = fresh({ 'app.log': 'current\n', 'app.1.log': 'one\n', 'app.2.log': 'two\n', 'app.3.log': 'three\n' })
  const r = rotateLogFiles(dir)
  const l = listing(dir)
  check(
    'shift: oldest dropped, others shift',
    r && Object.keys(l).join() === 'app.1.log,app.2.log,app.3.log' && l['app.1.log'] === 'current\n' && l['app.2.log'] === 'one\n' && l['app.3.log'] === 'two\n',
    { r, l }
  )
}

// A target that cannot be replaced (here a non-empty folder where the oldest file is):
// app.log and the other files stay where they are, and the step reports failure.
{
  const dir = fresh({ 'app.log': full, 'app.1.log': 'one\n', 'app.2.log': 'two\n' })
  mkdirSync(join(dir, 'app.3.log'))
  writeFileSync(join(dir, 'app.3.log', 'held'), 'held')
  let threw = false
  let r: string = ''
  try {
    r = rotateIfFull(dir, CAP)
  } catch {
    threw = true
  }
  const l = listing(dir)
  check('locked target: no throw, failure, app.log in place', !threw && r === 'failed' && l['app.log'] === full.slice(0, 12) && l['app.1.log'] === 'one\n' && l['app.2.log'] === 'two\n', { threw, r, l })
}

// The app.1 slot cannot be freed: app.log stays.
{
  const dir = fresh({ 'app.log': full })
  mkdirSync(join(dir, 'app.1.log'))
  writeFileSync(join(dir, 'app.1.log', 'held'), 'held')
  // keep = 1: the folder is the oldest and cannot be dropped.
  const r = rotateLogFiles(dir, 'app', 1)
  check('locked app.1 slot: app.log in place', !r && existsSync(join(dir, 'app.log')) && listing(dir)['app.log'] === full.slice(0, 12), listing(dir))
}

// A gap (app.2 missing): only app.1 shifts, into it, and app.3 is kept.
{
  const dir = fresh({ 'app.log': 'current\n', 'app.1.log': 'one\n', 'app.3.log': 'three\n' })
  const r = rotateLogFiles(dir)
  const l = listing(dir)
  check('gap: shifts into the free slot, keeps the rest', r && l['app.1.log'] === 'current\n' && l['app.2.log'] === 'one\n' && l['app.3.log'] === 'three\n' && !('app.log' in l), { r, l })
}

// As log.ts does it: rotate while the writer is open, end it, open a new one. Every line
// lands whole, in order, in exactly one file.
{
  const dir = fresh({})
  const lines = Array.from({ length: 200 }, (_, i) => `{"n":${i}}`)
  let w = createWriteStream(join(dir, 'app.log'), { flags: 'a' })
  await new Promise((r) => w.once('open', r))
  let bytes = 0
  let rotations = 0
  let rotateAt = CAP / 4
  const ends: Promise<void>[] = []
  for (const [i, line] of lines.entries()) {
    // Lines arrive over time, as in the app, so a new stream gets to create its file.
    if (i % 5 === 0) await new Promise((r) => setImmediate(r))
    w.write(line + '\n')
    bytes += Buffer.byteLength(line + '\n')
    if (bytes >= rotateAt) {
      // A failure (the new file not created yet) retries one cap later, as in log.ts.
      rotateAt = bytes + CAP / 4
      if (rotateLogFiles(dir)) {
        rotations++
        // Not awaited, as in log.ts: the old stream's pending writes follow the renamed file.
        const old = w
        ends.push(new Promise<void>((r) => old.end(r)))
        w = createWriteStream(join(dir, 'app.log'), { flags: 'a' })
        bytes = 0
        rotateAt = CAP / 4
      }
    }
  }
  ends.push(new Promise<void>((r) => w.end(r)))
  await Promise.all(ends)
  const files = ['app.3.log', 'app.2.log', 'app.1.log', 'app.log'].filter((f) => existsSync(join(dir, f)))
  const seen = files.flatMap((f) => readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean))
  const tail = lines.slice(lines.length - seen.length)
  check('open writer: whole lines, in order, nothing split', rotations > 3 && files.length === 4 && JSON.stringify(seen) === JSON.stringify(tail), { rotations, files, kept: seen.length })
}

for (const d of dirs) rmSync(d, { recursive: true, force: true })
if (failed) {
  console.log(`${failed} failed`)
  process.exit(1)
}
console.log('all passed')
