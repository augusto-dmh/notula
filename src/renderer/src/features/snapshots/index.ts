// SPDX-License-Identifier: Apache-2.0
// Screen-share snapshots and bubble snapshots: the source picker and region overlay
// windows, and the Labs row.

import { createElement, type JSX } from 'react'
import { LabsRow } from './LabsRow'
import { Picker } from './Picker'
import { Region } from './Region'

export { useScreenSnapshots } from './store'

/** `#/snapshot-picker`. */
export function SnapshotPickerRoot(): JSX.Element {
  return createElement(Picker)
}

/** `#/snapshot-region`. */
export function SnapshotRegionRoot(): JSX.Element {
  return createElement(Region)
}

/** Settings ▸ Labs: the custom screen-snapshots row (confirmation, image-model check). */
export function ScreenSnapshotsLabsRow(): JSX.Element {
  return createElement(LabsRow)
}
