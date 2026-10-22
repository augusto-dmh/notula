// SPDX-License-Identifier: Apache-2.0
// Settings ▸ Connectors ▸ Local API: the switch and its notice, the key
// table with its dialogs (generate, show once, edit, revoke, remove), Recent activity and the
// local-only line. Keys reach the renderer only once, in the create reply.

import { useEffect, useMemo, useState, type JSX } from 'react'
import { parseError } from '@shared/errors'
import { LOCAL_API_LIMITS, type LocalApiActivity, type LocalApiKey, type LocalApiKeyInput, type LocalApiScope, type LocalApiStatus } from '@shared/types/local-api'
import { showToast } from '../../app/toast'
import { Modal } from '../folders/Modal'
import { usePrefs } from '../settings/prefs-store'
import { Select, Switch } from '../settings/controls'
import './local-api.css'

const LOCAL_ONLY_LINE = 'Off while Nothing leaves this machine is on. Programs that read your notes could send them elsewhere.'
const NOTICE =
  'Programs on this computer that have a key can read your notes and transcripts. Programs such as coding agents may send what they read to their own AI provider.'

const SCOPE_ROWS: { scope: LocalApiScope; label: string; hint: string }[] = [
  { scope: 'notes:read', label: 'Read notes', hint: 'List notes and read your notes and summaries. Always on.' },
  { scope: 'transcripts:read', label: 'Read transcripts', hint: 'Read the transcript of a note.' },
  { scope: 'folders:write', label: 'Add notes to folders and remove them', hint: 'Every change shows in Recent activity.' }
]

const EXPIRY: { value: LocalApiKeyInput['expiresIn']; label: string }[] = [
  { value: 'never', label: 'Never' },
  { value: '30d', label: '30 days' },
  { value: '90d', label: '90 days' },
  { value: '1y', label: '1 year' }
]

const STATUS_LABEL: Record<LocalApiKey['status'], string> = { active: 'Active', expired: 'Expired', revoked: 'Revoked' }

const ago = (iso: string | null): string => {
  if (!iso) return 'Never'
  const ms = Date.now() - Date.parse(iso)
  if (ms < 60_000) return 'Just now'
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min ago`
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)} h ago`
  if (ms < 30 * 86_400_000) return `${Math.round(ms / 86_400_000)} d ago`
  return new Date(iso).toLocaleDateString()
}

const day = (iso: string | null): string => (iso ? new Date(iso).toLocaleDateString() : 'Never')

const access = (k: LocalApiKey): string =>
  [k.scopes.includes('transcripts:read') ? 'Notes and transcripts' : 'Notes', k.scopes.includes('folders:write') ? 'folders' : null].filter(Boolean).join(', ')

const toastError = (err: unknown, fallback: string): void => {
  showToast({ kind: 'error', title: parseError(err).message || fallback })
}

function ScopePicker({ value, onChange }: { value: LocalApiScope[]; onChange(next: LocalApiScope[]): void }): JSX.Element {
  return (
    <div className="lapi-scopes" role="group" aria-label="Access">
      <span className="mcp-field__label">Access</span>
      <span className="mcp-check__hint">Choose what this key can do with your notes.</span>
      {SCOPE_ROWS.map((r) => (
        <label key={r.scope} className="mcp-check">
          <input
            type="checkbox"
            checked={r.scope === 'notes:read' || value.includes(r.scope)}
            disabled={r.scope === 'notes:read'}
            onChange={(e) => onChange(e.target.checked ? [...value.filter((s) => s !== r.scope), r.scope] : value.filter((s) => s !== r.scope))}
          />
          <span>
            {r.label}
            <span className="mcp-check__hint">{r.hint}</span>
          </span>
        </label>
      ))}
    </div>
  )
}

