// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef, useState, type JSX } from 'react'
import { IconAlert, IconCheck, IconClose, IconInfo } from './icons'
import { defaultDuration, dismissToast, useToasts, type LiveToast } from './toast'
import './toast.css'

function ToastItem({ toast }: { toast: LiveToast }): JSX.Element {
  const [paused, setPaused] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const remaining = useRef(defaultDuration(toast))
  const started = useRef(0)

  // A replaced toast (same id, new version) gets a fresh timer.
  useEffect(() => {
    remaining.current = defaultDuration(toast)
    setLeaving(false)
  }, [toast])

  useEffect(() => {
    if (paused || leaving || remaining.current <= 0 || !Number.isFinite(remaining.current)) return
    started.current = Date.now()
    const timer = setTimeout(() => setLeaving(true), remaining.current)
    return () => {
      clearTimeout(timer)
      remaining.current -= Date.now() - started.current
    }
  }, [paused, leaving, toast])

  useEffect(() => {
    if (!leaving) return
    const timer = setTimeout(() => dismissToast(toast.id), 160)
    return () => clearTimeout(timer)
  }, [leaving, toast.id])

  const kind = toast.kind ?? 'info'
  const Icon = kind === 'error' ? IconAlert : kind === 'success' ? IconCheck : IconInfo

  return (
    <div
      className={`toast toast--${kind}${leaving ? ' toast--leaving' : ''}`}
      role={kind === 'error' ? 'alert' : 'status'}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <span className="toast__icon" aria-hidden="true">
        <Icon size={16} />
      </span>
      <div className="toast__body">
        <div className="toast__title">{toast.title}</div>
        {toast.description ? <div className="toast__description">{toast.description}</div> : null}
        {toast.action ? (
          <button
            type="button"
            className="n-btn n-btn--sm toast__action"
            onClick={() => {
              toast.action?.onClick()
              setLeaving(true)
            }}
          >
            {toast.action.label}
          </button>
        ) : null}
      </div>
      <button type="button" className="n-icon-btn n-icon-btn--sm toast__close" aria-label="Dismiss" onClick={() => setLeaving(true)}>
        <IconClose size={14} />
      </button>
    </div>
  )
}

/** Mounted once, app-wide. */
export function Toaster(): JSX.Element {
  const toasts = useToasts()
  return (
    <div className="toaster" aria-live="polite">
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} />
      ))}
    </div>
  )
}
