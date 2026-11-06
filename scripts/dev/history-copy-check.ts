// SPDX-License-Identifier: Apache-2.0
// Dev-only check for the History snapshot copy policy (src/main/sources/history-copy-policy.ts).
// Pure: fake file stats and a fake clock, no browser profile, no History file, no disk.
// Run: node scripts/dev/history-copy-check.ts   (Node's type stripping; exits 1 on a failure)

const { copyDecision, historySignatureOf, useSnapshot, HISTORY_COPY_MAX } = await import('../../src/main/sources/history-copy-policy.ts')
type FileStat = { size: number; mtimeMs: number }
type Shared = Parameters<typeof useSnapshot>[0] extends Map<string, infer S> ? S : never

let failed = 0
function check(name: string, ok: boolean, detail: string): void {
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `: ${detail}`}`)
}

/** The source and its journal/WAL at `t` seconds: the History mtime is the last change at or before `t`. */
type Stats = (t: number) => (FileStat | null)[]
const changesAt = (secs: readonly number[]): Stats => (t) => {
  const last = Math.max(0, ...secs.filter((c) => c <= t))
  return [{ size: 4096 + last, mtimeMs: 1_000_000 + last * 1000 }, null, null]
}

/** A 15 s lookup at 1 s steps: the seconds it copied at, and its attempts and bytes. */
async function replay(stats: Stats): Promise<{ at: number[]; attempts: number; bytes: number; left: number }> {
  const registry = new Map<string, Shared>()
  let t = 0
  const at: number[] = []
  let live = 0
  const use = useSnapshot(registry, 'History', {
    stat: async () => stats(t),
    copy: async () => {
      at.push(t)
      live++
      return `snap-${at.length}`
    },
    remove: async () => {
      live--
    },
    now: () => t * 1000
  })
  let attempts = 0
  for (; t < 15; t++) {
    attempts++
    await use.read(async () => [])
  }
  const bytes = use.bytes()
  if (use.copies() !== at.length) throw new Error('copies() disagrees with the copies made')
  await use.dispose()
  return { at, attempts, bytes, left: live + registry.size }
}

async function scenario(name: string, stats: Stats, want: number[]): Promise<void> {
  const r = await replay(stats)
  check(name, JSON.stringify(r.at) === JSON.stringify(want) && r.attempts === 15 && r.left === 0, `copied at ${JSON.stringify(r.at)}, attempts ${r.attempts}, left ${r.left}`)
}

await scenario('unchanged file: 1 copy over 15 attempts', changesAt([]), [0])
await scenario('a change every second: copies at 0, 5 and 10 s', changesAt([...Array(15).keys()].map((i) => i + 1)), [0, 5, 10])
await scenario('one change at 2 s: copied again at 5 s', changesAt([2]), [0, 5])
await scenario('one change at 7 s: copied again at 7 s', changesAt([7]), [0, 7])
await scenario('changes at 6 and 8 s: copies at 0, 6 and 11 s', changesAt([6, 8]), [0, 6, 11])
await scenario('a journal that appears at 6 s is a change', (t) => [{ size: 4096, mtimeMs: 1_000_000 }, t >= 6 ? { size: 512, mtimeMs: 1_006_000 } : null, null], [0, 6])

{
  const r = await replay((t) => [{ size: 1000 + t, mtimeMs: t * 1000 }, { size: 10, mtimeMs: t * 1000 }, null])
  check('bytes: every copy\'s files, all copies', r.bytes === 1010 + 1015 + 1020, `bytes ${r.bytes}`)
}

{
  const base = { hasSnapshot: true, copiedSignature: 'a', lastCopyAt: 0, now: 60_000 }
  check('3 copies already: a change gives reuse', copyDecision({ ...base, signature: 'b', copies: HISTORY_COPY_MAX }) === 'reuse', 'copy')
  check('2 copies, 5 s on: a change gives copy', copyDecision({ ...base, signature: 'b', copies: 2, now: 5_000 }) === 'copy', 'reuse')
  check('no snapshot yet: copy, whatever the count', copyDecision({ ...base, hasSnapshot: false, signature: 'a', copies: HISTORY_COPY_MAX }) === 'copy', 'reuse')
  check('a missing file signs as -', historySignatureOf([{ size: 1, mtimeMs: 2 }, null]) === '1:2|-', historySignatureOf([{ size: 1, mtimeMs: 2 }, null]))
}

// Two lookups of one file share a snapshot: one copy, and it stays until the last one disposes.
{
  const registry = new Map<string, Shared>()
  const live = new Set<string>()
  let n = 0
  const io = {
    stat: async () => [{ size: 100, mtimeMs: 1 }, null, null],
    copy: async () => {
      const b = `snap-${++n}`
      live.add(b)
      return b
    },
    remove: async (b: string) => {
      live.delete(b)
    },
    now: () => 0
  }
  const a = useSnapshot(registry, 'History', io)
  const b = useSnapshot(registry, 'History', io)
  const seen = await Promise.all([a.read(async (p) => p), b.read(async (p) => p)])
  check('shared: one copy for two lookups', n === 1 && seen[0] === seen[1] && a.copies() + b.copies() === 1, `copies ${n}`)
  await a.dispose()
  const kept = live.size === 1 && registry.size === 1 && (await b.read(async (p) => live.has(p)))
  check('shared: the first dispose leaves the snapshot to the other', kept, `live ${live.size}`)
  await a.dispose()
  check('shared: a second dispose of one lookup changes nothing', live.size === 1, `live ${live.size}`)
  await b.dispose()
  check('shared: the last dispose removes it', live.size === 0 && registry.size === 0, `live ${live.size}, registry ${registry.size}`)
  const c = useSnapshot(registry, 'History', io)
  await c.read(async () => null)
  check('shared: a later lookup copies afresh', n === 2 && c.copies() === 1, `copies ${n}`)
  await c.dispose()
}

// A failed copy doesn't count: the next read copies again, and the cap still allows 3.
{
  const registry = new Map<string, Shared>()
  let t = 0
  let made = 0
  let fail = true
  const use = useSnapshot(registry, 'History', {
    stat: async () => [{ size: 1, mtimeMs: t }, null, null],
    copy: async () => {
      if (fail) throw Object.assign(new Error('locked'), { code: 'EBUSY' })
      made++
      return `snap-${made}`
    },
    remove: async () => undefined,
    now: () => t * 1000
  })
  const threw = await use.read(async () => null).then(() => false, () => true)
  fail = false
  for (t = 1; t <= 15; t++) await use.read(async () => null)
  check('a failed copy is not counted', threw && made === 3 && use.copies() === 3, `threw ${threw}, made ${made}`)
  await use.dispose()
}

if (failed) {
  console.log(`\n${failed} failed`)
  process.exit(1)
}
console.log('\nall passed')
