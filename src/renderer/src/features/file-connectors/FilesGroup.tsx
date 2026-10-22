// SPDX-License-Identifier: Apache-2.0
// Settings ▸ Connectors ▸ Files: Google Drive and
// OneDrive on the calendar account's `files-read` grant, and Dropbox with the user's own app (its
// key goes to main once, through the integrations' set-credential; the flow runs on loopback
// port 47616).

import { useEffect, useState, type JSX } from 'react'
import { parseError } from '@shared/errors'
import type { FileConnectorKey, FileConnectorStatus } from '@shared/types/file-connectors'
import { navigateToSettings } from '../../app/navigation'
import { showToast } from '../../app/toast'
import { grantError, useGrantAction } from '../calendar-write/grants'
import { Group, Row } from '../settings/controls'
import { usePrefs } from '../settings/prefs-store'
import './file-connectors.css'

const NAMES: Record<FileConnectorKey, string> = { google_drive: 'Google Drive', onedrive: 'OneDrive', dropbox: 'Dropbox' }
const HINTS: Record<FileConnectorKey, string> = {
  google_drive: 'Search and read your Drive files and Google Docs in chat. Read-only.',
  onedrive: 'Search and read your OneDrive files in chat. Read-only.',
  dropbox: 'Search and read your Dropbox files in chat. Read-only.'
}
const NEEDS_CALENDAR = 'Connect your Google or Microsoft calendar first. Notula adds file access to that account.'

function useFileStatus(): { list: FileConnectorStatus[] | null; reload(): void } {
  const [list, setList] = useState<FileConnectorStatus[] | null>(null)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let alive = true
    window.notula.connectors
      .listFilesStatus()
      .then((l) => alive && setList(l))
      .catch(() => alive && setList([]))
    return () => {
      alive = false
    }
  }, [tick])
  useEffect(() => window.notula.calendar.onChanged(() => setTick((t) => t + 1)), [])
  useEffect(
    () =>
      window.notula.integrations.onChanged((e) => {
        if (e.provider === 'dropbox') setTick((t) => t + 1)
      }),
    []
  )
  return { list, reload: () => setTick((t) => t + 1) }
}

function GrantConnector({ s, reload }: { s: FileConnectorStatus; reload(): void }): JSX.Element {
  const { busyKey, run } = useGrantAction()
  const busy = busyKey !== null
  const name = NAMES[s.connector]
  if (s.state === 'needs-calendar') {
    return (
      <Row label={name} hint={NEEDS_CALENDAR}>
        <button type="button" className="n-btn n-btn--sm" onClick={() => navigateToSettings('calendar')}>
          Calendar settings
        </button>
      </Row>
    )
  }
  const on = s.state === 'connected' || s.state === 'reconnect'
  return (
    <Row label={name} hint={on ? `${s.state === 'reconnect' ? 'Needs reconnecting · ' : 'Connected · '}${s.accountLabel ?? ''}` : HINTS[s.connector]}>
      <button
        type="button"
        className={`n-btn n-btn--sm${on ? ' n-btn--ghost' : ''}`}
        disabled={busy || !s.sourceId}
        onClick={() => s.sourceId && void run(s.sourceId, 'files-read', !on).then(() => reload())}
      >
        {busy ? 'Connecting...' : on ? 'Disconnect' : 'Connect'}
      </button>
    </Row>
  )
}

