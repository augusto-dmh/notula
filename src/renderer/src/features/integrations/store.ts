// SPDX-License-Identifier: Apache-2.0
// Integrations renderer state: statuses, deliveries, the open dialog, and
// the selected panel's content. Everything provider-side happens in main; the renderer
// only ever sees masked credentials and delivery rows without content.

import { useEffect, useState, useSyncExternalStore } from 'react'
import { parseError } from '@shared/errors'
import type {
  IntegrationDelivery,
  IntegrationProvider,
  IntegrationShareContent,
  IntegrationStatus
} from '@shared/types/integrations'
import type { Panel } from '@shared/types/panels'
import { copyFlavors, readRoomHtml, roomIdFor } from '../../editor'

export const PROVIDER_ORDER: readonly IntegrationProvider[] = ['slack', 'notion', 'hubspot', 'attio', 'affinity', 'zapier']

export const PROVIDER_META: Record<IntegrationProvider, { name: string; title: string; description: string }> = {
  slack: { name: 'Slack', title: 'Slack', description: 'Post notes to Slack channels' },
  notion: { name: 'Notion', title: 'Notion', description: 'Save notes as Notion pages' },
  hubspot: { name: 'HubSpot', title: 'Hubspot', description: 'Add meeting notes to HubSpot records' },
  attio: { name: 'Attio', title: 'Attio', description: 'Attach meeting notes to Attio people and companies' },
  affinity: { name: 'Affinity', title: 'Affinity', description: 'Add meeting notes to people and organizations' },
  zapier: { name: 'Zapier', title: 'Zapier', description: 'Run Zaps from Notula to send notes to the other apps you use.' },
  // Served by the plug-in providers; their settings cards come from app/slots.ts
  salesforce: { name: 'Salesforce', title: 'Salesforce', description: 'Save meetings to Salesforce.' },
  pipedrive: { name: 'Pipedrive', title: 'Pipedrive', description: 'Save meetings to Pipedrive deals.' },
  ashby: { name: 'Ashby', title: 'Ashby', description: 'Save interviews to Ashby candidates.' },
  dropbox: { name: 'Dropbox', title: 'Dropbox', description: 'Read files from Dropbox in chat.' },
  webhook: { name: 'Webhooks', title: 'Webhooks', description: 'Send notes to your own URLs, signed.' },
  gmail: { name: 'Gmail', title: 'Gmail', description: 'Send follow-up emails from your Gmail account.' },
  outlook: { name: 'Outlook', title: 'Outlook', description: 'Send follow-up emails from your Outlook account.' }
}

export const LOCAL_ONLY_COPY = 'Integrations are off while Local-only mode is on.'
export const AUTOMATIONS_COPY = 'Automations run while Notula is open. Anything missed is sent the next time you open Notula.'

export function errorText(err: unknown): string {
  return parseError(err).message || 'Something went wrong. Try again.'
}

// ---------- statuses ----------

let statuses: Partial<Record<IntegrationProvider, IntegrationStatus>> = {}
let statusSnapshot: Partial<Record<IntegrationProvider, IntegrationStatus>> | null = null
const statusListeners = new Set<() => void>()
let started = false

function emitStatuses(): void {
  statusSnapshot = { ...statuses }
  for (const l of statusListeners) l()
}

export async function refreshStatus(provider?: IntegrationProvider): Promise<void> {
  try {
    const list = await window.notula.integrations.status(provider ? { provider } : {})
    for (const s of list) statuses[s.provider] = s
    emitStatuses()
  } catch {
    // Storage not ready yet: the next push or page open retries.
  }
}

// ---------- deliveries ----------

const deliveryListeners = new Set<(d: IntegrationDelivery) => void>()

function start(): void {
  if (started) return
  started = true
  void refreshStatus()
  window.notula.integrations.onChanged(({ provider }) => void refreshStatus(provider))
  window.notula.integrations.onDelivery((d) => {
    for (const l of deliveryListeners) l(d)
  })
}

export function useStatuses(): Partial<Record<IntegrationProvider, IntegrationStatus>> | null {
  start()
  return useSyncExternalStore(
    (cb) => {
      statusListeners.add(cb)
      return () => statusListeners.delete(cb)
    },
    () => statusSnapshot
  )
}

export function onDelivery(cb: (d: IntegrationDelivery) => void): () => void {
  start()
  deliveryListeners.add(cb)
  return () => deliveryListeners.delete(cb)
}

/** A note's (or a provider's) recent deliveries, kept current by pushes. */
export function useDeliveries(q: { noteId?: string; provider?: IntegrationProvider; limit?: number }): IntegrationDelivery[] | null {
  const [rows, setRows] = useState<IntegrationDelivery[] | null>(null)
  const { noteId, provider, limit = 20 } = q
  useEffect(() => {
    let alive = true
    const load = (): void => {
      window.notula.integrations
        .listDeliveries({ ...(noteId ? { noteId } : {}), ...(provider ? { provider } : {}), limit })
        .then((r) => alive && setRows(r))
        .catch(() => alive && setRows([]))
    }
    load()
    const off = onDelivery((d) => {
      if ((noteId && d.noteId !== noteId) || (provider && d.provider !== provider)) return
      setRows((prev) => {
        const list = prev ?? []
        const i = list.findIndex((x) => x.id === d.id)
        const next = i >= 0 ? list.map((x) => (x.id === d.id ? d : x)) : [d, ...list]
        return next.slice(0, limit)
      })
    })
    return () => {
      alive = false
      off()
    }
  }, [noteId, provider, limit])
  return rows
}

