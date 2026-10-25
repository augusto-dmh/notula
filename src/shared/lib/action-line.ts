// SPDX-License-Identifier: Apache-2.0
// The comparable text of a summary line that states an action item. Main stamps item ids onto
// the lines whose key matches and stores a fingerprint of it; the renderer hashes the line's
// current key the same way, so an edited line no longer matches. Pure: no DOM, no Electron.

/** Comparable text: markdown emphasis, code ticks and link syntax dropped, spaces collapsed. */
export function lineKey(text: string): string {
  return text
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')
    .replace(/^\s*\[[ xX]\]\s+/, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|~~|`)/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Hex characters of the SHA-256 of the line key kept as its fingerprint. */
export const LINE_FINGERPRINT_LENGTH = 16
