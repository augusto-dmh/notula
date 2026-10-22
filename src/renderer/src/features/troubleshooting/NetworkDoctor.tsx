// SPDX-License-Identifier: Apache-2.0
// Troubleshooting ▸ Diagnostics ▸ "Network connectivity". Run check / Run again,
// `Checking N/M…`, the 20 s firewall hint, the
// audience question, results per feature, the diagnosis with steps, Copy network report and
// Copy IT request. Leaving the page cancels a run.

import { useEffect, useRef, useState, type JSX } from 'react'
import { parseError } from '@shared/errors'
import { NETDOCTOR_LIMITS, type NetDoctorCheck, type NetDoctorReport } from '@shared/types/netdoctor'
import { debugLog } from '../../app/platform'
import { showToast } from '../../app/toast'
import {
  attentionCount,
  diagnose,
  DIAGNOSIS,
  headline,
  isPass,
  isSupplementary,
  IT_STEPS,
  itRequestText,
  OUTCOME_TEXT,
  PILL,
  reportText,
  type Audience
} from './report'

type State =
  | { kind: 'idle' }
  | { kind: 'running'; completed: number; total: number | null; slow: boolean }
  | { kind: 'done'; report: NetDoctorReport }
  | { kind: 'failed' }

const AUDIENCE_KEY = 'notula-netdoctor-audience'

function readAudience(): Audience | null {
  try {
    const v = sessionStorage.getItem(AUDIENCE_KEY)
    return v === 'self' || v === 'it' ? v : null
  } catch {
    return null
  }
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    await window.notula.clipboard.writeText({ text })
  }
}

