// SPDX-License-Identifier: Apache-2.0
// Settings ▸ Connectors ▸ MCP Servers (shown while Labs
// `mcpClient.enabled` is on): one row per server with its state and an enable switch, a menu
// with View tools, View log (stdio), Edit and Disconnect, and the "Add custom MCP" dialog
// (URL or Command). Secrets go to main once and never come back: Edit leaves the token and
// the environment values unchanged unless new ones are typed.

import { useEffect, useRef, useState, type JSX, type KeyboardEvent } from 'react'
import { parseError } from '@shared/errors'
import type { McpServerInfo, McpServerInput, McpServerPatch, McpToolInfo, McpTransport } from '@shared/types/mcp'
import { showToast } from '../../app/toast'
import { Modal } from '../folders/Modal'
import { Segmented, Switch } from '../settings/controls'

function ServerIcon(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="2" y="2.5" width="12" height="4.5" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
      <rect x="2" y="9" width="12" height="4.5" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="4.75" cy="4.75" r="0.8" fill="currentColor" />
      <circle cx="4.75" cy="11.25" r="0.8" fill="currentColor" />
    </svg>
  )
}

export function useMcpServers(): McpServerInfo[] | null {
  const [servers, setServers] = useState<McpServerInfo[] | null>(null)
  useEffect(() => {
    let live = true
    const read = (): void => {
      void window.notula.mcp
        .listServers()
        .then((s) => live && setServers(s))
        .catch(() => live && setServers([]))
    }
    read()
    const off = window.notula.mcp.onChanged(read)
    return () => {
      live = false
      off()
    }
  }, [])
  return servers
}

function describe(s: McpServerInfo): string {
  if (!s.enabled) return 'Turned off'
  if (s.state === 'connected') return `${s.toolCount} ${s.toolCount === 1 ? 'tool' : 'tools'}${s.toolsCut ? ` · ${s.toolsCut} not offered (64-tool limit)` : ''}`
  if (s.state === 'connecting') return 'Connecting...'
  if (s.state === 'disabled') return 'Waiting'
  return s.error ?? 'Something went wrong'
}

function where(s: McpServerInfo): string {
  return s.transport === 'stdio' ? [s.command, ...s.args].join(' ') : (s.url ?? '')
}

// ---------- the add / edit dialog ----------

type Kind = 'url' | 'command'

function parseEnv(text: string): { env: Record<string, string>; bad: string | null } {
  const env: Record<string, string> = {}
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const i = line.indexOf('=')
    if (i <= 0) return { env, bad: line.slice(0, 40) }
    env[line.slice(0, i).trim()] = line.slice(i + 1)
  }
  return { env, bad: null }
}

