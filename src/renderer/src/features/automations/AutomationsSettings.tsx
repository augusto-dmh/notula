// SPDX-License-Identifier: Apache-2.0
// Settings ▸ Automations: the intro, "Your automations"
// (name, summary line, switch, Edit, Delete), the editor, the Activity list of the
// last 50 runs with Send / Don't send for runs waiting on confirmation, and the footer line.

import { useCallback, useEffect, useState, type JSX } from 'react'
import { AUTOMATION_LIMITS, CLASSIFICATION_PRESETS, type AutomationPredicate, type AutomationRule, type AutomationRuleInput, type AutomationRun } from '@shared/types/automations'
import type { Folder } from '@shared/types/folders'
import type { WebhookEndpoint } from '@shared/types/webhooks'
import { showToast } from '../../app/toast'
import { Group, Select, Switch } from '../settings/controls'
import { ago, ChipInput, errorText, InlineConfirm, Modal, normDomain, normEmail } from './ui'

type FilterKind = 'all' | 'classification' | 'external' | 'internal' | 'company' | 'person' | 'custom'
const PRESET_NAMES = Object.keys(CLASSIFICATION_PRESETS) as (keyof typeof CLASSIFICATION_PRESETS)[]

const FILTERS: { value: FilterKind; label: string }[] = [
  { value: 'all', label: 'Every meeting' },
  { value: 'classification', label: 'Meeting type' },
  { value: 'external', label: 'Has external guests' },
  { value: 'internal', label: 'Has only internal guests' },
  { value: 'company', label: 'Includes someone from a company' },
  { value: 'person', label: 'Specific people' }
]

const STATUS_LABEL: Record<AutomationRun['status'], string> = {
  matched: 'Running',
  no_match: 'Didn’t match',
  needs_confirmation: 'Needs confirmation',
  executed: 'Done',
  dismissed: 'Not sent',
  failed: 'Failed'
}

interface Draft {
  id?: string
  name: string
  description: string
  enabled: boolean
  filter: FilterKind
  preset: (typeof PRESET_NAMES)[number]
  includePersonal: boolean
  values: string[]
  excludePeople: string[]
  excludeCompanies: string[]
  custom: AutomationPredicate[]
  action: 'file_in_folder' | 'post_webhook'
  folderId: string
  endpointId: string
  confirmSends: boolean
}

function toDraft(r: AutomationRule | null): Draft {
  const inc = r?.predicates.find((p) => p.operator === 'include')
  const exc = r?.predicates.filter((p) => p.operator === 'exclude') ?? []
  let filter: FilterKind = 'all'
  let preset: Draft['preset'] = PRESET_NAMES[0] as Draft['preset']
  const custom: AutomationPredicate[] = []
  if (inc) {
    if (inc.type === 'classification') {
      const hit = PRESET_NAMES.find((n) => [...CLASSIFICATION_PRESETS[n]].sort().join() === [...inc.selected_ids].sort().join())
      if (hit) {
        filter = 'classification'
        preset = hit
      } else filter = 'custom'
    } else if (inc.type === 'recurring') filter = 'custom'
    else filter = inc.type
  }
  if (filter === 'custom' && inc) custom.push(inc)
  for (const p of exc) if (p.type !== 'person' && p.type !== 'company') custom.push(p)
  const a = r?.actions[0]
  return {
    ...(r ? { id: r.id } : {}),
    name: r?.name ?? '',
    description: r?.description ?? '',
    enabled: r?.enabled ?? true,
    filter,
    preset,
    includePersonal: inc?.type === 'external' ? inc.config?.skip_shared_inboxes === false : false,
    values: inc && (inc.type === 'company' || inc.type === 'person') ? inc.selected_ids : [],
    excludePeople: exc.filter((p) => p.type === 'person').flatMap((p) => p.selected_ids),
    excludeCompanies: exc.filter((p) => p.type === 'company').flatMap((p) => p.selected_ids),
    custom,
    action: a?.type ?? 'file_in_folder',
    folderId: a?.type === 'file_in_folder' ? a.folder_id : '',
    endpointId: a?.type === 'post_webhook' ? a.webhook_id : '',
    confirmSends: r?.confirm_sends ?? true
  }
}

