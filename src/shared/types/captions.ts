// SPDX-License-Identifier: Apache-2.0
// Live captions.

export interface CaptionsState {
  noteId: string | null
  active: boolean
  alwaysOn: boolean
  mode: 'compact' | 'expanded'
  searching: boolean
}

export const CAPTIONS_GEOMETRY = {
  width: 880,
  compactHeight: 88,
  expandedHeight: 420,
  bottomMargin: 24,
  screenInset: 48,
  visibleLines: 3,
  lineHeight: 28,
  interimOpacityCompact: 0.78,
  interimOpacityExpanded: 0.8,
  followTolerancePx: 48
} as const
