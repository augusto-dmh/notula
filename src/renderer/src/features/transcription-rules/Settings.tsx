// SPDX-License-Identifier: Apache-2.0
// Settings ▸ Preferences ▸ Transcription rules: the internal domains, the rule list (each
// rule as a sentence with chips and badges, plus a switch, Edit and Delete) and the add / edit
// dialog. Every change saves the whole list through `transcription-rules:save`; main validates.

import { useEffect, useState, type JSX } from 'react'
import { RULE_LABELS, TRANSCRIPTION_RULES_LIMITS as L, type RuleAction, type RuleCondition, type TranscriptionRule } from '@shared/types/transcription-rules'
import { navigateToSettings } from '../../app/navigation'
import { showToast } from '../../app/toast'
import { ChipInput, errorText, InlineConfirm, Modal, normDomain, normEmail } from '../automations/ui'
import { Group, Row, Select, Switch } from '../settings/controls'
import { SettingsCard, SettingsRow } from '../settings/primitives'
import { usePrefs } from '../settings/prefs-store'
import './rules.css'

type Kept = 'always' | 'has_outside_guest' | 'internal_only' | 'guest_domain' | 'guest_email' | 'in_person' | 'event_name'

const WHEN: { value: Kept; label: string }[] = [
  { value: 'always', label: 'Every meeting' },
  { value: 'has_outside_guest', label: 'External participant' },
  { value: 'internal_only', label: 'Internal participants only' },
  { value: 'guest_domain', label: 'Participant domain' },
  { value: 'guest_email', label: 'Participant email' },
  { value: 'in_person', label: 'In-person meeting' },
  { value: 'event_name', label: 'Calendar event title' }
]
const KEPT = WHEN.map((w) => w.value as string)

