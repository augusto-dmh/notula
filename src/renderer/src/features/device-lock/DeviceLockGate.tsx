// SPDX-License-Identifier: Apache-2.0
// The lock view. While Notula is locked, only this renders and
// the routed content is not mounted; main refuses note IPC on its own (the IPC guard). The OS
// prompt opens once, when the window has focus; after that the user presses Unlock / Try again.

import { useEffect, useRef, useState, type JSX, type ReactNode } from 'react'
import type { DeviceLockFailure } from '@shared/types/device-lock'
import { NotulaMark } from '../../app/icons'
import { methodName, setDeviceLockStatus, useDeviceLock } from './store'
import './device-lock.css'

function failureText(reason: DeviceLockFailure, method: string): string {
  switch (reason) {
    case 'retries-exhausted':
      return `${method} has had too many attempts. Wait a moment, or unlock with your PIN or password.`
    case 'busy':
      return `${method} is busy. Try again in a moment.`
    case 'timeout':
      return 'The prompt closed before you answered.'
    case 'unavailable':
      return `${method} couldn't be reached.`
    default:
      return 'Not unlocked.'
  }
}

function LockView(): JSX.Element {
  const status = useDeviceLock()
  const method = methodName(status)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<DeviceLockFailure | null>(null)
  const prompted = useRef(false)

  const unlock = (): void => {
    if (busy) return
    setBusy(true)
    setFailure(null)
    void window.notula.deviceLock
      .unlock()
      .then((r) => {
        if (r.ok) void window.notula.deviceLock.getStatus().then(setDeviceLockStatus, () => undefined)
        else setFailure(r.reason ?? 'canceled')
      })
      .catch(() => setFailure('unavailable'))
      .finally(() => setBusy(false))
  }
  const unlockRef = useRef(unlock)
  unlockRef.current = unlock

  // Once per lock: when the window is (or becomes) the focused one.
  useEffect(() => {
    const once = (): void => {
      if (prompted.current || document.visibilityState !== 'visible' || !document.hasFocus()) return
      prompted.current = true
      unlockRef.current()
    }
    const t = window.setTimeout(once, 250)
    window.addEventListener('focus', once)
    document.addEventListener('visibilitychange', once)
    return () => {
      window.clearTimeout(t)
      window.removeEventListener('focus', once)
      document.removeEventListener('visibilitychange', once)
    }
  }, [])

  return (
    <main className="dl-lock" aria-labelledby="dl-lock-title">
      <div className="dl-lock__card">
        <NotulaMark size={44} />
        <h1 id="dl-lock-title" className="dl-lock__title">
          Notula is locked
        </h1>
        <p className="dl-lock__hint">
          {busy ? `Waiting for ${method}…` : failure ? failureText(failure, method) : `Unlock with ${method} to see your notes.`}
        </p>
        <button type="button" className="n-btn n-btn--primary dl-lock__btn" disabled={busy} onClick={unlock} autoFocus>
          {failure ? 'Try again' : 'Unlock'}
        </button>
        <p className="dl-lock__foot">Meetings keep recording while Notula is locked.</p>
      </div>
    </main>
  )
}

function WarningBar({ text }: { text: string }): JSX.Element | null {
  const [hidden, setHidden] = useState(false)
  if (hidden) return null
  return (
    <div className="dl-warning" role="status">
      <span>{text}</span>
      <button type="button" className="n-btn n-btn--sm n-btn--ghost" onClick={() => setHidden(true)}>
        Dismiss
      </button>
    </div>
  )
}

export function DeviceLockGate({ children }: { children: ReactNode }): JSX.Element {
  const status = useDeviceLock()
  if (!status) return <div className="dl-blank" aria-busy="true" />
  if (status.locked) return <LockView key="locked" />
  return (
    <>
      {status.warning ? <WarningBar text={status.warning} /> : null}
      {children}
    </>
  )
}
