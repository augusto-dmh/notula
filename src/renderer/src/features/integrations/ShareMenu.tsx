// SPDX-License-Identifier: Apache-2.0
// The note header's Share menu: Send to Slack, Save to Notion, Save to HubSpot,
// Save to Attio, Save to Affinity and Send to Zapier, with "Saved <time>" and "Open in …"
// read from the delivery ledger. Items follow the "Copy enhanced notes" rules: a selected
// panel that is not generating and has content.

import { useEffect, useRef, useState, type JSX } from 'react'
import type { IntegrationProvider } from '@shared/types/integrations'
import type { Panel } from '@shared/types/panels'
import { navigate } from '../../app/navigation'
import { integrationSlots, useSlotsVersion } from '../../app/slots'
import { showToast } from '../../app/toast'
import { ActionMenu, type ActionMenuAnchor, type ActionMenuEntry } from '../note-page/ActionMenu'
import {
  ago,
  errorText,
  latestSent,
  openExternal,
  openShareDialog,
  panelContent,
  panelGenerating,
  panelHasContent,
  useDeliveries,
  useStatuses,
  waitForDeliveries
} from './store'

export function settingsPath(p: IntegrationProvider): string {
  return `/settings/integrations?provider=${p}`
}

function IconShare(): JSX.Element {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 15V4" />
      <path d="m7.5 8.5 4.5-4.5 4.5 4.5" />
      <path d="M5 13v5.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V13" />
    </svg>
  )
}

/** Notion saves at once: no dialog, a toast with the copied link. */
async function saveToNotion(noteId: string, panelId: string): Promise<void> {
  showToast({ id: `notion-${noteId}`, title: 'Saving to Notion...', durationMs: 60_000 })
  try {
    const got = await panelContent(noteId, panelId)
    if (!got) throw new Error('This note has no summary to save yet.')
    const { deliveryIds } = await window.notula.integrations.share({ provider: 'notion', noteId, panelId, content: got.content })
    const [d] = await waitForDeliveries(deliveryIds, noteId)
    if (d?.status !== 'sent') throw new Error(d?.errorMessage ?? 'Couldn’t save to Notion. Try again in a minute.')
    const url = d.externalUrl
    if (url) {
      await window.notula.clipboard.writeText({ text: url }).catch(() => {})
      showToast({ id: `notion-${noteId}`, kind: 'success', title: 'Saved to Notion', description: 'Page link copied to clipboard', action: { label: 'Open', onClick: () => openExternal(url) } })
    } else showToast({ id: `notion-${noteId}`, kind: 'success', title: 'Saved to Notion' })
  } catch (err) {
    showToast({ id: `notion-${noteId}`, kind: 'error', title: 'Couldn’t save to Notion. Try again in a minute.', description: errorText(err) })
  }
}

