// SPDX-License-Identifier: Apache-2.0
// Companies: `/companies`, `/company/:domain`, the
// sidebar favorites, the company-icon Preferences rows and the folder page's Companies tab.

import { createElement, type JSX } from 'react'
import { CompaniesPageView } from './CompaniesPage'
import { CompanyPageView } from './CompanyPage'
import { CompanyPreferencesRowsView } from './CompanyPreferencesRows'
import { SidebarCompanyFavoritesView } from './SidebarCompanyFavorites'
import '../people/people.css'
import './companies.css'

/** `/companies`. */
export function CompaniesPage(): JSX.Element {
  return createElement(CompaniesPageView)
}

/** `/company/:domain`. */
export function CompanyPage({ domain }: { domain: string }): JSX.Element {
  return createElement(CompanyPageView, { key: domain, domain })
}

/** Under the sidebar's favorites; null unless `companies.sidebarFavorites` is on. */
export function SidebarCompanyFavorites(): JSX.Element | null {
  return createElement(SidebarCompanyFavoritesView)
}

/** Settings ▸ Preferences: company icons. */
export function CompanyPreferencesRows(): JSX.Element {
  return createElement(CompanyPreferencesRowsView)
}

export { CompanyLogo } from './CompanyLogo'
export { FolderCompaniesTab } from './FolderCompaniesTab'
