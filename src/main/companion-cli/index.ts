// SPDX-License-Identifier: Apache-2.0
// registerCompanionCli(): the companion CLI and its agent skill, and their IPC.
//
// - The listener, the companion token and `companion.json` are the Local API's (local-api/index.ts).
//   This module writes the CLI and its launcher to `<userData>/local-api/cli/` at each listener
//   start (bundled text, SHA-256 checked before reuse), and the skill to
//   `<userData>/agent-skills/notula/SKILL.md`.
// - Installer: one junction (Windows) or directory symlink (macOS) named `notula` in each agent's
//   global skills folder, only on an explicit Install click and only where nothing exists yet.
//   Remove deletes only a link that resolves to Notula's skill folder. Nothing else in an agent's
//   folder is ever written or deleted.
// - Dev only (unpackaged): NOTULA_DEV_AGENT_HOME replaces the home folder (and %APPDATA% under it)
//   for the agents' folders, so test runs never touch the real ones.

import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { chmodSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmdirSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { app, ipcMain, shell } from 'electron'
import type { InvokeChannel, InvokeRes } from '@shared/ipc'
import { notulaError } from '@shared/errors'
import { COMPANION_AGENTS, COMPANION_LIMITS, type CompanionAgentId, type CompanionAgentState, type CompanionCliStatus } from '@shared/types/local-api'
import type { MainContext } from '../context'
import { LOCAL_API_LOCAL_ONLY_LINE, onLocalApiListenerStart } from '../local-api'
import { log } from '../log'
import cliSource from './cli/notula-cli.cjs?raw'
import cmdSource from './cli/notula.cmd?raw'
import shSource from './cli/notula.sh?raw'
import skillSource from './skill.md?raw'

const OFF = 'The companion CLI is off'
const DETAIL: Record<'undetected' | 'other-link' | 'broken-link' | 'folder', string> = {
  undetected: 'Not found on this computer.',
  'other-link': 'A different skill named notula is linked here.',
  'broken-link': 'A broken link named notula is here.',
  folder: 'A folder named notula is already here.'
}

const sha = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex')

/** Writes `text` unless the file already has exactly that content. */
function writeChecked(file: string, text: string, mode?: number): void {
  let current: string | null = null
  try {
    current = sha(readFileSync(file))
  } catch {
    current = null
  }
  if (current !== sha(text)) {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, text, mode === undefined ? undefined : { mode })
  }
  if (mode !== undefined && process.platform !== 'win32') chmodSync(file, mode)
}

