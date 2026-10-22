// SPDX-License-Identifier: Apache-2.0
// The card where the user answers the AI’s multiple-choice questions in chat.

import { useEffect, useRef, useState, type JSX, type KeyboardEvent } from 'react'
import { QUESTIONS_SKIPPED_REASON, type AskUserQuestion, type ChatToolCall } from '@shared/types/chat'
import { IconCheck, IconClose } from '../../app/icons'
import { IconCaretRight } from './icons'

export interface QuestionDecision {
  status: 'approved' | 'denied'
  args: Record<string, unknown>
  reason: string
}

interface Answer {
  chosen: string[]
  custom: string
  customOpen: boolean
}

function questionsOf(call: ChatToolCall): AskUserQuestion[] {
  const raw = (call.approval?.proposedArgs?.['questions'] ?? call.args['questions']) as unknown
  if (!Array.isArray(raw)) return []
  return raw.filter(
    (q): q is AskUserQuestion => !!q && typeof q === 'object' && typeof (q as AskUserQuestion).question === 'string' && Array.isArray((q as AskUserQuestion).options)
  )
}

function valuesOf(a: Answer): string[] {
  const custom = a.custom.trim()
  return custom ? [...a.chosen, custom] : [...a.chosen]
}

/** An option chosen or custom text, and no open, empty custom field. */
function answered(a: Answer | undefined): boolean {
  if (!a) return false
  if (a.customOpen && !a.custom.trim()) return false
  return a.chosen.length > 0 || a.custom.trim().length > 0
}

/** The finished card: each question with its answers. */
function Settled({ call, questions }: { call: ChatToolCall; questions: AskUserQuestion[] }): JSX.Element {
  if (call.approval?.status === 'denied') return <div className="chat-question chat-question--settled chat-question--muted">Questions skipped</div>
  const answers = ((call.result as { answers?: Record<string, string[]> } | null)?.answers ?? (call.args['answers'] as Record<string, string[]> | undefined) ?? {}) as Record<
    string,
    string[]
  >
  return (
    <div className="chat-question chat-question--settled">
      {questions.map((q) => (
        <div key={q.id} className="chat-question__summary">
          <div className="chat-question__summary-q">{q.question}</div>
          <div className="chat-question__summary-a">{(answers[q.id] ?? []).join(', ') || '—'}</div>
        </div>
      ))}
    </div>
  )
}

