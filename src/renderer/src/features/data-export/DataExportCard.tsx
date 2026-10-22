// SPDX-License-Identifier: Apache-2.0
// Preferences ▸ Your data ▸ Export notes. The dialog
// has the six choices with their defaults, Choose folder… (main's picker), the plaintext
// confirmation and the decrypted-copy acknowledgement (both re-checked in main), progress
// with Cancel, and the closing toast. The renderer never touches the file system.
// While Sources is on (Windows), a second row, Export notes as Markdown, opens the same dialog
// in Markdown mode: notes in their folders with their sources, transcripts beside them.

import { useCallback, useEffect, useId, useRef, useState, type JSX, type ReactNode } from 'react'
import { parseError } from '@shared/errors'
import type { DataExportDone, DataExportFormat, DataExportInclude, DataExportProgress } from '@shared/types/data-export'
import type { StorageStatus } from '@shared/types/storage'
import { debugLog, isMac } from '../../app/platform'
import { usePrefs } from '../settings/prefs-store'
import { showToast } from '../../app/toast'
import './data-export.css'

const DEFAULTS: DataExportInclude & { includeTrash: boolean } = {
  notes: true,
  transcripts: true,
  index: true,
  includeTrash: false,
  encryptedDb: false,
  decryptedDb: false
}

type Step =
  | { kind: 'choose' }
  | { kind: 'confirm' }
  | { kind: 'running'; exportId: string | null; progress: DataExportProgress | null; cancelling: boolean }

function Check({
  label,
  hint,
  checked,
  onChange,
  disabled
}: {
  label: string
  hint?: ReactNode
  checked: boolean
  onChange(next: boolean): void
  disabled?: boolean
}): JSX.Element {
  const id = useId()
  return (
    <div className="dx-check">
      <input id={id} type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <label htmlFor={id}>
        <span className="dx-check__label">{label}</span>
        {hint ? <span className="dx-check__hint">{hint}</span> : null}
      </label>
    </div>
  )
}

function progressText(p: DataExportProgress | null): string {
  if (!p) return 'Preparing…'
  switch (p.phase) {
    case 'notes':
      return `Exporting ${p.done} of ${p.total}…`
    case 'transcripts':
      return `Exporting transcripts ${p.done} of ${p.total}…`
    case 'index':
      return 'Writing the index…'
    case 'database':
      return 'Copying the database…'
  }
}

function doneToast(d: DataExportDone, notesChosen: boolean): void {
  if (d.cancelled) {
    showToast({ id: 'data-export', kind: 'info', title: 'Export cancelled' })
    return
  }
  if (d.errors.length > 0) {
    const k = d.errors.length
    showToast({ id: 'data-export', kind: 'error', title: `Export finished with ${k} ${k === 1 ? 'problem' : 'problems'} — see README.txt` })
    return
  }
  if (!notesChosen) {
    showToast({ id: 'data-export', kind: 'success', title: 'Export finished' })
    return
  }
  const n = d.counts.notes
  showToast({ id: 'data-export', kind: 'success', title: `Exported ${n} ${n === 1 ? 'note' : 'notes'}` })
}

/** Markdown mode: notes always, transcripts beside them, no index or database copies. */
const MARKDOWN_DEFAULTS: typeof DEFAULTS = { ...DEFAULTS, index: false }

