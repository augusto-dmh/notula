// SPDX-License-Identifier: Apache-2.0
// `/scratchpad`: today's outline first, then every earlier
// day with text, newest first. Each day has a `Today` / `Yesterday` / weekday header with a
// short month and day; today's section is highlighted. Days live in the encrypted DB through
// `scratchpad:list-days`, `scratchpad:get-day` and `scratchpad:save-day`; `scratchpad:changed`
// pushes from other windows reload a day when it differs.

import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import type { Node as PMNode } from '@tiptap/pm/model'
import { parseError } from '@shared/errors'
import { debugLog } from '../../app/platform'
import { DayEditor, type DayEditorHandle } from './DayEditor'
import { dayFromJson } from './schema'
import './scratchpad.css'

interface LoadedDay {
  date: string
  doc: PMNode
}

function localToday(): string {
  const d = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function parseDate(date: string): Date {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number]
  return new Date(y, m - 1, d)
}

/** `Today`, `Yesterday` or the long weekday; then the short month and day. */
function headerFor(date: string, today: string): { primary: string; secondary: string } {
  const d = parseDate(date)
  const days = Math.round((parseDate(today).getTime() - d.getTime()) / 86_400_000)
  const primary = days === 0 ? 'Today' : days === 1 ? 'Yesterday' : d.toLocaleDateString(undefined, { weekday: 'long' })
  return { primary, secondary: d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) }
}

export function ScratchpadPage(): JSX.Element {
  const [today, setToday] = useState(localToday)
  const [days, setDays] = useState<LoadedDay[] | null>(null)
  const [failed, setFailed] = useState(false)
  const editors = useRef(new Map<string, DayEditorHandle>())

  const load = useCallback(async () => {
    try {
      const list = await window.notula.scratchpad.listDays()
      const loaded = await Promise.all(
        list.map(async (s) => {
          const day = await window.notula.scratchpad.getDay({ date: s.date })
          const { doc, readable } = dayFromJson(day.content)
          if (!readable) debugLog('scratchpad:day-unreadable', { date: s.date })
          return { date: s.date, doc }
        })
      )
      setDays(loaded)
      setFailed(false)
    } catch (err) {
      debugLog('scratchpad:load-failed', { code: parseError(err).code })
      setFailed(true)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load, today])

  // A new local day starts a new outline (checked when the window comes back).
  useEffect(() => {
    const onFocus = (): void => setToday((t) => (t === localToday() ? t : localToday()))
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [])

  useEffect(
    () =>
      window.notula.scratchpad.onChanged(({ date }) => {
        const editor = editors.current.get(date)
        if (editor) editor.remoteChanged()
        else void load()
      }),
    [load]
  )

  // Leaving the page saves what is pending (route change).
  useEffect(() => {
    const map = editors.current
    return () => {
      for (const e of map.values()) e.flush()
    }
  }, [])

  return (
    <div className="sp-page">
      <h1 className="visually-hidden">Scratchpad</h1>
      {failed ? (
        <p className="sp-error" role="alert">
          The scratchpad couldn’t load. Close it and open it again.
        </p>
      ) : null}
      {days === null && !failed ? (
        <div className="sp-loading" aria-busy="true">
          <div className="n-skeleton" style={{ height: 22, width: 140 }} />
          <div className="n-skeleton" style={{ height: 120 }} />
        </div>
      ) : null}
      {days?.map((day) => {
        const head = headerFor(day.date, today)
        const isToday = day.date === today
        return (
          <section key={day.date} className={`sp-day${isToday ? ' sp-day--today' : ''}`} aria-label={`${head.primary}, ${head.secondary}`}>
            <header className="sp-day__header">
              <span className="sp-day__primary">{head.primary}</span>
              <span className="sp-day__secondary">{head.secondary}</span>
            </header>
            <DayEditor
              ref={(h) => {
                if (h) editors.current.set(day.date, h)
                else editors.current.delete(day.date)
              }}
              date={day.date}
              initial={day.doc}
              today={isToday}
              label={`${head.primary} outline`}
            />
          </section>
        )
      })}
    </div>
  )
}
