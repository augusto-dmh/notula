// SPDX-License-Identifier: Apache-2.0
// The confirmation dialog of speaker profiles: Forget all, Forget voice, merge, delete, the
// model download and the switch-off questions. Esc and the backdrop close it as Cancel; the
// action marked `autoFocus` is the default answer (Enter).

import { useEffect, useRef, type JSX, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import './speaker-profiles.css'

export interface DialogAction {
  label: string
  onClick(): void
  kind?: 'primary' | 'danger' | 'default'
  disabled?: boolean
  autoFocus?: boolean
}

export function SpDialog({
  title,
  children,
  actions,
  onClose,
  wide
}: {
  title: string
  children?: ReactNode
  actions: DialogAction[]
  onClose(): void
  wide?: boolean
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const el = ref.current
    ;(el?.querySelector<HTMLElement>('[data-autofocus="true"]') ?? el?.querySelector<HTMLElement>('input, button'))?.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      previous?.focus()
    }
  }, [onClose])
  return createPortal(
    <div className="nt-spd-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`nt-spd${wide ? ' nt-spd--wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <h2 className="nt-spd__title">{title}</h2>
        {children ? <div className="nt-spd__body">{children}</div> : null}
        <div className="nt-spd__footer">
          {actions.map((a) => (
            <button
              key={a.label}
              type="button"
              className={`n-btn${a.kind === 'primary' ? ' n-btn--primary' : a.kind === 'danger' ? ' nt-sp-btn-danger' : ''}`}
              disabled={a.disabled}
              data-autofocus={a.autoFocus ? 'true' : undefined}
              onClick={a.onClick}
            >
              {a.label}
            </button>
          ))}
        </div>
      </div>
    </div>,
    document.body
  )
}
