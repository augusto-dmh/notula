// SPDX-License-Identifier: Apache-2.0
// Home ▸ Coming up, today's group: `Try a demo meeting`,
// offered while the demo was never started and the user has at most 5 non-demo notes.

import { useEffect, useState, type JSX, type KeyboardEvent } from 'react'
import { DEMO_LIMITS, isDemoNote } from '@shared/types/demo'
import { startDemo } from './store'
import './demo.css'

/** Counts own notes, demo notes excluded. */
function useFewNotes(): boolean | null {
  const [few, setFew] = useState<boolean | null>(null)
  useEffect(() => {
    let alive = true
    const check = (): void => {
      void window.notula.notes
        .list({ scope: 'own', limit: DEMO_LIMITS.maxNotes + 8 })
        .then((page) => {
          if (!alive) return
          const notes = page.items.filter((n) => !isDemoNote({ id: n.id, event_id: n.event_id }))
          setFew(notes.length <= DEMO_LIMITS.maxNotes)
        })
        .catch(() => alive && setFew(false))
    }
    check()
    const off = window.notula.notes.onChanged((c) => {
      if (c.tables.includes('documents')) check()
    })
    return () => {
      alive = false
      off()
    }
  }, [])
  return few
}

export function DemoComingUpRow({ demoStarted }: { demoStarted: boolean }): JSX.Element | null {
  const few = useFewNotes()
  if (demoStarted || few !== true) return null
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      void startDemo('home_event')
    }
  }
  return (
    <div role="button" tabIndex={0} className="nt-event demo-row" onClick={() => void startDemo('home_event')} onKeyDown={onKeyDown}>
      <span className="demo-row__thumb" role="img" aria-label="Demo meeting thumbnail">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M8 5.5v13l10.5-6.5z" />
        </svg>
      </span>
      <span className="nt-event__text">
        <span className="nt-event__title">Try a demo meeting</span>
        <span className="nt-event__meta">Learn how Notula works in 2 minutes</span>
      </span>
    </div>
  )
}
