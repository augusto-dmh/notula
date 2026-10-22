// SPDX-License-Identifier: Apache-2.0
// The folder's integrations panel: Auto-post to Slack, Auto-run workflows (Zapier) and Auto-sync
// to Attio. Rules run locally once per note; the panel says so.

import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import type { AttioObjectType, IntegrationAutomation, IntegrationDelivery, IntegrationDestination } from '@shared/types/integrations'
import { navigate } from '../../app/navigation'
import { integrationSlots, useSlotsVersion } from '../../app/slots'
import { showToast } from '../../app/toast'
import { Group, Row, Switch } from '../settings/controls'
import { setPrefs, usePrefs } from '../settings/prefs-store'
import { settingsPath } from './ShareMenu'
import { AUTOMATIONS_COPY, errorText, LOCAL_ONLY_COPY, onDelivery, useFolderPanelRequest, useStatuses } from './store'
import './integrations.css'

interface ChannelChoice {
  id: string
  label: string
  /** Bot mode: the channel id; webhook mode: the destination id. */
  channelId?: string
  destinationId?: string
}

function useAutomations(folderId: string): [IntegrationAutomation[] | null, () => void] {
  const [rows, setRows] = useState<IntegrationAutomation[] | null>(null)
  const load = useCallback(() => {
    void window.notula.integrations
      .listAutomations({ folderId })
      .then(setRows)
      .catch(() => setRows([]))
  }, [folderId])
  useEffect(() => {
    load()
    const off = window.notula.integrations.onChanged(() => load())
    return off
  }, [load])
  return [rows, load]
}

function SlackRow({ folderId, automations, reload }: { folderId: string; automations: IntegrationAutomation[]; reload(): void }): JSX.Element {
  const prefs = usePrefs()
  const mode = prefs?.['integrations.slack.mode'] ?? 'bot'
  const [dests, setDests] = useState<IntegrationDestination[]>([])
  const [choices, setChoices] = useState<ChannelChoice[] | null>(null)
  const [picking, setPicking] = useState(false)
  const [filter, setFilter] = useState('')
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState<IntegrationDelivery | null>(null)
  const bound = automations.find((a) => a.provider === 'slack' && a.enabled)
  const boundDest = bound ? dests.find((d) => d.id === bound.destinationId) : undefined

  useEffect(() => {
    void window.notula.integrations.listDestinations({ provider: 'slack' }).then(setDests)
  }, [automations])

  // "Last post failed" from the newest folder delivery of this rule.
  useEffect(() => {
    if (!bound) return setFailed(null)
    const load = (): void =>
      void window.notula.integrations.listDeliveries({ provider: 'slack', limit: 50 }).then((rows) => {
        const last = rows.find((r) => r.automationId === bound.id)
        setFailed(last && (last.status === 'failed' || last.status === 'uncertain') ? last : null)
      })
    load()
    return onDelivery((d) => d.automationId === bound.id && load())
  }, [bound])

  useEffect(() => {
    if (!picking) return
    if (mode === 'webhook') {
      setChoices(dests.filter((d) => d.kind === 'slack-webhook' && d.status === 'ok').map((d) => ({ id: d.id, label: d.label, destinationId: d.id })))
      return
    }
    setChoices(null)
    window.notula.integrations
      .search({ provider: 'slack', kinds: ['channel'] })
      .then((r) => setChoices(r.map((c) => ({ id: c.id, label: c.label, channelId: c.id }))))
      .catch((err) => {
        setChoices([])
        showToast({ kind: 'error', title: errorText(err) })
      })
  }, [picking, mode, dests])

  const choose = async (c: ChannelChoice): Promise<void> => {
    setBusy(true)
    try {
      const destinationId = c.destinationId ?? (await window.notula.integrations.saveDestination({ provider: 'slack', kind: 'slack-channel', label: c.label, externalId: c.channelId })).id
      await window.notula.integrations.setAutomation({ folderId, provider: 'slack', destinationId, enabled: true })
      showToast({ kind: 'success', title: 'Connected to Slack channel' })
      setPicking(false)
      reload()
    } catch {
      showToast({ kind: 'error', title: 'Couldn’t link the Slack channel. Try again.' })
    } finally {
      setBusy(false)
    }
  }
  const unbind = async (): Promise<void> => {
    if (!bound) return
    setBusy(true)
    try {
      await window.notula.integrations.setAutomation({ folderId, provider: 'slack', destinationId: bound.destinationId, enabled: false })
      showToast({ title: 'Disconnected from Slack channel' })
      reload()
    } catch {
      showToast({ kind: 'error', title: 'Couldn’t disconnect the Slack channel', description: 'Notula may keep posting new notes there. Try again.' })
    } finally {
      setBusy(false)
    }
  }

  const shown = (choices ?? []).filter((c) => !filter.trim() || c.label.toLowerCase().includes(filter.trim().toLowerCase()))
  return (
    <>
      <Row
        label="Auto-post to Slack"
        hint={failed ? `Last post failed: ${failed.errorMessage ?? 'Couldn’t send to Slack.'}` : bound ? 'Notula posts each note filed in this folder to the channel.' : 'Pick a channel to post each note filed in this folder.'}
      >
        <div className="int-row-actions">
          {failed ? (
            <button type="button" className="n-btn n-btn--sm" onClick={() => void window.notula.integrations.retryDelivery({ deliveryId: failed.id }).catch((err) => showToast({ kind: 'error', title: errorText(err) }))}>
              Retry
            </button>
          ) : null}
          {bound ? (
            <button type="button" className="n-btn n-btn--sm" disabled={busy} onClick={() => void unbind()} title="Stop posting to this channel">
              {busy ? 'Disconnecting channel...' : `#${boundDest?.label ?? 'channel'}`}
            </button>
          ) : (
            <button type="button" className="n-btn n-btn--sm" disabled={busy} onClick={() => setPicking((v) => !v)}>
              Choose a channel
            </button>
          )}
        </div>
      </Row>
      {picking && !bound ? (
        <Row stacked label="Channel">
          <input className="n-input int-input" placeholder="Choose a channel" aria-label="Search channels" value={filter} onChange={(e) => setFilter(e.target.value)} autoFocus />
          <div className="int-list int-list--rows">
            {choices === null ? <div className="int-empty">Loading channels…</div> : null}
            {choices && !shown.length ? <div className="int-empty">No channels found.</div> : null}
            {shown.map((c) => (
              <button key={c.id} type="button" className="int-option" disabled={busy} onClick={() => void choose(c)}>
                <span className="int-option__icon">#</span>
                {c.label}
              </button>
            ))}
          </div>
        </Row>
      ) : null}
    </>
  )
}

