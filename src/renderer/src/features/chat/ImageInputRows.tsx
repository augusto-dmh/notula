// SPDX-License-Identifier: Apache-2.0
// Settings ▸ AI: "This model accepts images" for the OpenAI-compatible and local providers.
// Anthropic models always read images. With the switch off, a chat image reaches the model
// as its text description instead.

import type { JSX } from 'react'
import { SettingsCard, SettingsRow } from '../settings'
import { Switch } from '../settings/controls'
import { setPrefs, usePrefs } from '../settings/prefs-store'

export function ImageInputRowsView(): JSX.Element {
  const prefs = usePrefs()
  const provider = prefs?.['llm.provider'] ?? 'anthropic'
  return (
    <SettingsCard title="Images in chat" description="Images you add to a chat go to your model as images when it accepts them, otherwise as a short description.">
      <SettingsRow
        title="This model accepts images"
        description={`OpenAI-compatible${provider === 'openai' ? ' (in use)' : ''}: ${prefs?.['llm.openai.model'] || 'no model chosen'}`}
        control={
          <Switch
            checked={prefs?.['llm.openai.acceptsImages'] ?? true}
            disabled={!prefs}
            label="OpenAI-compatible model accepts images"
            onChange={(on) => setPrefs({ 'llm.openai.acceptsImages': on })}
          />
        }
      />
      <SettingsRow
        title="This model accepts images"
        description={`Local model${provider === 'local' ? ' (in use)' : ''}: ${prefs?.['llm.local.model'] || 'no model chosen'}`}
        control={
          <Switch
            checked={prefs?.['llm.local.acceptsImages'] ?? false}
            disabled={!prefs}
            label="Local model accepts images"
            onChange={(on) => setPrefs({ 'llm.local.acceptsImages': on })}
          />
        }
      />
    </SettingsCard>
  )
}
