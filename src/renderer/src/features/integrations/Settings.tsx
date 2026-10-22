// SPDX-License-Identifier: Apache-2.0
// Settings ▸ Integrations: the list of
// providers, and per provider (`?provider=<id>`) its Connect steps, options, Recent
// deliveries with Retry or Open, and Disconnect. Credentials go to main once and come
// back masked; nothing on this page ever holds a saved credential or webhook URL.

import { useEffect, useRef, useState, type JSX, type ReactNode } from 'react'
import type { IntegrationDelivery, IntegrationDestination, IntegrationProvider, IntegrationSearchResult, IntegrationStatus } from '@shared/types/integrations'
import { navigate, useRoute } from '../../app/navigation'
import { integrationSlots, useSlotsVersion } from '../../app/slots'
import { showToast } from '../../app/toast'
import { HeldSendsReview } from '../local-only'
import { MailAccountsRows } from '../mail'
import { Group, Row, Segmented, Select, StatusLine, Switch, type Status } from '../settings/controls'
import { setPrefs, usePrefs } from '../settings/prefs-store'
import { WebhooksSettings } from '../webhooks'
import { settingsPath } from './ShareMenu'
import { ago, AUTOMATIONS_COPY, errorText, LOCAL_ONLY_COPY, openExternal, PROVIDER_META, PROVIDER_ORDER, refreshStatus, useDeliveries, useStatuses } from './store'
import './integrations.css'

const STALE_MS = 86_400_000

function statusText(s: IntegrationStatus | undefined): string {
  if (!s || s.state === 'not_configured') return 'Not connected'
  if (s.state === 'checking') return 'Checking...'
  if (s.state === 'connected') return s.accountLabel ? `Connected to ${s.accountLabel}` : 'Connected'
  if (s.state === 'invalid') return 'Needs attention'
  return 'Couldn’t check'
}

function Steps({ items }: { items: ReactNode[] }): JSX.Element {
  return (
    <ol className="int-steps">
      {items.map((it, i) => (
        <li key={i}>{it}</li>
      ))}
    </ol>
  )
}

function Confirm({ title, body, action, onConfirm, onCancel }: { title: string; body: string; action: string; onConfirm(): void; onCancel(): void }): JSX.Element {
  return (
    <div className="int-inline-confirm" role="alertdialog" aria-label={title}>
      <strong>{title}</strong>
      <p>{body}</p>
      <div className="int-row-actions">
        <button type="button" className="n-btn n-btn--sm" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="n-btn n-btn--sm n-btn--danger" onClick={onConfirm}>
          {action}
        </button>
      </div>
    </div>
  )
}

// ---------- credential form ----------

function CredentialForm({
  provider,
  kind,
  label,
  placeholder,
  status,
  copy,
  autoSaveMs
}: {
  provider: Exclude<IntegrationProvider, 'zapier'>
  kind: 'slack-bot-token' | 'notion-token' | 'hubspot-token' | 'attio-token' | 'affinity-key'
  label: string
  placeholder: string
  status: IntegrationStatus | undefined
  copy: { connected: (s: IntegrationStatus) => string; invalid: string; unreachable: string }
  /** Affinity: save 300 ms after typing stops. */
  autoSaveMs?: number
}): JSX.Element {
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const id = `int-cred-${provider}`

  const save = async (v: string): Promise<void> => {
    if (!v.trim()) return
    setBusy(true)
    setError(null)
    try {
      await window.notula.integrations.setCredential({ provider, kind, value: v.trim() })
      setValue('')
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
      void refreshStatus(provider)
    }
  }
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current)
  }, [])

  let line: Status = null
  if (error) line = { kind: 'error', text: error }
  else if (busy || status?.state === 'checking') line = { kind: 'info', text: 'Checking...' }
  else if (status?.blockedByLocalOnly && status.state !== 'not_configured') line = { kind: 'info', text: LOCAL_ONLY_COPY }
  else if (status?.state === 'connected') line = { kind: 'ok', text: copy.connected(status) }
  else if (status?.state === 'invalid') line = { kind: 'error', text: status.detail ?? copy.invalid }
  else if (status?.state === 'unreachable') line = { kind: 'error', text: status.detail ?? copy.unreachable }

  return (
    <div className="int-cred">
      <label className="int-label" htmlFor={id}>
        {label}
      </label>
      <div className="int-cred__row">
        <input
          id={id}
          className="n-input int-input"
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={status?.maskedCredential ?? placeholder}
          value={value}
          onChange={(e) => {
            const v = e.target.value
            setValue(v)
            if (autoSaveMs) {
              if (timer.current) clearTimeout(timer.current)
              timer.current = setTimeout(() => void save(v), autoSaveMs)
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void save(value)
          }}
        />
        {autoSaveMs ? null : (
          <button type="button" className="n-btn n-btn--primary" disabled={busy || !value.trim()} onClick={() => void save(value)}>
            {status && status.state !== 'not_configured' ? 'Update' : 'Connect'}
          </button>
        )}
      </div>
      <StatusLine status={line} />
    </div>
  )
}