function ExportDialog({ onClose, format }: { onClose(): void; format: DataExportFormat }): JSX.Element {
  const markdown = format === 'markdown'
  const [choice, setChoice] = useState(markdown ? MARKDOWN_DEFAULTS : DEFAULTS)
  const [acknowledged, setAcknowledged] = useState(false)
  const [folder, setFolder] = useState<string | null>(null)
  const [step, setStep] = useState<Step>({ kind: 'choose' })
  const [error, setError] = useState<string | null>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const exportIdRef = useRef<string | null>(null)
  const notesChosen = choice.notes || choice.transcripts || choice.index

  const running = step.kind === 'running'
  const notesChosenRef = useRef(notesChosen)
  notesChosenRef.current = notesChosen

  useEffect(() => {
    dialogRef.current?.querySelector<HTMLElement>('input, button')?.focus()
  }, [])

  useEffect(() => {
    const offProgress = window.notula.dataExport.onProgress((p) => {
      if (exportIdRef.current && p.exportId !== exportIdRef.current) return
      setStep((s) => (s.kind === 'running' ? { ...s, progress: p } : s))
    })
    const offDone = window.notula.dataExport.onDone((d) => {
      if (exportIdRef.current && d.exportId !== exportIdRef.current) return
      exportIdRef.current = null
      doneToast(d, notesChosenRef.current)
      onClose()
    })
    return () => {
      offProgress()
      offDone()
    }
  }, [onClose])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      if (step.kind === 'confirm') setStep({ kind: 'choose' })
      else if (!running) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [step.kind, running, onClose])

  const nothing = !notesChosen && !choice.encryptedDb && !choice.decryptedDb
  const canExport = folder !== null && !nothing && (!choice.decryptedDb || acknowledged)

  async function chooseFolder(): Promise<void> {
    try {
      const res = await window.notula.dataExport.chooseFolder()
      if ('path' in res) {
        setFolder(res.path)
        setError(null)
      }
    } catch (err) {
      debugLog('data-export:choose-failed', { code: parseError(err).code })
    }
  }

  async function start(confirmedPlaintext: boolean): Promise<void> {
    if (!folder) return
    setError(null)
    setStep({ kind: 'running', exportId: null, progress: null, cancelling: false })
    try {
      const { exportId } = await window.notula.dataExport.start({
        folder,
        include: {
          notes: choice.notes,
          transcripts: choice.transcripts,
          index: choice.index,
          encryptedDb: choice.encryptedDb,
          decryptedDb: choice.decryptedDb
        },
        includeTrash: choice.includeTrash,
        confirmedPlaintext,
        confirmedDecryptedDb: choice.decryptedDb && acknowledged,
        ...(markdown ? { format } : {})
      })
      exportIdRef.current = exportId
      setStep((s) => (s.kind === 'running' ? { ...s, exportId } : s))
    } catch (err) {
      setError(parseError(err).message)
      setStep({ kind: 'choose' })
    }
  }

  function onExport(): void {
    if (!canExport) return
    // Plaintext files need an explicit confirmation first.
    if (notesChosen) setStep({ kind: 'confirm' })
    else void start(false)
  }

  function cancel(): void {
    if (step.kind !== 'running' || !step.exportId || step.cancelling) return
    setStep({ ...step, cancelling: true })
    void window.notula.dataExport.cancel({ exportId: step.exportId }).catch(() => undefined)
  }

  const set = (patch: Partial<typeof DEFAULTS>): void => setChoice((c) => ({ ...c, ...patch }))

  return (
    <div className="dx-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !running && onClose()}>
      <div className="dx-dialog" role="dialog" aria-modal="true" aria-labelledby="dx-title" ref={dialogRef}>
        <h2 className="dx-dialog__title" id="dx-title">
          {markdown ? 'Export notes as Markdown' : 'Export notes'}
        </h2>

        {step.kind === 'choose' ? (
          <>
            <div className="dx-dialog__body">
              {markdown ? (
                <fieldset className="dx-group">
                  <legend>Files</legend>
                  <p className="dx-note">One file per note, in folders named like your Notula folders. Video and lesson notes keep their source and [mm:ss] links.</p>
                  <Check
                    label="Transcripts"
                    hint="A .transcript.md file beside each note, with [mm:ss] times"
                    checked={choice.transcripts}
                    onChange={(v) => set({ transcripts: v })}
                  />
                  <Check label="Include notes in Trash" checked={choice.includeTrash} onChange={(v) => set({ includeTrash: v })} />
                </fieldset>
              ) : (
                <>
                  <fieldset className="dx-group">
                    <legend>Files</legend>
                    <Check label="Notes (Markdown)" hint="Your notes and AI summaries, one file per note" checked={choice.notes} onChange={(v) => set({ notes: v })} />
                    <Check label="Transcripts (text)" hint="One file per note with a transcript" checked={choice.transcripts} onChange={(v) => set({ transcripts: v })} />
                    <Check label="Index (CSV)" hint="A list of every exported note, for spreadsheet apps" checked={choice.index} onChange={(v) => set({ index: v })} />
                    <Check
                      label="Include notes in Trash"
                      checked={choice.includeTrash}
                      disabled={!notesChosen}
                      onChange={(v) => set({ includeTrash: v })}
                    />
                  </fieldset>
                  <fieldset className="dx-group">
                    <legend>Database</legend>
                    <Check
                      label="Database backup (encrypted)"
                      hint="Opens only on this computer, signed in as you"
                      checked={choice.encryptedDb}
                      onChange={(v) => set({ encryptedDb: v })}
                    />
                    <Check
                      label="Decrypted database copy"
                      hint="A plain SQLite file anyone can open"
                      checked={choice.decryptedDb}
                      onChange={(v) => {
                        set({ decryptedDb: v })
                        if (!v) setAcknowledged(false)
                      }}
                    />
                    {choice.decryptedDb ? (
                      <div className="dx-ack">
                        <Check
                          label="I understand this copy is not protected by Notula’s encryption and can be opened by anyone with the file."
                          checked={acknowledged}
                          onChange={setAcknowledged}
                        />
                      </div>
                    ) : null}
                  </fieldset>
                </>
              )}
              <div className="dx-folder">
                <button type="button" className="n-btn n-btn--sm" onClick={() => void chooseFolder()}>
                  Choose folder…
                </button>
                <span className={`dx-folder__path${folder ? '' : ' dx-folder__path--empty'}`} title={folder ?? undefined}>
                  {folder ?? 'No folder chosen'}
                </span>
              </div>
              {folder ? (
                <p className="dx-note">
                  Notula adds a new “{markdown ? 'Notula Markdown export …' : 'Notula export …'}” folder there and changes nothing else in it.
                </p>
              ) : null}
              {error ? (
                <p className="dx-error" role="alert">
                  {error}
                </p>
              ) : null}
            </div>
            <div className="dx-dialog__footer">
              <button type="button" className="n-btn" onClick={onClose}>
                Cancel
              </button>
              <button type="button" className="n-btn n-btn--primary" disabled={!canExport} onClick={onExport}>
                Export
              </button>
            </div>
          </>
        ) : null}

        {step.kind === 'confirm' ? (
          <>
            <div className="dx-dialog__body">
              <p className="dx-warning">These files are not encrypted. Anyone who can open this folder can read your notes.</p>
            </div>
            <div className="dx-dialog__footer">
              <button type="button" className="n-btn" onClick={() => setStep({ kind: 'choose' })}>
                Cancel
              </button>
              <button type="button" className="n-btn n-btn--primary" autoFocus onClick={() => void start(true)}>
                Export
              </button>
            </div>
          </>
        ) : null}

        {step.kind === 'running' ? (
          <>
            <div className="dx-dialog__body">
              <div className="dx-progress" role="status">
                <span className="n-spinner" aria-hidden="true" />
                <span>{step.cancelling ? 'Cancelling…' : progressText(step.progress)}</span>
              </div>
              {step.progress && step.progress.total > 0 ? (
                <div className="dx-bar" aria-hidden="true">
                  <div className="dx-bar__fill" style={{ width: `${Math.round((step.progress.done / step.progress.total) * 100)}%` }} />
                </div>
              ) : null}
            </div>
            <div className="dx-dialog__footer">
              <button type="button" className="n-btn" disabled={!step.exportId || step.cancelling} onClick={cancel}>
                Cancel
              </button>
            </div>
          </>
        ) : null}
      </div>
    </div>
  )
}

