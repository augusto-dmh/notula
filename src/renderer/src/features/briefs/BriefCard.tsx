// SPDX-License-Identifier: Apache-2.0
// The note header's prep brief card: closed,
// preview (the first line and `Read more`) or open (headline, rule, the rest, the metadata line with
// its steps popover, and the sources / steps tabs). In progress it shows a pulsing icon and the
// status line; on error, the stored message.

import { useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from 'react'
import { BRIEF_LIMITS, MEETING_LINK_SCHEME, type BriefStep, type PrepBrief } from '@shared/types/briefs'
import { navigate, useRoute } from '../../app/navigation'
import { isTextTarget } from '../../app/platform'
import { usePrefs } from '../calendar/store'
import './briefs.css'

type Mode = 'closed' | 'preview' | 'open'

/** Meetings the user expanded this session start open. */
const expandedThisSession = new Set<string>()

const CYCLE = ['Preparing brief', 'Reading your notes', 'Looking up attendees', 'Pulling out key points', 'Putting it together']

/** The cleanup a generated brief gets (code fence, JSON wrapper), applied again before rendering. */
function clean(raw: string): string {
  let t = raw.trim()
  const fence = /^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n?```$/.exec(t)
  if (fence) t = (fence[1] ?? '').trim()
  if (t.startsWith('{')) {
    try {
      const o = JSON.parse(t) as Record<string, unknown>
      const v = typeof o['answer'] === 'string' && o['answer'].trim() ? o['answer'] : typeof o['brief'] === 'string' ? o['brief'] : null
      if (v && v.trim()) t = v.trim()
    } catch {
      // keep
    }
  }
  return t
}

function lowSignal(b: PrepBrief): boolean {
  return b.worth_showing === false
}

function meaningful(b: PrepBrief): boolean {
  return b.status === 'completed' && !lowSignal(b) && !!b.content?.trim()
}

function splitFirstLine(content: string): { first: string; rest: string } {
  const t = content.trim()
  const i = t.indexOf('\n')
  const strip = (s: string): string => s.replace(/^#{1,6}\s+/, '').trim()
  return i < 0 ? { first: strip(t), rest: '' } : { first: strip(t.slice(0, i)), rest: t.slice(i + 1).trim() }
}

/** This morning / afternoon / evening, overnight, yesterday, on <Mon> <Dth>, recently. */
function preparedWhen(iso: string | null): string {
  const ms = iso ? Date.parse(iso) : NaN
  if (Number.isNaN(ms)) return 'recently'
  const d = new Date(ms)
  const now = new Date()
  const day = (x: Date): number => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diffDays = Math.round((day(now) - day(d)) / 86_400_000)
  const h = d.getHours()
  if (diffDays === 0) return h < 12 ? 'this morning' : h < 18 ? 'this afternoon' : 'this evening'
  if (diffDays === 1) return h >= 18 ? 'overnight' : 'yesterday'
  const n = d.getDate()
  const suffix = n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'
  const month = d.toLocaleDateString('en-US', { month: 'short' })
  return `on ${month} ${n}${suffix}${d.getFullYear() !== now.getFullYear() ? ` ${d.getFullYear()}` : ''}`
}

/** Steps folded from `steps`: each start, closed by its matching end. */
function foldSteps(chunks: BriefStep[]): { id: string; message: string; tool: string; done: boolean; success: boolean }[] {
  const out: { id: string; message: string; tool: string; done: boolean; success: boolean }[] = []
  for (const c of chunks) {
    if (c.type === 'tool_start') out.push({ id: c.toolCallId, message: c.statusMessage, tool: c.toolName, done: false, success: false })
    else {
      const s = out.find((x) => x.id === c.toolCallId && !x.done)
      if (s) {
        s.done = true
        s.success = c.success !== false
      }
    }
  }
  return out
}

// ---------- a small markdown renderer (paragraphs, lists, bold, links) ----------

function Link({ href, children }: { href: string; children: ReactNode }): JSX.Element {
  if (href.startsWith(MEETING_LINK_SCHEME)) {
    const id = href.slice(MEETING_LINK_SCHEME.length)
    return (
      <a
        href={`#/meeting/${encodeURIComponent(id)}`}
        className="prep-link"
        onClick={(e) => {
          e.preventDefault()
          navigate(`/meeting/${encodeURIComponent(id)}?opened_from=prep_brief`)
        }}
      >
        {children}
      </a>
    )
  }
  if (/^https?:\/\//i.test(href)) {
    return (
      <a href={href} className="prep-link" target="_blank" rel="noreferrer noopener">
        {children}
      </a>
    )
  }
  return <>{children}</>
}

