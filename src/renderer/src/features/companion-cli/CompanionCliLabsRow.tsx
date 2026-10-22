// SPDX-License-Identifier: Apache-2.0
// Settings ▸ Labs ▸ Companion CLI for coding agents: the
// switch, its two checkboxes, one row per agent (Install / Remove / Not detected / Conflict), and
// Open folder and Copy CLI path. Disabled with the local-only line while local-only is on.

import { useCallback, useEffect, useState, type JSX } from 'react'
import { parseError } from '@shared/errors'
import type { CompanionAgentId, CompanionCliStatus } from '@shared/types/local-api'
import { showToast } from '../../app/toast'
import { Switch } from '../settings/controls'
import { setPrefs, usePrefs } from '../settings/prefs-store'
import '../local-api/local-api.css'

const LABEL = 'Companion CLI for coding agents'
const DESCRIPTION =
  'Installs a notula command that coding agents on this computer can run to search and read your notes, transcripts and folders, and to file notes in folders.'
const LOCAL_ONLY_LINE = 'Off while Nothing leaves this machine is on. Programs that read your notes could send them elsewhere.'
const INSTALLED_KEY = 'notula.companionCli.hadInstalls'

function rememberInstalls(s: CompanionCliStatus): void {
  try {
    localStorage.setItem(INSTALLED_KEY, s.agents.some((a) => a.state === 'installed') ? '1' : '0')
  } catch {
    // Per-viewer convenience only.
  }
}

function hadInstalls(): boolean {
  try {
    return localStorage.getItem(INSTALLED_KEY) === '1'
  } catch {
    return false
  }
}

export function CompanionCliLabsRow(): JSX.Element | null {
  const prefs = usePrefs()
  const [status, setStatus] = useState<CompanionCliStatus | null>(null)
  const [busy, setBusy] = useState<{ id: CompanionAgentId; kind: 'install' | 'remove' } | null>(null)
  const on = prefs?.['companionCli.enabled'] === true
  const localOnly = prefs?.['privacy.localOnly'] === true

  // Right after the switch turns on, main may not have the new value yet: retry briefly.
  const read = useCallback((tries = 4): void => {
    void window.notula.companionCli.getStatus().then(
      (s) => {
        setStatus(s)
        rememberInstalls(s)
      },
      () => {
        if (tries > 1) setTimeout(() => read(tries - 1), 300)
        else setStatus(null)
      }
    )
  }, [])

  useEffect(() => {
    if (on) read()
    else setStatus(null)
  }, [on, localOnly, read])

  if (!prefs) return null

  const act = async (id: CompanionAgentId, kind: 'install' | 'remove', label: string): Promise<void> => {
    setBusy({ id, kind })
    try {
      const s = kind === 'install' ? await window.notula.companionCli.install({ agentId: id }) : await window.notula.companionCli.remove({ agentId: id })
      setStatus(s)
      rememberInstalls(s)
      showToast({ kind: 'success', title: kind === 'install' ? `Skill installed for ${label}` : `Skill removed from ${label}` })
    } catch (err) {
      showToast({ kind: 'error', title: parseError(err).message || (kind === 'install' ? 'Couldn’t install the skill' : 'Couldn’t remove the skill') })
      read()
    } finally {
      setBusy(null)
    }
  }

  const copyPath = async (): Promise<void> => {
    if (!status) return
    try {
      await navigator.clipboard.writeText(status.cliPath)
      showToast({ kind: 'success', title: 'CLI path copied' })
    } catch {
      showToast({ kind: 'error', title: 'Couldn’t copy the CLI path' })
    }
  }

  const openFolder = (): void => {
    void window.notula.companionCli.openLocation().catch(() => showToast({ kind: 'error', title: 'Couldn’t open the skill folder' }))
  }

  const setBool = (key: 'companionCli.enabled' | 'companionCli.allowTranscripts' | 'companionCli.allowFolderWrites', v: boolean): void => {
    setPrefs({ [key]: v })
  }

  const hint = localOnly ? LOCAL_ONLY_LINE : !on && hadInstalls() ? `${DESCRIPTION} Skills stay installed until you remove them.` : DESCRIPTION

  return (
    <div className="ccli-row">
      <div className="settings-row">
        <div className="settings-row__text">
          <div className="settings-row__label">{LABEL}</div>
          <div className="settings-row__hint">{hint}</div>
        </div>
        <div className="settings-row__control">
          <Switch label={LABEL} checked={on && !localOnly} disabled={localOnly} onChange={(v) => setBool('companionCli.enabled', v)} />
        </div>
      </div>
      {on && !localOnly ? (
        <div className="ccli-body">
          <div className="ccli-checks">
            <label className="mcp-check">
              <input type="checkbox" checked={prefs['companionCli.allowTranscripts']} onChange={(e) => setBool('companionCli.allowTranscripts', e.target.checked)} />
              <span>Let agents read transcripts</span>
            </label>
            <label className="mcp-check">
              <input type="checkbox" checked={prefs['companionCli.allowFolderWrites']} onChange={(e) => setBool('companionCli.allowFolderWrites', e.target.checked)} />
              <span>Let agents add notes to folders and remove them</span>
            </label>
          </div>
          {status ? (
            <>
              <ul className="ccli-agents">
                {status.agents.map((a) => {
                  const mine = busy?.id === a.id
                  return (
                    <li key={a.id} className="ccli-agent">
                      <span className="ccli-agent__name">{a.label}</span>
                      <span className="ccli-agent__detail" title={a.detail ?? a.installPath}>
                        {a.state === 'installed' ? a.installPath : a.detail ?? ''}
                      </span>
                      {a.state === 'installed' ? (
                        <button type="button" className="n-btn n-btn--sm" disabled={busy !== null} onClick={() => void act(a.id, 'remove', a.label)}>
                          {mine ? 'Removing…' : 'Remove'}
                        </button>
                      ) : a.state === 'available' ? (
                        <button type="button" className="n-btn n-btn--primary n-btn--sm" disabled={busy !== null} onClick={() => void act(a.id, 'install', a.label)}>
                          {mine ? 'Installing…' : 'Install'}
                        </button>
                      ) : a.state === 'conflict' ? (
                        <span className="mcp-pill" title={a.detail ?? undefined}>
                          Conflict
                        </span>
                      ) : (
                        <button type="button" className="n-btn n-btn--sm" disabled>
                          Not detected
                        </button>
                      )}
                    </li>
                  )
                })}
              </ul>
              <div className="ccli-footer">
                <p>Each agent gets a link to one skill folder that Notula keeps. Removing an agent deletes only its link, never the folder or your notes.</p>
                <button type="button" className="n-btn n-btn--ghost n-btn--sm" onClick={openFolder}>
                  Open folder
                </button>
                <button type="button" className="n-btn n-btn--ghost n-btn--sm" onClick={() => void copyPath()}>
                  Copy CLI path
                </button>
              </div>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
