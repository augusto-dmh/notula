// SPDX-License-Identifier: Apache-2.0
// The macOS screen-recording guide.

import { createElement, type JSX } from 'react'
import { GuidePanel, GuideSpotlight } from './Guide'

/** `#/screen-guide`. */
export function ScreenGuideRoot(): JSX.Element {
  return createElement(GuidePanel)
}

/** `#/screen-guide-spotlight`. */
export function ScreenGuideSpotlightRoot(): JSX.Element {
  return createElement(GuideSpotlight)
}
