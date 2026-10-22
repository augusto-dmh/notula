// SPDX-License-Identifier: Apache-2.0
// Settings ▸ Preferences: Folders. "Suggest folders with AI" (`folders.aiSuggestions`)
// also has a switch on the folder pages; this is its home in Preferences. Off by default;
// on, a note's title and the start of its summary go to the user's own AI provider after
// a summary generates.

import type { JSX } from 'react'
import { SettingsCard, SettingsRow } from '../settings'
import { Switch } from '../settings/controls'
import { setPrefs, usePrefs } from '../settings/prefs-store'

export function FolderPreferencesRows(): JSX.Element {
  const prefs = usePrefs()
  return (
    <SettingsCard title="Folders">
      <SettingsRow
        title="Suggest folders with AI"
        description="After a summary is written, suggests one of your folders for the note. Sends the note’s title and the start of its summary to your AI provider."
        control={
          <Switch
            checked={prefs?.['folders.aiSuggestions'] ?? false}
            disabled={!prefs}
            onChange={(on) => setPrefs({ 'folders.aiSuggestions': on })}
            label="Suggest folders with AI"
          />
        }
      />
    </SettingsCard>
  )
}
