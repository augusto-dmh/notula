// SPDX-License-Identifier: Apache-2.0
// Window modes in the renderer:
// - `useWindowMode` and `WindowModeChrome`: the main window reads `window:get-mode`, follows
//   `window:mode-changed`, and drops the sidebar and the top bar's secondary controls in the
//   small modes;
// - `GuideDialog`: the wrapper for a step-by-step guide (wide or mini bottom-left, thumbnails
//   with the floating preview). No feature uses it yet; Developer tools has a fixture;
// - `ScreenCornerRoot` (`#/screen-corner`, macOS) and `WindowPreviewRoot` (`#/window-preview`).

import { useEffect, useRef, useState, type JSX } from 'react'
import { WINDOW_GEOMETRY, type WindowMode } from '@shared/types/window-modes'
import { IconClose, NotulaMark } from '../../app/icons'
import './window-modes.css'

// ---------- the mode ----------

export function useWindowMode(): WindowMode {
  const [mode, setMode] = useState<WindowMode>('wide')
  useEffect(() => {
    let live = true
    void window.notula.window
      .getMode()
      .then((r) => {
        if (live) setMode(r.mode)
      })
      .catch(() => undefined)
    const off = window.notula.window.onModeChanged(({ mode: next }) => setMode(next))
    return () => {
      live = false
      off()
    }
  }, [])
  return mode
}

/** Mounted once in App: marks the document so the small modes drop chrome (CSS). */
export function WindowModeChrome(): null {
  const mode = useWindowMode()
  useEffect(() => {
    document.documentElement.dataset['windowMode'] = mode
    return () => {
      delete document.documentElement.dataset['windowMode']
    }
  }, [mode])
  return null
}

// ---------- the guide dialog ----------

export interface GuideStep {
  text: string
  /** An image bundled with the app; its natural size sets the preview's aspect ratio. */
  image?: { src: string; width: number; height: number; alt: string }
}

function Thumbnail({ image }: { image: NonNullable<GuideStep['image']> }): JSX.Element {
  const hovering = useRef(false)
  useEffect(
    () => () => {
      if (hovering.current) window.notula.window.hidePreview()
    },
    []
  )
  const width = WINDOW_GEOMETRY.preview.requestWidth
  return (
    <img
      className="guide-thumb"
      src={image.src}
      alt={image.alt}
      style={{ maxHeight: WINDOW_GEOMETRY.preview.thumbMaxHeight }}
      onMouseEnter={() => {
        hovering.current = true
        window.notula.window.showPreview({ src: image.src, width, height: Math.round((width * image.height) / image.width) })
      }}
      onMouseLeave={() => {
        hovering.current = false
        window.notula.window.hidePreview()
      }}
    />
  )
}

export function GuideDialog({ title, steps, onClose }: { title: string; steps: GuideStep[]; onClose(): void }): JSX.Element {
  const [mini, setMini] = useState(false)
  const miniRef = useRef(false)
  miniRef.current = mini

  // Closing or unmounting while mini goes back to wide.
  useEffect(
    () => () => {
      if (miniRef.current) window.notula.window.setMode({ mode: 'wide', reason: 'guide' })
    },
    []
  )

  const goMini = (): void => {
    setMini(true)
    window.notula.window.setMode({ mode: 'mini-bottom-left', reason: 'guide' })
  }
  const goWide = (): void => {
    setMini(false)
    window.notula.window.setMode({ mode: 'wide', reason: 'guide' })
  }

  return (
    <div className={`guide-backdrop${mini ? ' guide-backdrop--mini' : ''}`}>
      <div className={`guide-dialog${mini ? ' guide-dialog--mini' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="guide-dialog__head">
          <h2 className="guide-dialog__title">{title}</h2>
          <div className="guide-dialog__actions">
            <button type="button" className="n-btn n-btn--sm n-btn--ghost" onClick={mini ? goWide : goMini}>
              {mini ? 'Go wide' : 'Go mini'}
            </button>
            <button type="button" className="n-icon-btn n-icon-btn--sm" aria-label="Close" onClick={onClose}>
              <IconClose size={16} />
            </button>
          </div>
        </div>
        <ol className="guide-steps">
          {steps.map((s, i) => (
            <li key={i} className="guide-step">
              <span className="guide-step__text">{s.text}</span>
              {s.image ? <Thumbnail image={s.image} /> : null}
            </li>
          ))}
        </ol>
      </div>
    </div>
  )
}

// ---------- #/screen-corner (macOS) ----------

export function ScreenCornerRoot(): JSX.Element {
  const [visible, setVisible] = useState(false)
  const [shown, setShown] = useState(false)

  useEffect(() => window.notula.screenCorner.onVisible(({ visible: v }) => setVisible(v)), [])

  // Slides in after two animation frames, so the transition runs from the corner.
  useEffect(() => {
    if (!visible) {
      setShown(false)
      return
    }
    let second = 0
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => setShown(true))
    })
    return () => {
      cancelAnimationFrame(first)
      cancelAnimationFrame(second)
    }
  }, [visible])

  return (
    <div className="screen-corner-root">
      <button type="button" className={`screen-corner${shown ? ' screen-corner--shown' : ''}`} onClick={() => window.notula.screenCorner.click()}>
        <NotulaMark size={44} />
        <span className="screen-corner__pill">Start transcribing</span>
      </button>
    </div>
  )
}

// ---------- #/window-preview ----------

export function WindowPreviewRoot(): JSX.Element {
  const [src, setSrc] = useState<string | null>(null)

  useEffect(() => {
    const off = window.notula.window.onPreviewSrc(({ src: next }) => setSrc(next))
    window.notula.window.previewReady()
    return off
  }, [])

  return (
    <div className="window-preview-root">
      {src ? <img key={src} className="window-preview" src={src} alt="" onLoad={() => window.notula.window.previewLoaded()} /> : null}
    </div>
  )
}