function ZapierRows({ folderId, automations, reload }: { folderId: string; automations: IntegrationAutomation[]; reload(): void }): JSX.Element {
  const prefs = usePrefs()
  const runIds = prefs?.['integrations.zapier.folderRunIds'] ?? []
  const master = runIds.includes(folderId)
  const [workflows, setWorkflows] = useState<IntegrationDestination[]>([])
  useEffect(() => {
    void window.notula.integrations.listDestinations({ provider: 'zapier' }).then((d) => setWorkflows(d.filter((w) => w.trigger === 'folder')))
  }, [automations])
  const setMaster = (on: boolean): void => {
    try {
      setPrefs({ 'integrations.zapier.folderRunIds': on ? [...new Set([...runIds, folderId])] : runIds.filter((x) => x !== folderId) })
    } catch {
      showToast({ kind: 'error', title: 'Couldn’t update Zapier for this folder. Try again.' })
    }
  }
  const setRule = (w: IntegrationDestination, on: boolean): void => {
    window.notula.integrations
      .setAutomation({ folderId, provider: 'zapier', destinationId: w.id, enabled: on })
      .then(reload)
      .catch(() => showToast({ kind: 'error', title: 'Couldn’t update Zapier settings' }))
  }
  return (
    <>
      <Row label="Run workflows" hint="Zapier runs them each time a note is filed in this folder.">
        <Switch label="Run workflows" checked={master} onChange={setMaster} />
      </Row>
      {master
        ? workflows.length
          ? workflows.map((w) => (
              <Row key={w.id} label={w.label} hint={w.status === 'disconnected' ? 'Zapier stopped accepting this hook. Turn the Zap back on, or edit the workflow with a new hook URL.' : 'Runs for each note filed in this folder'}>
                <Switch label={w.label} checked={automations.some((a) => a.provider === 'zapier' && a.destinationId === w.id && a.enabled)} onChange={(v) => setRule(w, v)} />
              </Row>
            ))
          : (
              <Row label="No folder workflows yet" hint="Set up a Zap in Settings that runs when notes join a folder.">
                <button type="button" className="n-btn n-btn--sm" onClick={() => navigate(settingsPath('zapier'))}>
                  Settings
                </button>
              </Row>
            )
        : null}
    </>
  )
}