function toInput(d: Draft): AutomationRuleInput {
  const predicates: AutomationPredicate[] = []
  if (d.filter === 'custom') predicates.push(...d.custom.filter((p) => p.operator === 'include'))
  else if (d.filter === 'classification') predicates.push({ type: 'classification', operator: 'include', selected_ids: [...CLASSIFICATION_PRESETS[d.preset]] })
  else if (d.filter === 'external') predicates.push({ type: 'external', operator: 'include', selected_ids: [], config: { skip_shared_inboxes: !d.includePersonal } })
  else if (d.filter === 'company' || d.filter === 'person') predicates.push({ type: d.filter, operator: 'include', selected_ids: d.values })
  else predicates.push({ type: d.filter, operator: 'include', selected_ids: [] })
  if (d.excludePeople.length) predicates.push({ type: 'person', operator: 'exclude', selected_ids: d.excludePeople })
  if (d.excludeCompanies.length) predicates.push({ type: 'company', operator: 'exclude', selected_ids: d.excludeCompanies })
  predicates.push(...d.custom.filter((p) => p.operator === 'exclude'))
  return {
    ...(d.id ? { id: d.id } : {}),
    name: d.name.trim() || 'Untitled automation',
    description: d.description.trim() || null,
    enabled: d.enabled,
    trigger: 'meeting_ended',
    predicates,
    actions: [d.action === 'file_in_folder' ? { type: 'file_in_folder', folder_id: d.folderId } : { type: 'post_webhook', webhook_id: d.endpointId }],
    confirm_sends: d.confirmSends
  }
}

function filterText(r: AutomationRule): string {
  const inc = r.predicates.find((p) => p.operator === 'include')
  if (!inc || inc.type === 'all') return 'a meeting ends'
  if (inc.type === 'classification') {
    const hit = PRESET_NAMES.find((n) => [...CLASSIFICATION_PRESETS[n]].sort().join() === [...inc.selected_ids].sort().join())
    return hit ? `it’s one of your ${hit.toLowerCase()}` : 'a meeting matches a custom filter'
  }
  if (inc.type === 'external') return 'a meeting has external guests'
  if (inc.type === 'internal') return 'everyone is from your company'
  if (inc.type === 'company') return `someone from ${inc.selected_ids.slice(0, 2).join(', ')}${inc.selected_ids.length > 2 ? '…' : ''} attends`
  if (inc.type === 'person') return `${inc.selected_ids.length === 1 ? inc.selected_ids[0] : `one of ${inc.selected_ids.length} people`} attends`
  return 'a meeting matches a custom filter'
}

export function summaryLine(r: AutomationRule, folders: Folder[], endpoints: WebhookEndpoint[]): string {
  const a = r.actions[0]
  if (a.type === 'file_in_folder') return `When ${filterText(r)}, add the notes to ${folders.find((f) => f.id === a.folder_id)?.title ?? 'a deleted folder'}.`
  const ep = endpoints.find((e) => e.id === a.webhook_id)
  return `When ${filterText(r)}, send a webhook to ${ep ? ep.url_label.replace(/^https?:\/\//, '') : 'a deleted webhook'}.`
}

