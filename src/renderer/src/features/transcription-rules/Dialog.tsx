// SPDX-License-Identifier: Apache-2.0
// The transcription-rules decision, in the main window, and its compact banner beside the
// bubble. Main holds or blocks the start; this only shows the decision and answers it through
// `transcription-rules:resolve`. A resolved push (any window) closes it.
// The host also shows the automation banner on a note that has a send waiting for
// confirmation, since the note page has no mount point for it.

import { useEffect, useState, type JSX } from 'react'
import type { AutomationRun } from '@shared/types/automations'
import { RULE_DIALOG_COPY as C, type RuleDecision } from '@shared/types/transcription-rules'
import { useRoute } from '../../app/navigation'
import { showToast } from '../../app/toast'
import { startTranscription } from '../capture'
import { errorText, Modal } from '../automations/ui'
import './rules.css'

interface View extends RuleDecision {
  kind: 'block' | 'override' | 'confirm' | 'none'
  always: boolean
  active: boolean
  concurrentTitle: string | null
  concurrent: boolean
  resolved?: boolean
  retryStart?: boolean
}

let current: View | null = null
const listeners = new Set<() => void>()
let started = false

function set(v: View | null): void {
  current = v
  for (const l of listeners) l()
}

function start(): void {
  if (started) return
  started = true
  window.notula.transcriptionRules.onDecision((raw) => {
    const d = raw as View
    if (d.resolved || d.outcome === 'allow') {
      if (current && current.decisionKey === d.decisionKey) set(null)
      if (d.retryStart && window.location.hash.indexOf('/bubble') < 0) void startTranscription(d.noteId).catch(() => undefined)
      return
    }
    set(d)
  })
}

function useDecision(): View | null {
  const [, force] = useState(0)
  useEffect(() => {
    start()
    const l = (): void => force((n) => n + 1)
    listeners.add(l)
    return () => {
      listeners.delete(l)
    }
  }, [])
  return current
}

function resolve(d: View, choice: 'confirm' | 'decline'): void {
  set(null)
  void window.notula.transcriptionRules.resolve({ noteId: d.noteId, decisionKey: d.decisionKey, choice }).catch((err: unknown) => showToast({ kind: 'error', title: errorText(err) }))
}

function copyFor(d: View): { title: string; description: string; decline: string; confirm: string | null } {
  if (d.kind === 'block') return { title: d.active ? C.block.titleActive : C.block.title, description: C.block.description, decline: C.block.decline, confirm: null }
  if (d.kind === 'override') return { title: C.override.title, description: C.override.description, decline: C.override.decline, confirm: C.override.confirm }
  return { title: d.always ? C.confirm.titleAlways : C.confirm.title, description: C.confirm.description, decline: C.confirm.decline, confirm: C.confirm.confirm }
}

function concurrentLine(d: View): string | null {
  if (!d.concurrent) return null
  return d.concurrentTitle ? C.concurrentLine.replace('<title>', d.concurrentTitle) : C.concurrentLineNoTitle
}

function Body({ d }: { d: View }): JSX.Element {
  const many = d.presentation.length > 1
  const line = concurrentLine(d)
  const copy = copyFor(d)
  const text = (p: View['presentation'][number]): JSX.Element => (
    <>
      {p.text}
      {p.link && /^https?:\/\//i.test(p.link.url) ? (
        <>
          {' '}
          <a href={p.link.url} target="_blank" rel="noreferrer">
            {p.link.label}
          </a>
        </>
      ) : null}
    </>
  )
  return (
    <>
      <p className="tr-header">{many ? C.headerMany : C.headerOne}</p>
      {many ? (
        <ul className="tr-texts">
          {d.presentation.map((p, i) => (
            <li key={i}>{text(p)}</li>
          ))}
        </ul>
      ) : d.presentation[0] ? (
        <p className="tr-text">{text(d.presentation[0])}</p>
      ) : null}
      {d.kind === 'block' ? <p>{line ?? copy.description}</p> : null}
      {d.kind === 'override' ? <p>{line ? `${line} ${copy.description}` : copy.description}</p> : null}
      {d.kind === 'confirm' ? (
        <>
          {line ? <p>{line}</p> : null}
          <p>{copy.description}</p>
        </>
      ) : null}
    </>
  )
}

