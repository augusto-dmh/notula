// SPDX-License-Identifier: Apache-2.0
// Links from the meeting invite on the note: a banner
// offering the invite's document links, and chips for the saved ones. Only with
// `attachedLinks.enabled` and only on the user's own note. A generic link icon stands in
// for favicons: nothing is fetched from Google or any site.

import { useMemo, useRef, useState, type JSX } from 'react'
import { parseError } from '@shared/errors'
import type { AttachedLink, Note } from '@shared/types/notes'
import { IconClose } from '../../app/icons'
import { debugLog } from '../../app/platform'
import { showToast } from '../../app/toast'
import { ActionMenu, type ActionMenuAnchor } from '../note-page/ActionMenu'
import { usePrefs } from '../settings/prefs-store'
import { suggestionsFor } from './links'
import './attachments.css'

function IconLink({ size = 16 }: { size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10 13.5a4 4 0 0 0 5.7.3l3-3a4 4 0 0 0-5.6-5.7l-1.6 1.5" />
      <path d="M14 10.5a4 4 0 0 0-5.7-.3l-3 3a4 4 0 0 0 5.6 5.7l1.6-1.5" />
    </svg>
  )
}

function IconMoreSmall({ size = 14 }: { size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="6" cy="12" r="1.6" />
      <circle cx="12" cy="12" r="1.6" />
      <circle cx="18" cy="12" r="1.6" />
    </svg>
  )
}

async function save(noteId: string, links: AttachedLink[]): Promise<boolean> {
  try {
    await window.notula.attachedLinks.update({ noteId, links })
    return true
  } catch (err) {
    debugLog('attached-links-save-failed', { err: parseError(err) })
    showToast({ id: 'links-failed', kind: 'error', title: 'Couldn’t save the links' })
    return false
  }
}

function openLink(url: string): void {
  window.open(url, '_blank', 'noopener,noreferrer')
}

export function AttachedLinks({ note, editable }: { note: Note; editable: boolean }): JSX.Element | null {
  const prefs = usePrefs()
  const enabled = prefs?.['attachedLinks.enabled'] === true
  const saved = note.saved_links
  const suggestions = useMemo(() => (enabled ? suggestionsFor(note.linked_event, saved) : []), [enabled, note.linked_event, saved])
  const added = saved.filter((l) => l.status === 'added')
  const [busy, setBusy] = useState(false)
  if (!enabled || !editable) return null
  if (suggestions.length === 0 && added.length === 0) return null

  const decide = (status: AttachedLink['status']): void => {
    setBusy(true)
    const next = [...saved, ...suggestions.map((s) => ({ url: s.url, label: s.label, status }))]
    void save(note.id, next).finally(() => setBusy(false))
  }
  const many = suggestions.length > 1
  const first = suggestions[0]

  return (
    <div className="att-links">
      {first ? (
        <div className="att-links__banner" role="status">
          <span className="att-links__banner-icon" aria-hidden="true">
            <IconLink size={15} />
          </span>
          <span className="att-links__banner-title" title={suggestions.map((s) => s.label).join('\n')}>
            {many ? `${first.label} and ${suggestions.length - 1} more` : first.label}
          </span>
          <span className="att-links__banner-hint">from the invite</span>
          <button type="button" className="n-btn n-btn--sm" disabled={busy} onClick={() => decide('added')}>
            {many ? 'Add links to the note' : 'Add link to the note'}
          </button>
          <span className="n-tooltip n-tooltip--end" data-tooltip={many ? 'Dismiss links' : 'Dismiss link'}>
            <button
              type="button"
              className="n-icon-btn n-icon-btn--sm"
              aria-label={many ? 'Dismiss links' : 'Dismiss link'}
              disabled={busy}
              onClick={() => decide('dismissed')}
            >
              <IconClose size={14} />
            </button>
          </span>
        </div>
      ) : null}
      {added.length ? (
        <ul className="att-links__chips" aria-label="Links">
          {added.map((l) => (
            <LinkChip key={l.url} link={l} onRemove={() => void save(note.id, saved.map((x) => (x.url === l.url ? { ...x, status: 'dismissed' } : x)))} />
          ))}
        </ul>
      ) : null}
    </div>
  )
}

function LinkChip({ link, onRemove }: { link: AttachedLink; onRemove(): void }): JSX.Element {
  const [menu, setMenu] = useState<ActionMenuAnchor | null>(null)
  const button = useRef<HTMLButtonElement>(null)
  return (
    <li className="att-chip">
      <a
        className="att-chip__link"
        href={link.url}
        target="_blank"
        rel="noopener noreferrer"
        title={link.url}
        onClick={(e) => {
          e.preventDefault()
          openLink(link.url)
        }}
      >
        <IconLink size={13} />
        <span className="att-chip__label">{link.label}</span>
      </a>
      <button
        ref={button}
        type="button"
        className="att-chip__more"
        aria-label={`Options for ${link.label}`}
        aria-haspopup="menu"
        aria-expanded={menu !== null}
        onClick={() => {
          const rect = button.current?.getBoundingClientRect()
          if (rect) setMenu(menu ? null : { rect, align: 'start' })
        }}
      >
        <IconMoreSmall />
      </button>
      {menu ? (
        <ActionMenu
          label={`Options for ${link.label}`}
          anchor={menu}
          owner={button.current}
          onClose={(refocus) => {
            setMenu(null)
            if (refocus) button.current?.focus()
          }}
          entries={[
            { kind: 'item', id: 'open', label: 'Open link', onSelect: () => openLink(link.url) },
            {
              kind: 'item',
              id: 'copy',
              label: 'Copy link',
              onSelect: () => {
                void navigator.clipboard
                  .writeText(link.url)
                  .then(() => showToast({ id: 'link-copied', kind: 'success', title: 'Link copied' }))
                  .catch(() => window.notula.clipboard.writeText({ text: link.url }).catch(() => undefined))
              }
            },
            { kind: 'divider', id: 'd' },
            { kind: 'item', id: 'remove', label: 'Remove', danger: true, onSelect: onRemove }
          ]}
        />
      ) : null}
    </li>
  )
}
