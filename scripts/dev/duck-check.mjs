// SPDX-License-Identifier: Apache-2.0
// Dev-only check (Windows) for the desk helper's audio ops: `duck`, `unduck` and `levels` in
// resources/desk/desk.ps1, over its JSON-line protocol, as the notula-desk process speaks it.
//
//   node scripts/dev/duck-check.mjs
//
// Every duck is limited (`only`) to a player this script starts: a PowerShell looping a silent
// WAV, which gives it an audio session on the default output. Nothing is heard. Windows keeps
// an app's level between runs, so each player starts at full level and is set back to full
// before it closes; one player runs at a time, since they share PowerShell's session id.
// 1. Notula's own tree is skipped: a duck whose root is the player lowers nothing.
// 2. Duck lowers the player to 20 % of its level, and unduck brings it back.
// 3. A level the user moved during the dictation is left alone.
// 4. A helper killed mid-dictation: a new helper, given the entries a marker would hold, restores.
// 5. A helper whose stdin closes (Notula quit) raises what it holds before it exits.
// 6. An app that restarts while lowered: its new session is found by key and raised.

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'

if (process.platform !== 'win32') {
  console.log('duck-check: Windows only, skipped')
  process.exit(0)
}

const script = resolve(import.meta.dirname, '../../resources/desk/desk.ps1')
const dir = mkdtempSync(join(tmpdir(), 'notula-duck-check-'))
const wav = join(dir, 'silence.wav')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const children = []
let failed = 0

function check(name, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`)
  if (!ok) failed++
}
const near = (a, b, tol = 0.03) => Math.abs(a - b) <= tol

// One second of 16-bit mono silence at 8 kHz.
function writeSilence() {
  const data = Buffer.alloc(16_000)
  const h = Buffer.alloc(44)
  h.write('RIFF', 0)
  h.writeUInt32LE(36 + data.length, 4)
  h.write('WAVE', 8)
  h.write('fmt ', 12)
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20)
  h.writeUInt16LE(1, 22)
  h.writeUInt32LE(8_000, 24)
  h.writeUInt32LE(16_000, 28)
  h.writeUInt16LE(2, 32)
  h.writeUInt16LE(16, 34)
  h.write('data', 36)
  h.writeUInt32LE(data.length, 40)
  writeFileSync(wav, Buffer.concat([h, data]))
}

async function player() {
  const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(New-Object System.Media.SoundPlayer '${wav}').PlayLooping(); Start-Sleep 120`], {
    windowsHide: true,
    stdio: 'ignore'
  })
  children.push(p)
  await sleep(1_500)
  return p
}

function helper() {
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-OwnerPid', String(process.pid)], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe']
  })
  children.push(child)
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (t) => (stderr += t))
  const waiting = new Map()
  let nextId = 1
  let onReady
  const ready = new Promise((r) => (onReady = r))
  createInterface({ input: child.stdout }).on('line', (line) => {
    let m
    try {
      m = JSON.parse(line)
    } catch {
      return
    }
    if (m.event === 'ready') return onReady()
    waiting.get(m.id)?.(m)
    waiting.delete(m.id)
  })
  const exited = new Promise((r) => child.on('exit', r))
  return {
    child,
    ready,
    exited,
    stderr: () => stderr,
    ask(op, args) {
      const id = nextId++
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`${op} timed out; stderr: ${stderr.slice(-400)}`)), 5_000)
        waiting.set(id, (m) => {
          clearTimeout(t)
          if (m.ok) resolve(m)
          else reject(new Error(`${op}: ${m.error}`))
        })
        child.stdin.write(`${JSON.stringify({ id, op, args })}\n`)
      })
    }
  }
}

async function levelOf(h, pid) {
  const r = await h.ask('levels', { pid })
  return r.levels.length ? r.levels[0] : null
}

async function setLevel(h, pid, level) {
  await h.ask('levels', { pid, set: level })
}

