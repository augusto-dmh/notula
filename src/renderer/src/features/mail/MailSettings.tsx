// SPDX-License-Identifier: Apache-2.0
// Settings ▸ Integrations ▸ Email: a Gmail
// or Outlook row per connected calendar account, with the two grant switches, Connected scopes, the
// restricted-scope line for Google, and Disconnect (which keeps the calendar).

import { useState, type JSX } from 'react'
import type { CalendarGrant } from '@shared/types/calendar'
import type { MailAccount } from '@shared/types/mail'
import { navigateToSettings } from '../../app/navigation'
import { useGrantAction } from '../calendar-write/grants'
import { openExternal } from '../integrations/store'
import { Group, Row, Switch } from '../settings/controls'
import { usePrefs } from '../settings/prefs-store'
import { providerName, useMailAccounts } from './shared'
import './mail.css'

const SCOPES_HELP = 'https://developers.google.com/workspace/gmail/api/auth/scopes'

function scopeLines(a: MailAccount): string[] {
  const google = a.provider === 'google'
  const out = [google ? 'Read your Google Calendar events' : 'Read your Outlook calendar events']
  if (a.grants.includes('mail-read')) out.push(google ? 'Read your Gmail' : 'Read your Outlook email')
  if (a.grants.includes('mail-send')) out.push(google ? 'Send email from Gmail' : 'Send email from Outlook')
  return out
}

function AccountRows({ account }: { account: MailAccount }): JSX.Element {
  const { busyKey, run } = useGrantAction()
  const [confirm, setConfirm] = useState(false)
  const [busyAll, setBusyAll] = useState(false)
  const name = providerName(account)
  const google = account.provider === 'google'
  const toggle = (grant: CalendarGrant, on: boolean): void => void run(account.sourceId, grant, on)
  const disconnect = async (): Promise<void> => {
    setBusyAll(true)
    try {
      for (const g of ['mail-send', 'mail-read'] as const) {
        if (account.grants.includes(g) && !(await run(account.sourceId, g, false))) break
      }
    } finally {
      setBusyAll(false)
      setConfirm(false)
    }
  }
  const holds = account.grants.includes('mail-read') || account.grants.includes('mail-send')
  return (
    <>
      <Row
        label={`${name} · ${account.email || 'account'}`}
        hint={
          google
            ? 'Notula reads your Google Calendar through this account. Turn on mail access below to use Gmail in briefs, chat and follow-ups.'
            : 'Notula reads your Outlook calendar through this account. Turn on mail access below to use Outlook email in briefs, chat and follow-ups.'
        }
      >
        {account.state === 'reconnect' ? (
          <button type="button" className="n-btn n-btn--sm" onClick={() => navigateToSettings('calendar')}>
            Reconnect
          </button>
        ) : null}
      </Row>
      <Row label="Read mail for briefs and chat" hint={google ? 'Read your Gmail' : 'Read your Outlook email'}>
        <Switch
          checked={account.grants.includes('mail-read')}
          busy={busyKey === `${account.sourceId}:mail-read`}
          disabled={busyKey !== null || busyAll}
          label="Read mail for briefs and chat"
          onChange={(on) => toggle('mail-read', on)}
        />
      </Row>
      <Row label="Draft and send follow-up emails" hint={google ? 'Send email from Gmail' : 'Send email from Outlook'}>
        <Switch
          checked={account.grants.includes('mail-send')}
          busy={busyKey === `${account.sourceId}:mail-send`}
          disabled={busyKey !== null || busyAll}
          label="Draft and send follow-up emails"
          onChange={(on) => toggle('mail-send', on)}
        />
      </Row>
      <Row label="Connected scopes" hint="What Notula can currently do with this account:" stacked>
        <ul className="ml-scopes">
          {scopeLines(account).map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
        {google ? (
          <p className="ml-restricted">
            Google classes Gmail access as restricted: with your own OAuth client in Testing mode, add your address as a test user. Sign-ins then last 7 days.{' '}
            <button type="button" className="ml-link" onClick={() => openExternal(SCOPES_HELP)}>
              Learn more
            </button>
          </p>
        ) : null}
        {holds ? (
          confirm ? (
            <div className="ml-confirm" role="alertdialog" aria-label={google ? 'Disconnect Gmail?' : 'Disconnect Outlook email?'}>
              <strong>{google ? 'Disconnect Gmail?' : 'Disconnect Outlook email?'}</strong>
              <p>{google ? 'Notula stops reading and sending Gmail for briefs, chat and follow-ups. Your Google Calendar stays connected.' : 'Notula stops reading and sending Outlook email for briefs, chat and follow-ups. Your Outlook calendar stays connected.'}</p>
              <div className="ml-confirm__actions">
                <button type="button" className="n-btn n-btn--sm" disabled={busyAll} onClick={() => setConfirm(false)}>
                  Cancel
                </button>
                <button type="button" className="n-btn n-btn--sm n-btn--danger" disabled={busyAll} onClick={() => void disconnect()}>
                  {busyAll ? 'Connecting...' : google ? 'Disconnect Gmail' : 'Disconnect Outlook email'}
                </button>
              </div>
            </div>
          ) : (
            <button type="button" className="n-btn n-btn--sm n-btn--ghost ml-disconnect" onClick={() => setConfirm(true)}>
              {google ? 'Disconnect Gmail' : 'Disconnect Outlook email'}
            </button>
          )
        ) : null}
      </Row>
    </>
  )
}

/** Gmail and Outlook per OAuth account, while `mail.enabled` is on. */
export function MailAccountsRows(): JSX.Element | null {
  const prefs = usePrefs()
  const { accounts } = useMailAccounts()
  if (!prefs?.['mail.enabled'] || accounts === null) return null
  return (
    <Group title="Email" description="Use your email in briefs, chat and follow-ups.">
      {accounts.length === 0 ? (
        <Row label="Gmail and Outlook" hint="Connect your Google or Microsoft calendar first. Notula adds mail access to that account.">
          <button type="button" className="n-btn n-btn--sm" onClick={() => navigateToSettings('calendar')}>
            Calendar settings
          </button>
        </Row>
      ) : (
        accounts.map((a) => <AccountRows key={a.sourceId} account={a} />)
      )}
      {prefs['privacy.localOnly'] ? <Row label="Paused" hint="Email is off while Local-only mode is on." /> : <></>}
    </Group>
  )
}