// ---------- recent deliveries ----------

const STATUS_LABEL: Record<IntegrationDelivery['status'], string> = {
  scheduled: 'Waiting',
  pending: 'Queued',
  sending: 'Sending',
  sent: 'Sent',
  failed: 'Failed',
  uncertain: 'Uncertain',
  cancelled: 'Undone'
}

function RecentDeliveries({ provider }: { provider: IntegrationProvider }): JSX.Element {
  const rows = useDeliveries({ provider, limit: 20 })
  const [busy, setBusy] = useState<string | null>(null)
  const retry = async (d: IntegrationDelivery): Promise<void> => {
    setBusy(d.id)
    try {
      const r = await window.notula.integrations.retryDelivery({ deliveryId: d.id })
      if (r.status === 'sent') showToast({ kind: 'success', title: 'Sent' })
      else showToast({ kind: 'error', title: r.errorMessage ?? 'Still not sent.' })
    } catch (err) {
      showToast({ kind: 'error', title: errorText(err) })
    } finally {
      setBusy(null)
    }
  }
  return (
    <Group title="Recent deliveries">
      {rows && !rows.length ? <Row label="Nothing sent yet" hint="Notes you send or that folders send appear here." /> : null}
      {(rows ?? []).map((d) => (
        <Row
          key={d.id}
          label={
            <span className="int-delivery">
              <span className={`int-badge int-badge--${d.status}`}>{STATUS_LABEL[d.status]}</span>
              <span className="int-delivery__title">{d.noteTitle?.trim() || 'Untitled note'}</span>
            </span>
          }
          hint={
            <>
              {ago(d.sentAt ?? d.updatedAt)}
              {d.trigger === 'folder' ? ' · from a folder' : d.trigger === 'test' ? ' · test' : ''}
              {d.status === 'failed' && d.nextAttemptAt ? ' · retrying automatically' : ''}
              {d.errorMessage && d.status !== 'sent' ? ` · ${d.errorMessage}` : ''}
            </>
          }
        >
          {d.status === 'sent' && d.externalUrl ? (
            <button type="button" className="n-btn n-btn--sm" onClick={() => openExternal(d.externalUrl ?? '')}>
              Open
            </button>
          ) : d.status === 'failed' || d.status === 'uncertain' ? (
            <button type="button" className="n-btn n-btn--sm" disabled={busy === d.id || d.errorCode === 'no_records'} onClick={() => void retry(d)}>
              {d.status === 'uncertain' ? 'Try again' : 'Retry'}
            </button>
          ) : d.status === 'scheduled' || d.status === 'pending' ? (
            <button type="button" className="n-btn n-btn--sm n-btn--ghost" onClick={() => void window.notula.integrations.cancelDelivery({ deliveryId: d.id }).catch(() => {})}>
              Cancel
            </button>
          ) : undefined}
        </Row>
      ))}
    </Group>
  )
}

function Disconnect({ provider, title, body, action = 'Disconnect', label }: { provider: IntegrationProvider; title: string; body: string; action?: string; label?: string }): JSX.Element {
  const [asking, setAsking] = useState(false)
  const name = PROVIDER_META[provider].name
  return (
    <Group title={label ?? 'Disconnect'}>
      {asking ? (
        <Confirm
          title={title}
          body={body}
          action={action}
          onCancel={() => setAsking(false)}
          onConfirm={() => {
            setAsking(false)
            window.notula.integrations
              .removeCredential({ provider })
              .then(() => showToast({ title: `${name} disconnected` }))
              .catch(() => showToast({ kind: 'error', title: `Couldn’t disconnect ${name}. Try again.` }))
          }}
        />
      ) : (
        <Row label={label ?? `Disconnect ${name}`} hint={body}>
          <button type="button" className="n-btn n-btn--sm n-btn--danger" onClick={() => setAsking(true)}>
            {action}
          </button>
        </Row>
      )}
    </Group>
  )
}

// ---------- providers ----------

