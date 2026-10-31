// SPDX-License-Identifier: Apache-2.0
// The screen-capture overlay (`#/screen-capture-region?mode=…`): the snapshot overlay, with
// Space switching to a list of windows (the snapshot picker's tiles, Notula's own windows
// excluded). Picking a window grabs it at full size; Escape cancels from either view.

import { useEffect, useState, type JSX } from 'react'
import type { ScreenSource } from '@shared/types/snapshots'
import { SnapshotRegionRoot } from '../snapshots'
import './screen-capture.css'

function startMode(): 'region' | 'window' {
  const q = window.location.hash.split('?')[1] ?? ''
  return new URLSearchParams(q).get('mode') === 'window' ? 'window' : 'region'
}

function WindowList(): JSX.Element {
  const [sources, setSources] = useState<ScreenSource[] | null>(null)
  const [picked, setPicked] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    void window.notula.snapshotRegion
      .listWindows()
      .then((list) => live && setSources(list))
      .catch(() => live && setSources([]))
    return () => {
      live = false
    }
  }, [])
  const pick = (id: string): void => {
    if (picked) return
    setPicked(id)
    window.notula.snapshotRegion.pickWindow({ sourceId: id })
  }
  return (
    <div className="cap-windows" role="dialog" aria-label="Choose a window">
      <div className="cap-windows__panel">
        <div className="cap-windows__head">
          <span className="cap-windows__title">Choose a window</span>
          <span className="cap-windows__hint">Space to drag a region · Esc to cancel</span>
        </div>
        <div className="snap-picker__grid cap-windows__grid">
          {sources === null ? (
            <div className="snap-picker__empty">Looking for windows…</div>
          ) : sources.length === 0 ? (
            <div className="snap-picker__empty">No windows to capture.</div>
          ) : (
            sources.map((s) => (
              <button key={s.id} type="button" className={`snap-source${picked === s.id ? ' is-busy' : ''}`} disabled={picked !== null} onClick={() => pick(s.id)}>
                <span className="snap-source__thumb">
                  <img src={s.thumbnail} alt="" />
                </span>
                <span className="snap-source__name" title={s.name}>
                  {s.name}
                </span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  )
}

export function CaptureRegion(): JSX.Element {
  const [mode, setMode] = useState(startMode)
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== ' ' || e.repeat) return
      e.preventDefault()
      setMode((m) => (m === 'region' ? 'window' : 'region'))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  return (
    <>
      <SnapshotRegionRoot />
      {mode === 'window' ? <WindowList /> : <div className="cap-region-hint">Space to pick a window</div>}
    </>
  )
}
