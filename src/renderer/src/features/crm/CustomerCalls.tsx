// SPDX-License-Identifier: Apache-2.0
// Customer calls: the Labs row (asks first, then creates the folder), the
// sidebar link, and `/view/customer-calls` with its header, tabs, backlog banner, exclusions,
// sync chips, per-note CRM status and "Sync <n> notes".

import { useCallback, useEffect, useMemo, useState, type JSX } from 'react'
import { CUSTOMER_CALLS, type CustomerCallsBacklogNote, type CustomerCallsStatus, type CustomerCallsSyncStatus } from '@shared/types/customer-calls'
import type { IntegrationAutomation, IntegrationProvider } from '@shared/types/integrations'
import type { NoteListItem } from '@shared/types/notes'
import { navigate, navigateToSettings, useRoute } from '../../app/navigation'
import { closeSidebarOverlay } from '../../app/sidebar-state'
import { showToast } from '../../app/toast'
import { ChipInput, errorText, Modal, normDomain, normEmail } from '../automations/ui'
import { openFolderIntegrations } from '../integrations'
import { Switch } from '../settings/controls'
import { setPrefs, usePrefs } from '../settings/prefs-store'
import './crm.css'

const NAMES: Partial<Record<IntegrationProvider, string>> = { slack: 'Slack', notion: 'Notion', hubspot: 'HubSpot', attio: 'Attio', affinity: 'Affinity', zapier: 'Zapier', salesforce: 'Salesforce', pipedrive: 'Pipedrive', ashby: 'Ashby' }
const TAB_KEY = 'notula.customerCalls.tab'

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

// ---------- Labs row ----------

export function CustomerCallsLabsRow(): JSX.Element {
  const prefs = usePrefs()
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const on = prefs?.['customerCalls.enabled'] === true
  const turnOn = async (): Promise<void> => {
    setBusy(true)
    try {
      await window.notula.customerCalls.enable()
      setAsking(false)
      showToast({ kind: 'success', title: 'Customer calls is on' })
    } catch (err) {
      showToast({ kind: 'error', title: errorText(err) })
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="settings-row">
      <div className="settings-row__text">
        <div className="settings-row__label">Customer calls</div>
        <div className="settings-row__hint">Gathers your calls with external attendees in one folder, ready to review or send to your CRM.</div>
      </div>
      <div className="settings-row__control">
        <Switch
          label="Customer calls"
          checked={on}
          busy={busy}
          onChange={(next) => {
            if (next) setAsking(true)
            else void window.notula.customerCalls.disable().catch((err: unknown) => showToast({ kind: 'error', title: errorText(err) }))
          }}
        />
      </div>
      {asking ? (
        <Modal
          title="Turn on Customer calls?"
          onClose={() => setAsking(false)}
          footer={
            <>
              <button type="button" className="n-btn" onClick={() => setAsking(false)}>
                Cancel
              </button>
              <button type="button" className="n-btn n-btn--primary" disabled={busy} onClick={() => void turnOn()}>
                Create folder and turn on
              </button>
            </>
          }
        >
          <p>Notula will create a Customer calls folder and use your AI provider to spot sales and customer calls.</p>
        </Modal>
      ) : null}
    </div>
  )
}

// ---------- sidebar ----------

function IconHandshake({ size = 16 }: { size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 12h3l3-3 3 2 3-2 3 3h3" />
      <path d="M7 13l3 3a1.5 1.5 0 0 0 2 0l1-1M14 15l1 1a1.5 1.5 0 0 0 2-2l-2-2" />
      <path d="M3 8v8M21 8v8" />
    </svg>
  )
}

export function SidebarCustomerCallsLink(): JSX.Element | null {
  const prefs = usePrefs()
  const { path } = useRoute()
  if (prefs?.['customerCalls.enabled'] !== true) return null
  return (
    <div className="app-sidebar__group">
      <button
        type="button"
        className="app-sidebar__item"
        aria-current={path === '/view/customer-calls' ? 'page' : undefined}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          navigate('/view/customer-calls')
          closeSidebarOverlay()
        }}
      >
        <IconHandshake size={16} />
        <span className="app-sidebar__label">Customer calls</span>
      </button>
    </div>
  )
}

