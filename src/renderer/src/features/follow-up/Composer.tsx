// SPDX-License-Identifier: Apache-2.0
// The follow-up composer: generate, edit,
// rewrite with AI (one undo), copy, or hand off to the mail app. Notula sends nothing.

import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import { parseError } from '@shared/errors'
import type { FollowUpDraft, FollowUpDraftPatch } from '@shared/types/follow-up'
import { IconClose, IconSparkle } from '../../app/icons'
import { debugLog } from '../../app/platform'
import { showToast } from '../../app/toast'
import { FollowUpMailButtons } from '../mail'
import { BodyEditor } from './BodyEditor'
import { Recipients } from './Recipients'
import { refreshSuggested, setComposerNote, useComposerNote } from './store'
import './follow-up.css'

const SAVE_DEBOUNCE_MS = 500
const PLACEHOLDER = /<placeholder(\s+type\s*=\s*"attention")?\s*>([\s\S]*?)<\/placeholder>/gi

function blockingPlaceholder(body: string): boolean {
  for (const m of body.matchAll(PLACEHOLDER)) if (!m[1]) return true
  return false
}

function bodyIsEmpty(body: string): boolean {
  return body.replace(PLACEHOLDER, '$2').replace(/[#>*_`~\-\s]/g, '') === ''
}

function IconMail({ size = 16 }: { size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3.5" y="5.5" width="17" height="13" rx="2.5" />
      <path d="m4.5 7.5 7.5 5.5 7.5-5.5" />
    </svg>
  )
}

function IconThumb({ down, size = 14 }: { down?: boolean; size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={down ? { transform: 'rotate(180deg)' } : undefined}>
      <path d="M7 11v9H4.5a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1H7zm0 0 4-7.5a2 2 0 0 1 2.4 2.2L12.8 10H18a2 2 0 0 1 2 2.3l-1.1 6.2a2 2 0 0 1-2 1.5H7" />
    </svg>
  )
}

/** App host: the composer of the note `openFollowUpComposer` named. */
export function FollowUpComposerHost(): JSX.Element | null {
  const noteId = useComposerNote()
  if (!noteId) return null
  return <Composer key={noteId} noteId={noteId} onClose={() => setComposerNote(null)} />
}

type Load = { state: 'loading' } | { state: 'none' } | { state: 'draft'; draft: FollowUpDraft }

function Composer({ noteId, onClose }: { noteId: string; onClose(): void }): JSX.Element {
  const [load, setLoad] = useState<Load>({ state: 'loading' })
  const [starting, setStarting] = useState(false)
  const draft = load.state === 'draft' ? load.draft : null
  const generating = starting || draft?.status === 'generating'

  const reload = useCallback(async (): Promise<void> => {
    try {
      const d = await window.notula.followUp.get({ noteId })
      setLoad(d ? { state: 'draft', draft: d } : { state: 'none' })
    } catch (err) {
      debugLog('follow-up-get-failed', { err: parseError(err) })
      setLoad({ state: 'none' })
    }
  }, [noteId])

  useEffect(() => {
    void reload()
    const offs = [
      window.notula.followUp.onResult((e) => {
        if (e.draft.document_id !== noteId) return
        setStarting(false)
        setLoad({ state: 'draft', draft: e.draft })
      }),
      window.notula.followUp.onError((e) => {
        if (e.noteId !== noteId) return
        setStarting(false)
        void reload()
      }),
      window.notula.followUp.onProgress((e) => {
        if (e.noteId === noteId) setStarting(true)
      })
    ]
    return () => offs.forEach((off) => off())
  }, [noteId, reload])

  // Opening the composer records `opened` once per draft.
  const opened = useRef<string | null>(null)
  useEffect(() => {
    if (!draft || draft.status !== 'completed' || draft.outcome !== null || opened.current === draft.id) return
    opened.current = draft.id
    window.notula.followUp.update({ draftId: draft.id, patch: { outcome: 'opened' } }).catch(() => undefined)
  }, [draft])

  const generate = async (): Promise<void> => {
    setStarting(true)
    try {
      await window.notula.followUp.generate({ noteId })
      refreshSuggested()
    } catch (err) {
      setStarting(false)
      debugLog('follow-up-generate-failed', { err: parseError(err) })
      showToast({ id: 'fu-generate-failed', kind: 'error', title: 'Couldn’t draft the email. Try again.' })
    }
  }

  const dialog = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    dialog.current?.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !e.defaultPrevented) {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      before?.focus?.()
    }
  }, [onClose])

  return (
    <div className="fu-overlay" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={dialog} className="fu-dialog" role="dialog" aria-modal="true" aria-label="Follow-up email" tabIndex={-1}>
        <header className="fu-dialog__head">
          <span className="fu-dialog__icon" aria-hidden="true">
            <IconMail size={16} />
          </span>
          <span className="fu-dialog__title">Follow-up email</span>
          <button type="button" className="n-icon-btn" aria-label="Close" onClick={onClose}>
            <IconClose size={18} />
          </button>
        </header>
        {load.state === 'loading' ? (
          <div className="fu-state" aria-busy="true">
            <span className="n-spinner" aria-hidden="true" />
          </div>
        ) : generating ? (
          <div className="fu-state fu-state--drafting" aria-busy="true">
            <p className="fu-state__title">
              <IconSparkle size={15} />
              Drafting email...
            </p>
            <div className="fu-skeleton">
              {[92, 84, 96, 60, 78].map((w) => (
                <div key={w} className="n-skeleton" style={{ width: `${w}%`, height: 12 }} />
              ))}
            </div>
          </div>
        ) : load.state === 'none' ? (
          <div className="fu-state">
            <p className="fu-state__title">No follow-up email yet.</p>
            <p className="fu-state__hint">Notula drafts it with your AI provider from the meeting’s notes and transcript.</p>
            <button type="button" className="n-btn n-btn--primary" onClick={() => void generate()}>
              <IconSparkle size={15} />
              Draft follow-up email
            </button>
          </div>
        ) : draft && draft.status === 'error' ? (
          <div className="fu-state">
            <p className="fu-state__title">{draft.error_message || 'Couldn’t draft the email. Try again.'}</p>
            <button type="button" className="n-btn" onClick={() => void generate()}>
              Try again
            </button>
          </div>
        ) : draft ? (
          <DraftEditor key={draft.id} draft={draft} onClose={onClose} onRegenerate={() => void generate()} />
        ) : null}
      </div>
    </div>
  )
}

