// SPDX-License-Identifier: Apache-2.0
// Settings ▸ Sources rows. Every Settings-written key lives here;
// History and online lookups go through `sources:grant` (main-only keys), the yt-dlp download
// through `sources:tools-*`. Status rows read `sources:get-status`; until main's handlers land,
// they say the feature isn't available in this build yet and the switches still save.

import { useEffect, useId, useState, type FormEvent, type JSX } from 'react'
import { parseError } from '@shared/errors'
import type { DetectorStatus, IdentifyStep, SourceMute, ToolsStatus } from '@shared/types/sources'
import { SOURCES_LIMITS } from '@shared/types/sources'
import { SettingsCard, SettingsRow } from '../../settings'
import { Select, StatusLine, Switch, type Status } from '../../settings/controls'
import { setPrefs, usePrefs } from '../../settings/prefs-store'
import { debugLog } from '../../../app/platform'
import { isMissingHandler, patchSourcesStatus, useSourcesStatus } from '../note/source-store'
import './sources-settings.css'

const STEP_LABEL: Record<IdentifyStep, string> = {
  tab: 'the browser tab',
  'address-bar': 'the address bar',
  history: 'browser history',
  fallback: 'the title only',
  search: 'a title search',
  verify: 'a check with YouTube',
  enrich: 'the video’s details',
  extension: 'the browser extension'
}

function detectorHint(d: DetectorStatus | null, on: boolean, unavailable: boolean): string {
  if (!on) return 'Off. Notula doesn’t watch what plays in your browser. You can still link sources by hand.'
  if (unavailable) return 'Detection isn’t available in this build yet.'
  if (!d) return 'Notices videos and lessons playing in Edge or Chrome.'
  const last = d.lastStep ? ` Last found through ${STEP_LABEL[d.lastStep]}.` : ''
  switch (d.state) {
    case 'running':
      return `Watching Edge and Chrome for videos and lessons.${last}`
    case 'starting':
    case 'restarting':
      return 'Starting…'
    case 'off':
      return 'Off. Notula doesn’t watch what plays in your browser.'
    case 'failed':
      return `Detection stopped${d.reason ? ` (${d.reason})` : ''}. Turn it off and on again to retry.`
    case 'unavailable':
      return `Not available on this computer${d.reason ? ` (${d.reason})` : ''}. You can still link sources by hand.`
  }
}

export function DetectionRows(): JSX.Element | null {
  const prefs = usePrefs()
  const { status, unavailable } = useSourcesStatus()
  if (!prefs) return null
  const detect = prefs['sources.detect']
  return (
    <SettingsCard title="Detection">
      <SettingsRow
        title="Detect videos"
        description={detectorHint(status?.detector ?? null, detect, unavailable)}
        control={<Switch label="Detect videos" checked={detect} onChange={(on) => setPrefs({ 'sources.detect': on })} />}
      />
      <SettingsRow
        title="Offer a note"
        description="Show a card when a video or lesson starts playing, so you can take notes on it or continue a note."
        control={
          <Switch
            label="Offer a note"
            checked={prefs['sources.offer'] === 'ask'}
            disabled={!detect}
            onChange={(on) => setPrefs({ 'sources.offer': on ? 'ask' : 'off' })}
          />
        }
      />
      <SettingsRow
        title="Prefer the browser extension"
        description="When the extension is connected, use its link, time and course details instead of what Windows reports."
        control={
          <Switch
            label="Prefer the browser extension"
            checked={prefs['sources.extensionPreferred']}
            onChange={(on) => setPrefs({ 'sources.extensionPreferred': on })}
          />
        }
      />
    </SettingsCard>
  )
}

