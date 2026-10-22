// SPDX-License-Identifier: Apache-2.0
// Automations: their IPC and their own scheduler.
//
// - Personal rules only, at most 50, behind Labs `automations.enabled`. Rows are validated here.
// - "A meeting ends" = the note's capture stopped, then its summary generation finished, or 2 min
//   passed with none started (`endedMeetingNotes`). Each enabled rule runs once per note
//   (`automation_runs` unique on rule and note), only for meetings that ended after the rule was
//   created or enabled, and only while Notula runs; a 7-day catch-up runs at launch.
// - Predicates: every `include` must match and no `exclude` may. Attendees come from the
//   note's event (or its people), without the user, rooms and bots. "Internal" is
//   `transcriptionRules.internalDomains`, else the user's own non-free-mail domain. An unclassified
//   note is classified first through `ctx.tags.classify`.
// - Actions: `file_in_folder` adds through storage (bound folder integrations fire as for any add);
//   a missing folder fails the run and turns the rule off. `post_webhook` queues a webhook delivery;
//   a sensitive note, or "Ask before sending", waits as `needs_confirmation`. Local-only records a
//   webhook run `failed` with `local-only mode`; folder routing still runs.
// - Customer calls' built-in rule rides this loop with its own gate, even
//   with `automations.enabled` off. Its row has the fixed id CUSTOMER_CALLS_RULE_ID and is never listed.

import { app, ipcMain } from 'electron'
import { notulaError } from '@shared/errors'
import type { InvokeChannel, InvokeReq, InvokeRes, PushChannel } from '@shared/ipc'
import { isBotEmail, isResourceEmail } from '@shared/lib/people'
import { AUTOMATION_LIMITS, type AutomationAction, type AutomationPredicate, type AutomationRule, type AutomationRuleInput, type AutomationRun, type AutomationRunStatus } from '@shared/types/automations'
import { CUSTOMER_CALLS } from '@shared/types/customer-calls'
import type { MainContext } from '../context'
import { expected } from '../ipc-expected'
import { log } from '../log'
import { egressBlocked, LOCAL_ONLY_REASON } from '../privacy'
import { isExcluded } from '../repos/crm-repo'
import { webhooks } from '../webhooks'
import { bad, domainOf, internalDomains, normDomain, normEmail, obj, onStorageReady, underDomain } from './util'

export const CUSTOMER_CALLS_RULE_ID = 'builtin-customer-calls'
export const FOLDER_GONE = 'The folder for this automation was deleted.'
const TICK_MS = 60_000
const PREDICATE_TYPES: readonly AutomationPredicate['type'][] = ['all', 'person', 'company', 'recurring', 'classification', 'external', 'internal']
const RUN_STATUSES: readonly AutomationRunStatus[] = ['matched', 'no_match', 'needs_confirmation', 'executed', 'dismissed', 'failed']

type StoredRule = AutomationRule & { enabled_at?: string | null }
type Facts = Awaited<ReturnType<MainContext['storage']['automationFacts']>>

// ---------- validation (step 2) ----------

function validatePredicate(v: unknown): AutomationPredicate {
  const p = obj(v)
  const type = p['type'] as AutomationPredicate['type']
  if (!PREDICATE_TYPES.includes(type)) throw bad('This filter can’t be saved.')
  const operator = p['operator'] === 'exclude' ? 'exclude' : 'include'
  const raw = Array.isArray(p['selected_ids']) ? (p['selected_ids'] as unknown[]) : []
  if (raw.length > 1_000) throw bad('Too many values in a filter.')
  let ids: string[] = []
  if (type === 'person') {
    ids = [...new Set(raw.map(normEmail).filter((x): x is string => !!x))]
    if (!ids.length) throw bad('Add at least one person.')
    if (operator === 'include' && ids.length > AUTOMATION_LIMITS.personMax) throw bad(`Up to ${AUTOMATION_LIMITS.personMax} people.`)
  } else if (type === 'company') {
    ids = [...new Set(raw.map(normDomain).filter((x): x is string => !!x))]
    if (!ids.length) throw bad('Add at least one company domain, like acme.com.')
  } else if (type === 'recurring' || type === 'classification') {
    ids = [...new Set(raw.filter((x): x is string => typeof x === 'string' && x.trim().length > 0 && x.length <= 200).map((x) => x.trim()))]
    if (!ids.length) throw bad(type === 'recurring' ? 'Pick a recurring meeting.' : 'Pick a meeting type.')
  }
  const out: AutomationPredicate = { type, operator, selected_ids: ids }
  if (type === 'external') out.config = { skip_shared_inboxes: obj(p['config'])['skip_shared_inboxes'] !== false }
  return out
}

