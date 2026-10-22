// SPDX-License-Identifier: Apache-2.0
// The Preferences section: General, Appearance and Language.

import { useCallback, useEffect, useId, useState, type JSX } from 'react'
import type { Settings, SummaryLanguage, ThemeSetting, TranscriptionLanguage } from '@shared/types/settings'
import { debugLog } from '../../app/platform'
import { AppIconRow } from '../app-icon'
import { Group, Row, Select, Switch } from './controls'
import { JargonEditor } from './JargonEditor'
import { setPrefs } from './prefs-store'
import { localLanguageInstalled, useLocalAsrStates } from '../transcript/speech-state'


/**
 * Open at login: the OS login item is the truth. It is read each time the
 * page opens; a toggle sends the change, reads it back, and the switch stays
 * disabled until then.
 */
function OpenAtLoginRow(): JSX.Element {
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [pending, setPending] = useState(false)

  const read = useCallback(async () => {
    try {
      setEnabled(await window.notula.app.getOpenAtLogin())
    } catch (err) {
      debugLog('settings:open-at-login-read-failed', { err: String(err) })
      setEnabled(false)
    }
  }, [])

  useEffect(() => {
    void read()
  }, [read])

  async function toggle(next: boolean): Promise<void> {
    setPending(true)
    setEnabled(next)
    window.notula.app.setLaunchAtLogin({ enabled: next })
    await read()
    setPending(false)
  }

  return (
    <Row label="Open Notula when you sign in" hint="Notula starts on its own each time you sign in to this computer.">
      <Switch
        label="Open Notula when you sign in"
        checked={enabled ?? false}
        disabled={enabled === null || pending}
        busy={pending}
        onChange={(next) => void toggle(next)}
      />
    </Row>
  )
}

export function PreferencesSection({ prefs }: { prefs: Settings }): JSX.Element {
  const themeId = useId()
  const transcriptionId = useId()
  const summaryId = useId()
  const jargonId = useId()
  const multi = prefs['asr.language'] !== 'en'
  // Brazilian Portuguese is offered while an on-device model covers it.
  const ptBr = localLanguageInstalled(useLocalAsrStates(), 'pt-BR') || prefs['asr.language'] === 'pt-BR'

  return (
    <>
      <Group title="General">
        <OpenAtLoginRow />
        <Row label="Play sounds" hint="A short tone when transcription starts, pauses or resumes">
          <Switch
            label="Play sounds"
            checked={prefs['capture.sounds']}
            onChange={(next) => setPrefs({ 'capture.sounds': next })}
          />
        </Row>
        {/* Side mode on joins and the after-meeting reset. */}
        <Row
          label="Move Notula aside during meetings"
          hint="Moves Notula to the side of your screen when a meeting starts, and back when it ends."
        >
          <Switch
            label="Move Notula aside during meetings"
            checked={prefs['window.repositionForMeetings']}
            onChange={(next) => setPrefs({ 'window.repositionForMeetings': next })}
          />
        </Row>
      </Group>

      <Group title="Appearance">
        <Row label="Theme" hint="Light, dark or match your system" htmlFor={themeId}>
          <Select<ThemeSetting>
            id={themeId}
            value={prefs['ui.theme']}
            options={[
              { value: 'system', label: 'System' },
              { value: 'light', label: 'Light' },
              { value: 'dark', label: 'Dark' }
            ]}
            onChange={(theme) => setPrefs({ 'ui.theme': theme })}
          />
        </Row>
        {/* The app icon colours, null on Linux. */}
        <AppIconRow />
      </Group>

      <Group title="Language">
        <Row label="Transcription language" hint="The language spoken in your meetings" htmlFor={transcriptionId}>
          <Select<TranscriptionLanguage>
            id={transcriptionId}
            value={prefs['asr.language']}
            options={[
              { value: 'en', label: 'English (best quality)' },
              { value: 'multi', label: 'Multi-language' },
              ...(ptBr ? [{ value: 'pt-BR' as const, label: 'Português (Brasil), on-device' }] : [])
            ]}
            onChange={(language) =>
              // Auto summaries need multi-language transcription, so English resets it.
              setPrefs(
                language === 'en'
                  ? { 'asr.language': 'en', 'enhance.summaryLanguage': 'en' }
                  : { 'asr.language': language }
              )
            }
          />
        </Row>
        <Row label="Summary language" hint="The language Notula writes your notes in" htmlFor={summaryId}>
          <Select<SummaryLanguage>
            id={summaryId}
            value={multi ? prefs['enhance.summaryLanguage'] : 'en'}
            options={[
              { value: 'en', label: 'English' },
              { value: 'multi', label: 'Auto', disabled: !multi }
            ]}
            onChange={(language) => setPrefs({ 'enhance.summaryLanguage': language })}
          />
        </Row>
        <Row label="Personal jargon" hint="Words Notula should listen for, like names and product terms." htmlFor={jargonId} stacked>
          <JargonEditor
            inputId={jargonId}
            terms={prefs['asr.keywords']}
            onChange={(terms) => setPrefs({ 'asr.keywords': terms })}
          />
        </Row>
      </Group>
    </>
  )
}

const PROFILE_FIELDS = [
  { key: 'profile.name', label: 'Name', placeholder: 'Your name', autoComplete: 'name' },
  { key: 'profile.email', label: 'Email', placeholder: 'you@example.com', autoComplete: 'email' },
  { key: 'profile.company', label: 'Company', placeholder: 'Where you work', autoComplete: 'organization' },
  { key: 'profile.jobTitle', label: 'Job title', placeholder: 'What you do', autoComplete: 'organization-title' }
] as const

function ProfileField({
  label,
  value,
  placeholder,
  autoComplete,
  multiline,
  onCommit
}: {
  label: string
  value: string
  placeholder: string
  autoComplete?: string
  multiline?: boolean
  onCommit(next: string): void
}): JSX.Element {
  const id = useId()
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  const commit = (): void => {
    const next = draft.trim()
    if (next !== value) onCommit(next)
  }
  return (
    <Row label={label} htmlFor={id} stacked>
      {multiline ? (
        <textarea
          id={id}
          className="n-input settings-textarea"
          value={draft}
          rows={3}
          maxLength={5000}
          placeholder={placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
        />
      ) : (
        <input
          id={id}
          className="n-input settings-text"
          value={draft}
          maxLength={500}
          placeholder={placeholder}
          autoComplete={autoComplete}
          spellCheck={false}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit()
          }}
        />
      )}
    </Row>
  )
}

/** Profile: stored locally and used only as context for Notes AI. */
export function ProfileSection({ prefs }: { prefs: Settings }): JSX.Element {
  return (
    <Group
      title="About you"
      description="Notes AI uses this to write notes from your point of view. It stays on this computer and is sent only with your Notes AI requests."
    >
      {PROFILE_FIELDS.map((f) => (
        <ProfileField
          key={f.key}
          label={f.label}
          value={prefs[f.key]}
          placeholder={f.placeholder}
          autoComplete={f.autoComplete}
          onCommit={(v) => setPrefs({ [f.key]: v })}
        />
      ))}
      <ProfileField
        label="About your company"
        value={prefs['profile.companyDescription']}
        placeholder="What your company does, in a sentence or two"
        multiline
        onCommit={(v) => setPrefs({ 'profile.companyDescription': v })}
      />
    </Group>
  )
}