function ServerDialog({ existing, onClose }: { existing: McpServerInfo | null; onClose(): void }): JSX.Element {
  const [kind, setKind] = useState<Kind>(existing?.transport === 'stdio' ? 'command' : 'url')
  const [name, setName] = useState(existing?.name ?? '')
  const [url, setUrl] = useState(existing?.url ?? '')
  const [transport, setTransport] = useState<Exclude<McpTransport, 'stdio'>>(existing?.transport === 'sse' ? 'sse' : 'http')
  const [token, setToken] = useState('')
  const [privateNet, setPrivateNet] = useState(existing?.allowPrivateNetwork ?? false)
  const [advanced, setAdvanced] = useState(false)
  const [command, setCommand] = useState(existing?.command ?? '')
  const [args, setArgs] = useState((existing?.args ?? []).join('\n'))
  const [envText, setEnvText] = useState(existing ? existing.envNames.map((n) => `${n}=`).join('\n') : '')
  const [envTouched, setEnvTouched] = useState(false)
  const [cwd, setCwd] = useState(existing?.cwd ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ text: string; detail: string | null } | null>(null)

  const submit = async (): Promise<void> => {
    if (busy) return
    setError(null)
    let input: McpServerInput
    if (kind === 'url') {
      if (!name.trim() || !url.trim()) return setError({ text: 'Enter a name and a URL.', detail: null })
      input = { name: name.trim(), transport, url: url.trim(), allowPrivateNetwork: privateNet, ...(token.trim() ? { token: token.trim() } : {}) }
    } else {
      if (!name.trim()) return setError({ text: 'Enter a name for this server.', detail: null })
      if (!command.trim()) return setError({ text: 'Enter a command', detail: null })
      const { env, bad } = parseEnv(envText)
      if (bad) return setError({ text: 'Write each variable as NAME=value', detail: bad })
      input = {
        name: name.trim(),
        transport: 'stdio',
        command: command.trim(),
        args: args.split('\n').map((a) => a.trim()).filter(Boolean),
        cwd: cwd.trim() || null,
        ...(!existing || envTouched ? { env } : {})
      }
    }
    setBusy(true)
    try {
      if (existing) {
        const patch: McpServerPatch = { ...input }
        await window.notula.mcp.updateServer({ id: existing.id, patch })
      } else {
        await window.notula.mcp.addServer(input)
        showToast({ kind: 'success', title: `Added ${input.name} MCP server` })
      }
      onClose()
    } catch (err) {
      const msg = parseError(err).message
      const [text = 'Couldn’t connect to this server. Try again.', ...rest] = msg.split('\n')
      setError({ text, detail: rest.join(' ') || null })
      setBusy(false)
    }
  }

  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Enter' && !(e.target instanceof HTMLTextAreaElement)) {
      e.preventDefault()
      void submit()
    }
  }

  return (
    <Modal label={existing ? 'Edit MCP server' : 'Add an MCP server'} className="mcp-dialog" onClose={() => !busy && onClose()}>
      <div className="h-modal__body" onKeyDown={onKey}>
        <h2 className="h-modal__title">{existing ? 'Edit MCP server' : 'Add an MCP server'}</h2>
        {!existing ? (
          <div className="mcp-field">
            <Segmented<Kind>
              label="Server type"
              value={kind}
              options={[
                { value: 'url', label: 'URL' },
                { value: 'command', label: 'Command' }
              ]}
              onChange={(k) => {
                setKind(k)
                setError(null)
              }}
            />
          </div>
        ) : null}
        <label className="mcp-field">
          <span className="mcp-field__label">Name</span>
          <input className="mcp-input" data-autofocus value={name} placeholder="e.g., Linear" onChange={(e) => setName(e.target.value)} />
        </label>
        {kind === 'url' ? (
          <>
            <label className="mcp-field">
              <span className="mcp-field__label">Server URL</span>
              <input className="mcp-input" value={url} placeholder="https://tools.example.org/mcp" spellCheck={false} onChange={(e) => setUrl(e.target.value)} />
            </label>
            <label className="mcp-check">
              <input type="checkbox" checked={privateNet} onChange={(e) => setPrivateNet(e.target.checked)} />
              This server is on my local network
            </label>
            <button type="button" className="mcp-advanced" aria-expanded={advanced} onClick={() => setAdvanced(!advanced)}>
              <span className={`mcp-advanced__chev${advanced ? ' is-open' : ''}`}>›</span> Advanced
            </button>
            {advanced ? (
              <div className="mcp-advanced__body">
                <div className="mcp-field">
                  <span className="mcp-field__label">Transport Type</span>
                  <Segmented<Exclude<McpTransport, 'stdio'>>
                    label="Transport Type"
                    value={transport}
                    options={[
                      { value: 'http', label: 'HTTP' },
                      { value: 'sse', label: 'SSE' }
                    ]}
                    onChange={setTransport}
                  />
                </div>
                <label className="mcp-field">
                  <span className="mcp-field__label">API Token</span>
                  <input
                    className="mcp-input"
                    type="password"
                    autoComplete="off"
                    value={token}
                    placeholder={existing?.hasToken ? 'Leave empty to keep the saved token' : 'Key or token, if the server needs one'}
                    onChange={(e) => setToken(e.target.value)}
                  />
                </label>
              </div>
            ) : null}
          </>
        ) : (
          <>
            <label className="mcp-field">
              <span className="mcp-field__label">Command</span>
              <input className="mcp-input mcp-input--mono" value={command} placeholder="e.g., npx" spellCheck={false} onChange={(e) => setCommand(e.target.value)} />
            </label>
            <label className="mcp-field">
              <span className="mcp-field__label">Arguments (one per line)</span>
              <textarea className="mcp-input mcp-input--mono mcp-textarea" rows={3} value={args} spellCheck={false} onChange={(e) => setArgs(e.target.value)} />
            </label>
            <label className="mcp-field">
              <span className="mcp-field__label">Environment variables (NAME=value per line)</span>
              <textarea
                className="mcp-input mcp-input--mono mcp-textarea mcp-secret"
                rows={2}
                value={envText}
                spellCheck={false}
                placeholder={existing?.envNames.length ? 'Saved values are kept unless you change this' : ''}
                onChange={(e) => {
                  setEnvText(e.target.value)
                  setEnvTouched(true)
                }}
              />
            </label>
            <label className="mcp-field">
              <span className="mcp-field__label">Working directory (optional)</span>
              <input className="mcp-input mcp-input--mono" value={cwd} spellCheck={false} onChange={(e) => setCwd(e.target.value)} />
            </label>
            <p className="mcp-warning">This runs a program on your computer with your permissions. Only add commands you trust.</p>
          </>
        )}
        {error ? (
          <p className="mcp-error" role="alert">
            {error.text}
            {error.detail ? <span className="mcp-error__detail">{error.detail}</span> : null}
          </p>
        ) : null}
        <div className="h-modal__footer">
          <button type="button" className="n-btn" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="n-btn n-btn--primary" disabled={busy} onClick={() => void submit()}>
            {busy ? (existing ? 'Saving...' : 'Connecting...') : existing ? 'Save' : 'Add'}
          </button>
        </div>
      </div>
    </Modal>
  )
}

