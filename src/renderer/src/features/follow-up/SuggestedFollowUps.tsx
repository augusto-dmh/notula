// SPDX-License-Identifier: Apache-2.0
// The home section "Suggested follow-up emails":
// the first three drafts, "Show <n> more" / "Show less", "Drafting takes a couple
// minutes" while one is being written, and Dismiss with rollback.

import { useState, type JSX } from 'react'
import { parseError } from '@shared/errors'
import type { FollowUpDraft } from '@shared/types/follow-up'
import { IconClose } from '../../app/icons'
import { debugLog } from '../../app/platform'
import { showToast } from '../../app/toast'
import { usePrefs } from '../settings/prefs-store'
import { hideSuggested, refreshSuggested, setComposerNote, useSuggestedFollowUps } from './store'
import './follow-up.css'

const FIRST = 3

function preview(d: FollowUpDraft): string {
  const text = d.body
    .replace(/<placeholder[^>]*>([\s\S]*?)<\/placeholder>/gi, '$1')
    .replace(/[#>*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > 140 ? `${text.slice(0, 140)}…` : text
}

export function SuggestedFollowUps(): JSX.Element | null {
  const prefs = usePrefs()
  const drafts = useSuggestedFollowUps()
  const [all, setAll] = useState(false)
  if (prefs?.['followUpEmail.enabled'] !== true || drafts.length === 0) return null
  const generating = drafts.some((d) => d.status === 'generating')
  const shown = all ? drafts : drafts.slice(0, FIRST)

  const dismiss = (d: FollowUpDraft): void => {
    const restore = hideSuggested(d.id)
    const name = d.note_title?.trim() || 'this meeting'
    showToast({ id: 'fu-dismissed', title: `Dismissed follow-up for ${name}` })
    window.notula.followUp
      .discard({ draftId: d.id })
      .then(() => refreshSuggested())
      .catch((err: unknown) => {
        debugLog('follow-up-dismiss-failed', { err: parseError(err) })
        restore()
        showToast({ id: 'fu-dismiss-failed', kind: 'error', title: 'Couldn’t discard the email. Try again.' })
      })
  }

  return (
    <section className="fu-home" aria-label="Suggested follow-up emails">
      <h2 className="home__section-title fu-home__title">
        Suggested follow-up emails
        {generating ? <span className="fu-home__drafting">Drafting takes a minute or two</span> : null}
      </h2>
      <ul className="fu-home__list">
        {shown.map((d) => (
          <li key={d.id} className="fu-home__row">
            <button type="button" className="fu-home__open" onClick={() => setComposerNote(d.document_id)}>
              <span className="fu-home__meeting">{d.note_title?.trim() || 'Untitled meeting'}</span>
              {d.status === 'generating' ? (
                <span className="fu-home__preview fu-home__preview--muted">
                  <span className="n-spinner fu-home__spinner" aria-hidden="true" />
                  Drafting email...
                </span>
              ) : (
                <span className="fu-home__preview">
                  {d.subject ? <strong>{d.subject}</strong> : null}
                  {d.subject ? ' — ' : null}
                  {preview(d)}
                </span>
              )}
              {d.to.length ? <span className="fu-home__to">To {d.to.join(', ')}</span> : null}
            </button>
            {d.status === 'completed' ? (
              <span className="n-tooltip n-tooltip--end" data-tooltip="Dismiss follow-up">
                <button type="button" className="n-icon-btn n-icon-btn--sm fu-home__dismiss" aria-label="Dismiss follow-up" onClick={() => dismiss(d)}>
                  <IconClose size={14} />
                </button>
              </span>
            ) : null}
          </li>
        ))}
      </ul>
      {drafts.length > FIRST ? (
        <button type="button" className="n-btn n-btn--sm n-btn--ghost fu-home__more" onClick={() => setAll((a) => !a)}>
          {all ? 'Show less' : `Show ${drafts.length - FIRST} more`}
        </button>
      ) : null}
    </section>
  )
}

/** The home row's "Follow-up email suggested" icon. */
export function FollowUpSuggestedIcon(): JSX.Element {
  return (
    <span className="fu-row-icon n-tooltip" data-tooltip="Follow-up email suggested" aria-label="Follow-up email suggested" role="img">
      <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="3.5" y="5.5" width="17" height="13" rx="2.5" />
        <path d="m4.5 7.5 7.5 5.5 7.5-5.5" />
      </svg>
    </span>
  )
}
