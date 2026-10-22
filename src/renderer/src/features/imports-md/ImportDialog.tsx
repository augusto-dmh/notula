// SPDX-License-Identifier: Apache-2.0
// The Import notes dialog: the scan's progress, the preview (summary line, the
// table grouped by target folder, the options), the run's progress, and the done screen with
// Open folder, Find sources, Undo import, Show skipped files and the catalog prompts. Nothing is
// written until Import; the renderer never sees a path it could send back, only handles.

import { Fragment, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { parseError } from '@shared/errors'
import type { ImportFolderMode, ImportOptions, ImportPreview, ImportPreviewRow, ImportProgress } from '@shared/types/imports-markdown'
import { navigate } from '../../app/navigation'
import { isMac } from '../../app/platform'
import { usePrefs } from '../settings/prefs-store'
import { CatalogButton, FindSourcesPanel } from './FindSources'
import { DATE_ORIGIN, FORMAT_LABEL, phaseLabel, plural, shortDate, STATUS_LABEL, TITLE_ORIGIN } from './labels'

type Step =
  | { kind: 'scanning'; read: number; total: number; cancelling: boolean }
  | { kind: 'failed'; reason: string }
  | { kind: 'preview'; preview: ImportPreview; busy: boolean; error: string | null }
  | { kind: 'running'; preview: ImportPreview; batchId: string; progress: ImportProgress | null; cancelling: boolean }
  | { kind: 'done'; preview: ImportPreview; batchId: string; progress: ImportProgress }

const TERMINAL = new Set(['complete', 'cancelled', 'failed', 'undone'])

const FOLDER_MODES: { mode: ImportFolderMode; label: string }[] = [
  { mode: 'mirror', label: 'Mirror folders (up to two levels)' },
  { mode: 'single', label: 'Put everything in one new folder' },
  { mode: 'none', label: 'Don’t add to folders' }
]

function contentsText(r: ImportPreviewRow): string {
  const parts: string[] = []
  if (r.contents.noteText) parts.push('Note text')
  if (r.contents.summaries) parts.push(r.contents.summaries === 1 ? 'Summary' : plural(r.contents.summaries, 'summary', 'summaries'))
  if (r.contents.transcript) parts.push(`Transcript (${plural(r.contents.transcript.lines, 'line', 'lines')}, ${r.contents.transcript.timed ? 'timed' : 'untimed'})`)
  const links = r.contents.sources + r.contents.references
  if (links) parts.push(`Links: ${r.contents.sources} ${r.contents.sources === 1 ? 'source' : 'sources'}, ${r.contents.references} ${r.contents.references === 1 ? 'reference' : 'references'}`)
  return parts.join(' · ') || 'Empty'
}

function folderLabel(r: ImportPreviewRow): string {
  if (!r.folderPath.length) return 'No folder'
  return `${r.folderPath.join(' ▸ ')} · ${r.folderExists ? 'Existing' : 'New'}`
}

/** The summary line, from the rows as ticked now. */
function summaryLine(preview: ImportPreview, ticked: Set<string>): string {
  const rows = preview.rows.filter((r) => ticked.has(r.itemId))
  const summaries = rows.reduce((n, r) => n + r.contents.summaries, 0)
  const transcripts = rows.filter((r) => r.contents.transcript).length
  const fresh = new Set<string>()
  const reused = new Set<string>()
  for (const r of rows) if (r.folderPath.length) (r.folderExists ? reused : fresh).add(r.folderPath.join('\u0000').toLowerCase())
  const skipped = preview.summary.skipped
  return (
    `${plural(rows.length, 'note', 'notes')} will be created, with ${plural(summaries, 'summary', 'summaries')} and ${plural(transcripts, 'transcript', 'transcripts')}, ` +
    `in ${plural(fresh.size, 'new folder', 'new folders')} (${plural(reused.size, 'existing folder', 'existing folders')} reused). ` +
    `${plural(skipped, 'file', 'files')} skipped, ${preview.summary.alreadyInNotula.toLocaleString('en-US')} already in Notula.`
  )
}

export function ImportDialog({ previewId, onClose, onUndo }: { previewId: string; onClose(): void; onUndo(batchId: string): void }): JSX.Element {
  const [step, setStep] = useState<Step>({ kind: 'scanning', read: 0, total: 0, cancelling: false })
  const [ticked, setTicked] = useState<Set<string>>(new Set())
  const [showSkipped, setShowSkipped] = useState(false)
  const prefs = usePrefs()
  const sourcesOn = !isMac && prefs?.['sources.enabled'] === true
  const dialogRef = useRef<HTMLDivElement>(null)
  const batchRef = useRef<string | null>(null)

  const loadPreview = async (): Promise<void> => {
    try {
      const p = await window.notula.notesImport.getPreview({ previewId })
      if (!p) {
        setStep({ kind: 'failed', reason: 'This preview expired. Choose the folder again.' })
        return
      }
      setTicked(new Set(p.rows.filter((r) => r.ticked).map((r) => r.itemId)))
      setStep({ kind: 'preview', preview: p, busy: false, error: null })
    } catch (err) {
      setStep({ kind: 'failed', reason: parseError(err).message })
    }
  }

  useEffect(() => {
    const offScan = window.notula.notesImport.onScanProgress((p) => {
      if (p.previewId !== previewId) return
      if (p.state === 'scanning') setStep((s) => (s.kind === 'scanning' ? { ...s, read: p.read, total: p.total } : s))
      else if (p.state === 'previewed') void loadPreview()
      else if (p.state === 'failed') setStep({ kind: 'failed', reason: p.reason ?? 'Notula can’t read this folder.' })
      else if (p.state === 'cancelled') onClose()
    })
    const offProgress = window.notula.notesImport.onProgress((p) => {
      if (!batchRef.current || p.batchId !== batchRef.current) return
      setStep((s) => {
        if (s.kind !== 'running') return s
        if (TERMINAL.has(p.state) && p.report) return { kind: 'done', preview: s.preview, batchId: s.batchId, progress: p }
        return { ...s, progress: p }
      })
    })
    // The scan may have finished before this dialog subscribed.
    void window.notula.notesImport
      .getPreview({ previewId })
      .then((p) => {
        if (p) {
          setTicked(new Set(p.rows.filter((r) => r.ticked).map((r) => r.itemId)))
          setStep((s) => (s.kind === 'scanning' ? { kind: 'preview', preview: p, busy: false, error: null } : s))
        }
      })
      .catch(() => undefined)
    return () => {
      offScan()
      offProgress()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewId])

  useEffect(() => {
    dialogRef.current?.querySelector<HTMLElement>('button, input')?.focus()
  }, [step.kind])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || step.kind === 'running' || step.kind === 'scanning') return
      e.preventDefault()
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [step.kind, onClose])

  async function setOptions(patch: Partial<ImportOptions>): Promise<void> {
    if (step.kind !== 'preview') return
    const options = { ...step.preview.options, ...patch }
    setStep({ ...step, busy: true })
    try {
      const p = await window.notula.notesImport.setOptions({ previewId, options })
      setTicked(new Set(p.rows.filter((r) => r.ticked).map((r) => r.itemId)))
      setStep({ kind: 'preview', preview: p, busy: false, error: null })
    } catch (err) {
      setStep({ ...step, busy: false, error: parseError(err).message })
    }
  }

  async function start(): Promise<void> {
    if (step.kind !== 'preview' || !ticked.size) return
    setStep({ ...step, busy: true, error: null })
    try {
      const { batchId } = await window.notula.notesImport.start({ previewId, itemIds: [...ticked], options: step.preview.options })
      batchRef.current = batchId
      setStep({ kind: 'running', preview: step.preview, batchId, progress: null, cancelling: false })
    } catch (err) {
      setStep({ ...step, busy: false, error: parseError(err).message })
    }
  }

  function cancel(): void {
    if (step.kind === 'scanning') {
      setStep({ ...step, cancelling: true })
      void window.notula.notesImport.cancel({ previewId }).catch(() => undefined)
    } else if (step.kind === 'running' && !step.cancelling) {
      setStep({ ...step, cancelling: true })
      void window.notula.notesImport.cancel({ batchId: step.batchId }).catch(() => undefined)
    }
  }

  const backdropClose = step.kind === 'preview' || step.kind === 'failed' || step.kind === 'done'
  return (
    <div className="nix-backdrop" onMouseDown={(e) => e.target === e.currentTarget && backdropClose && onClose()}>
      <div className={`nix-dialog${step.kind === 'preview' ? ' nix-dialog--wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby="nix-title" ref={dialogRef}>
        <h2 className="nix-dialog__title" id="nix-title">
          {step.kind === 'done' ? 'Import finished' : 'Import notes'}
        </h2>

        {step.kind === 'scanning' ? (
          <>
            <div className="nix-dialog__body">
              <div className="nix-progress" role="status">
                <span className="n-spinner" aria-hidden="true" />
                <span>{step.cancelling ? 'Cancelling…' : step.total ? `Reading ${step.read.toLocaleString('en-US')} of ${step.total.toLocaleString('en-US')} files` : 'Looking through the folder…'}</span>
              </div>
              <p className="nix-note">Notula only reads these files. It never changes them.</p>
            </div>
            <div className="nix-dialog__footer">
              <button type="button" className="n-btn" disabled={step.cancelling} onClick={cancel}>
                Cancel
              </button>
            </div>
          </>
        ) : null}

        {step.kind === 'failed' ? (
          <>
            <div className="nix-dialog__body">
              <p className="nix-error" role="alert">
                {step.reason}
              </p>
            </div>
            <div className="nix-dialog__footer">
              <button type="button" className="n-btn" onClick={onClose}>
                Close
              </button>
            </div>
          </>
        ) : null}

        {step.kind === 'preview' ? (
          <PreviewStep
            preview={step.preview}
            ticked={ticked}
            setTicked={setTicked}
            busy={step.busy}
            error={step.error}
            sourcesOn={sourcesOn}
            setOptions={(o) => void setOptions(o)}
            onImport={() => void start()}
            onClose={onClose}
          />
        ) : null}

        {step.kind === 'running' ? (
          <>
            <div className="nix-dialog__body">
              <div className="nix-progress" role="status">
                <span className="n-spinner" aria-hidden="true" />
                <span>
                  {step.cancelling
                    ? 'Cancelling…'
                    : step.progress
                      ? `${phaseLabel(step.progress.state, step.progress.counts.planned)}: ${(step.progress.counts.total - step.progress.counts.planned).toLocaleString('en-US')} of ${step.progress.counts.total.toLocaleString('en-US')}`
                      : 'Waiting'}
                </span>
              </div>
              {step.progress && step.progress.counts.total > 0 ? (
                <div className="nix-bar" aria-hidden="true">
                  <div
                    className="nix-bar__fill"
                    style={{ width: `${Math.round(((step.progress.counts.total - step.progress.counts.planned) / step.progress.counts.total) * 100)}%` }}
                  />
                </div>
              ) : null}
              {step.progress && (step.progress.counts.skipped || step.progress.counts.failed) ? (
                <p className="nix-note">
                  {plural(step.progress.counts.skipped, 'skipped', 'skipped')}, {plural(step.progress.counts.failed, 'failed', 'failed')}
                </p>
              ) : null}
              <p className="nix-note">You can close this window. The import keeps going.</p>
            </div>
            <div className="nix-dialog__footer">
              <button type="button" className="n-btn" disabled={step.cancelling} onClick={cancel}>
                Cancel
              </button>
              <button type="button" className="n-btn" onClick={onClose}>
                Hide
              </button>
            </div>
          </>
        ) : null}

        {step.kind === 'done' ? (
          <DoneStep
            preview={step.preview}
            progress={step.progress}
            batchId={step.batchId}
            ticked={ticked}
            sourcesOn={sourcesOn}
            showSkipped={showSkipped}
            setShowSkipped={setShowSkipped}
            onClose={onClose}
            onUndo={() => onUndo(step.batchId)}
          />
        ) : null}
      </div>
    </div>
  )
}

function PreviewStep(p: {
  preview: ImportPreview
  ticked: Set<string>
  setTicked(next: Set<string>): void
  busy: boolean
  error: string | null
  sourcesOn: boolean
  setOptions(o: Partial<ImportOptions>): void
  onImport(): void
  onClose(): void
}): JSX.Element {
  const { preview, ticked } = p
  const groups = useMemo(() => {
    const out: { label: string; rows: ImportPreviewRow[] }[] = []
    for (const r of preview.rows) {
      const label = folderLabel(r)
      const last = out[out.length - 1]
      if (last && last.label === label) last.rows.push(r)
      else out.push({ label, rows: [r] })
    }
    return out
  }, [preview])
  const hasExportTrash = preview.rows.some((r) => r.format === 'notula-export' && (r.detail === 'In Trash in the export' || r.status === 'new'))
  const study = preview.preset === 'study-vault' || preview.rows.some((r) => r.format === 'study-lesson')
  const set = (ids: string[], on: boolean): void => {
    const next = new Set(ticked)
    for (const id of ids) {
      if (on) next.add(id)
      else next.delete(id)
    }
    p.setTicked(next)
  }

  return (
    <>
      <div className="nix-dialog__body">
        <p className="nix-summary">{summaryLine(preview, ticked)}</p>
        <div className="nix-table" role="table" aria-label="Files to import">
          <div className="nix-row nix-row--head" role="row">
            <span role="columnheader" />
            <span role="columnheader">File</span>
            <span role="columnheader">Title</span>
            <span role="columnheader">Date</span>
            <span role="columnheader">Contents</span>
            <span role="columnheader">Status</span>
          </div>
          {groups.map((g, gi) => {
            const tickable = g.rows.filter((r) => r.tickable).map((r) => r.itemId)
            const allOn = tickable.length > 0 && tickable.every((id) => ticked.has(id))
            return (
              <Fragment key={`${g.label}-${gi}`}>
                <div className="nix-group" role="row">
                  <input
                    type="checkbox"
                    aria-label={`Import everything in ${g.label}`}
                    disabled={!tickable.length}
                    checked={allOn}
                    onChange={(e) => set(tickable, e.target.checked)}
                  />
                  <span>{g.label}</span>
                </div>
                {g.rows.map((r) => (
                  <div className={`nix-row${r.tickable ? '' : ' nix-row--off'}`} role="row" key={r.itemId}>
                    <span role="cell">
                      <input type="checkbox" aria-label={`Import ${r.relPath}`} disabled={!r.tickable} checked={ticked.has(r.itemId)} onChange={(e) => set([r.itemId], e.target.checked)} />
                    </span>
                    <span role="cell" className="nix-cell--path" title={r.relPath}>
                      {r.relPath}
                      <small>{FORMAT_LABEL[r.format]}</small>
                    </span>
                    <span role="cell">
                      {r.status === 'skipped' || r.status === 'unreadable' ? '—' : r.title}
                      {r.status === 'skipped' || r.status === 'unreadable' ? null : <small>{TITLE_ORIGIN[r.titleOrigin]}</small>}
                    </span>
                    <span role="cell">
                      {r.status === 'skipped' || r.status === 'unreadable' ? '—' : shortDate(r.createdAt)}
                      {r.status === 'skipped' || r.status === 'unreadable' ? null : <small>{DATE_ORIGIN[r.dateOrigin]}</small>}
                    </span>
                    <span role="cell">{r.status === 'skipped' || r.status === 'unreadable' ? '—' : contentsText(r)}</span>
                    <span role="cell">
                      <span className={`nix-status nix-status--${r.status}`}>{STATUS_LABEL[r.status]}</span>
                      {r.detail ? <small>{r.status === 'duplicate' ? `Same as ${r.detail}` : r.detail}</small> : null}
                      {r.warnings.map((w) => (
                        <small key={w} className="nix-warning">
                          {w}
                        </small>
                      ))}
                    </span>
                  </div>
                ))}
              </Fragment>
            )
          })}
        </div>

        <fieldset className="nix-options" disabled={p.busy}>
          <legend>Folders</legend>
          {FOLDER_MODES.map((m) => (
            <label key={m.mode} className="nix-radio">
              <input type="radio" name="nix-folders" checked={preview.options.folderMode === m.mode} onChange={() => p.setOptions({ folderMode: m.mode })} />
              {m.label}
            </label>
          ))}
          {hasExportTrash ? (
            <label className="nix-radio">
              <input
                type="checkbox"
                checked={preview.options.trash === 'import-into-trash'}
                onChange={(e) => p.setOptions({ trash: e.target.checked ? 'import-into-trash' : 'skip' })}
              />
              Import notes that were in Trash, into Trash
            </label>
          ) : null}
          {study ? (
            <label className="nix-radio">
              <input type="checkbox" checked={preview.options.includeOtherFiles} onChange={(e) => p.setOptions({ includeOtherFiles: e.target.checked })} />
              Also import other Markdown files as plain notes
            </label>
          ) : null}
          {p.sourcesOn ? (
            <label className="nix-radio">
              <input type="checkbox" checked={preview.options.findSourcesAfter} onChange={(e) => p.setOptions({ findSourcesAfter: e.target.checked })} />
              After import, find sources for these notes
            </label>
          ) : null}
        </fieldset>
        {p.error ? (
          <p className="nix-error" role="alert">
            {p.error}
          </p>
        ) : null}
      </div>
      <div className="nix-dialog__footer">
        <button type="button" className="n-btn" onClick={p.onClose}>
          Cancel
        </button>
        <button type="button" className="n-btn n-btn--primary" disabled={!ticked.size || p.busy} onClick={p.onImport}>
          {ticked.size ? `Import ${plural(ticked.size, 'note', 'notes')}` : 'Import'}
        </button>
      </div>
    </>
  )
}

function DoneStep(p: {
  preview: ImportPreview
  progress: ImportProgress
  batchId: string
  ticked: Set<string>
  sourcesOn: boolean
  showSkipped: boolean
  setShowSkipped(v: boolean): void
  onClose(): void
  onUndo(): void
}): JSX.Element {
  const report = p.progress.report ?? { noteIds: [], needSummary: [], issues: [] }
  const c = p.progress.counts
  const imported = p.preview.rows.filter((r) => p.ticked.has(r.itemId))
  const folderPaths = [...new Set(imported.filter((r) => r.folderPath.length).map((r) => r.folderPath.join('\u0000')))]
  const failed = report.issues.filter((i) => i.state === 'failed')
  const skipped = [
    ...p.preview.rows.filter((r) => !p.ticked.has(r.itemId) && r.status !== 'new').map((r) => ({ relPath: r.relPath, reason: r.detail ?? STATUS_LABEL[r.status] })),
    ...report.issues.filter((i) => i.state === 'skipped').map((i) => ({ relPath: i.relPath, reason: i.reason }))
  ]
  const totalSkipped = c.skipped + p.preview.rows.filter((r) => !p.ticked.has(r.itemId)).length

  async function openFolder(): Promise<void> {
    const first = imported.find((r) => r.folderPath.length)?.folderPath
    if (!first) return
    try {
      const { folders } = await window.notula.folders.list()
      let parent: string | null = null
      let id: string | null = null
      for (const title of first) {
        const f = folders.find((x) => x.parent_id === parent && x.title.trim().toLowerCase() === title.trim().toLowerCase())
        if (!f) break
        id = f.id
        parent = f.id
      }
      if (id) {
        p.onClose()
        navigate(`/list/${encodeURIComponent(id)}`)
      }
    } catch {
      // The folder list is a convenience here.
    }
  }

  return (
    <>
      <div className="nix-dialog__body">
        <p className="nix-summary">
          {p.progress.state === 'cancelled' ? 'Import cancelled. ' : p.progress.state === 'failed' ? 'Import stopped. ' : ''}
          {plural(c.done, 'note', 'notes')} imported into {plural(folderPaths.length, 'folder', 'folders')}. {totalSkipped.toLocaleString('en-US')} skipped,{' '}
          {c.failed.toLocaleString('en-US')} failed.
        </p>
        {failed.length ? (
          <ul className="nix-list">
            {failed.map((f) => (
              <li key={f.relPath}>
                <span>{f.relPath}</span>
                <small>{f.reason}</small>
              </li>
            ))}
          </ul>
        ) : null}
        {report.needSummary.length ? (
          <p className="nix-note">
            {plural(report.needSummary.length, 'note has', 'notes have')} a transcript and no summary. Open a note and generate notes when you want a summary.
          </p>
        ) : null}
        {p.sourcesOn && p.preview.options.findSourcesAfter && report.noteIds.length ? (
          <div className="nix-section">
            <h3 className="nix-section__title">Find sources</h3>
            <FindSourcesPanel noteIds={report.noteIds} />
          </div>
        ) : !p.sourcesOn && report.noteIds.length ? (
          <p className="nix-note">Turn on Sources in Settings ▸ Labs to link these notes to the videos and lessons they came from.</p>
        ) : null}
        {p.sourcesOn && p.preview.catalogs?.length ? (
          <div className="nix-section">
            {p.preview.catalogs.map((cat) => (
              <CatalogButton key={cat.relPath} course={cat.course} handle={cat.handle} />
            ))}
          </div>
        ) : null}
        {p.showSkipped ? (
          <ul className="nix-list">
            {skipped.length ? (
              skipped.map((s, i) => (
                <li key={`${s.relPath}-${i}`}>
                  <span>{s.relPath}</span>
                  <small>{s.reason}</small>
                </li>
              ))
            ) : (
              <li>No files were skipped.</li>
            )}
          </ul>
        ) : null}
      </div>
      <div className="nix-dialog__footer nix-dialog__footer--spread">
        <button type="button" className="n-btn n-btn--sm" onClick={() => p.setShowSkipped(!p.showSkipped)}>
          {p.showSkipped ? 'Hide skipped files' : 'Show skipped files'}
        </button>
        <span className="nix-spacer" />
        {c.done > 0 ? (
          <button type="button" className="n-btn" onClick={p.onUndo}>
            Undo import…
          </button>
        ) : null}
        {folderPaths.length ? (
          <button type="button" className="n-btn" onClick={() => void openFolder()}>
            Open folder in Notula
          </button>
        ) : null}
        <button type="button" className="n-btn n-btn--primary" onClick={p.onClose}>
          Done
        </button>
      </div>
    </>
  )
}
