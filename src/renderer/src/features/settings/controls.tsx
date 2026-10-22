// SPDX-License-Identifier: Apache-2.0
// Small form controls for Settings and onboarding: grouped cards of rows, a
// switch, a native select, a segmented choice and an inline status line.

import { useId, type JSX, type ReactNode } from 'react'
import { IconCheck, IconChevronDown, IconWarning } from './icons'
import './settings.css'

export function Group({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }): JSX.Element {
  const id = useId()
  return (
    <section className="settings-group" aria-labelledby={id}>
      <h2 className="settings-group__title" id={id}>
        {title}
      </h2>
      {description ? <p className="settings-group__description">{description}</p> : null}
      <div className="settings-card">{children}</div>
    </section>
  )
}

/** One row: label and hint on the left, the control on the right (or below when stacked). */
export function Row({
  label,
  hint,
  htmlFor,
  stacked,
  children
}: {
  label: ReactNode
  hint?: ReactNode
  htmlFor?: string
  stacked?: boolean
  children?: ReactNode
}): JSX.Element {
  return (
    <div className={`settings-row${stacked ? ' settings-row--stacked' : ''}`}>
      <div className="settings-row__text">
        {htmlFor ? (
          <label className="settings-row__label" htmlFor={htmlFor}>
            {label}
          </label>
        ) : (
          <div className="settings-row__label">{label}</div>
        )}
        {hint ? <div className="settings-row__hint">{hint}</div> : null}
      </div>
      {children !== undefined ? <div className="settings-row__control">{children}</div> : null}
    </div>
  )
}

export function Switch({
  checked,
  onChange,
  disabled,
  label,
  busy
}: {
  checked: boolean
  onChange(next: boolean): void
  disabled?: boolean
  label: string
  busy?: boolean
}): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-busy={busy || undefined}
      disabled={disabled}
      className="settings-switch"
      onClick={() => onChange(!checked)}
    >
      <span className="settings-switch__thumb" />
    </button>
  )
}

export interface SelectOption<T extends string> {
  value: T
  label: string
  disabled?: boolean
}

export function Select<T extends string>({
  id,
  value,
  options,
  onChange,
  disabled,
  label,
  wide
}: {
  id?: string
  value: T
  options: readonly SelectOption<T>[]
  onChange(next: T): void
  disabled?: boolean
  label?: string
  wide?: boolean
}): JSX.Element {
  return (
    <span className={`settings-select${wide ? ' settings-select--wide' : ''}`}>
      <select
        id={id}
        value={value}
        disabled={disabled}
        aria-label={label}
        onChange={(e) => onChange(e.target.value as T)}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
      </select>
      <IconChevronDown size={14} className="settings-select__chevron" />
    </span>
  )
}

export interface SegmentOption<T extends string> {
  value: T
  label: string
  note?: string
  disabled?: boolean
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label
}: {
  value: T
  options: readonly SegmentOption<T>[]
  onChange(next: T): void
  label: string
}): JSX.Element {
  return (
    <div className="settings-segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          disabled={o.disabled}
          className="settings-segmented__item"
          onClick={() => onChange(o.value)}
        >
          {o.label}
          {o.note ? <span className="settings-segmented__note">{o.note}</span> : null}
        </button>
      ))}
    </div>
  )
}

export type Status = { kind: 'ok' | 'error' | 'info'; text: string } | null

export function StatusLine({ status }: { status: Status }): JSX.Element | null {
  if (!status) return null
  return (
    <p className={`settings-status settings-status--${status.kind}`} role={status.kind === 'error' ? 'alert' : 'status'}>
      {status.kind === 'ok' ? <IconCheck size={14} /> : status.kind === 'error' ? <IconWarning size={14} /> : null}
      <span>{status.text}</span>
    </p>
  )
}
