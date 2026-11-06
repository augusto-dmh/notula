// SPDX-License-Identifier: Apache-2.0
// Dev-only check (Windows) for meeting detection's change notification: runs the notula-micmon
// PowerShell script (src/main/meetings/micmon-script.ts) against a scratch key it creates under
// HKCU\Software\Notula\dev-checks and deletes afterwards. It never reads the real consent store.
// Run: node scripts/dev/micmon-notify-check.ts   (Node's type stripping; exits 1 on a failure)
//
// 1. A LastUsedTimeStart / LastUsedTimeStop pair marking an entry in use: one `apps` line within 1 s.
// 2. Stopping it: one more `apps` line within 1 s.
// 3. 10 s with no writes: no `apps` line and no scan (the safety rescan is 60 s away).

import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createInterface } from 'node:readline'
import { micmonWindowsScript } from '../../src/main/meetings/micmon-script.ts'

if (process.platform !== 'win32') {
  console.log('micmon-notify-check: Windows only, skipped')
  process.exit(0)
}

const PARENT = 'Software\\Notula\\dev-checks'
const KEY = `${PARENT}\\micmon-${randomBytes(4).toString('hex')}`
const ENTRY = 'example.synthetic-app_0000000000000'

type Line = { at: number; t: string; ids?: string[]; why?: string; event?: string }
const lines: Line[] = []
let failures = 0

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`  ok    ${name}`)
  else {
    failures++
    console.log(`  FAIL  ${name}${detail ? `: ${detail}` : ''}`)
  }
}

function reg(args: string[]): boolean {
  return spawnSync('reg.exe', args, { stdio: 'ignore', windowsHide: true }).status === 0
}

const exists = (key: string): boolean => reg(['query', `HKCU\\${key}`])

function setQword(name: string, value: string): void {
  if (!reg(['add', `HKCU\\${KEY}\\${ENTRY}`, '/v', name, '/t', 'REG_QWORD', '/d', value, '/f'])) throw new Error(`reg add ${name} failed`)
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function waitFor(pred: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (pred()) return true
    await sleep(20)
  }
  return pred()
}

const apps = (since: number): Line[] => lines.filter((l) => l.t === 'apps' && l.at >= since)
const scans = (since: number): Line[] => lines.filter((l) => l.t === 'scan' && l.at >= since)

// Parents this run creates are removed with the key; ones that were there stay.
const hadNotula = exists('Software\\Notula')
const hadParent = exists(PARENT)

async function main(): Promise<void> {
  if (!reg(['add', `HKCU\\${KEY}`, '/f'])) throw new Error('could not create the scratch key')
  const script = micmonWindowsScript({ ownerPid: process.pid, keyPath: KEY, debug: true })
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  console.log(`micmon-notify-check: scratch key HKCU\\${KEY} (encoded script ${encoded.length} chars)`)
  const t0 = Date.now()
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true })
  child.stderr.on('data', () => undefined)
  createInterface({ input: child.stdout }).on('line', (l) => {
    try {
      const m = JSON.parse(l) as Omit<Line, 'at'>
      lines.push({ ...m, at: Date.now() })
    } catch {
      /* not a protocol line */
    }
  })
  try {
    const up = await waitFor(() => apps(0).length > 0, 20_000)
    check('starts and reports the empty list', up && JSON.stringify(apps(0)[0]?.ids) === '[]', up ? '' : 'no first apps line in 20 s')
    if (!up) return
    console.log(`        ready after ${Date.now() - t0} ms`)
    check('notification armed (no notify-unavailable line)', !lines.some((l) => l.t === 'log'))

    // 1. In use: the system writes the start value, then the stop value.
    await sleep(300)
    let since = Date.now()
    setQword('LastUsedTimeStart', '133000000000000000')
    setQword('LastUsedTimeStop', '0')
    let got = await waitFor(() => apps(since).length > 0, 1_000)
    let ms = got ? (apps(since)[0] as Line).at - since : -1
    check('an in-use pair produces an apps line within 1 s', got && JSON.stringify(apps(since)[0]?.ids) === `["p:${ENTRY}"]`, got ? `${JSON.stringify(apps(since)[0]?.ids)}` : 'none')
    if (got) console.log(`        ${ms} ms after the first write`)
    await sleep(700)
    check('one apps line for the pair', apps(since).length === 1, `${apps(since).length} lines`)

    // 2. Stopped.
    since = Date.now()
    setQword('LastUsedTimeStop', '133000000100000000')
    console.log(`        reg.exe took ${Date.now() - since} ms`)
    got = await waitFor(() => apps(since).length > 0, 1_000)
    ms = got ? (apps(since)[0] as Line).at - since : -1
    check('stopping produces another apps line within 1 s', got && JSON.stringify(apps(since)[0]?.ids) === '[]', got ? '' : 'none')
    if (got) console.log(`        ${ms} ms after the write; scan line at ${(scans(since)[0]?.at ?? 0) - since} ms`)
    await sleep(700)
    check('one apps line for the stop', apps(since).length === 1, `${apps(since).length} lines`)

    // 3. Quiet.
    since = Date.now()
    await sleep(10_000)
    check('10 s quiet: no apps line', apps(since).length === 0, `${apps(since).length} lines`)
    check('10 s quiet: no scan', scans(since).length === 0, `${scans(since).length} scans`)
  } finally {
    child.kill()
  }
}

try {
  await main()
} catch (err) {
  failures++
  console.log(`  FAIL  ${err instanceof Error ? err.message : String(err)}`)
} finally {
  reg(['delete', `HKCU\\${KEY}`, '/f'])
  if (!hadParent) reg(['delete', `HKCU\\${PARENT}`, '/f'])
  if (!hadNotula) reg(['delete', 'HKCU\\Software\\Notula', '/f'])
  check('scratch key removed', !exists(KEY))
}

console.log(failures ? `micmon-notify-check: ${failures} failure(s)` : 'micmon-notify-check: all passed')
process.exit(failures ? 1 : 0)
