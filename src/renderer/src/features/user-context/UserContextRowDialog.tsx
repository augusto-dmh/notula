// SPDX-License-Identifier: Apache-2.0
// The dialog behind a Wiki row: one profile section, or the projects or terms table. Edits stay
// in the dialog until Save; Cancel and Escape drop them. The rules are the page's: a section
// shows where its text came from, a draft never replaces the user's text without asking, and
// main checks every table limit (the checks here only save a round trip).

import { useEffect, useRef, useState, type JSX } from 'react'
import { parseError } from '@shared/errors'
import {
  USER_CONTEXT_LIMITS,
  USER_CONTEXT_SECTIONS,
  type UserContextEntry,
  type UserContextEntryKind,
  type UserContextSection,
  type UserContextSectionId,
  type UserContextState
} from '@shared/types/user-context'
import { IconSparkle } from '../../app/icons'
import { Modal } from '../folders/Modal'

/** A row of the Wiki page: a section, or one of the two tables. */
export type RowId = UserContextSectionId | 'projects' | 'terms'

export function isRowId(id: string | undefined): id is RowId {
  return id === 'projects' || id === 'terms' || USER_CONTEXT_SECTIONS.some((s) => s.id === id)
}

export const HINTS: Record<UserContextSectionId, string> = {
  identity: 'Your role, team and company, and what you are responsible for.',
  'current-work': 'What you are working on now, and what matters most.',
  relationships: 'Who you deal with most often, and what each person is to you: a manager, a client, a peer.',
  teams: 'The groups you belong to, how often each one meets, and duties that come back on a schedule.',
  'work-habits': 'How you like to work and make decisions. For example: "Prefers bullet points".',
  communication: 'How you write and speak, and the formats you prefer. Chat uses this to write in your voice.',
  calendar: 'Your meetings and scheduling habits.',
  reference: 'Where your notes and other work usually go: channels, folders and systems. Your vocabulary goes in Terms.',
  'assistant-guide': 'A short guide for colleagues working with you.'
}

export const PROJECTS_LEAD = 'The projects you work on, each summed up in a sentence or two, with the role you play. Up to 30 projects.'
export const TERMS_LEAD = 'Names, acronyms and jargon you use, with what they mean, so summaries and chat get them right. Up to 200 terms.'
export const FOLD_NOTE = 'Your edits here, and notes you take outside meetings, are folded in at the next refresh.'

const DRAFTED = new Set<UserContextSectionId>(USER_CONTEXT_SECTIONS.filter((s) => s.drafted).map((s) => s.id))