function Editor({ initial, folders, endpoints, onClose, onSaved }: { initial: AutomationRule | null; folders: Folder[]; endpoints: WebhookEndpoint[]; onClose(): void; onSaved(): void }): JSX.Element {
  const [d, setD] = useState<Draft>(() => toDraft(initial))
  const [excluding, setExcluding] = useState(d.excludePeople.length > 0 || d.excludeCompanies.length > 0)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const up = (p: Partial<Draft>): void => setD((x) => ({ ...x, ...p }))
  const save = async (): Promise<void> => {
    setError(null)
    if ((d.filter === 'company' || d.filter === 'person') && !d.values.length) return setError(d.filter === 'company' ? 'Add at least one company domain, like acme.com.' : 'Add at least one person.')
    if (d.action === 'file_in_folder' && !d.folderId) return setError('Pick a folder.')
    if (d.action === 'post_webhook' && !d.endpointId) return setError('Pick a webhook.')
    setBusy(true)
    try {
      await window.notula.automations.save(toInput(d))
      showToast({ kind: 'success', title: initial ? 'Automation updated' : 'Automation created' })
      onSaved()
      onClose()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }
  const sortedFolders = [...folders].sort((a, b) => a.title.localeCompare(b.title))
  return (
    <Modal
      wide
      title={initial ? 'Edit automation' : 'New automation'}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="n-btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="n-btn n-btn--primary" disabled={busy} onClick={() => void save()}>
            {initial ? 'Save changes' : 'Create automation'}
          </button>
        </>
      }
    >
      <div className="wb-field">
        <label htmlFor="au-name">Automation name</label>
        <input id="au-name" className="n-input" maxLength={AUTOMATION_LIMITS.nameMax} value={d.name} placeholder="Untitled automation" onChange={(e) => up({ name: e.target.value })} />
      </div>
      <div className="wb-field">
        <label htmlFor="au-desc">Automation description</label>
        <input id="au-desc" className="n-input" maxLength={2000} value={d.description} onChange={(e) => up({ description: e.target.value })} />
      </div>
      <p className="wb-help">Run when a meeting ends</p>
      <div className="wb-field">
        <label htmlFor="au-filter">Filter by</label>
        {d.filter === 'custom' ? (
          <p className="wb-help">This automation uses conditions this editor can’t show. Saving keeps them as they are.</p>
        ) : (
          <Select id="au-filter" wide value={d.filter} options={FILTERS} onChange={(v) => up({ filter: v, values: [] })} />
        )}
        {d.filter === 'all' ? <p className="wb-help">Runs after every meeting.</p> : null}
        {d.filter === 'classification' ? (
          <>
            <Select label="Meeting type" wide value={d.preset} options={PRESET_NAMES.map((n) => ({ value: n, label: n }))} onChange={(v) => up({ preset: v })} />
            <p className="wb-help">Notula works out each meeting’s type from what was said. The automation runs only when it matches the type picked here.</p>
          </>
        ) : null}
        {d.filter === 'external' ? (
          <>
            <p className="wb-help">Notula treats attendees outside your company’s email domain as external.</p>
            <label className="wb-check">
              <input type="checkbox" checked={d.includePersonal} onChange={(e) => up({ includePersonal: e.target.checked })} />
              Count personal addresses, like gmail.com, as external
            </label>
          </>
        ) : null}
        {d.filter === 'internal' ? <p className="wb-help">Runs only when Notula sees your company’s email domain for every attendee on the calendar event.</p> : null}
        {d.filter === 'company' ? (
          <>
            <ChipInput label="Specific companies" values={d.values} onChange={(v) => up({ values: v })} placeholder="acme.com" normalize={normDomain} invalidText="Enter valid company domains, like acme.com." />
            <p className="wb-help">Notula matches attendees by email domain, so acme.com covers everyone at acme.com.</p>
          </>
        ) : null}
        {d.filter === 'person' ? (
          <>
            <ChipInput label="Specific people" values={d.values} onChange={(v) => up({ values: v.slice(0, AUTOMATION_LIMITS.personMax) })} placeholder="name@acme.com" normalize={normEmail} invalidText="Enter valid email addresses." />
            <p className="wb-help">Up to 25 people.</p>
          </>
        ) : null}
      </div>
      {excluding ? (
        <>
          <div className="wb-field">
            <span className="wb-label">Never run for these people</span>
            <ChipInput label="Excluded people" values={d.excludePeople} onChange={(v) => up({ excludePeople: v })} placeholder="name@acme.com" normalize={normEmail} invalidText="Enter valid email addresses." />
          </div>
          <div className="wb-field">
            <span className="wb-label">Never run for these companies</span>
            <ChipInput label="Excluded companies" values={d.excludeCompanies} onChange={(v) => up({ excludeCompanies: v })} placeholder="acme.com" normalize={normDomain} invalidText="Enter valid company domains, like acme.com." />
          </div>
        </>
      ) : (
        <button type="button" className="wb-link" style={{ alignSelf: 'flex-start' }} onClick={() => setExcluding(true)}>
          Add exclusion
        </button>
      )}
      <div className="wb-field">
        <span className="wb-label">Then</span>
        <Select
          label="Action"
          wide
          value={d.action}
          options={[
            { value: 'file_in_folder', label: 'Add the notes to a folder' },
            { value: 'post_webhook', label: 'Send a webhook to', disabled: endpoints.length === 0 }
          ]}
          onChange={(v) => up({ action: v })}
        />
        {d.action === 'file_in_folder' ? (
          <Select label="Folder" wide value={d.folderId} options={[{ value: '', label: 'Choose a folder', disabled: true }, ...sortedFolders.map((f) => ({ value: f.id, label: f.title }))]} onChange={(v) => up({ folderId: v })} />
        ) : (
          <>
            <Select label="Webhook endpoint URL" wide value={d.endpointId} options={[{ value: '', label: 'Choose a webhook', disabled: true }, ...endpoints.map((e) => ({ value: e.id, label: e.url_label.replace(/^https?:\/\//, '') }))]} onChange={(v) => up({ endpointId: v })} />
            <label className="wb-check">
              <input type="checkbox" checked={d.confirmSends} onChange={(e) => up({ confirmSends: e.target.checked })} />
              Ask before sending
            </label>
          </>
        )}
        {endpoints.length === 0 ? <p className="wb-help">To send webhooks, set one up in Settings ▸ Integrations first.</p> : null}
      </div>
      {error ? <p className="wb-error">{error}</p> : null}
    </Modal>
  )
}

export function AutomationsSettings(): JSX.Element {
  const [rules, setRules] = useState<AutomationRule[] | null>(null)
  const [runs, setRuns] = useState<AutomationRun[]>([])
  const [folders, setFolders] = useState<Folder[]>([])
  const [endpoints, setEndpoints] = useState<WebhookEndpoint[]>([])
  const [editing, setEditing] = useState<AutomationRule | 'new' | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    try {
      const [r, x, f, e] = await Promise.all([
        window.notula.automations.list(),
        window.notula.automations.listRuns({ limit: AUTOMATION_LIMITS.activityRuns }),
        window.notula.folders.list(),
        window.notula.webhooks.list()
      ])
      setRules(r)
      setRuns(x)
      setFolders(f.folders)
      setEndpoints(e)
    } catch {
      setRules((p) => p ?? [])
    }
  }, [])
  useEffect(() => {
    void load()
    const off = window.notula.automations.onChanged(() => void load())
    return off
  }, [load])

  const toggle = (r: AutomationRule, enabled: boolean): void => {
    void window.notula.automations
      .save({ ...r, enabled })
      .then(load)
      .catch((err: unknown) => showToast({ kind: 'error', title: errorText(err) }))
  }
  const remove = (id: string): void => {
    setDeleting(null)
    void window.notula.automations
      .delete({ id })
      .then(() => {
        showToast({ title: 'Automation deleted' })
        return load()
      })
      .catch(() => showToast({ kind: 'error', title: 'Couldn’t delete the automation. Try again.' }))
  }
  const resolve = (run: AutomationRun, choice: 'send' | 'dismiss'): void => {
    void window.notula.automations
      .resolveRun({ runId: run.id, choice })
      .then(load)
      .catch((err: unknown) => showToast({ kind: 'error', title: errorText(err) }))
  }

  if (!rules) return <div className="n-skeleton" style={{ height: 160 }} />
  const ruleName = (id: string): string => rules.find((r) => r.id === id)?.name ?? 'Deleted automation'
  return (
    <>
      <p className="settings-group__description" style={{ margin: 0 }}>
        Automations act on a meeting after it ends, such as filing the note in a folder or sending it to a webhook. Set a rule once and Notula applies it.
      </p>
      <Group title="Your automations" description="Runs only for you">
        <div className="wb-list">
          {rules.length === 0 ? <div className="wb-empty">No automations yet.</div> : null}
          {rules.map((r) => (
            <div key={r.id} className={`wb-item${r.enabled ? '' : ' wb-item--off'}`}>
              <div className="wb-item__main">
                <div className="wb-item__title">{r.name || 'Untitled automation'}</div>
                <div className="wb-item__meta">{summaryLine(r, folders, endpoints)}</div>
                {deleting === r.id ? (
                  <InlineConfirm title="Delete automation?" body="Notula stops applying this rule. Notes it already filed or sent stay as they are." action="Delete" onCancel={() => setDeleting(null)} onConfirm={() => remove(r.id)} />
                ) : null}
              </div>
              <div className="wb-item__side">
                <Switch label="Automation on" checked={r.enabled} onChange={(v) => toggle(r, v)} />
                <button type="button" className="n-btn n-btn--sm" onClick={() => setEditing(r)}>
                  Edit
                </button>
                <button type="button" className="n-btn n-btn--sm n-btn--ghost" onClick={() => setDeleting(r.id)}>
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      </Group>
      <div className="wb-actions" style={{ justifyContent: 'flex-start' }}>
        <button type="button" className="n-btn n-btn--primary" disabled={rules.length >= AUTOMATION_LIMITS.maxRules} onClick={() => setEditing('new')}>
          New automation
        </button>
      </div>
      <Group title="Activity">
        <div className="wb-list">
          {runs.length === 0 ? <div className="wb-empty">Nothing has run yet.</div> : null}
          {runs.map((x) => (
            <div key={x.id} className="wb-item">
              <div className="wb-item__main">
                <div className="wb-item__title">{x.note_title?.trim() || 'Untitled note'}</div>
                <div className="wb-item__meta">
                  {ruleName(x.rule_id)} · {ago(x.executed_at ?? x.evaluated_at)}
                  {x.status === 'failed' && x.reason ? ` · ${x.reason === 'no_summary' ? 'No summary to send' : x.reason}` : ''}
                  {x.status === 'needs_confirmation' && x.reason === 'sensitive' ? ' · May contain sensitive content' : ''}
                </div>
              </div>
              <div className="wb-item__side">
                <span className={`wb-badge${x.status === 'executed' ? ' wb-badge--ok' : x.status === 'failed' ? ' wb-badge--bad' : x.status === 'needs_confirmation' ? ' wb-badge--warn' : ''}`}>{STATUS_LABEL[x.status]}</span>
                {x.status === 'needs_confirmation' ? (
                  <>
                    <button type="button" className="n-btn n-btn--sm n-btn--primary" onClick={() => resolve(x, 'send')}>
                      Send
                    </button>
                    <button type="button" className="n-btn n-btn--sm" onClick={() => resolve(x, 'dismiss')}>
                      Don’t send
                    </button>
                  </>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      </Group>
      <p className="wb-note">Automations run while Notula is open. Anything missed is checked the next time you open Notula.</p>
      {editing ? <Editor initial={editing === 'new' ? null : editing} folders={folders} endpoints={endpoints} onClose={() => setEditing(null)} onSaved={() => void load()} /> : null}
    </>
  )
}