export function GrantRows(): JSX.Element | null {
  const prefs = usePrefs()
  const { status } = useSourcesStatus()
  const [busy, setBusy] = useState<'history' | 'lookups' | null>(null)
  const [error, setError] = useState<Status>(null)
  if (!prefs) return null
  const grant = status?.grant ?? {
    readHistory: prefs['sources.readHistory'],
    onlineLookups: prefs['sources.onlineLookups'],
    asked: prefs['sources.grantAsked']
  }
  async function change(which: 'history' | 'lookups', on: boolean): Promise<void> {
    setBusy(which)
    setError(null)
    try {
      const next = await window.notula.sources.grant(which === 'history' ? { readHistory: on } : { onlineLookups: on })
      patchSourcesStatus({ grant: next })
    } catch (err) {
      setError({
        kind: 'error',
        text: isMissingHandler(err) ? 'This setting isn’t available in this build yet.' : 'Couldn’t change this setting. Try again.'
      })
    } finally {
      setBusy(null)
    }
  }
  return (
    <SettingsCard
      title="History and lookups"
      description="Notula asks about both the first time it offers a note. Local-only mode blocks every lookup."
    >
      <SettingsRow
        title="Read browser history"
        description="Find a video’s exact link in the playing browser’s history: YouTube and course sites only, the last 24 hours. Notula reads a temporary copy and deletes it."
        control={
          <Switch
            label="Read browser history"
            checked={grant.readHistory}
            busy={busy === 'history'}
            disabled={busy !== null}
            onChange={(on) => void change('history', on)}
          />
        }
      />
      <SettingsRow
        title="Online lookups"
        description="Ask YouTube for a video’s details and captions, only for videos you take notes on, link or look up."
        control={
          <Switch
            label="Online lookups"
            checked={grant.onlineLookups}
            busy={busy === 'lookups'}
            disabled={busy !== null}
            onChange={(on) => void change('lookups', on)}
          />
        }
      />
      {error ? (
        <div className="src-set__status">
          <StatusLine status={error} />
        </div>
      ) : null}
    </SettingsCard>
  )
}

function megabytes(bytes: number | null): string {
  return bytes && bytes > 0 ? `${Math.max(1, Math.round(bytes / 1_000_000))} MB` : 'about 18 MB'
}

function toolsHint(t: ToolsStatus | null, mode: string, unavailable: boolean): string {
  if (mode === 'off') return 'Off. Title search, video details and video captions aren’t available.'
  if (!t) return unavailable ? 'The lookup tool isn’t available in this build yet.' : 'Checking…'
  if (t.blockedByLocalOnly) return 'Blocked while local-only mode is on.'
  switch (t.state) {
    case 'absent':
      return mode === 'external'
        ? 'No copy of yt-dlp found on your PATH.'
        : `Not downloaded yet (${megabytes(t.sizeBytes)}, ${t.licence} licence). It’s needed for title search, video details and video captions.`
    case 'downloading': {
      const p = t.progress
      const pct = p && p.totalBytes ? Math.round((p.receivedBytes / p.totalBytes) * 100) : null
      return pct !== null ? `Downloading… ${pct}%` : 'Downloading…'
    }
    case 'updating':
      return 'Updating…'
    case 'ready': {
      const checked = t.lastCheckedAt ? ` Checked for updates ${new Date(t.lastCheckedAt).toLocaleDateString()}.` : ''
      return `Ready${t.version ? `, version ${t.version}` : ''}.${checked}`
    }
    case 'external':
      return `Using your copy${t.version ? ` (version ${t.version})` : ''}${t.path ? ` at ${t.path}` : ''}.`
    case 'failed':
      return `Couldn’t get yt-dlp${t.reason ? ` (${t.reason})` : ''}. Try again.`
    case 'off':
      return 'Off. Title search, video details and video captions aren’t available.'
  }
}

function useToolsStatus(): { tools: ToolsStatus | null; unavailable: boolean; set(t: ToolsStatus): void } {
  const { status } = useSourcesStatus()
  const [tools, setTools] = useState<ToolsStatus | null>(null)
  const [unavailable, setUnavailable] = useState(false)
  useEffect(() => {
    let alive = true
    void window.notula.sources
      .toolsStatus()
      .then((t) => alive && setTools(t))
      .catch((err: unknown) => {
        debugLog('sources:tools-status-failed', isMissingHandler(err) ? { missingHandler: true } : { code: parseError(err).code })
        if (alive) setUnavailable(true)
      })
    const off = window.notula.sources.onToolsProgress((t) => setTools(t))
    return () => {
      alive = false
      off()
    }
  }, [])
  return { tools: tools ?? status?.tools ?? null, unavailable: unavailable && !status, set: setTools }
}

