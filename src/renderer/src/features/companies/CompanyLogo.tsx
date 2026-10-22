// SPDX-License-Identifier: Apache-2.0
// A company's logo: an initials tile by
// default, drawn here with no image request. With "Show company icons from their
// websites" on, main's cached favicon (`companies:icon`) shows instead, and the tile comes
// back when there is none or it fails to decode; after a failure it retries once when the
// computer comes back online.

import { useEffect, useState, type JSX } from 'react'
import { usePrefs } from '../settings/prefs-store'
import { IconBuilding } from '../people/icons'

/** domain → its data URL, or null when main has none. */
const icons = new Map<string, string | null>()
const inflight = new Map<string, Promise<string | null>>()

function dataUrl(mimeType: string, bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return `data:${mimeType};base64,${btoa(s)}`
}

function loadIcon(domain: string): Promise<string | null> {
  const cached = icons.get(domain)
  if (cached !== undefined) return Promise.resolve(cached)
  let p = inflight.get(domain)
  if (!p) {
    p = window.notula.companies
      .icon({ domain })
      .then((icon) => (icon ? dataUrl(icon.mimeType, icon.bytes) : null))
      .catch(() => null)
      .then((url) => {
        icons.set(domain, url)
        return url
      })
      .finally(() => inflight.delete(domain))
    inflight.set(domain, p)
  }
  return p
}

/** Turning the icons off (or on again) starts from a clean slate. */
let lastEnabled: boolean | null = null

export function CompanyLogo({ domain, name, size = 32 }: { domain: string; name: string; size?: number }): JSX.Element {
  const prefs = usePrefs()
  const enabled = prefs?.['companies.faviconsEnabled'] === true
  const [src, setSrc] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (lastEnabled !== null && lastEnabled !== enabled) icons.clear()
    lastEnabled = enabled
    setSrc(null)
    setFailed(false)
    if (!enabled || !domain) return
    let live = true
    void loadIcon(domain).then((url) => live && setSrc(url))
    return () => {
      live = false
    }
  }, [enabled, domain])

  // After an error, one retry when the browser comes back online.
  useEffect(() => {
    if (!failed || !enabled) return
    const retry = (): void => {
      icons.delete(domain)
      setFailed(false)
      void loadIcon(domain).then(setSrc)
    }
    window.addEventListener('online', retry, { once: true })
    return () => window.removeEventListener('online', retry)
  }, [failed, enabled, domain])

  const label = `${name || domain} logo`
  const letter = (name || '').trim().charAt(0).toUpperCase()
  return (
    <span className="company-logo" style={{ width: size, height: size, borderRadius: Math.round(size * 0.25) }} role="img" aria-label={label}>
      {src && !failed ? (
        <img src={src} alt="" width={size} height={size} onError={() => setFailed(true)} />
      ) : letter ? (
        <span className="company-logo__letter" style={{ fontSize: Math.round(size * 0.45) }}>
          {letter}
        </span>
      ) : (
        <IconBuilding size={Math.round(size * 0.6)} />
      )}
    </span>
  )
}
