// SPDX-License-Identifier: Apache-2.0
// The recording drop target. Mounted once
// by App. The whole main window accepts a drag that carries audio: an overlay, then a confirm
// dialog with per-file validation, then a progress panel that stays until dismissed. Files reach
// main as paths (`files.pathForFile`), never as bytes.

import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import { IMPORT_LIMITS, type ImportJob, type ImportPhase } from '@shared/types/recordings'
import { navigate } from '../../app/navigation'
import { showToast } from '../../app/toast'
import './imports.css'

const ACTIVE: readonly ImportPhase[] = ['queued', 'creating', 'reading', 'transcribing', 'summarizing']
const PHASE_LABEL: Record<ImportPhase, string> = {
  queued: 'Waiting',
  creating: 'Starting',
  reading: 'Reading',
  transcribing: 'Transcribing',
  summarizing: 'Generating notes',
  complete: 'Ready',
  failed: 'Failed'
}

interface Pending {
  file: File
  error: string | null
}

function extensionOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i >= 0 ? name.slice(i).toLowerCase() : ''
}

function isAudioName(name: string): boolean {
  return (IMPORT_LIMITS.extensions as readonly string[]).includes(extensionOf(name))
}

/** Per-file validation, with its error copy. */
function validate(file: File): string | null {
  if (!isAudioName(file.name)) return 'Only MP3, M4A, AAC or WAV files are supported.'
  if (file.size === 0) return 'The file is empty.'
  if (file.size > IMPORT_LIMITS.maxBytes) return `File is over ${IMPORT_LIMITS.maxBytes / 1_048_576} MB. Trim or split it.`
  return null
}

function carriesAudio(dt: DataTransfer | null): boolean {
  if (!dt || !dt.types.includes('Files')) return false
  return [...dt.items].some((i) => i.kind === 'file' && (IMPORT_LIMITS.dragMimeTypes as readonly string[]).includes(i.type))
}

