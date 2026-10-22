// SPDX-License-Identifier: Apache-2.0
// The native-messaging host's files and HKCU keys.
//
// - Files in `<userData>\ext-bridge\`: the manifest `app.notula.bridge.json`, the launcher
//   `notula-ext-host.cmd` (the Notula executable under ELECTRON_RUN_AS_NODE) and the relay script
//   `notula-ext-host.cjs`. Written only while `sources.extension.enabled` is on, rewritten when they
//   differ (a moved install heals itself), removed with the folder when it goes off.
// - Keys: the Chrome key and the Edge key, both HKCU, default value = the manifest's full path.
//   Brave on Windows reads the Chrome key, so there is no Brave key. Written and deleted with the
//   in-box `%SystemRoot%\System32\reg.exe` (an absolute path, never PATH). Never HKLM, never a parent
//   key: only the two `app.notula.bridge` keys are ever deleted.
// - Dev only: a registry root under `HKCU\Software\NotulaDevTest` instead of the real keys, and a
//   dry run that only logs the reg.exe calls (index.ts picks them from the environment).
// No Electron import: the dev checks load this file on its own.

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { EXT_BRIDGE } from '../../../shared/types/extension-protocol'

export type RegisteredBrowser = keyof typeof EXT_BRIDGE.registryKeys
export const REGISTERED_BROWSERS = Object.keys(EXT_BRIDGE.registryKeys) as RegisteredBrowser[]

/** Dev builds may point the keys here instead (created and deleted by the dev check). */
export const DEV_REGISTRY_ROOT = 'Software\\NotulaDevTest'
const REG_TIMEOUT_MS = 10_000

export interface HostInstall {
  /** `<userData>\ext-bridge`. */
  dir: string
  /** The executable the launcher runs (`process.execPath`). */
  exePath: string
  /** `chrome-extension://<id>/` values; never empty when writing. */
  origins: string[]
  launcher: string
  script: string
  /** '' for the real keys; else a root under DEV_REGISTRY_ROOT. */
  registryRoot: string
  /** Log the reg.exe calls instead of running them. */
  dryRun: boolean
  onCommand?: (args: string[]) => void
}

export interface HostCheck {
  files: boolean
  keys: Record<RegisteredBrowser, boolean>
}

const sha = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex')

export const manifestPath = (dir: string): string => join(dir, EXT_BRIDGE.manifestFile)

export function manifestText(origins: string[]): string {
  return (
    JSON.stringify(
      {
        name: EXT_BRIDGE.hostName,
        description: 'Notula browser extension bridge',
        // Relative to the manifest's folder (allowed on Windows).
        path: EXT_BRIDGE.launcherFile,
        type: 'stdio',
        allowed_origins: origins
      },
      null,
      2
    ) + '\n'
  )
}

/**
 * The launcher with the executable filled in, CRLF (cmd.exe). The path sits in quotes; `%` is
 * still expanded there in a batch file, so it is doubled. A replacer function keeps `$` literal.
 */
export function launcherText(template: string, exePath: string): string {
  return template.replace('__NOTULA_EXE__', () => exePath.replace(/%/g, '%%')).replace(/\r?\n/g, '\r\n')
}

function hostFiles(o: Pick<HostInstall, 'dir' | 'exePath' | 'origins' | 'launcher' | 'script'>): [string, string][] {
  return [
    [join(o.dir, EXT_BRIDGE.launcherFile), launcherText(o.launcher, o.exePath)],
    [join(o.dir, EXT_BRIDGE.scriptFile), o.script],
    [manifestPath(o.dir), manifestText(o.origins)]
  ]
}

function sameContent(file: string, text: string): boolean {
  try {
    return sha(readFileSync(file)) === sha(text)
  } catch {
    return false
  }
}

/** The full key under HKCU for one browser. */
export function registryKey(root: string, browser: RegisteredBrowser): string {
  const rel = EXT_BRIDGE.registryKeys[browser]
  return `HKCU\\${root ? `${root}\\` : ''}${rel}`
}

function checkRoot(root: string): void {
  if (root && !(root === DEV_REGISTRY_ROOT || root.startsWith(`${DEV_REGISTRY_ROOT}\\`))) throw new Error('registry-root-refused')
}

