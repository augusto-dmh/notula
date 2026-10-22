// SPDX-License-Identifier: Apache-2.0
// Settings ▸ Troubleshooting. One `Diagnostics` section, rows in
// order: Network connectivity, Export logs, Show logs folder, Record performance trace (10 s),
// System log capture (macOS), Detailed logging. Nothing here is ever uploaded.

import { useEffect, useState, type JSX } from 'react'
import { parseError } from '@shared/errors'
import type { UnifiedLogStatus } from '@shared/types/diagnostics'
import { debugLog, isMac } from '../../app/platform'
import { showToast } from '../../app/toast'
import { Switch } from '../settings/controls'
import { setPrefs, usePrefs } from '../settings/prefs-store'
import { NetworkDoctorPanel } from './NetworkDoctor'
import { useTraceRecording } from './trace-state'
import './troubleshooting.css'

function Row({ title, hint, children }: { title: string; hint: string; children: JSX.Element | JSX.Element[] }): JSX.Element {
  return (
    <div className="settings-row">
      <div className="settings-row__text">
        <div className="settings-row__label">{title}</div>
        <div className="settings-row__hint">{hint}</div>
      </div>
      <div className="settings-row__control ts-controls">{children}</div>
    </div>
  )
}

function ExportLogsRow(): JSX.Element {
  const [busy, setBusy] = useState(false)
  async function exportLogs(): Promise<void> {
    setBusy(true)
    try {
      const res = await window.notula.diag.exportLogs()
      if ('path' in res) showToast({ id: 'logs-exported', kind: 'success', title: 'Logs exported', description: res.path })
    } catch (err) {
      debugLog('diag:export-logs-failed', { code: parseError(err).code })
      showToast({ id: 'logs-exported', kind: 'error', title: 'Couldn’t export logs' })
    } finally {
      setBusy(false)
    }
  }
  return (
    <Row title="Export logs" hint="Save Notula’s logs to a zip file you can share. Nothing is uploaded.">
      <button type="button" className="n-btn n-btn--sm" disabled={busy} onClick={() => void exportLogs()}>
        {busy ? 'Exporting…' : 'Export…'}
      </button>
    </Row>
  )
}

function TraceRow(): JSX.Element {
  const recording = useTraceRecording()
  async function start(): Promise<void> {
    try {
      const res = await window.notula.diag.startTrace()
      if (!res.ok) showToast({ id: 'trace', kind: 'error', title: 'Couldn’t save the trace. Try recording again.' })
    } catch (err) {
      if (parseError(err).code !== 'busy') showToast({ id: 'trace', kind: 'error', title: 'Couldn’t save the trace. Try recording again.' })
    }
  }
  return (
    <Row
      title="Record performance trace (10 s)"
      hint="Records ten seconds of what Notula is doing, for diagnosing slowness. Saved on this computer and shown in its folder."
    >
      <button type="button" className="n-btn n-btn--sm" disabled={recording} onClick={() => void start()}>
        {recording ? 'Recording…' : 'Record'}
      </button>
    </Row>
  )
}

function UnifiedLogRow(): JSX.Element {
  const [status, setStatus] = useState<UnifiedLogStatus | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    void window.notula.diag.unifiedLogStatus().then(setStatus).catch(() => undefined)
    // The Help menu toggles it too: read again when the window comes back.
    const onFocus = (): void => void window.notula.diag.unifiedLogStatus().then(setStatus).catch(() => undefined)
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [])
  async function toggle(): Promise<void> {
    setBusy(true)
    try {
      setStatus(await window.notula.diag.toggleUnifiedLog())
    } catch (err) {
      debugLog('diag:unified-log-failed', { code: parseError(err).code })
      showToast({ id: 'unified-log', kind: 'error', title: 'Couldn’t start the system log capture.' })
    } finally {
      setBusy(false)
    }
  }
  return (
    <Row title="System log capture" hint="Record macOS audio and screen-capture logs to a file while you reproduce a problem.">
      <button type="button" className="n-btn n-btn--sm" disabled={busy || status === null} onClick={() => void toggle()}>
        {status?.running ? 'Stop' : 'Start'}
      </button>
    </Row>
  )
}

export function TroubleshootingSettings(): JSX.Element {
  const prefs = usePrefs()
  return (
    <section className="settings-group">
      <h2 className="settings-group__title">Diagnostics</h2>
      <div className="settings-card ts-card">
        <NetworkDoctorPanel />
        <ExportLogsRow />
        <Row title="Show logs folder" hint="Open the folder where Notula keeps its log files.">
          <button type="button" className="n-btn n-btn--sm" onClick={() => window.notula.diag.showLogsFolder()}>
            Show folder
          </button>
        </Row>
        <TraceRow />
        {isMac ? <UnifiedLogRow /> : <></>}
        <Row title="Detailed logging" hint="Write extra detail to Notula’s log file. Turn it on while you reproduce a problem, then off again.">
          <Switch
            label="Detailed logging"
            checked={prefs?.['diagnostics.verboseLogging'] ?? false}
            disabled={!prefs}
            onChange={(next) => setPrefs({ 'diagnostics.verboseLogging': next })}
          />
        </Row>
      </div>
    </section>
  )
}
