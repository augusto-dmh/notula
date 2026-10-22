// SPDX-License-Identifier: Apache-2.0
// The reader, isolated world, in every frame of a granted site. It watches media, runs the
// site's adapter in the top frame, and reports to the service worker. It never clicks, types or
// changes the page, except the Circle transcript button when the user asks in the popup.

import { clean, isObj, str } from '../lib/check'
import { adapterFor } from '../lib/keys'
import {
  CAPS,
  type CaptionsReply,
  type ContentMessage,
  type FrameEvent,
  type FrameReport,
  type TranscriptRead
} from '../lib/messages'
import { canonicalUrl } from './adapters/common'
import { circleAdapter } from './adapters/circle'
import { courseraAdapter } from './adapters/coursera'
import { genericAdapter } from './adapters/generic'
import type { Adapter, AdapterEnv } from './adapters/types'
import { udemyAdapter } from './adapters/udemy'
import { youtubeAdapter, type YouTubeAdapter } from './adapters/youtube'
import { MediaWatch } from './media'

const PAGE_EVERY_MS = 5_000
const URL_EVERY_MS = 1_000
const PAGE_SETTLE_MS = 1_500

;(() => {
  const g = globalThis as { __notulaReader?: boolean }
  // Injected again by Enable on this site or Link this tab: one reader per frame.
  if (g.__notulaReader) return
  g.__notulaReader = true

  const top = window === window.top
  let alive = true
  let href = location.href
  let lastPage: string | null = null
  const missed = new Set<string>()
  /** The last position outside an ad, reported while an ad shows. */
  let content = { time: 0, duration: null as number | null }

  const send = (msg: ContentMessage): void => {
    if (!alive) return
    try {
      void chrome.runtime.sendMessage(msg).catch(() => undefined)
    } catch {
      // The extension was updated or removed: this copy of the reader is orphaned.
      alive = false
    }
  }

  const env: AdapterEnv = {
    media: () => watch.main(),
    track: (track) => send({ k: 'captions', ...track }),
    chapters: (video, items, source) => send({ k: 'chapters', video, items, source }),
    changed: () => {
      report('change')
      sendPage(true)
    }
  }

  const make = (): Adapter => {
    switch (adapterFor(location.href)) {
      case 'youtube':
        return youtubeAdapter(env)
      case 'circle':
        return circleAdapter(env)
      case 'udemy':
        return udemyAdapter(env)
      case 'coursera':
        return courseraAdapter(env)
      default:
        return genericAdapter(env)
    }
  }

  // The YouTube adapter listens to the main world from the start, even in a frame.
  let adapter: Adapter = make()

  const youtube = adapter.id === 'youtube'
  const watch = new MediaWatch(
    (event) => report(event),
    !youtube,
    // On YouTube only the main player counts; hover previews on the home page play muted elsewhere.
    youtube ? (el) => !!el.closest('#movie_player') : undefined
  )

  const session = (): FrameReport['session'] => {
    const m = navigator.mediaSession?.metadata
    if (!m) return null
    return { title: clean(m.title, CAPS.meta), artist: clean(m.artist, CAPS.meta), album: clean(m.album, CAPS.meta) }
  }

  const build = (event: FrameEvent): FrameReport | null => {
    const el = watch.main()
    if (!el && !top) return null
    const ad = adapter.ad()
    let media = el ? watch.snapshot(el) : null
    if (media) {
      if (!ad) content = { time: media.current_time, duration: media.duration }
      else media = { ...media, current_time: content.time, duration: content.duration }
      const live = (adapter as Partial<YouTubeAdapter>).live?.()
      if (live) media.live = true
    }
    return {
      k: 'report',
      event,
      url: location.href.slice(0, CAPS.url),
      title: (clean(document.title, CAPS.title) ?? '').slice(0, CAPS.title),
      canonical_url: top ? canonicalUrl() : null,
      adapter: adapter.id,
      video: adapter.video(),
      media,
      ad,
      session: session()
    }
  }

  const report = (event: FrameEvent): void => {
    const r = build(event)
    if (r) send(r)
    else if (event === 'gone') send(goneReport())
  }

  /** A sub-frame whose player went away. */
  const goneReport = (): FrameReport => ({
    k: 'report',
    event: 'gone',
    url: location.href.slice(0, CAPS.url),
    title: '',
    canonical_url: null,
    adapter: adapter.id,
    video: null,
    media: null,
    ad: false,
    session: null
  })

  const sendPage = (force: boolean): void => {
    if (!top) return
    const result = adapter.page()
    if (!result) return
    const json = JSON.stringify(result.page)
    if (force || json !== lastPage) {
      lastPage = json
      send({ k: 'page', video: adapter.video(), page: result.page })
    }
    for (const field of result.misses) {
      if (missed.has(field)) continue
      missed.add(field)
      send({ k: 'miss', field })
    }
  }

  // Single-page apps change the URL without a reload: re-read on every change.
  const checkUrl = (): void => {
    if (location.href === href) return
    href = location.href
    if (top && !youtube && adapterFor(href) !== adapter.id) adapter = make()
    lastPage = null
    missed.clear()
    report('change')
    setTimeout(() => sendPage(false), PAGE_SETTLE_MS)
  }

  chrome.runtime.onMessage.addListener((raw, _sender, respond) => {
    if (!isObj(raw)) return undefined
    switch (raw.k) {
      case 'snapshot':
        respond(build('tick'))
        return undefined
      case 'outline':
        respond(top ? adapter.outline() : [])
        return undefined
      case 'captions': {
        const video = str(raw.video, CAPS.key)
        const langs = Array.isArray(raw.langs) ? raw.langs.filter((l): l is string => typeof l === 'string').slice(0, 20) : []
        if (!video) {
          respond({ status: 'unavailable', reason: 'failed' } satisfies CaptionsReply)
          return undefined
        }
        adapter
          .captions(video, langs, raw.replay === true)
          .then(respond, () => respond({ status: 'unavailable', reason: 'failed' } satisfies CaptionsReply))
        return true
      }
      case 'transcript':
        if (!top) return undefined
        adapter.transcript().then(respond, () => respond({ status: 'failed' } satisfies TranscriptRead))
        return true
      default:
        return undefined
    }
  })

  watch.start()
  report('load')
  if (top) {
    setTimeout(() => sendPage(false), PAGE_SETTLE_MS)
    setInterval(() => {
      if (document.visibilityState === 'visible' || watch.main()) sendPage(false)
    }, PAGE_EVERY_MS)
  }
  setInterval(checkUrl, URL_EVERY_MS)
  document.addEventListener('yt-navigate-finish', checkUrl)
})()
