// SPDX-License-Identifier: Apache-2.0
// Dev-only QA helper: reads and steers the YouTube player in the throwaway Chrome (app.mjs chrome).
//   node scripts/dev/qa/yt.mjs state | play | pause | seek <s> | rate <r> | skip-ad | goto <url>
import { chromePage } from './cdp.mjs'

const [cmd, arg] = process.argv.slice(2)
const c = await chromePage('youtube.com')
const p = `document.querySelector('#movie_player')`
const exprs = {
  state: `(() => { const m = ${p}; if (!m) return null; const v = document.querySelector('video'); const d = m.getVideoData?.() ?? {};
    return { title: document.title, id: d.video_id, author: d.author, ad: m.classList.contains('ad-showing'), state: m.getPlayerState?.(),
      t: v && Math.round(v.currentTime), dur: v && Math.round(v.duration), rate: v && v.playbackRate, muted: v && v.muted, url: location.href } })()`,
  play: `document.querySelector('video').play().then(() => 'ok')`,
  pause: `(document.querySelector('video').pause(), 'ok')`,
  seek: `(document.querySelector('video').currentTime = ${Number(arg)}, 'ok')`,
  rate: `(document.querySelector('video').playbackRate = ${Number(arg)}, 'ok')`,
  'skip-ad': `(() => { const b = document.querySelector('.ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern'); if (b) { b.click(); return 'clicked' }
    const v = document.querySelector('video'); if (${p}.classList.contains('ad-showing') && v && isFinite(v.duration)) { v.play(); v.currentTime = v.duration - 0.5; return 'jumped' } return 'none' })()`,
  goto: `(location.href = ${JSON.stringify(arg)}, 'ok')`
}
try {
  if (!exprs[cmd]) throw new Error('usage: yt.mjs state|play|pause|seek <s>|rate <r>|skip-ad|goto <url>')
  console.log(JSON.stringify(await c.evaluate(exprs[cmd])))
} finally {
  c.close()
}
