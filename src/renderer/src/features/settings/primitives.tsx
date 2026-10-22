// SPDX-License-Identifier: Apache-2.0
// The Settings layout primitives, exported from `features/settings` for every feature's
// settings blocks, so all settings pages share one look.
//
// - Section heading: small secondary text above a card.
// - Card: 16 px corners, an elevated surface with a hairline ring, 32 px below it.
// - Row: 32 px icon tile, title and description, a trailing control; dashed dividers
//   between rows. A clickable row highlights on hover and draws a full-row focus ring.

import type { JSX, KeyboardEvent, ReactNode } from 'react'
import './settings.css'

/** A titled card of rows. */
export function SettingsCard({
  title,
  description,
  children
}: {
  title?: string
  description?: string
  children: ReactNode
}): JSX.Element {
  return (
    <section className="settings-group">
      {title ? <h2 className="settings-group__title">{title}</h2> : null}
      {description ? <p className="settings-group__description">{description}</p> : null}
      <div className="settings-card">{children}</div>
    </section>
  )
}

/** One row: optional icon tile, title and description on the left, the control on the right. */
export function SettingsRow({
  icon,
  title,
  description,
  control,
  onClick
}: {
  icon?: ReactNode
  title: string
  description?: string
  control?: ReactNode
  onClick?(): void
}): JSX.Element {
  const body = (
    <>
      {icon ? <span className="settings-row__icon">{icon}</span> : null}
      <div className="settings-row__text">
        <div className="settings-row__label">{title}</div>
        {description ? <div className="settings-row__hint">{description}</div> : null}
      </div>
      {control !== undefined ? (
        <div className="settings-row__control" onClick={onClick ? (e) => e.stopPropagation() : undefined}>
          {control}
        </div>
      ) : null}
    </>
  )
  if (!onClick) return <div className="settings-row">{body}</div>
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return
    e.preventDefault()
    onClick()
  }
  return (
    <div className="settings-row settings-row--clickable" role="button" tabIndex={0} onClick={onClick} onKeyDown={onKeyDown}>
      {body}
    </div>
  )
}

/** A section heading inside a settings page. */
export function SettingsSectionHeading({ children }: { children: ReactNode }): JSX.Element {
  return <h2 className="settings-group__title">{children}</h2>
}
