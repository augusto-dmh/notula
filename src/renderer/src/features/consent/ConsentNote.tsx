// SPDX-License-Identifier: Apache-2.0
// The notice on the note page: the header's status line with
// Copy notice, Mark as posted and Post again, and the "Waiting to post your notice…" banner.

import { useState, type JSX } from 'react'
import type { ConsentChannel, ConsentReason, ConsentStatus } from '@shared/types/consent'
import { showToast } from '../../app/toast'
import { usePrefs } from '../settings/prefs-store'
import { errorText, useConsentStatus } from './store'
import './consent.css'

const APP: Record<ConsentChannel, string> = { zoom: 'Zoom', teams: 'Microsoft Teams', meet: 'Google Meet' }

const REASON: Record<ConsentReason, string> = {
  'composer-missing': "Notula couldn't find the chat.",
  'composer-not-empty': 'The chat had a draft in it.',
  'composer-partial-text': "The notice didn't paste cleanly.",
  'composer-unreadable': "Notula couldn't read the chat.",
  'several-meeting-windows': 'More than one meeting app is open.',
  'foreground-lost': 'Another window came to the front.',
  timeout: 'It took too long.',
  'helper-unavailable': "Automatic posting isn't available on this computer."
}

function line(s: ConsentStatus): string | null {
  const where = s.channel ? `${APP[s.channel]} chat` : 'meeting chat'
  if (s.waitingFor === 'other-speaker') return 'Notice will be posted after someone else speaks'
  if (s.waitingFor === 'chat-field') return `Open the ${s.channel ? APP[s.channel] : 'meeting'} chat to post your notice`
  if (s.waitingFor === 'draft') return 'Waiting for your chat draft to be sent'
  switch (s.status) {
    case 'attempted':
      return `Posting notice in ${where}…`
    case 'success':
      return `Notice posted in ${where}`
    case 'confirmed':
      return 'Notice posted'
    case 'copied':
      return 'Notice copied'
    case 'cancelled':
      return 'Notice not posted'
    case 'failure':
    case 'unavailable':
      return `Notice not posted${s.reason ? `. ${REASON[s.reason]}` : ''}`
    default:
      return null
  }
}

function useAct(): [boolean, (label: string, run: () => Promise<unknown>) => void] {
  const [busy, setBusy] = useState(false)
  const act = (label: string, run: () => Promise<unknown>): void => {
    setBusy(true)
    run()
      .catch((err: unknown) => showToast({ title: errorText(err, `${label} didn't work.`), kind: 'error' }))
      .finally(() => setBusy(false))
  }
  return [busy, act]
}

export function ConsentNoteStatus({ noteId }: { noteId: string }): JSX.Element | null {
  const prefs = usePrefs()
  const s = useConsentStatus(noteId)
  const [busy, act] = useAct()
  if (prefs?.['consent.enabled'] !== true || !s || s.pending) return null
  const text = line(s)
  if (!text) return null
  const done = s.status === 'success' || s.status === 'confirmed'
  const running = s.status === 'attempted' && !s.reason
  return (
    <div className={`consent-status${done ? ' is-done' : ''}`} role="status">
      <span className="consent-status__dot" aria-hidden="true" />
      <span className="consent-status__text">{text}</span>
      {!done ? (
        <span className="consent-status__actions">
          <button
            type="button"
            className="consent-link"
            disabled={busy}
            onClick={() => act('Copy notice', () => window.notula.consent.copyMessage({ noteId }).then(() => showToast({ title: 'Notice copied' })))}
          >
            Copy notice
          </button>
          <button type="button" className="consent-link" disabled={busy} onClick={() => act('Mark as posted', () => window.notula.consent.markPosted({ noteId }))}>
            Mark as posted
          </button>
          {!running && s.status !== null ? (
            <button type="button" className="consent-link" disabled={busy} onClick={() => act('Post again', () => window.notula.consent.postNow({ noteId }))}>
              Post again
            </button>
          ) : null}
        </span>
      ) : null}
    </div>
  )
}

export function ConsentPendingBanner({ noteId }: { noteId: string }): JSX.Element | null {
  const s = useConsentStatus(noteId)
  const [busy, act] = useAct()
  if (!s?.pending) return null
  let why: string | null = null
  if (s.status === 'failure' || s.status === 'unavailable') why = `The notice wasn't posted${s.reason ? `: ${REASON[s.reason].replace(/\.$/, '').toLowerCase()}` : ''}. Paste it yourself, then start.`
  else if (s.status === 'copied') why = 'The notice is copied. Paste it in the chat, then mark it as posted.'
  else if (s.waitingFor === 'chat-field') why = `Open the ${s.channel ? APP[s.channel] : 'meeting'} chat so Notula can post it.`
  else if (s.waitingFor === 'draft') why = 'Your chat has a draft. Notula posts once it is sent.'
  return (
    <div className="consent-banner" role="status">
      <span className="n-spinner consent-banner__spin" aria-hidden="true" />
      <div className="consent-banner__text">
        <strong>Waiting to post your notice…</strong>
        {why ? <span>{why}</span> : <span>Transcription starts once it's posted.</span>}
      </div>
      <div className="consent-banner__actions">
        {s.status === 'copied' || s.status === 'failure' || s.status === 'unavailable' ? (
          <button type="button" className="n-btn n-btn--sm n-btn--ghost" disabled={busy} onClick={() => act('Mark as posted', () => window.notula.consent.markPosted({ noteId }))}>
            Mark as posted
          </button>
        ) : null}
        <button
          type="button"
          className="n-btn n-btn--sm n-btn--ghost"
          disabled={busy}
          onClick={() => act('Cancel', () => window.notula.consent.resolvePending({ noteId, action: 'cancel' }))}
        >
          Cancel
        </button>
        <button
          type="button"
          className="n-btn n-btn--sm n-btn--primary"
          disabled={busy}
          onClick={() => act('Start now', () => window.notula.consent.resolvePending({ noteId, action: 'start-now' }))}
        >
          Start now
        </button>
      </div>
    </div>
  )
}