const TERMINAL = new Set<IntegrationDelivery['status']>(['sent', 'failed', 'uncertain', 'cancelled'])

/** Resolves with the rows once each has finished (sent, failed, uncertain or cancelled). */
export function waitForDeliveries(ids: string[], noteId: string): Promise<IntegrationDelivery[]> {
  return new Promise((resolve) => {
    const got = new Map<string, IntegrationDelivery>()
    const check = (): boolean => {
      if (ids.every((id) => got.has(id) && TERMINAL.has(got.get(id)!.status))) {
        off()
        resolve(ids.map((id) => got.get(id)!))
        return true
      }
      return false
    }
    const off = onDelivery((d) => {
      if (ids.includes(d.id)) {
        got.set(d.id, d)
        check()
      }
    })
    void window.notula.integrations.listDeliveries({ noteId, limit: 100 }).then((rows) => {
      for (const r of rows) if (ids.includes(r.id) && !got.has(r.id)) got.set(r.id, r)
      check()
    })
  })
}

export function latestSent(rows: IntegrationDelivery[] | null, provider: IntegrationProvider): IntegrationDelivery | null {
  return (rows ?? []).filter((d) => d.provider === provider && d.status === 'sent' && d.trigger !== 'test').sort((a, b) => String(b.sentAt).localeCompare(String(a.sentAt)))[0] ?? null
}

// ---------- the open dialog ----------

export type DialogKind = 'slack' | 'hubspot' | 'attio' | 'affinity' | 'zapier'
export interface OpenDialog {
  kind: DialogKind
  noteId: string
  panelId: string
}

let dialog: OpenDialog | null = null
const dialogListeners = new Set<() => void>()

export function openShareDialog(d: OpenDialog): void {
  dialog = d
  for (const l of dialogListeners) l()
}

export function closeShareDialog(): void {
  dialog = null
  for (const l of dialogListeners) l()
}

export function useShareDialog(): OpenDialog | null {
  return useSyncExternalStore(
    (cb) => {
      dialogListeners.add(cb)
      return () => dialogListeners.delete(cb)
    },
    () => dialog
  )
}

// ---------- folder panel focus ----------

let focusFolder: string | null = null
const folderListeners = new Set<() => void>()

export function requestFolderPanel(folderId: string): void {
  focusFolder = folderId
  for (const l of folderListeners) l()
}

export function useFolderPanelRequest(): string | null {
  return useSyncExternalStore(
    (cb) => {
      folderListeners.add(cb)
      return () => folderListeners.delete(cb)
    },
    () => focusFolder
  )
}

// ---------- the selected panel ----------

export function panelGenerating(p: Panel): boolean {
  return p.enhance_started_at !== null && p.content_edited_at === null && p.enhance_failed_at === null
}

export function panelHasContent(p: Panel | null | undefined): boolean {
  return !!p && !p.deleted_at && p.content_edited_at !== null && (p.content_markdown ?? p.generated_content ?? '').trim() !== ''
}

function htmlToText(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  for (const el of doc.body.querySelectorAll('p, li, h1, h2, h3, h4, h5, h6, blockquote, pre, br')) {
    el.append(doc.createTextNode('\n'))
  }
  for (const li of doc.body.querySelectorAll('li')) li.prepend(doc.createTextNode('- '))
  return (doc.body.textContent ?? '').replace(/\n{3,}/g, '\n\n').trim()
}

/** The selected panel as the user sees it: HTML from its room, markdown from its projection. */
export async function panelContent(noteId: string, panelId: string): Promise<{ panel: Panel; content: IntegrationShareContent } | null> {
  const panels = await window.notula.panels.list({ noteId })
  const panel = panels.find((p) => p.id === panelId && !p.deleted_at)
  if (!panel) return null
  const stored = panel.content_markdown ?? panel.generated_content ?? ''
  const seed = { ...(panel.content ? { json: panel.content } : {}), ...(stored ? { markdown: stored } : {}) }
  const html = await readRoomHtml(roomIdFor('summary', panel.id), 'panel', seed)
  const markdown = stored.trim() ? stored : copyFlavors(html, null).text
  return { panel, content: { html, markdown, text: htmlToText(html) } }
}

// ---------- formatting ----------

export function ago(iso: string | null): string {
  if (!iso) return ''
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000)
  if (s < 45) return 'just now'
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`
  if (s < 172_800) return 'yesterday'
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

export function isMac(): boolean {
  return navigator.userAgent.includes('Mac')
}

export function openExternal(url: string): void {
  if (/^https:\/\//.test(url)) window.open(url, '_blank', 'noopener,noreferrer')
}
