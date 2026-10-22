// SPDX-License-Identifier: Apache-2.0
// The commands H registers in the palette (RH3): navigation, the
// Settings sections, the note-page actions ("Add to folder…", "Remove from folder…",
// copy, stop/resume, "Move to trash" with the double-Enter confirmation), the home
// selection's trash, "Create folder" and the AI folder-suggestion switch.
//
// A provider is read each time the palette opens, so it reads the current route, note,
// capture state and folders here, synchronously, from what the palette host tracks.

import { useEffect } from 'react'
import { parseError } from '@shared/errors'
import type { Note } from '@shared/types/notes'
import { registerCommands, type Command } from '../../app/commands'
import { currentRoute, navigate, navigateToSettings, useRoute } from '../../app/navigation'
import { isOwnNote } from '../../app/platform'
import { showToast } from '../../app/toast'
import { startTranscription, stopTranscription, useCaptureState, type CaptureState } from '../capture'
import {
  addNotesToFolder,
  FolderGlyph,
  folderTitle,
  getFolders,
  openCreateFolder,
  rankForAdding,
  removeNoteFromFolder
} from '../folders'
import { getSelectedNoteIds, trashNotes as trashSelection } from '../home'
import { copyEnhancedNotes, copyTranscript } from '../note-page'
import { getPrefs, setPrefs } from '../settings/prefs-store'
import { settingsSections } from '../settings/sections'
import { trashNotes } from '../trash'

const SOURCE = 'organize'

const SECTION_KEYWORDS: Record<string, string[]> = {
  preferences: ['appearance', 'theme', 'language', 'startup'],
  ai: ['model', 'keys', 'transcription', 'provider', 'llm'],
  profile: ['name', 'email', 'account'],
  calendar: ['calendar', 'events', 'feeds'],
  notifications: ['alerts', 'reminders'],
  dev: ['developer', 'debug', 'logs']
}

/** What the providers read; the palette host keeps it current. */
const context: { note: Note | null; capture: CaptureState | null } = { note: null, capture: null }

/** The note on screen (`/meeting/:id`), trashed or not, refreshed on its changes. */
function useTrackedNote(): void {
  const { path, params } = useRoute()
  const noteId = path.startsWith('/meeting/') ? (params['id'] ?? null) : null
  useEffect(() => {
    context.note = null
    if (!noteId) return
    let live = true
    const load = (): void => {
      window.notula.notes
        .get({ id: noteId, includeDeleted: true })
        .then((n) => {
          if (live) context.note = n
        })
        .catch(() => undefined)
    }
    load()
    const off = window.notula.notes.onChanged((c) => {
      if (c.ids.includes(noteId) && c.tables.includes('documents')) load()
    })
    return () => {
      live = false
      off()
    }
  }, [noteId])
}

/** Mounted once by the palette host: tracks the context and registers the provider. */
export function useOrganizeCommands(): void {
  useTrackedNote()
  const capture = useCaptureState()
  context.capture = capture
  useEffect(() => registerCommands(SOURCE, organizeCommands), [])
}

function go(to: string): () => void {
  return () => navigate(to)
}

function organizeCommands(): Command[] {
  const commands: Command[] = []
  const prefs = getPrefs()

  // ---------- general ----------
  commands.push({
    id: 'folders.create',
    label: 'Create folder',
    group: 'general',
    keywords: ['folder', 'new folder', 'list', 'organize'],
    run: () => openCreateFolder({ parentId: null })
  })

  // ---------- note context ----------
  const route = currentRoute()
  const note = context.note
  const noteId = route.path.startsWith('/meeting/') ? route.params['id'] : undefined
  if (noteId && note && note.id === noteId) commands.push(...noteCommands(note))

  // ---------- selection ----------
  const selected = route.path === '/' ? getSelectedNoteIds() : []
  if (selected.length > 0) {
    commands.push({
      id: 'selection.trash',
      label: selected.length > 1 ? `Move ${selected.length} notes to Trash` : 'Move to Trash',
      group: 'selected-notes',
      keywords: ['delete', 'remove', 'trash'],
      confirm: { hint: 'Press Enter again to confirm' },
      run: () => trashSelection(selected)
    })
  }

  // ---------- navigation ----------
  commands.push(
    { id: 'nav.home', label: 'Home', group: 'navigation', keywords: ['notes', 'meetings', 'go home'], run: go('/') },
    { id: 'nav.chat', label: 'Go to chat', group: 'navigation', keywords: ['chat', 'ask', 'ai'], run: go('/chat') },
    { id: 'nav.recipes', label: 'Recipes', group: 'navigation', keywords: ['recipe', 'prompts'], run: go('/recipes') },
    { id: 'nav.search', label: 'Search', group: 'navigation', keywords: ['find', 'results'], run: go('/search') },
    { id: 'nav.my-notes', label: 'My notes', group: 'navigation', keywords: ['folders', 'spaces', 'lists'], run: go('/list/my-notes') }
  )

  // ---------- settings: the shipped sections (Developer tools only in dev builds) ----------
  for (const s of settingsSections(import.meta.env.DEV ? false : null)) {
    commands.push({
      id: `settings.${s.id}`,
      label: s.label,
      group: 'settings',
      keywords: ['settings', ...(SECTION_KEYWORDS[s.id] ?? [])],
      run: () => navigateToSettings(s.id)
    })
  }
  const aiOn = prefs?.['folders.aiSuggestions'] ?? false
  commands.push({
    id: 'settings.folder-suggestions',
    label: aiOn ? 'Turn off AI folder suggestions' : 'Suggest folders with AI',
    group: 'settings',
    keywords: ['folder', 'ai', 'suggest', 'organize', 'settings'],
    enabled: prefs !== null,
    run: () => {
      setPrefs({ 'folders.aiSuggestions': !aiOn })
      showToast({
        kind: 'success',
        title: aiOn ? 'AI folder suggestions are off' : 'AI folder suggestions are on',
        ...(aiOn ? {} : { description: 'After a summary, Notula asks your AI provider which of your folders fits.' }),
        durationMs: 4_000
      })
    }
  })
  return commands
}

