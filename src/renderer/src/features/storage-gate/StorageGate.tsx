// SPDX-License-Identifier: Apache-2.0
// The recovery screen. Notula never wipes user data on a storage failure, so until
// storage is first `ready`, nothing else renders: the screen explains what happened and
// offers only non-destructive actions.
// "Start fresh" moves the database files aside, and asks first.
//
// Once the app has been shown, a later failure (the storage process exits, or a
// query finds corruption) never unmounts it: the app stays mounted but inert
// behind the same screen as a blocking overlay. Capture and transcription keep
// running, the editor keeps its unsent updates, and both catch up after Retry.

import { Fragment, useEffect, useRef, useState, type JSX, type ReactNode } from 'react'
import { parseError } from '@shared/errors'
import type { RecoveryAction, StorageState, StorageStatus } from '@shared/types/storage'
import { navigate } from '../../app/navigation'
import { showToast } from '../../app/toast'
import { stopTranscription, useCaptureState } from '../capture'
import './storage-gate.css'

/** The damaged-rooms notice shows once per renderer. */
let damagedShown = false

type RecoveryState = Exclude<StorageState, 'ready' | 'starting'>

/** Where the key's protection lives, in the words of each OS (Windows has no keychain). */
const KEY_STORE_HINT = /Mac/i.test(navigator.userAgent)
  ? 'If your keychain is locked, unlock it and try again.'
  : /Windows/i.test(navigator.userAgent)
    ? 'The key opens only for the Windows account that created it: sign in as that user, or make sure this data ' +
      'folder wasn’t copied from another computer, and try again.'
    : 'If your keyring is locked, unlock it and try again.'

interface Copy {
  title: string
  body: string
  actions: RecoveryAction[]
}

const COPY: Record<RecoveryState, Copy> = {
  'migration-failed': {
    title: 'Notula couldn’t update its database',
    body:
      'This version of Notula needs to update how your notes are stored, and the update didn’t finish. ' +
      'Nothing was changed: your notes are as they were, and a backup was saved before the update started.',
    actions: ['retry', 'export-copy', 'open-data-folder', 'start-fresh']
  },
  'version-ahead': {
    title: 'Update Notula to open your notes',
    body:
      'Your notes were last opened by a newer version of Notula. Install the latest version to open them. ' +
      'Notula hasn’t changed anything.',
    actions: ['export-copy', 'open-data-folder']
  },
  'key-unavailable': {
    title: 'Notula can’t unlock your notes',
    body:
      'Your notes are encrypted with a key kept in this computer’s secure storage, and that key couldn’t be read. ' +
      `${KEY_STORE_HINT} If Notula was closed within about ten seconds of its very first start, its key may not ` +
      'have been saved yet, and notes from those first seconds can’t be unlocked.',
    actions: ['retry', 'export-copy', 'open-data-folder', 'start-fresh']
  },
  'open-failed': {
    title: 'Notula can’t open your notes',
    body: 'The notes database couldn’t be opened. Notula hasn’t changed or deleted anything.',
    actions: ['retry', 'export-copy', 'open-data-folder', 'start-fresh']
  },
  'encryption-unavailable': {
    title: 'Secure storage isn’t available',
    body:
      'Notula encrypts your notes with a key protected by your operating system, and that protection isn’t ' +
      'available right now. Notula never stores notes unencrypted.',
    actions: ['retry', 'open-data-folder']
  }
}

/**
 * The status detail as a sentence plus, apart, the raw database error: a rolled-back
 * migration's cause, or a trailing `(SQLITE_…)` code.
 */
function presentDetail(detail: string): { summary: string; technical: string | null } {
  const rolledBack = /^(.*? failed and was rolled back): (.+)$/s.exec(detail)
  if (rolledBack?.[1] && rolledBack[2]) return { summary: `${rolledBack[1]}.`, technical: rolledBack[2] }
  const coded = /^(.*?)\s*\((SQLITE_[A-Z0-9_]+)\)\.?$/s.exec(detail)
  if (coded?.[1] && coded[2]) return { summary: /[.!?]$/.test(coded[1]) ? coded[1] : `${coded[1]}.`, technical: coded[2] }
  return { summary: detail, technical: null }
}

