// SPDX-License-Identifier: Apache-2.0
// The template icon picker: "Icons" (the
// default tab: a colour row and Notula's icon grid) and "Emojis" (the curated list,
// loaded lazily; "Search emoji...", "Loading…", "No emoji found."). Choosing an icon
// or an emoji closes the picker; changing the colour keeps it open.

import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import type { TemplateIcon } from '@shared/types/templates'
import type { EmojiEntry } from './emoji'
import { DEFAULT_TEMPLATE_ICON, TEMPLATE_COLORS, TEMPLATE_ICON_NAMES, TemplateGlyph, colorValue } from './icons'

export function IconPicker({
  icon,
  onChange,
  onClose
}: {
  icon: TemplateIcon | null
  onChange(icon: TemplateIcon, close: boolean): void
  onClose(): void
}): JSX.Element {
  const current = icon ?? DEFAULT_TEMPLATE_ICON
  const [tab, setTab] = useState<'icons' | 'emojis'>('icons')
  const [color, setColor] = useState(current.type === 'icon' ? current.color : 'gray')
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [onClose])

  return (
    <div className="tpl-picker" ref={rootRef} role="dialog" aria-label="Choose an icon">
      <div className="tpl-picker__tabs" role="tablist">
        <button type="button" role="tab" className="tpl-picker__tab" aria-selected={tab === 'icons'} onClick={() => setTab('icons')}>
          Icons
        </button>
        <button type="button" role="tab" className="tpl-picker__tab" aria-selected={tab === 'emojis'} onClick={() => setTab('emojis')}>
          Emojis
        </button>
      </div>
      {tab === 'icons' ? (
        <>
          <div className="tpl-picker__colors" role="radiogroup" aria-label="Colour">
            {TEMPLATE_COLORS.map((c) => (
              <button
                key={c.name}
                type="button"
                role="radio"
                aria-checked={color === c.name}
                aria-label={c.label}
                title={c.label}
                className="tpl-picker__color"
                style={{ background: c.value }}
                onClick={() => {
                  setColor(c.name)
                  if (current.type === 'icon') onChange({ type: 'icon', value: current.value, color: c.name }, false)
                }}
              />
            ))}
          </div>
          <div className="tpl-picker__grid">
            {TEMPLATE_ICON_NAMES.map((name) => (
              <button
                key={name}
                type="button"
                className="tpl-picker__cell"
                aria-label={name.replace(/-/g, ' ')}
                aria-pressed={current.type === 'icon' && current.value === name}
                style={{ color: colorValue(color) }}
                onClick={() => onChange({ type: 'icon', value: name, color }, true)}
              >
                <TemplateGlyph name={name} size={18} />
              </button>
            ))}
          </div>
        </>
      ) : (
        <EmojiTab current={current.type === 'emoji' ? current.value : null} onPick={(e) => onChange({ type: 'emoji', value: e.value, hexcode: e.hexcode }, true)} />
      )}
    </div>
  )
}

function EmojiTab({ current, onPick }: { current: string | null; onPick(e: EmojiEntry): void }): JSX.Element {
  const [list, setList] = useState<EmojiEntry[] | null>(null)
  const [query, setQuery] = useState('')
  useEffect(() => {
    let live = true
    void import('./emoji').then((m) => {
      if (live) setList(m.emojiList())
    })
    return () => {
      live = false
    }
  }, [])
  const shown = useMemo(() => {
    if (!list) return []
    const q = query.trim().toLowerCase()
    return q ? list.filter((e) => e.name.includes(q)) : list
  }, [list, query])

  return (
    <div className="tpl-picker__emoji">
      <input
        className="n-input tpl-picker__search"
        placeholder="Search emoji..."
        value={query}
        autoFocus
        onChange={(e) => setQuery(e.target.value)}
        aria-label="Search emoji"
      />
      {!list ? (
        <p className="tpl-picker__note">Loading…</p>
      ) : shown.length === 0 ? (
        <p className="tpl-picker__note">No emoji found.</p>
      ) : (
        <div className="tpl-picker__grid tpl-picker__grid--emoji">
          {shown.map((e) => (
            <button
              key={e.hexcode}
              type="button"
              className="tpl-picker__cell tpl-picker__cell--emoji"
              aria-label={e.name}
              title={e.name}
              aria-pressed={current === e.value}
              onClick={() => onPick(e)}
            >
              {e.value}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
