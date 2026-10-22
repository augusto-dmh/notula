// SPDX-License-Identifier: Apache-2.0
// The tip copy. Ids are fixed in `@shared/types/nux` (dismissals are stored by id); each
// host mounts `<NuxTip id/>` where the tip belongs.

import type { NuxTipBase, NuxTipId } from '@shared/types/nux'

export interface TipCopy {
  title: string
  body?: string
  /** A button that does the hinted thing; the tip ends when it is used. */
  action?: string
  /** A one-line hint instead of a card. */
  compact?: boolean
}

export const TIPS: Record<NuxTipBase, TipCopy> = {
  'live-transcript': {
    title: 'Follow along live',
    body: 'Open the transcript to see what people say while Notula listens.'
  },
  'slash-menu': {
    title: 'Type / for headings, lists and more',
    compact: true
  },
  recipes: {
    title: 'Recipes fit four moments',
    body: 'Before a meeting, during it, right after it, or across several meetings: pick the one that matches what you need.'
  },
  'demo-meeting': {
    title: 'Try a demo meeting',
    body: 'Watch Notula take notes on a short sample meeting. No call needed.'
  },
  'folder-empty': {
    title: 'Fill this folder',
    body: 'Drag notes here from anywhere in Notula, or use Add notes to pick a few at once.'
  },
  'ai-setup': {
    title: 'Add an AI provider to get summaries',
    body: 'Notula writes summaries and answers questions with the AI provider you choose.',
    action: 'Open AI settings'
  },
  labs: {
    title: 'New experimental features are in Labs',
    body: 'Each one stays off until you turn it on.'
  },
  'retention-first-purge': {
    title: 'Old transcripts deleted',
    body: 'Notula deleted transcripts older than your auto-deletion setting.',
    action: 'Show details'
  },
  'calendar-error': {
    title: "Your calendar isn't syncing",
    body: 'Notula hasn’t been able to read this calendar for a day, so upcoming meetings may be missing.',
    action: 'Open calendar settings'
  }
}

/** `folder-empty:<id>` → `folder-empty`. */
export function tipBase(id: NuxTipId): NuxTipBase {
  return id.split(':')[0] as NuxTipBase
}
