// SPDX-License-Identifier: Apache-2.0
// An answer's tool calls: ordinary calls
// fold into one collapsible group of steps; `exploreMeetings` and `show_todo_cards`
// render on their own with their card open; a write waiting for approval shows its
// approval card, and `askUser` its question card. Each step's card opens from its
// status line.

import { useEffect, useState, type JSX, type ReactNode } from 'react'
import type { ChatToolCall, ChatToolCategory } from '@shared/types/chat'
import { IconCheck } from '../../app/icons'
import { IconCalendarDay, IconCaretRight, IconDoc, IconMail, IconSearchDoc, IconTool, IconWarn } from './icons'
import { QuestionCard, type QuestionDecision } from './QuestionCard'
import { toolCard } from './ToolCards'
import { toolLine, toolPhase, type ToolPhase } from './util'

export interface ApprovalDecision {
  status: 'approved' | 'denied'
  args?: Record<string, unknown>
  reason: string
}

/** The reasons recorded with an approval decision. */
const APPROVED_REASON = 'Approved by the user.'
const DECLINED_REASON = 'The user declined this change.'

interface ApprovalPreview {
  title: string
  lines: string[]
  replace?: { before: string; after: string }
  editableTitle?: string
}

function previewOf(call: ChatToolCall): ApprovalPreview | null {
  const p = (call.result as { approvalPreview?: ApprovalPreview } | null)?.approvalPreview
  return p && typeof p.title === 'string' ? p : null
}

const CATEGORY_ICON: Record<ChatToolCategory, (size: number) => ReactNode> = {
  search: (s) => <IconSearchDoc size={s} />,
  calendar: (s) => <IconCalendarDay size={s} />,
  notes: (s) => <IconDoc size={s} />,
  email: (s) => <IconMail size={s} />,
  generic: (s) => <IconTool size={s} />
}

function phaseIcon(call: ChatToolCall, phase: ToolPhase): ReactNode {
  if (phase === 'running') return <span className="chat-tool__spin" aria-hidden="true" />
  if (phase === 'failed') return <IconWarn size={14} />
  if (phase === 'done' && (call.name === 'editNote' || call.name === 'rewriteNote')) return <IconCheck size={14} />
  return CATEGORY_ICON[call.category ?? 'generic'](14)
}

/** The approval card: the change, its preview, Approve and Decline. */
function ApprovalCard({ call, onDecide }: { call: ChatToolCall; onDecide(d: ApprovalDecision): void }): JSX.Element {
  const preview = previewOf(call)
  const [title, setTitle] = useState(preview?.editableTitle ?? '')
  const [sent, setSent] = useState(false)
  useEffect(() => setTitle(preview?.editableTitle ?? ''), [preview?.editableTitle])
  const editable = preview?.editableTitle !== undefined
  const decide = (status: 'approved' | 'denied'): void => {
    if (sent) return
    setSent(true)
    onDecide({
      status,
      reason: status === 'approved' ? APPROVED_REASON : DECLINED_REASON,
      ...(status === 'approved' && editable && title.trim() ? { args: { title: title.trim() } } : {})
    })
  }
  return (
    <div className="chat-approval" role="group" aria-label={preview?.title ?? `Approve ${call.name}`}>
      <p className="chat-approval__text">
        {preview?.title ?? (typeof call.args['action'] === 'string' ? call.args['action'] : `Notula wants to run ${call.mcpToolLabel ?? call.name}.`)}
      </p>
      {editable ? (
        <input
          className="n-input chat-approval__field"
          value={title}
          aria-label="Folder name"
          maxLength={200}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing && title.trim()) decide('approved')
          }}
        />
      ) : null}
      {preview?.replace ? (
        <div className="chat-approval__diff">
          <div className="chat-approval__before">{preview.replace.before}</div>
          <div className="chat-approval__after">{preview.replace.after || 'Delete this passage'}</div>
        </div>
      ) : null}
      {preview && preview.lines.length > 0 ? <div className="chat-approval__preview">{preview.lines.join('\n')}</div> : null}
      <div className="chat-approval__actions">
        <button type="button" className="n-btn n-btn--sm" disabled={sent} onClick={() => decide('denied')}>
          Decline
        </button>
        <button type="button" className="n-btn n-btn--sm n-btn--primary" disabled={sent || (editable && !title.trim())} onClick={() => decide('approved')}>
          Approve
        </button>
      </div>
    </div>
  )
}

