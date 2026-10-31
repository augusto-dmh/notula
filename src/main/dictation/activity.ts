// SPDX-License-Identifier: Apache-2.0
// A read-only view of voice typing for other modules: whether a dictation is recording or
// being processed. Dictation keeps it current; nothing else writes it.

let busy = false

/** Dictation only. */
export function setDictationBusy(next: boolean): void {
  busy = next
}

/** True while a dictation records or is processed. */
export function dictationBusy(): boolean {
  return busy
}