export function ToolsRows(): JSX.Element | null {
  const prefs = usePrefs()
  const { status } = useSourcesStatus()
  const { tools, unavailable, set } = useToolsStatus()
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<Status>(null)
  if (!prefs) return null
  const mode = prefs['sources.ytDlp']
  const lookups = status?.grant.onlineLookups ?? prefs['sources.onlineLookups']
  const busy = tools?.state === 'downloading' || tools?.state === 'updating'
  const canDownload = mode === 'managed' && tools !== null && (tools.state === 'absent' || tools.state === 'failed') && !tools.blockedByLocalOnly

  async function download(): Promise<void> {
    setConfirming(false)
    setError(null)
    try {
      set(await window.notula.sources.toolsDownload({ confirmed: true }))
    } catch (err) {
      setError({
        kind: 'error',
        text: isMissingHandler(err)
          ? 'Downloading isn’t available in this build yet.'
          : parseError(err).code === 'invalid-input'
            ? 'Can’t download right now. Check that online lookups are on and local-only mode is off.'
            : 'Couldn’t start the download. Try again.'
      })
    }
  }

  return (
    <SettingsCard title="Lookup tool">
      <SettingsRow
        title="yt-dlp"
        description="The open-source tool Notula uses for title search, video details and video captions."
        control={
          <Select
            label="yt-dlp"
            value={mode}
            options={[
              { value: 'managed', label: 'Download when needed' },
              { value: 'external', label: 'Use my own copy' },
              { value: 'off', label: 'Off' }
            ]}
            onChange={(v) => setPrefs({ 'sources.ytDlp': v })}
          />
        }
      />
      <SettingsRow
        title="Status"
        description={toolsHint(tools, mode, unavailable)}
        control={
          canDownload ? (
            <button
              type="button"
              className="n-btn n-btn--sm"
              disabled={!lookups || busy}
              title={lookups ? undefined : 'Turn on online lookups first'}
              onClick={() => setConfirming(true)}
            >
              {tools?.state === 'failed' ? 'Try again' : 'Download…'}
            </button>
          ) : undefined
        }
      />
      {canDownload && !lookups ? <p className="src-set__note">Turn on online lookups above to download yt-dlp.</p> : null}
      {confirming ? (
        <div className="src-set__confirm" role="group" aria-label="Download yt-dlp">
          <p>
            Download yt-dlp ({megabytes(tools?.sizeBytes ?? null)}) from its official GitHub release? Notula checks it against the release’s
            published checksum before using it. It’s free software under the Unlicense.
          </p>
          <div className="src-set__confirm-actions">
            <button type="button" className="n-btn n-btn--sm" onClick={() => setConfirming(false)}>
              Cancel
            </button>
            <button type="button" className="n-btn n-btn--sm n-btn--primary" autoFocus onClick={() => void download()}>
              Download
            </button>
          </div>
        </div>
      ) : null}
      {error ? (
        <div className="src-set__status">
          <StatusLine status={error} />
        </div>
      ) : null}
    </SettingsCard>
  )
}

export function TranscriptRows(): JSX.Element | null {
  const prefs = usePrefs()
  if (!prefs) return null
  return (
    <SettingsCard title="Transcript and template">
      <SettingsRow
        title="Use video captions"
        description="Use a YouTube video’s own captions as the transcript when it has them. Needs online lookups."
        control={
          <Switch label="Use video captions" checked={prefs['sources.videoCaptions']} onChange={(on) => setPrefs({ 'sources.videoCaptions': on })} />
        }
      />
      <SettingsRow
        title="Lesson template"
        description="Use the lesson template for enhanced notes on new video and lesson notes."
        control={
          <Switch label="Lesson template" checked={prefs['sources.lessonTemplate']} onChange={(on) => setPrefs({ 'sources.lessonTemplate': on })} />
        }
      />
    </SettingsCard>
  )
}

export function StampRows(): JSX.Element | null {
  const prefs = usePrefs()
  if (!prefs) return null
  return (
    <SettingsCard title="Timestamps">
      <SettingsRow
        title="Stamp video positions"
        description="Mark each line you start typing with the video’s time. Press Ctrl+Alt+T to insert a timestamp anywhere."
        control={
          <Switch
            label="Stamp video positions"
            checked={prefs['sources.stampPositions']}
            onChange={(on) => setPrefs({ 'sources.stampPositions': on })}
          />
        }
      />
    </SettingsCard>
  )
}

export function FilingRows(): JSX.Element | null {
  const prefs = usePrefs()
  if (!prefs) return null
  return (
    <SettingsCard title="Folders">
      <SettingsRow
        title="File notes into folders"
        description="Put notes in a folder per course or playlist, and other videos in Videos ▸ the channel’s folder. Notula never renames or deletes your folders."
        control={<Switch label="File notes into folders" checked={prefs['sources.autoFile']} onChange={(on) => setPrefs({ 'sources.autoFile': on })} />}
      />
    </SettingsCard>
  )
}