function AutomationBanner(): JSX.Element | null {
  const route = useRoute()
  const noteId = route.path.startsWith('/meeting/') ? (route.params['id'] ?? null) : null
  const [runs, setRuns] = useState<{ run: AutomationRun; to: string; sensitive: boolean }[]>([])
  useEffect(() => {
    if (!noteId) {
      setRuns([])
      return
    }
    let alive = true
    const load = async (): Promise<void> => {
      try {
        const [list, rules, eps] = await Promise.all([
          window.notula.automations.listRuns({ noteId, status: 'needs_confirmation', limit: 10 }),
          window.notula.automations.list(),
          window.notula.webhooks.list()
        ])
        const out = list.map((run) => {
          const a = rules.find((r) => r.id === run.rule_id)?.actions[0]
          const ep = a?.type === 'post_webhook' ? eps.find((e) => e.id === a.webhook_id) : undefined
          return { run, to: ep?.url_label.replace(/^https?:\/\//, '') ?? 'a webhook', sensitive: run.reason === 'sensitive' }
        })
        if (alive) setRuns(out)
      } catch {
        if (alive) setRuns([])
      }
    }
    void load()
    const off = window.notula.automations.onChanged(() => void load())
    return () => {
      alive = false
      off()
    }
  }, [noteId])
  const first = runs[0]
  if (!first) return null
  const answer = (choice: 'send' | 'dismiss'): void => {
    setRuns((r) => r.slice(1))
    void window.notula.automations
      .resolveRun({ runId: first.run.id, choice })
      .then((r) => showToast({ kind: r.status === 'failed' ? 'error' : 'success', title: r.status === 'executed' ? 'Sent' : r.status === 'dismissed' ? 'Not sent' : (r.reason ?? 'Not sent') }))
      .catch((err: unknown) => showToast({ kind: 'error', title: errorText(err) }))
  }
  return (
    <div className="tr-automation-banner" role="status">
      <span>
        An automation wants to send this note to {first.to}.{first.sensitive ? ' It may contain sensitive content.' : ''}
      </span>
      <button type="button" className="n-btn n-btn--sm n-btn--primary" onClick={() => answer('send')}>
        Send
      </button>
      <button type="button" className="n-btn n-btn--sm" onClick={() => answer('dismiss')}>
        Don’t send
      </button>
    </div>
  )
}

export function TranscriptionRulesDialogHost(): JSX.Element | null {
  const d = useDecision()
  return (
    <>
      <AutomationBanner />
      {d ? (
        <Modal
          title={copyFor(d).title}
          onClose={() => resolve(d, 'decline')}
          footer={
            <>
              <button type="button" className="n-btn" onClick={() => resolve(d, 'decline')}>
                {copyFor(d).decline}
              </button>
              {copyFor(d).confirm ? (
                <button type="button" className={`n-btn ${d.kind === 'override' ? 'n-btn--danger' : 'n-btn--primary'}`} onClick={() => resolve(d, 'confirm')}>
                  {copyFor(d).confirm}
                </button>
              ) : null}
            </>
          }
        >
          <Body d={d} />
        </Modal>
      ) : null}
    </>
  )
}

/** The bubble's compact banner: opens the note, where the decision is shown in full. */
export function TranscriptionRulesBubbleBanner(): JSX.Element | null {
  const d = useDecision()
  if (!d) return null
  return (
    <button type="button" className="tr-bubble-banner" title={copyFor(d).title} onClick={() => window.notula.bubble.openNote({ noteId: d.noteId })}>
      {d.kind === 'block' ? 'Notula can’t take notes here' : 'Check your rules before taking notes'}
    </button>
  )
}