export function dateLabel(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

export function provenanceText(section: UserContextSection): string {
  return section.origin === 'drafted' && section.drafted_at ? `Drafted from your meetings · Saved ${dateLabel(section.updated_at)}` : 'Written by you'
}

function Provenance({ section }: { section: UserContextSection }): JSX.Element {
  return <p className="uc-prov">{provenanceText(section)}</p>
}

/** Before drafting turns on: how many recorded meetings so far, as a ring. */
export function UnlockNote({ unlock }: { unlock: UserContextState['unlock'] }): JSX.Element {
  const r = 9
  const length = 2 * Math.PI * r
  const done = Math.min(1, unlock.recorded / unlock.needed)
  return (
    <div className="uc-unlock">
      <svg className="uc-unlock__ring" width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r={r} className="uc-unlock__track" />
        <circle cx="12" cy="12" r={r} className="uc-unlock__done" strokeDasharray={`${done * length} ${length}`} transform="rotate(-90 12 12)" />
      </svg>
      <div>
        <p className="uc-unlock__count">
          {unlock.recorded} of {unlock.needed} meetings recorded
        </p>
        <p className="uc-unlock__text">Notula can draft your profile after {unlock.needed} recorded meetings. You can write it yourself now.</p>
      </div>
    </div>
  )
}

export interface RowDialogProps {
  row: RowId
  state: UserContextState
  /** A draft or refresh is running. */
  busy: boolean
  /** The running draft writes this section. */
  drafting: boolean
  onDraft(id: UserContextSectionId, overwriteUser: boolean): void
  onClose(): void
}

export function UserContextRowDialog(p: RowDialogProps): JSX.Element {
  if (p.row === 'projects' || p.row === 'terms') {
    return (
      <TableDialog
        kind={p.row === 'projects' ? 'project' : 'term'}
        rows={p.row === 'projects' ? p.state.projects : p.state.terms}
        busy={p.busy}
        onClose={p.onClose}
      />
    )
  }
  const id = p.row
  return (
    <SectionDialog
      id={id}
      section={p.state.sections.find((s) => s.section_id === id) ?? null}
      unlock={p.state.unlock}
      everDrafted={p.state.refresh.drafted}
      busy={p.busy}
      drafting={p.drafting}
      onDraft={(overwrite) => p.onDraft(id, overwrite)}
      onClose={p.onClose}
    />
  )
}

function SectionDialog(p: {
  id: UserContextSectionId
  section: UserContextSection | null
  unlock: UserContextState['unlock']
  /** Drafted once: the unlock no longer applies. */
  everDrafted: boolean
  busy: boolean
  drafting: boolean
  onDraft(overwriteUser: boolean): void
  onClose(): void
}): JSX.Element {
  const title = USER_CONTEXT_SECTIONS.find((s) => s.id === p.id)!.title
  const draftable = DRAFTED.has(p.id)
  const locked = !p.everDrafted && p.unlock.recorded < p.unlock.needed
  const [text, setText] = useState(p.section?.content ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [asking, setAsking] = useState(false)
  const saved = useRef(p.section?.content ?? '')
  const dirty = text !== saved.current

  // A draft (or another window) changed the stored text: take it unless the user is mid-edit.
  useEffect(() => {
    const next = p.section?.content ?? ''
    if (next !== saved.current && text === saved.current) setText(next)
    saved.current = next
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.section?.content])

  const save = async (): Promise<void> => {
    if (!dirty) {
      p.onClose()
      return
    }
    setSaving(true)
    setError(null)
    try {
      await window.notula.userContext.update({ sectionId: p.id, content: text })
      p.onClose()
    } catch (err) {
      setError(`Couldn’t save. ${parseError(err).message || 'Try again.'}`)
      setSaving(false)
    }
  }

  // The user's own text is replaced only after they say so.
  const draft = (): void => {
    if (p.section?.origin === 'user' && p.section.content.trim()) setAsking(true)
    else p.onDraft(false)
  }

  return (
    <Modal label={title} className="uc-dialog" onClose={p.onClose}>
      <form
        className="h-modal__body"
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        <div className="h-modal__header">
          <div>
            <h2 className="h-modal__title">{title}</h2>
            <p className="h-modal__subtitle">{HINTS[p.id]}</p>
          </div>
        </div>
        {draftable && locked ? <UnlockNote unlock={p.unlock} /> : null}
        {asking ? (
          <div className="uc-confirm" role="alertdialog" aria-label="Replace your text?">
            <p>This section holds text you wrote. Replace it with a draft from your meetings?</p>
            <div className="uc-confirm__actions">
              <button type="button" className="n-btn n-btn--sm n-btn--ghost" onClick={() => setAsking(false)}>
                Keep mine
              </button>
              <button
                type="button"
                className="n-btn n-btn--sm n-btn--danger"
                onClick={() => {
                  setAsking(false)
                  p.onDraft(true)
                }}
              >
                Replace
              </button>
            </div>
          </div>
        ) : null}
        <textarea
          className="n-input uc-editor"
          data-autofocus
          aria-label={title}
          value={text}
          maxLength={USER_CONTEXT_LIMITS.sectionMax}
          placeholder="Nothing yet. Add what Notula should know about you."
          disabled={p.drafting || saving}
          onChange={(e) => setText(e.target.value)}
        />
        <div className="uc-editor__meta">
          {p.section && p.section.content.trim() ? <Provenance section={p.section} /> : <span />}
          <span className="uc-count">{`${text.length.toLocaleString()} / ${USER_CONTEXT_LIMITS.sectionMax.toLocaleString()}`}</span>
        </div>
        {error ? (
          <p className="uc-dialog__error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="h-modal__footer uc-dialog__footer">
          {draftable ? (
            <button
              type="button"
              className="n-btn n-btn--sm n-btn--ghost uc-dialog__draft"
              disabled={p.busy || locked || dirty || saving}
              title={dirty ? 'Save or cancel your changes first' : undefined}
              onClick={draft}
            >
              {p.drafting ? <span className="n-spinner" aria-hidden="true" /> : <IconSparkle size={14} />}
              {p.drafting ? 'Drafting…' : 'Draft from my meetings'}
            </button>
          ) : null}
          <button type="button" className="n-btn" onClick={p.onClose}>
            Cancel
          </button>
          <button type="submit" className="n-btn n-btn--primary" disabled={saving || p.drafting}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </Modal>
  )
}

const ENTRY_LIMITS: Record<UserContextEntryKind, { name: number; body: number; rows: number; noun: string; one: string }> = {
  term: { name: USER_CONTEXT_LIMITS.termMax, body: USER_CONTEXT_LIMITS.termBodyMax, rows: USER_CONTEXT_LIMITS.termsMax, noun: 'terms', one: 'term' },
  project: {
    name: USER_CONTEXT_LIMITS.projectNameMax,
    body: USER_CONTEXT_LIMITS.projectBodyMax,
    rows: USER_CONTEXT_LIMITS.projectsMax,
    noun: 'projects',
    one: 'project'
  }
}

interface EditRow {
  key: string
  entry: UserContextEntry | null
  name: string
  body: string
  role: string
}

let nextKey = 0
const editOf = (e: UserContextEntry | null): EditRow => ({ key: e?.id ?? `new-${++nextKey}`, entry: e, name: e?.name ?? '', body: e?.body ?? '', role: e?.role ?? '' })
const changed = (r: EditRow): boolean =>
  !r.entry || r.name.trim() !== r.entry.name.trim() || r.body.trim() !== r.entry.body.trim() || r.role.trim() !== (r.entry.role ?? '').trim()
const rowsKey = (rows: UserContextEntry[]): string => JSON.stringify(rows.map((r) => [r.id, r.name, r.body, r.role, r.origin]))

/** A terms or projects table, staged: Save sends the deletions, the changes and the new rows. */
function TableDialog(p: { kind: UserContextEntryKind; rows: UserContextEntry[]; busy: boolean; onClose(): void }): JSX.Element {
  const L = ENTRY_LIMITS[p.kind]
  const project = p.kind === 'project'
  const title = project ? 'Projects' : 'Terms'
  const [rows, setRows] = useState<EditRow[]>(() => p.rows.map(editOf))
  const [touched, setTouched] = useState(false)
  const [added, setAdded] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // A refresh (or another window) changed the table: take it unless the user has edited here.
  const key = rowsKey(p.rows)
  useEffect(() => {
    if (!touched) setRows(p.rows.map(editOf))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  const edit = (k: string, patch: Partial<EditRow>): void => {
    setTouched(true)
    setRows((list) => list.map((r) => (r.key === k ? { ...r, ...patch } : r)))
  }
  const remove = (k: string): void => {
    setTouched(true)
    setRows((list) => list.filter((r) => r.key !== k))
  }
  const add = (): void => {
    const row = editOf(null)
    setTouched(true)
    setAdded(row.key)
    setRows((list) => [...list, row])
  }

  const save = async (): Promise<void> => {
    // A new row left without a name or text is dropped; every other row needs a name.
    const kept = rows.filter((r) => r.entry || r.name.trim() || r.body.trim() || r.role.trim())
    if (kept.some((r) => !r.name.trim())) {
      setError(`Every ${L.one} needs a name.`)
      return
    }
    const seen = new Set<string>()
    for (const r of kept) {
      const n = r.name.trim().toLocaleLowerCase()
      if (seen.has(n)) {
        setError(`“${r.name.trim()}” is listed twice. Keep one.`)
        return
      }
      seen.add(n)
    }
    if (kept.length > L.rows) {
      setError(`You can keep up to ${L.rows} ${L.noun}. Delete one to add another.`)
      return
    }
    const removed = p.rows.filter((e) => !kept.some((r) => r.entry?.id === e.id))
    const writes = kept.filter(changed)
    setSaving(true)
    setError(null)
    try {
      for (const e of removed) await window.notula.userContext.deleteEntry({ id: e.id })
      for (const r of writes) {
        await window.notula.userContext.setEntry({
          ...(r.entry ? { id: r.entry.id } : {}),
          kind: p.kind,
          name: r.name.trim(),
          body: r.body.trim(),
          role: project ? r.role.trim() || null : null
        })
      }
      p.onClose()
    } catch (err) {
      // What was saved stays saved; the table shows the rest still to fix.
      setError(`Couldn’t save every change. ${parseError(err).message || 'Try again.'}`)
      setSaving(false)
    }
  }

  const full = rows.length >= L.rows
  const disabled = p.busy || saving
  const field = (r: EditRow, k: 'name' | 'body' | 'role', max: number, label: string, autofocus: boolean): JSX.Element => (
    <td>
      <input
        className="uc-cell"
        value={r[k]}
        maxLength={max}
        aria-label={label}
        disabled={disabled}
        data-autofocus={autofocus || undefined}
        autoFocus={k === 'name' && r.key === added}
        onChange={(e) => edit(r.key, { [k]: e.target.value })}
      />
    </td>
  )

  return (
    <Modal label={title} className="uc-dialog uc-dialog--table" onClose={p.onClose}>
      <form
        className="h-modal__body"
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        <div className="h-modal__header">
          <div>
            <h2 className="h-modal__title">{title}</h2>
            <p className="h-modal__subtitle">{project ? PROJECTS_LEAD : TERMS_LEAD}</p>
          </div>
        </div>
        <div className="uc-table-wrap">
          <table className="uc-table">
            <thead>
              <tr>
                <th scope="col">{project ? 'Project' : 'Term'}</th>
                <th scope="col">{project ? 'Summary' : 'Meaning'}</th>
                {project ? <th scope="col">Your role</th> : null}
                <th scope="col">
                  <span className="uc-sr">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const name = r.name.trim() || (project ? 'this project' : 'this term')
                return (
                  <tr key={r.key} className={r.entry ? undefined : 'uc-table__new'}>
                    {field(r, 'name', L.name, project ? 'Project name' : 'Term', i === 0)}
                    {field(r, 'body', L.body, project ? 'Summary' : 'Meaning', false)}
                    {project ? field(r, 'role', USER_CONTEXT_LIMITS.projectRoleMax, 'Your role', false) : null}
                    <td className="uc-table__actions">
                      {r.entry?.origin === 'drafted' && !changed(r) ? <span className="uc-badge">Drafted</span> : null}
                      <button type="button" className="uc-chip__remove" aria-label={`Delete ${name}`} disabled={disabled} onClick={() => remove(r.key)}>
                        ×
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {rows.length === 0 ? <p className="uc-muted">{project ? 'No projects yet.' : 'No terms yet.'}</p> : null}
        </div>
        {full ? (
          <p className="uc-muted">{`You can keep up to ${L.rows} ${L.noun}. Delete one to add another.`}</p>
        ) : (
          <div>
            <button type="button" className="n-btn n-btn--sm n-btn--ghost" disabled={disabled} onClick={add}>
              {project ? 'Add a project' : 'Add a term'}
            </button>
          </div>
        )}
        <p className="uc-muted uc-fold">{FOLD_NOTE}</p>
        {error ? (
          <p className="uc-dialog__error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="h-modal__footer">
          <button type="button" className="n-btn" onClick={p.onClose}>
            Cancel
          </button>
          <button type="submit" className="n-btn n-btn--primary" disabled={disabled}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
