// SPDX-License-Identifier: Apache-2.0
// Settings ▸ Notifications: the scheduled and auto-detected switches, the muted apps,
// auto-start, and meeting detection with its status.

import { useEffect, useMemo, useState, type JSX } from 'react'
import type { MeetingDetectionStatus, MicApp } from '@shared/types/meetings'
import { MEETING_APPS } from '@shared/types/meetings'
import { Choice, Toggle, setMeetingPrefs, useMeetingPrefs } from '../capture/settings-controls'
import { SettingsCard, SettingsRow } from '../settings'
import './notify-settings.css'

/** Display name → every app id with it (the Meet PWA has one id per browser). */
const IDS_BY_NAME: ReadonlyMap<string, string[]> = (() => {
  const m = new Map<string, string[]>()
  for (const [id, name] of Object.entries(MEETING_APPS)) m.set(name, [...(m.get(name) ?? []), id])
  return m
})()

function useDetection(): { status: MeetingDetectionStatus | null; apps: MicApp[] } {
  const [status, setStatus] = useState<MeetingDetectionStatus | null>(null)
  const [apps, setApps] = useState<MicApp[]>([])
  useEffect(() => {
    let alive = true
    const refresh = (): void => {
      void window.notula.meetings
        .getStatus()
        .then((s) => alive && setStatus(s))
        .catch(() => undefined)
    }
    refresh()
    void window.notula.meetings
      .getMicApps()
      .then((a) => alive && setApps(a))
      .catch(() => undefined)
    const off = window.notula.meetings.onMicAppsChanged((a) => {
      setApps(a)
      refresh()
    })
    // The monitor starts or restarts in the background; its status follows shortly.
    const t = window.setInterval(refresh, 3_000)
    return () => {
      alive = false
      off()
      clearInterval(t)
    }
  }, [])
  return { status, apps }
}

function detectionHint(status: MeetingDetectionStatus | null, apps: MicApp[]): string {
  if (!status) return 'Notice when a call app starts using your microphone.'
  switch (status.state) {
    case 'running':
      return apps.length
        ? `Watching for calls. Using your microphone now: ${apps.map((a) => a.name).join(', ')}.`
        : 'Watching for calls. Notula notices when a call app starts using your microphone.'
    case 'disabled':
      return 'Off. Notula won’t notice calls, or stop when the call app closes.'
    case 'unavailable':
      return status.detail ?? 'Meeting detection isn’t available on this computer.'
    case 'error':
      return `${status.detail ?? 'Meeting detection stopped.'} Turn it off and on again to retry.`
  }
}

function MutedApps({ silenced, disabled }: { silenced: string[]; disabled: boolean }): JSX.Element {
  const mutedNames = useMemo(() => {
    const names = new Set<string>()
    for (const id of silenced) {
      const name = MEETING_APPS[id]
      if (name) names.add(name)
    }
    return [...names].sort((a, b) => a.localeCompare(b))
  }, [silenced])
  const addable = useMemo(
    () => [...IDS_BY_NAME.keys()].filter((n) => !mutedNames.includes(n)).sort((a, b) => a.localeCompare(b)),
    [mutedNames]
  )
  const setNames = (names: string[]): void => {
    const keep = silenced.filter((id) => !MEETING_APPS[id])
    const ids = names.flatMap((n) => IDS_BY_NAME.get(n) ?? [])
    setMeetingPrefs({ 'notifications.silencedAppIds': [...new Set([...keep, ...ids])] })
  }
  return (
    <>
      <SettingsRow
        title="Muted apps"
        description={mutedNames.length ? 'No “Meeting detected” cards for these apps.' : 'No muted apps.'}
        control={
          <Choice
            label="Mute an app"
            value=""
            disabled={disabled || !addable.length}
            options={[{ value: '', label: 'Mute an app…' }, ...addable.map((n) => ({ value: n, label: n }))]}
            onChange={(n) => {
              if (n) setNames([...mutedNames, n])
            }}
          />
        }
      />
      {mutedNames.length ? (
        <div className={`nt-muted${disabled ? ' is-disabled' : ''}`}>
          {mutedNames.map((name) => (
            <span key={name} className="nt-muted__chip">
              {name}
              <button
                type="button"
                className="nt-muted__remove"
                aria-label={`Unmute ${name}`}
                disabled={disabled}
                onClick={() => setNames(mutedNames.filter((n) => n !== name))}
              >
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" aria-hidden="true">
                  <path d="M6 6l12 12M18 6 6 18" />
                </svg>
              </button>
            </span>
          ))}
        </div>
      ) : null}
    </>
  )
}

export function NotificationsSettings(): JSX.Element {
  const prefs = useMeetingPrefs()
  const { status, apps } = useDetection()
  if (!prefs) return <></>
  const autoBlocked = prefs['notifications.autoDetectedBlocked']
  const detection = prefs['meetings.detectionEnabled']
  return (
    <>
      <SettingsCard title="Meeting notifications">
        <SettingsRow
          title="Scheduled meetings"
          description="Get a reminder before meetings on your calendar start."
          control={
            <Toggle
              label="Scheduled meetings"
              checked={!prefs['notifications.scheduledBlocked']}
              onChange={(on) => setMeetingPrefs({ 'notifications.scheduledBlocked': !on })}
            />
          }
        />
        <SettingsRow
          title="Auto-detected meetings"
          description="Get a notification when Notula notices a call app using your microphone."
          control={
            <Toggle
              label="Auto-detected meetings"
              checked={!autoBlocked}
              onChange={(on) => setMeetingPrefs({ 'notifications.autoDetectedBlocked': !on })}
            />
          }
        />
        <MutedApps silenced={prefs['notifications.silencedAppIds']} disabled={autoBlocked} />
        <SettingsRow
          title="Auto-start detected meetings"
          description="Start transcribing as soon as Notula detects a meeting, without asking first."
          control={
            <Toggle
              label="Auto-start detected meetings"
              checked={prefs['meetings.autostartDetected']}
              disabled={autoBlocked}
              onChange={(on) => setMeetingPrefs({ 'meetings.autostartDetected': on })}
            />
          }
        />
      </SettingsCard>
      <SettingsCard title="Meeting detection">
        <SettingsRow
          title="Detect meetings"
          description={detectionHint(detection ? status : { state: 'disabled', detail: null, platform: 'win32' }, apps)}
          control={
            <Toggle
              label="Detect meetings"
              checked={detection}
              onChange={(on) => setMeetingPrefs({ 'meetings.detectionEnabled': on })}
            />
          }
        />
      </SettingsCard>
    </>
  )
}
