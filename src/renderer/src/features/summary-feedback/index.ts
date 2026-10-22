// SPDX-License-Identifier: Apache-2.0
// Summary ratings: the note-page banner, "Rate these
// notes" in the panel menu (null unless `summaryFeedback.enabled`) and the template editor's
// "Your feedback" section.

import { createElement, type JSX } from 'react'
import { IconPencil } from '../../app/icons'
import { usePrefs } from '../settings/prefs-store'
import { openRating, SummaryFeedbackBannerView } from './Banner'
import { TemplateFeedbackSectionView } from './TemplateFeedback'
import './summary-feedback.css'

export function SummaryFeedbackBanner(p: { noteId: string; chatIdle: boolean }): JSX.Element | null {
  return createElement(SummaryFeedbackBannerView, p)
}

export function RateTheseNotesMenuItem({ panelId }: { panelId: string }): JSX.Element | null {
  const prefs = usePrefs()
  if (prefs?.['summaryFeedback.enabled'] !== true) return null
  return createElement(
    'button',
    {
      type: 'button',
      role: 'menuitem',
      className: 'enh-menu__item',
      onClick: (e: { currentTarget: HTMLElement }) => {
        // The host menu closes on Escape; this item has no other handle on it.
        e.currentTarget.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
        openRating(panelId)
      }
    },
    createElement(IconPencil, { size: 15 }),
    createElement('span', { className: 'enh-menu__text' }, 'Rate these notes')
  )
}

export function TemplateFeedbackSection({ templateSlug }: { templateSlug: string }): JSX.Element | null {
  return createElement(TemplateFeedbackSectionView, { templateSlug })
}
