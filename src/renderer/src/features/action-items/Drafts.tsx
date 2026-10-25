// SPDX-License-Identifier: Apache-2.0
// The summary-line draft buttons' data and their click.
// Mounted by the enhanced view beside the thumbs. While `actionItems.lineDrafts` is on (under
// `actionItems.enabled`), it feeds the editor with the note's open email and Slack items
// that belong to the user: attributed to the Profile email or name. A click starts or
// reopens the item's chat thread in the floating chat, or says which account is missing.

import { useEffect, useMemo, useRef } from 'react'
import { parseError } from '@shared/errors'
import type { ActionItem, ActionItemChannel } from '@shared/types/action-items'
import { navigateToSettings } from '../../app/navigation'
import { debugLog } from '../../app/platform'
import { showToast } from '../../app/toast'
import { setActionItemDrafts, type DraftLine } from '../../editor'
import { openFloatingThread } from '../chat'
import { usePrefs } from '../settings/prefs-store'
import { useActionItems } from './store'

const NOT_CONNECTED: Record<ActionItemChannel, { title: string; section: 'calendar' | 'integrations' }> = {
  email: { title: 'Set up email in Notula to draft this.', section: 'calendar' },
  slack: { title: 'Set up Slack in Notula to draft this.', section: 'integrations' }
}

function isUsers(item: ActionItem, name: string, email: string): boolean {
  return item.attribution.some(
    (a) => (!!name && a.name.trim().toLowerCase() === name) || (!!email && a.identifiers.some((x) => x.trim().toLowerCase() === email))
  )
}

export function ActionItemDrafts({ noteId }: { noteId: string }): null {
  const prefs = usePrefs()
  const enabled = prefs?.['actionItems.enabled'] === true && prefs['actionItems.lineDrafts'] === true
  const name = (prefs?.['profile.name'] ?? '').trim().toLowerCase()
  const email = (prefs?.['profile.email'] ?? '').trim().toLowerCase()
  const { state } = useActionItems(enabled ? { noteIds: [noteId] } : null)
  const items = state.status === 'ready' ? state.items : null
  const busy = useRef(new Set<string>())

  const lines = useMemo(() => {
    const m = new Map<string, DraftLine>()
    for (const i of items ?? []) {
      if (i.status !== 'todo' || i.archivedAt || !i.nextStepChannel || !i.lineFingerprint) continue
      if (isUsers(i, name, email)) m.set(i.id, { channel: i.nextStepChannel, lineFingerprint: i.lineFingerprint })
    }
    return m
  }, [items, name, email])

  useEffect(() => {
    if (!enabled || lines.size === 0) {
      setActionItemDrafts(null)
      return
    }
    const onDraft = async (actionItemId: string): Promise<void> => {
      if (busy.current.has(actionItemId)) return
      busy.current.add(actionItemId)
      try {
        const r = await window.notula.actionItems.startDraft({ actionItemId })
        const place = { kind: 'meeting', noteId } as const
        if (r.status === 'reused') {
          openFloatingThread(place, r.threadId)
        } else if (r.status === 'started') {
          openFloatingThread(place, r.threadId, r.message)
        } else {
          const copy = NOT_CONNECTED[r.channel]
          showToast({
            id: 'ai-draft-not-connected',
            kind: 'error',
            title: copy.title,
            action: { label: 'Open settings', onClick: () => navigateToSettings(copy.section) }
          })
        }
      } catch (err) {
        debugLog('action-items-draft-failed', { code: parseError(err).code })
        showToast({ id: 'ai-draft-failed', kind: 'error', title: 'Couldn’t start the draft in chat', description: parseError(err).message })
      } finally {
        busy.current.delete(actionItemId)
      }
    }
    setActionItemDrafts({ items: lines, onDraft: (id) => void onDraft(id) })
    return () => setActionItemDrafts(null)
  }, [enabled, lines, noteId])

  return null
}
