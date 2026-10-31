// SPDX-License-Identifier: Apache-2.0
// Screen capture (Labs): the panel window and the capture overlay. Each is the lazy root of
// a secondary window chosen by hash in main.tsx.

import { createElement, type JSX } from 'react'
import { CaptureRegion } from './CaptureRegion'
import { Panel } from './Panel'

/** `#/screen-capture`. */
export function ScreenCaptureRoot(): JSX.Element {
  return createElement(Panel)
}

/** `#/screen-capture-region`. */
export function CaptureRegionRoot(): JSX.Element {
  return createElement(CaptureRegion)
}