// ---------- View tools / View log ----------

function ToolsDialog({ server, onClose }: { server: McpServerInfo; onClose(): void }): JSX.Element {
  const [tools, setTools] = useState<McpToolInfo[] | null>(null)
  const [policy, setPolicy] = useState(server.serverPolicy)
  const read = (): void => {
    void window.notula.mcp
      .listTools({ id: server.id })
      .then(setTools)
      .catch(() => setTools([]))
  }
  useEffect(read, [server.id])
  const setTool = (tool: string, always: boolean): void => {
    void window.notula.mcp.setToolPolicy({ id: server.id, tool, policy: always ? 'always' : 'ask' }).then(read)
  }
  return (
    <Modal label={`${server.name} tools`} className="mcp-dialog mcp-dialog--wide" onClose={onClose}>
      <div className="h-modal__body">
        <h2 className="h-modal__title">{server.name} tools</h2>
        <p className="h-modal__subtitle">Chat asks before running a tool unless you allow it here.</p>
        <label className="mcp-check mcp-check--policy">
          <input
            type="checkbox"
            checked={policy === 'read-only-auto'}
            onChange={(e) => {
              const next = e.target.checked ? 'read-only-auto' : 'ask'
              setPolicy(next)
              void window.notula.mcp.setToolPolicy({ id: server.id, serverPolicy: next })
            }}
          />
          <span>
            Allow read-only tools without asking
            <span className="mcp-check__hint">The server says which tools are read-only. Only use this for servers you trust.</span>
          </span>
        </label>
        <ul className="mcp-tools">
          {tools === null ? <li className="mcp-tools__empty">Loading…</li> : null}
          {tools?.length === 0 ? <li className="mcp-tools__empty">This server offers no tools.</li> : null}
          {tools?.map((t) => (
            <li key={t.name} className="mcp-tools__row">
              <div className="mcp-tools__text">
                <div className="mcp-tools__name">
                  {t.title ?? t.name}
                  {t.readOnlyHint ? <span className="mcp-badge">Read-only</span> : null}
                </div>
                <div className="mcp-tools__id">{t.offeredAs}</div>
                {t.description ? <div className="mcp-tools__desc">{t.description}</div> : null}
              </div>
              <label className="mcp-tools__always">
                <span>Always allow</span>
                <Switch checked={t.policy === 'always'} label={`Always allow ${t.name}`} onChange={(on) => setTool(t.name, on)} />
              </label>
            </li>
          ))}
        </ul>
        {server.instructions ? (
          <details className="mcp-instructions">
            <summary>What the server says about itself</summary>
            <p>{server.instructions}</p>
          </details>
        ) : null}
        <div className="h-modal__footer">
          <button type="button" className="n-btn" data-autofocus onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </Modal>
  )
}

function LogDialog({ server, onClose }: { server: McpServerInfo; onClose(): void }): JSX.Element {
  const [text, setText] = useState<string | null>(null)
  const pre = useRef<HTMLPreElement>(null)
  const read = (): void => {
    void window.notula.mcp
      .getLog({ id: server.id })
      .then((r) => setText(r.text))
      .catch(() => setText(''))
  }
  useEffect(read, [server.id])
  useEffect(() => {
    if (pre.current) pre.current.scrollTop = pre.current.scrollHeight
  }, [text])
  return (
    <Modal label={`${server.name} log`} className="mcp-dialog mcp-dialog--wide" onClose={onClose}>
      <div className="h-modal__body">
        <h2 className="h-modal__title">{server.name} log</h2>
        <p className="h-modal__subtitle">What the program wrote to its error output (the last 200 KB).</p>
        <pre ref={pre} className="mcp-log">
          {text === null ? 'Loading…' : text || 'Nothing yet.'}
        </pre>
        <div className="h-modal__footer">
          <button type="button" className="n-btn" onClick={read}>
            Refresh
          </button>
          <button type="button" className="n-btn n-btn--primary" data-autofocus onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </Modal>
  )
}

// ---------- a row ----------

