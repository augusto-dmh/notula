// SPDX-License-Identifier: Apache-2.0
// Settings ▸ Connectors ▸ MCP: Notula's own local MCP
// server. The main switch and the two transport switches, a status line, one-click installs for
// Cursor and VS Code, setup snippets for other local apps (each with a new key, shown once), the
// connected apps with their use over 30 days, and Recent activity.

import { useCallback, useEffect, useState, type JSX } from 'react'
import { parseError } from '@shared/errors'
import type {
  McpConnectedApp,
  McpInstallResult,
  McpInstallTarget,
  McpLocalServerActivity,
  McpLocalServerStatus,
  McpSnippet,
  McpSnippetClient
} from '@shared/types/mcp'
import { navigate } from '../../app/navigation'
import { showToast } from '../../app/toast'
import { Modal } from '../folders/Modal'
import { Switch } from '../settings/controls'
import { confirmDialog } from '../templates/confirm'

const INSTALL_APPS: { target: McpInstallTarget; name: string }[] = [
  { target: 'cursor', name: 'Cursor' },
  { target: 'vscode', name: 'VS Code' }
]

function installMessage(name: string, r: McpInstallResult): { text: string; error: boolean } {
  if (r === 'opened') return { text: `Opened ${name}. Confirm the install there.`, error: false }
  if (r === 'no-app') return { text: `${name} isn’t installed on this computer. Use a setup below instead.`, error: true }
  if (r === 'server-off') return { text: 'Turn on the server first.', error: true }
  return { text: `Couldn’t open ${name}. Try again, or use a setup below.`, error: true }
}

const SNIPPET_CLIENTS: { id: McpSnippetClient; label: string; needs: 'stdio' | 'http' | 'any'; steps: string }[] = [
  {
    id: 'claude-desktop',
    label: 'Claude Desktop',
    needs: 'stdio',
    steps: 'In Claude Desktop, open Settings ▸ Developer ▸ Edit Config, add the entry under “mcpServers”, save, and restart Claude Desktop.'
  },
  { id: 'claude-code', label: 'Claude Code', needs: 'any', steps: 'Run this command in a terminal.' },
  { id: 'cursor', label: 'Cursor', needs: 'any', steps: 'Add the entry under “mcpServers” in Cursor’s mcp.json, then reload Cursor.' },
  { id: 'vscode', label: 'VS Code', needs: 'any', steps: 'In VS Code, run “MCP: Open User Configuration” and add the entry under “servers”.' },
  { id: 'program', label: 'Another app that launches a program', needs: 'stdio', steps: 'Give the app this command, its arguments and its environment.' },
  { id: 'url', label: 'Another app that connects by URL', needs: 'http', steps: 'Give the app this address and the Authorization header.' }
]

function statusLine(s: McpLocalServerStatus): { text: string; error: boolean } {
  if (s.error === 'local-only') return { text: 'Off while Notula keeps everything on this computer (local-only mode).', error: false }
  if (s.error === 'port-in-use') return { text: `Port ${s.port} is in use. Choose another port.`, error: true }
  if (!s.enabled || !s.listening) return { text: 'Off', error: false }
  if (s.stdio && s.http) return { text: `On · stdio and http://127.0.0.1:${s.port}/mcp`, error: false }
  if (s.http) return { text: `On · http://127.0.0.1:${s.port}/mcp`, error: false }
  return { text: 'On · stdio', error: false }
}

const ago = (iso: string | null): string => {
  if (!iso) return 'Never'
  const ms = Date.now() - Date.parse(iso)
  if (ms < 60_000) return 'Just now'
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min ago`
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)} h ago`
  return new Date(iso).toLocaleDateString()
}

async function copy(text: string, title = 'Copied'): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    showToast({ kind: 'success', title })
  } catch {
    showToast({ kind: 'error', title: 'Couldn’t copy. Try again.' })
  }
}

