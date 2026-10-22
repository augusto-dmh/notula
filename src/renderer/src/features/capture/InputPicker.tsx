// SPDX-License-Identifier: Apache-2.0
// The microphone picker and the meeting audio panel.
// Rendered only while the selection state is not null (i.e. while capturing).
// On Windows Auto follows the meeting app's microphone (and the Auto option names the
// device it follows); elsewhere Auto is the system default and its label is shorter.
//
// The picker lives in the note's bottom dock, so its menu opens upward. It flips
// down only when there is more room below, and it is clamped to the viewport.

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type JSX, type RefObject } from 'react'
import type { InputPreference } from '@shared/types/capture'
import { navigateToSettings } from '../../app/navigation'
import { useCaptureSnapshot, useVolume } from './store'

const U1_MICROPHONE = 'Microphone'
const U2_AUTO = 'Auto'
const U3_SYSTEM_DEFAULT = 'System default'
const U4_AUTO_INFO = /Windows/i.test(navigator.userAgent)
  ? 'Follows the microphone your meeting app is using. If no meeting app is using one, uses your system default.'
  : 'Uses your system default.'
const U5_NO_MIC = 'No microphone selected'

/** Space kept between the menu and the window edges. */
const EDGE_PX = 8
/** Gap between the trigger and the menu (the CSS offset). */
const GAP_PX = 6
const MIN_MENU_PX = 120

interface Placement {
  up: boolean
  maxHeight: number
  shiftX: number
}

/** Opens the menu toward the side with room, keeps it inside the window, and re-measures on resize. */
function useMenuPlacement(
  open: boolean,
  trigger: RefObject<HTMLElement | null>,
  menu: RefObject<HTMLElement | null>
): Placement | null {
  const [place, setPlace] = useState<Placement | null>(null)
  useLayoutEffect(() => {
    if (!open) {
      setPlace(null)
      return
    }
    const measure = (): void => {
      const t = trigger.current?.getBoundingClientRect()
      const m = menu.current
      if (!t || !m) return
      const above = t.top - GAP_PX - EDGE_PX
      const below = window.innerHeight - t.bottom - GAP_PX - EDGE_PX
      const up = m.scrollHeight <= above || above >= below
      const maxHeight = Math.max(MIN_MENU_PX, Math.floor(up ? above : below))
      // Right-aligned to the trigger; pushed back in when that would cross the left edge.
      const left = t.right - m.offsetWidth
      const shiftX = left < EDGE_PX ? EDGE_PX - left : 0
      setPlace((p) => (p && p.up === up && p.maxHeight === maxHeight && p.shiftX === shiftX ? p : { up, maxHeight, shiftX }))
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [open, trigger, menu])
  return place
}

function LevelMeter(): JSX.Element {
  const rms = useVolume('microphone')
  // RMS of speech sits around 0.02–0.2; a square-root curve keeps the meter readable.
  const pct = Math.min(100, Math.round(Math.sqrt(Math.min(1, rms * 4)) * 100))
  return (
    <div className="nt-cap-meter" role="meter" aria-label="Microphone level" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
      <div className="nt-cap-meter-fill" style={{ width: `${pct}%` }} />
    </div>
  )
}

export function InputPicker(): JSX.Element | null {
  const s = useCaptureSnapshot()
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const place = useMenuPlacement(open, trigger, menu)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (!s.input) return null
  const selected = s.input.preference.mode === 'physical-device' ? s.input.preference.deviceId : 'auto'
  const choose = (pref: InputPreference): void => {
    window.notula.input.setPreference(pref)
    setOpen(false)
  }
  const menuStyle: CSSProperties | undefined = place
    ? { maxHeight: place.maxHeight, ...(place.shiftX ? { transform: `translateX(${place.shiftX}px)` } : {}) }
    : undefined

  return (
    <div className="nt-cap-picker" ref={root}>
      <button
        ref={trigger}
        type="button"
        className="nt-cap-pill"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        title={s.activeDevice.label ?? U1_MICROPHONE}
      >
        <MicIcon />
        <span className="nt-cap-pill-label">{s.activeDevice.label ?? U1_MICROPHONE}</span>
      </button>
      {open && (
        <div
          ref={menu}
          className={`nt-cap-menu ${place?.up === false ? 'nt-cap-menu--down' : 'nt-cap-menu--up'}`}
          role="menu"
          style={menuStyle}
        >
          <div className="nt-cap-menu-section">{U1_MICROPHONE}</div>
          <button
            type="button"
            role="menuitemradio"
            aria-checked={selected === 'auto'}
            className="nt-cap-option"
            onClick={() => choose({ mode: 'auto' })}
          >
            <span className="nt-cap-check">{selected === 'auto' ? '✓' : ''}</span>
            <span className="nt-cap-option-text">
              <span>
                {U2_AUTO}{' '}
                <span className="nt-cap-info" title={U4_AUTO_INFO} aria-label={U4_AUTO_INFO}>
                  ⓘ
                </span>
              </span>
              <span className="nt-cap-option-desc">
                {s.devices.find((d) => d.deviceId === s.input?.autoDeviceId)?.label ?? U3_SYSTEM_DEFAULT}
              </span>
            </span>
          </button>
          {s.devices.map((d, i) => (
            <button
              key={d.deviceId}
              type="button"
              role="menuitemradio"
              aria-checked={selected === d.deviceId}
              className="nt-cap-option"
              onClick={() => choose({ mode: 'physical-device', deviceId: d.deviceId })}
            >
              <span className="nt-cap-check">{selected === d.deviceId ? '✓' : ''}</span>
              <span className="nt-cap-option-text">
                <span>{d.label || `${U1_MICROPHONE} ${i + 1}`}</span>
              </span>
            </button>
          ))}
          <div className="nt-cap-audio">
            <div className="nt-cap-audio-row">
              <span className="nt-cap-audio-key">Input</span>
              <span className="nt-cap-audio-val">{s.activeDevice.label ?? U5_NO_MIC}</span>
            </div>
            <LevelMeter />
            <div className="nt-cap-audio-row">
              <span className="nt-cap-audio-key">System audio</span>
              <span className="nt-cap-audio-val">{s.systemSourceLabel ?? '—'}</span>
            </div>
            <button type="button" className="nt-cap-link" onClick={() => window.notula.system.openAudioSettings()}>
              Sound settings
            </button>
            {/* A shortcut to the transcription checks. */}
            <button
              type="button"
              className="nt-cap-link"
              onClick={() => {
                setOpen(false)
                navigateToSettings('troubleshooting')
              }}
            >
              Troubleshoot transcription issues
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function MicIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="5.5" y="1.5" width="5" height="8.5" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M3 8a5 5 0 0 0 10 0M8 13v2" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}
