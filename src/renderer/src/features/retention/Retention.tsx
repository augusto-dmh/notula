// SPDX-License-Identifier: Apache-2.0
// Transcript auto-deletion: Preferences ▸ Your data's period
// picker with the preview dialog and the cooldown line, the Deletion log, and the transcript tab's
// "deleted by auto-deletion" notice with the first-purge tip.

import { useEffect, useState, type JSX } from 'react'
import { RETENTION_OPTIONS, type RetentionHours, type RetentionPreview, type RetentionRun, type RetentionState } from '@shared/types/retention'
import { navigateToSettings } from '../../app/navigation'
import { useNote } from '../enhance/store'
import { Modal } from '../folders/Modal'
import { NuxTip } from '../nux'
import { Select } from '../settings/controls'
import { SettingsCard, SettingsRow } from '../settings/primitives'
import './retention.css'

type Choice = 'off' | `${RetentionHours}`

let state: RetentionState | null = null
const listeners = new Set<() => void>()
let subscribed = false

function setState(s: RetentionState): void {
  state = s
  for (const l of listeners) l()
}

function useRetention(): RetentionState | null {
  const [, tick] = useState(0)
  useEffect(() => {
    if (!subscribed) {
      subscribed = true
      window.notula.retention.onChanged(setState)
    }
    const l = (): void => tick((n) => n + 1)
    listeners.add(l)
    void window.notula.retention.get().then(setState).catch(() => undefined)
    return () => {
      listeners.delete(l)
    }
  }, [])
  return state
}

function label(h: RetentionHours | null): string {
  return RETENTION_OPTIONS.find((o) => o.hours === h)?.label ?? 'Off'
}

function day(iso: string | null): string {
  if (!iso) return ''
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
}

function errorText(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message.replace(/^.*?(?:[a-z-]+): /, '') || fallback : fallback
}

function ArmDialog({
  hours,
  from,
  preview,
  onClose
}: {
  hours: RetentionHours
  from: RetentionHours | null
  preview: RetentionPreview
  onClose(): void
}): JSX.Element {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const period = label(hours).toLowerCase()
  const enable = (): void => {
    setBusy(true)
    setError(null)
    window.notula.retention
      .set({ hours, confirmed: true })
      .then((s) => {
        setState(s)
        onClose()
      })
      .catch((err: unknown) => setError(errorText(err, 'Not changed.')))
      .finally(() => setBusy(false))
  }
  const counts =
    preview.notes > 0
      ? `This will delete the transcripts of ${preview.notes} ${preview.notes === 1 ? 'note' : 'notes'} and ${preview.recordings} ${
          preview.recordings === 1 ? 'recording' : 'recordings'
        }, from ${day(preview.oldest)} to ${day(preview.newest)}. Your notes, summaries and chats are kept.`
      : 'No transcript is old enough to be deleted yet. Your notes, summaries and chats are always kept.'
  return (
    <Modal label="Delete transcripts automatically" onClose={onClose}>
      <div className="h-modal__body retention-dialog">
        <h2 className="h-modal__title">{from === null ? 'Delete transcripts automatically?' : 'Delete transcripts sooner?'}</h2>
        <p className="h-modal__subtitle">Transcripts will be deleted automatically after {period}.</p>
        <p className="retention-dialog__counts">{counts}</p>
        <p className="retention-dialog__warn">
          Once deleted, transcripts and recordings can’t be recovered. Chat and new enhanced notes won’t be able to use them.
        </p>
        <p className="retention-dialog__hint">Deletion starts in 7 days. Until then, you can cancel it here.</p>
        {error ? (
          <p className="retention-error" role="alert">
            {error}
          </p>
        ) : null}
        <footer className="retention-dialog__actions">
          <button type="button" className="n-btn n-btn--ghost" data-autofocus onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="n-btn n-btn--danger" disabled={busy} onClick={enable}>
            {busy ? 'Enabling…' : 'Enable'}
          </button>
        </footer>
      </div>
    </Modal>
  )
}

