// SPDX-License-Identifier: Apache-2.0
// Export lessons… (the course page's menu): main asks where, then writes the course's notes as
// Markdown into a new folder `<Course> <date>` there, never over an existing file.

import { showToast } from '../../../app/toast'
import { failure, plural } from './helpers'

export async function exportLessons(seriesId: string): Promise<void> {
  try {
    const r = await window.notula.sources.exportSeries({ seriesId })
    if (r) showToast({ id: 'course-export', kind: 'success', title: 'Lessons exported', description: `${plural(r.files, 'file', 'files')} in a new folder.` })
  } catch (err) {
    showToast({ id: 'course-export', kind: 'error', title: 'Couldn’t export the lessons', description: failure(err, 'export the lessons') })
  }
}