function NameDialog({ title, onDone }: { title: string; onDone(name: string | null): void }): JSX.Element {
  const [name, setName] = useState('')
  return (
    <Modal label={title} className="mcp-dialog" onClose={() => onDone(null)}>
      <form
        className="h-modal__body"
        onSubmit={(e) => {
          e.preventDefault()
          if (name.trim()) onDone(name.trim())
        }}
      >
        <h2 className="h-modal__title">{title}</h2>
        <label className="mcp-field">
          <span className="mcp-field__label">Name</span>
          <input className="mcp-input" data-autofocus value={name} placeholder="e.g., Cursor" maxLength={100} onChange={(e) => setName(e.target.value)} />
        </label>
        <div className="h-modal__footer">
          <button type="button" className="n-btn" onClick={() => onDone(null)}>
            Cancel
          </button>
          <button type="submit" className="n-btn n-btn--primary" disabled={!name.trim()}>
            Create key
          </button>
        </div>
      </form>
    </Modal>
  )
}

export function LocalServerCard(): JSX.Element {
  const [status, setStatus] = useState<McpLocalServerStatus | null>(null)
  const [apps, setApps] = useState<McpConnectedApp[]>([])
  const [activity, setActivity] = useState<McpLocalServerActivity[]>([])
  const [naming, setNaming] = useState(false)
  const [client, setClient] = useState<McpSnippetClient>('claude-desktop')
  const [snippet, setSnippet] = useState<McpSnippet | null>(null)
  const [installing, setInstalling] = useState<McpInstallTarget | null>(null)
  const [installed, setInstalled] = useState<{ target: McpInstallTarget; result: McpInstallResult } | null>(null)
  const [portDraft, setPortDraft] = useState('')

  const readApps = useCallback((): void => {
    void window.notula.mcpServer.listApps().then(setApps).catch(() => undefined)
  }, [])
  useEffect(() => {
    void window.notula.mcpServer.getStatus().then(setStatus).catch(() => undefined)
    const readActivity = (): void => void window.notula.mcpServer.getActivity().then(setActivity).catch(() => undefined)
    const read = (): void => {
      readActivity()
      readApps()
    }
    read()
    const t = setInterval(read, 5_000)
    const off = window.notula.mcpServer.onChanged((s) => setStatus(s))
    return () => {
      clearInterval(t)
      off()
    }
  }, [readApps])

  if (!status) return <div className="settings-card mcp-local" />

  const set = (patch: Partial<McpLocalServerStatus>): void => {
    const next = { enabled: status.enabled, stdio: status.stdio, http: status.http, port: status.port, ...patch }
    void window.notula.mcpServer.setConfig(next).then(setStatus, (err: unknown) => showToast({ kind: 'error', title: parseError(err).message }))
  }
  const line = statusLine(status)
  const localOnly = status.error === 'local-only'
  const serverOn = status.enabled && status.listening && (status.stdio || status.http)
  const clients = SNIPPET_CLIENTS.filter((c) => (c.needs === 'stdio' ? status.stdio : c.needs === 'http' ? status.http : status.stdio || status.http))
  const picked = clients.find((c) => c.id === client) ?? clients[0]
  const installedMsg = installed ? installMessage(INSTALL_APPS.find((x) => x.target === installed.target)?.name ?? '', installed.result) : null

  const install = async (target: McpInstallTarget): Promise<void> => {
    setInstalling(target)
    setInstalled(null)
    try {
      const result = await window.notula.mcpServer.install({ target })
      setInstalled({ target, result })
      readApps()
    } catch (err) {
      showToast({ kind: 'error', title: parseError(err).message || 'Couldn’t add the app.' })
    } finally {
      setInstalling(null)
    }
  }

  const createSnippet = async (id: McpSnippetClient, name?: string): Promise<void> => {
    try {
      setSnippet(await window.notula.mcpServer.getSnippet({ client: id, ...(name ? { name } : {}) }))
      readApps()
    } catch (err) {
      showToast({ kind: 'error', title: parseError(err).message || 'Couldn’t create the setup.' })
    }
  }

  const remove = async (a: McpConnectedApp): Promise<void> => {
    const ok = await confirmDialog({
      title: `Remove ${a.name}?`,
      body: 'Its key stops working, so it can no longer read your notes. To use it again, add it here again.',
      confirmLabel: 'Remove app',
      danger: true
    })
    if (!ok) return
    try {
      await window.notula.mcpServer.revokeToken({ id: a.id })
      readApps()
    } catch (err) {
      showToast({ kind: 'error', title: 'Couldn’t remove the app', description: parseError(err).message })
    }
  }

  return (
    <section className="settings-group">
      <h2 className="settings-group__title">MCP</h2>
      <div className="settings-card mcp-local">
        <div className="mcp-local__hero">
          <div className="mcp-local__title">Use your notes in other AI apps</div>
          <div className="settings-row__hint">Notula can act as an MCP server for apps on this computer.</div>
        </div>
        <div className="settings-row">
          <div className="settings-row__text">
            <div className="settings-row__label">Let AI apps read your notes</div>
            <div className={`settings-row__hint mcp-status${line.error ? ' is-error' : ''}`}>{line.text}</div>
          </div>
          <div className="settings-row__control">
            <Switch checked={status.enabled} disabled={localOnly} label="Let AI apps read your notes" onChange={(on) => set({ enabled: on })} />
          </div>
        </div>
        {status.enabled ? (
          <p className="mcp-notice">
            Apps you connect can read all your notes and transcripts. What they do with them, for example sending them to their AI provider, is up to them.
          </p>
        ) : null}
        <div className="settings-row mcp-sub">
          <div className="settings-row__text">
            <div className="settings-row__label">Apps that launch Notula (Claude Desktop)</div>
          </div>
          <div className="settings-row__control">
            <Switch checked={status.stdio} disabled={!status.enabled || localOnly} label="Apps that launch Notula" onChange={(on) => set({ stdio: on })} />
          </div>
        </div>
        <div className="settings-row mcp-sub">
          <div className="settings-row__text">
            <div className="settings-row__label">Apps that connect by URL</div>
          </div>
          <div className="settings-row__control">
            <Switch checked={status.http} disabled={!status.enabled || localOnly} label="Apps that connect by URL" onChange={(on) => set({ http: on })} />
          </div>
        </div>
        {status.error === 'port-in-use' || status.http ? (
          <div className="settings-row mcp-sub">
            <div className="settings-row__text">
              <div className="settings-row__label">Port</div>
            </div>
            <div className="settings-row__control mcp-port">
              <input
                className="mcp-input mcp-input--port"
                inputMode="numeric"
                value={portDraft || String(status.port)}
                aria-label="Port"
                onChange={(e) => setPortDraft(e.target.value.replace(/\D/g, '').slice(0, 5))}
                onBlur={() => {
                  const n = Number(portDraft)
                  if (portDraft && n !== status.port) set({ port: n })
                  setPortDraft('')
                }}
              />
            </div>
          </div>
        ) : null}

        <div className="mcp-steps">
          <div className="mcp-steps__head">Add to an app</div>
          <div className="mcp-install">
            {INSTALL_APPS.map((x) => (
              <button
                key={x.target}
                type="button"
                className="n-btn n-btn--sm"
                disabled={!serverOn || installing !== null}
                onClick={() => void install(x.target)}
              >
                {installing === x.target ? <span className="n-spinner" aria-hidden="true" /> : null}
                Add to {x.name}
              </button>
            ))}
          </div>
          {!serverOn ? (
            <p className="mcp-steps__note">Turn on the server above to add an app.</p>
          ) : installedMsg ? (
            <p className={`mcp-steps__note${installedMsg.error ? ' is-error' : ''}`} role="status">
              {installedMsg.text}
            </p>
          ) : null}
          <p className="mcp-steps__note">Each app gets a private key to Notula’s server, kept in its own settings. Removing the app here cuts it off.</p>
        </div>

        {status.enabled && picked ? (
          <div className="mcp-steps">
            <div className="mcp-steps__head">Set up another app</div>
            {snippet ? (
              <div className="mcp-fresh">
                <div className="mcp-fresh__label">Copy this setup now. It holds a key Notula won’t show again.</div>
                <pre className="mcp-snippet">{snippet.text}</pre>
                <p className="mcp-steps__text">{SNIPPET_CLIENTS.find((c) => c.id === snippet.client)?.steps}</p>
                <div className="mcp-fresh__row">
                  <button type="button" className="n-btn n-btn--sm" onClick={() => void copy(snippet.text, 'Setup copied')}>
                    Copy setup
                  </button>
                  <button type="button" className="n-btn n-btn--ghost n-btn--sm" onClick={() => setSnippet(null)}>
                    Done
                  </button>
                </div>
              </div>
            ) : (
              <div className="mcp-picker">
                <select className="n-input mcp-picker__select" aria-label="App to set up" value={picked.id} onChange={(e) => setClient(e.target.value as McpSnippetClient)}>
                  {clients.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="n-btn n-btn--sm"
                  onClick={() => (picked.id === 'program' || picked.id === 'url' ? setNaming(true) : void createSnippet(picked.id))}
                >
                  Create key
                </button>
              </div>
            )}
          </div>
        ) : null}

        <div className="mcp-tokens">
          <div className="mcp-steps__head">Connected apps</div>
          {apps.length ? (
            <ul>
              {apps.map((a) => (
                <li key={a.id} className="mcp-tokens__row">
                  <span className="mcp-tokens__name" title={a.clientName && a.clientName !== a.name ? a.clientName : undefined}>
                    {a.name}
                  </span>
                  <span className="mcp-badge">{a.kind === 'stdio' ? 'stdio' : 'HTTP'}</span>
                  <span className="mcp-tokens__meta">
                    {a.lastUsedAt ? `Last used ${ago(a.lastUsedAt).toLowerCase()}` : 'Not used yet'} · {a.calls30d}{' '}
                    {a.calls30d === 1 ? 'request' : 'requests'} in 30 days
                  </span>
                  {a.readProfile ? (
                    <button type="button" className="mcp-chip" onClick={() => navigate('/wiki')}>
                      {a.profilePaused ? 'Profile paused' : 'Reads your profile'}
                    </button>
                  ) : null}
                  <button type="button" className="n-btn n-btn--ghost n-btn--sm" onClick={() => void remove(a)}>
                    Remove…
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mcp-steps__note">No apps yet. Add one above to use your notes there.</p>
          )}
        </div>

        {status.enabled ? (
          <div className="mcp-tokens">
            <div className="mcp-steps__head">Recent activity</div>
            {activity.length ? (
              <ul>
                {activity.map((a, i) => (
                  <li key={`${a.at}-${i}`} className="mcp-activity__row">
                    <span className="mcp-activity__time">{new Date(a.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}</span>
                    <span className="mcp-activity__client">{a.client ?? 'Unknown app'}</span>
                    <span className="mcp-activity__tool">{a.tool}</span>
                    <span className={a.ok ? 'mcp-ok' : 'mcp-bad'}>{a.ok ? 'ok' : 'error'}</span>
                    <span className="mcp-activity__ms">{a.durationMs} ms</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mcp-steps__note">No calls yet.</p>
            )}
          </div>
        ) : null}
      </div>
      {naming && picked ? (
        <NameDialog
          title="Name this app"
          onDone={(name) => {
            setNaming(false)
            if (name) void createSnippet(picked.id, name)
          }}
        />
      ) : null}
    </section>
  )
}
