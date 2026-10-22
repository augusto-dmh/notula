// SPDX-License-Identifier: Apache-2.0
// The Salesforce, Pipedrive and Ashby slots: Settings ▸ Integrations cards, the share-menu
// items with their "Save notes to:" record picker, and the folder-panel rows. Each shows only while
// its Labs switch is on. Credentials go to main once; nothing here holds a token.

import { useEffect, useRef, useState, type JSX } from 'react'
import { createRoot } from 'react-dom/client'
import type { IntegrationDelivery, IntegrationProvider, IntegrationSearchResult, IntegrationStatus, SalesforceOptions } from '@shared/types/integrations'
import type { IntegrationSlotProps } from '../../app/slots'
import { showToast } from '../../app/toast'
import { errorText, InlineConfirm, Modal } from '../automations/ui'
import { latestSent, openExternal, refreshStatus, useDeliveries, useStatuses, waitForDeliveries } from '../integrations/store'
import { Group, Row, Select, StatusLine, Switch, type Status } from '../settings/controls'
import { setPrefs, usePrefs } from '../settings/prefs-store'
import './plus.css'

type Plus = 'salesforce' | 'pipedrive' | 'ashby'
const NAME: Record<Plus, string> = { salesforce: 'Salesforce', pipedrive: 'Pipedrive', ashby: 'Ashby' }
const DESCRIPTION: Record<Plus, string> = {
  salesforce: 'Save meetings to Salesforce as Events and Notes on the right Contacts, Accounts and Opportunities.',
  pipedrive: 'Save meetings to Pipedrive as activities on people, organizations and deals.',
  ashby: 'Add interview notes to Ashby candidates.'
}
// Provider hosts are joined at run time: the renderer holds no provider host literal,
// since every provider request goes through main.
const host = (...parts: string[]): string => parts.join('.')
const SF_EXAMPLE = `https://${host('your-company', 'my', 'salesforce', 'com')}`
const PD_EXAMPLE = host('yourcompany', 'pipedrive', 'com')
const ASHBY_KEYS = `${host('app', 'ashbyhq', 'com')}/admin/api/keys`

const KIND_LABEL: Record<string, string> = { contact: 'Contact', lead: 'Lead', account: 'Account', opportunity: 'Opportunity', person: 'Person', organization: 'Organization', deal: 'Deal', candidate: 'Candidate' }

export function labsOn(prefs: ReturnType<typeof usePrefs>, p: IntegrationProvider): boolean {
  if (!prefs) return false
  if (p === 'salesforce') return prefs['integrations.salesforce.enabled'] === true
  return prefs['integrations.pipedriveAshby.enabled'] === true
}

function statusLine(s: IntegrationStatus | undefined, busy: boolean): Status {
  if (busy || s?.state === 'checking') return { kind: 'info', text: 'Checking...' }
  if (!s || s.state === 'not_configured') return s?.detail ? { kind: 'info', text: s.detail } : null
  if (s.blockedByLocalOnly) return { kind: 'info', text: 'Integrations are off while Local-only mode is on.' }
  if (s.state === 'connected') return { kind: 'ok', text: s.accountLabel ? `Connected to ${s.accountLabel}` : 'Connected' }
  if (s.state === 'invalid') return { kind: 'error', text: s.detail ?? 'Needs attention' }
  return { kind: 'error', text: s.detail ?? 'Couldn’t connect. Check the details and try again.' }
}

function Steps({ items }: { items: (string | JSX.Element)[] }): JSX.Element {
  return (
    <ol className="ip-steps">
      {items.map((it, i) => (
        <li key={i}>{it}</li>
      ))}
    </ol>
  )
}

const STATUS_LABEL: Record<IntegrationDelivery['status'], string> = { scheduled: 'Waiting', pending: 'Queued', sending: 'Sending', sent: 'Sent', failed: 'Failed', uncertain: 'Uncertain', cancelled: 'Undone' }

