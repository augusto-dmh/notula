// SPDX-License-Identifier: Apache-2.0
// Enhanced notes, title and regenerate. This module holds the public signatures; the
// bodies live in the files below.

import { useEffect, useRef } from 'react'
import type { Panel } from '@shared/types/panels'
import { onGenerationEvent, usePanelsSnapshot } from './store'

export { EnhancedView, type EnhancedViewProps } from './EnhancedView'
export { GenerateButton, type GenerateButtonProps } from './GenerateButton'
export { NotesMenu, type NotesMenuProps } from './NotesMenu'
export { regenerate } from './regenerate'
export { TitleField, type TitleFieldProps } from './TitleField'

export interface PanelsState {
  panels: Panel[]
  latest: Panel | null
  loading: boolean
}

export interface GenerationEvent {
  type: 'started' | 'completed' | 'failed'
  panelId: string
}

/**
 * The note's summary panels (not deleted, not suggested actions), most recently viewed
 * first; `latest` is the first.
 */
export function usePanels(noteId: string): PanelsState {
  return usePanelsSnapshot(noteId)
}

/** Generation started / completed / failed for the note's panels. */
export function useGenerationEvents(noteId: string, handler: (e: GenerationEvent) => void): void {
  const ref = useRef(handler)
  ref.current = handler
  useEffect(
    () =>
      onGenerationEvent((e) => {
        if (e.noteId !== noteId) return
        if (e.type === 'panel_id') ref.current({ type: 'started', panelId: e.panelId })
        else if (e.type === 'done') ref.current({ type: e.ok ? 'completed' : 'failed', panelId: e.panelId })
      }),
    [noteId]
  )
}