function values(c: RuleCondition): string[] {
  const o = c as Record<string, unknown>
  const v = o['domains'] ?? o['emails'] ?? o['strings']
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

export function ruleDefaultText(r: TranscriptionRule): string {
  const t = (RULE_LABELS.defaultTexts as Record<string, string>)[r.condition.type]
  const lead = r.action === 'confirm' ? RULE_LABELS.leads.confirm : RULE_LABELS.leads.other
  return (t ?? '').replace('<lead>', lead)
}

export function TranscriptionRulesPreferencesRow(): JSX.Element | null {
  const prefs = usePrefs()
  if (prefs?.['transcriptionRules.enabled'] !== true) return null
  const n = prefs['transcriptionRules.rules'].filter((r) => r.enabled).length
  return (
    <SettingsCard>
      <SettingsRow
        title="Transcription rules"
        description={n ? `Notula follows ${n === 1 ? '1 rule' : `${n} rules`} when deciding whether to transcribe.` : 'Choose when Notula asks before transcribing, or skips a meeting.'}
        control={<span className="tr-chevron" aria-hidden="true">›</span>}
        onClick={() => navigateToSettings('transcription-rules')}
      />
    </SettingsCard>
  )
}

function RuleRow({ rule, onToggle, onEdit, onDelete }: { rule: TranscriptionRule; onToggle(v: boolean): void; onEdit(): void; onDelete(): void }): JSX.Element {
  const [asking, setAsking] = useState(false)
  const supported = KEPT.includes(rule.condition.type)
  const sentence = (RULE_LABELS.sentences as Record<string, string>)[rule.condition.type] ?? 'A rule Notula can’t read'
  const text = rule.presentation.text ?? ruleDefaultText(rule)
  return (
    <div className={`wb-item${rule.enabled && supported ? '' : ' wb-item--off'}`}>
      <div className="wb-item__main">
        <div className="wb-item__title">{sentence}</div>
        {values(rule.condition).length ? (
          <div className="wb-item__chips">
            {values(rule.condition).map((v) => (
              <span key={v} className="wb-chip">
                {v}
              </span>
            ))}
          </div>
        ) : null}
        {supported ? (
          <p className="wb-item__quote">
            “{text}”
            {rule.presentation.link ? (
              <>
                {' '}
                <a href={rule.presentation.link.url} target="_blank" rel="noreferrer">
                  {rule.presentation.link.label}
                </a>
              </>
            ) : null}
          </p>
        ) : (
          <p className="wb-item__meta">Not supported in Notula</p>
        )}
        {asking ? <InlineConfirm title="Delete this rule?" body="Notula stops checking meetings with it." action="Delete" onCancel={() => setAsking(false)} onConfirm={onDelete} /> : null}
      </div>
      <div className="wb-item__side">
        {supported ? <span className={`wb-badge ${rule.action === 'block' ? 'wb-badge--bad' : rule.action === 'override' ? 'wb-badge--warn' : 'wb-badge--accent'}`}>{RULE_LABELS.badges[rule.action]}</span> : null}
        {supported ? <Switch label="Rule on" checked={rule.enabled} onChange={onToggle} /> : null}
        {supported ? (
          <button type="button" className="n-btn n-btn--sm" onClick={onEdit}>
            Edit
          </button>
        ) : null}
        <button type="button" className="n-btn n-btn--sm n-btn--ghost" onClick={() => setAsking(true)}>
          Delete
        </button>
      </div>
    </div>
  )
}

function RuleEditor({ initial, onSave, onClose }: { initial: TranscriptionRule | null; onSave(r: TranscriptionRule): Promise<void>; onClose(): void }): JSX.Element {
  const [type, setType] = useState<Kept>((initial?.condition.type as Kept) ?? 'has_outside_guest')
  const [vals, setVals] = useState<string[]>(initial ? values(initial.condition) : [])
  const [action, setAction] = useState<RuleAction>(initial?.action ?? 'confirm')
  const [text, setText] = useState(initial?.presentation.text ?? '')
  const [linkLabel, setLinkLabel] = useState(initial?.presentation.link?.label ?? '')
  const [linkUrl, setLinkUrl] = useState(initial?.presentation.link?.url ?? '')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const needs = type === 'guest_domain' ? 'domains' : type === 'guest_email' ? 'emails' : type === 'event_name' ? 'strings' : null
  useEffect(() => {
    if (type === 'always') setAction('confirm')
  }, [type])

  const save = async (): Promise<void> => {
    setError(null)
    if (needs && !vals.length) {
      setError(needs === 'domains' ? 'Add at least one domain.' : needs === 'emails' ? 'Add at least one email address.' : 'Add at least one word.')
      return
    }
    if (linkUrl.trim() && !/^https?:\/\/\S+$/i.test(linkUrl.trim())) {
      setError('Links must start with http:// or https://.')
      return
    }
    const condition: RuleCondition =
      needs === 'domains' ? { type: 'guest_domain', domains: vals } : needs === 'emails' ? { type: 'guest_email', emails: vals } : needs === 'strings' ? { type: 'event_name', match: 'contains', strings: vals } : ({ type } as RuleCondition)
    const rule: TranscriptionRule = {
      id: initial?.id ?? '',
      enabled: initial?.enabled ?? true,
      action,
      condition,
      presentation: {
        text: text.trim() || null,
        link: text.trim() && linkLabel.trim() && linkUrl.trim() ? { label: linkLabel.trim(), url: linkUrl.trim() } : null
      }
    }
    setBusy(true)
    try {
      await onSave(rule)
      onClose()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title={initial ? 'Edit rule' : 'Add a rule'}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="n-btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="n-btn n-btn--primary" disabled={busy} onClick={() => void save()}>
            Save rule
          </button>
        </>
      }
    >
      <div className="wb-field">
        <label htmlFor="tr-when">When</label>
        <Select
          id="tr-when"
          wide
          value={type}
          options={WHEN}
          onChange={(v) => {
            setType(v)
            setVals([])
          }}
        />
      </div>
      {needs ? (
        <div className="wb-field">
          <span className="wb-label">{needs === 'domains' ? 'Domains' : needs === 'emails' ? 'Email addresses' : 'Title contains'}</span>
          <ChipInput
            label={needs}
            values={vals}
            onChange={setVals}
            placeholder={needs === 'domains' ? 'acme.com' : needs === 'emails' ? 'name@acme.com' : 'interview'}
            normalize={needs === 'domains' ? normDomain : needs === 'emails' ? normEmail : (v) => v.trim().toLowerCase() || null}
            invalidText={needs === 'domains' ? 'Enter domains like acme.com.' : 'Enter valid email addresses.'}
          />
        </div>
      ) : null}
      <div className="wb-field">
        <label htmlFor="tr-then">Then</label>
        <Select
          id="tr-then"
          wide
          value={action}
          options={(['confirm', 'override', 'block'] as RuleAction[]).map((a) => ({ value: a, label: RULE_LABELS.actions[a], disabled: type === 'always' && a !== 'confirm' }))}
          onChange={(v: RuleAction) => setAction(v)}
        />
        {type === 'always' ? <p className="wb-help">Every-meeting rules can only ask before transcribing.</p> : null}
      </div>
      <div className="wb-field">
        <label htmlFor="tr-msg">Message (optional)</label>
        <textarea id="tr-msg" className="n-input wb-textarea" maxLength={L.messageMax} placeholder={ruleDefaultText({ id: '', enabled: true, action, condition: { type } as RuleCondition, presentation: { text: null, link: null } })} value={text} onChange={(e) => setText(e.target.value)} />
      </div>
      <div className="wb-row-split">
        <div className="wb-field">
          <label htmlFor="tr-ll">Link label (optional)</label>
          <input id="tr-ll" className="n-input" maxLength={L.linkLabelMax} value={linkLabel} onChange={(e) => setLinkLabel(e.target.value)} placeholder="Recording policy" />
        </div>
        <div className="wb-field">
          <label htmlFor="tr-lu">Link URL</label>
          <input id="tr-lu" className="n-input" maxLength={L.urlMax} value={linkUrl} onChange={(e) => setLinkUrl(e.target.value)} placeholder="https://" />
        </div>
      </div>
      {error ? <p className="wb-error">{error}</p> : null}
    </Modal>
  )
}

export function TranscriptionRulesSettings(): JSX.Element {
  const prefs = usePrefs()
  const [data, setData] = useState<{ rules: TranscriptionRule[]; internalDomains: string[] } | null>(null)
  const [editing, setEditing] = useState<TranscriptionRule | 'new' | null>(null)

  useEffect(() => {
    let alive = true
    window.notula.transcriptionRules
      .list()
      .then((d) => alive && setData(d))
      .catch(() => alive && setData({ rules: [], internalDomains: [] }))
    return () => {
      alive = false
    }
  }, [])

  const save = async (next: { rules: TranscriptionRule[]; internalDomains: string[] }): Promise<void> => {
    const out = await window.notula.transcriptionRules.save(next)
    setData(out)
  }
  const saveQuiet = (next: { rules: TranscriptionRule[]; internalDomains: string[] }): void => {
    void save(next).catch((err: unknown) => showToast({ kind: 'error', title: errorText(err) }))
  }

  if (!data || !prefs) return <div className="n-skeleton" style={{ height: 160 }} />
  return (
    <div className="tr-page">
      <button type="button" className="tr-back" onClick={() => navigateToSettings('preferences')}>
        ‹ Preferences
      </button>
      <h2 className="tr-title">Transcription rules</h2>
      <p className="tr-intro">Rules tell Notula when to ask before transcribing, or not to transcribe at all, based on who is in the meeting, its title or where it happens.</p>
      {!prefs['transcriptionRules.enabled'] ? (
        <p className="wb-warning">
          Transcription rules are off.{' '}
          <button type="button" className="wb-link" onClick={() => navigateToSettings('labs')}>
            Turn them on in Labs
          </button>
        </p>
      ) : null}
      <Group title="Internal domains" description="Participants outside these domains count as external.">
        <Row label="Your company’s domains" stacked>
          <ChipInput
            label="Internal domains"
            values={data.internalDomains}
            onChange={(d) => saveQuiet({ ...data, internalDomains: d })}
            placeholder="acme.com"
            normalize={normDomain}
            invalidText="Enter domains like acme.com."
          />
        </Row>
      </Group>
      <Group title={data.rules.length === 1 ? '1 rule' : `${data.rules.length} rules`}>
        <div className="wb-list">
          {data.rules.length === 0 ? <div className="wb-empty">No rules yet. Add a rule to be asked, warned or blocked before Notula takes notes.</div> : null}
          {data.rules.map((r) => (
            <RuleRow
              key={r.id}
              rule={r}
              onToggle={(v) => saveQuiet({ ...data, rules: data.rules.map((x) => (x.id === r.id ? { ...x, enabled: v } : x)) })}
              onEdit={() => setEditing(r)}
              onDelete={() => saveQuiet({ ...data, rules: data.rules.filter((x) => x.id !== r.id) })}
            />
          ))}
        </div>
      </Group>
      <div className="wb-actions tr-add">
        <button type="button" className="n-btn n-btn--primary" disabled={data.rules.length >= L.maxRules} onClick={() => setEditing('new')}>
          Add rule
        </button>
      </div>
      {editing ? (
        <RuleEditor
          initial={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSave={(rule) =>
            save({
              ...data,
              rules: editing === 'new' ? [...data.rules, rule] : data.rules.map((x) => (x.id === rule.id ? rule : x))
            })
          }
        />
      ) : null}
    </div>
  )
}
