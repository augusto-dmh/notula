// SPDX-License-Identifier: Apache-2.0
// YouTube, isolated world: ad state, playlist and channel, chapters, and captions. The
// player's own data comes from the main-world script (youtube-main.ts) over window.postMessage,
// on the channel it announces. That channel isolates nothing: any page script can read the
// announcement and post on it, so everything from the page's world is untrusted page data. It is
// checked and capped, the first channel heard is kept for the document, and caption bodies are
// accepted at most TIMEDTEXT_PER_MIN times a minute.

import type { ExtCue, ExtOutlineItem } from '../../../../src/shared/types/extension-protocol'
import { clean, isObj, num, str } from '../../lib/check'
import { youtubeVideoId } from '../../lib/keys'
import { CAPS, type CaptionsReply, type CaptionsTrack, type PageFields } from '../../lib/messages'
import { chaptersFromDescription, parseCaptions } from '../parse'
import type { Adapter, AdapterEnv, PageResult } from './types'

type Json = Record<string, unknown>

interface PlayerData {
  videoId: string
  title: string | null
  author: string | null
  channelId: string | null
  lengthSeconds: number | null
  isLive: boolean
  tracks: { lang: string; name: string | null; kind: 'asr' | 'manual'; plain: boolean }[]
  chapters: { start: number; title: string }[] | null
  description: string | null
}

const BODY_MAX = 8 * 1024 * 1024
const REPLAY_WAIT_MS = 10_000
const TIMEDTEXT_PER_MIN = 10

function parsePlayer(v: unknown): PlayerData | null {
  if (!isObj(v)) return null
  const videoId = str(v.videoId, 11)
  if (!videoId || !/^[A-Za-z0-9_-]{11}$/.test(videoId)) return null
  const tracks = Array.isArray(v.tracks)
    ? v.tracks.slice(0, 200).flatMap((t) => {
        if (!isObj(t)) return []
        const lang = str(t.lang, 35)
        if (!lang || !/^[A-Za-z0-9_-]+$/.test(lang)) return []
        return [{ lang, name: clean(typeof t.name === 'string' ? t.name : null, 100), kind: t.kind === 'asr' ? ('asr' as const) : ('manual' as const), plain: t.plain === true }]
      })
    : []
  const chapters = Array.isArray(v.chapters)
    ? v.chapters.slice(0, CAPS.chapters).flatMap((c) => {
        if (!isObj(c)) return []
        const start = num(c.start, 0, 1e7)
        const title = clean(typeof c.title === 'string' ? c.title : null)
        return start !== undefined && title ? [{ start, title }] : []
      })
    : null
  return {
    videoId,
    title: clean(typeof v.title === 'string' ? v.title : null),
    author: clean(typeof v.author === 'string' ? v.author : null, CAPS.meta),
    channelId: typeof v.channelId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v.channelId) ? v.channelId : null,
    lengthSeconds: num(v.lengthSeconds, 0, 1e7) ?? null,
    isLive: v.isLive === true,
    tracks,
    chapters: chapters && chapters.length ? chapters : null,
    description: typeof v.description === 'string' ? v.description.slice(0, 20_000) : null
  }
}

export interface YouTubeAdapter extends Adapter {
  live(): boolean | null
}

