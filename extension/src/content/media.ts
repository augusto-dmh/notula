// SPDX-License-Identifier: Apache-2.0
// The generic reader's media half: watches every <video> and <audio> in this frame,
// including inside open shadow roots (custom players such as Circle's), and picks the main one:
// playing, not muted, largest on screen, latest to start. It reads; it never changes the player.

import type { FrameEvent, FrameMedia } from '../lib/messages'

const EVENTS: [string, FrameEvent][] = [
  ['play', 'play'],
  ['playing', 'play'],
  ['pause', 'pause'],
  ['seeked', 'seek'],
  ['ratechange', 'rate'],
  ['durationchange', 'change'],
  ['loadedmetadata', 'change'],
  ['ended', 'ended'],
  ['emptied', 'change']
]
const SCAN_EVERY_MS = 3_000
const TICK_MS = 1_000

export class MediaWatch {
  private readonly known = new Set<HTMLMediaElement>()
  private readonly startedAt = new WeakMap<HTMLMediaElement, number>()
  private tick: ReturnType<typeof setInterval> | null = null
  private lastScan = 0
  private scanQueued = false

  /**
   * `deep`: also look inside open shadow roots (costly on large pages, so throttled).
   * `accept`: which elements count (YouTube: the main player only, not hover previews).
   */
  constructor(
    private readonly onEvent: (event: FrameEvent) => void,
    private readonly deep: boolean,
    private readonly accept: (el: HTMLMediaElement) => boolean = () => true
  ) {}

  start(): void {
    // Media events don't bubble, but a capturing listener on the document sees light-DOM ones,
    // which is how a new element is noticed the moment it plays.
    document.addEventListener(
      'play',
      (ev) => {
        if (ev.target instanceof HTMLMediaElement && !this.known.has(ev.target) && this.accept(ev.target)) {
          this.attach(ev.target)
          this.handle(ev.target, 'play')
        }
      },
      true
    )
    new MutationObserver(() => this.queueScan()).observe(document.documentElement, { childList: true, subtree: true })
    this.scan()
    if (this.deep) {
      // A custom player can build its shadow tree without touching the light DOM. Look again for
      // a while, until something is found.
      let tries = 40
      const timer = setInterval(() => {
        if (this.known.size > 0 || --tries <= 0) clearInterval(timer)
        else this.scan()
      }, SCAN_EVERY_MS)
    }
  }

  private queueScan(): void {
    if (this.scanQueued) return
    this.scanQueued = true
    const wait = Math.max(0, this.lastScan + SCAN_EVERY_MS - Date.now())
    setTimeout(() => {
      this.scanQueued = false
      this.scan()
    }, wait)
  }

  private scan(): void {
    this.lastScan = Date.now()
    const found = new Set<HTMLMediaElement>(document.querySelectorAll('video, audio'))
    if (this.deep && found.size === 0) collectShadow(document.documentElement, found, 0)
    for (const el of found) if (!this.known.has(el) && this.accept(el)) this.attach(el)
    let removed = false
    for (const el of this.known) {
      if (!el.isConnected) {
        this.known.delete(el)
        removed = true
      }
    }
    if (removed) this.onEvent(this.main() ? 'change' : 'gone')
    this.updateTick()
  }

  private attach(el: HTMLMediaElement): void {
    this.known.add(el)
    for (const [name, event] of EVENTS) el.addEventListener(name, () => this.handle(el, event))
    if (!el.paused) this.startedAt.set(el, Date.now())
  }

  private handle(el: HTMLMediaElement, event: FrameEvent): void {
    if (event === 'play') this.startedAt.set(el, Date.now())
    this.updateTick()
    this.onEvent(event)
  }

  private updateTick(): void {
    const playing = [...this.known].some((el) => !el.paused && !el.ended)
    if (playing && !this.tick) this.tick = setInterval(() => this.onEvent('tick'), TICK_MS)
    if (!playing && this.tick) {
      clearInterval(this.tick)
      this.tick = null
    }
  }

  main(): HTMLMediaElement | null {
    let best: HTMLMediaElement | null = null
    let bestScore: number[] = []
    for (const el of this.known) {
      if (!el.isConnected || (!el.currentSrc && !el.src && el.readyState === 0)) continue
      const score = [el.paused || el.ended ? 0 : 1, el.muted || el.volume === 0 ? 0 : 1, area(el), this.startedAt.get(el) ?? 0]
      if (!best || compare(score, bestScore) > 0) {
        best = el
        bestScore = score
      }
    }
    return best
  }

  snapshot(el: HTMLMediaElement): FrameMedia {
    const live = el.duration === Infinity
    return {
      current_time: Number.isFinite(el.currentTime) ? Math.max(0, el.currentTime) : 0,
      duration: Number.isFinite(el.duration) && el.duration > 0 ? el.duration : null,
      rate: Number.isFinite(el.playbackRate) ? Math.min(16, Math.max(0, el.playbackRate)) : 1,
      paused: el.paused,
      ended: el.ended,
      live,
      muted: el.muted || el.volume === 0,
      started_at: this.startedAt.get(el) ?? 0,
      area: area(el)
    }
  }
}

function compare(a: number[], b: number[]): number {
  for (let i = 0; i < a.length; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/** The on-screen part of the element, in CSS px². Audio elements count as 1. */
function area(el: HTMLMediaElement): number {
  if (el instanceof HTMLAudioElement) return 1
  const r = el.getBoundingClientRect()
  const w = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0))
  const h = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0))
  return Math.round(w * h)
}

const SHADOW_DEPTH = 6

function collectShadow(root: Element | ShadowRoot, out: Set<HTMLMediaElement>, depth: number): void {
  if (depth > SHADOW_DEPTH) return
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT)
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const el = n as Element
    if (el instanceof HTMLMediaElement) out.add(el)
    if (el.shadowRoot) collectShadow(el.shadowRoot, out, depth + 1)
  }
}