function validateAction(v: unknown): AutomationAction {
  const a = obj(v)
  if (a['type'] === 'file_in_folder' && typeof a['folder_id'] === 'string' && a['folder_id']) return { type: 'file_in_folder', folder_id: a['folder_id'] }
  if (a['type'] === 'post_webhook' && typeof a['webhook_id'] === 'string' && a['webhook_id']) return { type: 'post_webhook', webhook_id: a['webhook_id'] }
  throw bad('Pick what this automation does.')
}

function validateRule(v: unknown): AutomationRuleInput {
  const r = obj(v)
  const name = typeof r['name'] === 'string' ? r['name'].trim() : ''
  if (name.length > AUTOMATION_LIMITS.nameMax) throw bad(`Keep the name under ${AUTOMATION_LIMITS.nameMax} characters.`)
  const description = typeof r['description'] === 'string' && r['description'].trim() ? r['description'].trim().slice(0, 2_000) : null
  const predicates = (Array.isArray(r['predicates']) ? (r['predicates'] as unknown[]) : []).slice(0, 20).map(validatePredicate)
  const actions = Array.isArray(r['actions']) ? (r['actions'] as unknown[]) : []
  if (actions.length !== 1) throw bad('Pick what this automation does.')
  const out: AutomationRuleInput = {
    name: name || 'Untitled automation',
    description,
    enabled: r['enabled'] !== false,
    trigger: 'meeting_ended',
    predicates: predicates.length ? predicates : [{ type: 'all', operator: 'include', selected_ids: [] }],
    actions: [validateAction(actions[0])],
    confirm_sends: r['confirm_sends'] !== false
  }
  if (typeof r['id'] === 'string' && r['id']) out.id = r['id']
  return out
}

// ---------- evaluation ----------

interface Attendees {
  emails: string[]
}

async function attendeesOf(ctx: MainContext, facts: Facts): Promise<Attendees> {
  const mine = new Set((await ctx.calendar.myEmails().catch(() => [] as string[])).map((e) => e.toLowerCase()))
  return { emails: facts.attendees.map((a) => a.email).filter((e) => !mine.has(e) && !isResourceEmail(e) && !isBotEmail(e)) }
}

async function predicateMatches(ctx: MainContext, p: AutomationPredicate, facts: Facts, people: Attendees): Promise<boolean> {
  switch (p.type) {
    case 'all':
      return true
    case 'person':
      return people.emails.some((e) => p.selected_ids.includes(e))
    case 'company':
      return people.emails.some((e) => underDomain(domainOf(e), p.selected_ids))
    case 'recurring':
      return !!facts.recurringEventId && p.selected_ids.includes(facts.recurringEventId)
    case 'classification':
      return !!facts.meetingType && p.selected_ids.includes(facts.meetingType)
    case 'external': {
      const internal = await internalDomains(ctx)
      if (!internal.length) return false
      const generic = p.config?.skip_shared_inboxes !== false ? new Set((await ctx.settings.get('people.genericEmailDomains')).map((d) => d.toLowerCase())) : new Set<string>()
      return people.emails.some((e) => {
        const d = domainOf(e)
        return !underDomain(d, internal) && !generic.has(d)
      })
    }
    case 'internal': {
      const internal = await internalDomains(ctx)
      return internal.length > 0 && people.emails.length > 0 && people.emails.every((e) => underDomain(domainOf(e), internal))
    }
  }
}

export async function rulePredicatesMatch(ctx: MainContext, predicates: AutomationPredicate[], facts: Facts): Promise<boolean> {
  const people = await attendeesOf(ctx, facts)
  for (const p of predicates) {
    const hit = await predicateMatches(ctx, p, facts, people)
    if (p.operator === 'include' ? !hit : hit) return false
  }
  return true
}

// ---------- the service ----------

export interface AutomationsService {
  /** Runs a pass now (Customer calls' switches, a rule change). */
  wake(): void
}

let service: AutomationsService | null = null
export function automations(): AutomationsService | null {
  return service
}