function Recent({ provider }: { provider: Plus }): JSX.Element {
  const rows = useDeliveries({ provider, limit: 20 })
  return (
    <div className="ip-section">
      <div className="ip-section__title">Recent deliveries</div>
      {rows && !rows.length ? <p className="wb-help">Notes you save or that folders send appear here.</p> : null}
      {(rows ?? []).map((d) => (
        <div key={d.id} className="ip-delivery">
          <span className={`wb-badge${d.status === 'sent' ? ' wb-badge--ok' : d.status === 'failed' ? ' wb-badge--bad' : d.status === 'uncertain' ? ' wb-badge--warn' : ''}`}>{STATUS_LABEL[d.status]}</span>
          <span className="ip-delivery__title">{d.noteTitle?.trim() || 'Untitled note'}</span>
          {d.errorMessage && d.status !== 'sent' ? <span className="ip-delivery__err">{d.errorMessage}</span> : null}
          {d.status === 'sent' && d.externalUrl ? (
            <button type="button" className="n-btn n-btn--sm" onClick={() => openExternal(d.externalUrl ?? '')}>
              Open
            </button>
          ) : d.status === 'failed' || d.status === 'uncertain' ? (
            <button type="button" className="n-btn n-btn--sm" onClick={() => void window.notula.integrations.retryDelivery({ deliveryId: d.id }).catch((err: unknown) => showToast({ kind: 'error', title: errorText(err) }))}>
              {d.status === 'uncertain' ? 'Try again' : 'Retry'}
            </button>
          ) : null}
        </div>
      ))}
    </div>
  )
}

function Disconnect({ provider, body }: { provider: Plus; body: string }): JSX.Element {
  const [asking, setAsking] = useState(false)
  if (asking) {
    return (
      <InlineConfirm
        title={`Disconnect ${NAME[provider]}?`}
        body={body}
        action="Disconnect"
        onCancel={() => setAsking(false)}
        onConfirm={() => {
          setAsking(false)
          void window.notula.integrations
            .removeCredential({ provider })
            .then(() => {
              showToast({ title: `${NAME[provider]} disconnected` })
              return refreshStatus(provider)
            })
            .catch(() => showToast({ kind: 'error', title: `Couldn’t disconnect ${NAME[provider]}. Try again.` }))
        }}
      />
    )
  }
  return (
    <button type="button" className="n-btn n-btn--sm n-btn--danger" onClick={() => setAsking(true)}>
      Disconnect
    </button>
  )
}

// ---------- Salesforce ----------

function SalesforceOptionsRows(): JSX.Element | null {
  const prefs = usePrefs()
  if (!prefs) return null
  const o = prefs['integrations.salesforce.options']
  const set = (patch: Partial<SalesforceOptions>): void => {
    try {
      setPrefs({ 'integrations.salesforce.options': { ...o, ...patch } })
    } catch {
      showToast({ kind: 'error', title: 'Couldn’t update the Salesforce setting' })
    }
  }
  return (
    <>
      {o.eventHandling === 'none' && !o.contentNoteEnabled ? <p className="wb-warning">Events and Notes are both off, so nothing is saved to Salesforce. Turn one on.</p> : null}
      <Row label="Events" hint="Each meeting you push becomes an Event on its attendees’ Salesforce timelines.">
        <Switch label="Events" checked={o.eventHandling !== 'none'} onChange={(v) => set({ eventHandling: v ? 'create_new' : 'none' })} />
      </Row>
      {o.eventHandling !== 'none' ? (
        <>
          <Row label="Event creation" hint="Always create a new Salesforce Event for each meeting, or update a matching Event and create one only when none exists.">
            <Select
              label="Event creation"
              value={o.eventHandling}
              options={[
                { value: 'create_new', label: 'Always create new event' },
                { value: 'match_else_create', label: 'Update a matching event, or create one' }
              ]}
              onChange={(v) => set({ eventHandling: v })}
            />
          </Row>
          <Row label="Event description body" hint="Choose what goes in the Event’s description: Notula’s meeting summary or the calendar invite’s own text.">
            <Select
              label="Event description body"
              value={o.eventBodySource}
              options={[
                { value: 'meeting_summary', label: 'Notula meeting summary' },
                { value: 'event_description', label: 'Calendar event description' }
              ]}
              onChange={(v) => set({ eventBodySource: v })}
            />
          </Row>
          <Row label="Relate event to" hint="Choose which Salesforce record each Event is linked to: an opportunity, an account, or none.">
            <Select
              label="Relate event to"
              value={o.eventWhatId}
              options={[
                { value: 'opportunity', label: 'Opportunity' },
                { value: 'account', label: 'Account' },
                { value: 'none', label: 'None' }
              ]}
              onChange={(v) => set({ eventWhatId: v })}
            />
          </Row>
        </>
      ) : null}
      <Row label="Notes" hint="Adds a Salesforce Note with the formatted summary, linked to the matching Accounts, Opportunities and Contacts.">
        <Switch label="Notes" checked={o.contentNoteEnabled} onChange={(v) => set({ contentNoteEnabled: v })} />
      </Row>
    </>
  )
}