export function youtubeAdapter(env: AdapterEnv): YouTubeAdapter {
  let channel: string | null = null
  /** When the last caption bodies were accepted from the page's world. */
  const timedtextAt: number[] = []
  let player: PlayerData | null = null
  let chaptersFor: string | null = null
  let replayId = 0
  const replies = new Map<number, (v: Json) => void>()
  /** Tracks the player fetched on this page, by `<video>|<lang>`. */
  const fetched = new Map<string, CaptionsTrack>()

  const toMain = (msg: Json): void => {
    if (channel) window.postMessage({ channel, dir: 'in', ...msg }, location.origin)
  }

  const onPlayer = (data: PlayerData): void => {
    player = data
    const video = `youtube:${data.videoId}`
    if (chaptersFor !== video) {
      if (data.chapters?.length) {
        chaptersFor = video
        env.chapters(video, data.chapters, 'player')
      } else if (data.description) {
        const items = chaptersFromDescription(data.description)
        if (items) {
          chaptersFor = video
          env.chapters(video, items, 'description')
        }
      }
    }
    env.changed()
  }

  const onTimedtext = (url: string, body: string): void => {
    let u: URL
    try {
      u = new URL(url)
    } catch {
      return
    }
    const v = u.searchParams.get('v')
    const lang = u.searchParams.get('tlang') ?? u.searchParams.get('lang')
    if (!v || !/^[A-Za-z0-9_-]{11}$/.test(v) || !lang || !/^[A-Za-z0-9_-]{1,35}$/.test(lang)) return
    const cues = parseCaptions(body)
    if (!cues?.length) return
    const track: CaptionsTrack = {
      video: `youtube:${v}`,
      lang,
      kind: u.searchParams.get('kind') === 'asr' ? 'asr' : 'manual',
      source: 'player',
      cues
    }
    fetched.set(`${track.video}|${lang}`, track)
    env.track(track)
  }

  window.addEventListener('message', (ev: MessageEvent) => {
    if (ev.source !== window || !isObj(ev.data)) return
    const d = ev.data
    if (d.__notula === 'ready' && typeof d.channel === 'string' && /^notula-yt-[a-z0-9]{6,40}$/.test(d.channel)) {
      // The first channel wins for this document; a reload brings a new isolated script too.
      if (!channel) {
        channel = d.channel
        toMain({ kind: 'player' })
      }
      return
    }
    if (!channel || d.channel !== channel || d.dir !== 'out') return
    if (d.kind === 'player') {
      const p = parsePlayer(d.data)
      if (p) onPlayer(p)
    } else if (d.kind === 'timedtext' && typeof d.url === 'string' && typeof d.body === 'string' && d.body.length <= BODY_MAX) {
      const now = Date.now()
      while (timedtextAt.length && now - (timedtextAt[0] as number) > 60_000) timedtextAt.shift()
      if (timedtextAt.length >= TIMEDTEXT_PER_MIN) return
      timedtextAt.push(now)
      onTimedtext(d.url.slice(0, 4_000), d.body)
    } else if (d.kind === 'replay' && typeof d.id === 'number') {
      replies.get(d.id)?.(d)
      replies.delete(d.id)
    }
  })
  // The main-world script may have announced itself before this script loaded.
  window.postMessage({ __notula: 'ping' }, location.origin)

  const currentPlayer = (): PlayerData | null => {
    const id = youtubeVideoId(location.href)
    return player && player.videoId === id ? player : null
  }

  const askReplay = (lang: string, plain: boolean): Promise<Json | null> =>
    new Promise((resolve) => {
      if (!channel) return resolve(null)
      const id = ++replayId
      replies.set(id, resolve)
      toMain({ kind: 'replay', id, lang, plain })
      setTimeout(() => {
        if (replies.delete(id)) resolve(null)
      }, REPLAY_WAIT_MS)
    })

  const playlist = (): PageFields['playlist'] => {
    const u = new URL(location.href)
    const list = u.searchParams.get('list')
    // Mixes (`RD…`) are generated per viewer; they aren't a series.
    if (!list || list.startsWith('RD') || !/^[A-Za-z0-9_-]{2,64}$/.test(list)) return null
    const panel = document.querySelector('ytd-playlist-panel-renderer')
    const title = clean(panel?.querySelector('#header-description h3, .title')?.textContent ?? null)
    const pos = /(\d+)\s*\/\s*(\d+)/.exec(panel?.querySelector('#publisher-container')?.textContent ?? '')
    const index = Number(u.searchParams.get('index')) || (pos ? Number(pos[1]) : null)
    return { id: list, title, index: index || null, count: pos ? Number(pos[2]) : null }
  }

  const fromFetched = (video: string, langs: string[]): CaptionsTrack | null => {
    for (const l of langs.length ? langs : [...fetched.values()].map((t) => t.lang)) {
      const exact = fetched.get(`${video}|${l}`)
      if (exact) return exact
      const base = l.toLowerCase().split('-')[0]
      for (const t of fetched.values()) if (t.video === video && t.lang.toLowerCase().split('-')[0] === base) return t
    }
    return null
  }

  return {
    id: 'youtube',
    video: () => {
      const id = youtubeVideoId(location.href)
      return id ? `youtube:${id}` : null
    },
    ad: () => !!document.getElementById('movie_player')?.classList.contains('ad-showing'),
    live: () => currentPlayer()?.isLive ?? null,
    page(): PageResult | null {
      const p = currentPlayer()
      const pl = playlist()
      const misses: string[] = []
      if (!p) misses.push('player')
      const page: PageFields = {
        adapter: 'youtube',
        course: null,
        section: null,
        lesson: null,
        playlist: pl,
        channel: p ? { id: p.channelId, name: p.author } : null,
        confidence: { ...(pl ? { playlist: 'page' as const } : {}), ...(p ? { channel: 'page' as const } : {}) }
      }
      return { page, misses }
    },
    outline(): ExtOutlineItem[] {
      return Array.from(document.querySelectorAll('ytd-playlist-panel-renderer ytd-playlist-panel-video-renderer'))
        .slice(0, CAPS.outline)
        .map((el, i) => {
          const a = el.querySelector<HTMLAnchorElement>('a#wc-endpoint, a[href*="watch"]')
          return {
            number: Number(clean(el.querySelector('#index')?.textContent ?? null)) || i + 1,
            section: null,
            title: clean(el.querySelector('#video-title')?.textContent ?? null) ?? '',
            url: a?.href ?? null,
            duration: null
          }
        })
        .filter((x) => x.title)
    },
    async captions(video, langs, replay): Promise<CaptionsReply> {
      // 1. What the player already fetched: zero extra requests.
      const have = fromFetched(video, langs)
      if (have) return { status: 'ok', track: have }
      const p = currentPlayer()
      if (!p || `youtube:${p.videoId}` !== video) return { status: 'unavailable', reason: 'failed' }
      if (!p.tracks.length) return { status: 'unavailable', reason: 'no-track' }
      // 2–3. One replay with the player's token, or a plain track URL; off in local-only mode.
      if (!replay) return { status: 'unavailable', reason: 'policy' }
      const wanted = langs.length ? langs : [p.tracks.find((t) => t.kind === 'manual')?.lang ?? p.tracks[0]?.lang ?? 'en']
      let reason: 'token-required' | 'no-track' | 'failed' = 'no-track'
      for (const lang of wanted.slice(0, 3)) {
        const r = await askReplay(lang, true)
        if (!r) {
          reason = 'failed'
          continue
        }
        if (typeof r.body === 'string' && r.body.length <= BODY_MAX) {
          const cues: ExtCue[] | null = parseCaptions(r.body)
          if (cues?.length) {
            const l = typeof r.lang === 'string' && /^[A-Za-z0-9_-]{1,35}$/.test(r.lang) ? r.lang : lang
            return {
              status: 'ok',
              track: { video, lang: l, kind: r.trackKind === 'asr' ? 'asr' : 'manual', source: 'replay', cues }
            }
          }
        }
        if (r.reason === 'token-required' || r.reason === 'failed') reason = r.reason
      }
      return { status: 'unavailable', reason }
    },
    transcript: async () => ({ status: 'none' })
  }
}
