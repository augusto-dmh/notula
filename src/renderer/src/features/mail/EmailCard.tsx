// SPDX-License-Identifier: Apache-2.0
// The chat email card: a draft from
// `draftFollowUpEmail` the user edits, then sends (after a 10 s countdown they can undo) or saves to
// their mailbox's drafts. The tool never sends by itself.

import { useEffect, useRef, useState, type JSX } from 'react'
import type { EmailDraftBlock } from '@shared/types/workflow-blocks'
import type { ToolCardProps } from '../../app/slots'
import { showToast } from '../../app/toast'
import { IconAlert } from '../../app/icons'
import { blockIdOf, useBlock } from '../blocks/useBlock'
import { openExternal } from '../integrations/store'
import { IconMail, SIGNATURE_NOTE } from './shared'
import './mail.css'

const SAVE_FAILED = 'Couldn’t save the email draft'
const UNDO_S = 10

function splitList(v: string): string[] {
  return v
    .split(/[\s,;]+/)
    .map((x) => x.trim())
    .filter(Boolean)
}

function ListInput({ label, value, onChange, disabled }: { label: string; value: string[]; onChange(v: string[]): void; disabled: boolean }): JSX.Element {
  const [text, setText] = useState(value.join(', '))
  useEffect(() => setText(value.join(', ')), [value])
  return (
    <label className="ml-line">
      <span className="ml-line__label">{label}</span>
      <input className="ml-line__input" value={text} disabled={disabled} aria-label={label} onChange={(e) => setText(e.target.value)} onBlur={() => onChange(splitList(text))} />
    </label>
  )
}

