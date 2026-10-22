// SPDX-License-Identifier: Apache-2.0
// Held integration sends: sends that came due while Nothing leaves this
// machine was on wait here, in Settings ▸ Integrations, until the user sends or discards each one.

import { useCallback, useEffect, useState, type JSX } from 'react'
import type { IntegrationDelivery } from '@shared/types/integrations'
import { SettingsCard } from '../settings/primitives'
import { refreshLocalOnly, useLocalOnly } from './store'
import './local-only.css'

const PROVIDER_LABEL: Record<string, string> = {
  slack: 'Slack',
  notion: 'Notion',
  hubspot: 'HubSpot',
  attio: 'Attio',
  affinity: 'Affinity',
  zapier: 'Zapier',
  salesforce: 'Salesforce',
  pipedrive: 'Pipedrive',
  ashby: 'Ashby',
  webhook: 'Webhook'
}

export function HeldSendsReview(): JSX.Element | null {
  const status = useLocalOnly()
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<IntegrationDelivery[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const count = status?.heldSends ?? 0

  const load = useCallback(() => {
    void window.notula.privacy
      .listHeldSends()
      .then(setItems)
      .catch(() => setItems([]))
  }, [])

  useEffect(() => {
    if (open) load()
  }, [open, count, load])

  if (!status || (count === 0 && items.length === 0)) return null

  const act = (id: string, action: 'send' | 'discard'): void => {
    setBusy(id)
    setError(null)
    void window.notula.privacy
      .releaseHeldSend({ deliveryId: id, action })
      .then(() => {
        setItems((xs) => xs.filter((x) => x.id !== id))
        refreshLocalOnly()
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message.replace(/^[a-z-]+: /, '') : 'That send could not be changed.'))
      .finally(() => setBusy(null))
  }

  const n = open ? items.length : count
  return (
    <SettingsCard>
      <div className="held">
        <div className="held__head">
          <div>
            <div className="settings-row__label">
              {n} {n === 1 ? 'send was' : 'sends were'} held while Nothing leaves this machine was on
            </div>
            <div className="settings-row__hint">Nothing goes out until you send it.</div>
          </div>
          <button type="button" className="n-btn n-btn--sm" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            {open ? 'Hide' : 'Review'}
          </button>
        </div>
        {open ? (
          <ul className="held__list">
            {items.map((d) => (
              <li key={d.id} className="held__item">
                <div className="held__what">
                  <span className="held__note">{d.noteTitle || 'Untitled note'}</span>
                  <span className="held__to">
                    to {PROVIDER_LABEL[d.provider] ?? d.provider}
                    {d.trigger === 'folder' ? ' · automatic' : ''}
                  </span>
                </div>
                <div className="held__actions">
                  <button type="button" className="n-btn n-btn--sm n-btn--ghost" disabled={busy === d.id} onClick={() => act(d.id, 'discard')}>
                    Discard
                  </button>
                  <button
                    type="button"
                    className="n-btn n-btn--sm n-btn--primary"
                    disabled={busy === d.id || status.enabled}
                    title={status.enabled ? 'Off while Nothing leaves this machine is on.' : undefined}
                    onClick={() => act(d.id, 'send')}
                  >
                    Send
                  </button>
                </div>
              </li>
            ))}
          </ul>
        ) : null}
        {error ? (
          <p className="lo-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </SettingsCard>
  )
}
