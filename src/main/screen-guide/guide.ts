// SPDX-License-Identifier: Apache-2.0
// The screen-recording guide's opener for the other live-meeting modules (screen snapshots, bubble snapshots):
// `registerScreenGuide` installs it; until then, and on Windows, opening is a no-op.

let opener: (() => void) | null = null

export function setScreenGuideOpener(fn: (() => void) | null): void {
  opener = fn
}

/** Opens the guide on macOS; nothing elsewhere. */
export function openScreenGuide(): void {
  opener?.()
}
