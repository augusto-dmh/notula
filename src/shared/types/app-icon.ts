// SPDX-License-Identifier: Apache-2.0
// App icon colours unlocked by note milestones.
// The tint colours live in src/main/app-icon/tints.ts.

export type AppIconValue = 'black' | 'white' | 'blue' | 'yellow' | 'red' | 'pink'

/** The note count that unlocks each colour. */
export const APP_ICON_THRESHOLDS = { default: 0, black: 10, white: 50, blue: 100, yellow: 250, red: 500, pink: 1_000 } as const

export interface AppIconState {
  current: AppIconValue | null
  noteCount: number
  platformSupported: boolean
}