/** The "Your data" card, last on Settings ▸ Preferences. */
export function DataExportCard(): JSX.Element {
  const [open, setOpen] = useState<DataExportFormat | null>(null)
  const prefs = usePrefs()
  const sources = !isMac && prefs?.['sources.enabled'] === true
  const [status, setStatus] = useState<StorageStatus | null>(null)
  const close = useCallback(() => setOpen(null), [])

  useEffect(() => {
    void window.notula.storage.getStatus().then(setStatus).catch(() => undefined)
    return window.notula.storage.onStatusChanged(setStatus)
  }, [])

  const recovering = status !== null && status.state !== 'ready' && status.state !== 'starting'

  return (
    <section className="settings-group">
      <h2 className="settings-group__title">Your data</h2>
      <div className="settings-card">
        <div className="settings-row">
          <div className="settings-row__text">
            <div className="settings-row__label">Export notes</div>
            <div className="settings-row__hint">
              {recovering
                ? 'Not available while Notula is recovering your data.'
                : 'Save your notes, summaries and transcripts as files in a folder you choose.'}
            </div>
          </div>
          <div className="settings-row__control">
            <button type="button" className="n-btn n-btn--sm" disabled={recovering || status === null} onClick={() => setOpen('standard')}>
              Export…
            </button>
          </div>
        </div>
        {sources ? (
          <div className="settings-row">
            <div className="settings-row__text">
              <div className="settings-row__label">Export notes as Markdown</div>
              <div className="settings-row__hint">
                {recovering
                  ? 'Not available while Notula is recovering your data.'
                  : 'One Markdown file per note in your folder tree, with video and lesson details for other Markdown apps.'}
              </div>
            </div>
            <div className="settings-row__control">
              <button type="button" className="n-btn n-btn--sm" disabled={recovering || status === null} onClick={() => setOpen('markdown')}>
                Export…
              </button>
            </div>
          </div>
        ) : null}
      </div>
      {open ? <ExportDialog onClose={close} format={open} /> : null}
    </section>
  )
}
