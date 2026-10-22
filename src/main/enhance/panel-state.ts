// SPDX-License-Identifier: Apache-2.0
// Panel generation state from the stored timestamps.

import type { Panel } from '@shared/types/panels'

/** The watchdog: a stored "generating" older than this counts as failed. */
export const GENERATION_WATCHDOG_MS = 180_000

export type PanelState = 'completed' | 'failed' | 'generating' | 'timed-out' | 'idle'

export function panelState(
  p: Pick<Panel, 'content_edited_at' | 'enhance_started_at' | 'enhance_failed_at'>,
  now = Date.now()
): PanelState {
  const started = p.enhance_started_at ?? ''
  const failed = p.enhance_failed_at ?? ''
  if (p.content_edited_at && p.content_edited_at >= started && p.content_edited_at >= failed) return 'completed'
  if (p.enhance_failed_at && p.enhance_failed_at >= started) return 'failed'
  if (p.enhance_started_at) {
    return now - Date.parse(p.enhance_started_at) < GENERATION_WATCHDOG_MS ? 'generating' : 'timed-out'
  }
  return 'idle'
}