export function NoteShareMenu({ noteId, panelId }: { noteId: string; panelId: string | null }): JSX.Element | null {
  const statuses = useStatuses()
  const deliveries = useDeliveries({ noteId, limit: 50 })
  const buttonRef = useRef<HTMLButtonElement>(null)
  const [anchor, setAnchor] = useState<ActionMenuAnchor | null>(null)
  useSlotsVersion()
  const shareSlots = integrationSlots('share-item')
  const [panel, setPanel] = useState<Panel | null>(null)
  const [recentChannel, setRecentChannel] = useState<string | null>(null)
  const [hasZapierShare, setHasZapierShare] = useState(false)
  const [hasNotionTarget, setHasNotionTarget] = useState(false)

  useEffect(() => {
    if (!anchor) return
    let alive = true
    if (panelId) void window.notula.panels.list({ noteId }).then((ps) => alive && setPanel(ps.find((p) => p.id === panelId) ?? null))
    else setPanel(null)
    void Promise.all([
      window.notula.integrations.listDeliveries({ provider: 'slack', limit: 20 }),
      window.notula.integrations.listDestinations({ provider: 'slack' }),
      window.notula.integrations.listDestinations({ provider: 'zapier' }),
      window.notula.integrations.listDestinations({ provider: 'notion' })
    ])
      .then(([sent, slackDests, zaps, notion]) => {
        if (!alive) return
        const last = sent.find((d) => d.status === 'sent' && d.trigger === 'manual')
        const dest = last ? slackDests.find((x) => x.id === last.destinationId) : undefined
        setRecentChannel(dest ? dest.label : null)
        setHasZapierShare(zaps.some((z) => z.trigger === 'share' && z.status === 'ok'))
        setHasNotionTarget(notion.length > 0)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [anchor, noteId, panelId])

  if (!statuses) return null
  const configured = (p: IntegrationProvider): boolean => {
    const s = statuses[p]
    return !!s && s.state !== 'not_configured'
  }
  const blocked = Object.values(statuses).some((s) => s?.blockedByLocalOnly)
  const disabledReason = !panelId || !panel ? 'Select a summary first' : panelGenerating(panel) ? 'Wait for the summary to finish' : !panelHasContent(panel) ? 'This summary is empty' : null
  const disabled = blocked || disabledReason !== null
  const hint = blocked ? 'Off in Local-only mode' : undefined

  const close = (refocus: boolean): void => {
    setAnchor(null)
    if (refocus) buttonRef.current?.focus()
  }
  const dialog = (kind: 'slack' | 'hubspot' | 'attio' | 'affinity' | 'zapier'): void => {
    if (panelId) openShareDialog({ kind, noteId, panelId })
  }

  const entries: ActionMenuEntry[] = []
  if (configured('slack')) {
    entries.push({ kind: 'item', id: 'slack', label: 'Send to Slack', disabled, hint: hint ?? (recentChannel ? `#${recentChannel}` : undefined), onSelect: () => dialog('slack') })
  } else {
    entries.push({ kind: 'item', id: 'slack-connect', label: 'Connect Slack', onSelect: () => navigate(settingsPath('slack')) })
  }
  if (configured('notion')) {
    const sent = latestSent(deliveries, 'notion')
    if (sent?.externalUrl) {
      const url = sent.externalUrl
      entries.push({ kind: 'item', id: 'notion-open', label: 'Open in Notion', hint: `Saved ${ago(sent.sentAt)}`, onSelect: () => openExternal(url) })
      entries.push({ kind: 'item', id: 'notion-copy', label: 'Save a new copy to Notion', disabled, hint, onSelect: () => panelId && void saveToNotion(noteId, panelId) })
    } else {
      entries.push({
        kind: 'item',
        id: 'notion',
        label: 'Save to Notion',
        disabled: hasNotionTarget && disabled,
        hint,
        onSelect: () => (hasNotionTarget ? panelId && void saveToNotion(noteId, panelId) : navigate(settingsPath('notion')))
      })
    }
  }
  if (configured('hubspot')) {
    const sent = latestSent(deliveries, 'hubspot')
    entries.push({ kind: 'item', id: 'hubspot', label: 'Save to HubSpot', disabled, hint: hint ?? (sent ? `Saved ${ago(sent.sentAt)}` : undefined), onSelect: () => dialog('hubspot') })
  }
  if (configured('attio')) {
    const sent = latestSent(deliveries, 'attio')
    entries.push({ kind: 'item', id: 'attio', label: 'Save to Attio', disabled, hint: hint ?? (sent ? `Saved ${ago(sent.sentAt)}` : undefined), onSelect: () => dialog('attio') })
  }
  if (configured('affinity')) {
    const sent = latestSent(deliveries, 'affinity')
    if (sent?.externalUrl) {
      const url = sent.externalUrl
      entries.push({ kind: 'item', id: 'affinity-open', label: 'Open in Affinity', hint: `Saved ${ago(sent.sentAt)}`, onSelect: () => openExternal(url) })
    }
    entries.push({ kind: 'item', id: 'affinity', label: 'Save to Affinity', disabled, hint, onSelect: () => dialog('affinity') })
  }
  if (configured('zapier') && hasZapierShare) {
    entries.push({ kind: 'item', id: 'zapier', label: 'Send to Zapier', disabled, hint, onSelect: () => dialog('zapier') })
  }
  entries.push({ kind: 'divider', id: 'd1' })
  entries.push({ kind: 'item', id: 'settings', label: 'Integration settings…', onSelect: () => navigate('/settings/integrations') })

  return (
    <>
      <span className="n-tooltip n-tooltip--end" data-tooltip={disabledReason && !blocked ? `Share · ${disabledReason}` : 'Share'}>
        <button
          ref={buttonRef}
          type="button"
          className="n-icon-btn"
          aria-label="Share"
          aria-haspopup="menu"
          aria-expanded={anchor !== null}
          onClick={() => {
            const rect = buttonRef.current?.getBoundingClientRect()
            if (anchor) close(false)
            else if (rect) setAnchor({ rect, align: 'end' })
          }}
        >
          <IconShare />
        </button>
      </span>
      {anchor ? (
        <ActionMenu
          label="Share"
          anchor={anchor}
          entries={entries}
          owner={buttonRef.current}
          onClose={close}
          extra={
            // The plug-in providers' share items.
            shareSlots.length ? (
              <>
                {shareSlots.map(({ provider: p, component: Item }) => (
                  <Item key={p} provider={p} noteId={noteId} panelId={panelId} onDone={() => close(false)} />
                ))}
              </>
            ) : null
          }
        />
      ) : null}
    </>
  )
}
