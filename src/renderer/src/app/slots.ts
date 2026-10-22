// SPDX-License-Identifier: Apache-2.0
// Renderer slot registries.
//
// - Tool cards: the draft-block feature registers a card per chat tool name (`proposeEvent`,
//   `draftFollowUpEmail`, `readDriveDoc`, the connector actions); chat's Conversation renders
//   the registered card for a tool call and its default card otherwise.
// - Integration slots: the extra integrations register settings cards, share-menu items and
//   folder-panel rows per provider; the Integrations pages render them. Nothing registered
//   renders nothing.
//
// Registration happens once from App (`registerBlockCards`, `registerIntegrationPlusSlots`), never
// at module load. Subscribers re-render when the registries change.

import { useSyncExternalStore, type ComponentType } from 'react'
import type { ChatToolCall } from '@shared/types/chat'
import type { IntegrationProvider } from '@shared/types/integrations'

export interface ToolCardProps {
  threadId: string
  messageId: string
  toolCall: ChatToolCall
}

/** Props of each integration slot kind. */
export interface IntegrationSlotProps {
  /** A card in Settings ▸ Integrations. */
  'settings-card': { provider: IntegrationProvider }
  /** An item in a note's share menu; `onDone` closes the menu. */
  'share-item': { provider: IntegrationProvider; noteId: string; panelId: string | null; onDone(): void }
  /** A row in a folder's integrations panel. */
  'folder-row': { provider: IntegrationProvider; folderId: string }
}

export type IntegrationSlotKind = keyof IntegrationSlotProps

let version = 0
const listeners = new Set<() => void>()

function changed(): void {
  version += 1
  for (const l of listeners) l()
}

function subscribe(l: () => void): () => void {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

/** Re-renders the caller when a registry changes. */
export function useSlotsVersion(): number {
  return useSyncExternalStore(subscribe, () => version)
}

// ---------- tool cards ----------

const toolCards = new Map<string, ComponentType<ToolCardProps>>()

export function registerToolCard(toolName: string, card: ComponentType<ToolCardProps>): () => void {
  toolCards.set(toolName, card)
  changed()
  return () => {
    if (toolCards.get(toolName) === card) {
      toolCards.delete(toolName)
      changed()
    }
  }
}

export function toolCardFor(toolName: string): ComponentType<ToolCardProps> | null {
  return toolCards.get(toolName) ?? null
}

// ---------- integration slots ----------

type SlotEntry<K extends IntegrationSlotKind> = { provider: IntegrationProvider; component: ComponentType<IntegrationSlotProps[K]> }

const slots: { [K in IntegrationSlotKind]: SlotEntry<K>[] } = { 'settings-card': [], 'share-item': [], 'folder-row': [] }

export function registerIntegrationSlot<K extends IntegrationSlotKind>(
  kind: K,
  provider: IntegrationProvider,
  c: ComponentType<IntegrationSlotProps[K]>
): () => void {
  const list = slots[kind] as SlotEntry<K>[]
  const entry: SlotEntry<K> = { provider, component: c }
  const i = list.findIndex((e) => e.provider === provider)
  if (i >= 0) list.splice(i, 1, entry)
  else list.push(entry)
  changed()
  return () => {
    const j = list.indexOf(entry)
    if (j >= 0) {
      list.splice(j, 1)
      changed()
    }
  }
}

/** In registration order. */
export function integrationSlots<K extends IntegrationSlotKind>(kind: K): readonly SlotEntry<K>[] {
  return slots[kind] as SlotEntry<K>[]
}
