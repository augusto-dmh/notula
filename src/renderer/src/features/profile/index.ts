// SPDX-License-Identifier: Apache-2.0
// Profile and This device. The views live beside this file.

import { createElement, type JSX } from 'react'
import { ProfileFormView } from './ProfileForm'
import { ThisDeviceCardView } from './ThisDeviceCard'

export function ProfileForm(): JSX.Element {
  return createElement(ProfileFormView)
}

export function ThisDeviceCard(): JSX.Element {
  return createElement(ThisDeviceCardView)
}