function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = []
  const re = /\[([^\]\n]*)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*/g
  let at = 0
  let m: RegExpExecArray | null
  let i = 0
  while ((m = re.exec(text))) {
    if (m.index > at) out.push(text.slice(at, m.index))
    if (m[1] !== undefined && m[2] !== undefined) {
      out.push(
        <Link key={`${key}-${i++}`} href={m[2]}>
          {m[1]}
        </Link>
      )
    } else if (m[3] !== undefined) {
      out.push(<strong key={`${key}-${i++}`}>{inline(m[3], `${key}-b${i}`)}</strong>)
    }
    at = m.index + m[0].length
  }
  if (at < text.length) out.push(text.slice(at))
  return out
}

function Markdown({ text }: { text: string }): JSX.Element {
  const blocks: JSX.Element[] = []
  let list: string[] = []
  let para: string[] = []
  const flush = (): void => {
    if (para.length) {
      const k = `p${blocks.length}`
      blocks.push(<p key={k}>{inline(para.join(' '), k)}</p>)
      para = []
    }
    if (list.length) {
      const k = `l${blocks.length}`
      blocks.push(
        <ul key={k}>
          {list.map((li, i) => (
            <li key={i}>{inline(li, `${k}-${i}`)}</li>
          ))}
        </ul>
      )
      list = []
    }
  }
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    const bullet = /^([-*•]|\d+[.)])\s+(.*)$/.exec(line)
    if (!line) flush()
    else if (bullet) {
      if (para.length) flush()
      list.push(bullet[2] ?? '')
    } else if (/^#{1,6}\s+/.test(line)) {
      flush()
      const k = `h${blocks.length}`
      blocks.push(<h4 key={k}>{inline(line.replace(/^#{1,6}\s+/, ''), k)}</h4>)
    } else {
      if (list.length) flush()
      para.push(line)
    }
  }
  flush()
  return <div className="prep-md">{blocks}</div>
}

// ---------- the card ----------

function useBrief(eventId: string | null, enabled: boolean): { brief: PrepBrief | null; status: string | null; loaded: boolean } {
  const [brief, setBrief] = useState<PrepBrief | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  useEffect(() => {
    setBrief(null)
    setStatus(null)
    setLoaded(false)
    if (!eventId || !enabled) return
    let alive = true
    const load = (): void => {
      void window.notula.briefs
        .get({ eventId })
        .then((b) => {
          if (alive) setBrief(b)
        })
        .catch(() => undefined)
        .finally(() => alive && setLoaded(true))
    }
    const off = window.notula.briefs.onChanged((p) => {
      if (p.eventId !== eventId) return
      setStatus(p.statusMessage ?? null)
      load()
    })
    load()
    // Opening the note asks once.
    void window.notula.briefs.ensure({ eventId }).catch(() => undefined)
    return () => {
      alive = false
      off()
    }
  }, [eventId, enabled])
  return { brief, status, loaded }
}

function Spark(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 2l2.2 6.3L20.5 10l-6.3 2.2L12 18.5l-2.2-6.3L3.5 10l6.3-1.7z" />
    </svg>
  )
}

function CyclingStatus({ message }: { message: string | null }): JSX.Element {
  const [i, setI] = useState(0)
  const [fading, setFading] = useState(false)
  useEffect(() => {
    if (message) return
    let fadeTimer: ReturnType<typeof setTimeout> | undefined
    const t = setInterval(() => {
      setFading(true)
      fadeTimer = setTimeout(() => {
        setI((x) => (x + 1) % CYCLE.length)
        setFading(false)
      }, 150)
    }, BRIEF_LIMITS.statusCycleMs)
    return () => {
      clearInterval(t)
      if (fadeTimer) clearTimeout(fadeTimer)
    }
  }, [message])
  return <span className={`prep-status${fading ? ' is-fading' : ''}`}>{message ?? CYCLE[i]}</span>
}

export function BriefCard({ eventId }: { noteId: string; eventId: string | null }): JSX.Element | null {
  const prefs = usePrefs()
  const enabled = prefs?.['prepBrief.enabled'] === true
  const route = useRoute()
  const { brief, status } = useBrief(eventId, enabled)
  const [mode, setMode] = useState<Mode | null>(null)
  const [tab, setTab] = useState<'sources' | 'steps'>('sources')
  const [stepsOpen, setStepsOpen] = useState(false)
  const card = useRef<HTMLDivElement | null>(null)
  const expandQuery = route.query.get('expand_brief') === '1'

  // The first mode, once the brief is known.
  useEffect(() => {
    if (!brief || brief.status !== 'completed') return
    setMode((m) => {
      if (m !== null) return m
      if (expandQuery || (eventId && expandedThisSession.has(eventId))) return 'open'
      return lowSignal(brief) ? 'closed' : 'preview'
    })
  }, [brief, eventId, expandQuery])
  useEffect(() => setMode(null), [eventId])

  useEffect(() => {
    if (mode === 'open' && eventId) expandedThisSession.add(eventId)
  }, [mode, eventId])

  // Escape outside inputs collapses the open card.
  useEffect(() => {
    if (mode !== 'open' || !brief) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented || isTextTarget(e.target)) return
      if (document.querySelector('[role="dialog"], [aria-modal="true"]')) return
      setStepsOpen(false)
      setMode(lowSignal(brief) ? 'closed' : 'preview')
      if (eventId) expandedThisSession.delete(eventId)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [mode, brief, eventId])

  const content = useMemo(() => (brief?.content ? clean(brief.content) : ''), [brief?.content])
  const steps = useMemo(() => (brief ? foldSteps(brief.steps) : []), [brief])

  if (!enabled || !eventId || !brief || brief.dismissed_at) return null
  const inProgress = brief.status === 'generating' || brief.status === 'streaming'

  if (inProgress) {
    const open = steps.find((s) => !s.done)
    return (
      <div className="prep-card prep-card--progress" role="status" aria-live="polite">
        <span className="prep-icon is-pulsing">
          <Spark />
        </span>
        <CyclingStatus message={status ?? open?.message ?? null} />
      </div>
    )
  }
  if (brief.status === 'error') {
    return (
      <div className="prep-card prep-card--error" role="status">
        <span className="prep-icon">
          <Spark />
        </span>
        <span className="prep-status">{brief.error_message?.trim() || 'Couldn’t prepare the brief. Try again later.'}</span>
      </div>
    )
  }
  if (!content.trim()) return null

  const { first, rest } = splitFirstLine(content)
  const headline = brief.headline?.trim() || first
  const current = mode ?? (lowSignal(brief) ? 'closed' : 'preview')
  const generationMs = Date.parse(brief.updated_at) - Date.parse(brief.created_at)
  const meta = `Prepared for you ${preparedWhen(brief.updated_at)}`

  if (current === 'closed') {
    return (
      <button type="button" className="prep-closed" onClick={() => setMode('open')} aria-expanded={false}>
        <span className="prep-icon">
          <Spark />
        </span>
        <span>Meeting brief</span>
        <span className="prep-closed__meta">{meta}</span>
      </button>
    )
  }

  if (current === 'preview') {
    return (
      <div
        ref={card}
        role="button"
        tabIndex={0}
        className={`prep-card prep-card--preview${meaningful(brief) ? '' : ' is-low'}`}
        aria-expanded={false}
        onClick={() => setMode('open')}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            setMode('open')
          }
        }}
      >
        <span className="prep-icon">
          <Spark />
        </span>
        <span className="prep-preview__text">{inline(headline, 'pv')}</span>
        <span className="prep-readmore">Read more</span>
      </div>
    )
  }

  return (
    <section ref={card} className="prep-card prep-card--open" aria-label="Prep brief">
      <div className="prep-open__head">
        <span className="prep-icon">
          <Spark />
        </span>
        <h3 className="prep-headline">{inline(headline, 'hl')}</h3>
        <button
          type="button"
          className="n-icon-btn n-icon-btn--sm prep-collapse"
          aria-label="Collapse brief"
          onClick={() => setMode(lowSignal(brief) ? 'closed' : 'preview')}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="M6 15l6-6 6 6" />
          </svg>
        </button>
      </div>
      <hr className="prep-rule" />
      {rest ? <Markdown text={rest} /> : null}
      <div className="prep-meta">
        {steps.length > 0 ? (
          <span className="prep-meta__wrap">
            <button type="button" className="prep-meta__btn" aria-expanded={stepsOpen} onClick={() => setStepsOpen((o) => !o)}>
              {meta}
            </button>
            {stepsOpen ? (
              <div className="prep-popover" role="dialog" aria-label="Brief steps">
                <div className="prep-popover__head">
                  {`${steps.length} ${steps.length === 1 ? 'step' : 'steps'}`}
                  {generationMs > 0 ? <span> · in {(generationMs / 60_000).toFixed(1)} minutes</span> : null}
                </div>
                <StepList steps={steps} />
              </div>
            ) : null}
          </span>
        ) : (
          <span>{meta}</span>
        )}
      </div>
      <div className="prep-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'sources'} className={`prep-tab${tab === 'sources' ? ' is-active' : ''}`} onClick={() => setTab('sources')}>
          Sources
        </button>
        <button type="button" role="tab" aria-selected={tab === 'steps'} className={`prep-tab${tab === 'steps' ? ' is-active' : ''}`} onClick={() => setTab('steps')}>
          Steps
        </button>
      </div>
      {tab === 'sources' ? (
        brief.brief_sources.length === 0 ? (
          <div className="prep-empty">No sources cited.</div>
        ) : (
          <ul className="prep-sources">
            {brief.brief_sources.map((r) => (
              <li key={r.id}>
                <Link href={r.link}>
                  <span className="prep-source__title">{r.title}</span>
                </Link>
                <span className="prep-source__meta">
                  {r.source === 'gmail' ? 'Gmail' : r.source === 'outlook' ? 'Outlook' : 'Notula note'} · {new Date(r.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
                </span>
              </li>
            ))}
          </ul>
        )
      ) : (
        <StepList steps={steps} />
      )}
    </section>
  )
}

/** An icon by tool. */
const STEP_ICON: Record<string, string> = {
  find_meetings_with_people: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4',
  reading_notes: 'M6 3h9l3 3v15H6zM9 10h6M9 14h6M9 18h4',
  write_brief: 'M4 20h4L19 9l-4-4L4 16zM14 6l4 4'
}

function StepList({ steps }: { steps: ReturnType<typeof foldSteps> }): JSX.Element {
  return (
    <ul className="prep-steps">
      {steps.map((s) => (
        <li key={s.id} className={s.done ? (s.success ? 'is-done' : 'is-failed') : 'is-open'}>
          <span className="prep-step__icon" aria-hidden="true">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d={STEP_ICON[s.tool] ?? STEP_ICON['write_brief']} />
            </svg>
          </span>
          {s.message}
        </li>
      ))}
    </ul>
  )
}
