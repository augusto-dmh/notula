// SPDX-License-Identifier: Apache-2.0
import { trashNotes as trashWithUndo } from '../trash'
import { homeSelection } from './selection'

export { HomePage } from './HomePage'
export { attendeeSummary, noteAttendeeLine } from './attendees'
export { dayLabel, eventStart, groupRows, noteTime } from './grouping'

// Trash and the home multi-select, for the command palette.

/**
 * Trashes the notes, then one toast with Undo. Trashed notes
 * leave the home list, and with it the selection.
 */
export async function trashNotes(ids: string[]): Promise<void> {
  await trashWithUndo(ids)
}

/** The home list's current multi-selection; empty when home is not showing. */
export function getSelectedNoteIds(): string[] {
  return homeSelection()
}
