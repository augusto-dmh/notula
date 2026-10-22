// SPDX-License-Identifier: Apache-2.0
// The command palette's registry. Features register a provider under a source id; the
// palette calls `listCommands()` each time it opens, so a provider always reflects the
// current route, note and selection. The search feature owns the palette UI and
// registers the core commands itself.

import type { ReactNode } from 'react'
import { debugLog } from './platform'

export type CommandGroup =
  | 'general'
  | 'meetings'
  | 'companies'
  | 'folders'
  | 'people'
  | 'navigation'
  | 'more-results'
  | 'selected-notes'
  | 'actions'
  | 'settings'
  | 'workspace'
  | 'account'
  | 'internal'

/** One row of a command's sub-list (for example "Add to folder…"). */
export interface CommandItem {
  id: string
  label: string
  icon?: ReactNode
  keywords?: string[]
  run(): void | Promise<void>
}

export interface Command {
  id: string
  label: string
  group: CommandGroup
  keywords?: string[]
  /** Shown only in its context (a note page, a selection). */
  contextual?: boolean
  /** Shown disabled when false. */
  enabled?: boolean
  /** Double-Enter: the first Enter shows "Confirm ↵" and the hint; the second runs it. */
  confirm?: { hint: string }
  /** Right Arrow (or Enter) opens it; Backspace, Left or "Back" leaves it. */
  subList?: { placeholder: string; items(): CommandItem[] }
  run?(): void | Promise<void>
}

const providers = new Map<string, () => Command[]>()

/**
 * Registers (or replaces) the provider for `sourceId`. Returns the unregister function,
 * which removes only this provider.
 */
export function registerCommands(sourceId: string, provider: () => Command[]): () => void {
  providers.set(sourceId, provider)
  return () => {
    if (providers.get(sourceId) === provider) providers.delete(sourceId)
  }
}

/** Every registered command, in registration order. A provider that throws is skipped. */
export function listCommands(): Command[] {
  const out: Command[] = []
  for (const [sourceId, provider] of providers) {
    try {
      out.push(...provider())
    } catch (err) {
      debugLog('commands:provider-failed', { sourceId, err })
    }
  }
  return out
}
