// SPDX-License-Identifier: Apache-2.0
// `<NuxTip id/>`: a small card, or a one-line hint, where its host
// mounts it. It shows only while tips are on, it isn't dismissed, its feature applies, and no
// other tip is showing. It ends for good on the hinted action, the close button or "Got it".
//
// Per-tip rules:
// - `live-transcript`: mounted inside the transcript, so the transcript being open ends it; the
//   pointer at the toggle during a capture is NuxHost's.
// - `recipes`: ends when the recipes menu that showed it closes.
// - `demo-meeting`: only while no note exists and the demo hasn't been started.
// - `ai-setup`: only while the chosen AI provider has no key.

import { useEffect, useRef, useState, type JSX } from 'react'
import type { NuxTipId } from '@shared/types/nux'
import { navigateToSettings } from '../../app/navigation'
import type { Settings } from '@shared/types/settings'
import { IconX } from '../settings/icons'
import { usePrefs } from '../settings/prefs-store'
import { claim, dismissTip, dismissedLocally, hostMounted, release, useNuxVersion, visibleTip } from './store'
import { TIPS, tipBase } from './tips'
import './nux.css'

/** Async conditions some tips need; null while unknown. */
function useCondition(id: NuxTipId, prefs: Settings | null): boolean | null {
  const base = tipBase(id)
  const [ok, setOk] = useState<boolean | null>(base === 'demo-meeting' || base === 'ai-setup' ? null : true)
  const provider = prefs?.['llm.provider']
  useEffect(() => {
    let live = true
    if (base === 'demo-meeting') {
      window.notula.appIcon.getState().then(
        (s) => live && setOk(s.noteCount === 0),
        () => live && setOk(false)
      )
    } else if (base === 'ai-setup' && provider) {
      if (provider === 'local') setOk(false)
      else
        window.notula.llm.hasKey({ provider }).then(
          (has) => live && setOk(!has),
          () => live && setOk(false)
        )
    }
    return () => {
      live = false
    }
  }, [base, provider])
  if (base === 'demo-meeting' && prefs?.['onboarding.demoStarted'] === true) return false
  return ok
}

export function eligible(id: string, prefs: Settings | null): boolean {
  return !!prefs && hostMounted() && prefs['nux.enabled'] && !prefs['nux.dismissed'][id] && !dismissedLocally(id)
}

export function NuxTipView({ id, title, body, onAction }: { id: NuxTipId; title?: string; body?: string; onAction?(): void }): JSX.Element | null {
  useNuxVersion()
  const prefs = usePrefs()
  const base = tipBase(id)
  const condition = useCondition(id, prefs)
  const show = eligible(id, prefs) && condition === true
  const host = hostMounted()

  // The transcript is open: that is the hinted action.
  useEffect(() => {
    if (base === 'live-transcript' && host && prefs && !prefs['nux.dismissed'][id] && !dismissedLocally(id)) dismissTip(id)
  }, [base, host, id, prefs])

  useEffect(() => {
    if (!show || base === 'live-transcript') return
    claim(id)
    return () => release(id)
  }, [show, id, base])

  const visible = show && visibleTip() === id
  const shown = useRef(false)
  if (visible) shown.current = true
  // The recipes tip ends when the menu that showed it closes.
  useEffect(
    () => () => {
      if (base === 'recipes' && shown.current) dismissTip(id)
    },
    [base, id]
  )

  if (!visible || base === 'live-transcript') return null
  const copy = TIPS[base]
  const heading = title ?? copy.title
  const text = body ?? copy.body
  const act = (): void => {
    dismissTip(id)
    if (onAction) onAction()
    else if (base === 'ai-setup') navigateToSettings('ai')
  }

  if (copy.compact) {
    return (
      <div className="nux-hint" role="note">
        <span>{heading}</span>
        <button type="button" className="nux-hint__close" aria-label="Dismiss tip" onClick={() => dismissTip(id)}>
          <IconX size={12} />
        </button>
      </div>
    )
  }

  return (
    <div className="nux-tip" role="note" aria-label={heading}>
      <div className="nux-tip__text">
        <p className="nux-tip__title">{heading}</p>
        {text ? <p className="nux-tip__body">{text}</p> : null}
      </div>
      <div className="nux-tip__actions">
        {copy.action && (onAction || base === 'ai-setup') ? (
          <button type="button" className="n-btn n-btn--sm n-btn--primary" onClick={act}>
            {copy.action}
          </button>
        ) : null}
        <button type="button" className="n-btn n-btn--sm n-btn--ghost" onClick={() => dismissTip(id)}>
          Got it
        </button>
      </div>
      <button type="button" className="nux-tip__close n-icon-btn n-icon-btn--sm" aria-label="Dismiss tip" onClick={() => dismissTip(id)}>
        <IconX size={14} />
      </button>
    </div>
  )
}