function SalesforceSetup({ status }: { status: IntegrationStatus | undefined }): JSX.Element {
  const [url, setUrl] = useState('')
  const [key, setKey] = useState('')
  const [secret, setSecret] = useState('')
  const [waiting, setWaiting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const connect = async (): Promise<void> => {
    setError(null)
    if (key.trim() || url.trim()) {
      try {
        await window.notula.integrations.setCredential({ provider: 'salesforce', kind: 'oauth-client', value: JSON.stringify({ key: key.trim(), ...(secret.trim() ? { secret: secret.trim() } : {}) }), label: url.trim() })
        setKey('')
        setSecret('')
      } catch (err) {
        setError(errorText(err))
        return
      }
    }
    setWaiting(true)
    try {
      await window.notula.integrations.connectOAuth({ provider: 'salesforce' })
      await window.notula.integrations.validate({ provider: 'salesforce' }).catch(() => undefined)
      showToast({ kind: 'success', title: 'Salesforce connected' })
    } catch (err) {
      setError(errorText(err))
    } finally {
      setWaiting(false)
      void refreshStatus('salesforce')
    }
  }
  const hasClient = !!status?.detail
  return (
    <div className="ip-setup">
      <Steps
        items={[
          <>
            In Salesforce Setup, search for <b>External Client App Manager</b> and click <b>New External Client App</b>. (An existing <b>Connected App</b> works the same.)
          </>,
          <>
            Name it Notula. Under <b>OAuth Settings</b>, turn on <b>Enable OAuth</b>, set the <b>Callback URL</b> to <code>http://localhost:47615/salesforce/callback</code>, and add the scopes <b>Manage user data via APIs (api)</b> and{' '}
            <b>Perform requests at any time (refresh_token, offline_access)</b>.
          </>,
          <>
            Turn on <b>Require Proof Key for Code Exchange (PKCE)</b> and turn off <b>Require secret for Web Server Flow</b>. Save.
          </>,
          <>
            Copy the <b>Consumer Key</b> and paste it below, with your Salesforce URL (for example {SF_EXAMPLE}).
          </>
        ]}
      />
      {waiting ? (
        <div className="ip-waiting">
          <p>Finish signing in to Salesforce in your browser, then come back to Notula.</p>
          <p className="wb-help">Waiting for connection…</p>
          <button type="button" className="n-btn n-btn--sm" onClick={() => void window.notula.integrations.cancelOAuth({ provider: 'salesforce' })}>
            Cancel
          </button>
        </div>
      ) : (
        <div className="ip-form">
          <input className="n-input" aria-label="Salesforce URL" placeholder="Salesforce URL" value={url} onChange={(e) => setUrl(e.target.value)} />
          <input className="n-input" aria-label="Consumer key" type="password" autoComplete="off" placeholder={hasClient ? 'Consumer key (saved)' : 'Consumer key'} value={key} onChange={(e) => setKey(e.target.value)} />
          <input className="n-input" aria-label="Consumer secret" type="password" autoComplete="off" placeholder="Consumer secret (only if your app requires one)" value={secret} onChange={(e) => setSecret(e.target.value)} />
          <div className="wb-actions" style={{ justifyContent: 'flex-start' }}>
            <button type="button" className="n-btn n-btn--primary" disabled={!hasClient && (!key.trim() || !url.trim())} onClick={() => void connect()}>
              Connect
            </button>
          </div>
        </div>
      )}
      {error ? <p className="wb-error">{error}</p> : null}
    </div>
  )
}

// ---------- Pipedrive and Ashby setup ----------

function TokenSetup({ provider }: { provider: 'pipedrive' | 'ashby' }): JSX.Element {
  const [company, setCompany] = useState('')
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const save = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const s = await window.notula.integrations.setCredential(provider === 'pipedrive' ? { provider, kind: 'pipedrive-token', value: value.trim(), label: company.trim() } : { provider, kind: 'ashby-key', value: value.trim() })
      setValue('')
      if (s.state === 'invalid') setError(s.detail ?? 'That credential didn’t work.')
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
      void refreshStatus(provider)
    }
  }
  return (
    <div className="ip-setup">
      {provider === 'pipedrive' ? (
        <Steps
          items={[
            <>
              In Pipedrive, open your account menu, then <b>Personal preferences</b> ▸ <b>API</b>.
            </>,
            <>
              Copy <b>Your personal API token</b> and paste it below, with your company address (for example {PD_EXAMPLE}).
            </>,
            'Notula sees everything your Pipedrive user can see. Don’t regenerate the token while Notula uses it, or reconnect afterwards.'
          ]}
        />
      ) : (
        <Steps
          items={[
            <>
              In Ashby, go to <b>Admin</b> ▸ <b>API Keys</b> ({ASHBY_KEYS}) and create a key named Notula.
            </>,
            <>
              Give it <b>Candidates: read</b> and <b>Candidates: write</b>.
            </>,
            'Copy the key and paste it below.'
          ]}
        />
      )}
      <div className="ip-form">
        {provider === 'pipedrive' ? <input className="n-input" aria-label="Company address" placeholder="Company address" value={company} onChange={(e) => setCompany(e.target.value)} /> : null}
        <input className="n-input" aria-label={provider === 'pipedrive' ? 'API token' : 'API key'} type="password" autoComplete="off" spellCheck={false} placeholder={provider === 'pipedrive' ? 'API token' : 'API key'} value={value} onChange={(e) => setValue(e.target.value)} />
        <div className="wb-actions" style={{ justifyContent: 'flex-start' }}>
          <button type="button" className="n-btn n-btn--primary" disabled={busy || !value.trim() || (provider === 'pipedrive' && !company.trim())} onClick={() => void save()}>
            Connect
          </button>
        </div>
      </div>
      {error ? <p className="wb-error">{error}</p> : null}
    </div>
  )
}

