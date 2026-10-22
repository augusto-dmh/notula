// SPDX-License-Identifier: Apache-2.0
// "Add notes": the user's notes not already in
// the folder, grouped by date, filtered by "Search meetings to add..." (title contains
// the text, case-insensitive), with "Select all" / "Deselect all" per group and
// "Add N note(s)".

import { useEffect, useMemo, useState, type JSX } from 'react'
import { parseError } from '@shared/errors'
import type { NoteListItem } from '@shared/types/notes'
import { IconClose, IconNote } from '../../app/icons'
import { isOwnNote } from '../../app/platform'
import { groupRows } from '../home'
import { addNotesToFolder } from './actions'
import { Modal } from './Modal'
import { useFolders } from './store'
import { folderTitle } from './tree'
import { noteTimeLabel } from './NoteList'

type Load = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; items: NoteListItem[] }

export function AddNotesDialog({ folderId, onClose }: { folderId: string; onClose(): void }): JSX.Element {
  const view = useFolders()
  const folder = view?.byId.get(folderId)
  const [load, setLoad] = useState<Load>({ status: 'loading' })
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let live = true
    window.notula.notes
      .list({ scope: 'own' })
      .then((page) => live && setLoad({ status: 'ready', items: page.items.filter((i) => isOwnNote(i)) }))
      .catch((err: unknown) => live && setLoad({ status: 'error', message: parseError(err).message }))
    return () => {
      live = false
    }
  }, [])

  const members = useMemo(() => new Set(view?.membership[folderId] ?? []), [view, folderId])
  const candidates = useMemo(() => {
    if (load.status !== 'ready') return []
    const q = query.trim().toLowerCase()
    return load.items.filter((i) => !members.has(i.id) && (!q || (i.title ?? '').toLowerCase().includes(q)))
  }, [load, members, query])

  // Day groups, each with its note ids.
  const groups = useMemo(() => {
    const out: { label: string; items: NoteListItem[] }[] = []
    for (const row of groupRows(candidates)) {
      if (row.kind === 'header') out.push({ label: row.label, items: [] })
      else out[out.length - 1]?.items.push(row.item)
    }
    return out
  }, [candidates])

  const toggle = (id: string): void =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (!next.delete(id)) next.add(id)
      return next
    })

  const setMany = (ids: string[], on: boolean): void =>
    setSelected((prev) => {
      const next = new Set(prev)
      for (const id of ids) {
        if (on) next.add(id)
        else next.delete(id)
      }
      return next
    })

  const count = selected.size
  const submit = async (): Promise<void> => {
    if (count === 0 || busy) return
    setBusy(true)
    const added = await addNotesToFolder(folderId, [...selected], 'add_notes')
    setBusy(false)
    if (added > 0) onClose()
  }

  return (
    <Modal label="Add notes" className="folder-dialog add-notes" onClose={onClose}>
      <div className="h-modal__body add-notes__body">
        <header className="h-modal__header">
          <div>
            <h2 className="h-modal__title">Add notes</h2>
            {folder ? <p className="h-modal__subtitle">to {folderTitle(folder)}</p> : null}
          </div>
          <button type="button" className="n-icon-btn n-icon-btn--sm" aria-label="Close" onClick={onClose}>
            <IconClose size={15} />
          </button>
        </header>
        <input
          className="n-input add-notes__search"
          placeholder="Search meetings to add..."
          aria-label="Search meetings to add"
          value={query}
          data-autofocus
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="add-notes__list" role="group" aria-label="Notes">
          {load.status === 'loading' ? (
            <p className="add-notes__note">Loading notes...</p>
          ) : load.status === 'error' ? (
            <p className="add-notes__note">{load.message || 'Couldn’t load your notes'}</p>
          ) : groups.length === 0 ? (
            <p className="add-notes__note">No notes found</p>
          ) : (
            groups.map((g) => {
              const ids = g.items.map((i) => i.id)
              const all = ids.every((id) => selected.has(id))
              return (
                <section key={g.label} className="add-notes__group">
                  <div className="add-notes__group-head">
                    <span>{g.label}</span>
                    <button type="button" className="add-notes__select-all" onClick={() => setMany(ids, !all)}>
                      {all ? 'Deselect all' : 'Select all'}
                    </button>
                  </div>
                  {g.items.map((item) => (
                    <label key={item.id} className={`add-notes__row${selected.has(item.id) ? ' is-selected' : ''}`}>
                      <input type="checkbox" checked={selected.has(item.id)} onChange={() => toggle(item.id)} />
                      <span className="add-notes__icon" aria-hidden="true">
                        <IconNote size={15} />
                      </span>
                      <span className={`add-notes__title${item.title ? '' : ' is-untitled'}`}>{item.title || 'New note'}</span>
                      <span className="add-notes__time">{noteTimeLabel(item)}</span>
                    </label>
                  ))}
                </section>
              )
            })
          )}
        </div>
        <footer className="h-modal__footer">
          <button type="button" className="n-btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="n-btn n-btn--primary" disabled={count === 0 || busy} onClick={() => void submit()}>
            {busy ? 'Adding...' : `Add ${count} ${count === 1 ? 'note' : 'notes'}`}
          </button>
        </footer>
      </div>
    </Modal>
  )
}
