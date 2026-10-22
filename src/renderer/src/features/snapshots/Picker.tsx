// SPDX-License-Identifier: Apache-2.0
// The screen-snapshot source picker (`#/snapshot-picker?noteId=…`): windows and screens
// with thumbnails, Notula's own windows excluded. Picking one
// starts the snapshots; main closes the window once the start resolves.

import { useEffect, useState, type JSX } from 'react'
import type { ScreenSource } from '@shared/types/snapshots'
import './snapshots.css'

function noteIdFromHash(): string {
  const q = window.location.hash.split('?')[1] ?? ''
  return new URLSearchParams(q).get('noteId') ?? ''
}

export function Picker(): JSX.Element {
  const noteId = noteIdFromHash()
  const [sources, setSources] = useState<ScreenSource[] | null>(null)
  const [tab, setTab] = useState<'window' | 'screen'>('window')
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    const html = document.documentElement
    html.classList.add('snap-window')
    html.dataset['theme'] = 'dark'
    document.title = 'Choose what to snapshot'
  }, [])

  const load = (): void => {
    void window.notula.screenSnapshots
      .listSources()
      .then((list) => {
        setSources(list)
        if (list.every((s) => s.kind === 'screen')) setTab('screen')
      })
      .catch(() => setSources([]))
  }
  useEffect(load, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') window.close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const pick = async (s: ScreenSource): Promise<void> => {
    if (busy || !noteId) return
    setBusy(s.id)
    setMessage(null)
    try {
      const r = await window.notula.screenSnapshots.start({ noteId, sourceId: s.id })
      if (r.status === 'source-gone') {
        setMessage('That window is no longer available. Pick another one.')
        load()
      } else if (r.status === 'disabled') {
        setMessage('Screen snapshots are turned off, or your AI model does not accept images.')
      }
    } finally {
      setBusy(null)
    }
  }

  const shown = (sources ?? []).filter((s) => s.kind === tab)
  return (
    <div className="snap-picker">
      <header className="snap-picker__head">
        <div>
          <div className="snap-picker__title">Choose what to snapshot</div>
          <div className="snap-picker__hint">Notula adds an image of the window or screen you pick to your notes.</div>
        </div>
        <button type="button" className="snap-icon-btn" aria-label="Close" onClick={() => window.close()}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </header>
      <div className="snap-picker__tabs" role="tablist">
        {(['window', 'screen'] as const).map((k) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} className={`snap-tab${tab === k ? ' is-active' : ''}`} onClick={() => setTab(k)}>
            {k === 'window' ? 'Windows' : 'Screens'}
          </button>
        ))}
      </div>
      {message ? <div className="snap-picker__message">{message}</div> : null}
      <div className="snap-picker__grid">
        {sources === null ? (
          <div className="snap-picker__empty">Looking for windows…</div>
        ) : shown.length === 0 ? (
          <div className="snap-picker__empty">{tab === 'window' ? 'No windows to snapshot.' : 'No screens to snapshot.'}</div>
        ) : (
          shown.map((s) => (
            <button key={s.id} type="button" className={`snap-source${busy === s.id ? ' is-busy' : ''}`} disabled={busy !== null} onClick={() => void pick(s)}>
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
  )
}
