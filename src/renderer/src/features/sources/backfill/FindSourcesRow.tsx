// SPDX-License-Identifier: Apache-2.0
// Settings ▸ Sources ▸ Find sources for older notes, and its preview table with Apply and Undo
// (`sources:backfill-*`). Rows are a preview: nothing changes until the ticked rows
// are linked. Exact and high rows start ticked; a row with several links asks for a pick. One
// Undo unlinks the batch. The Markdown import's done screen has its own panel (imports-md).

import { useState, type JSX } from 'react'
import { parseError } from '@shared/errors'
import type { BackfillPreview, BackfillRow, SourceConfidence, SourceDraft } from '@shared/types/sources'
import { SettingsCard, SettingsRow } from '../../settings'
import { StatusLine, type Status } from '../../settings/controls'
import { isMissingHandler } from '../note/source-store'
import './find-sources.css'

const REASON: Record<BackfillRow['reason'], string> = {
  'url-in-note': 'Link in the note',
  'import-candidate': 'Link from the import',
  'import-series': 'Course from the import',
  'title-search': 'From the title',
  'no-match': 'No match'
}

const CONFIDENCE: Record<SourceConfidence, string> = { exact: 'Exact', high: 'Likely', guess: 'Guess' }

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

function draftLabel(d: SourceDraft): string {
  const lesson = d.lesson?.number != null ? ` · lesson ${d.lesson.number}` : ''
  const series = d.series?.title ? ` · ${d.series.title}` : ''
  return `${d.title || d.url || 'Untitled'}${d.channel ? ` · ${d.channel}` : ''}${series}${lesson}`
}

type State =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'review'; preview: BackfillPreview; ticked: Set<string>; choices: Record<string, number>; applying: boolean }
  | { kind: 'applied'; batchId: string; applied: number; undoing: boolean }

export function FindSourcesRow(): JSX.Element {
  const [state, setState] = useState<State>({ kind: 'idle' })
  const [status, setStatus] = useState<Status>(null)

  async function find(): Promise<void> {
    setState({ kind: 'loading' })
    setStatus(null)
    try {
      const preview = await window.notula.sources.backfillPreview({})
      setState({ kind: 'review', preview, ticked: new Set(preview.rows.filter((r) => r.ticked).map((r) => r.id)), choices: {}, applying: false })
    } catch (err) {
      setState({ kind: 'idle' })
      setStatus({ kind: 'error', text: isMissingHandler(err) ? 'Find sources isn’t available in this build yet.' : `Couldn’t find sources. ${parseError(err).message}` })
    }
  }

  async function apply(): Promise<void> {
    if (state.kind !== 'review' || state.applying) return
    setState({ ...state, applying: true })
    try {
      const res = await window.notula.sources.backfillApply({ previewId: state.preview.previewId, rowIds: [...state.ticked], choices: state.choices })
      setState({ kind: 'applied', batchId: res.batchId, applied: res.applied, undoing: false })
      setStatus({ kind: 'ok', text: `Linked ${plural(res.applied, 'note', 'notes')} to their sources.` })
    } catch (err) {
      setState({ ...state, applying: false })
      setStatus({ kind: 'error', text: `Couldn’t link these notes. ${parseError(err).message}` })
    }
  }

  async function undo(): Promise<void> {
    if (state.kind !== 'applied' || state.undoing) return
    setState({ ...state, undoing: true })
    try {
      const res = await window.notula.sources.backfillUndo({ batchId: state.batchId })
      setState({ kind: 'idle' })
      setStatus({ kind: 'info', text: `Unlinked ${plural(res.reverted, 'note', 'notes')}.` })
    } catch (err) {
      setState({ ...state, undoing: false })
      setStatus({ kind: 'error', text: `Couldn’t undo. ${parseError(err).message}` })
    }
  }

  const control =
    state.kind === 'applied' ? (
      <button type="button" className="n-btn n-btn--sm" disabled={state.undoing || state.applied === 0} onClick={() => void undo()}>
        {state.undoing ? 'Undoing…' : 'Undo'}
      </button>
    ) : (
      <button type="button" className="n-btn n-btn--sm" disabled={state.kind === 'loading' || state.kind === 'review'} onClick={() => void find()}>
        {state.kind === 'loading' ? 'Finding…' : 'Find sources'}
      </button>
    )

  return (
    <SettingsCard title="Older notes">
      <SettingsRow
        title="Find sources for older notes"
        description="Link notes you took before to the videos and lessons they came from. Nothing changes until you choose which to link."
        control={control}
      />
      <StatusLine status={status} />
      {state.kind === 'review' ? <Review state={state} setState={setState} onApply={() => void apply()} /> : null}
    </SettingsCard>
  )
}

