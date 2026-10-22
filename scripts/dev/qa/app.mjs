// SPDX-License-Identifier: Apache-2.0
// Dev-only QA driver: starts and stops a built Notula (`npm run build` first) on a throwaway
// profile under %TEMP%\notula-qa, and a throwaway muted Chrome for media.
//
//   node scripts/dev/qa/app.mjs start [--profile <name>] [--env K=V]…   Notula with CDP + inspector
//   node scripts/dev/qa/app.mjs stop                                    quit it (window close, then kill)
//   node scripts/dev/qa/app.mjs chrome <url>…                           a muted Chrome on its own profile
//   node scripts/dev/qa/app.mjs chrome-stop                             only that Chrome
//   node scripts/dev/qa/app.mjs status
//
// Never points at %APPDATA%\Notula, Notula-dev or a real browser profile. Processes are found by
// their --user-data-dir / NOTULA_USER_DATA_DIR paths under %TEMP%\notula-qa only.

import { spawn, execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync, openSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { QA_ROOT, STATE_FILE, listTargets } from './cdp.mjs'

const ROOT = resolve(import.meta.dirname, '..', '..', '..')
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
export const CHROME_PROFILE = join(QA_ROOT, 'chrome-profile')
const RDP_PORT = 9333
const INSPECT_PORT = 9334
/** The throwaway Chrome's own DevTools port: `cdp.mjs … --chrome` drives its pages. */
export const CHROME_RDP_PORT = 9335

function state() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'))
  } catch {
    return {}
  }
}

function save(s) {
  mkdirSync(QA_ROOT, { recursive: true })
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2))
}

/** Process ids whose command line contains `needle` (by name). */
function pidsMatching(name, needle) {
  const ps = `Get-CimInstance Win32_Process -Filter "name='${name}'" | Where-Object { $_.CommandLine -like '*${needle.replace(/'/g, "''")}*' } | ForEach-Object { $_.ProcessId }`
  const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8' })
  return out
    .split(/\s+/)
    .filter(Boolean)
    .map(Number)
}

async function waitFor(fn, ms, what) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    try {
      const v = await fn()
      if (v) return v
    } catch {}
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error(`timed out waiting for ${what}`)
}

async function start(args) {
  let profile = 'profile'
  const env = { ...process.env }
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--profile') profile = args[++i]
    else if (args[i] === '--env') {
      const [k, ...v] = args[++i].split('=')
      env[k] = v.join('=')
    }
  }
  const userData = join(QA_ROOT, profile)
  if (!userData.startsWith(QA_ROOT)) throw new Error('profile must stay under the QA root')
  mkdirSync(userData, { recursive: true })
  env.NOTULA_USER_DATA_DIR = userData
  delete env.ELECTRON_RUN_AS_NODE
  const log = openSync(join(QA_ROOT, `${profile}-stdout.log`), 'a')
  const child = spawn(ELECTRON, [ROOT, `--remote-debugging-port=${RDP_PORT}`, `--inspect=${INSPECT_PORT}`], {
    cwd: ROOT,
    env,
    detached: true,
    stdio: ['ignore', log, log],
    windowsHide: false
  })
  child.unref()
  save({ ...state(), pid: child.pid, userData, profile, rdpPort: RDP_PORT, inspectPort: INSPECT_PORT })
  await waitFor(async () => (await listTargets(RDP_PORT)).some((t) => t.type === 'page' && t.url.includes('index.html')), 30_000, 'the main window')
  console.log(JSON.stringify({ pid: child.pid, userData }))
}

async function stop() {
  const s = state()
  if (!s.userData) return console.log('not running')
  // A soft quit first: the main process's own app.quit().
  try {
    const { mainProcess } = await import('./cdp.mjs')
    const c = await mainProcess()
    await c.evaluate(`process.mainModule.require('electron').app.quit()`, { commandLine: true }).catch(() => undefined)
    c.close()
  } catch {}
  // Electron's processes carry this worktree's path (the app path) on their command lines.
  const gone = await waitFor(() => pidsMatching('electron.exe', ROOT).length === 0, 20_000, 'quit').catch(() => false)
  if (!gone && s.pid) {
    try {
      execFileSync('taskkill', ['/T', '/F', '/PID', String(s.pid)], { stdio: 'ignore' })
    } catch {}
  }
  console.log(JSON.stringify({ stopped: true, left: pidsMatching('electron.exe', ROOT) }))
}

function chrome(urls) {
  mkdirSync(CHROME_PROFILE, { recursive: true })
  const child = spawn(
    CHROME,
    [
      `--user-data-dir=${CHROME_PROFILE}`,
      '--mute-audio',
      '--autoplay-policy=no-user-gesture-required',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-sync',
      `--remote-debugging-port=${CHROME_RDP_PORT}`,
      ...urls
    ],
    { detached: true, stdio: 'ignore' }
  )
  child.unref()
  console.log(JSON.stringify({ chrome: child.pid, profile: CHROME_PROFILE }))
}

function chromeStop() {
  const pids = pidsMatching('chrome.exe', CHROME_PROFILE)
  for (const pid of pids) {
    try {
      process.kill(pid)
    } catch {}
  }
  console.log(JSON.stringify({ killed: pids.length }))
}

const [cmd, ...rest] = process.argv.slice(2)
const run = {
  start: () => start(rest),
  stop,
  chrome: () => chrome(rest),
  'chrome-stop': chromeStop,
  status: () =>
    console.log(
      JSON.stringify({
        ...state(),
        electron: pidsMatching('electron.exe', ROOT),
        chrome: pidsMatching('chrome.exe', CHROME_PROFILE)
      })
    )
}[cmd]
if (!run) {
  console.error('usage: app.mjs start|stop|chrome|chrome-stop|status')
  process.exit(2)
}
Promise.resolve(run()).catch((e) => {
  console.error(e.message)
  process.exit(1)
})