// ---------- the view ----------

function syncLabel(s: CustomerCallsSyncStatus): { text: string; cls: string } | null {
  if (s.state === 'synced') return { text: 'Synced', cls: 'wb-badge--ok' }
  if (s.state === 'sending') return { text: 'Sending', cls: '' }
  if (s.state === 'failed') return { text: 'Failed', cls: 'wb-badge--bad' }
  if (s.state === 'check') return { text: 'Check', cls: 'wb-badge--warn' }
  if (s.state === 'not-synced') return { text: 'Not synced', cls: '' }
  return null
}

function Exclusions({ status, onClose, onSaved }: { status: CustomerCallsStatus; onClose(): void; onSaved(s: CustomerCallsStatus): void }): JSX.Element {
  const [emails, setEmails] = useState(status.excludedEmails)
  const [domains, setDomains] = useState(status.excludedDomains)
  const save = async (): Promise<void> => {
    try {
      onSaved(await window.notula.customerCalls.setExclusions({ emails, domains }))
      onClose()
    } catch {
      showToast({ kind: 'error', title: 'Couldn’t update customer call exclusions. Try again.' })
    }
  }
  return (
    <Modal
      title="Meeting exclusions"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="n-btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="n-btn n-btn--primary" onClick={() => void save()}>
            Save
          </button>
        </>
      }
    >
      <p>Calls with these people or companies are never added to Customer calls.</p>
      <div className="wb-field">
        <span className="wb-label">People</span>
        <ChipInput label="Excluded people" values={emails} onChange={setEmails} placeholder="name@acme.com" normalize={normEmail} invalidText="Enter valid email addresses." />
      </div>
      <div className="wb-field">
        <span className="wb-label">Companies</span>
        <ChipInput label="Excluded companies" values={domains} onChange={setDomains} placeholder="acme.com" normalize={normDomain} invalidText="Enter valid company domains, like acme.com." />
      </div>
    </Modal>
  )
}

