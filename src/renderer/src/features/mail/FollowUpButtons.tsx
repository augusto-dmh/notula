// SPDX-License-Identifier: Apache-2.0
// Send and "Save as draft" in the follow-up composer
// while the sender account holds `mail-send`. Send is scheduled in main's outbox with a 10 s Undo;
// without the grant (or in local-only mode) this renders nothing and the mailto: hand-off stays.

import { useEffect, useRef, useState, type JSX } from 'react'
import { parseError } from '@shared/errors'
import type { MailAccount } from '@shared/types/mail'
import { dismissToast, showToast } from '../../app/toast'
import { openExternal } from '../integrations/store'
import { usePrefs } from '../settings/prefs-store'
import { IconMail, providerName, SIGNATURE_NOTE, useMailAccounts } from './shared'
import './mail.css'

/** The composer saves 500 ms after typing stops; actions wait for that save. */
const SETTLE_MS = 650
const MAY_SENT = 'Notula can’t tell whether this email went out. Check your Sent folder before you send it again.'

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, SETTLE_MS))

export function FollowUpMailButtons({ draftId }: { draftId: string }): JSX.Element | null {
  const prefs = usePrefs()
  const { accounts } = useMailAccounts()
  const [picked, setPicked] = useState<string | null>(null)
  const [busy, setBusy] = useState<'draft' | 'send' | null>(null)
  const watching = useRef<string | null>(null)

  useEffect(
    () =>
      window.notula.integrations.onDelivery((d) => {
        if (d.id !== watching.current) return
        if (d.status === 'sent') {
          watching.current = null
          dismissToast(`mail-send-${draftId}`)
          showToast({ kind: 'success', title: 'Email sent' })
        } else if (d.status === 'uncertain') {
          watching.current = null
          showToast({ id: `mail-send-${draftId}`, kind: 'error', title: 'Email status unknown', description: MAY_SENT })
        } else if (d.status === 'failed') {
          watching.current = null
          showToast({ id: `mail-send-${draftId}`, kind: 'error', title: 'Email not sent', description: d.errorMessage ?? undefined })
        }
      }),
    [draftId]
  )

  if (!prefs?.['mail.enabled'] || prefs['privacy.localOnly'] || !accounts) return null
  const senders = accounts.filter((a) => a.grants.includes('mail-send') && a.state !== 'reconnect')
  if (!senders.length) return null
  const profile = prefs['profile.email']?.toLowerCase() ?? ''
  const sender: MailAccount = senders.find((a) => a.sourceId === picked) ?? senders.find((a) => a.email.toLowerCase() === profile) ?? (senders[0] as MailAccount)
  const input = { sourceId: sender.sourceId, followUpDraftId: draftId, to: [], cc: [], bcc: [], subject: '', html: '', text: '' }

  const saveDraft = async (): Promise<void> => {
    setBusy('draft')
    try {
      await settle()
      const r = await window.notula.mail.saveDraft(input)
      const url = r.webUrl
      showToast({
        kind: 'success',
        title: sender.provider === 'google' ? 'Saved to Gmail drafts' : 'Saved to Outlook drafts',
        ...(url ? { action: { label: 'Open', onClick: () => openExternal(url) } } : {})
      })
    } catch (err) {
      showToast({ kind: 'error', title: 'Couldn’t save the draft', description: parseError(err).message })
    } finally {
      setBusy(null)
    }
  }

  const send = async (): Promise<void> => {
    setBusy('send')
    try {
      await settle()
      const { deliveryId } = await window.notula.mail.send(input)
      watching.current = deliveryId
      showToast({
        id: `mail-send-${draftId}`,
        kind: 'info',
        title: 'Sending email…',
        durationMs: 10_000,
        action: {
          label: 'Undo',
          onClick: () => {
            watching.current = null
            window.notula.mail
              .cancelSend({ deliveryId })
              .then(() => showToast({ kind: 'info', title: 'Email not sent' }))
              .catch((err: unknown) => showToast({ kind: 'error', title: parseError(err).message || 'It was already sent.' }))
          }
        }
      })
    } catch (err) {
      showToast({ kind: 'error', title: 'Couldn’t send the email', description: parseError(err).message })
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="ml-fu">
      {senders.length > 1 ? (
        <select className="n-input ml-fu__from" aria-label="Send from" value={sender.sourceId} onChange={(e) => setPicked(e.target.value)}>
          {senders.map((a) => (
            <option key={a.sourceId} value={a.sourceId}>
              {a.email || providerName(a)}
            </option>
          ))}
        </select>
      ) : null}
      <button type="button" className="n-btn n-btn--sm" disabled={busy !== null} onClick={() => void saveDraft()}>
        {busy === 'draft' ? 'Saving…' : 'Save as draft'}
      </button>
      <span className="n-tooltip n-tooltip--end" data-tooltip={`${SIGNATURE_NOTE} Sends from ${sender.email || providerName(sender)}.`}>
        <button type="button" className="n-btn n-btn--sm n-btn--primary" disabled={busy !== null} onClick={() => void send()}>
          <IconMail size={14} />
          {busy === 'send' ? 'Sending…' : 'Send'}
        </button>
      </span>
    </div>
  )
}