/** `<drive>:\Windows\System32\reg.exe`: the environment may pick the drive only. */
function regExe(): string {
  const root = process.env.SystemRoot ?? ''
  return join(/^[A-Za-z]:\\Windows$/i.test(root) ? root : 'C:\\Windows', 'System32', 'reg.exe')
}

function reg(o: Pick<HostInstall, 'dryRun' | 'onCommand'>, args: string[]): Promise<{ ok: boolean; stdout: string }> {
  o.onCommand?.(args)
  if (o.dryRun) return Promise.resolve({ ok: true, stdout: '' })
  return new Promise((resolve) => {
    execFile(regExe(), args, { timeout: REG_TIMEOUT_MS, windowsHide: true }, (err, stdout) => resolve({ ok: !err, stdout: String(stdout ?? '') }))
  })
}

async function keyValue(o: Pick<HostInstall, 'registryRoot'>, browser: RegisteredBrowser): Promise<string | null> {
  const r = await reg({ dryRun: false }, ['query', registryKey(o.registryRoot, browser), '/ve'])
  if (!r.ok) return null
  // `    (Default)    REG_SZ    C:\...\app.notula.bridge.json` (the name is localised).
  const m = /REG_SZ\s+(.+?)\s*$/m.exec(r.stdout)
  return m?.[1] ?? null
}

/** Does either key still name this folder's manifest (the folder went before the switch did)? */
export async function keysNameHost(o: Pick<HostInstall, 'dir' | 'registryRoot'>): Promise<boolean> {
  checkRoot(o.registryRoot)
  const want = manifestPath(o.dir).toLowerCase()
  for (const b of REGISTERED_BROWSERS) if ((await keyValue(o, b))?.toLowerCase() === want) return true
  return false
}

/** Are the files current and do both keys point at the manifest? */
export async function checkHost(o: HostInstall): Promise<HostCheck> {
  checkRoot(o.registryRoot)
  const files = hostFiles(o).every(([file, text]) => sameContent(file, text))
  const keys = {} as Record<RegisteredBrowser, boolean>
  const want = manifestPath(o.dir).toLowerCase()
  for (const b of REGISTERED_BROWSERS) {
    keys[b] = o.dryRun ? true : (await keyValue(o, b))?.toLowerCase() === want
  }
  return { files, keys }
}

/** Writes the files that differ and both keys. Throws `host-install-failed:<step>` on failure. */
export async function installHost(o: HostInstall): Promise<{ filesWritten: number; keysWritten: number }> {
  checkRoot(o.registryRoot)
  if (o.origins.length === 0) throw new Error('host-install-failed:no-origins')
  let filesWritten = 0
  try {
    mkdirSync(o.dir, { recursive: true })
    for (const [file, text] of hostFiles(o)) {
      if (sameContent(file, text)) continue
      writeFileSync(file, text)
      filesWritten++
    }
  } catch {
    throw new Error('host-install-failed:files')
  }
  let keysWritten = 0
  const target = manifestPath(o.dir)
  for (const b of REGISTERED_BROWSERS) {
    if (!o.dryRun && (await keyValue(o, b))?.toLowerCase() === target.toLowerCase()) continue
    const r = await reg(o, ['add', registryKey(o.registryRoot, b), '/ve', '/t', 'REG_SZ', '/d', target, '/f'])
    if (!r.ok) throw new Error(`host-install-failed:key-${b}`)
    keysWritten++
  }
  return { filesWritten, keysWritten }
}

/** Deletes both keys (only those two) and the folder. Missing pieces are fine. */
export async function removeHost(o: Pick<HostInstall, 'dir' | 'registryRoot' | 'dryRun' | 'onCommand'>): Promise<{ keysRemoved: number; filesRemoved: boolean }> {
  checkRoot(o.registryRoot)
  let keysRemoved = 0
  for (const b of REGISTERED_BROWSERS) {
    const r = await reg(o, ['delete', registryKey(o.registryRoot, b), '/f'])
    // A missing key fails the delete; that is the state we want.
    if (r.ok) keysRemoved++
  }
  let filesRemoved = true
  try {
    rmSync(o.dir, { recursive: true, force: true })
  } catch {
    filesRemoved = false
  }
  return { keysRemoved, filesRemoved }
}
