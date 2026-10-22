// SPDX-License-Identifier: Apache-2.0
// A small modal for the speech settings (the uninstall confirmation, Learn more, the
// language list). Escape and the backdrop close it; focus moves into it.

import { useEffect, useRef, type JSX, type ReactNode } from 'react'
import './speech.css'

export function SpeechDialog({
  title,
  children,
  footer,
  onClose
}: {
  title: string
  children: ReactNode
  footer: ReactNode
  onClose(): void
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    ref.current?.querySelector<HTMLElement>('button')?.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      previous?.focus()
    }
  }, [onClose])
  return (
    <div className="nt-sp-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="nt-sp-dialog" role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <h2 className="nt-sp-dialog__title">{title}</h2>
        <div className="nt-sp-dialog__body">{children}</div>
        <div className="nt-sp-dialog__footer">{footer}</div>
      </div>
    </div>
  )
}
