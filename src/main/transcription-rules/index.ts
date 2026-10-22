// SPDX-License-Identifier: Apache-2.0
// Transcription rules: their IPC and the capture start gate (enforced in main).
//
// - Labs `transcriptionRules.enabled`, off by default. Off, or no enabled rule: evaluation is
//   skipped and adds no delay. Rules and the internal domains are main-only settings, written
//   whole by `transcription-rules:save` after validation.
// - The gate (`transcription-rules`) runs before every fresh start and switch. A matched `block`
//   blocks with `recording_rule`; a matched confirm or override that this note has not
//   acknowledged holds the start until `transcription-rules:resolve` (`confirm` releases it, `decline` cancels it with
//   `start_cancelled`). Acknowledgements live in memory, per note, for the app session.
// - Inputs: the note's linked event (2 min before its start counts as its start; 5 min after its end
//   counts as just before the end) plus the attended calendar events active now, merged by iCalUID +
//   start. In person = no meeting app, after up to 3 s for the first detection result.
// - Runtime: while capturing, calendar-dependent rules are re-checked every 10 min ± 5 s, at
//   the next event boundary + 100 ms and on `calendar:changed`; an `in_person` rule re-checks 3 s
//   after the meeting app goes away. A new block, or an unacknowledged confirm, stops capture with
//   `recording_rule` (the normal drained stop: no audio is lost) and shows the
//   decision. A meeting app that appears within 5 min of an in-person stop retries the start.
// - Locked: a held decision is pushed only after unlock; the start stays held meanwhile.
// - A local log line records each decision (rule ids, condition types, outcome, phase, choice).
//   Nothing is sent anywhere.

import { randomUUID } from 'node:crypto'
import { ipcMain } from 'electron'
import type { InvokeChannel, InvokeReq, InvokeRes, PushChannel } from '@shared/ipc'
import { isBotEmail, isResourceEmail } from '@shared/lib/people'
import type { MicApp } from '@shared/types/meetings'
import type { CalendarAttendee, CalendarEvent, Note } from '@shared/types/notes'
import { RULE_LABELS, TRANSCRIPTION_RULES_LIMITS as L, type RuleAction, type RuleCondition, type RuleDecision, type TranscriptionRule } from '@shared/types/transcription-rules'
import { bad, domainOf, internalDomains, normDomain, normEmail, obj, ownDomains, underDomain } from '../automations/util'
import type { MainContext } from '../context'
import { log } from '../log'

const KEPT = ['always', 'has_outside_guest', 'internal_only', 'guest_domain', 'guest_email', 'in_person', 'event_name'] as const
type KeptType = (typeof KEPT)[number]
const CALENDAR_TYPES: readonly string[] = ['has_outside_guest', 'internal_only', 'guest_domain', 'guest_email', 'event_name']
const ACTIONS: readonly RuleAction[] = ['confirm', 'override', 'block']
const RETRY_AFTER_INPERSON_MS = 300_000

/** What the dialogs need beyond `RuleDecision` (carried on the same object). */
export interface RuleDecisionView extends RuleDecision {
  kind: 'block' | 'override' | 'confirm' | 'none'
  always: boolean
  active: boolean
  concurrentTitle: string | null
  concurrent: boolean
  resolved?: boolean
  retryStart?: boolean
}

// ---------- validation ----------

function validPresentation(v: unknown): TranscriptionRule['presentation'] {
  const p = obj(v)
  const text = typeof p['text'] === 'string' ? p['text'].trim() : ''
  if (!text || text.length > L.messageMax) return { text: null, link: null }
  const l = obj(p['link'])
  const label = typeof l['label'] === 'string' ? l['label'].trim() : ''
  const url = typeof l['url'] === 'string' ? l['url'].trim() : ''
  let link: { label: string; url: string } | null = null
  if (label && label.length <= L.linkLabelMax && url.length <= L.urlMax && /^https?:\/\//i.test(url)) {
    try {
      new URL(url)
      link = { label, url }
    } catch {
      link = null
    }
  }
  return { text, link }
}