function SlackPage({ status }: { status: IntegrationStatus | undefined }): JSX.Element {
  const prefs = usePrefs()
  const mode = prefs?.['integrations.slack.mode'] ?? 'bot'
  const [hooks, setHooks] = useState<IntegrationDestination[]>([])
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [line, setLine] = useState<Status>(null)
  const load = (): void => void window.notula.integrations.listDestinations({ provider: 'slack' }).then((d) => setHooks(d.filter((x) => x.kind === 'slack-webhook')))
  useEffect(load, [status])
  const add = async (): Promise<void> => {
    setLine(null)
    try {
      await window.notula.integrations.saveDestination({ provider: 'slack', kind: 'slack-webhook', label: name, secretValue: url })
      setName('')
      setUrl('')
      load()
    } catch (err) {
      setLine({ kind: 'error', text: errorText(err) })
    }
  }
  const test = async (d: IntegrationDestination): Promise<void> => {
    try {
      const r = await window.notula.integrations.testDestination({ destinationId: d.id })
      showToast(r.status === 'sent' ? { kind: 'success', title: `Sent to #${d.label}` } : { kind: 'error', title: r.errorMessage ?? 'Couldn’t send to Slack. Try again.' })
    } catch (err) {
      showToast({ kind: 'error', title: errorText(err) })
    }
  }
  return (
    <>
      <Group title="Connect">
        <Row label="How Notula posts" hint={mode === 'bot' ? 'Bot token (recommended): post to any channel.' : 'Incoming webhooks: one channel each.'}>
          <Segmented
            label="How Notula posts"
            value={mode}
            options={[
              { value: 'bot', label: 'Bot token' },
              { value: 'webhook', label: 'Webhooks' }
            ]}
            onChange={(v) => setPrefs({ 'integrations.slack.mode': v })}
          />
        </Row>
        {mode === 'bot' ? (
          <Row
            stacked
            label="Bot token"
            hint={
              <Steps
                items={[
                  <>Go to api.slack.com/apps, click <b>Create New App</b>, then <b>From scratch</b>. Name it Notula and choose your workspace.</>,
                  <>Open <b>OAuth &amp; Permissions</b>. Under <b>Bot Token Scopes</b>, add <code>chat:write</code>, <code>chat:write.public</code>, <code>chat:write.customize</code>, <code>channels:read</code> and <code>groups:read</code>.</>,
                  <>Click <b>Install to Workspace</b> and allow access.</>,
                  <>Copy the <b>Bot User OAuth Token</b> (it starts with <code>xoxb-</code>) and paste it below.</>
                ]}
              />
            }
          >
            <CredentialForm
              provider="slack"
              kind="slack-bot-token"
              label="Bot token"
              placeholder="xoxb-…"
              status={status}
              copy={{ connected: (s) => `Connected to ${s.accountLabel ?? 'Slack'}`, invalid: 'Slack didn’t accept this token. Check it and try again.', unreachable: 'Couldn’t reach Slack. Check your connection and try again.' }}
            />
          </Row>
        ) : (
          <Row
            stacked
            label="Incoming webhooks"
            hint={
              <Steps
                items={[
                  <>Go to api.slack.com/apps, click <b>Create New App</b>, then <b>From scratch</b>.</>,
                  <>Open <b>Incoming Webhooks</b> and turn on <b>Activate Incoming Webhooks</b>.</>,
                  <>Click <b>Add New Webhook to Workspace</b>, pick a channel and click <b>Authorize</b>. For a private channel, join it first.</>,
                  <>Copy the webhook URL and paste it below, with the channel’s name.</>
                ]}
              />
            }
          >
            <div className="int-form">
              <input className="n-input int-input" aria-label="Channel name" placeholder="#general" value={name} onChange={(e) => setName(e.target.value)} />
              <input className="n-input int-input" aria-label="Webhook URL" type="password" autoComplete="off" placeholder="Webhook URL from Slack" value={url} onChange={(e) => setUrl(e.target.value)} />
              <button type="button" className="n-btn n-btn--primary" disabled={!name.trim() || !url.trim()} onClick={() => void add()}>
                Add channel
              </button>
            </div>
            <StatusLine status={line} />
          </Row>
        )}
        {mode === 'webhook'
          ? hooks.map((h) => (
              <Row key={h.id} label={`#${h.label}`} hint={h.status === 'disconnected' ? h.lastError ?? 'This Slack webhook no longer works.' : h.maskedSecret ?? undefined}>
                <div className="int-row-actions">
                  <button type="button" className="n-btn n-btn--sm" onClick={() => void test(h)}>
                    Send test message
                  </button>
                  <button type="button" className="n-btn n-btn--sm n-btn--ghost" onClick={() => void window.notula.integrations.removeCredential({ provider: 'slack', destinationId: h.id }).then(load)}>
                    Remove
                  </button>
                </div>
              </Row>
            ))
          : null}
      </Group>
      {mode === 'bot' && status?.state === 'connected' ? (
        <Group title="Adding private channels">
          <Row label="In Slack, open the private channel and add your app to it (/invite @your-app-name). Notula can then post there." />
        </Group>
      ) : null}
    </>
  )
}

