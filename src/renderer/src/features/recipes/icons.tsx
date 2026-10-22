// SPDX-License-Identifier: Apache-2.0
// Icons for the recipe UIs: the shared small set plus the recipe tile (a slash on a
// soft accent square, the visual cue for `/<slug>`).

import type { JSX } from 'react'
import { IconPencil } from '../../app/icons'
import { IconSlash } from '../templates/ui-icons'

export { IconCopy, IconGrid, IconPlay, IconRows, IconSlash, IconTrashSmall } from '../templates/ui-icons'

export function IconPencilSmall({ size = 14 }: { size?: number }): JSX.Element {
  return <IconPencil size={size} />
}

export function IconSlashTile({ size = 28 }: { size?: number }): JSX.Element {
  return (
    <span className="rcp-tile" style={{ width: size, height: size }} aria-hidden="true">
      <IconSlash size={Math.round(size * 0.58)} />
    </span>
  )
}
