// SPDX-License-Identifier: Apache-2.0
// Prep briefs: the note header card.

import { createElement, type JSX } from 'react'
import { BriefCard } from './BriefCard'

/** NotePage, top of the header. */
export function PrepBriefCard({ noteId, eventId }: { noteId: string; eventId: string | null }): JSX.Element | null {
  return createElement(BriefCard, { noteId, eventId })
}