function NotionTarget(): JSX.Element {
  const [target, setTarget] = useState<IntegrationDestination | null | undefined>(undefined)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<IntegrationSearchResult[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [picking, setPicking] = useState(false)
  const [dateProps, setDateProps] = useState<string[]>([])
  const load = (): void => void window.notula.integrations.listDestinations({ provider: 'notion' }).then((d) => setTarget(d[0] ?? null))
  useEffect(load, [])
  // A database target's date-type properties come from its search entry.
  useEffect(() => {
    if (!target || target.options.notionTargetType !== 'data_source') return
    window.notula.integrations
      .search({ provider: 'notion', query: target.label })
      .then((r) => {
        const hit = r.find((x) => x.id === target.externalId)
        if (hit) setDateProps(String(hit.extra?.['dateProperties'] ?? '').split('\n').filter(Boolean))
      })
      .catch(() => {})
  }, [target])
  useEffect(() => {
    if (!picking) return
    const t = setTimeout(() => {
      window.notula.integrations
        .search({ provider: 'notion', ...(query.trim() ? { query: query.trim() } : {}) })
        .then((r) => {
          setResults(r)
          setError(null)
        })
        .catch((err) => setError(errorText(err)))
    }, 300)
    return () => clearTimeout(t)
  }, [query, picking])
  const choose = async (r: IntegrationSearchResult): Promise<void> => {
    try {
      const isDb = r.kind === 'data_source'
      const url = typeof r.extra?.['url'] === 'string' ? r.extra['url'] : undefined
      await window.notula.integrations.saveDestination({
        provider: 'notion',
        kind: 'notion-target',
        label: r.label,
        externalId: r.id,
        options: {
          notionTargetType: isDb ? 'data_source' : 'page',
          ...(isDb && typeof r.extra?.['titleProperty'] === 'string' ? { notionTitleProperty: r.extra['titleProperty'] } : {}),
          notionDateProperty: null,
          ...(url ? { notionUrl: url } : {})
        }
      })
      setDateProps(isDb ? String(r.extra?.['dateProperties'] ?? '').split('\n').filter(Boolean) : [])
      setPicking(false)
      load()
    } catch (err) {
      setError(errorText(err))
    }
  }
  const setDate = async (v: string): Promise<void> => {
    if (!target) return
    await window.notula.integrations.saveDestination({ id: target.id, provider: 'notion', kind: 'notion-target', label: target.label, externalId: target.externalId, options: { ...target.options, notionDateProperty: v || null } }).catch(() => {})
    load()
  }
  return (
    <Group title="Save notes to">
      {target && !picking ? (
        <Row label={target.label} hint={target.status === 'disconnected' ? target.lastError ?? undefined : target.options.notionTargetType === 'data_source' ? 'Database: each note becomes a row' : 'Page: each note becomes a child page'}>
          <button type="button" className="n-btn n-btn--sm" onClick={() => setPicking(true)}>
            Change
          </button>
        </Row>
      ) : (
        <Row stacked label="Pick a database or a page" hint="Type a title to find it.">
          <input className="n-input int-input" placeholder="Search Notion" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search Notion" />
          <div className="int-list">
            {results && !results.length ? <div className="int-empty">No pages found. Share a page with your connection, or use a personal access token.</div> : null}
            {(results ?? []).map((r) => (
              <button key={r.id} type="button" className="int-option" onClick={() => void choose(r)}>
                <span className="int-option__main">{r.label}</span>
                <span className="int-option__kind">{r.subtitle}</span>
              </button>
            ))}
          </div>
          {error ? <p className="int-error">{error}</p> : null}
          {!picking && !target ? (
            <button type="button" className="n-btn n-btn--sm" onClick={() => setPicking(true)}>
              Find pages
            </button>
          ) : null}
        </Row>
      )}
      {target && target.options.notionTargetType === 'data_source' && !picking ? (
        <Row label="Date property" hint="The meeting start goes here.">
          <Select
            label="Date property"
            value={target.options.notionDateProperty ?? ''}
            options={[{ value: '', label: 'None' }, ...[...new Set([...dateProps, ...(target.options.notionDateProperty ? [target.options.notionDateProperty] : [])])].map((p) => ({ value: p, label: p }))]}
            onChange={(v) => void setDate(v)}
          />
        </Row>
      ) : null}
    </Group>
  )
}

function ZapierPage(): JSX.Element {
  const [rows, setRows] = useState<IntegrationDestination[]>([])
  const [editing, setEditing] = useState<IntegrationDestination | 'new' | null>(null)
  const [form, setForm] = useState({ label: '', url: '', trigger: 'share' as 'share' | 'folder', transcript: false })
  const [line, setLine] = useState<Status>(null)
  const load = (): void => void window.notula.integrations.listDestinations({ provider: 'zapier' }).then(setRows)
  useEffect(load, [])
  const edit = (d: IntegrationDestination | 'new'): void => {
    setEditing(d)
    setLine(null)
    setForm(d === 'new' ? { label: '', url: '', trigger: 'share', transcript: false } : { label: d.label, url: '', trigger: d.trigger ?? 'share', transcript: d.options.zapierIncludeTranscript === true })
  }
  const save = async (andTest: boolean): Promise<void> => {
    setLine(null)
    try {
      const d = await window.notula.integrations.saveDestination({
        ...(editing && editing !== 'new' ? { id: editing.id } : {}),
        provider: 'zapier',
        kind: 'zapier-hook',
        label: form.label.trim() || 'Untitled workflow',
        trigger: form.trigger,
        ...(form.url.trim() ? { secretValue: form.url.trim() } : {}),
        options: { zapierIncludeTranscript: form.transcript }
      })
      load()
      if (andTest) await test(d)
      else setEditing(null)
    } catch (err) {
      setLine({ kind: 'error', text: errorText(err) })
    }
  }
  const test = async (d: IntegrationDestination): Promise<void> => {
    try {
      const r = await window.notula.integrations.testDestination({ destinationId: d.id })
      const ok = r.status === 'sent'
      setLine(ok ? { kind: 'ok', text: 'Test note sent. Now click Test trigger in Zapier.' } : { kind: 'error', text: r.errorMessage ?? 'Couldn’t send to Zapier. Try again in a minute.' })
      showToast(ok ? { kind: 'success', title: 'Test note sent. Now click Test trigger in Zapier.' } : { kind: 'error', title: r.errorMessage ?? 'Couldn’t send to Zapier. Try again in a minute.' })
      load()
    } catch (err) {
      showToast({ kind: 'error', title: errorText(err) })
    }
  }
  return (
    <>
      <Group title="How it works" description="Webhooks by Zapier needs a paid Zapier plan.">
        <Row
          stacked
          label="Send notes to a Zap"
          hint={
            <Steps
              items={[
                <>Click <b>Set up Zapier</b>. In the Zap editor, click the trigger step and search for <b>Webhooks by Zapier</b>.</>,
                <>Choose the event <b>Catch Hook</b> and click <b>Continue</b>.</>,
                <>On the <b>Test</b> tab, click <b>Copy</b> to copy your webhook URL. Click <b>Add workflow</b> here and paste it.</>,
                <>Click <b>Send test note</b> here, then <b>Test trigger</b> in Zapier. Add your actions and publish the Zap.</>
              ]}
            />
          }
        >
          <div className="int-row-actions">
            <button type="button" className="n-btn n-btn--sm n-btn--primary" onClick={() => openExternal('https://zapier.com/editor')}>
              Set up Zapier
            </button>
            <button type="button" className="n-btn n-btn--sm" onClick={() => openExternal('https://zapier.com/app/assets/zaps')}>
              Edit workflows
            </button>
          </div>
        </Row>
      </Group>
      <Group title="Your workflows">
        {rows.map((d) =>
          editing !== null && editing !== 'new' && editing.id === d.id ? null : (
            <Row
              key={d.id}
              label={
                <span className="int-delivery">
                  {d.label}
                  <span className="int-badge">{d.trigger === 'folder' ? 'Note filed in a folder' : 'Note shared to Zapier'}</span>
                  {d.status === 'disconnected' ? <span className="int-badge int-badge--failed">Disconnected</span> : null}
                </span>
              }
              hint={d.status === 'disconnected' ? 'Zapier stopped accepting this hook. Turn the Zap back on, or edit the workflow with a new hook URL.' : d.maskedSecret ?? undefined}
            >
              <div className="int-row-actions">
                <button type="button" className="n-btn n-btn--sm" onClick={() => edit(d)}>
                  Edit
                </button>
                <button type="button" className="n-btn n-btn--sm" onClick={() => void test(d)}>
                  Send test note
                </button>
                <button type="button" className="n-btn n-btn--sm n-btn--ghost" aria-label={`Remove ${d.label}`} onClick={() => void window.notula.integrations.removeCredential({ provider: 'zapier', destinationId: d.id }).then(load)}>
                  Remove
                </button>
              </div>
            </Row>
          )
        )}
        {editing ? (
          <Row stacked label={editing === 'new' ? 'Add workflow' : `Edit ${editing.label}`}>
            <div className="int-form int-form--stack">
              <input className="n-input int-input" aria-label="Name" placeholder="Post to CRM" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} />
              <input
                className="n-input int-input"
                aria-label="Catch Hook URL"
                type="password"
                autoComplete="off"
                placeholder={editing === 'new' ? 'https://hooks.zapier.com/hooks/catch/…' : `${editing.maskedSecret ?? ''} (leave empty to keep)`}
                value={form.url}
                onChange={(e) => setForm({ ...form, url: e.target.value })}
              />
              <Segmented
                label="Runs"
                value={form.trigger}
                options={[
                  { value: 'share', label: 'When I send a note from the Share menu' },
                  { value: 'folder', label: 'When a note is filed in a folder' }
                ]}
                onChange={(v) => setForm({ ...form, trigger: v })}
              />
              <label className="int-toggle">
                <Switch label="Include transcript" checked={form.transcript} onChange={(v) => setForm({ ...form, transcript: v })} />
                Include transcript
              </label>
              <div className="int-row-actions">
                <button type="button" className="n-btn n-btn--sm n-btn--ghost" onClick={() => setEditing(null)}>
                  Cancel
                </button>
                <button type="button" className="n-btn n-btn--sm" disabled={editing === 'new' && !form.url.trim()} onClick={() => void save(true)}>
                  Send test note
                </button>
                <button type="button" className="n-btn n-btn--sm n-btn--primary" disabled={editing === 'new' && !form.url.trim()} onClick={() => void save(false)}>
                  Save
                </button>
              </div>
            </div>
          </Row>
        ) : (
          <Row label={rows.length ? 'Add another workflow' : 'No workflows yet'} hint="Paste a Catch Hook URL from a Zap.">
            <button type="button" className="n-btn n-btn--sm n-btn--primary" onClick={() => edit('new')}>
              Add workflow
            </button>
          </Row>
        )}
        <StatusLine status={line} />
      </Group>
    </>
  )
}

