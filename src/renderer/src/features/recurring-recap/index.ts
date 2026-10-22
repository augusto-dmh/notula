// SPDX-License-Identifier: Apache-2.0
// The recap of last time.
//
// Mounted by `NotificationCard` in `scheduled-meeting` cards. The classic header `Last time`
// (plus ` · <date>`) always shows; the title and bullets open while the pointer is over the card
// (an expandable panel), and the card window grows with them. `notify:last-time` replaces the
// raw lines with the AI title and bullets when they are ready.

import { createElement, useEffect, useState, type JSX } from 'react'
import type { LastTimeRecap as LastTimeRecapValue } from '@shared/types/notify'
import './recurring-recap.css'

export function LastTimeRecap(p: { notificationId: string; lastTime: LastTimeRecapValue | null }): JSX.Element | null {
  const [value, setValue] = useState<LastTimeRecapValue | null>(p.lastTime)

  useEffect(() => setValue(p.lastTime), [p.lastTime])
  useEffect(
    () =>
      window.notula.notify.onLastTime((e) => {
        if (e.notificationId === p.notificationId) setValue(e.lastTime)
      }),
    [p.notificationId]
  )

  if (!value) return null
  const title = value.title ?? 'Previous meeting'
  return createElement(
    'div',
    { className: `lt-recap${value.status === 'ready' ? ' is-ready' : ''}`, 'aria-label': 'Recap of last time' },
    createElement('div', { className: 'lt-recap__head' }, value.dateLabel ? `Last time · ${value.dateLabel}` : 'Last time'),
    createElement(
      'div',
      { className: 'lt-recap__body' },
      createElement('p', { className: 'lt-recap__title' }, title),
      value.bullets.length
        ? createElement(
            'ul',
            { className: 'lt-recap__bullets' },
            value.bullets.map((b, i) => createElement('li', { key: i }, b))
          )
        : null
    )
  )
}
