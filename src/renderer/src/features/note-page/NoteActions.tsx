// SPDX-License-Identifier: Apache-2.0
// The note header's "…" menu: Copy enhanced notes, Copy transcript, Stop/Resume
// transcript and Move to trash. With a finished panel the copy items come first (the
// long order); otherwise transcription leads (the short order).

import { useCallback, useRef, useState, type JSX } from 'react'
import { parseError } from '@shared/errors'
import type { Note } from '@shared/types/notes'
import type { Panel } from '@shared/types/panels'
import { IconDownload } from '../../app/icons'
import { navigate } from '../../app/navigation'
import { debugLog, isOwnNote } from '../../app/platform'
import { showToast } from '../../app/toast'
import type { EditorHandle } from '../../editor'
import { startTranscription, stopTranscription, useCaptureState } from '../capture'
import { openFollowUpComposer } from '../follow-up'
import { usePrefs } from '../settings/prefs-store'
import { IconCopy, IconMore, IconPlay, IconStop, IconTrash, trashNotes } from '../trash'
import { RunDispatcherMenuItem } from '../dispatch'
import { ActionMenu, type ActionMenuAnchor, type ActionMenuEntry } from './ActionMenu'
import { copyEnhancedNotes, copyTranscript, hasCopyableTranscript, hasFinishedPanel } from './copy-actions'

interface MenuState {
  anchor: ActionMenuAnchor
  transcript: boolean
  /** The note has saved meeting audio (`recordings:list`). */
  recordings: boolean
}

function panelHasText(panel: Panel | null, editor: EditorHandle | null): boolean {
  if (!panel) return false
  if (editor) return editor.getMarkdown().trim() !== ''
  return (panel.content_markdown ?? panel.generated_content ?? '').trim() !== ''
}

async function resumeTranscript(noteId: string): Promise<void> {
  const result = await startTranscription(noteId)
  if (result.ok) return
  debugLog('note-menu-transcription-not-started', { noteId, reason: result.reason })
  if (result.reason === 'no-asr') {
    showToast({
      id: 'transcription-not-set-up',
      title: 'Transcription isn’t set up yet',
      description: 'Add a transcription provider in Settings to capture this meeting.',
      action: { label: 'Open Settings', onClick: () => navigate('/settings') }
    })
  } else if (result.reason === 'busy') {
    showToast({ id: 'transcription-not-started', kind: 'error', title: 'Another note is being transcribed' })
  } else {
    showToast({ id: 'transcription-not-started', kind: 'error', title: 'Couldn’t start transcription' })
  }
}

function IconMailSmall(): JSX.Element {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3.5" y="5.5" width="17" height="13" rx="2.5" />
      <path d="m4.5 7.5 7.5 5.5 7.5-5.5" />
    </svg>
  )
}

/** The meeting's audio as WAV files, through `recordings:export` (main shows the folder dialog). */
async function exportAudio(noteId: string): Promise<void> {
  try {
    const { paths } = await window.notula.recordings.export({ noteId })
    if (paths.length) showToast({ id: 'audio-exported', kind: 'success', title: paths.length === 1 ? 'Meeting audio saved' : `${paths.length} audio files saved` })
  } catch (err) {
    debugLog('note-menu-export-audio-failed', { err: parseError(err) })
    showToast({ id: 'audio-export-failed', kind: 'error', title: 'Couldn’t export the meeting audio' })
  }
}

