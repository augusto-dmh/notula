// SPDX-License-Identifier: Apache-2.0
// The home list's multi-selection, for the command palette (`getSelectedNoteIds`).
// HomePage publishes it while mounted; it is empty otherwise.

let current: readonly string[] = []

export function publishHomeSelection(ids: readonly string[]): void {
  current = ids
}

export function homeSelection(): string[] {
  return [...current]
}