function Row({ s, onEdit, onTools, onLog }: { s: McpServerInfo; onEdit(): void; onTools(): void; onLog(): void }): JSX.Element {
  const [menu, setMenu] = useState(false)
  const [busy, setBusy] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!menu) return
    const close = (e: MouseEvent): void => {
      if (!menuRef.current?.contains(e.target as Node)) setMenu(false)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [menu])

  const reconnect = (): void => {
    setBusy(true)
    void window.notula.mcp
      .reconnectServer({ id: s.id })
      .catch(() => showToast({ kind: 'error', title: 'Couldn’t connect to this server. Try again.' }))
      .finally(() => setBusy(false))
  }
  const remove = (): void => {
    setMenu(false)
    void window.notula.mcp.removeServer({ id: s.id }).then(
      () => showToast({ kind: 'success', title: `Removed ${s.name}` }),
      (err: unknown) => showToast({ kind: 'error', title: parseError(err).message })
    )
  }
  const bad = s.enabled && (s.state === 'error' || s.state === 'needs_auth')
  return (
    <div className="settings-row mcp-row">
      <span className="settings-row__icon">
        <ServerIcon />
      </span>
      <div className="settings-row__text">
        <div className="settings-row__label">
          {s.name} <span className="mcp-badge">Custom</span>
        </div>
        <div className="settings-row__hint mcp-row__where" title={where(s)}>
          {where(s)}
        </div>
        <div className={`mcp-row__state${bad ? ' is-error' : ''}`}>{describe(s)}</div>
      </div>
      <div className="settings-row__control mcp-row__control">
        {s.enabled && s.state === 'connecting' ? <span className="mcp-spinner" aria-label="Connecting..." /> : null}
        {s.enabled && s.state === 'connected' ? <span className="mcp-pill mcp-pill--ok">Connected</span> : null}
        {bad ? (
          <>
            <span className="mcp-pill mcp-pill--error">Error</span>
            <button type="button" className="n-btn n-btn--sm" disabled={busy} onClick={reconnect}>
              {busy ? 'Reconnecting...' : 'Reconnect'}
            </button>
          </>
        ) : null}
        <Switch
          checked={s.enabled}
          label={`Use ${s.name}`}
          onChange={(on) => void window.notula.mcp.updateServer({ id: s.id, patch: { enabled: on } }).catch(() => undefined)}
        />
        <div className="mcp-menu" ref={menuRef}>
          <button type="button" className="vt-icon-btn mcp-menu__btn" aria-label={`${s.name} options`} aria-expanded={menu} onClick={() => setMenu(!menu)}>
            ⋯
          </button>
          {menu ? (
            <div className="mcp-menu__list" role="menu">
              <button type="button" role="menuitem" onClick={() => (setMenu(false), onTools())}>
                View tools
              </button>
              {s.transport === 'stdio' ? (
                <button type="button" role="menuitem" onClick={() => (setMenu(false), onLog())}>
                  View log
                </button>
              ) : null}
              <button type="button" role="menuitem" onClick={() => (setMenu(false), onEdit())}>
                Edit
              </button>
              <button type="button" role="menuitem" className="is-danger" onClick={remove}>
                Disconnect
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}

export function McpServersSection(): JSX.Element {
  const servers = useMcpServers()
  const [dialog, setDialog] = useState<
    { kind: 'add' } | { kind: 'edit'; s: McpServerInfo } | { kind: 'tools'; s: McpServerInfo } | { kind: 'log'; s: McpServerInfo } | null
  >(null)
  return (
    <section className="settings-group">
      <h2 className="settings-group__title">MCP servers</h2>
      <p className="settings-group__description">Chat can use the tools of the servers you add here. It asks before running a tool.</p>
      <div className="settings-card">
        {servers?.map((s) => (
          <Row
            key={s.id}
            s={s}
            onEdit={() => setDialog({ kind: 'edit', s })}
            onTools={() => setDialog({ kind: 'tools', s })}
            onLog={() => setDialog({ kind: 'log', s })}
          />
        ))}
        <div className="settings-row mcp-footer">
          <div className="settings-row__text">
            <div className="settings-row__label">Custom MCP server</div>
            <div className="settings-row__hint">Connect any MCP server by URL or command.</div>
          </div>
          <div className="settings-row__control">
            <button type="button" className="n-btn n-btn--sm" onClick={() => setDialog({ kind: 'add' })}>
              Add an MCP server
            </button>
          </div>
        </div>
      </div>
      {dialog?.kind === 'add' ? <ServerDialog existing={null} onClose={() => setDialog(null)} /> : null}
      {dialog?.kind === 'edit' ? <ServerDialog existing={dialog.s} onClose={() => setDialog(null)} /> : null}
      {dialog?.kind === 'tools' ? <ToolsDialog server={dialog.s} onClose={() => setDialog(null)} /> : null}
      {dialog?.kind === 'log' ? <LogDialog server={dialog.s} onClose={() => setDialog(null)} /> : null}
    </section>
  )
}