function muteLabel(m: SourceMute): string {
  return m.startsWith('channel:') ? m.slice('channel:'.length) : m.slice('site:'.length)
}

function RemovableChips({ items, label, onRemove }: { items: string[]; label(item: string): string; onRemove(item: string): void }): JSX.Element {
  return (
    <ul className="src-set__chips">
      {items.map((item) => (
        <li key={item} className="src-set__chip">
          <span className="src-set__chip-text">{label(item)}</span>
          <button type="button" className="src-set__chip-remove" aria-label={`Remove ${label(item)}`} onClick={() => onRemove(item)}>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" aria-hidden="true">
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
        </li>
      ))}
    </ul>
  )
}

export function MuteRows(): JSX.Element | null {
  const prefs = usePrefs()
  if (!prefs) return null
  const muted = prefs['sources.muted']
  const channels = muted.filter((m) => m.startsWith('channel:'))
  const sites = muted.filter((m) => m.startsWith('site:'))
  const remove = (m: string): void => setPrefs({ 'sources.muted': muted.filter((x) => x !== m) })
  return (
    <SettingsCard title="Muted channels and sites">
      <SettingsRow
        title="Channels"
        description={channels.length ? 'No cards for videos from these channels.' : 'No muted channels. Mute one from a video card’s menu.'}
      />
      {channels.length ? <RemovableChips items={channels} label={(m) => muteLabel(m as SourceMute)} onRemove={remove} /> : null}
      <SettingsRow title="Sites" description={sites.length ? 'No cards for videos on these sites.' : 'No muted sites.'} />
      {sites.length ? <RemovableChips items={sites} label={(m) => muteLabel(m as SourceMute)} onRemove={remove} /> : null}
    </SettingsCard>
  )
}

/** A host from what was typed: `https://x.y/z` → `x.y`. Null when it isn't one. */
function hostOf(raw: string): string | null {
  let v = raw.trim().toLowerCase()
  if (!v) return null
  if (!/^[a-z][a-z0-9+.-]*:\/\//.test(v)) v = `https://${v}`
  try {
    const host = new URL(v).hostname.replace(/\.$/, '')
    return /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host) ? host : null
  } catch {
    return null
  }
}

export function CourseHostRows(): JSX.Element | null {
  const prefs = usePrefs()
  const [value, setValue] = useState('')
  const [invalid, setInvalid] = useState(false)
  const inputId = useId()
  if (!prefs) return null
  const hosts = prefs['sources.courseHosts']
  const full = hosts.length >= SOURCES_LIMITS.courseHosts
  function add(e: FormEvent): void {
    e.preventDefault()
    const host = hostOf(value)
    if (!host) {
      setInvalid(true)
      return
    }
    setInvalid(false)
    setValue('')
    if (!hosts.includes(host)) setPrefs({ 'sources.courseHosts': [...hosts, host].slice(0, SOURCES_LIMITS.courseHosts) })
  }
  return (
    <SettingsCard title="Course sites">
      <SettingsRow
        title="Extra course sites"
        description="Sites whose lessons Notula looks for in your browser history, such as a Circle community. YouTube, Udemy, Coursera, Hotmart, Kiwify and Memberkit are built in."
      />
      {hosts.length ? <RemovableChips items={hosts} label={(h) => h} onRemove={(h) => setPrefs({ 'sources.courseHosts': hosts.filter((x) => x !== h) })} /> : null}
      <form className="src-set__add" onSubmit={add}>
        <label className="src-set__add-label" htmlFor={inputId}>
          Add a site
        </label>
        <input
          id={inputId}
          className="n-input"
          placeholder="community.example.com"
          value={value}
          disabled={full}
          aria-invalid={invalid || undefined}
          aria-describedby={invalid || full ? `${inputId}-hint` : undefined}
          onChange={(e) => {
            setValue(e.target.value)
            setInvalid(false)
          }}
        />
        <button type="submit" className="n-btn n-btn--sm" disabled={full || !value.trim()}>
          Add
        </button>
      </form>
      {invalid || full ? (
        <p className="src-set__note src-set__note--error" id={`${inputId}-hint`}>
          {full ? `You can add up to ${SOURCES_LIMITS.courseHosts} sites. Remove one to add another.` : 'Enter a site like community.example.com.'}
        </p>
      ) : null}
    </SettingsCard>
  )
}
