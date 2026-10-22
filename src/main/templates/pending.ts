// SPDX-License-Identifier: Apache-2.0
// The note's temporary template, mirrored from the renderer (`templates:set-note-template`):
// the template picked before the meeting's summary exists. End-of-meeting generation uses
// it and then clears it; a manual generation without a template uses it too. Memory only:
// it does not survive a restart.

const byNote = new Map<string, string>()

export function setNoteTemplate(noteId: string, templateId: string | null): void {
  if (templateId) byNote.set(noteId, templateId)
  else byNote.delete(noteId)
}

export function noteTemplate(noteId: string): string | null {
  return byNote.get(noteId) ?? null
}

export function clearNoteTemplate(noteId: string): void {
  byNote.delete(noteId)
}