export function QuestionCard({ call, onDecide }: { call: ChatToolCall; onDecide(d: QuestionDecision): void }): JSX.Element {
  const questions = questionsOf(call)
  const pending = call.approval?.status === 'pending'
  const [index, setIndex] = useState(0)
  const [answers, setAnswers] = useState<Record<string, Answer>>({})
  const [sent, setSent] = useState(false)
  const customRef = useRef<HTMLInputElement>(null)

  const q = questions[Math.min(index, questions.length - 1)]
  const a: Answer = (q && answers[q.id]) ?? { chosen: [], custom: '', customOpen: false }
  const last = index >= questions.length - 1
  const all = questions.every((x) => answered(answers[x.id]))

  useEffect(() => {
    if (a.customOpen) customRef.current?.focus()
  }, [a.customOpen, index])

  if (questions.length === 0) return <div className="chat-question chat-question--settled chat-question--muted">Preparing a question…</div>
  if (!pending || !q) return <Settled call={call} questions={questions} />

  const set = (patch: Partial<Answer>): void => setAnswers((prev) => ({ ...prev, [q.id]: { ...a, ...patch } }))

  const pick = (label: string): void => {
    if (q.multiSelect) {
      set({ chosen: a.chosen.includes(label) ? a.chosen.filter((x) => x !== label) : [...a.chosen, label] })
    } else {
      // Single select: picking an option closes the custom field.
      set({ chosen: [label], customOpen: false, custom: '' })
    }
  }

  const send = (): void => {
    if (!all || sent) return
    setSent(true)
    const out: Record<string, string[]> = {}
    for (const x of questions) out[x.id] = valuesOf(answers[x.id] ?? { chosen: [], custom: '', customOpen: false })
    const reason = questions.map((x) => `${x.question}\n${(out[x.id] ?? []).join(', ')}`).join('\n\n')
    onDecide({ status: 'approved', args: { questions, answers: out }, reason })
  }

  const skip = (): void => {
    if (sent) return
    setSent(true)
    onDecide({ status: 'denied', args: { questions }, reason: QUESTIONS_SKIPPED_REASON })
  }

  const advance = (): void => {
    if (!answered(a)) return
    if (last) send()
    else setIndex((i) => i + 1)
  }

  const onEnter = (e: KeyboardEvent): void => {
    if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return
    e.preventDefault()
    advance()
  }

  return (
    <div className="chat-question" role="group" aria-label={q.question}>
      <div className="chat-question__head">
        <span className="chat-question__text">{q.question}</span>
        {questions.length > 1 ? (
          <span className="chat-question__nav">
            <button
              type="button"
              className="n-icon-btn n-icon-btn--sm"
              aria-label="Previous question"
              disabled={index === 0}
              onClick={() => setIndex((i) => Math.max(0, i - 1))}
            >
              <IconCaretRight size={14} className="chat-question__prev" />
            </button>
            <span className="chat-question__count">
              {index + 1} of {questions.length}
            </span>
            <button
              type="button"
              className="n-icon-btn n-icon-btn--sm"
              aria-label="Next question"
              disabled={last}
              onClick={() => setIndex((i) => Math.min(questions.length - 1, i + 1))}
            >
              <IconCaretRight size={14} />
            </button>
          </span>
        ) : null}
      </div>
      <div className="chat-question__options" role={q.multiSelect ? 'group' : 'radiogroup'}>
        {q.options.map((o, i) => {
          const on = a.chosen.includes(o.label)
          return (
            <button
              key={o.label}
              type="button"
              role={q.multiSelect ? 'checkbox' : 'radio'}
              aria-checked={on}
              className={`chat-question__option${on ? ' is-on' : ''}`}
              onClick={() => pick(o.label)}
              onKeyDown={(e) => on && onEnter(e)}
            >
              {q.multiSelect ? (
                <span className="chat-question__box" aria-hidden="true">
                  {on ? <IconCheck size={11} /> : null}
                </span>
              ) : (
                <span className="chat-question__num" aria-hidden="true">
                  {i + 1}
                </span>
              )}
              <span>{o.label}</span>
            </button>
          )
        })}
        {a.customOpen ? (
          <div className="chat-question__custom">
            <input
              ref={customRef}
              className="chat-question__field"
              value={a.custom}
              placeholder="Type your answer…"
              aria-label={`${q.question} custom answer`}
              onChange={(e) => set({ custom: e.target.value })}
              onKeyDown={onEnter}
              onBlur={() => {
                // A blank custom field closes on blur.
                if (!a.custom.trim()) set({ customOpen: false, custom: '' })
              }}
            />
            <button type="button" className="n-icon-btn n-icon-btn--sm" aria-label="Remove custom answer" onMouseDown={(e) => e.preventDefault()} onClick={() => set({ customOpen: false, custom: '' })}>
              <IconClose size={12} />
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="chat-question__option chat-question__option--other"
            // Single select: opening the field clears the chosen option.
            onClick={() => set({ customOpen: true, ...(q.multiSelect ? {} : { chosen: [] }) })}
          >
            <span className="chat-question__num chat-question__num--ghost" aria-hidden="true">
              {q.multiSelect ? '' : q.options.length + 1}
            </span>
            <span>Something else…</span>
          </button>
        )}
      </div>
      <div className="chat-question__foot">
        <button type="button" className="n-btn n-btn--ghost n-btn--sm" disabled={sent} onClick={skip}>
          Skip
        </button>
        <button
          type="button"
          className={`n-btn n-btn--sm${answered(a) && (!last || all) ? ' n-btn--primary' : ''}`}
          disabled={sent || !answered(a) || (last && !all)}
          onClick={advance}
        >
          {last ? 'Send' : 'Next'}
          <kbd className="chat-question__kbd" aria-hidden="true">
            ⏎
          </kbd>
        </button>
      </div>
    </div>
  )
}