function validCondition(v: unknown): RuleCondition {
  const c = obj(v)
  const type = typeof c['type'] === 'string' ? c['type'] : ''
  if (!type) throw bad('Pick when this rule applies.')
  if (!(KEPT as readonly string[]).includes(type)) return { ...c, type } as RuleCondition
  const list = (k: string): unknown[] => (Array.isArray(c[k]) ? (c[k] as unknown[]) : [])
  switch (type as KeptType) {
    case 'guest_domain': {
      const domains = [...new Set(list('domains').map(normDomain))]
      if (domains.includes(null)) throw bad('Enter domains like acme.com.')
      if (!domains.length) throw bad('Add at least one domain.')
      return { type: 'guest_domain', domains: domains as string[] }
    }
    case 'guest_email': {
      const emails = [...new Set(list('emails').map(normEmail))]
      if (emails.includes(null)) throw bad('Enter valid email addresses.')
      if (!emails.length) throw bad('Add at least one email address.')
      return { type: 'guest_email', emails: emails as string[] }
    }
    case 'event_name': {
      const strings = [...new Set(list('strings').map((x) => (typeof x === 'string' ? x.trim().toLowerCase() : '')).filter(Boolean))]
      if (!strings.length) throw bad('Add at least one word.')
      return { type: 'event_name', match: 'contains', strings }
    }
    default:
      return { type } as RuleCondition
  }
}

export function validateRules(raw: unknown): TranscriptionRule[] {
  if (!Array.isArray(raw)) throw bad('Rules must be a list.')
  if (raw.length > L.maxRules) throw bad(`You can have up to ${L.maxRules} rules.`)
  const ids = new Set<string>()
  return raw.map((v) => {
    const r = obj(v)
    let id = typeof r['id'] === 'string' ? r['id'].trim() : ''
    if (!id) id = randomUUID()
    if (id.length > 100) throw bad('A rule id is too long.')
    if (ids.has(id)) throw bad('Rule ids must be unique.')
    ids.add(id)
    const action = r['action'] as RuleAction
    if (!ACTIONS.includes(action)) throw bad('Pick what Notula should do.')
    const condition = validCondition(r['condition'])
    if (condition.type === 'always' && action !== 'confirm') throw bad('A rule that covers every meeting must use Ask first.')
    return { id, enabled: r['enabled'] !== false, action, condition, presentation: validPresentation(r['presentation']) }
  })
}

function validateDomains(raw: unknown): string[] {
  if (!Array.isArray(raw)) throw bad('Internal domains must be a list.')
  const out = [...new Set(raw.map(normDomain))]
  if (out.includes(null)) throw bad('Enter domains like acme.com.')
  if (out.length > 200) throw bad('Up to 200 internal domains.')
  return out as string[]
}

export function defaultText(r: TranscriptionRule): string {
  const t = (RULE_LABELS.defaultTexts as Record<string, string>)[r.condition.type]
  const lead = r.action === 'confirm' ? RULE_LABELS.leads.confirm : RULE_LABELS.leads.other
  return (t ?? `${lead} these meetings`).replace('<lead>', lead)
}

// ---------- evaluation ----------

interface EvalEvent {
  ev: CalendarEvent
  linked: boolean
  concurrent: boolean
  start: number
  end: number
}

const timeOf = (t: CalendarEvent['start']): number => {
  const s = t?.dateTime ?? t?.date
  const n = s ? Date.parse(s) : NaN
  return Number.isFinite(n) ? n : NaN
}

function attended(ev: CalendarEvent, mine: Set<string>): boolean {
  if (ev['status'] === 'cancelled') return false
  const list = Array.isArray(ev.attendees) ? ev.attendees : []
  const me = list.find((a) => a.self === true || mine.has(String(a.email ?? '').toLowerCase()))
  if (me) return me.responseStatus !== 'declined'
  const org = ev['organizer'] as { email?: string; self?: boolean } | undefined
  const creator = ev['creator'] as { email?: string; self?: boolean } | undefined
  if (org?.self || (org?.email && mine.has(org.email.toLowerCase()))) return true
  if (creator?.self || (creator?.email && mine.has(creator.email.toLowerCase()))) return true
  // A calendar with no attendee list is the user's own.
  return list.length === 0
}