// ---------- the settings card ----------

export function PlusSettingsCard({ provider }: IntegrationSlotProps['settings-card']): JSX.Element | null {
  const p = provider as Plus
  const prefs = usePrefs()
  const statuses = useStatuses()
  const status = statuses?.[p]
  const [open, setOpen] = useState(false)
  const on = labsOn(prefs, p)
  useEffect(() => {
    if (on) void refreshStatus(p)
  }, [on, p])
  if (!on) return null
  const connected = !!status && status.state !== 'not_configured'
  return (
    <Group title={NAME[p]} description={DESCRIPTION[p]}>
      <Row label={connected ? (status?.state === 'connected' ? 'Connected' : 'Needs attention') : 'Not connected'} hint={p === 'salesforce' ? 'Labs: not yet verified against a Salesforce Developer Edition org.' : undefined}>
        <button type="button" className="n-btn n-btn--sm" onClick={() => setOpen((v) => !v)}>
          {open ? 'Close' : connected ? 'Manage' : 'Set up'}
        </button>
      </Row>
      <div className="ip-body">
        <StatusLine status={statusLine(status, false)} />
      </div>
      {open ? (
        <div className="ip-body">
          {status?.state === 'connected' || status?.state === 'invalid' || status?.state === 'unreachable' ? (
            <>
              {status.state !== 'connected' && p === 'salesforce' ? <SalesforceSetup status={status} /> : null}
              {status.state !== 'connected' && p !== 'salesforce' ? <TokenSetup provider={p} /> : null}
              {p === 'salesforce' ? <SalesforceOptionsRows /> : null}
              {p === 'pipedrive' && prefs ? (
                <Row label="Mark activities as done" hint="When on, activities Notula creates in Pipedrive are marked as done, since the meeting is over.">
                  <Switch label="Mark activities as done" checked={prefs['integrations.pipedrive.activityDone']} onChange={(v) => setPrefs({ 'integrations.pipedrive.activityDone': v })} />
                </Row>
              ) : null}
              <Recent provider={p} />
              <div className="ip-section">
                <Disconnect provider={p} body={p === 'salesforce' ? 'Notula will forget your Salesforce connection.' : p === 'pipedrive' ? 'Notula will forget your Pipedrive token.' : 'Notula will forget your Ashby key.'} />
              </div>
            </>
          ) : p === 'salesforce' ? (
            <SalesforceSetup status={status} />
          ) : (
            <TokenSetup provider={p} />
          )}
        </div>
      ) : null}
    </Group>
  )
}

