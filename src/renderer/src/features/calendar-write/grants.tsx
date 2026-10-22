// SPDX-License-Identifier: Apache-2.0
// Calendar permission rows, and the modal that asks the user to give Notula more access.

import { useState, type JSX } from 'react'
import { createPortal } from 'react-dom'
import { parseError } from '@shared/errors'
import type { CalendarGrant, CalendarSource } from '@shared/types/calendar'
import { showToast } from '../../app/toast'
import { useCalendarData } from '../calendar/store'
import { Row } from '../settings/controls'
import { usePrefs } from '../settings/prefs-store'
import './calendar-write.css'

export const CONFIRM_FAILED = 'Access wasn’t granted. Try again when you’re ready.'
export const GOOGLE_REVOKE_NOTE = 'To remove the permission completely, revoke Notula in your Google account settings.'

/** The OAuth accounts (ICS feeds never write) and a reload. */
export function useOAuthSources(): { sources: CalendarSource[]; loaded: boolean; reload(): void } {
  const data = useCalendarData()
  const sources = (data.state?.sources ?? []).filter((s) => s.kind === 'google' || s.kind === 'microsoft')
  return { sources, loaded: data.state !== null, reload: data.reload }
}

/** A grant change's user-facing failure: a timeout or a denial reads as the generic confirmation failure. */
export function grantError(err: unknown): string {
  const msg = parseError(err).message
  return /timed out|not granted|denied/i.test(msg) ? CONFIRM_FAILED : msg || CONFIRM_FAILED
}

/** Runs `calendar:set-grant`; resolves whether the grant is now as asked. */
export function useGrantAction(): { busyKey: string | null; run(sourceId: string, grant: CalendarGrant, enabled: boolean): Promise<boolean> } {
  const [busyKey, setBusy] = useState<string | null>(null)
  const run = async (sourceId: string, grant: CalendarGrant, enabled: boolean): Promise<boolean> => {
    const key = `${sourceId}:${grant}`
    setBusy(key)
    try {
      const s = await window.notula.calendar.setGrant({ sourceId, grant, enabled })
      if (!enabled && s.kind === 'google') showToast({ kind: 'info', title: 'Permission turned off', description: GOOGLE_REVOKE_NOTE })
      return s.grants.includes(grant) === enabled
    } catch (err) {
      showToast({ id: `grant-${key}`, kind: 'error', title: grantError(err) })
      return false
    } finally {
      setBusy(null)
    }
  }
  return { busyKey, run }
}

/** One permission row: Grant access (busy "Connecting...") or Enabled with Turn off. */
export function GrantRow({ source, grant, label, hint }: { source: CalendarSource; grant: CalendarGrant; label: string; hint: string }): JSX.Element {
  const { busyKey, run } = useGrantAction()
  const held = source.grants.includes(grant)
  const busy = busyKey === `${source.id}:${grant}`
  return (
    <Row label={label} hint={hint}>
      <div className="cw-grant">
        {held ? (
          <>
            <span className="cw-grant__on">Enabled</span>
            <button type="button" className="n-btn n-btn--sm n-btn--ghost" disabled={busy} onClick={() => void run(source.id, grant, false)}>
              {busy ? 'Connecting...' : 'Turn off'}
            </button>
          </>
        ) : (
          <button type="button" className="n-btn n-btn--sm" disabled={busy} onClick={() => void run(source.id, grant, true)}>
            {busy ? 'Connecting...' : 'Grant access'}
          </button>
        )}
      </div>
    </Row>
  )
}

/** Under each OAuth account in Settings ▸ Calendar, the grants of the features that are on. */
export function CalendarPermissionsRows({ sourceId }: { sourceId: string }): JSX.Element | null {
  const prefs = usePrefs()
  const { sources } = useOAuthSources()
  const source = sources.find((s) => s.id === sourceId)
  if (!prefs || !source) return null
  const google = source.kind === 'google'
  const rows: { grant: CalendarGrant; label: string; hint: string }[] = []
  if (prefs['calendarWrite.enabled']) rows.push({ grant: 'calendar-write', label: 'Create events', hint: 'Lets Notula add and edit events on your calendar' })
  if (prefs['mail.enabled']) {
    rows.push(
      { grant: 'mail-read', label: 'Read mail for briefs and chat', hint: google ? 'Read your Gmail' : 'Read your Outlook email' },
      { grant: 'mail-send', label: 'Draft and send follow-up emails', hint: google ? 'Send email from Gmail' : 'Send email from Outlook' }
    )
  }
  if (prefs['connectors.files.enabled']) rows.push({ grant: 'files-read', label: 'Read files', hint: google ? 'Search and read your Google Drive files in chat' : 'Search and read your OneDrive files in chat' })
  if (!rows.length) return null
  return (
    <div className="cw-perms" aria-label="Permissions">
      <div className="cw-perms__title">Permissions</div>
      {rows.map((r) => (
        <GrantRow key={r.grant} source={source} grant={r.grant} label={r.label} hint={r.hint} />
      ))}
      {google && source.grants.length > 0 ? <p className="cw-perms__note">{GOOGLE_REVOKE_NOTE}</p> : null}
    </div>
  )
}

function IconCheckSmall(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M3.5 8.5l3 3 6-7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** The write-permission modal. `onGranted` runs the pending Create event. */
export function PermissionModal({ sourceId, onGranted, onClose }: { sourceId: string; onGranted(): void; onClose(): void }): JSX.Element {
  const { busyKey, run } = useGrantAction()
  const busy = busyKey !== null
  const grant = async (): Promise<void> => {
    if (await run(sourceId, 'calendar-write', true)) {
      onClose()
      onGranted()
    }
  }
  return createPortal(
    <div className="cw-modal" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="cw-modal__panel" role="dialog" aria-modal="true" aria-labelledby="cw-modal-title" aria-describedby="cw-modal-sr">
        <div className="cw-modal__art" aria-hidden="true">
          <svg width="56" height="56" viewBox="0 0 56 56" fill="none">
            <rect x="8" y="12" width="40" height="36" rx="7" fill="var(--accent-soft)" stroke="var(--accent)" strokeWidth="1.5" />
            <path d="M8 22h40" stroke="var(--accent)" strokeWidth="1.5" />
            <path d="M19 8v8M37 8v8" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round" />
            <path d="M22 34l4 4 9-9" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        <h2 id="cw-modal-title" className="cw-modal__title">
          Let Notula create calendar events
        </h2>
        <p id="cw-modal-sr" className="cw-sr">
          Notula needs permission to add events to your calendar. You approve each one first.
        </p>
        <ul className="cw-modal__points">
          {['Create events from chat in one step', 'Review every event before Notula adds it', 'Turn this off at any time in Settings'].map((t) => (
            <li key={t}>
              <span className="cw-modal__tick">
                <IconCheckSmall />
              </span>
              {t}
            </li>
          ))}
        </ul>
        <div className="cw-modal__actions">
          <button type="button" className="n-btn n-btn--primary" disabled={busy} onClick={() => void grant()}>
            {busy ? 'Connecting...' : 'Grant access'}
          </button>
          <button type="button" className="n-btn n-btn--ghost" disabled={busy} onClick={onClose}>
            Skip for now
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
