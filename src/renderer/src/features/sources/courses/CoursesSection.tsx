// SPDX-License-Identifier: Apache-2.0
// The sidebar's Courses section, between Templates and the folders: one row per course (name and
// notes/lessons), last watched first, then Add course. Shown only while `sources.enabled` is on.
//
// - A row opens the course's folder, whose page is the course page. A course with no folder yet
//   (added before its first note) gets one, named after it, the first time it is opened.
// - The rows come from the shared course list (one `sources:list-courses` per change).
// - It also hosts the Add course sheet for openers outside a mounted view.

import { useState, type JSX } from 'react'
import type { CourseListItem } from '@shared/types/sources'
import { IconPlus } from '../../../app/icons'
import { navigate, useRoute } from '../../../app/navigation'
import { closeSidebarOverlay } from '../../../app/sidebar-state'
import { showToast } from '../../../app/toast'
import { FolderGlyph } from '../../folders/icons'
import { useFolders } from '../../folders/store'
import { AddCourseSheet } from './AddCourseSheet'
import { byLastWatched, closeAddCourseSheet, openAddCourseSheet, useCourses, useSheetRequest } from './courses-store'
import { failure } from './helpers'
import './courses.css'

/** The course's folder, made on first open when it has none. */
export async function openCourse(course: Pick<CourseListItem, 'id' | 'title' | 'folder_id'>): Promise<void> {
  let folderId = course.folder_id
  if (!folderId) {
    try {
      const folder = await window.notula.folders.create({ title: course.title })
      await window.notula.sources.updateSeries({ seriesId: course.id, patch: { folderId: folder.id } })
      folderId = folder.id
    } catch (err) {
      showToast({ kind: 'error', title: 'Couldn’t open this course', description: failure(err, 'open the course') })
      return
    }
  }
  navigate(`/list/${encodeURIComponent(folderId)}`)
}

function progress(c: CourseListItem): string | null {
  return c.lessonsTotal > 0 ? `${c.lessonsWithNotes}/${c.lessonsTotal}` : null
}

function SheetHost(): JSX.Element | null {
  const req = useSheetRequest()
  if (!req) return null
  return (
    <AddCourseSheet
      {...req}
      onClose={(result) => {
        closeAddCourseSheet()
        req.onClose?.(result)
      }}
    />
  )
}

export function CoursesSection(): JSX.Element | null {
  const courses = useCourses()
  const folders = useFolders()
  const route = useRoute()
  const [opening, setOpening] = useState<string | null>(null)
  const activeFolder = route.path.startsWith('/list/') ? (route.params['id'] ?? null) : null

  const rows = courses ? byLastWatched(courses) : []
  return (
    <section className="sidebar-folders course-section" aria-label="Courses">
      <div className="sidebar-folders__heading">Courses</div>
      <ul className="sidebar-folders__list">
        {rows.map((c) => {
          const active = !!c.folder_id && c.folder_id === activeFolder
          const count = progress(c)
          return (
            <li key={c.id} className="sidebar-folders__item">
              <div className={`folder-row course-row${active ? ' is-active' : ''}`}>
                <span className="folder-row__chevron is-empty" aria-hidden="true" />
                <button
                  type="button"
                  id={`course-row-${c.id}`}
                  className="folder-row__link"
                  aria-current={active ? 'page' : undefined}
                  aria-busy={opening === c.id || undefined}
                  title={count ? `${c.title}: ${c.lessonsWithNotes} of ${c.lessonsTotal} lessons with notes` : c.title}
                  onClick={() => {
                    setOpening(c.id)
                    void openCourse(c).finally(() => setOpening(null))
                    closeSidebarOverlay()
                  }}
                >
                  <FolderGlyph icon={c.folder_id ? folders?.byId.get(c.folder_id)?.icon : null} size={15} />
                  <span className="folder-row__title">{c.title}</span>
                  {count ? <span className="course-row__count">{count}</span> : null}
                </button>
              </div>
            </li>
          )
        })}
      </ul>
      <button
        type="button"
        id="courses-add"
        className="folder-row folder-row--add"
        onClick={() => {
          openAddCourseSheet({ mode: 'add' })
          closeSidebarOverlay()
        }}
      >
        <IconPlus size={14} />
        Add course
      </button>
      <SheetHost />
    </section>
  )
}