function participants(ev: CalendarEvent, mine: Set<string>): string[] {
  const out = new Set<string>()
  const isMe = (p: { email?: unknown; self?: unknown }): boolean => p.self === true || (typeof p.email === 'string' && mine.has(p.email.toLowerCase()))
  for (const a of (Array.isArray(ev.attendees) ? ev.attendees : []) as CalendarAttendee[]) {
    if (!a?.email || isMe(a) || a.resource || a.responseStatus === 'declined') continue
    const e = a.email.trim().toLowerCase()
    if (isResourceEmail(e) || isBotEmail(e)) continue
    out.add(e)
  }
  const org = ev['organizer'] as { email?: string; self?: boolean } | undefined
  if (org?.email && !isMe(org)) {
    const e = org.email.trim().toLowerCase()
    if (!isResourceEmail(e) && !isBotEmail(e)) out.add(e)
  }
  return [...out]
}

function matchCount(c: RuleCondition, people: string[], title: string, internal: string[], inPerson: boolean): number {
  switch (c.type) {
    case 'always':
      return 1
    case 'in_person':
      return inPerson ? 1 : 0
    case 'has_outside_guest':
      return internal.length ? people.filter((e) => !underDomain(domainOf(e), internal)).length : 0
    case 'internal_only':
      return internal.length && people.length && people.every((e) => underDomain(domainOf(e), internal)) ? people.length : 0
    case 'guest_domain': {
      const ds = (c as { domains: string[] }).domains
      return people.filter((e) => underDomain(domainOf(e), ds)).length
    }
    case 'guest_email': {
      const es = (c as { emails: string[] }).emails
      return people.filter((e) => es.includes(e)).length
    }
    case 'event_name': {
      const t = title.toLowerCase()
      return (c as { strings: string[] }).strings.filter((s) => s && t.includes(s)).length
    }
    default:
      // guest_group, consent_page_absent and unknown types: kept, never matched.
      return 0
  }
}

