// SPDX-License-Identifier: Apache-2.0
// Settings ▸ Preferences ▸ Your data ▸ Import notes: Choose folder… and
// Choose files… (main's pickers), the preset menu, the running import's progress with Cancel,
// and Import history with Undo import and Clear history. A scan started anywhere (the File menu
// too) opens the preview dialog here. Not behind Labs.

import { useCallback, useEffect, useState, type JSX } from 'react'
import { parseError } from '@shared/errors'
import type { ImportBatch, ImportPreset, ImportProgress } from '@shared/types/imports-markdown'
import type { StorageStatus } from '@shared/types/storage'
import { debugLog } from '../../app/platform'
import { ImportDialog } from './ImportDialog'
import { folderName, phaseLabel, plural, PRESET_LABEL, shortDate } from './labels'
import { UndoDialog } from './UndoDialog'
import './imports-md.css'

const PRESETS: ImportPreset[] = ['auto', 'plain', 'obsidian', 'notula-export', 'study-vault']
const ACTIVE = new Set(['queued', 'running'])

export function NotesImportCardView(): JSX.Element | null {
  const [status, setStatus] = useState<StorageStatus | null>(null)
  const [preset, setPreset] = useState<ImportPreset>('auto')
  const [previewId, setPreviewId] = useState<string | null>(null)
  const [undoBatch, setUndoBatch] = useState<string | null>(null)
  const [batches, setBatches] = useState<ImportBatch[]>([])
  const [progress, setProgress] = useState<Record<string, ImportProgress>>({})
  const [error, setError] = useState<string | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)

  const reload = useCallback(() => {
    void window.notula.notesImport
      .listBatches()
      .then(setBatches)
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    void window.notula.storage.getStatus().then(setStatus).catch(() => undefined)
    const offStatus = window.notula.storage.onStatusChanged(setStatus)
    reload()
    const offChanged = window.notula.notesImport.onChanged((b) => {
      setBatches((list) => {
        const i = list.findIndex((x) => x.id === b.id)
        if (i < 0) return [b, ...list]
        const next = [...list]
        next[i] = b
        return next
      })
    })
    const offProgress = window.notula.notesImport.onProgress((p) => setProgress((m) => ({ ...m, [p.batchId]: p })))
    // A scan started from the File menu opens the preview here.
    const offScan = window.notula.notesImport.onScanProgress((p) => {
      if (p.state === 'scanning') setPreviewId((cur) => cur ?? p.previewId)
    })
    return () => {
      offStatus()
      offChanged()
      offProgress()
      offScan()
    }
  }, [reload])

  const recovering = status !== null && status.state !== 'ready' && status.state !== 'starting'
  const disabled = recovering || status === null

  async function choose(kind: 'folder' | 'files'): Promise<void> {
    setError(null)
    try {
      const picked = kind === 'folder' ? await window.notula.notesImport.chooseFolder() : await window.notula.notesImport.chooseFiles()
      if ('cancelled' in picked) return
      const { previewId: id } = await window.notula.notesImport.scan({ handle: picked.handle, preset })
      setPreviewId(id)
    } catch (err) {
      setError(parseError(err).message)
      debugLog('notes-import:choose-failed', { code: parseError(err).code })
    }
  }

  async function clearHistory(): Promise<void> {
    setConfirmClear(false)
    try {
      await window.notula.notesImport.clearHistory({ confirmed: true })
      reload()
    } catch (err) {
      setError(parseError(err).message)
    }
  }

  const closeDialog = useCallback(() => {
    setPreviewId(null)
    reload()
  }, [reload])
  const closeUndo = useCallback(() => {
    setUndoBatch(null)
    reload()
  }, [reload])

  const active = batches.find((b) => ACTIVE.has(b.state))
  const history = batches.filter((b) => !ACTIVE.has(b.state))

  return (
    <section className="settings-group">
      <div className="settings-card">
        <div className="settings-row">
          <div className="settings-row__text">
            <div className="settings-row__label">Import notes</div>
            <div className="settings-row__hint">
              {recovering
                ? 'Not available while Notula is recovering your data.'
                : 'Bring in Markdown files, Obsidian vaults and Notula exports. Notula reads them and never changes them.'}
            </div>
          </div>
          <div className="settings-row__control nix-controls">
            <select className="settings-select" aria-label="Format" value={preset} disabled={disabled} onChange={(e) => setPreset(e.target.value as ImportPreset)}>
              {PRESETS.map((p) => (
                <option key={p} value={p}>
                  {PRESET_LABEL[p]}
                </option>
              ))}
            </select>
            <button type="button" className="n-btn n-btn--sm" disabled={disabled || !!active} onClick={() => void choose('folder')}>
              Choose folder…
            </button>
            <button type="button" className="n-btn n-btn--sm" disabled={disabled || !!active} onClick={() => void choose('files')}>
              Choose files…
            </button>
          </div>
        </div>
        {error ? (
          <p className="nix-error nix-error--row" role="alert">
            {error}
          </p>
        ) : null}
        {active ? (
          <div className="settings-row">
            <div className="settings-row__text">
              <div className="settings-row__label">
                {phaseLabel(active.state, progress[active.id]?.counts.planned ?? active.counts.planned)}: {folderName(active.root_path)}
              </div>
              <div className="settings-row__hint">
                {(active.counts.done + active.counts.skipped + active.counts.failed).toLocaleString('en-US')} of{' '}
                {(active.counts.planned + active.counts.done + active.counts.skipped + active.counts.failed).toLocaleString('en-US')}
              </div>
            </div>
            <div className="settings-row__control">
              <button type="button" className="n-btn n-btn--sm" onClick={() => void window.notula.notesImport.cancel({ batchId: active.id }).catch(() => undefined)}>
                Cancel
              </button>
            </div>
          </div>
        ) : null}
        {history.length ? (
          <div className="settings-row settings-row--stacked">
            <div className="settings-row__text">
              <div className="settings-row__label">Import history</div>
            </div>
            <ul className="nix-history">
              {history.map((b) => (
                <li key={b.id}>
                  <span className="nix-history__text">
                    <span>
                      {folderName(b.root_path)} · {shortDate(b.created_at)}
                    </span>
                    <small>
                      {phaseLabel(b.state, b.counts.planned)} · {plural(b.counts.done, 'note', 'notes')}
                      {b.counts.skipped ? `, ${b.counts.skipped.toLocaleString('en-US')} skipped` : ''}
                      {b.counts.failed ? `, ${b.counts.failed.toLocaleString('en-US')} failed` : ''}
                    </small>
                  </span>
                  {b.state !== 'undone' && b.counts.done > 0 ? (
                    <button type="button" className="n-btn n-btn--sm" onClick={() => setUndoBatch(b.id)}>
                      Undo import…
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
            <div className="nix-history__footer">
              {confirmClear ? (
                <>
                  <span className="nix-note">Clear the history? Your notes stay, but re-importing can’t tell what was imported before.</span>
                  <button type="button" className="n-btn n-btn--sm" onClick={() => setConfirmClear(false)}>
                    Cancel
                  </button>
                  <button type="button" className="n-btn n-btn--sm n-btn--danger" onClick={() => void clearHistory()}>
                    Clear history
                  </button>
                </>
              ) : (
                <button type="button" className="n-btn n-btn--sm" onClick={() => setConfirmClear(true)}>
                  Clear history
                </button>
              )}
            </div>
          </div>
        ) : null}
      </div>
      {previewId ? (
        <ImportDialog
          previewId={previewId}
          onClose={closeDialog}
          onUndo={(id) => {
            setPreviewId(null)
            setUndoBatch(id)
          }}
        />
      ) : null}
      {undoBatch ? <UndoDialog batchId={undoBatch} onClose={closeUndo} /> : null}
    </section>
  )
}
