// SPDX-License-Identifier: Apache-2.0
// Settings ▸ Profile: the local profile, saved automatically. Each edit applies to the
// field at once and saves 1 s after the last keystroke; main's
// `prefs:changed` echo confirms the save ("Profile updated"), and no echo within a few seconds
// shows the 5 s error toast. Leaving the page saves what is pending rather than dropping it.
// No LinkedIn field and no delete-all.

import { useEffect, useId, useRef, useState, type JSX } from 'react'
import type { SettingKey, SettingsPatch } from '@shared/types/settings'
import { showToast } from '../../app/toast'
import { Group, Row } from '../settings/controls'
import { usePrefs, setPrefs } from '../settings/prefs-store'
import './profile.css'

type ProfileKey = 'profile.name' | 'profile.email' | 'profile.jobTitle' | 'profile.company' | 'profile.companyDescription'

const FIELDS: readonly { key: ProfileKey; label: string; placeholder: string; autoComplete?: string; hint?: string; multiline?: boolean }[] = [
  { key: 'profile.name', label: 'Full name', placeholder: 'Jamie Rivera', autoComplete: 'name' },
  { key: 'profile.email', label: 'Email', placeholder: 'jamie@example.com', autoComplete: 'email' },
  { key: 'profile.jobTitle', label: 'Job title', placeholder: 'Product manager', autoComplete: 'organization-title' },
  { key: 'profile.company', label: 'Company name', placeholder: 'Northwind', autoComplete: 'organization' },
  {
    key: 'profile.companyDescription',
    label: 'Company description',
    placeholder: 'What your company does, in a sentence or two',
    hint: 'Helps Notula understand your meetings and write better notes.',
    multiline: true
  }
]

const SAVE_DELAY_MS = 1_000
const CONFIRM_TIMEOUT_MS = 4_000
const MAX: Record<ProfileKey, number> = {
  'profile.name': 500,
  'profile.email': 500,
  'profile.jobTitle': 500,
  'profile.company': 500,
  'profile.companyDescription': 5_000
}

function failed(): void {
  showToast({ id: 'profile-save', kind: 'error', title: 'Couldn’t save your profile. Try again.', durationMs: 5_000 })
}

/** Sends a patch and resolves whether main echoed every key back. */
function save(patch: SettingsPatch): Promise<boolean> {
  const keys = Object.keys(patch) as SettingKey[]
  return new Promise((resolve) => {
    const pending = new Set(keys)
    const off = window.notula.prefs.onChanged((e) => {
      for (const k of e.keys) pending.delete(k)
      if (pending.size === 0) finish(true)
    })
    const timer = window.setTimeout(() => finish(false), CONFIRM_TIMEOUT_MS)
    function finish(ok: boolean): void {
      window.clearTimeout(timer)
      off()
      resolve(ok)
    }
    setPrefs(patch)
  })
}

export function ProfileFormView(): JSX.Element | null {
  const prefs = usePrefs()
  const baseId = useId()
  const [drafts, setDrafts] = useState<Partial<Record<ProfileKey, string>>>({})
  const pending = useRef<Partial<Record<ProfileKey, string>>>({})
  const timer = useRef<number | null>(null)

  const flush = (toast: boolean): void => {
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = null
    const patch = pending.current
    pending.current = {}
    const keys = Object.keys(patch) as ProfileKey[]
    if (keys.length === 0) return
    const out: SettingsPatch = {}
    for (const k of keys) out[k] = (patch[k] ?? '').trim()
    void save(out).then((ok) => {
      if (!toast) return
      if (ok) showToast({ id: 'profile-save', kind: 'success', title: 'Profile updated' })
      else failed()
    })
    // The fields keep what was typed (untrimmed), so typing on after a save loses nothing.
  }
  const flushRef = useRef(flush)
  flushRef.current = flush
  useEffect(() => () => flushRef.current(false), [])

  if (!prefs) return null

  const edit = (key: ProfileKey, value: string): void => {
    setDrafts((d) => ({ ...d, [key]: value }))
    pending.current = { ...pending.current, [key]: value }
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => flush(true), SAVE_DELAY_MS)
  }

  return (
    <Group title="Account" description="Notula uses this when it writes your notes. It stays on this computer.">
      {FIELDS.map((f) => {
        const id = `${baseId}-${f.key}`
        const value = drafts[f.key] ?? prefs[f.key]
        return (
          <Row key={f.key} label={f.label} hint={f.hint} htmlFor={id} stacked>
            {f.multiline ? (
              <textarea
                id={id}
                className="n-input settings-textarea"
                value={value}
                rows={3}
                maxLength={MAX[f.key]}
                placeholder={f.placeholder}
                onChange={(e) => edit(f.key, e.target.value)}
              />
            ) : (
              <input
                id={id}
                className="n-input settings-text"
                type={f.key === 'profile.email' ? 'email' : 'text'}
                value={value}
                maxLength={MAX[f.key]}
                placeholder={f.placeholder}
                autoComplete={f.autoComplete}
                spellCheck={false}
                onChange={(e) => edit(f.key, e.target.value)}
              />
            )}
          </Row>
        )
      })}
    </Group>
  )
}
