// SPDX-License-Identifier: Apache-2.0
// The folder suggestion bar under the note header: main answers `folders:suggest`
// (recurring match → AI → new folder; only for the
// owner's note while it is in no folder and has a summary). After a 500 ms settle the bar
// shows; Add, Create and dismiss. Dismissing a series records it in
// `folders.ignoredSeries`; an AI answer without a series is dismissed for the session.

import { useEffect, useRef, useState, type JSX } from 'react'
import { parseError } from '@shared/errors'
import { FOLDER_LIMITS, type FolderSuggestion } from '@shared/types/folders'
import { IconClose } from '../../app/icons'
import { debugLog, isOwnNote } from '../../app/platform'
import { showToast } from '../../app/toast'
import { getPrefs, setPrefs } from '../settings/prefs-store'
import { addNotesToFolder } from './actions'
import { openCreateFolder } from './dialogs'
import { FolderGlyph, IconFolderPlus, IconSparkles } from './icons'
import { refreshFolders, useFolders } from './store'
import { folderTitle } from './tree'

const MAX_IGNORED = 2_000
/** AI answers dismissed this session (they live in main memory only). */
const dismissedNotes = new Set<string>()

export function SuggestionBar({ noteId }: { noteId: string }): JSX.Element | null {
  const view = useFolders()
  const [suggestion, setSuggestion] = useState<FolderSuggestion | null>(null)
  const [summary, setSummary] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [hidden, setHidden] = useState(() => dismissedNotes.has(noteId))
  const seq = useRef(0)

  useEffect(() => {
    let settle: ReturnType<typeof setTimeout> | null = null
    let debounce: ReturnType<typeof setTimeout> | null = null
    const evaluate = (): void => {
      const id = ++seq.current
      void Promise.all([window.notula.folders.suggest({ noteId }), window.notula.notes.get({ id: noteId })])
        .then(([next, note]) => {
          if (id !== seq.current) return
          if (!next || !note || !isOwnNote(note) || note.deleted_at) {
            setSuggestion(null)
            return
          }
          const event = note.linked_event
          setSummary(typeof event?.summary === 'string' && event.summary.trim() ? event.summary.trim() : null)
          // Shown after a 500 ms settle.
          if (settle) clearTimeout(settle)
          settle = setTimeout(() => {
            if (id === seq.current) setSuggestion(next)
          }, FOLDER_LIMITS.suggestionSettleMs)
        })
        .catch((err: unknown) => debugLog('folders:suggest-failed', { err: parseError(err) }))
    }
    const later = (): void => {
      if (debounce) clearTimeout(debounce)
      debounce = setTimeout(evaluate, 300)
    }
    evaluate()
    const offFolders = window.notula.folders.onChanged(later)
    const offNotes = window.notula.notes.onChanged((c) => {
      if (c.ids.includes(noteId) && (c.tables.includes('note_panels') || c.tables.includes('documents'))) later()
    })
    return () => {
      seq.current++
      offFolders()
      offNotes()
      if (settle) clearTimeout(settle)
      if (debounce) clearTimeout(debounce)
    }
  }, [noteId])

  if (!suggestion || hidden || !view) return null
  const folder = suggestion.type === 'create_folder' ? undefined : view.byId.get(suggestion.folderId)
  if (suggestion.type !== 'create_folder' && !folder) return null

  const dismiss = (): void => {
    setHidden(true)
    debugLog('folder_suggestion_dismissed', { noteId, type: suggestion.type })
    if (suggestion.type === 'ai_match') {
      dismissedNotes.add(noteId)
      return
    }
    const ignored = getPrefs()?.['folders.ignoredSeries'] ?? []
    if (!ignored.includes(suggestion.recurringEventId)) {
      setPrefs({ 'folders.ignoredSeries': [...ignored, suggestion.recurringEventId].slice(-MAX_IGNORED) })
    }
  }

  const accept = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    debugLog('folder-suggestion-taken', { noteId, type: suggestion.type })
    try {
      if (suggestion.type === 'create_folder') {
        const series = suggestion.recurringEventId
        setBusy(false)
        openCreateFolder({
          parentId: null,
          forSeries: { title: suggestion.title },
          onCreated: async (created) => {
            await addNotesToFolder(created.id, [noteId], 'suggestion', { toast: false })
            await window.notula.folders.setRule({ folderId: created.id, recurringEventId: series, target: { type: 'all', excluded_event_ids: [] } })
            refreshFolders()
            showToast({
              kind: 'success',
              title: `Auto-add ${summary ?? 'this meeting'} to ${folderTitle(created)}`,
              durationMs: 3_000
            })
          }
        })
        return
      }
      const target = folder!
      const added = await addNotesToFolder(target.id, [noteId], 'suggestion', { toast: false })
      if (suggestion.type === 'recurring_event') {
        // A recurring match also files the rest of the series.
        await window.notula.folders.setRule({
          folderId: target.id,
          recurringEventId: suggestion.recurringEventId,
          target: { type: 'all', excluded_event_ids: [] }
        })
        refreshFolders()
        if (added) showToast({ kind: 'success', title: `Auto-add ${summary ?? 'this meeting'} to ${folderTitle(target)}`, durationMs: 3_000 })
      } else if (added) {
        showToast({ kind: 'success', title: `Added to ${folderTitle(target)}`, durationMs: 3_000 })
      }
    } catch (err) {
      showToast({ kind: 'error', title: 'Couldn’t add the note to the folder', description: parseError(err).message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="folder-suggestion" role="region" aria-label="Folder suggestion">
      {suggestion.type === 'create_folder' ? (
        <>
          <span className="folder-suggestion__icon" aria-hidden="true">
            <IconFolderPlus size={15} />
          </span>
          <span className="folder-suggestion__text">Create folder for this meeting</span>
          <span className="folder-suggestion__chip">
            <FolderGlyph icon={null} size={14} />
            {suggestion.title}
          </span>
          <button type="button" className="n-btn n-btn--sm folder-suggestion__accept" disabled={busy} onClick={() => void accept()}>
            Create
          </button>
        </>
      ) : (
        <>
          <span className="folder-suggestion__icon" aria-hidden="true">
            {suggestion.type === 'ai_match' ? <IconSparkles size={15} /> : <IconFolderPlus size={15} />}
          </span>
          <span className="folder-suggestion__text">
            {suggestion.type === 'ai_match' ? 'Suggested folder' : 'Add this meeting to'}
          </span>
          <span className="folder-suggestion__chip">
            <FolderGlyph icon={folder?.icon} size={14} />
            {folderTitle(folder)}
          </span>
          <button type="button" className="n-btn n-btn--sm folder-suggestion__accept" disabled={busy} onClick={() => void accept()}>
            Add
          </button>
        </>
      )}
      <span className="n-tooltip n-tooltip--end" data-tooltip="Dismiss">
        <button type="button" className="n-icon-btn n-icon-btn--sm" aria-label="Dismiss" onClick={dismiss}>
          <IconClose size={14} />
        </button>
      </span>
    </div>
  )
}
