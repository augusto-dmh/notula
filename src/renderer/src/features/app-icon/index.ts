// SPDX-License-Identifier: Apache-2.0
// App icon colours. Renders null on Linux.

import { createElement, type JSX } from 'react'
import { AppIconPicker } from './AppIconPicker'

export function AppIconRow(): JSX.Element | null {
  return createElement(AppIconPicker)
}
