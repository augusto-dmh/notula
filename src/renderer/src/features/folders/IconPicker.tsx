// SPDX-License-Identifier: Apache-2.0
// The folder icon picker: tabs "Icons" (a colour
// row and an icon grid) and "Emojis" ("Search emoji...", "Loading…", "No emoji found.").
// There is no "Integrations" tab (no integration icons in Notula). A popover anchored to
// its trigger; Escape or an outside click closes it.

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX } from 'react'
import type { TemplateIcon } from '@shared/types/templates'
import { DEFAULT_FOLDER_COLOR, emojiHexcode, FOLDER_COLORS, FOLDER_ICON_NAMES, FOLDER_ICONS, FolderGlyph } from './icons'

type Emoji = readonly [string, string]

let emojiCache: readonly Emoji[] | null = null

const EDGE = 8
const GAP = 6

export function IconPicker({
  anchor,
  value,
  onChange,
  onClose
}: {
  anchor: HTMLElement
  value: TemplateIcon | null
  onChange(icon: TemplateIcon): void
  onClose(): void
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [tab, setTab] = useState<'icons' | 'emojis'>(value?.type === 'emoji' ? 'emojis' : 'icons')
  const [color, setColor] = useState(value?.type === 'icon' ? value.color : DEFAULT_FOLDER_COLOR)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = anchor.getBoundingClientRect()
    const w = el.offsetWidth
    const h = el.offsetHeight
    let top = r.bottom + GAP
    if (top + h > window.innerHeight - EDGE) top = Math.max(EDGE, r.top - GAP - h)
    const left = Math.max(EDGE, Math.min(r.left, window.innerWidth - w - EDGE))
    setPos({ left, top })
  }, [anchor, tab])

  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Node
      if (!ref.current?.contains(t) && !anchor.contains(t)) onClose()
    }
    window.addEventListener('mousedown', onDown, true)
    return () => window.removeEventListener('mousedown', onDown, true)
  }, [anchor, onClose])

  return (
    <div
      ref={ref}
      className="icon-picker"
      role="dialog"
      aria-label="Choose an icon"
      style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: -9999 }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          onClose()
          anchor.focus()
        }
      }}
    >
      <div className="icon-picker__tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'icons'} className="icon-picker__tab" onClick={() => setTab('icons')}>
          Icons
        </button>
        <button type="button" role="tab" aria-selected={tab === 'emojis'} className="icon-picker__tab" onClick={() => setTab('emojis')}>
          Emojis
        </button>
      </div>
      {tab === 'icons' ? (
        <div className="icon-picker__panel" role="tabpanel">
          <div className="icon-picker__colors" role="radiogroup" aria-label="Colour">
            {FOLDER_COLORS.map((c) => (
              <button
                key={c.value}
                type="button"
                role="radio"
                aria-checked={c.value.toLowerCase() === color.toLowerCase()}
                aria-label={c.name}
                title={c.name}
                className="icon-picker__color"
                style={{ background: c.value }}
                onClick={() => {
                  setColor(c.value)
                  if (value?.type === 'icon') onChange({ type: 'icon', value: value.value, color: c.value })
                }}
              />
            ))}
          </div>
          <div className="icon-picker__grid">
            {FOLDER_ICON_NAMES.map((name) => {
              const selected = value?.type === 'icon' && value.value === name
              return (
                <button
                  key={name}
                  type="button"
                  className={`icon-picker__cell${selected ? ' is-selected' : ''}`}
                  aria-label={FOLDER_ICONS[name]?.label ?? name}
                  aria-pressed={selected}
                  title={FOLDER_ICONS[name]?.label}
                  onClick={() => {
                    onChange({ type: 'icon', value: name, color })
                    onClose()
                  }}
                >
                  <FolderGlyph icon={{ type: 'icon', value: name, color }} size={18} />
                </button>
              )
            })}
          </div>
        </div>
      ) : (
        <EmojiPanel
          selected={value?.type === 'emoji' ? value.value : null}
          onPick={(emoji) => {
            onChange({ type: 'emoji', value: emoji, hexcode: emojiHexcode(emoji) })
            onClose()
          }}
        />
      )}
    </div>
  )
}

function EmojiPanel({ selected, onPick }: { selected: string | null; onPick(emoji: string): void }): JSX.Element {
  const [list, setList] = useState<readonly Emoji[] | null>(emojiCache)
  const [query, setQuery] = useState('')

  useEffect(() => {
    if (emojiCache) return
    let live = true
    void import('./emoji').then((m) => {
      emojiCache = m.EMOJI
      if (live) setList(m.EMOJI)
    })
    return () => {
      live = false
    }
  }, [])

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!list) return []
    return q ? list.filter(([e, name]) => name.includes(q) || e === q) : list
  }, [list, query])

  return (
    <div className="icon-picker__panel" role="tabpanel">
      <input
        className="n-input icon-picker__search"
        placeholder="Search emoji..."
        aria-label="Search emoji"
        value={query}
        autoFocus
        onChange={(e) => setQuery(e.target.value)}
      />
      {!list ? (
        <p className="icon-picker__note">Loading…</p>
      ) : shown.length === 0 ? (
        <p className="icon-picker__note">No emoji found.</p>
      ) : (
        <div className="icon-picker__grid icon-picker__grid--emoji">
          {shown.map(([emoji, name]) => (
            <button
              key={emoji}
              type="button"
              className={`icon-picker__cell icon-picker__emoji${selected === emoji ? ' is-selected' : ''}`}
              aria-label={name}
              title={name}
              onClick={() => onPick(emoji)}
            >
              {emoji}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