function Backlog({ onClose, onAdded }: { onClose(): void; onAdded(): void }): JSX.Element {
  const [notes, setNotes] = useState<CustomerCallsBacklogNote[] | null>(null)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [checking, setChecking] = useState(false)
  const load = useCallback(async (classifyOlder: boolean): Promise<void> => {
    const req = { days: CUSTOMER_CALLS.backlogDays, ...(classifyOlder ? { classifyOlder: true } : {}) }
    const list = await window.notula.customerCalls.listBacklog(req)
    setNotes(list)
    setPicked(new Set(list.map((n) => n.noteId)))
  }, [])
  useEffect(() => {
    void load(false).catch(() => setNotes([]))
  }, [load])
  const add = async (): Promise<void> => {
    try {
      const r = await window.notula.customerCalls.add({ noteIds: [...picked] })
      showToast({ kind: 'success', title: `Added ${plural(r.added, 'note', 'notes')}` })
      onAdded()
      onClose()
    } catch (err) {
      showToast({ kind: 'error', title: errorText(err) })
    }
  }
  return (
    <Modal
      wide
      title="Review and add"
      onClose={onClose}
      footer={
        <>
          <button
            type="button"
            className="n-btn"
            disabled={checking}
            onClick={() => {
              setChecking(true)
              void load(true)
                .catch((err: unknown) => showToast({ kind: 'error', title: errorText(err) }))
                .finally(() => setChecking(false))
            }}
          >
            {checking ? 'Checking…' : 'Check older notes'}
          </button>
          <button type="button" className="n-btn n-btn--primary" disabled={!picked.size} onClick={() => void add()}>
            Add {plural(picked.size, 'note', 'notes')}
          </button>
        </>
      }
    >
      <p className="wb-help">Sales and customer calls from the last 30 days that aren’t in Customer calls yet. “Check older notes” asks your AI provider about up to 50 notes it hasn’t classified.</p>
      <div className="cc-checklist">
        {notes === null ? <div className="n-skeleton" style={{ height: 80 }} /> : null}
        {notes?.length === 0 ? <div className="wb-empty">Nothing to add.</div> : null}
        {notes?.map((n) => (
          <label key={n.noteId} className="wb-check">
            <input
              type="checkbox"
              checked={picked.has(n.noteId)}
              onChange={(e) =>
                setPicked((s) => {
                  const next = new Set(s)
                  if (e.target.checked) next.add(n.noteId)
                  else next.delete(n.noteId)
                  return next
                })
              }
            />
            <span className="cc-check__title">{n.title?.trim() || 'Untitled note'}</span>
            <span className="cc-check__date">{new Date(n.meetingAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>
          </label>
        ))}
      </div>
    </Modal>
  )
}

interface Group {
  key: string
  label: string
  notes: NoteListItem[]
}

function groupBy(notes: NoteListItem[], by: 'company' | 'person', me: string): Group[] {
  const map = new Map<string, Group>()
  for (const n of notes) {
    const seen = new Set<string>()
    for (const a of n.linked_event?.attendees ?? []) {
      const e = a.email?.toLowerCase() ?? ''
      if (!e || e === me || a.self || a.resource) continue
      const key = by === 'company' ? e.slice(e.lastIndexOf('@') + 1) : e
      if (!key || seen.has(key)) continue
      seen.add(key)
      const g = map.get(key) ?? { key, label: by === 'company' ? key : a.displayName || e, notes: [] }
      g.notes.push(n)
      map.set(key, g)
    }
  }
  return [...map.values()].sort((a, b) => b.notes.length - a.notes.length || a.label.localeCompare(b.label))
}

export function CustomerCallsPageView(): JSX.Element {
  const prefs = usePrefs()
  const [status, setStatus] = useState<CustomerCallsStatus | null>(null)
  const [notes, setNotes] = useState<NoteListItem[] | null>(null)
  const [bindings, setBindings] = useState<IntegrationAutomation[]>([])
  const [sync, setSync] = useState<CustomerCallsSyncStatus[]>([])
  const [tab, setTab] = useState<'notes' | 'companies' | 'people' | null>(() => {
    try {
      const t = localStorage.getItem(TAB_KEY)
      return t === 'notes' || t === 'companies' || t === 'people' ? t : null
    } catch {
      return null
    }
  })
  const [dialog, setDialog] = useState<'exclusions' | 'backlog' | null>(null)
  const [syncing, setSyncing] = useState<IntegrationProvider | null>(null)

  const load = useCallback(async (): Promise<void> => {
    try {
      const s = await window.notula.customerCalls.status()
      setStatus(s)
      if (!s.enabled || !s.folderId) return
      const [page, b] = await Promise.all([window.notula.notes.list({ scope: 'own', folderId: s.folderId }), window.notula.integrations.listAutomations({ folderId: s.folderId })])
      setNotes(page.items)
      const on = b.filter((x) => x.enabled)
      setBindings(on)
      setSync(on.length && page.items.length ? await window.notula.customerCalls.syncStatus({ noteIds: page.items.map((n) => n.id) }) : [])
    } catch {
      setNotes((n) => n ?? [])
    }
  }, [])
  useEffect(() => {
    void load()
    const offs = [window.notula.folders.onChanged(() => void load()), window.notula.integrations.onDelivery(() => void load())]
    return () => {
      for (const off of offs) off()
    }
  }, [load])

  const providers = useMemo(() => [...new Set(bindings.map((b) => b.provider))], [bindings])
  const me = (prefs?.['profile.email'] ?? '').toLowerCase()
  if (!status) return <div className="cc-page"><div className="n-skeleton" style={{ height: 160 }} /></div>
  if (!status.enabled) {
    return (
      <div className="cc-page">
        <h1 className="cc-title">Customer calls</h1>
        <p className="cc-description">
          Customer calls is off.{' '}
          <button type="button" className="wb-link" onClick={() => navigateToSettings('labs')}>
            Turn it on in Labs
          </button>
        </p>
      </div>
    )
  }
  const list = notes ?? []
  const shownTab = tab ?? (list.length >= CUSTOMER_CALLS.companiesMinNotes ? 'companies' : 'notes')
  const pick = (t: 'notes' | 'companies' | 'people'): void => {
    setTab(t)
    try {
      localStorage.setItem(TAB_KEY, t)
    } catch {
      // Remembering the tab is a convenience.
    }
  }
  const statusFor = (noteId: string): CustomerCallsSyncStatus[] => sync.filter((s) => s.noteId === noteId)
  const runSync = async (p: IntegrationProvider): Promise<void> => {
    setSyncing(p)
    try {
      setSync(await window.notula.customerCalls.syncStatus({ noteIds: list.map((n) => n.id), sync: p }))
    } catch (err) {
      showToast({ kind: 'error', title: errorText(err) })
    } finally {
      setSyncing(null)
    }
  }
  const notCustomer = (noteId: string): void => {
    void window.notula.customerCalls
      .add({ noteIds: [noteId], remove: true })
      .then(() => {
        showToast({ title: 'Removed from Customer calls' })
        return load()
      })
      .catch((err: unknown) => showToast({ kind: 'error', title: errorText(err) }))
  }
  const retry = (deliveryId: string): void => {
    void window.notula.integrations
      .retryDelivery({ deliveryId })
      .then(load)
      .catch((err: unknown) => showToast({ kind: 'error', title: errorText(err) }))
  }

  const noteRow = (n: NoteListItem): JSX.Element => (
    <div key={n.id} className="wb-item cc-row">
      <button type="button" className="cc-row__open" onClick={() => navigate(`/meeting/${n.id}`)}>
        <span className="wb-item__title">{n.title?.trim() || 'Untitled note'}</span>
        <span className="wb-item__meta">{new Date(n.sort_epoch * 1000).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}</span>
      </button>
      <div className="wb-item__side">
        {statusFor(n.id).map((s) => {
          const l = syncLabel(s)
          if (!l) return null
          return (
            <span key={s.provider} className="cc-sync">
              <span className={`wb-badge ${l.cls}`} title={s.error ?? undefined}>
                {NAMES[s.provider] ?? s.provider}: {l.text}
              </span>
              {(s.state === 'failed' || s.state === 'check') && s.deliveryId ? (
                <button type="button" className="n-btn n-btn--sm" onClick={() => retry(s.deliveryId as string)}>
                  {s.state === 'check' ? 'Try again' : 'Retry'}
                </button>
              ) : null}
            </span>
          )
        })}
        <button type="button" className="n-btn n-btn--sm n-btn--ghost" onClick={() => notCustomer(n.id)}>
          Not a customer call
        </button>
      </div>
    </div>
  )

  const groups = shownTab === 'notes' ? [] : groupBy(list, shownTab === 'companies' ? 'company' : 'person', me)
  return (
    <div className="cc-page">
      <header className="cc-header">
        <div className="cc-header__text">
          <h1 className="cc-title">Customer calls</h1>
          <p className="cc-description">Your calls with customers, in one place.</p>
          <p className="cc-count">{plural(list.length, 'note', 'notes')}</p>
        </div>
        <div className="cc-header__actions">
          {providers.map((p) => (
            <span key={p} className="cc-chip">
              Syncing to {NAMES[p] ?? p}
              <button type="button" className="wb-link" onClick={() => navigate(`/settings/integrations?provider=${p}`)}>
                Manage {NAMES[p] ?? p} integration
              </button>
            </span>
          ))}
          <button type="button" className="n-btn n-btn--sm" onClick={() => setDialog('exclusions')}>
            Meeting exclusions
          </button>
        </div>
      </header>

      <div className="cc-adding">
        <span>{prefs?.['customerCalls.autoAdd'] ? 'New customer calls are added here automatically.' : 'New calls with customers aren’t added here automatically.'}</span>
        <button type="button" className="n-btn n-btn--sm" onClick={() => setPrefs({ 'customerCalls.autoAdd': !prefs?.['customerCalls.autoAdd'] })}>
          {prefs?.['customerCalls.autoAdd'] ? 'Stop adding my calls' : 'Add my calls'}
        </button>
      </div>

      {status.backlogCount > 0 ? (
        <div className="wb-banner">
          <span className="wb-banner__text">You have {plural(status.backlogCount, 'customer call', 'customer calls')} that haven’t been added</span>
          <button type="button" className="n-btn n-btn--sm n-btn--primary" onClick={() => setDialog('backlog')}>
            Review and add
          </button>
        </div>
      ) : null}

      {!providers.length ? (
        <div className="wb-banner cc-prompt">
          <span className="wb-banner__text">Connect your CRM to send these notes to customer records.</span>
          <button type="button" className="n-btn n-btn--sm" onClick={() => navigate('/settings/integrations')}>
            Connect your apps
          </button>
          {status.folderId ? (
            <button type="button" className="n-btn n-btn--sm" onClick={() => openFolderIntegrations(status.folderId as string)}>
              Folder sync
            </button>
          ) : null}
        </div>
      ) : (
        providers.map((p) => {
          const missing = sync.filter((s) => s.provider === p && s.state === 'not-synced').length
          return missing ? (
            <div key={p} className="wb-banner">
              <span className="wb-banner__text">
                {plural(missing, 'note isn’t', 'notes aren’t')} in {NAMES[p] ?? p} yet.
              </span>
              <button type="button" className="n-btn n-btn--sm n-btn--primary" disabled={syncing === p} onClick={() => void runSync(p)}>
                {syncing === p ? 'Syncing…' : `Sync ${plural(missing, 'note', 'notes')}`}
              </button>
            </div>
          ) : null
        })
      )}

      <div className="cc-tabs" role="tablist">
        {(['notes', 'companies', 'people'] as const).map((t) => (
          <button key={t} type="button" role="tab" aria-selected={shownTab === t} className="cc-tab" onClick={() => pick(t)}>
            {t === 'notes' ? 'Notes' : t === 'companies' ? 'Companies' : 'People'}
          </button>
        ))}
      </div>
      <div className="settings-card">
        <div className="wb-list">
          {notes === null ? <div className="n-skeleton" style={{ height: 120 }} /> : null}
          {notes && !list.length ? <div className="wb-empty">No customer calls yet. Sales and customer calls land here after their summary.</div> : null}
          {shownTab === 'notes'
            ? list.map(noteRow)
            : groups.map((g) => (
                <div key={g.key} className="wb-item">
                  <div className="wb-item__main">
                    <div className="wb-item__title">{g.label}</div>
                    <div className="wb-item__meta">
                      {g.notes
                        .slice(0, 3)
                        .map((n) => n.title?.trim() || 'Untitled note')
                        .join(' · ')}
                    </div>
                  </div>
                  <span className="wb-badge">{plural(g.notes.length, 'note', 'notes')}</span>
                </div>
              ))}
        </div>
      </div>
      {dialog === 'exclusions' ? <Exclusions status={status} onClose={() => setDialog(null)} onSaved={setStatus} /> : null}
      {dialog === 'backlog' ? <Backlog onClose={() => setDialog(null)} onAdded={() => void load()} /> : null}
    </div>
  )
}