export function registerTranscriptionRules(ctx: MainContext): void {
  /** Note id → acknowledged rule ids (this app session). */
  const acks = new Map<string, Set<string>>()
  /** The decision a held start or a runtime stop waits on. */
  let pending: { noteId: string; key: string; phase: 'start' | 'runtime'; ruleIds: string[]; inPerson: boolean } | null = null
  let micApps: MicApp[] = []
  let micReported = false
  const micWaiters = new Set<() => void>()
  let capture: { noteId: string; startedAt: number } | null = null
  let runtimeTimer: ReturnType<typeof setTimeout> | null = null
  let boundaryTimer: ReturnType<typeof setTimeout> | null = null
  let inPersonTimer: ReturnType<typeof setTimeout> | null = null
  let inPersonStop: { noteId: string; at: number } | null = null

  async function activeRules(): Promise<TranscriptionRule[]> {
    const s = await ctx.settings.getAll()
    if (!s['transcriptionRules.enabled']) return []
    return s['transcriptionRules.rules'].filter((r) => r.enabled)
  }

  function waitForMic(): Promise<void> {
    if (micReported) return Promise.resolve()
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(t)
        micWaiters.delete(done)
        resolve()
      }
      const t = setTimeout(done, L.firstResultWaitMs)
      micWaiters.add(done)
    })
  }

  async function evaluate(noteId: string, phase: 'start' | 'runtime', rules: TranscriptionRule[], opts: { calendarOnly: boolean; at?: number }): Promise<RuleDecisionView> {
    const key = randomUUID()
    const none: RuleDecisionView = { noteId, outcome: 'allow', decisionKey: key, phase, matchedRuleIds: [], presentation: [], kind: 'none', always: false, active: false, concurrentTitle: null, concurrent: false }
    const use = rules.filter((r) => (KEPT as readonly string[]).includes(r.condition.type) && (!opts.calendarOnly || CALENDAR_TYPES.includes(r.condition.type)))
    if (!use.length) return none
    if (phase === 'start' && use.some((r) => r.condition.type === 'in_person')) await waitForMic()
    const note: Note | null = await ctx.storage.getNote(noteId)
    const now = opts.at ?? Date.now()
    const mine = new Set((await ctx.calendar.myEmails().catch(() => [] as string[])).map((e) => e.toLowerCase()))
    const internal = await internalDomains(ctx)
    // The linked event, with its grace windows (step 11).
    const events: EvalEvent[] = []
    let at = now
    const linked = note?.linked_event && note.linked_event['status'] !== 'cancelled' ? note.linked_event : null
    if (linked) {
      const start = timeOf(linked.start)
      const end = timeOf(linked.end)
      if (Number.isFinite(start) && now < start && start - now <= L.eventGraceStartMs) at = start
      else if (Number.isFinite(end) && now >= end && now - end <= L.eventGraceEndMs && (!capture || capture.startedAt < end)) at = end - 1
      events.push({ ev: linked, linked: true, concurrent: false, start, end })
    }
    if (use.some((r) => CALENDAR_TYPES.includes(r.condition.type))) {
      try {
        const list = await ctx.calendar.listEvents({ from: new Date(at - 86_400_000).toISOString(), to: new Date(at + 60_000).toISOString() })
        for (const ev of list) {
          const start = timeOf(ev.start)
          const end = timeOf(ev.end)
          if (!(start <= at && at < end) || !attended(ev, mine)) continue
          const same = events.find((x) => (x.ev.id === ev.id || (!!ev.iCalUID && x.ev.iCalUID === ev.iCalUID)) && x.start === start)
          if (same) {
            same.concurrent = true
            const seen = new Set((same.ev.attendees ?? []).map((a) => a.email?.toLowerCase()))
            same.ev = { ...same.ev, attendees: [...(same.ev.attendees ?? []), ...(ev.attendees ?? []).filter((a) => !seen.has(a.email?.toLowerCase()))] }
          } else events.push({ ev, linked: false, concurrent: true, start, end })
        }
      } catch {
        log('warn', 'transcription-rules-events-error', { noteId })
      }
    }
    const inPerson = micApps.length === 0
    const acked = acks.get(noteId) ?? new Set<string>()
    const hits: { rule: TranscriptionRule; ev: EvalEvent | null }[] = []
    for (const r of use) {
      if (CALENDAR_TYPES.includes(r.condition.type)) {
        for (const e of events) {
          if (matchCount(r.condition, participants(e.ev, mine), String(e.ev.summary ?? ''), internal, inPerson) > 0) {
            hits.push({ rule: r, ev: e })
            break
          }
        }
      } else if (matchCount(r.condition, [], '', internal, inPerson) > 0) hits.push({ rule: r, ev: null })
    }
    const blocks = hits.filter((h) => h.rule.action === 'block')
    const confirms = hits.filter((h) => h.rule.action !== 'block' && !acked.has(h.rule.id))
    const winners = blocks.length ? blocks : confirms
    if (!winners.length) return none
    const conc = winners.find((h) => h.ev && h.ev.concurrent && !h.ev.linked)?.ev ?? null
    const texts = new Map<string, TranscriptionRule['presentation']>()
    for (const h of winners) {
      const text = h.rule.presentation.text ?? defaultText(h.rule)
      if (!texts.has(text)) texts.set(text, { text, link: h.rule.presentation.link })
    }
    return {
      noteId,
      outcome: blocks.length ? 'block' : 'confirm',
      decisionKey: key,
      phase,
      matchedRuleIds: winners.map((h) => h.rule.id),
      presentation: [...texts.values()],
      kind: blocks.length ? 'block' : winners.some((h) => h.rule.action === 'override') ? 'override' : 'confirm',
      always: winners.some((h) => h.rule.condition.type === 'always'),
      active: winners.some((h) => h.ev && h.ev.start <= now && now < h.ev.end),
      concurrentTitle: conc ? String(conc.ev.summary ?? '') || null : null,
      concurrent: !!conc
    }
  }

  function logDecision(d: RuleDecisionView, rules: TranscriptionRule[], choice: string | null): void {
    const byId = new Map(rules.map((r) => [r.id, r]))
    log('info', 'transcription-rules:decision', {
      noteId: d.noteId,
      outcome: d.outcome,
      phase: d.phase,
      ruleIds: d.matchedRuleIds.join(','),
      conditions: d.matchedRuleIds.map((id) => byId.get(id)?.condition.type ?? '?').join(','),
      choice
    })
  }

  /** While Notula is locked, the decision waits for unlock. */
  function push(d: RuleDecisionView): void {
    const send = (): void => {
      for (const wc of ctx.windows.targets()) wc.send('transcription-rules:decision' satisfies PushChannel, d)
    }
    if (!ctx.deviceLock.isLocked()) {
      send()
      return
    }
    log('info', 'transcription-rules:held-while-locked', { noteId: d.noteId })
    const t = setInterval(() => {
      if (pending?.key !== d.decisionKey && !d.resolved) {
        clearInterval(t)
        return
      }
      if (ctx.deviceLock.isLocked()) return
      clearInterval(t)
      send()
    }, 1_000)
    t.unref?.()
  }

  function pushResolved(noteId: string, key: string, retryStart = false): void {
    push({ noteId, outcome: 'allow', decisionKey: key, phase: 'start', matchedRuleIds: [], presentation: [], kind: 'none', always: false, active: false, concurrentTitle: null, concurrent: false, resolved: true, retryStart })
  }

  // ---------- the start gate ----------

  ctx.capture.registerStartGate({
    id: 'transcription-rules',
    beforeStart: async ({ noteId }) => {
      const rules = await activeRules()
      if (!rules.length) return { result: 'proceed' }
      const d = await evaluate(noteId, 'start', rules, { calendarOnly: false })
      logDecision(d, rules, null)
      if (d.outcome === 'allow') return { result: 'proceed' }
      if (pending && pending.noteId !== noteId) pushResolved(pending.noteId, pending.key)
      pending = { noteId, key: d.decisionKey, phase: 'start', ruleIds: d.matchedRuleIds, inPerson: rules.some((r) => d.matchedRuleIds.includes(r.id) && r.condition.type === 'in_person') }
      push(d)
      if (d.outcome === 'block') {
        pending = null
        return { result: 'block', reason: 'recording_rule' }
      }
      return { result: 'hold' }
    }
  })

  // ---------- runtime ----------

  function clearRuntime(): void {
    for (const t of [runtimeTimer, boundaryTimer, inPersonTimer]) if (t) clearTimeout(t)
    runtimeTimer = boundaryTimer = inPersonTimer = null
  }

  async function runtimeCheck(why: string): Promise<void> {
    const c = capture
    if (!c || ctx.capture.currentNoteId() !== c.noteId) return
    const rules = await activeRules()
    if (!rules.length) return
    const d = await evaluate(c.noteId, 'runtime', rules, { calendarOnly: why !== 'in_person' })
    if (d.outcome === 'allow' || capture !== c) return
    logDecision(d, rules, null)
    pending = { noteId: c.noteId, key: d.decisionKey, phase: 'runtime', ruleIds: d.matchedRuleIds, inPerson: why === 'in_person' }
    if (why === 'in_person') inPersonStop = { noteId: c.noteId, at: Date.now() }
    log('info', 'transcription-rules:runtime-stop', { noteId: c.noteId, why })
    await ctx.capture.stop('recording_rule')
    push(d)
  }

  async function scheduleRuntime(): Promise<void> {
    clearRuntime()
    const c = capture
    if (!c) return
    const rules = await activeRules()
    if (!rules.some((r) => CALENDAR_TYPES.includes(r.condition.type) || r.condition.type === 'in_person')) return
    const jitter = Math.floor(Math.random() * L.jitterMs)
    runtimeTimer = setTimeout(() => void runtimeCheck('poll').finally(() => void scheduleRuntime()), L.runtimeCheckMs + jitter)
    runtimeTimer.unref?.()
    // The next start or end boundary of an event around now (+100 ms).
    try {
      const now = Date.now()
      const list = await ctx.calendar.listEvents({ from: new Date(now - 86_400_000).toISOString(), to: new Date(now + 86_400_000).toISOString() })
      const next = list.flatMap((e) => [timeOf(e.start), timeOf(e.end)]).filter((t) => Number.isFinite(t) && t > now).sort((a, b) => a - b)[0]
      if (next !== undefined && next - now < 2 ** 31 - 1) {
        boundaryTimer = setTimeout(() => void runtimeCheck('boundary').finally(() => void scheduleRuntime()), next - now + 100)
        boundaryTimer.unref?.()
      }
    } catch {
      // The poll still runs.
    }
  }

  ctx.bus.on('capture:started', (e) => {
    capture = { noteId: e.noteId, startedAt: Date.parse(e.startedAt) || Date.now() }
    void scheduleRuntime()
  })
  ctx.bus.on('capture:stopped', () => {
    capture = null
    clearRuntime()
  })
  ctx.bus.on('calendar:changed', () => {
    if (capture) void runtimeCheck('calendar').finally(() => void scheduleRuntime())
  })
  ctx.bus.on('meetings:mic-apps', (e) => {
    micApps = e.apps
    micReported = true
    for (const w of [...micWaiters]) w()
    if (e.apps.length) {
      if (inPersonTimer) clearTimeout(inPersonTimer)
      inPersonTimer = null
      // A meeting app within 5 min of an in-person decision retries the start.
      const p = pending
      if (p?.inPerson) {
        void (async () => {
          const rules = await activeRules()
          const d = await evaluate(p.noteId, 'start', rules, { calendarOnly: false })
          if (d.outcome !== 'allow' || pending?.key !== p.key) return
          pending = null
          const held = ctx.capture.heldStart()
          if (held?.noteId === p.noteId) {
            ctx.capture.releaseHeldStart(p.noteId)
            pushResolved(p.noteId, p.key)
          } else if (inPersonStop?.noteId === p.noteId && Date.now() - inPersonStop.at <= RETRY_AFTER_INPERSON_MS) {
            pushResolved(p.noteId, p.key, true)
          }
          log('info', 'transcription-rules:retry-after-meeting-app', { noteId: p.noteId })
        })().catch(() => undefined)
      }
    } else if (capture && !inPersonTimer) {
      inPersonTimer = setTimeout(() => {
        inPersonTimer = null
        if (micApps.length === 0) void runtimeCheck('in_person')
      }, L.runtimeGraceMs)
      inPersonTimer.unref?.()
    }
  })

  // ---------- IPC ----------

  ipcMain.handle('transcription-rules:list' satisfies InvokeChannel, async (): Promise<InvokeRes<'transcription-rules:list'>> => {
    const s = await ctx.settings.getAll()
    const rules = s['transcriptionRules.rules']
    let domains = s['transcriptionRules.internalDomains']
    // The first value is the user's own domains, until the user saves a list.
    if (!domains.length && !rules.length) domains = await ownDomains(ctx)
    return { rules, internalDomains: domains }
  })

  ipcMain.handle('transcription-rules:save' satisfies InvokeChannel, async (_e, req: InvokeReq<'transcription-rules:save'>): Promise<InvokeRes<'transcription-rules:save'>> => {
    const r = obj(req)
    const rules = validateRules(r['rules'])
    const internal = validateDomains(r['internalDomains'] ?? [])
    await ctx.settings.set('transcriptionRules.rules', rules)
    await ctx.settings.set('transcriptionRules.internalDomains', internal)
    log('info', 'transcription-rules:saved', { rules: rules.length, enabled: rules.filter((x) => x.enabled).length, domains: internal.length })
    if (capture) void runtimeCheck('saved').finally(() => void scheduleRuntime())
    return { rules, internalDomains: internal }
  })

  ipcMain.handle('transcription-rules:decide' satisfies InvokeChannel, async (_e, req: InvokeReq<'transcription-rules:decide'>): Promise<InvokeRes<'transcription-rules:decide'>> => {
    const noteId = obj(req)['noteId']
    if (typeof noteId !== 'string' || !noteId) throw bad('noteId is required')
    const rules = await activeRules()
    return evaluate(noteId, 'start', rules, { calendarOnly: false })
  })

  ipcMain.handle('transcription-rules:resolve' satisfies InvokeChannel, async (_e, req: InvokeReq<'transcription-rules:resolve'>): Promise<void> => {
    const r = obj(req)
    const noteId = r['noteId']
    const key = r['decisionKey']
    const choice = r['choice']
    if (typeof noteId !== 'string' || typeof key !== 'string' || (choice !== 'confirm' && choice !== 'decline')) throw bad('noteId, decisionKey and choice are required')
    const p = pending
    if (!p || p.noteId !== noteId || p.key !== key) return
    pending = null
    log('info', 'transcription-rules:resolved', { noteId, phase: p.phase, ruleIds: p.ruleIds.join(','), choice })
    const held = ctx.capture.heldStart()
    if (choice === 'confirm') {
      const set = acks.get(noteId) ?? new Set<string>()
      for (const id of p.ruleIds) set.add(id)
      acks.set(noteId, set)
      if (held?.noteId === noteId && held.gateId === 'transcription-rules') ctx.capture.releaseHeldStart(noteId)
      pushResolved(noteId, key, p.phase === 'runtime')
      return
    }
    if (held?.noteId === noteId) ctx.capture.cancelHeldStart(noteId, 'start_cancelled')
    pushResolved(noteId, key)
  })
}