function AudienceQuestion({ value, onChange }: { value: Audience | null; onChange(a: Audience): void }): JSX.Element {
  const options: { value: Audience; title: string; hint: string }[] = [
    { value: 'self', title: 'I can change this network', hint: 'You’ll get steps to fix it yourself' },
    { value: 'it', title: 'Someone else manages this network', hint: 'You’ll get a summary to send to your IT team' }
  ]
  return (
    <div className="nd-audience" role="radiogroup" aria-label="Who manages this network?">
      <div className="nd-audience__question">Who manages this network?</div>
      <div className="nd-audience__options">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={value === o.value}
            className="nd-audience__option"
            onClick={() => onChange(o.value)}
          >
            <span className="nd-audience__title">{o.title}</span>
            <span className="nd-audience__hint">{o.hint}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

function CheckLine({ checks }: { checks: NetDoctorCheck[] }): JSX.Element {
  const first = checks[0]!
  const hosts = [...new Set(checks.map((c) => c.host))].join(', ')
  return (
    <li className="nd-check">
      <span className="nd-check__outcome">{OUTCOME_TEXT[first.outcome]}</span>
      <span className="nd-check__host">{hosts}</span>
      {first.detail ? <span className="nd-check__detail">{first.detail}</span> : null}
      {first.tlsIssuer ? <span className="nd-check__detail">Certificate issued by {first.tlsIssuer}</span> : null}
    </li>
  )
}

/** Failing checks of one feature, grouped by outcome text and host. */
function groupChecks(checks: NetDoctorCheck[]): NetDoctorCheck[][] {
  const groups = new Map<string, NetDoctorCheck[]>()
  for (const c of checks) {
    const k = `${c.outcome}|${c.host}`
    groups.set(k, [...(groups.get(k) ?? []), c])
  }
  return [...groups.values()]
}

function Results({ report, audience }: { report: NetDoctorReport; audience: Audience | null }): JSX.Element {
  const failingFeatures = report.features.filter((f) => f.status !== 'CONNECTION CHECKS PASSED')
  const passingFeatures = report.features.filter((f) => f.status === 'CONNECTION CHECKS PASSED')
  const diagnosis = diagnose(report)
  const copy = DIAGNOSIS[diagnosis]
  // A rejected key is the user's to fix, whoever manages the network.
  const it = audience === 'it' && diagnosis !== 'inconclusive' && diagnosis !== 'credentials'
  const allPassed = attentionCount(report) === 0

  return (
    <div className="nd-results">
      <div className={`nd-headline${allPassed ? ' nd-headline--ok' : ''}`}>{headline(report)}</div>
      {!allPassed ? <p className="nd-explanation">{copy.explanation}</p> : null}

      {failingFeatures.map((f) => {
        const checks = report.checks.filter((c) => c.feature === f.feature && !isSupplementary(c) && !isPass(c.status))
        return (
          <div key={f.feature} className="nd-feature">
            <div className="nd-feature__head">
              <span className="nd-feature__label">{f.label}</span>
              <span className={`nd-pill nd-pill--${PILL[f.status].replace(' ', '-')}`}>{PILL[f.status]}</span>
            </div>
            <p className="nd-feature__symptom">{f.symptom}</p>
            <ul className="nd-checks">
              {groupChecks(checks).map((g) => (
                <CheckLine key={`${g[0]!.outcome}|${g[0]!.host}`} checks={g} />
              ))}
            </ul>
          </div>
        )
      })}

      {!allPassed ? (
        <div className="nd-steps">
          <div className="nd-steps__title">Troubleshooting steps</div>
          <p className="nd-steps__intro">Try these steps in order, then run the check again.</p>
          <ol className="nd-steps__list">
            {(it ? IT_STEPS : copy.steps).map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
        </div>
      ) : null}

      {passingFeatures.length > 0 ? (
        <details className="nd-passed" open={allPassed}>
          <summary>
            Passed ({passingFeatures.length})
          </summary>
          <ul className="nd-checks">
            {passingFeatures.map((f) => (
              <li key={f.feature} className="nd-check">
                <span className="nd-check__outcome">{f.label}</span>
                <span className="nd-pill nd-pill--ok">ok</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      <div className="nd-actions">
        <button
          type="button"
          className="n-btn n-btn--sm"
          onClick={() =>
            void copyText(reportText(report)).then(
              () => showToast({ id: 'nd-copy', kind: 'success', title: 'Copied network report' }),
              () => showToast({ id: 'nd-copy', kind: 'error', title: 'Couldn’t copy the report' })
            )
          }
        >
          Copy network report
        </button>
        {it ? (
          <button
            type="button"
            className="n-btn n-btn--sm"
            onClick={() =>
              void copyText(itRequestText(report)).then(
                () => showToast({ id: 'nd-copy', kind: 'success', title: 'Copied IT request' }),
                () => showToast({ id: 'nd-copy', kind: 'error', title: 'Couldn’t copy the request' })
              )
            }
          >
            Copy IT request
          </button>
        ) : null}
      </div>
    </div>
  )
}

export function NetworkDoctorPanel(): JSX.Element {
  const [state, setState] = useState<State>({ kind: 'idle' })
  const [audience, setAudienceState] = useState<Audience | null>(readAudience)
  const runningRef = useRef(false)

  const setAudience = (a: Audience): void => {
    setAudienceState(a)
    try {
      sessionStorage.setItem(AUDIENCE_KEY, a)
    } catch {
      // per-window convenience only
    }
  }

  useEffect(
    () =>
      window.notula.netdoctor.onProgress(({ completed, total }) => {
        setState((s) => (s.kind === 'running' ? { ...s, completed, total } : s))
      }),
    []
  )

  // Leaving the page cancels a run.
  useEffect(
    () => () => {
      if (runningRef.current) void window.notula.netdoctor.cancel().catch(() => undefined)
    },
    []
  )

  useEffect(() => {
    if (state.kind !== 'running' || state.slow) return
    const t = setTimeout(() => setState((s) => (s.kind === 'running' ? { ...s, slow: true } : s)), NETDOCTOR_LIMITS.firewallHintMs)
    return () => clearTimeout(t)
  }, [state])

  async function run(): Promise<void> {
    runningRef.current = true
    setState({ kind: 'running', completed: 0, total: null, slow: false })
    try {
      const report = await window.notula.netdoctor.run()
      setState(report.cancelled ? { kind: 'idle' } : { kind: 'done', report })
    } catch (err) {
      const e = parseError(err)
      debugLog('netdoctor:run-failed', { code: e.code })
      setState({ kind: 'failed' })
    } finally {
      runningRef.current = false
    }
  }

  const running = state.kind === 'running'
  const showQuestion = running ? audience === null : state.kind === 'done' && attentionCount(state.report) > 0 && audience === null

  return (
    <div className="nd">
      <div className="settings-row nd__row">
        <div className="settings-row__text">
          <div className="settings-row__label">Network connectivity</div>
          <div className="settings-row__hint">Check that Notula can reach the services it needs.</div>
        </div>
        <div className="settings-row__control nd__controls">
          {running ? (
            <>
              <span className="nd-progress" role="status">
                <span className="n-spinner" aria-hidden="true" />
                {state.total ? `Checking ${state.completed}/${state.total}…` : 'Checking…'}
              </span>
              <button type="button" className="n-btn n-btn--sm n-btn--ghost" onClick={() => void window.notula.netdoctor.cancel()}>
                Cancel
              </button>
            </>
          ) : (
            <button type="button" className="n-btn n-btn--sm" onClick={() => void run()}>
              {state.kind === 'idle' ? 'Run check' : 'Run again'}
            </button>
          )}
        </div>
      </div>

      {running || state.kind !== 'idle' ? (
        <div className="nd__body">
          {running && state.slow ? (
            <p className="nd-hint">This is taking longer than usual. Some networks slow down Notula’s checks, so give it a minute.</p>
          ) : null}
          {state.kind === 'failed' ? (
            <p className="nd-failed" role="alert">
              The network check couldn’t finish. Check that you’re online, then try again.
            </p>
          ) : null}
          {showQuestion ? <AudienceQuestion value={audience} onChange={setAudience} /> : null}
          {state.kind === 'done' ? <Results report={state.report} audience={audience} /> : null}
          {state.kind === 'done' && audience !== null && attentionCount(state.report) > 0 ? (
            <button type="button" className="nd-audience-change" onClick={() => setAudienceState(null)}>
              {audience === 'it' ? 'IT manages this network' : 'You manage this network'} · Change
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