function noteCommands(note: Note): Command[] {
  const trashed = note.deleted_at !== null
  const capture = context.capture
  const transcribing = capture?.transcribingNoteId === note.id
  const view = getFolders()
  const uses = getPrefs()?.['folders.useTimestamps'] ?? {}
  const inFolders = view ? (view.foldersOfNote.get(note.id) ?? []) : []
  const out: Command[] = []

  out.push({
    id: 'note.folder-add',
    label: 'Add to folder',
    group: 'actions',
    contextual: true,
    keywords: ['folder', 'list', 'organize', 'move'],
    enabled: !trashed && view !== null,
    subList: {
      placeholder: 'Add to folder…',
      items: () => {
        const v = getFolders()
        if (!v) return []
        const candidates = v.folders.filter((f) => !inFolders.includes(f.id))
        return rankForAdding(v, uses, candidates).map((f) => ({
          id: f.id,
          label: folderTitle(f),
          icon: <FolderGlyph icon={f.icon} size={15} />,
          run: () => void addNotesToFolder(f.id, [note.id], 'palette')
        }))
      }
    }
  })
  if (inFolders.length > 0) {
    out.push({
      id: 'note.folder-remove',
      label: 'Remove from folder',
      group: 'actions',
      contextual: true,
      keywords: ['folder', 'list', 'remove'],
      enabled: !trashed,
      subList: {
        placeholder: 'Remove from folder…',
        items: () => {
          const v = getFolders()
          if (!v) return []
          return inFolders
            .map((id) => v.byId.get(id))
            .filter((f) => f !== undefined)
            .sort((a, b) => folderTitle(a).localeCompare(folderTitle(b), undefined, { sensitivity: 'base' }))
            .map((f) => ({
              id: f.id,
              label: folderTitle(f),
              icon: <FolderGlyph icon={f.icon} size={15} />,
              run: () =>
                void removeNoteFromFolder(f.id, note.id).then((ok) => {
                  if (ok) showToast({ kind: 'success', title: `Removed from ${folderTitle(f)}`, durationMs: 3_000 })
                })
            }))
        }
      }
    })
  }
  out.push(
    {
      id: 'note.copy-enhanced',
      label: 'Copy enhanced notes',
      group: 'actions',
      contextual: true,
      keywords: ['copy', 'summary', 'clipboard', 'enhanced'],
      enabled: !trashed,
      run: () => copyEnhancedNotes(note.id, null)
    },
    {
      id: 'note.transcript-copy',
      label: 'Copy transcript',
      group: 'actions',
      contextual: true,
      keywords: ['copy', 'transcript', 'clipboard'],
      enabled: !trashed,
      run: () => copyTranscript(note.id)
    }
  )
  out.push(
    transcribing
      ? {
          id: 'note.stop-transcript',
          label: 'Stop transcript',
          group: 'actions',
          contextual: true,
          keywords: ['stop', 'pause', 'transcribe', 'record'],
          run: () => stopTranscription('note_stop_button')
        }
      : {
          id: 'note.resume-transcript',
          label: 'Resume transcript',
          group: 'actions',
          contextual: true,
          keywords: ['start', 'resume', 'transcribe', 'record'],
          enabled: !trashed && !capture?.transcribingNoteId && !capture?.pendingStart,
          run: async () => {
            const res = await startTranscription(note.id)
            if (res.ok) return
            showToast({
              kind: 'error',
              title: 'Couldn’t resume the transcript',
              description:
                res.reason === 'busy'
                  ? 'Another note is being transcribed.'
                  : res.reason === 'no-asr'
                    ? 'Set up transcription in Settings ▸ AI.'
                    : 'This note no longer exists.'
            })
          }
        }
  )
  out.push({
    id: 'note.trash',
    label: 'Move to Trash',
    group: 'actions',
    contextual: true,
    keywords: ['delete', 'remove', 'trash'],
    enabled: !trashed && isOwnNote(note) && !transcribing,
    confirm: { hint: 'Press Enter again to confirm' },
    run: async () => {
      try {
        const moved = await trashNotes([note.id])
        if (moved.length) navigate('/')
      } catch (err) {
        showToast({ kind: 'error', title: 'Couldn’t move the note to trash', description: parseError(err).message })
      }
    }
  })
  return out
}
