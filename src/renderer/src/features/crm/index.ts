// SPDX-License-Identifier: Apache-2.0
// Customer calls: `/view/customer-calls`, its sidebar link and the
// Labs row.

import { createElement, type JSX } from 'react'
import { CustomerCallsPageView } from './CustomerCalls'

export { CustomerCallsLabsRow, SidebarCustomerCallsLink } from './CustomerCalls'

export function CustomerCallsPage(): JSX.Element {
  return createElement(CustomerCallsPageView)
}
