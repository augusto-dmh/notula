// SPDX-License-Identifier: Apache-2.0
// The macOS screen-recording guide's two windows:
// the panel beside System Settings (drag Notula into the Screen Recording list) and the spotlight
// backdrop (the Settings window spotlighted, then the `Click later` arrow in the restart phase).

import { useEffect, useState, type DragEvent, type JSX } from 'react'
import type { ScreenGuideLayout } from '@shared/types/snapshots'
import './screen-guide.css'

function useLayout(kind: 'panel' | 'spotlight'): ScreenGuideLayout | null {
  const [layout, setLayout] = useState<ScreenGuideLayout | null>(null)
  useEffect(() => {
    const html = document.documentElement
    html.classList.add('sg-window', `sg-window--${kind}`)
    html.dataset['theme'] = 'dark'
    const off = window.notula.screenGuide.onLayout(setLayout)
    window.notula.screenGuide.ready()
    return off
  }, [kind])
  return layout
}

function AppGlyph(): JSX.Element {
  return (
    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 18V6l12 12V6" />
    </svg>
  )
}

export function GuidePanel(): JSX.Element {
  const layout = useLayout('panel')
  const [appName, setAppName] = useState('Notula')
  useEffect(() => {
    void window.notula.screenGuide
      .getConfig()
      .then((c) => setAppName(c.appName || 'Notula'))
      .catch(() => undefined)
  }, [])
  const dragging = layout?.phase === 'dragging'
  const direction = layout?.direction ?? 'inside'
  const onDragStart = (e: DragEvent<HTMLDivElement>): void => {
    // Main starts the native file drag of the app bundle.
    e.preventDefault()
    window.notula.screenGuide.startDrag({})
  }
  return (
    <div className={`sg-panel sg-panel--${direction}`}>
      {direction !== 'inside' ? <span className={`sg-pointer sg-pointer--${direction}`} aria-hidden="true" /> : null}
      <button type="button" className="sg-close" aria-label="Close guide" onClick={() => window.notula.screenGuide.dismiss()}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden="true">
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>
      <div className="sg-title">{dragging ? 'Drop it in the Screen Recording list' : `Drag ${appName} into Settings`}</div>
      <div className="sg-sub">{dragging ? 'Then switch it on.' : 'Drop it into the Screen Recording list, then turn it on.'}</div>
      <div
        className="sg-icon"
        draggable
        role="img"
        aria-label={`${appName} icon: drag into the Screen Recording list`}
        onDragStart={onDragStart}
      >
        <AppGlyph />
      </div>
      <div className="sg-name">{appName}</div>
    </div>
  )
}

export function GuideSpotlight(): JSX.Element {
  const layout = useLayout('spotlight')
  const s = layout?.settings
  const sheet = layout?.restartSheet
  return (
    <div className="sg-spot">
      {s ? <div className="sg-spot__hole" style={{ left: s.x - 6, top: s.y - 6, width: s.width + 12, height: s.height + 12 }} /> : null}
      {layout?.phase === 'restart' && sheet ? (
        <div className="sg-later" style={{ left: sheet.x + sheet.width * 0.28, top: sheet.y + sheet.height + 14 }}>
          <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 20V5M6 11l6-6 6 6" />
          </svg>
          <span>Click later</span>
        </div>
      ) : null}
    </div>
  )
}
