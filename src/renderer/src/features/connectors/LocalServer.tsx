// SPDX-License-Identifier: Apache-2.0
// Settings ▸ Connectors ▸ MCP: Notula's own local MCP
// server. The main switch and the two transport switches, a status line, the Claude Desktop
// steps ("Copy the configuration"), HTTP tokens (shown once) and Recent activity.

import { useEffect, useState, type JSX } from 'react'
import { parseError } from '@shared/errors'
import type { McpLocalServerActivity, McpLocalServerStatus, McpLocalServerToken } from '@shared/types/mcp'
import { showToast } from '../../app/toast'
import { Modal } from '../folders/Modal'
import { Switch } from '../settings/controls'

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
            Create token
          </button>
        </div>
      </form>
    </Modal>
  )
}

export function LocalServerCard(): JSX.Element {
  const [status, setStatus] = useState<McpLocalServerStatus | null>(null)
  const [tokens, setTokens] = useState<McpLocalServerToken[]>([])
  const [activity, setActivity] = useState<McpLocalServerActivity[]>([])
  const [naming, setNaming] = useState(false)
  const [fresh, setFresh] = useState<{ id: string; token: string } | null>(null)
  const [portDraft, setPortDraft] = useState('')

  const readTokens = (): void => {
    void window.notula.mcpServer.listTokens().then(setTokens).catch(() => undefined)
  }
  useEffect(() => {
    void window.notula.mcpServer.getStatus().then(setStatus).catch(() => undefined)
    readTokens()
    const readActivity = (): void => void window.notula.mcpServer.getActivity().then(setActivity).catch(() => undefined)
    readActivity()
    const t = setInterval(readActivity, 5_000)
    const off = window.notula.mcpServer.onChanged((s) => setStatus(s))
    return () => {
      clearInterval(t)
      off()
    }
  }, [])

  if (!status) return <div className="settings-card mcp-local" />

  const set = (patch: Partial<McpLocalServerStatus>): void => {
    const next = { enabled: status.enabled, stdio: status.stdio, http: status.http, port: status.port, ...patch }
    void window.notula.mcpServer.setConfig(next).then(setStatus, (err: unknown) => showToast({ kind: 'error', title: parseError(err).message }))
  }
  const line = statusLine(status)
  const localOnly = status.error === 'local-only'

  const copyConfig = async (): Promise<void> => {
    try {
      const cfg = await window.notula.mcpServer.getStdioConfig({ name: 'Claude Desktop' })
      await copy(cfg.configJson, 'Configuration copied')
      readTokens()
    } catch (err) {
      showToast({ kind: 'error', title: parseError(err).message || 'Couldn’t create the configuration.' })
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

        {status.enabled && status.stdio ? (
          <div className="mcp-steps">
            <div className="mcp-steps__head">Claude Desktop</div>
            <ol>
              <li>
                <button type="button" className="n-btn n-btn--sm" onClick={() => void copyConfig()}>
                  Copy the configuration
                </button>
                <span className="mcp-steps__note">Each copy creates its own token, listed below.</span>
              </li>
              <li>In Claude Desktop, open Settings ▸ Developer ▸ Edit Config, add the entry under “mcpServers”, save, and restart Claude Desktop.</li>
            </ol>
          </div>
        ) : null}

        {status.enabled && status.http ? (
          <div className="mcp-steps">
            <div className="mcp-steps__head">Other apps (HTTP)</div>
            <p className="mcp-steps__text">
              Connect to{' '}
              <button type="button" className="mcp-chip" onClick={() => void copy(`http://127.0.0.1:${status.port}/mcp`, 'Link copied')}>
                http://127.0.0.1:{status.port}/mcp
              </button>{' '}
              and send the token as <code>Authorization: Bearer &lt;token&gt;</code>.
            </p>
            {fresh ? (
              <div className="mcp-fresh">
                <div className="mcp-fresh__label">Copy this token now. Notula won’t show it again.</div>
                <div className="mcp-fresh__row">
                  <code className="mcp-fresh__token">{fresh.token}</code>
                  <button type="button" className="n-btn n-btn--sm" onClick={() => void copy(fresh.token)}>
                    Copy
                  </button>
                  <button type="button" className="n-btn n-btn--ghost n-btn--sm" onClick={() => setFresh(null)}>
                    Done
                  </button>
                </div>
              </div>
            ) : (
              <button type="button" className="n-btn n-btn--sm" onClick={() => setNaming(true)}>
                Create token
              </button>
            )}
          </div>
        ) : null}

        {tokens.length ? (
          <div className="mcp-tokens">
            <div className="mcp-steps__head">Tokens</div>
            <ul>
              {tokens.map((t) => (
                <li key={t.id} className="mcp-tokens__row">
                  <span className="mcp-tokens__name">{t.name}</span>
                  <span className="mcp-badge">{t.kind === 'stdio' ? 'stdio' : 'HTTP'}</span>
                  <span className="mcp-tokens__meta">
                    Created {new Date(t.createdAt).toLocaleDateString()} · Last used {ago(t.lastUsedAt)}
                  </span>
                  <button
                    type="button"
                    className="n-btn n-btn--ghost n-btn--sm"
                    onClick={() => void window.notula.mcpServer.revokeToken({ id: t.id }).then(readTokens)}
                  >
                    Revoke
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

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
      {naming ? (
        <NameDialog
          title="Create token"
          onDone={(name) => {
            setNaming(false)
            if (!name) return
            void window.notula.mcpServer.createToken({ name }).then(
              (r) => {
                setFresh(r)
                readTokens()
              },
              (err: unknown) => showToast({ kind: 'error', title: parseError(err).message })
            )
          }}
        />
      ) : null}
    </section>
  )
}
