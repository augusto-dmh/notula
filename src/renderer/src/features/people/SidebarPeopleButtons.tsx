// SPDX-License-Identifier: Apache-2.0
// The sidebar footer's People and Companies icon buttons: a row of two, each with its
// tooltip, never gated.

import type { JSX } from 'react'
import { navigate, useRoute } from '../../app/navigation'
import { closeSidebarOverlay } from '../../app/sidebar-state'
import { IconBuilding, IconPeopleLarge } from './icons'

export function SidebarPeopleButtonsView(): JSX.Element {
  const { path } = useRoute()
  const onPeople = path === '/people' || path.startsWith('/person/')
  const onCompanies = path === '/companies' || path.startsWith('/company/')
  const go = (to: string): void => {
    navigate(to)
    closeSidebarOverlay()
  }
  return (
    <div className="sidebar-people">
      <span className="n-tooltip n-tooltip--start" data-tooltip="People">
        <button type="button" className="n-icon-btn sidebar-people__btn" aria-label="People" aria-current={onPeople ? 'page' : undefined} onClick={() => go('/people')}>
          <IconPeopleLarge size={17} />
        </button>
      </span>
      <span className="n-tooltip" data-tooltip="Companies">
        <button
          type="button"
          className="n-icon-btn sidebar-people__btn"
          aria-label="Companies"
          aria-current={onCompanies ? 'page' : undefined}
          onClick={() => go('/companies')}
        >
          <IconBuilding size={17} />
        </button>
      </span>
    </div>
  )
}