/**
 * A long path that wraps at its separators rather than mid-name: each segment is one
 * inline box (it breaks inside only when it is wider than the line on its own).
 */
function PathText({ path }: { path: string }): JSX.Element {
  const parts = path.split(/(?<=[\\/])/)
  return (
    <>
      {parts.map((part, i) => (
        <Fragment key={i}>
          <span className="storage-gate__segment">{part}</span>
          {i < parts.length - 1 ? <wbr /> : null}
        </Fragment>
      ))}
    </>
  )
}

const ACTION_LABEL: Record<RecoveryAction, string> = {
  retry: 'Try again',
  'export-copy': 'Export a copy…',
  'open-data-folder': 'Open data folder',
  'start-fresh': 'Start fresh…'
}

export function StorageGate({ children }: { children: ReactNode }): JSX.Element {
  const [status, setStatus] = useState<StorageStatus | null>(null)
  /** The app has been shown in this renderer. */
  const [shown, setShown] = useState(false)
  /** Bumped after Start fresh from the overlay: the app remounts on the new database. */
  const [generation, setGeneration] = useState(0)
  const ready = status?.state === 'ready'

  useEffect(() => {
    if (ready) setShown(true)
  }, [ready])

  // Rooms with quarantined Yjs rows: the rows were kept aside,
  // never deleted, and the rest of each note opened. Said once per app run.
  const damaged = ready ? (status?.damagedRooms ?? 0) : 0
  useEffect(() => {
    if (damaged <= 0 || damagedShown) return
    damagedShown = true
    showToast({
      id: 'storage-damaged-rooms',
      title: damaged === 1 ? 'Part of a note couldn’t be read' : `Parts of ${damaged} notes couldn’t be read`,
      description: 'Notula kept the unreadable edits aside, unchanged, and opened everything else.',
      durationMs: 10_000
    })
  }, [damaged])

  useEffect(() => {
    let alive = true
    let pushed = false
    const off = window.notula.storage.onStatusChanged((s) => {
      pushed = true
      if (alive) setStatus(s)
    })
    window.notula.storage
      .getStatus()
      .then((s) => {
        if (alive && !pushed) setStatus(s)
      })
      .catch((err: unknown) => {
        if (alive && !pushed) {
          setStatus({ state: 'open-failed', detail: parseError(err).message, dataPath: '', expectedVersion: 0 })
        }
      })
    return () => {
      alive = false
      off()
    }
  }, [])

  function onRecovered(action: RecoveryAction, s: StorageStatus): void {
    setStatus(s)
    // The app on screen shows the old database's notes; start over on the new one.
    if (action === 'start-fresh' && s.state === 'ready' && shown) {
      setGeneration((g) => g + 1)
      navigate('/', { replace: true })
    }
  }

  const overlay = shown && !ready
  let screen: JSX.Element | null = null
  if (!status || status.state === 'starting') {
    screen = overlay ? (
      <div className="storage-gate storage-gate--overlay storage-gate--loading" aria-busy="true" role="status">
        <p className="storage-gate__panel">Reopening your notes…</p>
      </div>
    ) : (
      <div className="storage-gate storage-gate--loading" aria-busy="true" />
    )
  } else if (status.state !== 'ready') {
    screen = <RecoveryScreen status={status} state={status.state} overlay={overlay} onRecovered={onRecovered} />
  }

  // The app keeps one position in the tree, so a status change never remounts it.
  return (
    <>
      {ready || shown ? (
        <div className="storage-gate__app" inert={!ready}>
          <Fragment key={generation}>{children}</Fragment>
        </div>
      ) : null}
      {screen}
    </>
  )
}