/** One step: its status line, and its card under it once opened. */
function Step({
  call,
  line,
  phase,
  open,
  onToggle,
  extra
}: {
  call: ChatToolCall
  line: ReactNode
  phase: ToolPhase
  open: boolean
  onToggle(): void
  extra?: ReactNode
}): JSX.Element {
  const card = phase === 'done' ? toolCard(call) : null
  return (
    <div className={`chat-tool chat-tool--${phase}`}>
      {card ? (
        <button type="button" className="chat-tool__line chat-tool__line--toggle" aria-expanded={open} onClick={onToggle}>
          {phaseIcon(call, phase)}
          <span>{line}</span>
          <IconCaretRight size={13} className={`chat-tool__chev${open ? ' is-open' : ''}`} />
        </button>
      ) : (
        <div className="chat-tool__line" title={phase === 'failed' && call.error ? call.error : undefined}>
          {phaseIcon(call, phase)}
          <span>{line}</span>
        </div>
      )}
      {extra}
      {card && open ? card : null}
    </div>
  )
}

/** A call that renders on its own (plus approvals and questions). */
export function standalone(call: ChatToolCall): boolean {
  return call.renderInline || call.name === 'askUser' || !!call.approval
}

export function StandaloneStep({
  call,
  renderLine,
  onApproval
}: {
  call: ChatToolCall
  /** The rewrite link and phases (Conversation's ToolLine) for note edits. */
  renderLine?(call: ChatToolCall): ReactNode
  onApproval(d: ApprovalDecision): void
}): JSX.Element {
  const phase = toolPhase(call)
  const [open, setOpen] = useState(call.renderInline)
  if (call.name === 'askUser') {
    return (
      <div className="chat-tool chat-tool--question">
        <div className="chat-tool__line">
          {phase === 'waiting' ? <span className="chat-tool__dot" aria-hidden="true" /> : CATEGORY_ICON.generic(14)}
          <span>{toolLine(call, phase)}</span>
        </div>
        <QuestionCard call={call} onDecide={(d: QuestionDecision) => onApproval(d)} />
      </div>
    )
  }
  if (renderLine && !call.approval) return <>{renderLine(call)}</>
  return (
    <Step
      call={call}
      line={toolLine(call, phase)}
      phase={phase}
      open={open}
      onToggle={() => setOpen((o) => !o)}
      extra={phase === 'waiting' ? <ApprovalCard call={call} onDecide={onApproval} /> : null}
    />
  )
}

/** A run of ordinary calls: one line while there is one, a collapsible group of steps for more. */
export function StepGroup({ calls }: { calls: ChatToolCall[] }): JSX.Element | null {
  const [expanded, setExpanded] = useState(false)
  const [openCard, setOpenCard] = useState<string | null>(null)
  if (calls.length === 0) return null
  const toggle = (id: string): void => setOpenCard((cur) => (cur === id ? null : id))
  if (calls.length === 1) {
    const call = calls[0] as ChatToolCall
    const phase = toolPhase(call)
    return <Step call={call} line={toolLine(call, phase)} phase={phase} open={openCard === call.id} onToggle={() => toggle(call.id)} />
  }
  const running = calls.find((c) => toolPhase(c) === 'running')
  // The step in progress, else the last one that did something.
  const lead = running ?? [...calls].reverse().find((c) => toolPhase(c) === 'done') ?? (calls[calls.length - 1] as ChatToolCall)
  const leadPhase = toolPhase(lead)
  const failed = calls.filter((c) => toolPhase(c) === 'failed').length
  return (
    <div className={`chat-steps${expanded ? ' is-open' : ''}`}>
      <button type="button" className={`chat-tool__line chat-steps__head chat-tool--${leadPhase}`} aria-expanded={expanded} onClick={() => setExpanded((e) => !e)}>
        {phaseIcon(lead, leadPhase)}
        <span>{toolLine(lead, leadPhase)}</span>
        <span className="chat-steps__count">
          {calls.length} steps{failed ? ` · ${failed} failed` : ''}
        </span>
        <IconCaretRight size={13} className={`chat-tool__chev${expanded ? ' is-open' : ''}`} />
      </button>
      {expanded ? (
        <div className="chat-steps__list">
          {calls.map((c) => {
            const phase = toolPhase(c)
            return <Step key={c.id} call={c} line={toolLine(c, phase)} phase={phase} open={openCard === c.id} onToggle={() => toggle(c.id)} />
          })}
        </div>
      ) : null}
    </div>
  )
}
