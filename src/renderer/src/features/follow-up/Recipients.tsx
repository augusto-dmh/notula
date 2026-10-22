// SPDX-License-Identifier: Apache-2.0
// A recipients field: addresses as chips; Enter, comma, Tab or leaving the field adds what
// was typed; Backspace in an empty field removes the last chip.

import { useRef, useState, type JSX, type KeyboardEvent } from 'react'
import { IconClose } from '../../app/icons'

const EMAIL = /^[^\s@<>(),;:"[\]]+@[^\s@<>(),;:"[\]]+\.[^\s@<>(),;:"[\]]+$/

export function Recipients({
  label,
  value,
  onChange,
  disabled,
  trailing
}: {
  label: string
  value: string[]
  onChange(next: string[]): void
  disabled?: boolean
  trailing?: JSX.Element | null
}): JSX.Element {
  const [text, setText] = useState('')
  const [invalid, setInvalid] = useState(false)
  const input = useRef<HTMLInputElement>(null)

  const commit = (): boolean => {
    const parts = text
      .split(/[,;\s]+/)
      .map((p) => p.trim().replace(/^<|>$/g, ''))
      .filter(Boolean)
    if (parts.length === 0) return false
    const good = parts.filter((p) => EMAIL.test(p))
    if (good.length !== parts.length) {
      setInvalid(true)
      return true
    }
    const seen = new Set(value.map((v) => v.toLowerCase()))
    onChange([...value, ...good.filter((g) => !seen.has(g.toLowerCase()))])
    setText('')
    setInvalid(false)
    return true
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter' || e.key === ',' || e.key === ';') {
      e.preventDefault()
      commit()
    } else if (e.key === 'Tab' && text.trim()) {
      if (commit()) e.preventDefault()
    } else if (e.key === 'Backspace' && text === '' && value.length) {
      onChange(value.slice(0, -1))
    }
  }

  return (
    <div className="fu-field" onMouseDown={(e) => e.target === e.currentTarget && (e.preventDefault(), input.current?.focus())}>
      <span className="fu-field__label">{label}</span>
      <div className="fu-chips">
        {value.map((v) => (
          <span key={v} className="fu-chip">
            {v}
            {disabled ? null : (
              <button type="button" className="fu-chip__remove" aria-label={`Remove ${v}`} onClick={() => onChange(value.filter((x) => x !== v))}>
                <IconClose size={11} />
              </button>
            )}
          </span>
        ))}
        <input
          ref={input}
          className={`fu-chips__input${invalid ? ' is-invalid' : ''}`}
          aria-label={label}
          aria-invalid={invalid || undefined}
          value={text}
          disabled={disabled}
          onChange={(e) => {
            setText(e.target.value)
            setInvalid(false)
          }}
          onKeyDown={onKeyDown}
          onBlur={() => commit()}
        />
      </div>
      {trailing ?? null}
    </div>
  )
}