export function EmailDraftCard({ toolCall }: ToolCardProps): JSX.Element {
  const blockId = blockIdOf(toolCall.result)
  const h = useBlock<EmailDraftBlock>(blockId, 'email', SAVE_FAILED)
  const [countdown, setCountdown] = useState<number | null>(null)
  const [showCc, setShowCc] = useState(false)
  const tick = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => () => {
    if (tick.current) clearInterval(tick.current)
  }, [])

  if (toolCall.error) {
    return (
      <div className="ml-card ml-card--quiet">
        <div className="ml-head">
          <IconMail />
          <span>Couldn’t draft the email. Try again.</span>
        </div>
        <p className="ml-msg">{toolCall.error}</p>
      </div>
    )
  }
  if (!blockId || !h.content || !h.block) {
    return (
      <div className="ml-card ml-card--quiet" aria-busy="true">
        <div className="ml-head">
          <IconMail />
          <span>{h.error ?? 'Drafting email…'}</span>
        </div>
      </div>
    )
  }

  const c = h.content
  const ex = h.block.execution
  const status = ex?.status ?? null
  const dismissed = !!h.block.dismissed_at
  const sent = status === 'sent'
  const drafted = status === 'created' && ex?.['drafted'] === true
  const locked = sent || drafted || dismissed || status === 'sending' || h.busy || countdown !== null
  const set = (patch: Partial<EmailDraftBlock>): void => h.edit({ ...c, ...patch })
  const noRecipient = !c.to.length && !c.cc.length && !c.bcc.length

  const run = async (mode: 'send' | 'draft'): Promise<void> => {
    const r = await h.execute({ mode })
    if (!r) return
    if (!r.failure) {
      if (mode === 'send') showToast({ kind: 'success', title: 'Email sent' })
      else {
        const provider = r.block.execution?.['provider']
        const url = r.block.execution?.['webUrl']
        showToast({
          kind: 'success',
          title: provider === 'microsoft' ? 'Saved to Outlook drafts' : 'Saved to Gmail drafts',
          ...(typeof url === 'string' ? { action: { label: 'Open', onClick: () => openExternal(url) } } : {})
        })
      }
    } else if (r.failure.error) showToast({ id: `ml-fail-${h.block?.id ?? ''}`, kind: 'error', title: r.failure.error })
  }

  const startSend = (): void => {
    void h.flush()
    setCountdown(UNDO_S)
    let left = UNDO_S
    tick.current = setInterval(() => {
      left -= 1
      if (left <= 0) {
        if (tick.current) clearInterval(tick.current)
        tick.current = null
        setCountdown(null)
        void run('send')
      } else setCountdown(left)
    }, 1_000)
  }
  const undo = (): void => {
    if (tick.current) clearInterval(tick.current)
    tick.current = null
    setCountdown(null)
  }

  if (sent || drafted || dismissed) {
    const url = typeof ex?.['webUrl'] === 'string' ? ex['webUrl'] : null
    return (
      <div className="ml-card ml-card--done">
        <div className="ml-head">
          <IconMail />
          <span>{dismissed ? 'Dismissed' : sent ? 'Email sent' : ex?.['provider'] === 'microsoft' ? 'Saved to Outlook drafts' : 'Saved to Gmail drafts'}</span>
          {drafted && url ? (
            <button type="button" className="ml-link" onClick={() => openExternal(url)}>
              Open
            </button>
          ) : null}
        </div>
        <p className="ml-summary">
          {c.subject || '(no subject)'} · {c.to[0] ?? c.cc[0] ?? ''}
          {c.to.length > 1 ? ` +${c.to.length - 1}` : ''}
        </p>
      </div>
    )
  }

  return (
    <div className="ml-card">
      <div className="ml-head">
        <IconMail />
        <span>Email draft</span>
        {!showCc && !c.cc.length && !c.bcc.length ? (
          <button type="button" className="ml-link" onClick={() => setShowCc(true)}>
            Cc / Bcc
          </button>
        ) : null}
      </div>
      {status === 'failed' || status === 'unknown' ? (
        <div className={`ml-banner${status === 'unknown' ? ' ml-banner--warn' : ''}`} role="status">
          <IconAlert size={14} />
          <span>{ex?.error || 'This email wasn’t sent.'}</span>
        </div>
      ) : null}
      <ListInput label="To" value={c.to} disabled={locked} onChange={(to) => set({ to })} />
      {showCc || c.cc.length || c.bcc.length ? (
        <>
          <ListInput label="Cc" value={c.cc} disabled={locked} onChange={(cc) => set({ cc })} />
          <ListInput label="Bcc" value={c.bcc} disabled={locked} onChange={(bcc) => set({ bcc })} />
        </>
      ) : null}
      <label className="ml-line">
        <span className="ml-line__label">Subject</span>
        <input className="ml-line__input" value={c.subject} disabled={locked} aria-label="Subject" onChange={(e) => set({ subject: e.target.value })} />
      </label>
      <textarea className="ml-body" value={c.body} disabled={locked} aria-label="Message" rows={Math.min(14, Math.max(5, c.body.split('\n').length + 1))} onChange={(e) => set({ body: e.target.value })} />
      <div className="ml-foot">
        <button type="button" className="n-btn n-btn--sm n-btn--ghost" disabled={locked} onClick={() => void h.dismiss()}>
          Dismiss
        </button>
        <span className="ml-foot__note">{SIGNATURE_NOTE}</span>
        {countdown !== null ? (
          <>
            <span className="ml-countdown" aria-live="polite">
              Sending in {countdown} s
            </span>
            <button type="button" className="n-btn n-btn--sm" onClick={undo}>
              Undo
            </button>
          </>
        ) : status === 'unknown' ? null : (
          <>
            <button type="button" className="n-btn n-btn--sm" disabled={locked || noRecipient} onClick={() => void run('draft')}>
              Save as draft
            </button>
            <button type="button" className="n-btn n-btn--sm n-btn--primary" disabled={locked || noRecipient} onClick={startSend}>
              {h.busy || status === 'sending' ? 'Sending…' : status === 'failed' ? 'Try again' : 'Send'}
            </button>
          </>
        )}
      </div>
    </div>
  )
}