function ProviderPage({ provider }: { provider: IntegrationProvider }): JSX.Element {
  const statuses = useStatuses()
  const status = statuses?.[provider]
  const meta = PROVIDER_META[provider]
  const checked = useRef(false)

  // Validate again when the page opens and the last check is older than 24 h.
  useEffect(() => {
    if (!status || checked.current) return
    checked.current = true
    if (status.state === 'not_configured' || status.blockedByLocalOnly) return
    if (!status.lastValidatedAt || Date.now() - Date.parse(status.lastValidatedAt) > STALE_MS) {
      void window.notula.integrations.validate({ provider }).catch(() => {})
    }
  }, [status, provider])

  const connected = !!status && status.state !== 'not_configured'
  return (
    <div className="int-page">
      <button type="button" className="int-back" onClick={() => navigate('/settings/integrations')}>
        ‹ Integrations
      </button>
      <h2 className="int-page__title">{meta.title}</h2>
      <p className="int-page__description">{meta.description}</p>
      {status?.blockedByLocalOnly ? <p className="int-banner">{LOCAL_ONLY_COPY}</p> : null}
      {provider === 'slack' || provider === 'zapier' || provider === 'attio' ? <p className="int-note">{AUTOMATIONS_COPY}</p> : null}

      {provider === 'slack' ? <SlackPage status={status} /> : null}
      {provider === 'notion' ? (
        <>
          <Group title="Connect">
            <Row
              stacked
              label="Notion token"
              hint={
                <>
                  <Steps
                    items={[
                      <>In Notion’s Developer portal, open <b>Personal access tokens</b> (notion.so/developers/tokens).</>,
                      <>Click <b>New token</b>, enter a name (for example Notula), select the <b>Notion API</b> capability and click <b>Create token</b>. If a workspace picker appears, choose your workspace.</>,
                      <>Copy the token (Notion shows it only once) and paste it below.</>
                    ]}
                  />
                  <p className="int-small">On Business and Enterprise plans, a workspace owner may need to allow personal access tokens under <b>Settings → Connections</b>.</p>
                  <details className="int-small">
                    <summary>Use an internal connection instead</summary>
                    <p>Create a connection in the Developer portal, open its <b>Configuration</b> tab and copy the API token.</p>
                    <p>Then open the page or database Notula should save to, click <b>•••</b>, choose <b>Add connections</b> and select your connection.</p>
                  </details>
                </>
              }
            >
              <CredentialForm
                provider="notion"
                kind="notion-token"
                label="Notion token"
                placeholder="Paste your token"
                status={status}
                copy={{ connected: (s) => `Connected to ${s.accountLabel ?? 'Notion'}`, invalid: 'Notion didn’t accept this token.', unreachable: 'Couldn’t reach Notion.' }}
              />
            </Row>
          </Group>
          {status?.state === 'connected' ? <NotionTarget /> : null}
        </>
      ) : null}
      {provider === 'hubspot' ? (
        <>
          <Group title="How it works">
            <Row label="Notula saves meeting notes to the HubSpot contacts, companies and deals you pick. You choose what to send each time." />
          </Group>
          <Group title="Connect">
            <Row
              stacked
              label="HubSpot access token"
              hint={
                <Steps
                  items={[
                    <>In HubSpot, go to <b>Development</b>, then <b>Legacy apps</b> in the left sidebar.</>,
                    <>Click <b>Create legacy app</b>, then <b>Private</b>. On <b>Basic Info</b>, enter a name (for example Notula).</>,
                    <>Open the <b>Scopes</b> tab, click <b>Add new scope</b>, and add <code>crm.objects.contacts.read</code>, <code>crm.objects.contacts.write</code>, <code>crm.objects.companies.read</code>, <code>crm.objects.companies.write</code>, <code>crm.objects.deals.read</code> and <code>crm.objects.deals.write</code>. Click <b>Update</b>.</>,
                    <>Click <b>Create app</b>, then <b>Continue creating</b>.</>,
                    <>Open the app’s <b>Auth</b> tab, click <b>Show token</b>, then <b>Copy</b>, and paste it below.</>
                  ]}
                />
              }
            >
              <CredentialForm
                provider="hubspot"
                kind="hubspot-token"
                label="HubSpot access token"
                placeholder="pat-…"
                status={status}
                copy={{ connected: () => 'Connected', invalid: 'HubSpot didn’t accept this token.', unreachable: 'Couldn’t reach HubSpot.' }}
              />
            </Row>
          </Group>
        </>
      ) : null}
      {provider === 'attio' ? (
        <>
          <Group title="How it works">
            <Row label="Notula adds each meeting’s notes to the matching people and companies in Attio. Send one note at a time from Share, or turn on syncing for a folder." />
          </Group>
          <Group title="Connect">
            <Row
              stacked
              label="Attio access token"
              hint={
                <Steps
                  items={[
                    <>In Attio, open the dropdown beside your workspace name and choose <b>Workspace settings</b>.</>,
                    <>Open the <b>Developers</b> tab and click <b>+ New access token</b>.</>,
                    <>Name it (for example Notula). Under <b>Scopes</b>, allow <code>note:read-write</code>, <code>record_permission:read</code> and <code>object_configuration:read</code>.</>,
                    <>Copy the token and paste it below.</>
                  ]}
                />
              }
            >
              <CredentialForm
                provider="attio"
                kind="attio-token"
                label="Attio access token"
                placeholder="Paste your token"
                status={status}
                copy={{ connected: (s) => `Connected for ${s.accountLabel ?? 'Attio'}`, invalid: 'Attio didn’t accept this token.', unreachable: 'Couldn’t reach Attio.' }}
              />
            </Row>
          </Group>
        </>
      ) : null}
      {provider === 'affinity' ? (
        <Group title="Connect" description="Connect with an API key from your Affinity account.">
          <Row
            stacked
            label="Affinity API key"
            hint={
              <>
                <Steps items={[<>In Affinity, open <b>Settings</b>, then <b>Manage Apps</b>, and generate an API key.</>, <>Copy the key and paste it below.</>]} />
                <button type="button" className="int-link" onClick={() => openExternal('https://support.affinity.co/s/article/How-to-obtain-your-API-Key')}>
                  How to get an API key
                </button>
              </>
            }
          >
            <CredentialForm
              provider="affinity"
              kind="affinity-key"
              label="Affinity API key"
              placeholder="Paste your key here"
              status={status}
              autoSaveMs={300}
              copy={{ connected: (s) => `Connected to ${s.accountLabel ?? 'Affinity'}.`, invalid: 'Affinity rejected this key. Paste a new one.', unreachable: 'Couldn’t reach Affinity. Try again, or check your connection.' }}
            />
          </Row>
        </Group>
      ) : null}
      {provider === 'zapier' ? <ZapierPage /> : null}

      {connected ? <RecentDeliveries provider={provider} /> : null}
      {connected && provider === 'slack' ? <Disconnect provider="slack" title="Disconnect Slack?" body="Notula will forget your Slack token and webhooks and stop auto-posting folders to Slack." /> : null}
      {connected && provider === 'notion' ? <Disconnect provider="notion" title="Disconnect Notion?" body="Notula will forget your Notion token. Pages it already created stay in Notion." action="Disconnect Notion" /> : null}
      {connected && provider === 'hubspot' ? <Disconnect provider="hubspot" title="Disconnect HubSpot?" body="Notula will forget your HubSpot token." /> : null}
      {connected && provider === 'attio' ? <Disconnect provider="attio" title="Disconnect Attio?" body="Notula will forget your Attio token and stop auto-syncing folders to Attio." /> : null}
      {connected && provider === 'affinity' ? <Disconnect provider="affinity" title="Remove API key" body="Notula will forget your Affinity API key." action="Remove" label="Remove API key" /> : null}
      {connected && provider === 'zapier' ? <Disconnect provider="zapier" title="Remove all workflows?" body="Notula will forget every Catch Hook URL and stop running folder workflows." action="Remove all" label="Remove all workflows" /> : null}
    </div>
  )
}

