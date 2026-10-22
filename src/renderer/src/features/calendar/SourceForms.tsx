// SPDX-License-Identifier: Apache-2.0
// The forms Settings ▸ Calendar and the onboarding step share: "Add calendar feed"
// (fetch-first save, inline error) and the Google /
// Microsoft client fields with Connect. Feed URLs and client values go to main and
// never come back.

import { useEffect, useState, type FormEvent, type JSX } from 'react'
import { parseError } from '@shared/errors'
import type { CalendarSource, OAuthCalendarProvider } from '@shared/types/calendar'
import { usePrefs } from './store'

export const PROVIDER_NAME: Record<OAuthCalendarProvider, string> = { google: 'Google', microsoft: 'Microsoft' }

export function AddFeedForm({ onAdded, onCancel }: { onAdded(source: CalendarSource): void; onCancel?(): void }): JSX.Element {
  const prefs = usePrefs()
  const [url, setUrl] = useState('')
  const [label, setLabel] = useState('')
  const [email, setEmail] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const myEmail = email ?? prefs?.['profile.email'] ?? ''

  const submit = (e: FormEvent): void => {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    window.notula.calendar
      .addIcs({ url: url.trim(), ...(label.trim() ? { label: label.trim() } : {}), ...(myEmail.trim() ? { myEmail: myEmail.trim() } : {}) })
      .then((source) => {
        setUrl('')
        setLabel('')
        onAdded(source)
      })
      .catch((err: unknown) => setError(parseError(err).message || 'Couldn’t read this calendar'))
      .finally(() => setBusy(false))
  }

  return (
    <form className="nt-form" onSubmit={submit}>
      <label className="nt-field">
        <span className="nt-field__label">Calendar address (iCal / ICS)</span>
        <input
          className="n-input"
          type="url"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          placeholder="https://calendar.google.com/calendar/ical/…/basic.ics"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          required
          autoFocus
        />
      </label>
      <div className="nt-form__row">
        <label className="nt-field">
          <span className="nt-field__label">Label (optional)</span>
          <input className="n-input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Work" maxLength={200} />
        </label>
        <label className="nt-field">
          <span className="nt-field__label">Your email in this calendar (optional)</span>
          <input className="n-input" type="email" value={myEmail} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
        </label>
      </div>
      {error ? (
        <p className="nt-form__error" role="alert">
          {error}
        </p>
      ) : null}
      <p className="nt-form__help">
        Google Calendar: Settings ▸ your calendar ▸ Integrate calendar ▸ “Secret address in iCal format”. Outlook: Settings ▸
        Calendar ▸ Shared calendars ▸ Publish a calendar ▸ the ICS link. The address is stored in this computer’s secure storage.
      </p>
      <div className="nt-form__actions">
        {onCancel ? (
          <button type="button" className="n-btn n-btn--ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        ) : null}
        <button type="submit" className="n-btn n-btn--primary" disabled={busy || !url.trim()}>
          {busy ? 'Reading calendar…' : 'Add calendar feed'}
        </button>
      </div>
    </form>
  )
}

/** The client fields for one provider; values are write-only (only "is set" comes back). */
export function ClientFields({
  provider,
  hasClient,
  onSaved
}: {
  provider: OAuthCalendarProvider
  hasClient: boolean
  onSaved?(): void
}): JSX.Element {
  const [editing, setEditing] = useState(!hasClient)
  const [clientId, setClientId] = useState('')
  const [secret, setSecret] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // A client saved elsewhere (another view, the onboarding step) closes the form.
  useEffect(() => {
    if (hasClient) setEditing(false)
  }, [hasClient])

  const save = (e: FormEvent): void => {
    e.preventDefault()
    if (busy || !clientId.trim()) return
    setBusy(true)
    setError(null)
    window.notula.calendar
      .setOAuthClient({ provider, clientId: clientId.trim(), ...(provider === 'google' && secret.trim() ? { clientSecret: secret.trim() } : {}) })
      .then(() => {
        setClientId('')
        setSecret('')
        setEditing(false)
        onSaved?.()
      })
      .catch((err: unknown) => setError(parseError(err).message))
      .finally(() => setBusy(false))
  }

  const clear = (): void => {
    setBusy(true)
    window.notula.calendar
      .setOAuthClient({ provider, clientId: '' })
      .then(() => setEditing(true))
      .catch((err: unknown) => setError(parseError(err).message))
      .finally(() => setBusy(false))
  }

  if (hasClient && !editing) {
    return (
      <div className="nt-client is-set">
        <span className="nt-client__saved">Client ID saved</span>
        <button type="button" className="n-btn n-btn--ghost n-btn--sm" onClick={() => setEditing(true)} disabled={busy}>
          Change
        </button>
        <button type="button" className="n-btn n-btn--ghost n-btn--sm" onClick={clear} disabled={busy}>
          Remove
        </button>
      </div>
    )
  }

  return (
    <form className="nt-form nt-client" onSubmit={save}>
      <div className="nt-form__row">
        <label className="nt-field">
          <span className="nt-field__label">{provider === 'google' ? 'OAuth client ID' : 'Application (client) ID'}</span>
          <input
            className="n-input"
            autoComplete="off"
            spellCheck={false}
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            placeholder={provider === 'google' ? '…apps.googleusercontent.com' : '00000000-0000-0000-0000-000000000000'}
          />
        </label>
        {provider === 'google' ? (
          <label className="nt-field">
            <span className="nt-field__label">Client secret</span>
            <input className="n-input" type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} />
          </label>
        ) : null}
      </div>
      <p className="nt-form__help">
        {provider === 'google'
          ? 'Create a “Desktop app” OAuth client in Google Cloud Console (APIs & Services ▸ Credentials) with the Google Calendar API enabled. While the app is in “Testing”, Google signs you out every 7 days; publish it to stay connected.'
          : 'Register an app in Microsoft Entra (App registrations) with the “Mobile and desktop applications” platform and the redirect URI http://localhost, then paste its Application (client) ID. No secret is needed.'}
      </p>
      {error ? (
        <p className="nt-form__error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="nt-form__actions">
        {hasClient ? (
          <button type="button" className="n-btn n-btn--ghost" onClick={() => setEditing(false)} disabled={busy}>
            Cancel
          </button>
        ) : null}
        <button type="submit" className="n-btn" disabled={busy || !clientId.trim()}>
          Save client ID
        </button>
      </div>
    </form>
  )
}

/** Connect / Connecting... (C3/C4), or Reconnect for an existing source. */
export function ConnectButton({
  provider,
  disabled,
  sourceId,
  label,
  onConnected,
  primary
}: {
  provider: OAuthCalendarProvider
  disabled?: boolean
  sourceId?: string
  label?: string
  onConnected?(source: CalendarSource): void
  primary?: boolean
}): JSX.Element {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const connect = (): void => {
    setBusy(true)
    setError(null)
    window.notula.calendar
      .connect({ provider, ...(sourceId ? { sourceId } : {}) })
      .then((s) => onConnected?.(s))
      .catch((err: unknown) => {
        const { code, message } = parseError(err)
        setError(code === 'busy' ? 'Another connection is in progress.' : code === 'missing-key' ? 'Add a client ID first.' : message)
      })
      .finally(() => setBusy(false))
  }
  return (
    <span className="nt-connect">
      <button type="button" className={`n-btn n-btn--sm${primary ? ' n-btn--primary' : ''}`} disabled={disabled || busy} onClick={connect}>
        {busy ? 'Connecting...' : (label ?? `Connect ${PROVIDER_NAME[provider]}`)}
      </button>
      {busy ? <span className="nt-connect__hint">Finish signing in in your browser.</span> : null}
      {error ? (
        <span className="nt-form__error" role="alert">
          {error}
        </span>
      ) : null}
    </span>
  )
}
