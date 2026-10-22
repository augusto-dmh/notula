// SPDX-License-Identifier: Apache-2.0
// Settings ▸ Calendar: Display (events with no participants, and the menu-bar meeting
// on macOS), calendar feeds, accounts, visible calendars, and the connect card when no
// source exists.

import { Fragment, useState, type JSX } from 'react'
import { parseError } from '@shared/errors'
import { CALENDAR_COLOR_DEFAULT, type CalendarInfo, type CalendarSource, type OAuthCalendarProvider } from '@shared/types/calendar'
import { isMac } from '../../app/platform'
import { showToast } from '../../app/toast'
import { CalendarPermissionsRows } from '../calendar-write'
import { SettingsCard, SettingsRow } from '../settings'
import { AddFeedForm, ClientFields, ConnectButton, PROVIDER_NAME } from './SourceForms'
import { setPrefs, syncedAgo, useCalendarData, usePrefs } from './store'
import './calendar.css'

export function NtSwitch({
  checked,
  onChange,
  label,
  disabled
}: {
  checked: boolean
  onChange(next: boolean): void
  label: string
  disabled?: boolean
}): JSX.Element {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} className="nt-switch" onClick={() => onChange(!checked)}>
      <span className="nt-switch__thumb" />
    </button>
  )
}

function CheckIcon(): JSX.Element {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  )
}

/** C2: the three check-marked lines. */
export function ConnectBenefits(): JSX.Element {
  return (
    <ul className="nt-benefits">
      {['See your upcoming meetings at a glance', 'Get reminders before meetings start', 'Let Notula fill in titles and attendees'].map((t) => (
        <li key={t}>
          <CheckIcon />
          {t}
        </li>
      ))}
    </ul>
  )
}

function statusLine(s: CalendarSource): { text: string; tone: 'ok' | 'error' | 'busy' } {
  if (s.status === 'syncing') return { text: 'Syncing…', tone: 'busy' }
  if (s.status === 'error') return { text: s.lastError || 'Couldn’t sync this calendar', tone: 'error' }
  return { text: syncedAgo(s.lastSyncedAt), tone: 'ok' }
}

function RemoveButton({ label, onConfirm }: { label: string; onConfirm(): Promise<void> }): JSX.Element {
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  if (!confirming) {
    return (
      <button type="button" className="n-btn n-btn--ghost n-btn--sm" onClick={() => setConfirming(true)}>
        {label}
      </button>
    )
  }
  return (
    <span className="nt-confirm">
      <button
        type="button"
        className="n-btn n-btn--danger n-btn--sm"
        disabled={busy}
        onClick={() => {
          setBusy(true)
          void onConfirm().finally(() => {
            setBusy(false)
            setConfirming(false)
          })
        }}
      >
        {busy ? 'Removing…' : `${label}?`}
      </button>
      <button type="button" className="n-btn n-btn--ghost n-btn--sm" disabled={busy} onClick={() => setConfirming(false)}>
        Cancel
      </button>
    </span>
  )
}

async function removeSource(id: string): Promise<void> {
  try {
    await window.notula.calendar.removeSource({ sourceId: id })
  } catch (err) {
    showToast({ id: 'calendar-remove-failed', kind: 'error', title: 'Couldn’t remove the calendar', description: parseError(err).message })
  }
}

function FeedRow({ source }: { source: CalendarSource }): JSX.Element {
  const st = statusLine(source)
  return (
    <div className="nt-source">
      <div className="nt-source__text">
        <div className="nt-source__name">{source.label}</div>
        <div className="nt-source__detail">
          <span className="nt-source__url">
            {source.insecure ? 'http' : 'https'}://{source.urlHost ?? 'calendar'}/••••••
          </span>
          {source.insecure ? <span className="nt-source__warn">Not encrypted (http)</span> : null}
        </div>
        <div className={`nt-source__status is-${st.tone}`}>{st.text}</div>
      </div>
      <RemoveButton label="Remove" onConfirm={() => removeSource(source.id)} />
    </div>
  )
}

