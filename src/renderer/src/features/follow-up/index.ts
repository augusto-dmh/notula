// SPDX-License-Identifier: Apache-2.0
// Follow-up email drafts: the composer host, the
// function the note's "…" menu and home rows call, and the home section.

import { setComposerNote } from './store'

export { FollowUpComposerHost } from './Composer'
export { FollowUpSuggestedIcon, SuggestedFollowUps } from './SuggestedFollowUps'
export { useSuggestedNoteIds } from './store'

export function openFollowUpComposer(opts: { noteId: string }): void {
  setComposerNote(opts.noteId)
}
