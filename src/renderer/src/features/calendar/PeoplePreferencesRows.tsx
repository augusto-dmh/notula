// SPDX-License-Identifier: Apache-2.0
// Settings ▸ Preferences: People: the opt-in
// Gravatar switch with its privacy note, and the user-editable webmail domain list
// (a short curated default).

import { useState, type FormEvent, type JSX } from 'react'
import { DEFAULT_GENERIC_EMAIL_DOMAINS } from '@shared/lib/people'
import { SettingsCard, SettingsRow } from '../settings'
import { NtSwitch } from './CalendarSettings'
import { setPrefs, usePrefs } from './store'
import './calendar.css'

const DOMAIN = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/
const MAX_DOMAINS = 500

export function PeoplePreferences(): JSX.Element {
  const prefs = usePrefs()
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const domains = prefs?.['people.genericEmailDomains'] ?? []

  const add = (e: FormEvent): void => {
    e.preventDefault()
    const d = draft.trim().toLowerCase().replace(/^@/, '')
    if (!d) return
    if (!DOMAIN.test(d)) {
      setError('Enter a domain such as example.com')
      return
    }
    if (domains.includes(d)) {
      setError('That domain is already in the list')
      return
    }
    if (domains.length >= MAX_DOMAINS) {
      setError(`At most ${MAX_DOMAINS} domains`)
      return
    }
    setPrefs({ 'people.genericEmailDomains': [...domains, d].sort() })
    setDraft('')
    setError(null)
  }

  return (
    <SettingsCard title="People">
      <SettingsRow
        title="Show profile pictures from Gravatar"
        description="Shows attendees’ Gravatar pictures. Turning this on sends a hash of each attendee’s email address to Gravatar."
        control={
          <NtSwitch
            checked={prefs?.['people.gravatarEnabled'] ?? false}
            disabled={!prefs}
            onChange={(on) => setPrefs({ 'people.gravatarEnabled': on })}
            label="Show profile pictures from Gravatar"
          />
        }
      />
      <SettingsRow
        title="Personal email domains"
        description={`People on these domains (${domains.length}) are grouped as personal addresses, not as one company.`}
        control={
          <button type="button" className="n-btn n-btn--ghost n-btn--sm" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
            {open ? 'Done' : 'Edit'}
          </button>
        }
      />
      {open ? (
        <div className="nt-domains">
          <ul className="nt-domains__list">
            {domains.map((d) => (
              <li key={d} className="nt-chip">
                {d}
                <button
                  type="button"
                  className="nt-chip__remove"
                  aria-label={`Remove ${d}`}
                  onClick={() => setPrefs({ 'people.genericEmailDomains': domains.filter((x) => x !== d) })}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
          <form className="nt-domains__add" onSubmit={add}>
            <input
              className="n-input"
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value)
                setError(null)
              }}
              placeholder="example.com"
              aria-label="Add a domain"
              spellCheck={false}
            />
            <button type="submit" className="n-btn n-btn--sm" disabled={!draft.trim()}>
              Add
            </button>
            <button
              type="button"
              className="n-btn n-btn--ghost n-btn--sm"
              onClick={() => setPrefs({ 'people.genericEmailDomains': [...DEFAULT_GENERIC_EMAIL_DOMAINS] })}
            >
              Reset to defaults
            </button>
          </form>
          {error ? <p className="nt-form__error">{error}</p> : null}
        </div>
      ) : null}
    </SettingsCard>
  )
}
