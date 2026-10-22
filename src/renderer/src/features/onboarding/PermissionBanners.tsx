// SPDX-License-Identifier: Apache-2.0
// App-level permission warnings, rendered above every page by OnboardingGate.
//
// - Windows: while the OS microphone status reads denied, a non-blocking warning (so a
//   denied microphone never goes unnoticed) with a button that opens
//   the Windows microphone privacy page. It can be dismissed; it comes back at the
//   next push (every capture start pushes).
// - macOS: while a note is transcribing and the screen-capture
//   status is denied. "Grant permission" opens the Screen Recording pane. The status
//   is re-checked on window focus and arrives with every push.

import { useEffect, useState, type JSX } from 'react'
import { useCaptureState } from '../capture'
import { IconWarning, IconX } from '../settings/icons'
import { checkSystemAudio, refreshPermissions, usePermissionPushes, usePermissions } from './permissions-store'
import './onboarding.css'

function Banner({
  text,
  actionLabel,
  onAction,
  onDismiss
}: {
  text: string
  actionLabel: string
  onAction(): void
  onDismiss?: () => void
}): JSX.Element {
  return (
    <div className="perm-banner" role="alert">
      <IconWarning size={16} className="perm-banner__icon" />
      <p className="perm-banner__text">{text}</p>
      <button type="button" className="n-btn n-btn--sm perm-banner__action" onClick={onAction}>
        {actionLabel}
      </button>
      {onDismiss ? (
        <button type="button" className="n-icon-btn n-icon-btn--sm perm-banner__dismiss" aria-label="Dismiss" onClick={onDismiss}>
          <IconX size={14} />
        </button>
      ) : null}
    </div>
  )
}

export function PermissionBanners(): JSX.Element | null {
  const perms = usePermissions()
  const pushes = usePermissionPushes()
  const { transcribingNoteId } = useCaptureState()
  const [dismissedAt, setDismissedAt] = useState<number | null>(null)
  const platform = perms?.platform

  // Re-read on focus: the user may have just changed it in the OS settings.
  useEffect(() => {
    if (platform !== 'darwin' && platform !== 'win32') return
    const onFocus = (): void => {
      if (platform === 'darwin') void checkSystemAudio()
      else refreshPermissions()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [platform])

  // macOS: check again whenever a note starts transcribing.
  useEffect(() => {
    if (platform === 'darwin' && transcribingNoteId) void checkSystemAudio()
  }, [platform, transcribingNoteId])

  if (!perms) return null

  if (perms.platform === 'win32' && perms.osMicrophone === 'denied' && dismissedAt !== pushes) {
    return (
      <Banner
        text="Windows is blocking microphone access, so Notula can’t transcribe your voice."
        actionLabel="Open microphone settings"
        onAction={() => window.notula.system.openPrivacySettings({ target: 'microphone' })}
        onDismiss={() => setDismissedAt(pushes)}
      />
    )
  }

  if (perms.platform === 'darwin' && transcribingNoteId && perms.systemAudioCheck?.screenCapture === 'denied') {
    return (
      <Banner
        text="Notula needs permission to capture this computer’s audio."
        actionLabel="Grant permission"
        onAction={() => window.notula.system.openPrivacySettings({ target: 'screen-recording' })}
      />
    )
  }

  return null
}