function DropboxConnector({ s, reload }: { s: FileConnectorStatus; reload(): void }): JSX.Element {
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState<'save' | 'connect' | 'remove' | null>(null)
  const [open, setOpen] = useState(false)
  const connected = s.state === 'connected'

  const connect = async (): Promise<void> => {
    setBusy(key.trim() ? 'save' : 'connect')
    try {
      if (key.trim()) {
        await window.notula.integrations.setCredential({ provider: 'dropbox', kind: 'oauth-client', value: key.trim() })
        setKey('')
      }
      setBusy('connect')
      await window.notula.integrations.connectOAuth({ provider: 'dropbox' })
      showToast({ kind: 'success', title: 'Dropbox connected' })
      setOpen(false)
    } catch (err) {
      const msg = parseError(err).message
      showToast({ id: 'dropbox-connect', kind: 'error', title: /No handler registered/i.test(msg) ? 'Dropbox sign-in isn’t available in this build yet.' : grantError(err) })
    } finally {
      setBusy(null)
      reload()
    }
  }
  const cancel = (): void => void window.notula.integrations.cancelOAuth({ provider: 'dropbox' }).catch(() => undefined)
  const remove = async (): Promise<void> => {
    setBusy('remove')
    try {
      await window.notula.integrations.removeCredential({ provider: 'dropbox' })
    } catch (err) {
      showToast({ kind: 'error', title: parseError(err).message })
    } finally {
      setBusy(null)
      reload()
    }
  }

  if (connected) {
    return (
      <Row label="Dropbox" hint={`Connected · ${s.accountLabel ?? 'your Dropbox'}`}>
        <button type="button" className="n-btn n-btn--sm n-btn--ghost" disabled={busy !== null} onClick={() => void remove()}>
          {busy === 'remove' ? 'Disconnecting…' : 'Disconnect'}
        </button>
      </Row>
    )
  }
  return (
    <Row label="Dropbox" hint={HINTS.dropbox} stacked={open}>
      {!open ? (
        <button type="button" className="n-btn n-btn--sm" onClick={() => setOpen(true)}>
          Set up
        </button>
      ) : (
        <div className="fc-setup">
          <ol className="fc-steps">
            <li>
              Go to dropbox.com/developers/apps, click <strong>Create app</strong>, choose <strong>Scoped access</strong> and <strong>Full Dropbox</strong>, and name it (for example
              Notula-&lt;your name&gt;).
            </li>
            <li>
              On <strong>Permissions</strong>, tick <code>files.metadata.read</code>, <code>files.content.read</code> and <code>account_info.read</code>, then <strong>Submit</strong>.
            </li>
            <li>
              On <strong>Settings</strong>, under <strong>OAuth 2</strong> ▸ <strong>Redirect URIs</strong>, add <code>http://127.0.0.1:47616/dropbox/callback</code>.
            </li>
            <li>
              Copy the <strong>App key</strong> and paste it below. (No app secret is needed.)
            </li>
          </ol>
          <div className="fc-key">
            <input className="n-input" placeholder="App key" aria-label="Dropbox App key" value={key} disabled={busy !== null} onChange={(e) => setKey(e.target.value)} autoComplete="off" spellCheck={false} />
            {busy === 'connect' ? (
              <button type="button" className="n-btn n-btn--sm" onClick={cancel}>
                Cancel
              </button>
            ) : null}
            <button type="button" className="n-btn n-btn--sm n-btn--primary" disabled={busy !== null} onClick={() => void connect()}>
              {busy ? 'Connecting...' : 'Connect Dropbox'}
            </button>
          </div>
          {busy === 'connect' ? <p className="fc-muted">Finish signing in to Dropbox in your browser.</p> : null}
        </div>
      )}
    </Row>
  )
}

/** The "Files" group under the MCP card, while `connectors.files.enabled` is on. */
export function FileConnectorsGroup(): JSX.Element | null {
  const prefs = usePrefs()
  const { list, reload } = useFileStatus()
  if (!prefs?.['connectors.files.enabled'] || !list) return null
  return (
    <Group title="Files" description="Let chat search and read your files. Notula only reads; it never changes or shares them.">
      {list.map((s) => (s.connector === 'dropbox' ? <DropboxConnector key={s.connector} s={s} reload={reload} /> : <GrantConnector key={s.connector} s={s} reload={reload} />))}
      {prefs['privacy.localOnly'] ? <Row label="Paused" hint="File connectors are off while Local-only mode is on." /> : <></>}
    </Group>
  )
}
