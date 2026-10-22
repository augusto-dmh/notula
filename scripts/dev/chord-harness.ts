// SPDX-License-Identifier: Apache-2.0
// Dev-only harness for the dictation bar shortcut engine. Feeds
// scripted key-event sequences to the pure state machine; no hook, no injected keys.
// Run: node scripts/dev/chord-harness.ts   (Node's type stripping; exits 1 on a failure)

import { IDLE, sessionEnded, sessionStartedElsewhere, setSuspended, step, type ChordConfig, type ChordEffect, type ChordState } from '../../src/main/dictation/chord-machine.ts'

const WIN: ChordConfig = { hold: ['ctrl', 'win'], handsFree: ['ctrl', 'space', 'win'], tapMs: 150 }
const MAC: ChordConfig = { hold: ['alt', 'ctrl'], handsFree: ['alt', 'ctrl', 'space'], tapMs: 150 }

type Ev = [key: string, down: boolean, at: number] | ['@ended'] | ['@elsewhere'] | ['@suspend', boolean]

interface Case {
  name: string
  cfg: ChordConfig
  events: Ev[]
  effects: ChordEffect[]
  masks?: number
  mode?: ChordState['mode']
}

const d = (k: string, at: number): Ev => [k, true, at]
const u = (k: string, at: number): Ev => [k, false, at]

