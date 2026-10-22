// SPDX-License-Identifier: Apache-2.0
// Small UI pieces shared by the workflow features (rules, automations, Customer calls,
// webhooks, the CRM cards): a modal, a chip input and an inline confirm.

import { useEffect, useRef, useState, type JSX, type ReactNode } from 'react'
import { parseError } from '@shared/errors'
import './wb.css'

export function errorText(err: unknown): string {
  return parseError(err).message || 'Something went wrong. Try again.'
}

export function Modal({ title, onClose, children, wide, footer }: { title: ReactNode; onClose(): void; children: ReactNode; wide?: boolean; footer?: ReactNode }): JSX.Element {
  const panel = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    panel.current?.querySelector<HTMLElement>('input, select, textarea, button')?.focus()
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="wb-modal" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={panel} className={`wb-modal__panel${wide ? ' wb-modal__panel--wide' : ''}`} role="dialog" aria-modal="true">
        <h2 className="wb-modal__title">{title}</h2>
        <div className="wb-modal__body">{children}</div>
        {footer ? <div className="wb-modal__actions">{footer}</div> : null}
      </div>
    </div>
  )
}

/** Values as chips; Enter, comma or blur adds the typed value through `normalize` (null = refused). */
export function ChipInput({
  values,
  onChange,
  placeholder,
  normalize,
  label,
  invalidText
}: {
  values: string[]
  onChange(next: string[]): void
  placeholder: string
  normalize(v: string): string | null
  label: string
  invalidText: string
}): JSX.Element {
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const add = (): void => {
    const parts = text.split(/[,\s]+/).map((x) => x.trim()).filter(Boolean)
    if (!parts.length) return
    const next = [...values]
    for (const p of parts) {
      const v = normalize(p)
      if (!v) {
        setError(invalidText)
        return
      }
      if (!next.includes(v)) next.push(v)
    }
    setError(null)
    setText('')
    onChange(next)
  }
  return (
    <div className="wb-chips">
      <div className="wb-chips__box">
        {values.map((v) => (
          <span key={v} className="wb-chip">
            {v}
            <button type="button" className="wb-chip__x" aria-label={`Remove ${v}`} onClick={() => onChange(values.filter((x) => x !== v))}>
              ×
            </button>
          </span>
        ))}
        <input
          className="wb-chips__input"
          aria-label={label}
          placeholder={values.length ? '' : placeholder}
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            setError(null)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault()
              add()
            } else if (e.key === 'Backspace' && !text && values.length) onChange(values.slice(0, -1))
          }}
          onBlur={add}
        />
      </div>
      {error ? <p className="wb-error">{error}</p> : null}
    </div>
  )
}

export function InlineConfirm({ title, body, action, onConfirm, onCancel, danger = true }: { title: string; body: ReactNode; action: string; onConfirm(): void; onCancel(): void; danger?: boolean }): JSX.Element {
  return (
    <div className="wb-confirm" role="alertdialog" aria-label={title}>
      <strong>{title}</strong>
      <div className="wb-confirm__body">{body}</div>
      <div className="wb-actions">
        <button type="button" className="n-btn n-btn--sm" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className={`n-btn n-btn--sm ${danger ? 'n-btn--danger' : 'n-btn--primary'}`} onClick={onConfirm}>
          {action}
        </button>
      </div>
    </div>
  )
}

export const HOSTNAME = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/
export const EMAIL = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/

export function normDomain(v: string): string | null {
  const d = v.trim().replace(/^@/, '').replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase()
  return HOSTNAME.test(d) ? d : null
}

export function normEmail(v: string): string | null {
  const e = v.trim().toLowerCase()
  return EMAIL.test(e) ? e : null
}

export function ago(iso: string | null): string {
  if (!iso) return ''
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000)
  if (!Number.isFinite(s)) return ''
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
