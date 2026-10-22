// SPDX-License-Identifier: Apache-2.0
// `/permissions`: the permissions page as a
// direct route. Continue goes home, where the guard moves on.

import type { JSX } from 'react'
import { navigate } from '../../app/navigation'
import { PermissionsCard } from '../onboarding/PermissionsCard'

export function PermissionsPage(): JSX.Element {
  return (
    <div className="onb-page">
      <PermissionsCard onContinue={() => navigate('/')} />
    </div>
  )
}
