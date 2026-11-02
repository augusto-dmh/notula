// SPDX-License-Identifier: Apache-2.0
// Settings ▸ Sources rows for Courses:
// - Courses: one row per course with Settings (the Course settings sheet) and Remove (with Undo);
// - Browser history: the hosts in `sources.historyHosts` (main-only, read here), each with Revoke,
//   which turns the course's switch off through `sources:update-course` (main drops the host
//   when no other course uses it);
// - When a video outside Courses has no captions (`sources.noCaptions`).

import { useState, type JSX } from 'react'
import type { CourseListItem, SourcesNoCaptionsMode } from '@shared/types/sources'
import { showToast } from '../../../app/toast'
import { SettingsCard, SettingsRow } from '../../settings'
import { Select } from '../../settings/controls'
import { setPrefs, usePrefs } from '../../settings/prefs-store'
import { AddCourseSheet } from '../courses/AddCourseSheet'
import { byLastWatched, refreshCourses, useCourses } from '../courses/courses-store'
import { failure, plural, removeCourseWithUndo } from '../courses/helpers'
import '../courses/courses.css'

function courseLine(c: CourseListItem): string {
  return [c.playsIn ?? 'Not linked yet', c.lessonsTotal > 0 ? `${c.lessonsWithNotes} of ${plural(c.lessonsTotal, 'lesson', 'lessons')} with notes` : null]
    .filter(Boolean)
    .join(' · ')
}

export function CourseRows(): JSX.Element | null {
  const courses = useCourses()
  const [editing, setEditing] = useState<string | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)
  if (!courses) return null
  const rows = byLastWatched(courses)
  return (
    <SettingsCard title="Courses" description="A lesson of a course records on its own, with Undo. Add courses from Courses in the sidebar.">
      {rows.length === 0 ? <SettingsRow title="No courses yet" description="Add one from Courses ▸ Add course in the sidebar, or from a lesson’s card." /> : null}
      {rows.map((c) => (
        <SettingsRow
          key={c.id}
          title={c.title}
          description={courseLine(c)}
          control={
            <span className="course-set__actions">
              <button type="button" id={`course-settings-${c.id}`} className="n-btn n-btn--sm" onClick={() => setEditing(c.id)}>
                Settings
              </button>
              <button
                type="button"
                id={`course-remove-${c.id}`}
                className="n-btn n-btn--sm n-btn--ghost"
                disabled={removing === c.id}
                onClick={() => {
                  setRemoving(c.id)
                  void removeCourseWithUndo(c).finally(() => setRemoving(null))
                }}
              >
                Remove
              </button>
            </span>
          }
        />
      ))}
      {editing ? <AddCourseSheet mode="settings" seriesId={editing} onClose={() => setEditing(null)} /> : null}
    </SettingsCard>
  )
}

export function HistoryHostRows(): JSX.Element | null {
  const prefs = usePrefs()
  const courses = useCourses()
  const [busy, setBusy] = useState<string | null>(null)
  if (!prefs || !courses) return null
  const hosts = prefs['sources.historyHosts']
  const owners = (host: string): CourseListItem[] => courses.filter((c) => c.match?.windowRead && c.match.hosts.includes(host))

  const revoke = async (host: string): Promise<void> => {
    setBusy(host)
    try {
      for (const c of owners(host)) await window.notula.sources.updateCourse({ seriesId: c.id, patch: { match: { windowRead: false } } })
      refreshCourses()
      showToast({ kind: 'success', title: `History access for ${host} revoked`, durationMs: 3_000 })
    } catch (err) {
      showToast({ kind: 'error', title: 'Couldn’t revoke access', description: failure(err, 'revoke access') })
    } finally {
      setBusy(null)
    }
  }

  return (
    <SettingsCard
      title="Browser history"
      description="Sites whose rows Notula may read from a copy of the browser’s history, granted when you add a course. YouTube follows Read browser history above."
    >
      {hosts.length === 0 ? <SettingsRow title="No sites" description="Adding a course with its switch on grants its site here." /> : null}
      {hosts.map((h) => {
        const by = owners(h)
        return (
          <SettingsRow
            key={h}
            title={h}
            description={by.length ? `Used by ${by.map((c) => c.title).join(', ')}.` : 'No course uses it now.'}
            control={
              by.length ? (
                <button type="button" id={`history-revoke-${h}`} className="n-btn n-btn--sm" disabled={busy !== null} onClick={() => void revoke(h)}>
                  {busy === h ? 'Revoking…' : 'Revoke'}
                </button>
              ) : undefined
            }
          />
        )
      })}
    </SettingsCard>
  )
}

const NO_CAPTIONS: { value: SourcesNoCaptionsMode; label: string }[] = [
  { value: 'ask', label: 'Ask' },
  { value: 'always', label: 'Always transcribe' },
  { value: 'never', label: 'Never' }
]

export function NoCaptionsRow(): JSX.Element | null {
  const prefs = usePrefs()
  if (!prefs) return null
  return (
    <SettingsCard title="Videos without captions">
      <SettingsRow
        title="When a video outside Courses has no captions"
        description="Transcribe its audio, or ask in the note first. Courses always transcribe."
        control={
          <Select
            id="sources-no-captions"
            label="When a video outside Courses has no captions"
            value={prefs['sources.noCaptions']}
            options={NO_CAPTIONS}
            onChange={(v) => setPrefs({ 'sources.noCaptions': v })}
          />
        }
      />
    </SettingsCard>
  )
}