function AccountRow({ source, hasClient }: { source: CalendarSource; hasClient: boolean }): JSX.Element {
  const st = statusLine(source)
  const provider = source.kind as OAuthCalendarProvider
  return (
    <div className="nt-source">
      <div className="nt-source__text">
        <div className="nt-source__name">{source.accountEmail ?? source.label}</div>
        <div className={`nt-source__status is-${st.tone}`}>{st.text}</div>
      </div>
      <span className="nt-source__actions">
        {source.status === 'error' ? <ConnectButton provider={provider} sourceId={source.id} label="Reconnect" disabled={!hasClient} /> : null}
        <RemoveButton label="Disconnect" onConfirm={() => removeSource(source.id)} />
      </span>
    </div>
  )
}

function ProviderBlock({
  provider,
  sources,
  hasClient,
  onConnected
}: {
  provider: OAuthCalendarProvider
  sources: CalendarSource[]
  hasClient: boolean
  onConnected?(s: CalendarSource): void
}): JSX.Element {
  return (
    <div className="nt-provider">
      <div className="nt-provider__head">
        <span className="nt-provider__name">{provider === 'google' ? 'Google Calendar' : 'Microsoft Outlook'}</span>
        <ConnectButton provider={provider} disabled={!hasClient} {...(onConnected ? { onConnected } : {})} label={sources.length ? 'Connect another' : `Connect ${PROVIDER_NAME[provider]}`} />
      </div>
      {sources.map((s) => (
        <Fragment key={s.id}>
          <AccountRow source={s} hasClient={hasClient} />
          {/* Grant access / Turn off per incremental grant. */}
          <CalendarPermissionsRows sourceId={s.id} />
        </Fragment>
      ))}
      <ClientFields provider={provider} hasClient={hasClient} />
    </div>
  )
}

function VisibleCalendars({ calendars, sources }: { calendars: CalendarInfo[]; sources: CalendarSource[] }): JSX.Element {
  const [busy, setBusy] = useState(false)
  const toggle = (c: CalendarInfo, visible: boolean): void => {
    void window.notula.calendar
      .setVisible({ calendarId: c.id, visible })
      .catch((err: unknown) => showToast({ id: 'calendar-visible-failed', kind: 'error', title: 'Couldn’t change the calendar', description: parseError(err).message }))
  }
  const reset = (): void => {
    setBusy(true)
    void window.notula.calendar
      .resetVisible()
      .catch(() => undefined)
      .finally(() => setBusy(false))
  }
  return (
    <section className="settings-group">
      <div className="nt-group-head">
        <h2 className="settings-group__title">Visible calendars</h2>
        <button type="button" className="n-btn n-btn--ghost n-btn--sm" onClick={reset} disabled={busy}>
          Reset
        </button>
      </div>
      <div className="settings-card">
        {sources.map((src) => {
          const mine = calendars.filter((c) => c.sourceId === src.id)
          return (
            <div key={src.id} className="nt-calgroup">
              <div className="nt-calgroup__label">{src.kind === 'ics' ? src.label : (src.accountEmail ?? src.label)}</div>
              {mine.length === 0 ? <div className="nt-calgroup__empty">No calendars yet</div> : null}
              {mine.map((c) => (
                <div key={c.id} className="settings-row nt-calrow">
                  <div className="settings-row__text">
                    <div className="settings-row__label">
                      <span className="nt-dot" style={{ background: c.color ?? CALENDAR_COLOR_DEFAULT }} aria-hidden="true" />
                      {c.name || c.id || 'Untitled calendar'}
                    </div>
                  </div>
                  <div className="settings-row__control">
                    <NtSwitch checked={c.visible} onChange={(v) => toggle(c, v)} label={`Show ${c.name || 'calendar'}`} />
                  </div>
                </div>
              ))}
            </div>
          )
        })}
      </div>
      <p className="settings-group__description nt-footnote">
        Events from a calendar you turn off won’t appear in Notula’s list of upcoming meetings.
      </p>
    </section>
  )
}