function same(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

export function registerCompanionCli(ctx: MainContext): void {
  const isWin = process.platform === 'win32'
  const cliDir = join(ctx.userDataPath, 'local-api', 'cli')
  const scriptPath = join(cliDir, 'notula-cli.cjs')
  const launcherPath = join(cliDir, isWin ? 'notula.cmd' : 'notula')
  const skillDir = join(ctx.userDataPath, 'agent-skills', COMPANION_LIMITS.skillFolderName)
  const skillFile = join(skillDir, 'SKILL.md')

  const devHome = !app.isPackaged ? process.env.NOTULA_DEV_AGENT_HOME : undefined
  const home = devHome || homedir()
  const appData = devHome ? join(devHome, 'AppData', 'Roaming') : app.getPath('appData')

  let enabled = false
  let localOnly = false
  const detected = new Map<string, { at: number; found: boolean }>()

  // ---------- the CLI files and the skill ----------

  const launcherText = (): string => {
    const appArgs = app.isPackaged ? '' : app.getAppPath()
    // Dev runs keep their own profile and display when the CLI starts the app.
    const devEnv = app.isPackaged
      ? []
      : (['NOTULA_USER_DATA_DIR', 'NOTULA_DEV_DISPLAY'] as const).filter((k) => process.env[k]).map((k) => [k, process.env[k] as string] as const)
    // Replacer functions keep `$` in a path literal.
    if (isWin) {
      // `%` is expanded even inside quotes in a batch file, so it is doubled.
      const pct = (v: string): string => v.replace(/%/g, '%%')
      const lines = devEnv.map(([k, v]) => `set "${k}=${pct(v)}"`).join('\n')
      return cmdSource
        .replace('__NOTULA_EXE__', () => pct(process.execPath))
        .replace('__NOTULA_APP_ARGS__', () => pct(appArgs))
        .replace('__NOTULA_DEV_ENV__', () => lines)
        .replace(/\r?\n/g, '\r\n')
    }
    const q = (v: string): string => v.replace(/'/g, `'\\''`)
    const lines = devEnv.map(([k, v]) => `${k}='${q(v)}'; export ${k}`).join('\n')
    return shSource
      .replace('__NOTULA_EXE__', () => q(process.execPath))
      .replace('__NOTULA_APP_ARGS__', () => q(appArgs))
      .replace('__NOTULA_DEV_ENV__', () => lines)
  }

  const skillText = (): string => {
    // PowerShell call syntax on Windows, a single-quoted path on macOS.
    const command = isWin ? `& '${launcherPath.replace(/'/g, "''")}'` : `'${launcherPath.replace(/'/g, `'\\''`)}'`
    const alt = isWin ? `From a POSIX shell (Git Bash), run \`'${launcherPath.replace(/\\/g, '/')}'\` the same way.` : ''
    return skillSource.replace('__NOTULA_COMMAND__', () => command).replace('__NOTULA_ALT_COMMAND__', () => alt)
  }

  const writeCli = (): void => {
    writeChecked(scriptPath, cliSource, 0o644)
    writeChecked(launcherPath, launcherText(), 0o755)
  }

  const writeSkill = (): void => {
    writeChecked(skillFile, skillText(), 0o644)
  }

  onLocalApiListenerStart(() => {
    try {
      writeCli()
      writeSkill()
    } catch (err) {
      log('warn', 'companion-cli:write-failed', { err: err instanceof Error ? err.message : String(err) })
    }
  })

  // ---------- agents ----------

  const expand = (p: string): string => {
    const rest = p.replace(/^~[\\/]?|^%APPDATA%[\\/]?/, '')
    const base = p.startsWith('%APPDATA%') ? appData : home
    return join(base, ...rest.split('/'))
  }

  const commandFound = (command: string): Promise<boolean> => {
    const hit = detected.get(command)
    if (hit && Date.now() - hit.at < 30_000) return Promise.resolve(hit.found)
    return new Promise((resolve) => {
      execFile(isWin ? 'where' : 'which', [command], { timeout: COMPANION_LIMITS.detectTimeoutMs, windowsHide: true }, (err) => {
        const found = !err
        detected.set(command, { at: Date.now(), found })
        resolve(found)
      })
    })
  }

  const exists = (p: string): boolean => {
    try {
      statSync(p)
      return true
    } catch {
      return false
    }
  }

  const skillReal = (): string => {
    try {
      return realpathSync(skillDir)
    } catch {
      return skillDir
    }
  }

  /** The entry at an agent's install path: none, ours, or a conflict (never touched). */
  const entryState = (installPath: string): { state: 'none' | 'installed' | 'conflict'; detail: string | null } => {
    let st
    try {
      st = lstatSync(installPath)
    } catch {
      return { state: 'none', detail: null }
    }
    if (st.isSymbolicLink()) {
      let real: string
      try {
        real = realpathSync(installPath)
      } catch {
        return { state: 'conflict', detail: DETAIL['broken-link'] }
      }
      return same(real, skillReal()) ? { state: 'installed', detail: null } : { state: 'conflict', detail: DETAIL['other-link'] }
    }
    return { state: 'conflict', detail: DETAIL.folder }
  }

  const agentRows = async (): Promise<CompanionCliStatus['agents']> =>
    Promise.all(
      COMPANION_AGENTS.map(async (a) => {
        const skillsDir = expand(isWin ? a.skillsDir.win32 : a.skillsDir.default)
        const installPath = join(skillsDir, COMPANION_LIMITS.skillFolderName)
        const e = entryState(installPath)
        let state: CompanionAgentState
        let detail = e.detail
        if (e.state === 'none') {
          const present = exists(dirname(skillsDir)) || (await commandFound(a.command))
          state = present ? 'available' : 'undetected'
          detail = present ? null : DETAIL.undetected
        } else state = e.state
        return { id: a.id, label: a.label, installPath, state, detail }
      })
    )

  const status = async (): Promise<CompanionCliStatus> => ({
    enabled,
    blockedByLocalOnly: localOnly,
    cliPath: launcherPath,
    skillPath: skillFile,
    agents: await agentRows()
  })

  const requireOn = (): void => {
    if (!enabled) throw notulaError('invalid-input', OFF)
    if (localOnly) throw notulaError('invalid-input', LOCAL_API_LOCAL_ONLY_LINE)
  }

  const agentOf = (id: unknown): (typeof COMPANION_AGENTS)[number] => {
    const a = COMPANION_AGENTS.find((x) => x.id === (id as CompanionAgentId))
    if (!a) throw notulaError('invalid-input', 'Unknown agent')
    return a
  }

  // ---------- settings ----------

  void app.whenReady().then(async () => {
    try {
      const s = await ctx.settings.getAll()
      enabled = s['companionCli.enabled']
      localOnly = s['privacy.localOnly']
    } catch {
      // Defaults stay off.
    }
  })
  ctx.bus.on('settings:changed', (e) => {
    enabled = e.settings['companionCli.enabled']
    localOnly = e.settings['privacy.localOnly']
  })

  // ---------- IPC ----------

  ipcMain.handle('companion-cli:get-status' satisfies InvokeChannel, async (): Promise<InvokeRes<'companion-cli:get-status'>> => {
    if (!enabled) throw notulaError('invalid-input', OFF)
    return status()
  })

  ipcMain.handle('companion-cli:install' satisfies InvokeChannel, async (_e, p: { agentId: CompanionAgentId }): Promise<InvokeRes<'companion-cli:install'>> => {
    requireOn()
    const a = agentOf(p?.agentId)
    writeCli()
    writeSkill()
    const skillsDir = expand(isWin ? a.skillsDir.win32 : a.skillsDir.default)
    const installPath = join(skillsDir, COMPANION_LIMITS.skillFolderName)
    const e = entryState(installPath)
    if (e.state === 'conflict') throw notulaError('invalid-input', `${a.label} already has a different skill named notula. Notula left it as it is.`)
    if (e.state === 'none') {
      mkdirSync(skillsDir, { recursive: true })
      symlinkSync(skillDir, installPath, isWin ? 'junction' : 'dir')
      log('info', 'companion-cli:installed', { agent: a.id })
    }
    return status()
  })

  ipcMain.handle('companion-cli:remove' satisfies InvokeChannel, async (_e, p: { agentId: CompanionAgentId }): Promise<InvokeRes<'companion-cli:remove'>> => {
    if (!enabled) throw notulaError('invalid-input', OFF)
    const a = agentOf(p?.agentId)
    const installPath = join(expand(isWin ? a.skillsDir.win32 : a.skillsDir.default), COMPANION_LIMITS.skillFolderName)
    // Only our own link; a folder or a foreign link is never touched.
    if (entryState(installPath).state === 'installed') {
      try {
        unlinkSync(installPath)
      } catch {
        // A Windows junction is removed as an (empty-looking) directory entry; the target stays.
        rmdirSync(installPath)
      }
      log('info', 'companion-cli:removed', { agent: a.id })
    }
    return status()
  })

  ipcMain.handle('companion-cli:open-location' satisfies InvokeChannel, async (): Promise<InvokeRes<'companion-cli:open-location'>> => {
    if (!enabled) throw notulaError('invalid-input', OFF)
    writeCli()
    writeSkill()
    const err = await shell.openPath(skillDir)
    if (err) throw notulaError('internal', 'Couldn’t open the skill folder')
  })
}
