// SPDX-License-Identifier: Apache-2.0
// The OS user verification behind the device lock.
//
// - macOS: Electron's Touch ID prompt with the reason text. No native module.
// - Windows: Windows Hello through `UserConsentVerifier`, run by a bundled PowerShell 5.1 helper
//   (`verifier.ps1`, written to <userData>/helpers and checked by SHA-256 before every run). One
//   run at a time, 60 s cap (treated as cancelled), killed at quit.
// - Dev only (unpackaged builds): `NOTULA_DEV_DEVICE_LOCK_STUB=1` replaces the OS with
//   `<userData>/device-lock-stub.json` ({ "availability": "<word>", "result": "<word>" }, read on
//   every call), so a test never opens a real Windows Hello or Touch ID prompt.

import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, systemPreferences } from 'electron'
import { DEVICE_LOCK_LIMITS, type DeviceLockFailure, type DeviceLockMethod, type DeviceLockUnavailable } from '@shared/types/device-lock'
import { log } from '../log'
import helperSource from './verifier.ps1?raw'

export type Availability = { method: DeviceLockMethod; unavailable: DeviceLockUnavailable | null }
export type Verification = { ok: true } | { ok: false; reason: DeviceLockFailure; osUnavailable: DeviceLockUnavailable | null }

const CHECK_TIMEOUT_MS = 15_000

/** Windows `UserConsentVerifierAvailability` words → Notula's reasons. */
const WIN_UNAVAILABLE: Record<string, DeviceLockUnavailable> = {
  DeviceNotPresent: 'device-not-present',
  NotConfiguredForUser: 'not-configured',
  DisabledByPolicy: 'disabled-by-policy',
  DeviceBusy: 'device-busy'
}

function stubEnabled(): boolean {
  return !app.isPackaged && process.env.NOTULA_DEV_DEVICE_LOCK_STUB === '1'
}

async function readStub(userDataPath: string): Promise<{ availability: string; result: string }> {
  try {
    const raw = JSON.parse(await readFile(join(userDataPath, 'device-lock-stub.json'), 'utf8')) as Record<string, unknown>
    return {
      availability: typeof raw['availability'] === 'string' ? raw['availability'] : 'Available',
      result: typeof raw['result'] === 'string' ? raw['result'] : 'Verified'
    }
  } catch {
    return { availability: 'Available', result: 'Verified' }
  }
}

export interface Verifier {
  availability(): Promise<Availability>
  verify(message: string): Promise<Verification>
  /** Kills a running helper (quit). */
  dispose(): void
}

export function createVerifier(userDataPath: string): Verifier {
  let child: ChildProcess | null = null
  const platformMethod: DeviceLockMethod =
    process.platform === 'win32' ? 'windows-hello' : process.platform === 'darwin' ? 'touch-id' : 'none'

  /** Writes the helper once and rewrites it whenever its bytes no longer match the bundled text. */
  async function helperPath(): Promise<string> {
    const sha = createHash('sha256').update(helperSource).digest('hex')
    const dir = join(userDataPath, 'helpers')
    const file = join(dir, `device-lock-${sha.slice(0, 8)}.ps1`)
    let current: string | null = null
    try {
      current = createHash('sha256').update(await readFile(file)).digest('hex')
    } catch {
      current = null
    }
    if (current !== sha) {
      await mkdir(dir, { recursive: true })
      await writeFile(file, helperSource, 'utf8')
    }
    return file
  }

  /** One helper run → its result word, or 'HelperFailed' / 'Timeout'. */
  async function runHelper(req: { op: 'check' } | { op: 'verify'; message: string }, timeoutMs: number): Promise<string> {
    if (child) return 'Busy'
    let file: string
    try {
      file = await helperPath()
    } catch (err) {
      log('warn', 'device-lock:helper-write-failed', { err })
      return 'HelperFailed'
    }
    return new Promise<string>((resolve) => {
      let out = ''
      let done = false
      const finish = (word: string): void => {
        if (done) return
        done = true
        clearTimeout(timer)
        child = null
        resolve(word)
      }
      let proc: ChildProcess
      try {
        proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], {
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'ignore']
        })
      } catch {
        finish('HelperFailed')
        return
      }
      child = proc
      const timer = setTimeout(() => {
        proc.kill()
        finish('Timeout')
      }, timeoutMs)
      proc.stdout?.setEncoding('utf8')
      proc.stdout?.on('data', (d: string) => {
        out += d
      })
      proc.on('error', () => finish('HelperFailed'))
      proc.on('close', () => {
        try {
          const line = out.split(/\r?\n/).find((l) => l.trim().startsWith('{'))
          const word = (JSON.parse(line ?? '') as { result?: unknown }).result
          finish(typeof word === 'string' ? word : 'HelperFailed')
        } catch {
          finish('HelperFailed')
        }
      })
      proc.stdin?.end(`${JSON.stringify(req)}\n`)
    })
  }

  function fromWord(word: string): Verification {
    if (word === 'Verified') return { ok: true }
    if (word === 'Canceled' || word === 'Timeout') return { ok: false, reason: word === 'Timeout' ? 'timeout' : 'canceled', osUnavailable: null }
    if (word === 'RetriesExhausted') return { ok: false, reason: 'retries-exhausted', osUnavailable: null }
    if (word === 'Busy' || word === 'DeviceBusy') return { ok: false, reason: 'busy', osUnavailable: null }
    const os = WIN_UNAVAILABLE[word]
    if (os) return { ok: false, reason: 'unavailable', osUnavailable: os }
    return { ok: false, reason: 'unavailable', osUnavailable: null }
  }

  return {
    async availability() {
      if (stubEnabled()) {
        const word = (await readStub(userDataPath)).availability
        return { method: 'windows-hello', unavailable: word === 'Available' ? null : (WIN_UNAVAILABLE[word] ?? 'helper-failed') }
      }
      if (platformMethod === 'touch-id') {
        return { method: 'touch-id', unavailable: systemPreferences.canPromptTouchID() ? null : 'no-touch-id' }
      }
      if (platformMethod === 'none') return { method: 'none', unavailable: 'unsupported-platform' }
      const word = await runHelper({ op: 'check' }, CHECK_TIMEOUT_MS)
      if (word === 'Available') return { method: 'windows-hello', unavailable: null }
      return { method: 'windows-hello', unavailable: WIN_UNAVAILABLE[word] ?? 'helper-failed' }
    },

    async verify(message) {
      if (stubEnabled()) return fromWord((await readStub(userDataPath)).result)
      if (platformMethod === 'touch-id') {
        if (!systemPreferences.canPromptTouchID()) return { ok: false, reason: 'unavailable', osUnavailable: 'no-touch-id' }
        try {
          await systemPreferences.promptTouchID(message)
          return { ok: true }
        } catch {
          return { ok: false, reason: 'canceled', osUnavailable: null }
        }
      }
      if (platformMethod === 'none') return { ok: false, reason: 'unavailable', osUnavailable: 'unsupported-platform' }
      return fromWord(await runHelper({ op: 'verify', message }, DEVICE_LOCK_LIMITS.helperTimeoutMs))
    },

    dispose() {
      child?.kill()
      child = null
    }
  }
}
