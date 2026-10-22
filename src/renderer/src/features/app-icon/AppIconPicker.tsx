// SPDX-License-Identifier: Apache-2.0
// Preferences ▸ Appearance ▸ App icon: seven options, each unlocked by a
// number of notes counted locally. A locked option shows a lock and the tooltip
// "Unlock after <n> notes (<count>/<n>)"; main re-checks the threshold anyway. Choosing one
// changes the selection at once and applies the icon in main; a refusal puts it back.
// The swatches mirror the art main draws (src/main/app-icon/tints.ts).

import { useEffect, useRef, useState, type JSX, type KeyboardEvent } from 'react'
import { parseError } from '@shared/errors'
import { APP_ICON_THRESHOLDS, type AppIconState, type AppIconValue } from '@shared/types/app-icon'
import { showToast } from '../../app/toast'
import { Row } from '../settings/controls'
import { IconLock } from '../settings/icons'
import './app-icon.css'

const OPTIONS: readonly { value: AppIconValue | null; label: string }[] = [
  { value: null, label: 'Default' },
  { value: 'black', label: 'Black' },
  { value: 'white', label: 'White' },
  { value: 'blue', label: 'Blue' },
  { value: 'yellow', label: 'Yellow' },
  { value: 'red', label: 'Red' },
  { value: 'pink', label: 'Pink' }
]

export function AppIconPicker(): JSX.Element | null {
  const [state, setState] = useState<AppIconState | null>(null)
  const group = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let live = true
    window.notula.appIcon.getState().then(
      (s) => live && setState(s),
      () => live && setState(null)
    )
    return () => {
      live = false
    }
  }, [])

  if (!state || !state.platformSupported) return null

  const choose = async (value: AppIconValue | null): Promise<void> => {
    if (value === state.current) return
    const before = state
    setState({ ...state, current: value })
    try {
      setState(await window.notula.appIcon.set({ value }))
    } catch (err) {
      setState(before)
      showToast({ kind: 'error', title: parseError(err).message || 'Couldn’t change the app icon' })
    }
  }

  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return
    const buttons = Array.from(group.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement)
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : (at + (e.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length
    buttons[next]?.focus()
    e.preventDefault()
  }

  return (
    <Row label="App icon" hint="Pick a color for Notula’s icon. New colors unlock as you take notes." stacked>
      <div className="app-icon-picker" role="radiogroup" aria-label="App icon" ref={group} onKeyDown={onKey}>
        {OPTIONS.map((o) => {
          const need = APP_ICON_THRESHOLDS[o.value ?? 'default']
          const locked = state.noteCount < need
          const selected = state.current === o.value
          return (
            <button
              key={o.label}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-disabled={locked || undefined}
              aria-label={`${o.label} app icon`}
              title={locked ? `Unlock after ${need} notes (${state.noteCount}/${need})` : o.label}
              tabIndex={selected ? 0 : -1}
              className={`app-icon-option${selected ? ' is-selected' : ''}${locked ? ' is-locked' : ''}`}
              onClick={() => {
                if (!locked) void choose(o.value)
              }}
            >
              <span className={`app-icon-swatch app-icon-swatch--${o.value ?? 'default'}`} aria-hidden="true">
                <span className="app-icon-swatch__page">
                  <i />
                  <i />
                  <i />
                </span>
              </span>
              <span className="app-icon-option__label">{o.label}</span>
              {locked ? (
                <span className="app-icon-option__lock" aria-hidden="true">
                  <IconLock size={11} />
                </span>
              ) : null}
            </button>
          )
        })}
      </div>
    </Row>
  )
}
