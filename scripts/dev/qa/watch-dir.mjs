// SPDX-License-Identifier: Apache-2.0
// Dev-only QA helper: lists every file under a folder every 250 ms for N seconds and appends
// `<time> <name> <size>` lines to a log (to watch the History copy folder).
//   node scripts/dev/qa/watch-dir.mjs <dir> <seconds> <log>
import { appendFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const [dir, seconds, out] = process.argv.slice(2)
const end = Date.now() + Number(seconds) * 1000
function walk(d) {
  let names = []
  try {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) names = names.concat(walk(p))
      else {
        try {
          names.push(`${e.name} ${statSync(p).size}`)
        } catch {}
      }
    }
  } catch {}
  return names
}
appendFileSync(out, `${new Date().toISOString()} watching ${dir}\n`)
const timer = setInterval(() => {
  const t = new Date().toISOString()
  for (const n of walk(dir)) appendFileSync(out, `${t} ${n}\n`)
  if (Date.now() > end) {
    clearInterval(timer)
    appendFileSync(out, `${new Date().toISOString()} done\n`)
  }
}, 250)