export function CalendarSettingsPage(): JSX.Element {
  const prefs = usePrefs()
  const { state, calendars, error } = useCalendarData()
  const [adding, setAdding] = useState(false)
  const [panel, setPanel] = useState<'feed' | OAuthCalendarProvider | null>(null)

  const display = (
    <SettingsCard title="Display">
      <SettingsRow
        title="Show events with no participants"
        description="Includes blocks like focus time or reminders that have no other attendees."
        control={
          <NtSwitch
            checked={!(prefs?.['calendar.filterPersonalEvents'] ?? false)}
            disabled={!prefs}
            onChange={(on) => setPrefs({ 'calendar.filterPersonalEvents': !on })}
            label="Show events with no participants"
          />
        }
      />
      {isMac ? (
        <SettingsRow
          title="Show next meeting in the menu bar"
          description="Shows your next meeting next to the Notula icon in the macOS menu bar."
          control={
            <NtSwitch
              checked={prefs?.['tray.showUpcomingEventInMenuBar'] ?? false}
              disabled={!prefs}
              onChange={(on) => setPrefs({ 'tray.showUpcomingEventInMenuBar': on })}
              label="Show next meeting in the menu bar"
            />
          }
        />
      ) : null}
    </SettingsCard>
  )

  if (error) {
    return (
      <>
        {display}
        <p className="nt-form__error">{error}</p>
      </>
    )
  }
  if (!state) {
    return (
      <>
        {display}
        <div className="n-skeleton" style={{ height: 120 }} />
      </>
    )
  }

  const feeds = state.sources.filter((s) => s.kind === 'ics')
  const google = state.sources.filter((s) => s.kind === 'google')
  const microsoft = state.sources.filter((s) => s.kind === 'microsoft')

  if (state.sources.length === 0) {
    return (
      <>
        {display}
        <section className="settings-group">
          <div className="settings-card nt-connect-card">
            <h2 className="nt-connect-card__title">Connect your calendar to Notula</h2>
            <ConnectBenefits />
            <div className="nt-connect-card__actions">
              <button type="button" className="n-btn n-btn--primary" onClick={() => setPanel('feed')}>
                Add calendar feed
              </button>
              <button type="button" className="n-btn" onClick={() => setPanel('google')}>
                Connect Google
              </button>
              <button type="button" className="n-btn" onClick={() => setPanel('microsoft')}>
                Connect Microsoft
              </button>
            </div>
            {panel === 'feed' ? <AddFeedForm onAdded={() => setPanel(null)} onCancel={() => setPanel(null)} /> : null}
            {panel === 'google' || panel === 'microsoft' ? (
              <ProviderBlock provider={panel} sources={[]} hasClient={state.oauthClients[panel]} />
            ) : null}
          </div>
        </section>
      </>
    )
  }

  return (
    <>
      {display}
      <section className="settings-group">
        <div className="nt-group-head">
          <h2 className="settings-group__title">Calendar feeds</h2>
          {!adding ? (
            <button type="button" className="n-btn n-btn--sm" onClick={() => setAdding(true)}>
              Add calendar feed
            </button>
          ) : null}
        </div>
        <div className="settings-card">
          {feeds.length === 0 && !adding ? <div className="nt-calgroup__empty">No feeds. Add a calendar’s iCal address to read it without signing in.</div> : null}
          {feeds.map((s) => (
            <FeedRow key={s.id} source={s} />
          ))}
          {adding ? <AddFeedForm onAdded={() => setAdding(false)} onCancel={() => setAdding(false)} /> : null}
        </div>
      </section>
      <section className="settings-group">
        <h2 className="settings-group__title">Accounts</h2>
        <div className="settings-card">
          <ProviderBlock provider="google" sources={google} hasClient={state.oauthClients.google} />
          <ProviderBlock provider="microsoft" sources={microsoft} hasClient={state.oauthClients.microsoft} />
        </div>
      </section>
      <VisibleCalendars calendars={calendars} sources={state.sources} />
    </>
  )
}