const ATTIO_TYPES: { type: AttioObjectType; label: string; hint: string }[] = [
  { type: 'companies', label: 'Companies', hint: 'Link the note to the companies of the people you met' },
  { type: 'people', label: 'People', hint: 'Link the note to each attendee’s person record' },
  { type: 'deals', label: 'Deals', hint: 'Link the note to deals tied to the meeting’s companies' }
]

function AttioRows({ folderId, automations, reload }: { folderId: string; automations: IntegrationAutomation[]; reload(): void }): JSX.Element {
  const rule = automations.find((a) => a.provider === 'attio')
  const types = rule?.enabled ? rule.options.objectTypes ?? [] : []
  const on = types.length > 0
  const write = (next: AttioObjectType[]): void => {
    window.notula.integrations
      .setAutomation({ folderId, provider: 'attio', options: { objectTypes: next }, enabled: next.length > 0 })
      .then(reload)
      .catch(() => showToast({ kind: 'error', title: 'Couldn’t update Attio settings' }))
  }
  return (
    <>
      <Row label="Auto-sync to Attio" hint="Notula saves each note filed in this folder to Attio.">
        {/* Turning it on enables Companies; off disables every type (step 16). */}
        <Switch label="Auto-sync to Attio" checked={on} onChange={(v) => write(v ? ['companies'] : [])} />
      </Row>
      {on
        ? ATTIO_TYPES.map((t) => (
            <Row key={t.type} label={t.label} hint={t.hint}>
              <Switch label={t.label} checked={types.includes(t.type)} onChange={(v) => write(v ? [...types, t.type] : types.filter((x) => x !== t.type))} />
            </Row>
          ))
        : null}
    </>
  )
}

export function FolderIntegrationsPanel({ folderId }: { folderId: string }): JSX.Element | null {
  const statuses = useStatuses()
  useSlotsVersion()
  const [automations, reload] = useAutomations(folderId)
  const requested = useFolderPanelRequest()
  const ref = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (requested === folderId) {
      setOpen(true)
      requestAnimationFrame(() => ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
    }
  }, [requested, folderId])

  if (!statuses || !automations) return null
  const has = (p: 'slack' | 'zapier' | 'attio'): boolean => !!statuses[p] && statuses[p]?.state !== 'not_configured'
  const any = has('slack') || has('zapier') || has('attio')
  const active = automations.some((a) => a.enabled)
  // Quiet by default: the folder menu's "Integrations" opens it; active rules keep it shown.
  if (!active && !open) return null
  const blocked = Object.values(statuses).some((s) => s?.blockedByLocalOnly)

  return (
    <div ref={ref} className="int-folder">
      <Group title="Connect other tools" description={active || open || any ? 'Send notes added to this folder to other apps automatically.' : undefined}>
        {blocked ? <Row label={LOCAL_ONLY_COPY} /> : null}
        {has('slack') ? <SlackRow folderId={folderId} automations={automations} reload={reload} /> : null}
        {has('zapier') ? <ZapierRows folderId={folderId} automations={automations} reload={reload} /> : null}
        {has('attio') ? <AttioRows folderId={folderId} automations={automations} reload={reload} /> : null}
        {/* The plug-in providers' folder rows. */}
        {integrationSlots('folder-row').map(({ provider: p, component: FolderRow }) => (
          <FolderRow key={p} provider={p} folderId={folderId} />
        ))}
        {!any ? (
          <Row label="Auto-post to Slack, run Zapier workflows or sync to Attio" hint="Connect one of them in Settings first.">
            <button type="button" className="n-btn n-btn--sm" onClick={() => navigate('/settings/integrations')}>
              Settings
            </button>
          </Row>
        ) : null}
        <Row label={<span className="int-small">{AUTOMATIONS_COPY}</span>} />
      </Group>
    </div>
  )
}