async function close(h, p) {
  await setLevel(h, p.pid, 1).catch(() => undefined)
  p.kill()
  await new Promise((r) => (p.exitCode === null ? p.on('exit', r) : r()))
  await sleep(300)
}

try {
  writeSilence()
  const a = helper()
  await a.ready
  check('helper ready', true)

  // 1 and 2
  const p1 = await player()
  const start = await levelOf(a, p1.pid)
  check('the player has a session', start !== null, `level ${start}`)
  if (start === null) throw new Error('no audio session for the player; is an output device active?')
  await setLevel(a, p1.pid, 1)
  const own = await a.ask('duck', { root: p1.pid, only: p1.pid })
  check("Notula's own tree is skipped", own.entries.length === 0)
  const d = await a.ask('duck', { root: 0, only: p1.pid })
  check('duck lowers one session', d.entries.length === 1, `entries ${d.entries.length}`)
  const e = d.entries[0]
  check('duck saves the level and sets 20 %', near(e.saved, 1) && near(e.set, 0.2), `saved ${e.saved} set ${e.set}`)
  check('the key names no app', /^[0-9a-f]{16}$/.test(e.key))
  await sleep(400)
  const low = await levelOf(a, p1.pid)
  check('faded down', near(low, 0.2), `level ${low}`)
  const u = await a.ask('unduck', { entries: d.entries })
  check('unduck raises one session on one device', u.sessions === 1 && u.devices === 1, `sessions ${u.sessions} devices ${u.devices}`)
  await sleep(500)
  check('faded back up', near(await levelOf(a, p1.pid), 1))
  await close(a, p1)

  // 3
  const p2 = await player()
  await setLevel(a, p2.pid, 1)
  const d2 = await a.ask('duck', { root: 0, only: p2.pid })
  await sleep(400)
  await setLevel(a, p2.pid, 0.5)
  await a.ask('unduck', { entries: d2.entries })
  await sleep(500)
  check('a level the user moved is left alone', near(await levelOf(a, p2.pid), 0.5))
  await close(a, p2)

  // 4
  const p3 = await player()
  await setLevel(a, p3.pid, 1)
  const c = helper()
  await c.ready
  const dc = await c.ask('duck', { root: 0, only: p3.pid })
  await sleep(400)
  c.child.kill()
  await c.exited
  check('a killed helper leaves the level lowered', near(await levelOf(a, p3.pid), 0.2))
  const uc = await a.ask('unduck', { entries: dc.entries })
  check('a new helper restores from the entries', uc.sessions === 1, `sessions ${uc.sessions}`)
  await sleep(500)
  check('restored after the crash', near(await levelOf(a, p3.pid), 1))
  await close(a, p3)

  // 5
  const p4 = await player()
  await setLevel(a, p4.pid, 1)
  const q = helper()
  await q.ready
  await q.ask('duck', { root: 0, only: p4.pid })
  await sleep(400)
  q.child.stdin.end()
  await q.exited
  const lq = await levelOf(a, p4.pid)
  check('a helper raises what it holds as it exits', near(lq, 1), `level ${lq}`)
  await close(a, p4)

  // 6
  const p5 = await player()
  await setLevel(a, p5.pid, 1)
  await a.ask('duck', { root: 0, only: p5.pid })
  await sleep(400)
  p5.kill()
  await sleep(800)
  const p6 = await player()
  const reborn = await levelOf(a, p6.pid)
  const u6 = await a.ask('unduck', {})
  await sleep(500)
  check('a restarted app is raised', near(await levelOf(a, p6.pid), 1), `came back at ${reborn}, sessions ${u6.sessions}`)
  await close(a, p6)

  a.child.stdin.end()
  await a.exited
} catch (err) {
  check('run', false, err instanceof Error ? err.message : String(err))
} finally {
  for (const ch of children) if (ch.exitCode === null) ch.kill()
  await sleep(300)
  rmSync(dir, { recursive: true, force: true })
}

console.log(failed ? `duck-check: ${failed} failed` : 'duck-check: all passed')
process.exit(failed ? 1 : 0)
