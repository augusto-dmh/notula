// SPDX-License-Identifier: Apache-2.0
// The AI-providers onboarding step. It shows the shared AI
// section and ends with "Save", "Use local" or "Skip for now". Any of them sets
// `onboarding.aiProvidersDoneAt`. Save also saves keys typed but not saved.
// The recommended choices are preselected: Notes AI starts on the Google Gemini
// preset (unless a Notes AI key is already saved), and on-device Whisper large-v3-turbo
// leads the transcription block with a one-click "Download and use".

import { useEffect, useRef, useState, type JSX } from 'react'
import type { Settings } from '@shared/types/settings'
import { NotulaMark } from '../../app/icons'
import { AiSection, llmChoicePatch, type KeyDrafts } from '../settings/AiSection'
import { setPrefs } from '../settings/prefs-store'
import './onboarding.css'

/** Once per app run: the step can remount while onboarding is open. */
let preselected = false

export function AiProvidersStep({ prefs }: { prefs: Settings }): JSX.Element {
  const drafts = useRef<KeyDrafts>(new Map())
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (preselected || prefs['llm.provider'] !== 'anthropic') return
    preselected = true
    void Promise.all([window.notula.llm.hasKey({ provider: 'anthropic' }), window.notula.llm.hasKey({ provider: 'openai' })])
      .then(([anthropic, openai]) => {
        if (!anthropic && !openai) setPrefs(llmChoicePatch('gemini', prefs))
      })
      .catch(() => undefined)
    // Only the first render's settings matter here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function done(): void {
    setPrefs({ 'onboarding.aiProvidersDoneAt': new Date().toISOString() })
  }

  async function save(): Promise<void> {
    setSaving(true)
    try {
      const results = await Promise.all([...drafts.current.values()].map((saveDraft) => saveDraft()))
      if (results.every(Boolean)) done()
    } finally {
      setSaving(false)
    }
  }

  return (
    <main className="onb-step" aria-labelledby="onb-ai-title">
      <div className="onb-step__inner">
        <header className="onb-step__header">
          <NotulaMark size={30} />
          <p className="onb-step__eyebrow">Welcome to Notula</p>
          <h1 className="onb-step__title" id="onb-ai-title">
            Set up AI
          </h1>
          <p className="onb-step__lede">
            Notula transcribes meetings and writes notes with AI providers you choose, using your own API keys. Keys
            stay in this computer’s secure storage.
          </p>
          <p className="onb-step__lede onb-step__lede--small">
            Recommended: transcribe on this computer with <strong>Whisper large-v3-turbo</strong> (choose{' '}
            <strong>Download and use</strong> below), and write notes with <strong>Google Gemini</strong> (paste your
            key). Choose <strong>Save</strong> when you are done. To write notes with a model running on this computer
            instead, choose <strong>Use local</strong>. You can also skip this and set it up later in Settings.
          </p>
        </header>
        <div className="onb-step__body">
          <AiSection prefs={prefs} drafts={drafts.current} />
        </div>
      </div>
      <footer className="onb-step__footer">
        <div className="onb-step__footer-inner">
          <button type="button" className="n-btn n-btn--ghost" disabled={saving} onClick={done}>
            Skip for now
          </button>
          <span className="onb-step__spacer" />
          <button
            type="button"
            className="n-btn"
            disabled={saving}
            title="Write notes with a model running on this computer"
            onClick={() => {
              setPrefs({ 'llm.provider': 'local', 'onboarding.aiProvidersDoneAt': new Date().toISOString() })
            }}
          >
            Use local
          </button>
          <button type="button" className="n-btn n-btn--primary" disabled={saving} onClick={() => void save()}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </footer>
    </main>
  )
}
