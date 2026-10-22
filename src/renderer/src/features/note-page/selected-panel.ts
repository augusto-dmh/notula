// SPDX-License-Identifier: Apache-2.0
// The summary panel each open note page has selected, for the palette's "Copy enhanced
// notes" ("the selected one when `panelId` is omitted").

const selected = new Map<string, string | null>()

export function rememberSelectedPanel(noteId: string, panelId: string | null): void {
  selected.set(noteId, panelId)
}

export function forgetSelectedPanel(noteId: string): void {
  selected.delete(noteId)
}

export function selectedPanelOf(noteId: string): string | null {
  return selected.get(noteId) ?? null
}
