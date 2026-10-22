// SPDX-License-Identifier: Apache-2.0
// The import done screen's Find sources: the core backfill scoped to this batch's notes,
// through `sources:backfill-preview {noteIds}` and `sources:backfill-apply`. Rows are a preview;
// nothing changes until Link. Exact and high rows are ticked; several sources ask for a pick.
// When the backfill isn't in this build yet, it says so and the links stay saved for later.
// Also the catalog prompt per course (`sources:import-catalog` with a file handle main made).

import { useState, type JSX } from 'react'
import { parseError } from '@shared/errors'
import type { BackfillPreview, BackfillRow, SourceDraft } from '@shared/types/sources'
import { showToast } from '../../app/toast'
import { isMissingHandler, plural } from './labels'

const REASON: Record<BackfillRow['reason'], string> = {
  'url-in-note': 'Link in the note',
  'import-candidate': 'Link from the import',
  'import-series': 'Course from the import',
  'title-search': 'Title search',
  'no-match': 'No match'
}

const CONFIDENCE: Record<string, string> = { exact: 'Exact', high: 'Likely', guess: 'Guess' }

function draftLabel(d: SourceDraft | null): string {
  if (!d) return '—'
  return d.channel ? `${d.title} · ${d.channel}` : d.title
}

export function FindSourcesPanel({ noteIds }: { noteIds: string[] }): JSX.Element {
  const [state, setState] = useState<
    | { kind: 'idle' }
    | { kind: 'loading' }
    | { kind: 'unavailable' }
    | { kind: 'error'; message: string }
    | { kind: 'review'; preview: BackfillPreview; ticked: Set<string>; choices: Record<string, number>; applying: boolean }
    | { kind: 'applied'; applied: number }
  >({ kind: 'idle' })

  async function find(): Promise<void> {
    setState({ kind: 'loading' })
    try {
      const preview = await window.notula.sources.backfillPreview({ noteIds })
      setState({ kind: 'review', preview, ticked: new Set(preview.rows.filter((r) => r.ticked).map((r) => r.id)), choices: {}, applying: false })
    } catch (err) {
      setState(isMissingHandler(err) ? { kind: 'unavailable' } : { kind: 'error', message: parseError(err).message })
    }
  }

  async function apply(): Promise<void> {
    if (state.kind !== 'review' || state.applying) return
    setState({ ...state, applying: true })
    try {
      const res = await window.notula.sources.backfillApply({ previewId: state.preview.previewId, rowIds: [...state.ticked], choices: state.choices })
      showToast({ id: 'notes-import-sources', kind: 'success', title: `Linked ${plural(res.applied, 'note', 'notes')} to their sources` })
      setState({ kind: 'applied', applied: res.applied })
    } catch (err) {
      setState({ kind: 'error', message: parseError(err).message })
    }
  }

  if (state.kind === 'idle' || state.kind === 'loading') {
    return (
      <button type="button" className="n-btn n-btn--sm" disabled={state.kind === 'loading' || noteIds.length === 0} onClick={() => void find()}>
        {state.kind === 'loading' ? 'Finding sources…' : 'Find sources'}
      </button>
    )
  }
  if (state.kind === 'unavailable') return <p className="nix-note">Find sources isn’t available in this build yet. The links stay saved for later.</p>
  if (state.kind === 'error') {
    return (
      <p className="nix-error" role="alert">
        Couldn’t find sources. {state.message}
      </p>
    )
  }
  if (state.kind === 'applied') return <p className="nix-note">{plural(state.applied, 'note is', 'notes are')} linked to their sources.</p>

  const { preview, ticked } = state
  const rows = preview.rows.filter((r) => r.proposal || r.choices.length)
  const toggle = (id: string, on: boolean): void => {
    const next = new Set(ticked)
    if (on) next.add(id)
    else next.delete(id)
    setState({ ...state, ticked: next })
  }
  return (
    <div className="nix-sources">
      <p className="nix-note">
        {rows.length
          ? `${plural(rows.length, 'note has', 'notes have')} a suggested source.${preview.lookupsSkipped ? ' Online lookups are off, so only links were used.' : ''}`
          : 'No sources found for these notes.'}
      </p>
      {rows.length ? (
        <ul className="nix-sources__list">
          {rows.map((r) => (
            <li key={r.id} className="nix-sources__row">
              <input type="checkbox" aria-label={`Link ${r.noteTitle ?? 'Untitled'}`} checked={ticked.has(r.id)} onChange={(e) => toggle(r.id, e.target.checked)} />
              <div className="nix-sources__text">
                <span className="nix-sources__title">{r.noteTitle ?? 'Untitled'}</span>
                {r.choices.length > 1 ? (
                  <select
                    className="nix-select"
                    value={state.choices[r.id] ?? 0}
                    onChange={(e) => setState({ ...state, choices: { ...state.choices, [r.id]: Number(e.target.value) } })}
                  >
                    {r.choices.map((c, i) => (
                      <option key={c.canonicalKey} value={i}>
                        {draftLabel(c)}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="nix-sources__meta">{draftLabel(r.proposal)}</span>
                )}
                <span className="nix-sources__meta">
                  {REASON[r.reason]}
                  {r.confidence ? ` · ${CONFIDENCE[r.confidence] ?? r.confidence}` : ''}
                </span>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      {rows.length ? (
        <button type="button" className="n-btn n-btn--sm n-btn--primary" disabled={!ticked.size || state.applying} onClick={() => void apply()}>
          {state.applying ? 'Linking…' : `Link ${plural(ticked.size, 'note', 'notes')}`}
        </button>
      ) : null}
    </div>
  )
}

/** "Import catalog for <course>": the series must exist (Find sources makes it). */
export function CatalogButton({ course, handle }: { course: string; handle: string }): JSX.Element {
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  async function run(): Promise<void> {
    setBusy(true)
    setNote(null)
    try {
      // The course's series by title, or by the folder it is filed in.
      const want = course.trim().toLowerCase()
      const [list, folders] = await Promise.all([window.notula.sources.listSeries(), window.notula.folders.list()])
      const folderTitle = new Map(folders.folders.map((f) => [f.id, f.title.trim().toLowerCase()]))
      let series =
        list.find((s) => s.title.trim().toLowerCase() === want) ?? list.find((s) => s.folder_id !== null && folderTitle.get(s.folder_id) === want)
      if (!series) {
        // Else the one course series of the notes the import put in the course's folder: Find
        // sources links them without filing, and the series may carry another name.
        const inFolder = folders.folders.filter((f) => f.title.trim().toLowerCase() === want).flatMap((f) => folders.membership[f.id] ?? [])
        const views = await Promise.all(inFolder.slice(0, 50).map((noteId) => window.notula.sources.getForNote({ noteId }).catch(() => null)))
        const ids = new Set(views.flatMap((v) => (v?.series && v.series.kind !== 'channel' ? [v.series.id] : [])))
        if (ids.size === 1) series = list.find((s) => ids.has(s.id))
      }
      if (!series) {
        setNote('Find sources first, so Notula knows this course.')
        return
      }
      const res = await window.notula.sources.importCatalog({ seriesId: series.id, input: { kind: 'file', handle } })
      showToast({ id: 'notes-import-catalog', kind: 'success', title: `Imported ${plural(res.items, 'lesson', 'lessons')} for ${course}` })
      setNote(`${plural(res.items, 'lesson', 'lessons')} in the catalog, ${res.numbered} numbered.`)
    } catch (err) {
      setNote(isMissingHandler(err) ? 'Catalog import isn’t available in this build yet.' : `Couldn’t import the catalog. ${parseError(err).message}`)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="nix-catalog">
      <button type="button" className="n-btn n-btn--sm" disabled={busy} onClick={() => void run()}>
        Import catalog for {course}
      </button>
      {note ? <span className="nix-note">{note}</span> : null}
    </div>
  )
}