function KeyDialog({ edit, onClose, onSaved }: { edit: LocalApiKey | null; onClose(): void; onSaved(fresh: { id: string; key: string } | null): void }): JSX.Element {
  const [description, setDescription] = useState(edit?.description ?? '')
  const [scopes, setScopes] = useState<LocalApiScope[]>(edit?.scopes ?? ['notes:read', 'transcripts:read'])
  const [expiresIn, setExpiresIn] = useState<LocalApiKeyInput['expiresIn']>('never')
  const [busy, setBusy] = useState(false)
  const title = edit ? 'Edit API key' : 'Create API key'

  const submit = async (): Promise<void> => {
    setBusy(true)
    try {
      if (edit) {
        await window.notula.localApi.updateKey({ id: edit.id, description, scopes })
        showToast({ kind: 'success', title: 'API key updated' })
        onSaved(null)
      } else {
        onSaved(await window.notula.localApi.createKey({ description, scopes, expiresIn }))
      }
    } catch (err) {
      toastError(err, edit ? 'Couldn’t update the API key' : 'Couldn’t create the API key')
      setBusy(false)
    }
  }

  return (
    <Modal label={title} className="mcp-dialog" onClose={onClose}>
      <form
        className="h-modal__body"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <h2 className="h-modal__title">{title}</h2>
        <label className="mcp-field">
          <span className="mcp-field__label">Description (optional)</span>
          <input
            className="mcp-input"
            data-autofocus
            value={description}
            placeholder="e.g. Sales CRM sync"
            maxLength={LOCAL_API_LIMITS.descriptionMax}
            onChange={(e) => setDescription(e.target.value)}
          />
          <span className="mcp-check__hint">A name to help you recognize this key later.</span>
        </label>
        <ScopePicker value={scopes} onChange={setScopes} />
        {edit ? null : (
          <div className="mcp-field lapi-expiry">
            <span className="mcp-field__label">Expires</span>
            <Select<LocalApiKeyInput['expiresIn']> label="Expires" value={expiresIn} options={EXPIRY} onChange={setExpiresIn} />
          </div>
        )}
        <div className="h-modal__footer">
          <button type="button" className="n-btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="n-btn n-btn--primary" disabled={busy}>
            {edit ? (busy ? 'Saving…' : 'Save') : busy ? 'Generating...' : 'Create API key'}
          </button>
        </div>
      </form>
    </Modal>
  )
}

function FreshKeyDialog({ value, onClose }: { value: string; onClose(): void }): JSX.Element {
  const [copied, setCopied] = useState(false)
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value)
      showToast({ kind: 'success', title: 'API key copied to clipboard' })
      setCopied(true)
      setTimeout(() => setCopied(false), 2_000)
    } catch {
      showToast({ kind: 'error', title: 'Couldn’t copy. Try again.' })
    }
  }
  return (
    <Modal label="Your new API key" className="mcp-dialog mcp-dialog--wide" onClose={onClose}>
      <div className="h-modal__body">
        <h2 className="h-modal__title">Your new API key</h2>
        <p className="mcp-warning">Copy this key now. Notula won’t show it again.</p>
        <div className="mcp-fresh__row">
          <code className="mcp-fresh__token">{value}</code>
          <button type="button" className="n-btn n-btn--sm" onClick={() => void copy()}>
            {copied ? '✓ Copied' : 'Copy'}
          </button>
        </div>
        <p className="mcp-steps__note">
          A program connects to the pipe named in <code>local-api/endpoint.json</code> in Notula’s data folder, sends <code>{'{"type":"auth","token":"<key>"}'}</code>, then one JSON request per line.
        </p>
        <div className="h-modal__footer">
          <button type="button" className="n-btn n-btn--primary" data-autofocus onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </Modal>
  )
}

function ConfirmDialog({
  title,
  body,
  action,
  onDone
}: {
  title: string
  body: string
  action: string
  onDone(ok: boolean): void
}): JSX.Element {
  return (
    <Modal label={title} className="mcp-dialog" onClose={() => onDone(false)}>
      <div className="h-modal__body">
        <h2 className="h-modal__title">{title}</h2>
        <p className="lapi-confirm">{body}</p>
        <div className="h-modal__footer">
          <button type="button" className="n-btn" data-autofocus onClick={() => onDone(false)}>
            Cancel
          </button>
          <button type="button" className="n-btn n-btn--danger" onClick={() => onDone(true)}>
            {action}
          </button>
        </div>
      </div>
    </Modal>
  )
}

