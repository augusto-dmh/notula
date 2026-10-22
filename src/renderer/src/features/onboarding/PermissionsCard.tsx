// SPDX-License-Identifier: Apache-2.0
// The permissions page, used by the onboarding step and by `/permissions`. In practice
// it only asks on macOS: every other platform records both permissions as granted at
// startup.
//
// - Microphone: the OS prompt; a denial shows a toast.
// - System audio: the display-media probe; attempts are counted. From the second
//   attempt on, a denial shows a toast, and a help panel stays while the two are not
//   both granted.
// - Continue is enabled only when both are granted. There is no accessibility row:
//   no feature needs that permission.

import { useState, type JSX } from 'react'
import { showToast } from '../../app/toast'
import { IconMic, IconSpeaker } from '../settings/icons'
import { requestMicrophone, requestSystemAudio, usePermissions } from './permissions-store'
import './onboarding.css'

/** The macOS path for system audio (`core_audio` is on by default). */
const SYSTEM_AUDIO_PATH = 'Privacy & Security ▸ Screen & System Audio Recording'

function PermissionRow({
  icon,
  eyebrow,
  title,
  granted,
  busy,
  actionLabel,
  onEnable
}: {
  icon: JSX.Element
  eyebrow: string
  title: string
  granted: boolean
  busy: boolean
  actionLabel: string
  onEnable(): void
}): JSX.Element {
  return (
    <div className="perm-row">
      <span className="perm-row__icon" aria-hidden="true">
        {icon}
      </span>
      <div className="perm-row__text">
        <div className="perm-row__eyebrow">{eyebrow}</div>
        <div className="perm-row__title">{title}</div>
      </div>
      {granted ? (
        <span className="perm-row__enabled">Enabled</span>
      ) : (
        <button type="button" className="n-btn n-btn--sm" disabled={busy} aria-busy={busy || undefined} onClick={onEnable}>
          {busy ? <span className="n-spinner perm-row__spinner" /> : null}
          {actionLabel}
        </button>
      )}
    </div>
  )
}

export function PermissionsCard({ onContinue }: { onContinue(): void }): JSX.Element {
  const perms = usePermissions()
  const [busy, setBusy] = useState<'microphone' | 'system' | null>(null)
  const [systemAttempts, setSystemAttempts] = useState(0)

  const micGranted = perms?.microphone === 'granted'
  const systemGranted = perms?.systemAudio === 'granted'
  const bothGranted = micGranted && systemGranted

  async function enableMicrophone(): Promise<void> {
    setBusy('microphone')
    try {
      const next = await requestMicrophone()
      if (next.microphone !== 'granted') {
        showToast({
          id: 'permissions-microphone',
          kind: 'error',
          title:
            'Notula can’t use the microphone. Allow it in your system’s privacy settings, then try again.'
        })
      }
    } finally {
      setBusy(null)
    }
  }

  async function enableSystemAudio(): Promise<void> {
    const attempt = systemAttempts + 1
    setSystemAttempts(attempt)
    setBusy('system')
    try {
      const next = await requestSystemAudio()
      if (next.systemAudio !== 'granted' && attempt > 1) {
        showToast({
          id: 'permissions-system-audio',
          kind: 'error',
          title: `To capture other people’s voices, allow Notula in ${SYSTEM_AUDIO_PATH}, then try again.`
        })
      }
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="perm">
      <section className="perm-card" aria-labelledby="perm-title">
        <h1 className="perm-card__title" id="perm-title">
          Let Notula hear your meetings
        </h1>
        <p className="perm-card__lede">
          Notula needs your microphone for your voice, and your computer’s audio for everyone else in the call.
        </p>
        <div className="perm-card__rows">
          <PermissionRow
            icon={<IconMic size={18} />}
            eyebrow="Your voice"
            title="Transcribe my voice"
            granted={micGranted}
            busy={busy === 'microphone'}
            actionLabel="Allow microphone"
            onEnable={() => void enableMicrophone()}
          />
          <PermissionRow
            icon={<IconSpeaker size={18} />}
            eyebrow="Other people’s voices"
            title="Transcribe other people’s voices"
            granted={systemGranted}
            busy={busy === 'system'}
            actionLabel="Allow system audio"
            onEnable={() => void enableSystemAudio()}
          />
        </div>
        {systemAttempts >= 2 && !bothGranted ? (
          <div className="perm-help" role="note">
            <p className="perm-help__title">Enable Notula in {SYSTEM_AUDIO_PATH}</p>
            <button
              type="button"
              className="n-btn n-btn--sm"
              onClick={() => window.notula.system.openPrivacySettings({ target: 'screen-recording' })}
            >
              Edit in System Settings
            </button>
            <p className="perm-help__note">You may need to restart Notula after allowing it.</p>
          </div>
        ) : null}
      </section>
      <button type="button" className="n-btn n-btn--primary perm__continue" disabled={!bothGranted} onClick={onContinue}>
        Continue
      </button>
    </div>
  )
}
