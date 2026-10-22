// SPDX-License-Identifier: Apache-2.0
// Coursera lectures: `/learn/<course-slug>/lecture/<itemId>/<slug>`. Course, module and
// item come from the page navigation (breadcrumbs and the module's item list). Unverified: hand
// check 9 confirms them on a logged-in lecture. Captions come from the player's text tracks.

import type { ExtOutlineItem } from '../../../../src/shared/types/extension-protocol'
import { clean } from '../../lib/check'
import { COURSERA_LECTURE } from '../../lib/keys'
import type { PageFields } from '../../lib/messages'
import { breadcrumbs, lessonNumber, textTrackCues, titleWithoutSite, visible } from './common'
import type { Adapter, AdapterEnv, PageResult } from './types'

function ids(): { slug: string; itemId: string } | null {
  const m = COURSERA_LECTURE.exec(location.pathname)
  return m ? { slug: m[1] ?? '', itemId: m[2] ?? '' } : null
}

/** The module's item links in the navigation, in page order. */
function itemLinks(slug: string): HTMLAnchorElement[] {
  const seen = new Set<string>()
  return Array.from(document.querySelectorAll<HTMLAnchorElement>(`nav a[href*="/learn/${slug}/"], aside a[href*="/learn/${slug}/"]`))
    .filter((a) => /\/(lecture|supplement|quiz|exam|ungradedLab|programming)\//.test(a.pathname))
    .filter((a) => {
      const k = a.pathname
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })
}

export function courseraAdapter(env: AdapterEnv): Adapter {
  const key = (): string | null => {
    const i = ids()
    return i ? `coursera:${i.slug}:${i.itemId}` : null
  }
  return {
    id: 'coursera',
    video: key,
    ad: () => false,
    page(): PageResult | null {
      const i = ids()
      if (!i) return null
      const crumbs = breadcrumbs()
      const heading = Array.from(document.querySelectorAll('main h1, h1')).find((el) => visible(el))
      const title = clean(heading?.textContent ?? null) ?? titleWithoutSite()
      const course = crumbs[0]?.name ?? null
      const moduleName = crumbs.find((c) => /module|m[óo]dulo|week|semana/i.test(c.name))?.name ?? null
      const links = itemLinks(i.slug)
      const index = links.findIndex((a) => a.pathname.includes(`/lecture/${i.itemId}`))
      const misses: string[] = []
      if (!course) misses.push('course')
      if (index < 0) misses.push('lesson-number')
      const page: PageFields = {
        adapter: 'coursera',
        course: { id: i.slug, title: course, url: `${location.origin}/learn/${i.slug}` },
        section: moduleName ? { id: null, title: moduleName, index: lessonNumber(moduleName) } : null,
        lesson: { id: i.itemId, title, index: index >= 0 ? index + 1 : null, count: links.length || null },
        playlist: null,
        channel: null,
        confidence: { course: 'page', section: 'page', lesson: index >= 0 ? 'page' : 'heuristic' }
      }
      return { page, misses }
    },
    outline(): ExtOutlineItem[] {
      const i = ids()
      if (!i) return []
      return itemLinks(i.slug).map((a, n) => ({
        number: n + 1,
        section: null,
        title: clean(a.textContent) ?? a.pathname,
        url: a.href,
        duration: null
      }))
    },
    captions: (video, langs) => textTrackCues(env.media(), video, langs),
    transcript: async () => ({ status: 'none' })
  }
}