const CASES: Case[] = [
  {
    name: 'hold Ctrl+Win 800 ms, release → finish, Start menu masked',
    cfg: WIN,
    events: [d('ctrl', 0), d('win', 20), u('win', 820), u('ctrl', 830)],
    effects: ['start-hold', 'finish'],
    masks: 1,
    mode: 'idle'
  },
  {
    name: 'right-side keys count (ctrl_r + win_r)',
    cfg: WIN,
    events: [d('ctrl_r', 0), d('win_r', 10), u('ctrl_r', 600), u('win_r', 610)],
    effects: ['start-hold', 'finish'],
    masks: 1
  },
  {
    name: 'short tap (<150 ms) → discard silently',
    cfg: WIN,
    events: [d('ctrl', 0), d('win', 10), u('win', 90), u('ctrl', 95)],
    effects: ['start-hold', 'discard'],
    masks: 1,
    mode: 'idle'
  },
  {
    name: 'lock: Space while holding → hands-free; release keeps it; chord again → finish',
    cfg: WIN,
    events: [d('ctrl', 0), d('win', 10), d('space', 400), u('space', 450), u('win', 460), u('ctrl', 470), d('ctrl', 5000), d('win', 5010), d('space', 5020), u('space', 5060), u('win', 5070), u('ctrl', 5080)],
    effects: ['start-hold', 'lock', 'finish'],
    masks: 2,
    mode: 'idle'
  },
  {
    name: 'Esc while holding → cancel; no restart until keys are up',
    cfg: WIN,
    events: [d('ctrl', 0), d('win', 10), d('esc', 500), u('esc', 520), u('win', 600), u('ctrl', 610)],
    effects: ['start-hold', 'cancel'],
    masks: 1,
    mode: 'idle'
  },
  {
    name: 'other key while holding (Ctrl+Win+<letter>) → cancel silently',
    cfg: WIN,
    events: [d('ctrl', 0), d('win', 10), d('other', 40), u('other', 60), u('win', 80), u('ctrl', 90)],
    effects: ['start-hold', 'cancel'],
    masks: 1,
    mode: 'idle'
  },
  {
    name: 'hands-free chord from idle (Space first) → start-hands-free; chord again → finish',
    cfg: WIN,
    events: [d('space', 0), d('ctrl', 5), d('win', 10), u('win', 100), u('ctrl', 105), u('space', 110), d('ctrl', 3000), d('win', 3005), d('space', 3010), u('space', 3050), u('win', 3060), u('ctrl', 3070)],
    effects: ['start-hands-free', 'finish'],
    masks: 2
  },
  {
    name: 'hands-free: Esc cancels',
    cfg: WIN,
    events: [d('ctrl', 0), d('win', 5), d('space', 10), u('space', 50), u('win', 60), u('ctrl', 70), d('esc', 2000), u('esc', 2050)],
    effects: ['start-hold', 'lock', 'cancel'],
    masks: 1,
    mode: 'idle'
  },
  {
    name: 'hands-free: typing other keys does not cancel',
    cfg: WIN,
    events: [d('ctrl', 0), d('win', 5), d('space', 10), u('space', 50), u('win', 60), u('ctrl', 70), d('other', 900), u('other', 950)],
    effects: ['start-hold', 'lock'],
    mode: 'handsFree'
  },
  {
    name: 'mic click started it elsewhere → hands-free chord finishes it',
    cfg: WIN,
    events: [['@elsewhere'], d('ctrl', 100), d('win', 110), d('space', 120), u('space', 150), u('win', 160), u('ctrl', 170)],
    effects: ['finish'],
    masks: 1
  },
  {
    name: 'session ended by a click while holding → release does nothing',
    cfg: WIN,
    events: [d('ctrl', 0), d('win', 10), ['@ended'], u('win', 900), u('ctrl', 910)],
    effects: ['start-hold'],
    masks: 1,
    mode: 'idle'
  },
  {
    name: 'Win alone (no chord fired) → never masked',
    cfg: WIN,
    events: [d('win', 0), u('win', 300), d('ctrl', 1000), u('ctrl', 1100)],
    effects: [],
    masks: 0
  },
  {
    name: 'Win+Ctrl order with an extra Shift → no chord, nothing fires',
    cfg: WIN,
    events: [d('shift', 0), d('win', 5), d('ctrl', 10), u('ctrl', 400), u('win', 410), u('shift', 420)],
    effects: [],
    masks: 0
  },
  {
    name: 'suspended (recording a shortcut in Settings) → nothing fires',
    cfg: WIN,
    events: [['@suspend', true], d('ctrl', 0), d('win', 10), u('win', 600), u('ctrl', 610), ['@suspend', false]],
    effects: [],
    masks: 0,
    mode: 'idle'
  },
  {
    name: 'hold chord off (empty) → hands-free chord still starts directly',
    cfg: { hold: null, handsFree: ['ctrl', 'space', 'win'], tapMs: 150 },
    events: [d('ctrl', 0), d('win', 5), d('space', 10), u('space', 40), u('win', 50), u('ctrl', 60)],
    effects: ['start-hands-free'],
    masks: 1,
    mode: 'handsFree'
  },
  {
    name: 'macOS Ctrl+Option hold (option name) → finish, never masked',
    cfg: MAC,
    events: [d('ctrl', 0), d('option', 10), u('option', 700), u('ctrl', 710)],
    effects: ['start-hold', 'finish'],
    masks: 0
  },
  {
    name: 'Shift pressed during a hold → cancel (another shortcut)',
    cfg: WIN,
    events: [d('ctrl', 0), d('win', 10), d('shift', 300), u('shift', 350), u('win', 400), u('ctrl', 410)],
    effects: ['start-hold', 'cancel'],
    masks: 1,
    mode: 'idle'
  },
  {
    name: 'record chord Win+Alt+M (hook fallback) → record, Start menu masked',
    cfg: { ...WIN, record: ['alt', 'm', 'win'] },
    events: [d('win', 0), d('alt', 10), d('m', 20), u('m', 80), u('alt', 90), u('win', 100)],
    effects: ['record'],
    masks: 1,
    mode: 'idle'
  },
  {
    name: 'record chord does not fire while holding to dictate',
    cfg: { ...WIN, record: ['alt', 'm', 'win'] },
    events: [d('ctrl', 0), d('win', 10), d('alt', 400), u('alt', 450), u('win', 500), u('ctrl', 510)],
    effects: ['start-hold', 'cancel'],
    masks: 1
  },
  {
    name: 'repeat chord after finish starts a new hold',
    cfg: WIN,
    events: [d('ctrl', 0), d('win', 10), u('win', 500), d('win', 700), u('win', 1400), u('ctrl', 1500)],
    effects: ['start-hold', 'finish'],
    masks: 1
  }
]

let failed = 0
for (const c of CASES) {
  let s: ChordState = { ...IDLE }
  const effects: ChordEffect[] = []
  let masks = 0
  for (const ev of c.events) {
    if (ev[0] === '@ended') s = sessionEnded(s)
    else if (ev[0] === '@elsewhere') s = sessionStartedElsewhere(s)
    else if (ev[0] === '@suspend') s = setSuspended(s, ev[1] as boolean)
    else {
      const r = step(s, c.cfg, { key: ev[0], down: ev[1] as boolean, at: ev[2] as number })
      s = r.state
      effects.push(...r.effects)
      if (r.mask) masks++
    }
  }
  const okEffects = JSON.stringify(effects) === JSON.stringify(c.effects)
  const okMasks = c.masks === undefined || masks === c.masks
  const okMode = c.mode === undefined || s.mode === c.mode
  const ok = okEffects && okMasks && okMode
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.name}`)
  if (!ok) console.log(`      effects ${JSON.stringify(effects)} masks ${masks} mode ${s.mode}`)
}
console.log(`\n${CASES.length - failed}/${CASES.length} passed`)
process.exit(failed ? 1 : 0)