export function RetentionRows(): JSX.Element {
  const s = useRetention()
  const [dialog, setDialog] = useState<{ hours: RetentionHours; preview: RetentionPreview } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (!s) return <></>
  const value: Choice = s.hours === null ? 'off' : `${s.hours}`
  const change = (next: Choice): void => {
    const hours = next === 'off' ? null : (Number(next) as RetentionHours)
    if (hours === s.hours && s.pendingHours === null) return
    setError(null)
    setBusy(true)
    const deletesMore = hours !== null && (s.hours === null || hours < s.hours)
    const run = deletesMore
      ? window.notula.retention.preview({ hours }).then((preview) => setDialog({ hours, preview }))
      : window.notula.retention.set({ hours }).then(setState)
    run.catch((err: unknown) => setError(errorText(err, 'Not changed.'))).finally(() => setBusy(false))
  }
  const cancelPending = (): void => {
    void window.notula.retention
      .cancelPending()
      .then(setState)
      .catch((err: unknown) => setError(errorText(err, 'Not changed.')))
  }
  return (
    <div id="retention-rows">
      <SettingsCard>
        <SettingsRow
          title="Delete transcripts after"
          description="Delete transcripts and recordings automatically after this long. Notes and enhanced notes stay."
          control={
            <Select<Choice>
              label="Delete transcripts after"
              value={value}
              disabled={busy}
              options={RETENTION_OPTIONS.map((o) => ({ value: o.hours === null ? 'off' : (`${o.hours}` as Choice), label: o.label }))}
              onChange={change}
            />
          }
        />
        {s.pendingHours !== null && s.effectiveAt ? (
          <div className="retention-pending">
            <span>
              {label(s.pendingHours)}: starts on {day(s.effectiveAt)}. Nothing is deleted before then.
            </span>
            <button type="button" className="retention-link" onClick={cancelPending}>
              Cancel change
            </button>
          </div>
        ) : null}
        {error ? (
          <p className="retention-error retention-error--inline" role="alert">
            {error}
          </p>
        ) : null}
      </SettingsCard>
      {dialog ? <ArmDialog hours={dialog.hours} from={s.hours} preview={dialog.preview} onClose={() => setDialog(null)} /> : null}
    </div>
  )
}

function runLine(r: RetentionRun): string {
  if (!r.notes) return 'Nothing was old enough to delete.'
  const rec = r.recordings ? ` and ${r.recordings} ${r.recordings === 1 ? 'recording' : 'recordings'}` : ''
  return `Deleted the transcripts of ${r.notes} ${r.notes === 1 ? 'note' : 'notes'}${rec}.`
}

export function DeletionLog(): JSX.Element {
  const s = useRetention()
  const [runs, setRuns] = useState<RetentionRun[] | null>(null)
  const last = s?.lastRun?.id ?? null
  useEffect(() => {
    void window.notula.retention.getLog().then(setRuns).catch(() => setRuns([]))
  }, [last])
  if (!runs?.length) return <></>
  return (
    <div id="retention-log">
      <SettingsCard title="Deletion log" description="The last 20 auto-deletion runs on this computer.">
        <ul className="retention-log">
          {runs.map((r) => (
            <li key={r.id} className="retention-log__row">
              <span className="retention-log__when">
                {new Date(r.ran_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
              </span>
              <span className="retention-log__what">
                {runLine(r)} <span className="retention-log__period">Older than {label(r.period_hours).toLowerCase()}.</span>
                {r.errors.length ? <span className="retention-log__errors"> {r.errors.length} could not be deleted and will be retried.</span> : null}
              </span>
            </li>
          ))}
        </ul>
      </SettingsCard>
    </div>
  )
}

function openLog(): void {
  navigateToSettings('preferences')
  window.setTimeout(() => document.getElementById('retention-log')?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 120)
}

export function TranscriptDeletedNotice({ noteId }: { noteId: string }): JSX.Element | null {
  const note = useNote(noteId)
  const [first, setFirst] = useState<RetentionRun | null>(null)
  useEffect(() => {
    void window.notula.retention
      .getLog()
      .then((runs) => setFirst([...runs].reverse().find((r) => r.notes > 0) ?? null))
      .catch(() => undefined)
  }, [])
  const at = note?.transcript_purged_at ?? null
  if (!at) return null
  return (
    <div className="retention-notice">
      <p>This transcript was deleted on {day(at)} by auto-deletion.</p>
      <button
        type="button"
        className="retention-link"
        onClick={() => {
          navigateToSettings('preferences')
          window.setTimeout(() => document.getElementById('retention-rows')?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 120)
        }}
      >
        Auto-deletion settings
      </button>
      {first ? (
        <NuxTip
          id={`retention-first-purge:${first.id}`}
          title="Old transcripts deleted"
          body={`Notula deleted the transcripts of ${first.notes} ${first.notes === 1 ? 'note' : 'notes'} older than ${label(first.period_hours).toLowerCase()}.`}
          onAction={openLog}
        />
      ) : null}
    </div>
  )
}