export function LocalApiSection(): JSX.Element {
  const prefs = usePrefs()
  const [status, setStatus] = useState<LocalApiStatus | null>(null)
  const [keys, setKeys] = useState<LocalApiKey[]>([])
  const [activity, setActivity] = useState<LocalApiActivity[]>([])
  const [query, setQuery] = useState('')
  const [dialog, setDialog] = useState<{ kind: 'create' } | { kind: 'edit'; key: LocalApiKey } | { kind: 'revoke'; key: LocalApiKey } | { kind: 'remove'; key: LocalApiKey } | null>(null)
  const [fresh, setFresh] = useState<string | null>(null)

  const readKeys = (): void => {
    void window.notula.localApi.listKeys().then(setKeys).catch(() => undefined)
  }
  useEffect(() => {
    void window.notula.localApi.getStatus().then(setStatus).catch(() => undefined)
    readKeys()
    const readActivity = (): void => void window.notula.localApi.getActivity().then(setActivity).catch(() => undefined)
    readActivity()
    const t = setInterval(readActivity, 5_000)
    const off = window.notula.localApi.onChanged((s) => setStatus(s))
    return () => {
      clearInterval(t)
      off()
    }
  }, [])

  const shownKeys = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? keys.filter((k) => (k.description || 'Unnamed key').toLowerCase().includes(q)) : keys
  }, [keys, query])

  if (!status) return <section className="settings-group" />

  const localOnly = prefs?.['privacy.localOnly'] === true || status.error === 'local-only'
  const companionOn = prefs?.['companionCli.enabled'] === true
  const line = localOnly
    ? LOCAL_ONLY_LINE
    : status.error === 'listen-failed'
      ? 'Notula couldn’t open the connection. Turn it off and on again.'
      : status.enabled && status.listening
        ? 'On · programs connect through a private pipe on this computer'
        : 'Off'

  const setEnabled = (on: boolean): void => {
    void window.notula.localApi.setEnabled({ enabled: on }).then(setStatus, (err: unknown) => toastError(err, 'Couldn’t change the Local API.'))
  }

  const closeDialog = (): void => setDialog(null)

  return (
    <section className="settings-group">
      <h2 className="settings-group__title">Local API</h2>
      <div className="settings-card mcp-local">
        <div className="mcp-local__hero">
          <div className="mcp-local__title">Connect your own scripts and tools</div>
          <div className="settings-row__hint">For scripts and tools on this computer. Nothing listens on the network.</div>
        </div>
        <div className="settings-row">
          <div className="settings-row__text">
            <div className="settings-row__label">Let local programs read your notes</div>
            <div className="settings-row__hint mcp-status">{line}</div>
          </div>
          <div className="settings-row__control">
            <Switch checked={status.enabled && !localOnly} disabled={localOnly} label="Let local programs read your notes" onChange={setEnabled} />
          </div>
        </div>
        {status.enabled && !localOnly ? <p className="mcp-notice">{NOTICE}</p> : null}
        {companionOn && !status.enabled && !localOnly ? (
          <p className="mcp-steps__note lapi-note">The companion CLI in Labs uses the same connection. Your keys work only while this switch is on.</p>
        ) : null}

        {status.enabled || keys.length ? (
          <div className="mcp-tokens">
            <div className="lapi-keys__head">
              <div className="mcp-steps__head">API keys</div>
              {keys.length > 3 ? (
                <input className="mcp-input lapi-search" value={query} placeholder="Search keys" aria-label="Search keys" onChange={(e) => setQuery(e.target.value)} />
              ) : null}
              <button type="button" className="n-btn n-btn--sm" disabled={!status.enabled || localOnly} onClick={() => setDialog({ kind: 'create' })}>
                Create API key
              </button>
            </div>
            {keys.length === 0 ? (
              <p className="mcp-steps__note">No API keys yet</p>
            ) : shownKeys.length === 0 ? (
              <p className="mcp-steps__note">No keys match your search</p>
            ) : (
              <div className="lapi-table" role="table" aria-label="API keys">
                <div className="lapi-table__row lapi-table__row--head" role="row">
                  <span role="columnheader">Description</span>
                  <span role="columnheader">Access</span>
                  <span role="columnheader">Status</span>
                  <span role="columnheader">Created</span>
                  <span role="columnheader">Last used</span>
                  <span role="columnheader">Expires</span>
                  <span role="columnheader" aria-label="Actions" />
                </div>
                {shownKeys.map((k) => (
                  <div key={k.id} role="row" className={`lapi-table__row${k.status === 'active' ? '' : ' is-inactive'}`}>
                    <span role="cell" className="lapi-table__name" title={k.description}>
                      {k.description || 'Unnamed key'}
                    </span>
                    <span role="cell">{access(k)}</span>
                    <span role="cell">
                      <span className={`mcp-pill${k.status === 'active' ? ' mcp-pill--ok' : ''}`}>{STATUS_LABEL[k.status]}</span>
                    </span>
                    <span role="cell">{day(k.createdAt)}</span>
                    <span role="cell">{ago(k.lastUsedAt)}</span>
                    <span role="cell">{day(k.expiresAt)}</span>
                    <span role="cell" className="lapi-table__actions">
                      {k.status === 'active' ? (
                        <>
                          <button type="button" className="n-btn n-btn--ghost n-btn--sm" onClick={() => setDialog({ kind: 'edit', key: k })}>
                            Edit
                          </button>
                          <button type="button" className="n-btn n-btn--ghost n-btn--sm" onClick={() => setDialog({ kind: 'revoke', key: k })}>
                            Revoke
                          </button>
                        </>
                      ) : (
                        <button type="button" className="n-btn n-btn--ghost n-btn--sm" onClick={() => setDialog({ kind: 'remove', key: k })}>
                          Remove
                        </button>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : null}

        {(status.enabled || companionOn) && !localOnly ? (
          <div className="mcp-tokens">
            <div className="mcp-steps__head">Recent activity</div>
            {activity.length ? (
              <ul>
                {activity.map((a, i) => (
                  <li key={`${a.at}-${i}`} className="mcp-activity__row">
                    <span className="mcp-activity__time">{new Date(a.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}</span>
                    <span className="mcp-activity__client">{a.client}</span>
                    <span className="mcp-activity__tool">{a.method}</span>
                    <span className={a.ok ? 'mcp-ok' : 'mcp-bad'}>{a.ok ? 'ok' : a.code ?? 'error'}</span>
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

      {dialog?.kind === 'create' || dialog?.kind === 'edit' ? (
        <KeyDialog
          edit={dialog.kind === 'edit' ? dialog.key : null}
          onClose={closeDialog}
          onSaved={(r) => {
            closeDialog()
            readKeys()
            if (r) setFresh(r.key)
          }}
        />
      ) : null}
      {dialog?.kind === 'revoke' ? (
        <ConfirmDialog
          title="Revoke API key?"
          body={`${dialog.key.description ? `“${dialog.key.description}”` : 'This API key'} stops working at once, and programs using it lose access. This action cannot be undone.`}
          action="Revoke"
          onDone={(ok) => {
            const k = dialog.key
            closeDialog()
            if (!ok) return
            void window.notula.localApi.revokeKey({ id: k.id }).then(
              () => {
                showToast({ kind: 'success', title: 'API key revoked' })
                readKeys()
              },
              (err: unknown) => toastError(err, 'Couldn’t revoke the API key')
            )
          }}
        />
      ) : null}
      {dialog?.kind === 'remove' ? (
        <ConfirmDialog
          title="Remove this key?"
          body="The key is already unusable. Removing it takes it off this list."
          action="Remove"
          onDone={(ok) => {
            const k = dialog.key
            closeDialog()
            if (!ok) return
            void window.notula.localApi.deleteKey({ id: k.id }).then(readKeys, (err: unknown) => toastError(err, 'Couldn’t remove the key.'))
          }}
        />
      ) : null}
      {fresh ? <FreshKeyDialog value={fresh} onClose={() => setFresh(null)} /> : null}
    </section>
  )
}