// ---------- the save dialog ----------

interface Open {
  provider: Plus
  noteId: string
  panelId: string | null
}
let openDialog: Open | null = null
const dialogListeners = new Set<() => void>()
function setDialog(d: Open | null): void {
  openDialog = d
  for (const l of dialogListeners) l()
}

function SaveDialog({ d }: { d: Open }): JSX.Element {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<IntegrationSearchResult[] | null>(null)
  const [picked, setPicked] = useState<IntegrationSearchResult[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const min = d.provider === 'pipedrive' ? 2 : 3

  useEffect(() => {
    let alive = true
    window.notula.integrations
      .search({ provider: d.provider, noteId: d.noteId })
      .then((r) => {
        if (!alive) return
        setResults(r)
        setPicked(r.filter((x) => x.suggested))
      })
      .catch((err: unknown) => {
        if (!alive) return
        setResults([])
        setError(errorText(err))
      })
    return () => {
      alive = false
    }
  }, [d])

  const search = (text: string): void => {
    setQuery(text)
    if (timer.current) clearTimeout(timer.current)
    if (text.trim().length < min) return
    timer.current = setTimeout(() => {
      window.notula.integrations
        .search({ provider: d.provider, query: text.trim() })
        .then(setResults)
        .catch((err: unknown) => setError(errorText(err)))
    }, 500)
  }
  const toggle = (r: IntegrationSearchResult): void => setPicked((list) => (list.some((x) => x.id === r.id) ? list.filter((x) => x.id !== r.id) : [...list, r]))
  const save = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const { deliveryIds } = await window.notula.integrations.share({ provider: d.provider, noteId: d.noteId, panelId: d.panelId, targets: picked.map((r) => ({ kind: r.kind, id: r.id, label: r.label })) })
      setDialog(null)
      const id = `plus-${d.provider}-${d.noteId}`
      showToast({ id, title: `Saving to ${NAME[d.provider]}...`, durationMs: 60_000 })
      const rows = await waitForDeliveries(deliveryIds, d.noteId)
      const failed = rows.find((r) => r.status !== 'sent')
      const url = rows.find((r) => r.externalUrl)?.externalUrl
      if (failed) showToast({ id, kind: failed.status === 'uncertain' ? 'info' : 'error', title: failed.errorMessage ?? `Error saving to ${NAME[d.provider]}` })
      else showToast({ id, kind: 'success', title: `Saved to ${NAME[d.provider]}`, ...(url ? { action: { label: 'Open', onClick: () => openExternal(url) } } : {}) })
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }
  const list = results ?? []
  return (
    <Modal
      title="Save notes to:"
      onClose={() => setDialog(null)}
      footer={
        <>
          <button type="button" className="n-btn" onClick={() => setDialog(null)}>
            Cancel
          </button>
          <button type="button" className="n-btn n-btn--primary" disabled={busy || !picked.length} onClick={() => void save()}>
            Save to {NAME[d.provider]}
          </button>
        </>
      }
    >
      {picked.length ? (
        <div className="wb-item__chips">
          {picked.map((r) => (
            <span key={r.id} className="wb-chip">
              {KIND_LABEL[r.kind] ?? r.kind}: {r.label}
              <button type="button" className="wb-chip__x" aria-label={`Remove ${r.label}`} onClick={() => toggle(r)}>
                ×
              </button>
            </span>
          ))}
        </div>
      ) : null}
      <input className="n-input" autoFocus placeholder={d.provider === 'ashby' ? 'Search candidates' : 'Search related records'} value={query} onChange={(e) => search(e.target.value)} aria-label="Search records" />
      <div className="ip-results">
        {results === null ? <div className="n-skeleton" style={{ height: 60 }} /> : null}
        {results && !list.length ? <div className="wb-empty">No matching records. Type a name to search.</div> : null}
        {list.map((r) => (
          <button key={`${r.kind}:${r.id}`} type="button" className="ip-result" aria-pressed={picked.some((x) => x.id === r.id)} onClick={() => toggle(r)}>
            <span className="ip-result__kind">{KIND_LABEL[r.kind] ?? r.kind}</span>
            <span className="ip-result__label">{r.label}</span>
            {r.subtitle ? <span className="ip-result__sub">{r.subtitle}</span> : null}
          </button>
        ))}
      </div>
      {error ? <p className="wb-error">{error}</p> : null}
    </Modal>
  )
}