export function registerAutomations(ctx: MainContext): void {
  let ready = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let running: Promise<void> | null = null
  let again = false
  /** `<rule>:<note>` pairs with a run row, so a pass does not re-query them. */
  const done = new Set<string>()
  /** Notes classified on request this session (one try each). */
  const classifyTried = new Set<string>()

  const pushChanged = (ruleIds: string[]): void => {
    for (const wc of ctx.windows.targets()) wc.send('automations:changed' satisfies PushChannel, { ruleIds })
  }

  async function userRules(): Promise<StoredRule[]> {
    return ((await ctx.storage.listAutomationRules()) as StoredRule[]).filter((r) => r.id !== CUSTOMER_CALLS_RULE_ID)
  }

  function schedule(ms: number): void {
    if (!ready) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      void pass()
    }, ms)
    timer.unref?.()
  }

  function pass(): Promise<void> {
    if (running) {
      again = true
      return running
    }
    running = runPass()
      .catch((err: unknown) => log('error', 'automations:pass-failed', { err: err instanceof Error ? err.message.slice(0, 60) : 'error' }))
      .finally(() => {
        running = null
        if (again) {
          again = false
          schedule(250)
        } else schedule(TICK_MS)
      })
    return running
  }

  /** The note's facts, classified first when a rule needs a meeting type; null = try again later. */
  async function factsFor(noteId: string, needType: boolean): Promise<Facts | null> {
    let facts = await ctx.storage.automationFacts(noteId)
    if (needType && !facts.meetingType) {
      // No meeting type yet. A type set by hand wins; otherwise ask the AI to classify the note.
      const note = await ctx.storage.getNote(noteId)
      if (note?.tags.some((t) => t.category === 'meeting_kind' && t.source === 'manual')) return facts
      if (await egressBlocked(ctx, { kind: 'llm' })) return null
      if (!classifyTried.has(noteId)) {
        classifyTried.add(noteId)
        await ctx.tags.classify(noteId).catch(() => [])
        facts = await ctx.storage.automationFacts(noteId)
      }
    }
    return facts
  }

  async function runPass(): Promise<void> {
    const s = await ctx.settings.getAll()
    const user = s['automations.enabled'] ? (await userRules()).filter((r) => r.enabled) : []
    const cc = s['customerCalls.enabled'] && s['customerCalls.autoAdd'] && s['customerCalls.folderId'] ? ((await ctx.storage.listAutomationRules()) as StoredRule[]).find((r) => r.id === CUSTOMER_CALLS_RULE_ID && r.enabled) : undefined
    const rules = cc ? [...user, cc] : user
    if (!rules.length) return
    const now = Date.now()
    const ended = await ctx.storage.endedMeetingNotes({ since: new Date(now - AUTOMATION_LIMITS.catchUpMs).toISOString(), noSummaryWaitMs: AUTOMATION_LIMITS.noSummaryWaitMs, now: new Date(now).toISOString() })
    for (const { noteId, endedAt } of ended) {
      const due = rules.filter((r) => !done.has(`${r.id}:${noteId}`) && (!r.enabled_at || r.enabled_at <= endedAt))
      if (!due.length) continue
      const runs = await ctx.storage.listAutomationRuns({ noteId, limit: 100 })
      for (const run of runs) done.add(`${run.rule_id}:${noteId}`)
      for (const rule of due) {
        if (done.has(`${rule.id}:${noteId}`)) continue
        try {
          const ok = rule.id === CUSTOMER_CALLS_RULE_ID ? await runCustomerCalls(rule, noteId) : await runRule(rule, noteId)
          if (ok) done.add(`${rule.id}:${noteId}`)
        } catch (err) {
          log('warn', 'automations:rule-deferred', { ruleId: rule.id, noteId, err: err instanceof Error ? err.message.slice(0, 60) : 'error' })
        }
      }
    }
  }

  async function claim(rule: StoredRule, noteId: string, status: AutomationRunStatus, reason: string | null): Promise<AutomationRun | null> {
    const c = await ctx.storage.claimAutomationRunOnce(rule.id, noteId, { status, reason })
    if (!c.created) return null
    log('info', 'automations:run', { ruleId: rule.id, noteId, status, reason })
    pushChanged([rule.id])
    return c.run
  }

  async function routeToFolder(rule: StoredRule, run: AutomationRun, folderId: string, noteId: string): Promise<void> {
    const folders = await ctx.storage.listFolders()
    if (!folders.folders.some((f) => f.id === folderId)) {
      await ctx.storage.updateAutomationRun(run.id, { status: 'failed', reason: FOLDER_GONE })
      if (rule.id !== CUSTOMER_CALLS_RULE_ID) await ctx.storage.upsertAutomationRule({ ...rule, enabled: false })
      log('info', 'automations:folder-missing', { ruleId: rule.id })
      pushChanged([rule.id])
      return
    }
    await ctx.storage.addNotesToFolder(folderId, [noteId], 'series_rule')
    await ctx.storage.updateAutomationRun(run.id, { status: 'executed', executed_at: new Date().toISOString() })
    pushChanged([rule.id])
  }

  async function sendWebhook(rule: StoredRule, run: AutomationRun, endpointId: string, noteId: string): Promise<AutomationRun> {
    if (await egressBlocked(ctx, { kind: 'integration' })) {
      return ctx.storage.updateAutomationRun(run.id, { status: 'failed', reason: LOCAL_ONLY_REASON })
    }
    const queued = await webhooks()?.queueForAutomation(endpointId, noteId, { id: rule.id, name: rule.name })
    if (!queued) return ctx.storage.updateAutomationRun(run.id, { status: 'failed', reason: 'The webhook for this automation is off or was deleted.' })
    return ctx.storage.updateAutomationRun(run.id, { status: 'executed', delivery_id: queued.deliveryId, executed_at: new Date().toISOString() })
  }

  /** One rule on one note. False = not decided yet (try on a later pass). */
  async function runRule(rule: StoredRule, noteId: string): Promise<boolean> {
    const facts = await factsFor(noteId, rule.predicates.some((p) => p.type === 'classification'))
    if (!facts) return false
    const action = rule.actions[0]
    if (!(await rulePredicatesMatch(ctx, rule.predicates, facts))) {
      await claim(rule, noteId, 'no_match', null)
      return true
    }
    if (action.type === 'file_in_folder') {
      const run = await claim(rule, noteId, 'matched', null)
      if (run) await routeToFolder(rule, run, action.folder_id, noteId)
      return true
    }
    if (!facts.hasSummary) {
      await claim(rule, noteId, 'failed', 'no_summary')
      return true
    }
    if (await egressBlocked(ctx, { kind: 'integration' })) {
      await claim(rule, noteId, 'failed', LOCAL_ONLY_REASON)
      return true
    }
    if (facts.isSensitive || rule.confirm_sends) {
      await claim(rule, noteId, 'needs_confirmation', facts.isSensitive ? 'sensitive' : 'confirm')
      return true
    }
    const run = await claim(rule, noteId, 'matched', null)
    if (run) {
      await sendWebhook(rule, run, action.webhook_id, noteId)
      pushChanged([rule.id])
    }
    return true
  }

  /** A sales or customer-success call, not sensitive, not excluded, not removed. */
  async function runCustomerCalls(rule: StoredRule, noteId: string): Promise<boolean> {
    const s = await ctx.settings.getAll()
    const folderId = s['customerCalls.folderId']
    if (!folderId) return false
    const facts = await factsFor(noteId, true)
    if (!facts) return false
    const note = await ctx.storage.getNote(noteId)
    const tag = note?.tags.find((t) => t.category === 'meeting_kind')
    const types = CUSTOMER_CALLS.meetingTypes as readonly string[]
    const removed = tag?.source === 'manual' && !types.includes(tag.value ?? '')
    const match =
      !!facts.meetingType &&
      types.includes(facts.meetingType) &&
      facts.isSensitive !== true &&
      !removed &&
      !isExcluded(facts.attendees.map((a) => a.email), s['customerCalls.excludedEmails'], s['customerCalls.excludedDomains'])
    if (!match) {
      await claim(rule, noteId, 'no_match', removed ? 'removed' : null)
      return true
    }
    const run = await claim(rule, noteId, 'matched', null)
    if (run) await routeToFolder(rule, run, folderId, noteId)
    return true
  }

  // ---------- triggers ----------

  ctx.bus.on('capture:stopped', () => schedule(AUTOMATION_LIMITS.noSummaryWaitMs + 1_000))
  ctx.bus.on('enhance:completed', () => schedule(2_000))
  ctx.bus.on('settings:changed', (c) => {
    if (c.keys.some((k) => k === 'automations.enabled' || k.startsWith('customerCalls.') || k === 'transcriptionRules.internalDomains')) schedule(1_000)
  })
  onStorageReady(ctx, () => {
    ready = true
    // The launch catch-up (7 days).
    schedule(5_000)
  })

  // ---------- IPC ----------

  ipcMain.handle('automations:list' satisfies InvokeChannel, async (): Promise<InvokeRes<'automations:list'>> => userRules())

  ipcMain.handle('automations:save' satisfies InvokeChannel, async (_e, req: InvokeReq<'automations:save'>): Promise<InvokeRes<'automations:save'>> => {
    const input = validateRule(req)
    if (input.id === CUSTOMER_CALLS_RULE_ID) throw bad('This automation can’t be edited here.')
    const rules = await userRules()
    const prev = input.id ? rules.find((r) => r.id === input.id) : undefined
    if (input.id && !prev) throw expected(notulaError('not-found', 'This automation no longer exists.'))
    if (!prev && rules.length >= AUTOMATION_LIMITS.maxRules) throw bad(`You can have up to ${AUTOMATION_LIMITS.maxRules} automations.`)
    const a = input.actions[0]
    if (a.type === 'file_in_folder' && !(await ctx.storage.listFolders()).folders.some((f) => f.id === a.folder_id)) throw bad('Pick a folder.')
    if (a.type === 'post_webhook' && !(await ctx.storage.listWebhookEndpoints()).some((e) => e.id === a.webhook_id)) throw bad('Pick a webhook.')
    const saved = await ctx.storage.upsertAutomationRule(input)
    log('info', 'automations:saved', { ruleId: saved.id, enabled: saved.enabled, action: a.type, predicates: input.predicates.map((p) => p.type).join(',') })
    pushChanged([saved.id])
    schedule(1_000)
    return saved
  })

  ipcMain.handle('automations:delete' satisfies InvokeChannel, async (_e, req: InvokeReq<'automations:delete'>): Promise<void> => {
    const id = obj(req)['id']
    if (typeof id !== 'string' || !id || id === CUSTOMER_CALLS_RULE_ID) throw bad('id is required')
    await ctx.storage.deleteAutomationRule(id)
    for (const k of [...done]) if (k.startsWith(`${id}:`)) done.delete(k)
    log('info', 'automations:deleted', { ruleId: id })
    pushChanged([id])
  })

  ipcMain.handle('automations:list-runs' satisfies InvokeChannel, async (_e, req: InvokeReq<'automations:list-runs'>): Promise<InvokeRes<'automations:list-runs'>> => {
    const r = obj(req)
    const status = RUN_STATUSES.includes(r['status'] as AutomationRunStatus) ? (r['status'] as AutomationRunStatus) : undefined
    const runs = await ctx.storage.listAutomationRuns({
      ...(typeof r['ruleId'] === 'string' && r['ruleId'] ? { ruleId: r['ruleId'] } : {}),
      ...(typeof r['noteId'] === 'string' && r['noteId'] ? { noteId: r['noteId'] } : {}),
      ...(status ? { status } : {}),
      limit: Math.max(1, Math.min(200, Math.floor(Number(r['limit']) || AUTOMATION_LIMITS.activityRuns)))
    })
    return runs.filter((x) => x.rule_id !== CUSTOMER_CALLS_RULE_ID)
  })

  ipcMain.handle('automations:resolve-run' satisfies InvokeChannel, async (_e, req: InvokeReq<'automations:resolve-run'>): Promise<InvokeRes<'automations:resolve-run'>> => {
    const r = obj(req)
    const runId = r['runId']
    const choice = r['choice']
    if (typeof runId !== 'string' || (choice !== 'send' && choice !== 'dismiss')) throw bad('runId and choice are required')
    const run = (await ctx.storage.listAutomationRuns({ status: 'needs_confirmation', limit: 500 })).find((x) => x.id === runId)
    if (!run) throw bad('This was already handled.')
    const rule = (await userRules()).find((x) => x.id === run.rule_id)
    let out: AutomationRun
    if (choice === 'dismiss' || !rule) out = await ctx.storage.updateAutomationRun(run.id, { status: 'dismissed', reason: rule ? 'user' : 'rule_deleted' })
    else {
      const a = rule.actions[0]
      out = a.type === 'post_webhook' ? await sendWebhook(rule, run, a.webhook_id, run.note_id) : await ctx.storage.updateAutomationRun(run.id, { status: 'dismissed' })
    }
    log('info', 'automations:resolved', { runId, ruleId: run.rule_id, choice, status: out.status })
    pushChanged([run.rule_id])
    return out
  })

  service = { wake: () => schedule(500) }

  if (!app.isPackaged && process.env['NOTULA_DEV_WB_HARNESS'] === '1') {
    setTimeout(() => void import('./dev-harness').then((m) => m.runWbHarness(ctx)), 3_000)
  }
}
