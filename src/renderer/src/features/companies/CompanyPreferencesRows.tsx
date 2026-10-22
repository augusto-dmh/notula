// SPDX-License-Identifier: Apache-2.0
// Settings ▸ Preferences ▸ Companies: the opt-in
// favicon switch. Off by default; turning it off deletes the cached icons (main).

import type { JSX } from 'react'
import { SettingsCard, SettingsRow } from '../settings'
import { Switch } from '../settings/controls'
import { setPrefs, usePrefs } from '../settings/prefs-store'

export function CompanyPreferencesRowsView(): JSX.Element {
  const prefs = usePrefs()
  return (
    <SettingsCard title="Companies">
      <SettingsRow
        title="Show company icons from their websites"
        description="Notula will contact each company's website to fetch its icon. This shows those sites your IP address."
        control={
          <Switch
            checked={prefs?.['companies.faviconsEnabled'] ?? false}
            disabled={!prefs}
            label="Show company icons from their websites"
            onChange={(on) => setPrefs({ 'companies.faviconsEnabled': on })}
          />
        }
      />
    </SettingsCard>
  )
}
