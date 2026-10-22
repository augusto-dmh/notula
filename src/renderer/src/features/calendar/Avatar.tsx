// SPDX-License-Identifier: Apache-2.0
// The person avatar: a letter on one of
// Notula's seven tones, or the Gravatar image when the user opted in. With Gravatar
// off no image request is made; with it on, a missing image (404) falls back to the letter.

import { useEffect, useState, type JSX } from 'react'
import { avatarTone } from '@shared/lib/people'
import { usePrefs } from './store'

const hashes = new Map<string, string>()

async function sha256Hex(text: string): Promise<string> {
  const cached = hashes.get(text)
  if (cached) return cached
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
  hashes.set(text, hex)
  return hex
}

/** Emails whose Gravatar failed this session: never asked again. */
const missing = new Set<string>()

function PeopleIcon({ size }: { size: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" aria-hidden="true">
      <circle cx="9" cy="9" r="3.2" />
      <path d="M3.5 19a5.5 5.5 0 0 1 11 0" />
      <circle cx="17" cy="9.5" r="2.6" />
      <path d="M15.5 14.2A4.6 4.6 0 0 1 21 18.6" />
    </svg>
  )
}

export function Avatar({ name, email, size = 20 }: { name?: string | null; email?: string | null; size?: number }): JSX.Element {
  const prefs = usePrefs()
  const gravatarOn = prefs?.['people.gravatarEnabled'] === true
  const key = email?.trim().toLowerCase() ?? ''
  const [src, setSrc] = useState<string | null>(null)

  useEffect(() => {
    setSrc(null)
    if (!gravatarOn || !key || missing.has(key)) return
    let alive = true
    void sha256Hex(key).then((hex) => {
      if (alive) setSrc(`https://gravatar.com/avatar/${hex}?s=${size * 2}&d=404`)
    })
    return () => {
      alive = false
    }
  }, [gravatarOn, key, size])

  const text = (name?.trim() || email?.trim() || '').trim()
  const tone = text ? avatarTone(key || text) : 0
  return (
    <span
      className={`nt-avatar nt-avatar--tone-${tone}`}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.55) }}
      aria-hidden="true"
    >
      {src ? (
        <img
          src={src}
          alt=""
          width={size}
          height={size}
          referrerPolicy="no-referrer"
          onError={() => {
            missing.add(key)
            setSrc(null)
          }}
        />
      ) : text ? (
        (text.codePointAt(0) !== undefined ? String.fromCodePoint(text.codePointAt(0) as number) : '').toUpperCase()
      ) : (
        <PeopleIcon size={Math.round(size * 0.6)} />
      )}
    </span>
  )
}