export function NoteActions({
  note,
  panels,
  selectedPanel,
  summaryEditor
}: {
  note: Note
  panels: Panel[]
  selectedPanel: Panel | null
  summaryEditor: EditorHandle | null
}): JSX.Element {
  const capture = useCaptureState()
  const prefs = usePrefs()
  const [menu, setMenu] = useState<MenuState | null>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const own = isOwnNote(note)
  const transcribingThis = capture.transcribingNoteId === note.id
  const transcribingOther = capture.transcribingNoteId !== null && !transcribingThis

  const open = async (): Promise<void> => {
    const rect = buttonRef.current?.getBoundingClientRect()
    if (!rect) return
    let transcript = false
    try {
      transcript = hasCopyableTranscript(await window.notula.transcript.get({ noteId: note.id }))
    } catch (err) {
      debugLog('note-menu-transcript-failed', { err: parseError(err) })
    }
    // "Export meeting audio…" only when the note has recordings.
    let recordings = false
    try {
      recordings = (await window.notula.recordings.list({ noteId: note.id })).length > 0
    } catch {
      recordings = false
    }
    setMenu({ anchor: { rect, align: 'end' }, transcript, recordings })
  }

  const close = useCallback((refocus: boolean): void => {
    setMenu(null)
    if (refocus) buttonRef.current?.focus()
  }, [])

  const finished = hasFinishedPanel(panels)
  const copyNotes: ActionMenuEntry = {
    kind: 'item',
    id: 'copy-notes',
    label: 'Copy enhanced notes',
    icon: <IconCopy size={16} />,
    disabled: !finished || !panelHasText(selectedPanel, summaryEditor),
    onSelect: () => {
      if (selectedPanel) void copyEnhancedNotes(note, selectedPanel)
    }
  }
  const copyTranscriptItem: ActionMenuEntry = {
    kind: 'item',
    id: 'copy-transcript',
    label: 'Copy transcript',
    icon: <IconCopy size={16} />,
    disabled: !menu?.transcript,
    onSelect: () => void copyTranscript(note)
  }
  const transcriptItem: ActionMenuEntry = transcribingThis
    ? {
        kind: 'item',
        id: 'stop',
        label: 'Stop transcript',
        icon: <IconStop size={16} />,
        onSelect: () => stopTranscription('note_stop_button')
      }
    : {
        kind: 'item',
        id: 'resume',
        label: 'Resume transcript',
        icon: <IconPlay size={16} />,
        disabled: !own || transcribingOther || capture.pendingStart,
        onSelect: () => void resumeTranscript(note.id)
      }
  // Danger, after a divider, disabled while this note is transcribing; trash, then home.
  const trash: ActionMenuEntry = {
    kind: 'item',
    id: 'trash',
    label: 'Move to Trash',
    icon: <IconTrash size={16} />,
    danger: true,
    disabled: !own || transcribingThis,
    onSelect: () => {
      void trashNotes([note.id]).then((moved) => {
        if (moved.length) navigate('/')
      })
    }
  }
  // Follow-up drafts and meeting audio (`recordings:list`, `recordings:export`).
  const extras: ActionMenuEntry[] = [
    ...(prefs?.['followUpEmail.enabled'] === true && own
      ? [{ kind: 'item', id: 'follow-up', label: 'Draft follow-up email', icon: <IconMailSmall />, onSelect: () => openFollowUpComposer({ noteId: note.id }) } satisfies ActionMenuEntry]
      : []),
    ...(menu?.recordings
      ? [{ kind: 'item', id: 'export-audio', label: 'Export meeting audio…', icon: <IconDownload size={16} />, onSelect: () => void exportAudio(note.id) } satisfies ActionMenuEntry]
      : [])
  ]
  const entries: ActionMenuEntry[] = finished
    ? [copyNotes, copyTranscriptItem, transcriptItem, ...extras, { kind: 'divider', id: 'd' }, trash]
    : [transcriptItem, copyTranscriptItem, ...extras, { kind: 'divider', id: 'd' }, trash]

  return (
    <>
      <span className="n-tooltip n-tooltip--end" data-tooltip="More actions">
        <button
          ref={buttonRef}
          type="button"
          className="n-icon-btn"
          aria-label="More actions"
          aria-haspopup="menu"
          aria-expanded={menu !== null}
          onClick={() => (menu ? close(false) : void open())}
        >
          <IconMore size={18} />
        </button>
      </span>
      {menu ? (
        <ActionMenu
          label="Note actions"
          anchor={menu.anchor}
          entries={entries}
          owner={buttonRef.current}
          onClose={close}
          extra={<RunDispatcherMenuItem noteId={note.id} />}
        />
      ) : null}
    </>
  )
}
