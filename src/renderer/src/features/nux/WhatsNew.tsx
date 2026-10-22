// SPDX-License-Identifier: Apache-2.0
// "What's new": one local sidebar card after an update whose
// bundled notes have an entry. "See all" opens the notes in full; closing it dismisses the card
// as `whats-new:<version>`. No server cards, no promotions.
// And Preferences ▸ Tips: "Show tips" (`nux.enabled`) and "Reset tips".

import { useEffect, useState, type JSX } from 'react'
import type { WhatsNewEntry } from '@shared/types/nux'
import { showToast } from '../../app/toast'
import { Modal } from '../folders/Modal'
import { Group, Row, Switch } from '../settings/controls'
import { IconSparkles, IconX } from '../settings/icons'
import { usePrefs, setPrefs } from '../settings/prefs-store'
import { clearLocalDismissals, dismissTip, useNuxVersion } from './store'
import './nux.css'

export function WhatsNewCardView(): JSX.Element | null {
  useNuxVersion()
  const prefs = usePrefs()
  const [entry, setEntry] = useState<WhatsNewEntry | null>(null)
  const [open, setOpen] = useState(false)
  const dismissedMap = prefs?.['nux.dismissed']

  useEffect(() => {
    let live = true
    void window.notula.nux.getWhatsNew().then(
      (e) => live && setEntry(e),
      () => live && setEntry(null)
    )
    return () => {
      live = false
    }
  }, [dismissedMap])

  if (!entry) return null
  const id = `whats-new:${entry.version}`
  const close = (): void => {
    setOpen(false)
    setEntry(null)
    dismissTip(id)
  }

  return (
    <>
      <section className="nux-whatsnew" aria-label={entry.title}>
        <div className="nux-whatsnew__head">
          <IconSparkles size={14} className="nux-whatsnew__icon" />
          <p className="nux-whatsnew__title">{entry.title}</p>
          <button type="button" className="n-icon-btn n-icon-btn--sm nux-whatsnew__close" aria-label="Dismiss What's new" onClick={close}>
            <IconX size={12} />
          </button>
        </div>
        <ul className="nux-whatsnew__lines">
          {entry.lines.map((l) => (
            <li key={l} title={l}>
              {l}
            </li>
          ))}
        </ul>
        <button type="button" className="nux-whatsnew__more" onClick={() => setOpen(true)}>
          See all
        </button>
      </section>
      {open ? (
        <Modal label={entry.title} className="nux-modal" onClose={() => setOpen(false)}>
          <div className="h-modal__body">
            <h2 className="h-modal__title">{entry.title}</h2>
            <p className="nux-modal__version">Notula {entry.version}</p>
            <ul className="nux-modal__list">
              {entry.lines.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
            <div className="h-modal__footer">
              <button type="button" className="n-btn" onClick={() => setOpen(false)}>
                Close
              </button>
              <button type="button" className="n-btn n-btn--primary" data-autofocus onClick={close}>
                Got it
              </button>
            </div>
          </div>
        </Modal>
      ) : null}
    </>
  )
}

export function TipsPreferencesView(): JSX.Element | null {
  const prefs = usePrefs()
  const [busy, setBusy] = useState(false)
  if (!prefs) return null
  const reset = async (): Promise<void> => {
    setBusy(true)
    try {
      await window.notula.nux.reset()
      clearLocalDismissals()
      showToast({ kind: 'success', title: 'Tips reset', description: 'You’ll see each tip again where it applies.' })
    } catch {
      showToast({ kind: 'error', title: 'Couldn’t reset tips' })
    } finally {
      setBusy(false)
    }
  }
  return (
    <Group title="Tips">
      <Row label="Show tips" hint="Short one-time hints that point out features as you use Notula.">
        <Switch label="Show tips" checked={prefs['nux.enabled']} onChange={(next) => setPrefs({ 'nux.enabled': next })} />
      </Row>
      <Row label="Reset tips" hint="Show every tip again, including the ones you closed.">
        <button type="button" className="n-btn n-btn--sm" disabled={busy} onClick={() => void reset()}>
          Reset tips
        </button>
      </Row>
    </Group>
  )
}