function Review({
  state,
  setState,
  onApply
}: {
  state: Extract<State, { kind: 'review' }>
  setState(s: State): void
  onApply(): void
}): JSX.Element {
  const { preview, ticked, choices } = state
  const rows = preview.rows.filter((r) => r.proposal || r.choices.length)
  const missed = preview.rows.length - rows.length
  const toggle = (id: string, on: boolean): void => {
    const next = new Set(ticked)
    if (on) next.add(id)
    else next.delete(id)
    setState({ ...state, ticked: next })
  }
  const pick = (row: BackfillRow, index: number): void => {
    const next = new Set(ticked)
    next.add(row.id)
    setState({ ...state, ticked: next, choices: { ...choices, [row.id]: index } })
  }
  // A row with several links needs a pick before it can be linked.
  const ready = [...ticked].filter((id) => {
    const r = preview.rows.find((x) => x.id === id)
    return !!r && (r.proposal !== null || choices[id] !== undefined)
  })

  return (
    <div className="fsrc">
      {preview.lookupsSkipped ? <p className="fsrc__note">Online lookups are off, so video titles weren’t searched. Turn them on above to search them.</p> : null}
      {preview.searchesLeft ? (
        <p className="fsrc__note">{plural(preview.searchesLeft, 'title wasn’t', 'titles weren’t')} searched yet. Find sources again after linking to continue.</p>
      ) : null}
      {preview.moreLeft ? <p className="fsrc__note">More notes are left. Run Find sources again after linking to continue.</p> : null}
      {rows.length === 0 ? (
        <p className="fsrc__note">No sources found for your older notes.</p>
      ) : (
        <ul className="fsrc__rows">
          {rows.map((r) => (
            <li key={r.id} className="fsrc__row">
              <input
                type="checkbox"
                aria-label={`Link “${r.noteTitle ?? 'Untitled note'}”`}
                checked={ticked.has(r.id)}
                onChange={(e) => toggle(r.id, e.target.checked)}
              />
              <div className="fsrc__text">
                <div className="fsrc__title">{r.noteTitle ?? 'Untitled note'}</div>
                {r.proposal ? (
                  <div className="fsrc__proposal">{draftLabel(r.proposal)}</div>
                ) : (
                  <div className="fsrc__choices" role="radiogroup" aria-label="Choose the source">
                    {r.choices.map((c, i) => (
                      <label key={`${c.canonicalKey}-${i}`} className="fsrc__choice">
                        <input type="radio" name={`fsrc-${r.id}`} checked={choices[r.id] === i} onChange={() => pick(r, i)} />
                        <span>{draftLabel(c)}</span>
                      </label>
                    ))}
                  </div>
                )}
                <div className="fsrc__meta">
                  {r.confidence ? <span className={`fsrc__badge fsrc__badge--${r.confidence}`}>{CONFIDENCE[r.confidence]}</span> : null}
                  <span>{REASON[r.reason]}</span>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
      {missed > 0 ? <p className="fsrc__note">{plural(missed, 'other note looks', 'other notes look')} like a video or lesson, but no source was found.</p> : null}
      <div className="fsrc__actions">
        <button type="button" className="n-btn n-btn--sm" disabled={state.applying} onClick={() => setState({ kind: 'idle' })}>
          Cancel
        </button>
        <button type="button" className="n-btn n-btn--sm n-btn--primary" disabled={state.applying || ready.length === 0} onClick={onApply}>
          {state.applying ? 'Linking…' : `Link ${plural(ready.length, 'note', 'notes')}`}
        </button>
      </div>
    </div>
  )
}
