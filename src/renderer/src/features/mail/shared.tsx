// SPDX-License-Identifier: Apache-2.0
// Shared bits of the mail UI: the accounts hook, the icon and the copy.

import { useEffect, useState, type JSX } from 'react'
import type { MailAccount } from '@shared/types/mail'

export const SIGNATURE_NOTE = 'Your email signature is not added.'

export function IconMail({ size = 15 }: { size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="2" y="3.5" width="12" height="9" rx="1.8" stroke="currentColor" strokeWidth="1.3" />
      <path d="M2.6 4.6L8 8.6l5.4-4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** `mail:status`, re-read when the calendar accounts change (grants live there). */
export function useMailAccounts(): { accounts: MailAccount[] | null; reload(): void } {
  const [accounts, setAccounts] = useState<MailAccount[] | null>(null)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let alive = true
    window.notula.mail
      .status()
      .then((a) => alive && setAccounts(a))
      .catch(() => alive && setAccounts([]))
    return () => {
      alive = false
    }
  }, [tick])
  useEffect(() => window.notula.calendar.onChanged(() => setTick((t) => t + 1)), [])
  return { accounts, reload: () => setTick((t) => t + 1) }
}

export const providerName = (a: Pick<MailAccount, 'provider'>): string => (a.provider === 'google' ? 'Gmail' : 'Outlook')
