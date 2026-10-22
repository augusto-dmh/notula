// SPDX-License-Identifier: Apache-2.0
// The generic reader's page half: any site the user turned on, and the member
// areas without an adapter of their own. Best first: JSON-LD, breadcrumbs, `og:title`, the page
// title. Lesson numbers come only from a visible pattern and are marked `heuristic`.

import { canonicalKey } from '../../lib/keys'
import type { PageFields } from '../../lib/messages'
import { breadcrumbs, jsonLd, ldOfType, ldString, lessonNumber, metaContent, textTrackCues, titleWithoutSite } from './common'
import { memberArea } from './hosts'
import type { Adapter, AdapterEnv, PageResult } from './types'

export function genericAdapter(env: AdapterEnv): Adapter {
  return {
    id: 'generic',
    video: () => canonicalKey(location.href),
    ad: () => false,
    page(): PageResult | null {
      const ld = jsonLd()
      const crumbs = breadcrumbs(ld)
      const course = ldOfType(ld, 'Course')
      const lessonLd = ldOfType(ld, 'VideoObject', 'LearningResource')
      const lessonTitle = ldString(lessonLd?.name) ?? metaContent('meta[property="og:title"]') ?? titleWithoutSite()
      const courseTitle = ldString(course?.name) ?? (crumbs.length >= 2 ? crumbs[0]?.name ?? null : null)
      const courseUrl = ldString(course?.url) ?? (crumbs.length >= 2 ? crumbs[0]?.url ?? null : null)
      const sectionTitle = crumbs.length >= 3 ? crumbs[crumbs.length - 2]?.name ?? null : null
      const number = lessonNumber(lessonTitle) ?? lessonNumber(crumbs[crumbs.length - 1]?.name ?? null)
      // Without a course and a lesson pattern there's nothing a member area adds; stay quiet.
      if (!courseTitle && number === null && !memberArea(location.hostname)) return null
      const page: PageFields = {
        adapter: 'generic',
        course: courseTitle ? { id: courseUrl ?? courseTitle, title: courseTitle, url: courseUrl } : null,
        section: sectionTitle ? { id: null, title: sectionTitle, index: lessonNumber(sectionTitle) } : null,
        lesson: { id: null, title: lessonTitle, index: number, count: null },
        playlist: null,
        channel: null,
        confidence: { course: 'heuristic', section: 'heuristic', lesson: 'heuristic' }
      }
      const misses: string[] = []
      if (!courseTitle) misses.push('course')
      if (number === null) misses.push('lesson-number')
      return { page, misses }
    },
    outline: () => [],
    captions: (video, langs) => textTrackCues(env.media(), video, langs),
    transcript: async () => ({ status: 'none' })
  }
}