function formatSize(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1000))} KB`
}

export function RecordingDropTarget(): JSX.Element | null {
  const [over, setOver] = useState(false)
  const [pending, setPending] = useState<Pending[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [jobs, setJobs] = useState<ImportJob[]>([])
  const depth = useRef(0)

  const upsert = useCallback((job: ImportJob) => {
    setJobs((prev) => {
      const i = prev.findIndex((j) => j.id === job.id)
      if (i < 0) return [...prev, job]
      const next = [...prev]
      next[i] = job
      return next
    })
  }, [])

  useEffect(() => {
    const off = window.notula.imports.onChanged((job) => upsert(job))
    // Jobs still running from before (a restart re-queues them) show in the panel.
    void window.notula.imports
      .list()
      .then((all) => {
        for (const j of all) if (ACTIVE.includes(j.phase)) upsert(j)
      })
      .catch(() => undefined)
    return off
  }, [upsert])

  const onDrop = useCallback(async (files: File[]) => {
    const audio = files.filter((f) => isAudioName(f.name))
    if (audio.length < files.length) {
      showToast({ id: 'imports-types', kind: 'info', title: 'Only MP3, M4A, AAC, and WAV files will be transcribed' })
    }
    if (!audio.length) return
    let inProgress = 0
    try {
      inProgress = (await window.notula.imports.list()).filter((j) => ACTIVE.includes(j.phase)).length
    } catch {
      inProgress = 0
    }
    const room = IMPORT_LIMITS.maxInProgress - inProgress
    if (room <= 0) {
      showToast({ id: 'imports-limit', kind: 'info', title: 'Too many imports at once. Wait for some to finish.' })
      return
    }
    setPending(audio.slice(0, room).map((file) => ({ file, error: validate(file) })))
  }, [])

  useEffect(() => {
    const enter = (e: DragEvent): void => {
      if (!carriesAudio(e.dataTransfer)) return
      depth.current++
      setOver(true)
    }
    const overHandler = (e: DragEvent): void => {
      if (!carriesAudio(e.dataTransfer)) return
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    }
    const leave = (e: DragEvent): void => {
      if (!carriesAudio(e.dataTransfer)) return
      depth.current = Math.max(0, depth.current - 1)
      if (depth.current === 0) setOver(false)
    }
    const drop = (e: DragEvent): void => {
      const files = [...(e.dataTransfer?.files ?? [])]
      const audioDrag = carriesAudio(e.dataTransfer) || (files.length > 0 && files.every((f) => isAudioName(f.name)))
      depth.current = 0
      setOver(false)
      if (!audioDrag) return
      e.preventDefault()
      e.stopPropagation()
      void onDrop(files)
    }
    window.addEventListener('dragenter', enter, true)
    window.addEventListener('dragover', overHandler, true)
    window.addEventListener('dragleave', leave, true)
    window.addEventListener('drop', drop, true)
    return () => {
      window.removeEventListener('dragenter', enter, true)
      window.removeEventListener('dragover', overHandler, true)
      window.removeEventListener('dragleave', leave, true)
      window.removeEventListener('drop', drop, true)
    }
  }, [onDrop])

  const transcribe = async (): Promise<void> => {
    if (!pending || pending.some((p) => p.error)) return
    setBusy(true)
    try {
      const paths = pending.map((p) => window.notula.files.pathForFile(p.file)).filter(Boolean)
      const started = await window.notula.imports.start({ paths })
      for (const j of started) upsert(j)
      setPending(null)
    } catch (err) {
      showToast({ id: 'imports-start', kind: 'error', title: 'Couldn’t process the audio. Check that the file plays, then import it again.', description: err instanceof Error ? err.message : undefined })
    } finally {
      setBusy(false)
    }
  }

  const dismissAll = (): void => {
    for (const j of jobs) {
      if (!ACTIVE.includes(j.phase)) void window.notula.imports.dismiss({ jobId: j.id }).catch(() => undefined)
    }
    setJobs((prev) => prev.filter((j) => ACTIVE.includes(j.phase)))
  }

  const working = jobs.some((j) => ACTIVE.includes(j.phase))
  const many = jobs.length > 1

  return (
    <>
      {over && (
        <div className="nt-imp-overlay" aria-live="polite">
          <div className="nt-imp-overlay__card">
            <div className="nt-imp-overlay__title">Drop recordings to transcribe</div>
            <div className="nt-imp-overlay__sub">Notula turns each one into a note with a transcript</div>
          </div>
        </div>
      )}
      {pending && (
        <div className="nt-imp-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && setPending(null)}>
          <div className="nt-imp-dialog" role="dialog" aria-modal="true" aria-labelledby="nt-imp-title">
            <h2 id="nt-imp-title" className="nt-imp-dialog__title">
              {pending.length > 1 ? 'Transcribe recordings?' : 'Transcribe recording?'}
            </h2>
            <p className="nt-imp-dialog__sub">Notula creates a note for each file and transcribes it.</p>
            <ul className="nt-imp-files">
              {pending.map((p, i) => (
                <li key={`${p.file.name}-${i}`} className="nt-imp-file">
                  <span className="nt-imp-file__name">{p.file.name}</span>
                  <span className="nt-imp-file__size">{formatSize(p.file.size)}</span>
                  {p.error && <span className="nt-imp-file__error">{p.error}</span>}
                </li>
              ))}
            </ul>
            <div className="nt-imp-dialog__actions">
              <button type="button" className="n-btn" disabled={busy} onClick={() => setPending(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="n-btn n-btn--primary"
                disabled={busy || pending.some((p) => p.error)}
                onClick={() => void transcribe()}
              >
                Transcribe
              </button>
            </div>
          </div>
        </div>
      )}
      {jobs.length > 0 && (
        <div className="nt-imp-panel" role="status">
          <div className="nt-imp-panel__head">
            <span className="nt-imp-panel__title">
              {working ? (many ? 'Processing recordings' : 'Processing recording') : many ? 'Your notes are ready' : 'Your note is ready'}
            </span>
            <button type="button" className="n-icon-btn n-icon-btn--sm" aria-label="Dismiss" onClick={dismissAll}>
              ×
            </button>
          </div>
          <ul className="nt-imp-rows">
            {jobs.map((j) => (
              <li key={j.id} className={`nt-imp-row nt-imp-row--${j.phase}`}>
                <span className="nt-imp-row__icon" aria-hidden="true" />
                {j.phase === 'complete' && j.note_id ? (
                  <button type="button" className="nt-imp-row__name nt-imp-row__name--link" onClick={() => navigate(`/meeting/${j.note_id}`)}>
                    {j.file_name}
                  </button>
                ) : (
                  <span className="nt-imp-row__name">{j.file_name}</span>
                )}
                <span className="nt-imp-row__phase">{PHASE_LABEL[j.phase]}</span>
                {j.phase === 'failed' && j.error && <span className="nt-imp-row__error">{j.error}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  )
}