function RecoveryScreen({
  status,
  state,
  overlay,
  onRecovered
}: {
  status: StorageStatus
  state: RecoveryState
  /** Shown over the app after a mid-session failure. */
  overlay: boolean
  onRecovered(action: RecoveryAction, s: StorageStatus): void
}): JSX.Element {
  const copy = COPY[state]
  const detail = status.detail ? presentDetail(status.detail) : null
  const [busy, setBusy] = useState<RecoveryAction | null>(null)
  const [error, setError] = useState<string | null>(null)
  const confirmRef = useRef<HTMLDialogElement>(null)
  const transcribing = useCaptureState().transcribingNoteId !== null
  // A new database would not hold the note being transcribed: stop first.
  const actions = transcribing ? copy.actions.filter((a) => a !== 'start-fresh') : copy.actions

  async function run(action: RecoveryAction): Promise<void> {
    setBusy(action)
    setError(null)
    try {
      onRecovered(action, await window.notula.storage.recover({ action }))
    } catch (err) {
      setError(parseError(err).message)
    } finally {
      setBusy(null)
    }
  }

  function onAction(action: RecoveryAction): void {
    const dialog = confirmRef.current
    if (action !== 'start-fresh') void run(action)
    else if (dialog) {
      // Escape keeps the previous returnValue; only an explicit confirm may start fresh.
      dialog.returnValue = ''
      dialog.showModal()
    }
  }

  return (
    <main
      className={overlay ? 'storage-gate storage-gate--overlay' : 'storage-gate'}
      aria-labelledby="storage-gate-title"
      {...(overlay ? { role: 'alertdialog', 'aria-modal': true } : {})}
    >
      <section className="storage-gate__panel">
        <h1 id="storage-gate-title">{copy.title}</h1>
        <p>{copy.body}</p>
        {transcribing ? (
          <div className="storage-gate__capture" role="status">
            <p>
              Transcription is still running. Notula keeps the transcript in memory and saves it as soon as your notes
              open again. Stop transcription before starting fresh.
            </p>
            <button type="button" className="storage-gate__button" onClick={() => stopTranscription('toggle_off')}>
              Stop transcript
            </button>
          </div>
        ) : null}

        <dl className="storage-gate__facts">
          {detail ? (
            <>
              <dt>What happened</dt>
              <dd>
                {detail.summary}
                {detail.technical ? (
                  <details className="storage-gate__tech">
                    <summary>Technical details</summary>
                    <code>{detail.technical}</code>
                  </details>
                ) : null}
              </dd>
            </>
          ) : null}
          {status.backupPath ? (
            <>
              <dt>Backup</dt>
              <dd className="storage-gate__path">
                <PathText path={status.backupPath} />
              </dd>
            </>
          ) : null}
          {state === 'version-ahead' && status.schemaVersion !== undefined ? (
            <>
              <dt>Database version</dt>
              <dd>
                {status.schemaVersion} (this version of Notula supports {status.expectedVersion})
              </dd>
            </>
          ) : null}
          {status.dataPath ? (
            <>
              <dt>Data folder</dt>
              <dd className="storage-gate__path">
                <PathText path={status.dataPath} />
              </dd>
            </>
          ) : null}
        </dl>

        <div className="storage-gate__actions">
          {actions.map((action) => (
            <button
              key={action}
              type="button"
              className={action === 'start-fresh' ? 'storage-gate__button storage-gate__button--danger' : 'storage-gate__button'}
              disabled={busy !== null}
              aria-busy={busy === action}
              onClick={() => onAction(action)}
            >
              {ACTION_LABEL[action]}
            </button>
          ))}
        </div>
        {actions.includes('export-copy') ? (
          <p className="storage-gate__note">
            An exported copy stays encrypted. It includes the key files, so it opens only on this computer, signed in as
            the same user.
          </p>
        ) : null}
        {error ? (
          <p className="storage-gate__error" role="alert">
            {error}
          </p>
        ) : null}
      </section>

      <dialog
        ref={confirmRef}
        className="storage-gate__confirm"
        aria-labelledby="storage-gate-confirm-title"
        onClose={() => {
          if (confirmRef.current?.returnValue === 'confirm') void run('start-fresh')
        }}
      >
        <form method="dialog">
          <h2 id="storage-gate-confirm-title">Start with an empty database?</h2>
          <p>
            Notula will move the current database files into a “recovered” folder inside its data folder and create a
            new, empty database. Nothing is deleted, but notes in the moved files won’t appear in Notula.
          </p>
          <div className="storage-gate__actions">
            <button type="submit" value="cancel" className="storage-gate__button" autoFocus>
              Cancel
            </button>
            <button type="submit" value="confirm" className="storage-gate__button storage-gate__button--danger">
              Move files and start fresh
            </button>
          </div>
        </form>
      </dialog>
    </main>
  )
}
