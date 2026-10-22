// SPDX-License-Identifier: Apache-2.0
// The onboarding calendar step: after permissions
// and AI providers. C1, C2 and the illustration; "Add calendar feed", "Connect Google" /
// "Connect Microsoft" (each leads to its client-ID fields) and "Skip for now". It is done
// once a source syncs, or on skip, and records `onboarding.calendarDoneAt`. Never blocking.

import { useState, type JSX } from 'react'
import type { OAuthCalendarProvider } from '@shared/types/calendar'
import { ConnectBenefits } from './CalendarSettings'
import { AddFeedForm, ClientFields, ConnectButton } from './SourceForms'
import { setPrefs, useCalendarData } from './store'
import './calendar.css'

function Illustration(): JSX.Element {
  return (
    <svg className="nt-onb__art" width={88} height={88} viewBox="0 0 88 88" fill="none" aria-hidden="true">
      <rect x="10" y="16" width="68" height="60" rx="10" fill="var(--surface)" stroke="var(--border-strong)" strokeWidth="2" />
      <path d="M10 32h68" stroke="var(--border-strong)" strokeWidth="2" />
      <rect x="25" y="9" width="5" height="14" rx="2.5" fill="var(--fg-3)" />
      <rect x="58" y="9" width="5" height="14" rx="2.5" fill="var(--fg-3)" />
      <rect x="20" y="42" width="30" height="8" rx="3" fill="var(--accent)" opacity="0.85" />
      <rect x="20" y="56" width="44" height="8" rx="3" fill="var(--accent-soft)" />
    </svg>
  )
}

export function CalendarOnboarding({ onDone }: { onDone(): void }): JSX.Element {
  const { state } = useCalendarData()
  const [panel, setPanel] = useState<'feed' | OAuthCalendarProvider | null>(null)

  const finish = (): void => {
    setPrefs({ 'onboarding.calendarDoneAt': new Date().toISOString() })
    onDone()
  }

  return (
    <div className="nt-onb">
      <div className="nt-onb__head">
        <Illustration />
        <h1 className="nt-onb__title">Connect your calendar to Notula</h1>
        <ConnectBenefits />
      </div>
      <div className="nt-onb__actions">
        <button type="button" className={`n-btn${panel === 'feed' ? ' n-btn--primary' : ''}`} onClick={() => setPanel('feed')}>
          Add calendar feed
        </button>
        <button type="button" className={`n-btn${panel === 'google' ? ' n-btn--primary' : ''}`} onClick={() => setPanel('google')}>
          Connect Google
        </button>
        <button type="button" className={`n-btn${panel === 'microsoft' ? ' n-btn--primary' : ''}`} onClick={() => setPanel('microsoft')}>
          Connect Microsoft
        </button>
      </div>
      <div className="nt-onb__panel">
        {panel === 'feed' ? <AddFeedForm onAdded={finish} onCancel={() => setPanel(null)} /> : null}
        {panel === 'google' || panel === 'microsoft' ? (
          <div className="nt-provider">
            <ClientFields provider={panel} hasClient={state?.oauthClients[panel] ?? false} />
            <ConnectButton provider={panel} primary disabled={!(state?.oauthClients[panel] ?? false)} onConnected={finish} />
          </div>
        ) : null}
      </div>
      <div className="nt-onb__footer">
        <button type="button" className="n-btn n-btn--ghost" onClick={finish}>
          Skip for now
        </button>
      </div>
    </div>
  )
}
