// SPDX-License-Identifier: Apache-2.0
// Settings ▸ Preferences: kept meeting audio.
// "Keep meeting audio" (off by default), how long to keep it, the total size, and a confirmed
// "Delete all saved audio". The audio itself never reaches the renderer.

import { useCallback, useEffect, useState, type JSX } from 'react'
import type { AudioRetention, RecordingsUsage } from '@shared/types/recordings'
import { showToast } from '../../app/toast'
import { SettingsCard, SettingsRow } from '../settings'
import { SpeechSwitch } from '../transcript/LocalAsrSettings'
import { formatBytes, setSpeechPrefs, useSpeechPrefs } from '../transcript/speech-state'
import './recordings.css'

const RETENTION: { value: AudioRetention; label: string }[] = [
  { value: '1d', label: '1 day' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: '90d', label: '90 days' },
  { value: '365d', label: '1 year' },
  { value: 'note', label: 'As long as the note' }
]

export function RecordingsPreferencesRows(): JSX.Element {
  const prefs = useSpeechPrefs()
  const [usage, setUsage] = useState<RecordingsUsage | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(() => {
    void window.notula.recordings
      .usage()
      .then(setUsage)
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    refresh()
    const t = setInterval(refresh, 15_000)
    return () => clearInterval(t)
  }, [refresh])

  const keep = prefs?.['audio.keepRecordings'] ?? false
  const retention = prefs?.['audio.retention'] ?? '7d'

  const deleteAll = async (): Promise<void> => {
    setBusy(true)
    try {
      await window.notula.recordings.deleteAll({ confirmed: true })
      showToast({ id: 'recordings-deleted', kind: 'success', title: 'Saved audio deleted' })
    } catch {
      showToast({ id: 'recordings-deleted', kind: 'error', title: 'Could not delete the saved audio' })
    } finally {
      setBusy(false)
      setConfirming(false)
      refresh()
    }
  }

  const sizeLine = usage
    ? usage.count
      ? `${formatBytes(usage.totalBytes)} in ${usage.count} recording${usage.count === 1 ? '' : 's'}, encrypted on this computer.`
      : 'No saved audio.'
    : ''

  return (
    <SettingsCard title="Meeting audio">
      <SettingsRow
        title="Keep meeting audio"
        description="Save an encrypted copy of each meeting's audio on this computer. You can export it from the note as WAV files."
        control={
          <SpeechSwitch
            label="Keep meeting audio"
            checked={keep}
            disabled={!prefs}
            onChange={(next) => setSpeechPrefs({ 'audio.keepRecordings': next })}
          />
        }
      />
      <SettingsRow
        title="Keep audio for"
        description="Older recordings are deleted automatically."
        control={
          <span className="settings-select">
            <select
              aria-label="Keep audio for"
              value={retention}
              disabled={!prefs}
              onChange={(e) => setSpeechPrefs({ 'audio.retention': e.target.value as AudioRetention })}
            >
              {RETENTION.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
          </span>
        }
      />
      <SettingsRow
        title="Saved audio"
        description={sizeLine}
        control={
          confirming ? (
            <span className="nt-rec-confirm">
              <button type="button" className="n-btn n-btn--sm" disabled={busy} onClick={() => setConfirming(false)}>
                Cancel
              </button>
              <button type="button" className="n-btn n-btn--sm n-btn--danger" disabled={busy} onClick={() => void deleteAll()}>
                Delete all
              </button>
            </span>
          ) : (
            <button
              type="button"
              className="n-btn n-btn--sm"
              disabled={!usage?.count}
              onClick={() => setConfirming(true)}
            >
              Delete all saved audio
            </button>
          )
        }
      />
    </SettingsCard>
  )
}
