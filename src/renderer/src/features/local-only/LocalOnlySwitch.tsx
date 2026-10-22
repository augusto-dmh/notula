// SPDX-License-Identifier: Apache-2.0
// "Nothing leaves this machine": the only control of
// `privacy.localOnly`. Main applies it (`privacy:set-local-only`); this row only asks and confirms.

import { useState, type JSX } from 'react'
import type { LocalOnlyStatus, LocalOnlyWarning } from '@shared/types/local-only'
import { Modal } from '../folders/Modal'
import { Switch } from '../settings/controls'
import { SettingsCard, SettingsRow } from '../settings/primitives'
import { refreshLocalOnly, useLocalOnly } from './store'
import './local-only.css'

const WARNING_TEXT: Record<LocalOnlyWarning, string> = {
  'no-local-asr': "Local transcription isn't installed, so meetings won't be transcribed until you install it.",
  'no-local-llm': "No local AI model is set up, so summaries and chat won't work until you set one up.",
  'local-llm-not-loopback': "Your local AI model isn't on this computer, so summaries and chat won't work until it is."
}

const ASR_LABEL: Record<string, string> = { deepgram: 'Deepgram', assemblyai: 'AssemblyAI' }
const LLM_LABEL: Record<string, string> = { anthropic: 'Anthropic', openai: 'your OpenAI-compatible provider' }

function ServiceList({ status }: { status: LocalOnlyStatus }): JSX.Element | null {
  if (!status.activeServices.length) return null
  return (
    <ul className="lo-list">
      {status.activeServices.map((s, i) => (
        <li key={`${s.kind}-${i}`}>{s.name}</li>
      ))}
    </ul>
  )
}

function TurnOnDialog({ status, onClose }: { status: LocalOnlyStatus; onClose(): void }): JSX.Element {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const apply = (): void => {
    setBusy(true)
    setError(null)
    void window.notula.privacy
      .setLocalOnly({ enabled: true, confirmed: true })
      .then((r) => {
        if (r.ok) {
          refreshLocalOnly()
          onClose()
          return
        }
        setError(r.reason === 'cloud-transcription-active' ? "Stop the transcript first. It's being transcribed in the cloud." : 'Not turned on.')
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message.replace(/^[a-z-]+: /, '') : 'Not turned on.'))
      .finally(() => setBusy(false))
  }
  return (
    <Modal label="Turn on Nothing leaves this machine" onClose={onClose}>
      <div className="h-modal__body lo-dialog">
        <h2 className="h-modal__title">Turn on Nothing leaves this machine?</h2>
        <p className="h-modal__subtitle">Notula will use only local transcription and a local AI model, and stop everything that connects to the internet.</p>
        {status.activeServices.length ? (
          <>
            <p className="lo-dialog__label">This stops</p>
            <ServiceList status={status} />
          </>
        ) : null}
        {status.warnings.length ? (
          <div className="lo-warnings" role="note">
            {status.warnings.map((w) => (
              <p key={w}>{WARNING_TEXT[w]}</p>
            ))}
          </div>
        ) : null}
        {error ? (
          <p className="lo-error" role="alert">
            {error}
          </p>
        ) : null}
        <footer className="lo-dialog__actions">
          <button type="button" className="n-btn n-btn--ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="n-btn n-btn--primary" data-autofocus disabled={busy} onClick={apply}>
            {busy ? 'Turning on…' : 'Turn on'}
          </button>
        </footer>
      </div>
    </Modal>
  )
}

function TurnOffDialog({ status, onClose }: { status: LocalOnlyStatus; onClose(): void }): JSX.Element {
  const [asr, setAsr] = useState(false)
  const [llm, setLlm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const prev = status.previousProviders
  const showAsr = prev && prev.asr !== 'local'
  const showLlm = prev && prev.llm !== 'local'
  const resuming = status.activeServices.map((s) => s.name)
  const apply = (): void => {
    setBusy(true)
    setError(null)
    void window.notula.privacy
      .setLocalOnly({ enabled: false, confirmed: true, restoreProviders: { asr, llm } })
      .then((r) => {
        if (r.ok) {
          refreshLocalOnly()
          onClose()
          return
        }
        setError(r.reason === 'not-verified' ? "Not turned off: your identity wasn't confirmed." : 'Not turned off.')
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message.replace(/^[a-z-]+: /, '') : 'Not turned off.'))
      .finally(() => setBusy(false))
  }
  return (
    <Modal label="Turn off Nothing leaves this machine" onClose={onClose}>
      <div className="h-modal__body lo-dialog">
        <h2 className="h-modal__title">Let data leave this computer again?</h2>
        <p className="h-modal__subtitle">
          {resuming.length ? `Data can leave this computer again for: ${resuming.join(', ')}.` : 'Data can leave this computer again for the services you set up.'}
        </p>
        {showAsr || showLlm ? (
          <div className="lo-restore">
            {showAsr ? (
              <label className="lo-check">
                <input type="checkbox" checked={asr} onChange={(e) => setAsr(e.target.checked)} />
                Use {ASR_LABEL[prev.asr] ?? prev.asr} for transcription again
              </label>
            ) : null}
            {showLlm ? (
              <label className="lo-check">
                <input type="checkbox" checked={llm} onChange={(e) => setLlm(e.target.checked)} />
                Use {LLM_LABEL[prev.llm] ?? prev.llm} again
              </label>
            ) : null}
            <p className="lo-dialog__hint">Otherwise Notula keeps using local models until you change them in Settings ▸ AI.</p>
          </div>
        ) : null}
        {status.heldSends > 0 ? (
          <p className="lo-dialog__hint">Integration sends held while this was on wait for your review in Settings ▸ Integrations.</p>
        ) : null}
        {error ? (
          <p className="lo-error" role="alert">
            {error}
          </p>
        ) : null}
        <footer className="lo-dialog__actions">
          <button type="button" className="n-btn n-btn--ghost" data-autofocus onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="n-btn n-btn--primary" disabled={busy} onClick={apply}>
            {busy ? 'Confirming…' : 'Turn off'}
          </button>
        </footer>
      </div>
    </Modal>
  )
}

export function LocalOnlySwitch(): JSX.Element | null {
  const status = useLocalOnly()
  const [dialog, setDialog] = useState<'on' | 'off' | null>(null)
  if (!status) return null
  const on = status.enabled
  return (
    <div id="local-only-switch">
      <SettingsCard>
        <SettingsRow
          title="Nothing leaves this machine"
          description={
            on
              ? 'On. Notula uses only local transcription and a local AI model, and connects to nothing on the internet.'
              : 'Use only local transcription and a local AI model, and turn off everything that connects to the internet.'
          }
          control={<Switch checked={on} busy={dialog !== null} label="Nothing leaves this machine" onChange={(next) => setDialog(next ? 'on' : 'off')} />}
        />
        {on && status.warnings.length ? (
          <div className="lo-inline-warnings">
            {status.warnings.map((w) => (
              <p key={w}>{WARNING_TEXT[w]}</p>
            ))}
          </div>
        ) : null}
      </SettingsCard>
      {dialog === 'on' ? <TurnOnDialog status={status} onClose={() => setDialog(null)} /> : null}
      {dialog === 'off' ? <TurnOffDialog status={status} onClose={() => setDialog(null)} /> : null}
    </div>
  )
}