function DraftEditor({ draft, onClose, onRegenerate }: { draft: FollowUpDraft; onClose(): void; onRegenerate(): void }): JSX.Element {
  const [to, setTo] = useState(draft.to)
  const [cc, setCc] = useState(draft.cc)
  const [bcc, setBcc] = useState(draft.bcc)
  const [showCc, setShowCc] = useState(draft.cc.length > 0 || draft.bcc.length > 0)
  const [subject, setSubject] = useState(draft.subject)
  const [body, setBody] = useState(draft.body)
  const [bodyVersion, setBodyVersion] = useState(0)
  const [undoBody, setUndoBody] = useState<string | null>(null)
  const [selection, setSelection] = useState<string | null>(null)
  const [rewriteOpen, setRewriteOpen] = useState(false)
  const [instruction, setInstruction] = useState('')
  const [rewriting, setRewriting] = useState(false)
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<'positive' | 'negative' | null>(null)
  const [feedbackText, setFeedbackText] = useState('')

  // Edits are saved shortly after they stop.
  const pending = useRef<FollowUpDraftPatch>({})
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const flush = useCallback(async (): Promise<void> => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    const patch = pending.current
    pending.current = {}
    if (Object.keys(patch).length === 0) return
    await window.notula.followUp.update({ draftId: draft.id, patch }).catch((err: unknown) => {
      debugLog('follow-up-save-failed', { err: parseError(err) })
    })
  }, [draft.id])
  const save = (patch: FollowUpDraftPatch): void => {
    pending.current = { ...pending.current, ...patch }
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => void flush(), SAVE_DEBOUNCE_MS)
  }
  useEffect(() => () => void flush(), [flush])

  const blocked = blockingPlaceholder(body)
  const empty = bodyIsEmpty(body)
  const handoffBlock = blocked ? 'Fill in the highlighted gaps before sending' : empty ? "Can't send an empty email" : null

  const handoff = async (mode: 'mail-app' | 'copy'): Promise<void> => {
    if (busy || (mode === 'mail-app' && handoffBlock)) return
    setBusy(true)
    await flush()
    try {
      const result = await window.notula.followUp.handoff({ draftId: draft.id, mode })
      refreshSuggested()
      if (mode === 'copy') {
        showToast({ id: 'fu-copied', kind: 'success', title: 'Email copied' })
      } else {
        showToast({
          id: 'fu-handed-off',
          kind: 'success',
          title: 'Opened in your mail app',
          ...(result.bodyOnClipboard ? { description: 'Email body copied. Paste it into your draft.' } : {})
        })
        onClose()
      }
    } catch (err) {
      const e = parseError(err)
      debugLog('follow-up-handoff-failed', { err: e })
      showToast({ id: 'fu-handoff-failed', kind: 'error', title: e.message || 'Couldn’t open your mail app' })
    } finally {
      setBusy(false)
    }
  }

  const discard = async (): Promise<void> => {
    setBusy(true)
    await flush()
    try {
      await window.notula.followUp.discard({ draftId: draft.id })
      refreshSuggested()
      showToast({ id: 'fu-discarded', title: `Dismissed follow-up for ${draft.note_title?.trim() || 'this meeting'}` })
      onClose()
    } catch (err) {
      debugLog('follow-up-discard-failed', { err: parseError(err) })
      showToast({ id: 'fu-discard-failed', kind: 'error', title: 'Couldn’t discard the email. Try again.' })
      setBusy(false)
    }
  }

  const rewrite = async (text?: string): Promise<void> => {
    const ask = (text ?? instruction).trim()
    if (!ask || rewriting) return
    setRewriting(true)
    await flush()
    try {
      const out = await window.notula.followUp.rewrite({ draftId: draft.id, instruction: ask, ...(selection ? { referencedText: selection } : {}) })
      setUndoBody(body)
      setBody(out.body)
      setSubject(out.subject)
      setBodyVersion((v) => v + 1)
      setInstruction('')
      setRewriteOpen(false)
    } catch (err) {
      const e = parseError(err)
      debugLog('follow-up-rewrite-failed', { err: e })
      showToast({ id: 'fu-rewrite-failed', kind: 'error', title: e.message || 'The draft could not be rewritten.' })
    } finally {
      setRewriting(false)
    }
  }

  const undo = (): void => {
    if (undoBody === null) return
    setBody(undoBody)
    setBodyVersion((v) => v + 1)
    save({ body: undoBody })
    setUndoBody(null)
  }

  const sendFeedback = async (): Promise<void> => {
    if (!feedback) return
    try {
      await window.notula.followUp.update({ draftId: draft.id, patch: { feedback_direction: feedback, feedback_text: feedbackText.trim() || null } })
      showToast({ id: 'fu-feedback', kind: 'success', title: 'Feedback saved' })
      setFeedback(null)
      setFeedbackText('')
    } catch {
      showToast({ id: 'fu-feedback-failed', kind: 'error', title: 'Couldn’t save your feedback. Try again.' })
    }
  }

  return (
    <>
      <div className="fu-fields">
        <Recipients
          label="To"
          value={to}
          onChange={(v) => {
            setTo(v)
            save({ to: v })
          }}
          trailing={
            showCc ? null : (
              <button type="button" className="fu-field__toggle" onClick={() => setShowCc(true)}>
                Cc / Bcc
              </button>
            )
          }
        />
        {showCc ? (
          <>
            <Recipients
              label="Cc"
              value={cc}
              onChange={(v) => {
                setCc(v)
                save({ cc: v })
              }}
            />
            <Recipients
              label="Bcc"
              value={bcc}
              onChange={(v) => {
                setBcc(v)
                save({ bcc: v })
              }}
            />
          </>
        ) : null}
        <label className="fu-field">
          <span className="fu-field__label">Subject</span>
          <input
            className="fu-subject"
            value={subject}
            maxLength={1_000}
            onChange={(e) => {
              setSubject(e.target.value)
              save({ subject: e.target.value })
            }}
          />
        </label>
      </div>
      <div className={`fu-editor${rewriting ? ' is-rewriting' : ''}`}>
        <BodyEditor
          markdown={body}
          version={bodyVersion}
          editable={!rewriting}
          onChange={(md) => {
            setBody(md)
            save({ body: md })
          }}
          onSelection={setSelection}
          onSubmit={() => void handoff('mail-app')}
        />
        {rewriting ? (
          <div className="fu-editor__busy" aria-live="polite">
            <IconSparkle size={14} />
            Rewriting…
          </div>
        ) : null}
      </div>
      {rewriteOpen ? (
        <form
          className="fu-rewrite"
          onSubmit={(e) => {
            e.preventDefault()
            void rewrite()
          }}
        >
          <input
            className="n-input fu-rewrite__input"
            autoFocus
            placeholder={selection ? 'How should the selected text change?' : 'How should the draft change? e.g. Make it shorter'}
            value={instruction}
            maxLength={4_000}
            onChange={(e) => setInstruction(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault()
                setRewriteOpen(false)
              }
            }}
          />
          <button type="submit" className="n-btn n-btn--sm n-btn--primary" disabled={!instruction.trim() || rewriting}>
            Rewrite
          </button>
          <button type="button" className="n-btn n-btn--sm n-btn--ghost" onClick={() => setRewriteOpen(false)}>
            Cancel
          </button>
        </form>
      ) : null}
      {feedback ? (
        <form
          className="fu-feedback"
          onSubmit={(e) => {
            e.preventDefault()
            void sendFeedback()
          }}
        >
          <textarea
            className="n-input fu-feedback__text"
            autoFocus
            rows={2}
            maxLength={4_000}
            placeholder="Optional: what to change in future drafts."
            value={feedbackText}
            onChange={(e) => setFeedbackText(e.target.value)}
          />
          <div className="fu-feedback__actions">
            <button type="button" className="n-btn n-btn--sm n-btn--ghost" onClick={() => setFeedback(null)}>
              Cancel
            </button>
            <button type="submit" className="n-btn n-btn--sm n-btn--primary">
              Submit
            </button>
          </div>
        </form>
      ) : null}
      <footer className="fu-dialog__foot">
        <div className="fu-dialog__foot-start">
          <button type="button" className="n-btn n-btn--sm n-btn--ghost" disabled={rewriting} onClick={() => setRewriteOpen((o) => !o)}>
            <IconSparkle size={14} />
            {selection ? 'Edit selection' : 'Rewrite'}
          </button>
          {undoBody !== null ? (
            <button type="button" className="n-btn n-btn--sm n-btn--ghost" onClick={undo}>
              Undo
            </button>
          ) : null}
          <span className="fu-dialog__sep" aria-hidden="true" />
          <span className="n-tooltip" data-tooltip="Good follow-up">
            <button
              type="button"
              className={`n-icon-btn n-icon-btn--sm${draft.feedback_direction === 'positive' ? ' is-on' : ''}`}
              aria-label="Good follow-up"
              onClick={() => setFeedback('positive')}
            >
              <IconThumb />
            </button>
          </span>
          <span className="n-tooltip" data-tooltip="Bad follow-up">
            <button
              type="button"
              className={`n-icon-btn n-icon-btn--sm${draft.feedback_direction === 'negative' ? ' is-on' : ''}`}
              aria-label="Bad follow-up"
              onClick={() => setFeedback('negative')}
            >
              <IconThumb down />
            </button>
          </span>
        </div>
        <div className="fu-dialog__foot-end">
          <button type="button" className="n-btn n-btn--sm n-btn--ghost" disabled={busy} onClick={() => void discard()}>
            Discard
          </button>
          <button type="button" className="n-btn n-btn--sm n-btn--ghost" disabled={busy} onClick={onRegenerate}>
            Redraft
          </button>
          <button type="button" className="n-btn n-btn--sm" disabled={busy} onClick={() => void handoff('copy')}>
            Copy
          </button>
          <span className={handoffBlock ? 'n-tooltip n-tooltip--end' : undefined} data-tooltip={handoffBlock ?? undefined}>
            <button type="button" className="n-btn n-btn--sm n-btn--primary" disabled={busy || handoffBlock !== null} onClick={() => void handoff('mail-app')}>
              <IconMail size={14} />
              Open in mail app
            </button>
          </span>
          {/* Send and "Save as draft" while the sender account holds `mail-send`. */}
          <FollowUpMailButtons draftId={draft.id} />
        </div>
      </footer>
    </>
  )
}
