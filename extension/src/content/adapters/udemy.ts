// SPDX-License-Identifier: Apache-2.0
// Udemy lectures: `/course/<slug>/learn/lecture/<id>`. Course, section and lecture come
// from the curriculum sidebar on the right of the course player. Unverified selectors: hand
// check 9 confirms them on a logged-in lecture. `data-purpose` attributes are preferred because
// they are meant as stable hooks; class names are avoided.

import type { ExtOutlineItem } from '../../../../src/shared/types/extension-protocol'
import { clean } from '../../lib/check'
import { UDEMY_LECTURE } from '../../lib/keys'
import type { PageFields } from '../../lib/messages'
import { lessonNumber, textTrackCues, titleWithoutSite } from './common'
import type { Adapter, AdapterEnv, PageResult } from './types'

interface Item {
  title: string
  section: string | null
  sectionIndex: number
  number: number
  current: boolean
  duration: number | null
}

function ids(): { slug: string; lectureId: string } | null {
  const m = UDEMY_LECTURE.exec(location.pathname)
  return m ? { slug: m[1] ?? '', lectureId: m[2] ?? '' } : null
}

/** `5min`, `1hr 2min`, `12:34` → seconds. */
function duration(text: string | null): number | null {
  if (!text) return null
  const clock = /(?:(\d+):)?(\d{1,2}):(\d{2})/.exec(text)
  if (clock) return Number(clock[1] ?? 0) * 3_600 + Number(clock[2]) * 60 + Number(clock[3])
  const h = /(\d+)\s*h/.exec(text)
  const m = /(\d+)\s*min/.exec(text)
  return h || m ? Number(h?.[1] ?? 0) * 3_600 + Number(m?.[1] ?? 0) * 60 : null
}

function items(): Item[] {
  const out: Item[] = []
  const panels = Array.from(document.querySelectorAll('[data-purpose^="section-panel-"]'))
  panels.forEach((panel, si) => {
    const section = clean(panel.querySelector('[data-purpose="section-heading"] h3, [data-purpose="section-heading"]')?.textContent ?? null)
    for (const it of Array.from(panel.querySelectorAll('[data-purpose^="curriculum-item-"]'))) {
      const title = clean(it.querySelector('[data-purpose="item-title"]')?.textContent ?? null)
      if (!title) continue
      out.push({
        title,
        section: section?.replace(/\s*\d+\s*\/\s*\d+.*$/, '') ?? null,
        sectionIndex: si + 1,
        number: lessonNumber(title) ?? out.length + 1,
        current: it.getAttribute('aria-current') === 'true' || !!it.querySelector('[aria-current="true"]'),
        duration: duration(clean(it.textContent))
      })
    }
  })
  return out
}

export function udemyAdapter(env: AdapterEnv): Adapter {
  const key = (): string | null => {
    const i = ids()
    return i ? `udemy:${i.slug}:${i.lectureId}` : null
  }
  return {
    id: 'udemy',
    video: key,
    ad: () => false,
    page(): PageResult | null {
      const i = ids()
      if (!i) return null
      const list = items()
      const current = list.find((x) => x.current) ?? null
      const course =
        clean(document.querySelector('[data-purpose="course-header-title"]')?.textContent ?? null) ?? titleWithoutSite()
      const misses: string[] = []
      if (!list.length) misses.push('outline')
      if (!current) misses.push('lesson-number')
      const page: PageFields = {
        adapter: 'udemy',
        course: { id: i.slug, title: course, url: `${location.origin}/course/${i.slug}/` },
        section: current ? { id: null, title: current.section, index: current.sectionIndex } : null,
        lesson: { id: i.lectureId, title: current?.title ?? null, index: current?.number ?? null, count: list.length || null },
        playlist: null,
        channel: null,
        confidence: { course: 'page', section: 'page', lesson: 'page' }
      }
      return { page, misses }
    },
    outline(): ExtOutlineItem[] {
      return items().map((x) => ({ number: x.number, section: x.section, title: x.title, url: null, duration: x.duration }))
    },
    captions: (video, langs) => textTrackCues(env.media(), video, langs),
    transcript: async () => ({ status: 'none' })
  }
}