function DialogHost(): JSX.Element | null {
  const [, force] = useState(0)
  useEffect(() => {
    const l = (): void => force((n) => n + 1)
    dialogListeners.add(l)
    return () => {
      dialogListeners.delete(l)
    }
  }, [])
  return openDialog ? <SaveDialog key={`${openDialog.provider}:${openDialog.noteId}`} d={openDialog} /> : null
}

let hostMounted = false
export function mountDialogHost(): void {
  if (hostMounted || typeof document === 'undefined') return
  hostMounted = true
  const el = document.createElement('div')
  el.id = 'notula-integrations-plus'
  document.body.appendChild(el)
  createRoot(el).render(<DialogHost />)
}

// ---------- share items and folder rows ----------

export function PlusShareItem({ provider, noteId, panelId, onDone }: IntegrationSlotProps['share-item']): JSX.Element | null {
  const p = provider as Plus
  const prefs = usePrefs()
  const statuses = useStatuses()
  const rows = useDeliveries({ noteId, provider: p, limit: 10 })
  if (!labsOn(prefs, p) || statuses?.[p]?.state !== 'connected') return null
  const sent = latestSent(rows, p)
  return (
    <>
      <button
        type="button"
        className="ip-share-item"
        role="menuitem"
        onClick={() => {
          onDone()
          setDialog({ provider: p, noteId, panelId })
        }}
      >
        Save to {NAME[p]}
      </button>
      {sent?.externalUrl ? (
        <button
          type="button"
          className="ip-share-item"
          role="menuitem"
          onClick={() => {
            onDone()
            openExternal(sent.externalUrl ?? '')
          }}
        >
          Open in {NAME[p]}
        </button>
      ) : null}
    </>
  )
}

export function PlusFolderRow({ provider, folderId }: IntegrationSlotProps['folder-row']): JSX.Element | null {
  const p = provider as Plus
  const prefs = usePrefs()
  const statuses = useStatuses()
  const [enabled, setEnabled] = useState<boolean | null>(null)
  useEffect(() => {
    let alive = true
    window.notula.integrations
      .listAutomations({ folderId, provider: p })
      .then((a) => alive && setEnabled(a.some((x) => x.enabled)))
      .catch(() => alive && setEnabled(false))
    return () => {
      alive = false
    }
  }, [folderId, p])
  if (!labsOn(prefs, p) || statuses?.[p]?.state !== 'connected' || enabled === null) return null
  return (
    <Row label={`Sync to ${NAME[p]}`} hint={`Notula saves each note filed in this folder to ${NAME[p]}.`}>
      <Switch
        label={`Sync to ${NAME[p]}`}
        checked={enabled}
        onChange={(v) => {
          setEnabled(v)
          void window.notula.integrations.setAutomation({ folderId, provider: p, enabled: v }).catch((err: unknown) => {
            setEnabled(!v)
            showToast({ kind: 'error', title: errorText(err) })
          })
        }}
      />
    </Row>
  )
}