export function IntegrationsSettings(): JSX.Element {
  const route = useRoute()
  const statuses = useStatuses()
  useSlotsVersion()
  const q = route.query.get('provider')
  const provider = PROVIDER_ORDER.find((p) => p === q)
  const pageRef = useRef<HTMLDivElement>(null)
  // A plug-in provider (its slot card, webhooks, mail) has no page of its own, so
  // `?provider=<id>` scrolls its card into view on the list instead.
  useEffect(() => {
    if (!q || provider) return
    const card = Array.from(pageRef.current?.querySelectorAll<HTMLElement>('[data-int-provider]') ?? []).find((el) =>
      (el.dataset['intProvider'] ?? '').split(' ').includes(q)
    )
    card?.scrollIntoView({ block: 'start' })
  }, [q, provider])
  if (provider) return <ProviderPage key={provider} provider={provider} />
  const blocked = Object.values(statuses ?? {}).some((s) => s?.blockedByLocalOnly)
  return (
    <div className="int-page" ref={pageRef}>
      {/* Sends held while Nothing leaves this machine was on. */}
      <HeldSendsReview />
      {blocked ? <p className="int-banner">{LOCAL_ONLY_COPY}</p> : null}
      <Group title="Integrations" description="Send notes to the tools you use, with your own accounts. Notula talks to each service directly from this computer.">
        {PROVIDER_ORDER.map((p) => {
          const s = statuses?.[p]
          const on = !!s && s.state !== 'not_configured'
          return (
            <div key={p} className="int-provider-row">
              <Row label={PROVIDER_META[p].name} hint={PROVIDER_META[p].description}>
                <span className={`int-badge${on ? (s?.state === 'connected' ? ' int-badge--sent' : ' int-badge--failed') : ''}`}>{statusText(s)}</span>
                <button type="button" className="n-btn n-btn--sm" onClick={() => navigate(settingsPath(p))}>
                  {on ? 'Manage' : 'Set up'}
                </button>
              </Row>
            </div>
          )
        })}
      </Group>
      {/* The plug-in providers' cards (Salesforce, Pipedrive, Ashby). */}
      {integrationSlots('settings-card').map(({ provider: p, component: Card }) => (
        <div key={p} data-int-provider={p}>
          <Card provider={p} />
        </div>
      ))}
      {/* Webhooks, then Gmail and Outlook per OAuth account. */}
      <div data-int-provider="webhook">
        <WebhooksSettings />
      </div>
      <div data-int-provider="gmail outlook">
        <MailAccountsRows />
      </div>
    </div>
  )
}
