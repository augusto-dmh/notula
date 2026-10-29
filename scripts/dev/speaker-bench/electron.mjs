// SPDX-License-Identifier: Apache-2.0
// Starts the built app (`npm run build` first) on a scratch profile with the replay feed and a
// plan, in the tray only (no window), and waits for it to quit. The profile's `models` folder
// can be a junction to a shared models folder, so downloads happen once.

import { spawn } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, openSync, closeSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from './manifest.mjs'

const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')

export function assertBuilt() {
  if (!existsSync(join(ROOT, 'out', 'main', 'index.js'))) throw new Error('No built app: run `npm run build` first.')
  if (!existsSync(ELECTRON)) throw new Error('Electron is not installed (npm install).')
}

/** `<profile>/models` → `modelsDir` (a junction on Windows), created once. */
export function linkModels(profile, modelsDir) {
  if (!modelsDir) return
  mkdirSync(profile, { recursive: true })
  mkdirSync(modelsDir, { recursive: true })
  const link = join(profile, 'models')
  if (existsSync(link)) {
    if (!lstatSync(link).isSymbolicLink()) throw new Error(`${link} exists and is not a link to the shared models folder`)
    return
  }
  symlinkSync(modelsDir, link, process.platform === 'win32' ? 'junction' : 'dir')
}

/**
 * Runs one plan. Resolves with the results the feed wrote. `interactive`: a normal window and no
 * feed (setup and labelling in the app's own UI); it resolves when you quit the app.
 */
export async function runApp({ profile, plan, planPath, logPath, timeoutMs = 6 * 3_600_000, interactive = false, extraEnv = {} }) {
  assertBuilt()
  mkdirSync(profile, { recursive: true })
  const env = { ...process.env, ...extraEnv, NOTULA_USER_DATA_DIR: profile }
  delete env.ELECTRON_RUN_AS_NODE
  if (!interactive) {
    writeFileSync(planPath, JSON.stringify(plan, null, 1))
    env.NOTULA_DEV_SPEAKER_BENCH = '1'
    env.NOTULA_DEV_SPEAKER_BENCH_PLAN = planPath
  } else {
    delete env.NOTULA_DEV_SPEAKER_BENCH
  }
  const fd = openSync(logPath, 'a')
  const args = interactive ? [ROOT] : [ROOT, '--notula-task=background']
  const child = spawn(ELECTRON, args, { cwd: ROOT, env, stdio: ['ignore', fd, fd], windowsHide: !interactive })
  const code = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill()
      resolve('timeout')
    }, timeoutMs)
    child.once('exit', (c) => {
      clearTimeout(timer)
      resolve(c)
    })
  })
  closeSync(fd)
  if (interactive) return null
  if (!existsSync(plan.resultsPath)) throw new Error(`the app exited (${code}) without results; see ${logPath}`)
  const results = JSON.parse(readFileSync(plan.resultsPath, 'utf8'))
  if (code !== 0) results.errors.push(`the app exited with ${code}`)
  return results
}
