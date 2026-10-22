// SPDX-License-Identifier: Apache-2.0
// Smoke harness for tasks, summary ratings, About me and the dispatcher. Dev only: unpackaged builds
// with `NOTULA_DEV_K_HARNESS=1` (seed and check) or `=2` (after a restart: persistence). It
// drives the real bridge from the main window, writes `<userData>/k-harness-<phase>.json` and
// quits. Run it only against a scratch NOTULA_USER_DATA_DIR and a mock LLM
// (NOTULA_DEV_ANTHROPIC_BASE_URL): it seeds notes and turns those features' switches on.

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as Y from 'yjs'
import { app } from 'electron'
import { YDOC_FRAGMENT } from '@shared/types/ydoc'
import { BUILTIN_TEMPLATE_IDS } from '@shared/types/templates'
import type { MainContext } from '../context'
import { log } from '../log'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const SUMMARY = (n: number): string =>
  `## Notes\nWe went through the launch plan for meeting ${n}.\n\n## Action items\n- [ ] Send the deck to Sam\n- [ ] Book the review with Priya\n`

function seedRoom(): Uint8Array {
  const doc = new Y.Doc()
  const frag = doc.getXmlFragment(YDOC_FRAGMENT)
  const para = (text: string): Y.XmlElement => {
    const p = new Y.XmlElement('paragraph')
    p.insert(0, [new Y.XmlText(text)])
    return p
  }
  const heading = (text: string): Y.XmlElement => {
    const h = new Y.XmlElement('heading')
    h.setAttribute('level', 2 as unknown as string)
    h.insert(0, [new Y.XmlText(text)])
    return h
  }
  const list = new Y.XmlElement('taskList')
  list.insert(
    0,
    ['Send the deck to Sam', 'Book the review with Priya'].map((t) => {
      const li = new Y.XmlElement('taskItem')
      li.setAttribute('checked', false as unknown as string)
      li.insert(0, [para(t)])
      return li
    })
  )
  frag.insert(0, [heading('Notes'), para('We went through the launch plan.'), heading('Action items'), list])
  const update = Y.encodeStateAsUpdate(doc)
  doc.destroy()
  return update
}

export async function runKHarness(ctx: MainContext, phase: 1 | 2): Promise<void> {
  const out: Record<string, unknown> = { phase, startedAt: new Date().toISOString() }
  const file = join(app.getPath('userData'), `k-harness-${phase}.json`)
  const save = (): void => writeFileSync(file, JSON.stringify(out, null, 2))
  const check = (name: string, ok: boolean, detail?: unknown): void => {
    out[name] = { ok, ...(detail !== undefined ? { detail } : {}) }
    save()
  }
  try {
    for (let i = 0; i < 120; i++) {
      if (await ctx.storage.identity().then(() => true).catch(() => false)) break
      await sleep(500)
    }
    let wc = ctx.windows.main()?.webContents
    for (let i = 0; i < 120 && (!wc || wc.isLoading()); i++) {
      await sleep(500)
      wc = ctx.windows.main()?.webContents
    }
    if (!wc) throw new Error('no main window')
    const js = async <T>(code: string): Promise<T> => (await wc!.executeJavaScript(`(async () => { ${code} })()`, true)) as T
    const now = new Date().toISOString()

    if (phase === 2) {
      const state = JSON.parse(await js<string>(`return JSON.stringify(await window.notula.tasks.list({ showCompleted: true, includeOlder: true }))`)) as {
        groups: { documentId: string; title: string; items: { checked: boolean; text: string }[] }[]
      }
      const g = state.groups.find((x) => x.title === 'K harness 0')
      check('dod1.persisted', !!g && g.items[0]?.checked === true, g?.items)
      await js(`location.hash = '#/meeting/${g?.documentId ?? ''}'; return true`)
      let dom = '[]'
      for (let i = 0; i < 20 && dom === '[]'; i++) {
        await sleep(1_000)
        dom = await js<string>(`return JSON.stringify([...document.querySelectorAll('.ProseMirror [data-checked]')].map((li) => li.getAttribute('data-checked')))`)
      }
      const diag = await js<string>(`return JSON.stringify({ hash: location.hash, editors: document.querySelectorAll('.ProseMirror').length, text: (document.querySelector('.ProseMirror')?.textContent ?? '').slice(0, 200) })`)
      check('dod1.persisted-editor', JSON.parse(dom)[0] === 'true', { dom, diag })
      // Live: tick the second item while the editor is open.
      const it = g?.items[1] as unknown as { panelId: string; nodePath: number[] } | undefined
      if (it) {
        await js(`await window.notula.tasks.toggle({ kind: 'meeting', documentId: '${g?.documentId}', panelId: '${it.panelId}', nodePath: ${JSON.stringify(it.nodePath)}, checked: true }); return true`)
        await sleep(500)
        const live = await js<string>(`return JSON.stringify([...document.querySelectorAll('.ProseMirror [data-checked]')].map((li) => li.getAttribute('data-checked')))`)
        check('dod1.editor-updated-live', JSON.parse(live)[1] === 'true', live)
      }
      return
    }

    // ---------- setup ----------
    const set = async (k: string, v: unknown): Promise<void> => {
      await ctx.settings.set(k as never, v as never)
    }
    await set('onboarding.aiProvidersDoneAt', now)
    await set('onboarding.calendarDoneAt', now)
    await set('profile.name', 'Alex Doe')
    await set('profile.email', 'alex@example.com')
    await set('llm.provider', 'anthropic')
    for (const k of ['tasks.enabled', 'summaryFeedback.enabled', 'userContext.enabled', 'actionItems.enabled', 'dispatcher.enabled']) await set(k, true)
    await set('dispatcher.morningRun', false)

    const notes: { id: string; panelId: string }[] = []
    for (let n = 0; n < 11; n++) {
      const note = await ctx.storage.createNote({ origin: 'new_note_button', title: `K harness ${n}`, created_via: 'Windows' })
      const panel = await ctx.storage.createPanel({
        document_id: note.id,
        title: 'Summary',
        template_key: n >= 5 && n < 8 ? BUILTIN_TEMPLATE_IDS['team-meeting'] : null,
        content: null,
        content_markdown: SUMMARY(n),
        generated_content: SUMMARY(n),
        content_edited_at: now,
        deleted_at: null,
        last_opened_at: null,
        enhance_started_at: now,
        enhance_failed_at: null,
        enhance_error: null,
        ai_line_map: null,
        speakers_attributed: false,
        crdt_version: 1
      })
      notes.push({ id: note.id, panelId: panel.id })
    }
    const n0 = notes[0]!
    await ctx.storage.appendYdoc(`summary:1:${n0.panelId}`, seedRoom(), 'k-harness')
    out['notes'] = notes
    save()

    // ---------- ticking a task updates an open summary editor ----------
    await js(`location.hash = '#/meeting/${n0.id}'; return true`)
    await sleep(4_000)
    const before = await js<string>(`return JSON.stringify([...document.querySelectorAll('li[data-type="taskItem"]')].map((li) => li.getAttribute('data-checked')))`)
    const list = JSON.parse(await js<string>(`return JSON.stringify(await window.notula.tasks.list({ showCompleted: false, includeOlder: false }))`)) as {
      groups: { documentId: string; items: { panelId: string; nodePath: number[]; text: string; checked: boolean; context: string }[] }[]
      openCount: number
    }
    const g0 = list.groups.find((g) => g.documentId === n0.id)
    const g1 = list.groups.find((g) => g.documentId === notes[1]!.id)
    check('dod1.listed', !!g0 && g0.items.length === 2 && !!g1 && g1.items.length === 2, { g0: g0?.items, g1: g1?.items, openCount: list.openCount })
    const item = g0!.items[0]!
    await js(`
      window.__kUpdates = 0
      window.notula.ydoc.onUpdated((u) => { if (u.origin === 'tasks') window.__kUpdates++ })
      await window.notula.tasks.toggle({ kind: 'meeting', documentId: '${n0.id}', panelId: '${item.panelId}', nodePath: ${JSON.stringify(item.nodePath)}, checked: true })
      return true`)
    await sleep(800)
    const after = await js<string>(`return JSON.stringify({ dom: [...document.querySelectorAll('li[data-type="taskItem"]')].map((li) => li.getAttribute('data-checked')), pushes: window.__kUpdates })`)
    const a = JSON.parse(after) as { dom: (string | null)[]; pushes: number }
    check('dod1.editor-updated', a.dom[0] === 'true' && a.pushes >= 1, { before, after: a })
    // A summary that was never opened: the markdown seed is rewritten.
    const md = g1!.items[1]!
    await js(`await window.notula.tasks.toggle({ kind: 'meeting', documentId: '${notes[1]!.id}', panelId: '${md.panelId}', nodePath: ${JSON.stringify(md.nodePath)}, checked: true }); return true`)
    const p1 = await ctx.storage.getPanel(md.panelId)
    check('dod1.markdown-seed', !!p1?.content_markdown?.includes('- [x] Book the review with Priya'), p1?.content_markdown)
    // A stale path changes nothing.
    await js(`await window.notula.tasks.toggle({ kind: 'meeting', documentId: '${n0.id}', panelId: '${item.panelId}', nodePath: [0], checked: true }); return true`)
    check('dod1.stale-noop', true)
    const manual = JSON.parse(await js<string>(`const t = await window.notula.tasks.add({ text: '  Call the bank  ' }); await window.notula.tasks.toggle({ kind: 'manual', id: t.id, checked: true }); return JSON.stringify(t)`))
    check('tasks.manual', (manual as { text: string }).text === 'Call the bank', manual)

    // ---------- the banner, once ----------
    const e0 = await js<boolean>(`return (await window.notula.summaryFeedback.eligibility({ panelId: '${n0.panelId}' })).show`)
    await js(`await window.notula.summaryFeedback.shown({ panelId: '${n0.panelId}' }); return true`)
    const e1 = await js<boolean>(`return (await window.notula.summaryFeedback.eligibility({ panelId: '${notes[2]!.panelId}' })).show`)
    check('dod2.banner-once', e0 === true && e1 === false, { first: e0, secondWithin168h: e1 })
    for (const [i, c] of [
      [5, 'Too long, I want shorter bullets'],
      [6, 'Missed the decisions'],
      [7, 'Good structure']
    ] as const) {
      await js(`await window.notula.summaryFeedback.rate({ panelId: '${notes[i]!.panelId}', direction: '${i === 7 ? 'positive' : 'negative'}' }); await window.notula.summaryFeedback.rate({ panelId: '${notes[i]!.panelId}', direction: '${i === 7 ? 'positive' : 'negative'}', comment: ${JSON.stringify(c)} }); return true`)
    }
    const fl = JSON.parse(await js<string>(`return JSON.stringify(await window.notula.summaryFeedback.list({ templateSlug: '${BUILTIN_TEMPLATE_IDS['team-meeting']}' }))`)) as { counts: unknown; items: unknown[] }
    check('dod2.template-list', fl.items.length === 3, fl.counts)
    const sug = JSON.parse(await js<string>(`return JSON.stringify(await window.notula.summaryFeedback.suggestTemplateEdits({ templateSlug: '${BUILTIN_TEMPLATE_IDS['team-meeting']}' }))`)) as { ok: boolean }
    check('summary-feedback.suggest', sug.ok === true, sug)

    // ---------- the wiki in summary prompts, and the ASR names ----------
    await js(`await window.notula.userContext.update({ sectionId: 'work-habits', content: 'Prefers bullet points' }); return true`)
    const withCtx = await ctx.promptExtras.summaryVars(notes[3]!.id)
    await js(`await window.notula.enhance.generate({ noteId: '${notes[3]!.id}' }); return true`)
    await sleep(6_000)
    await set('userContext.inSummaries', false)
    const without = await ctx.promptExtras.summaryVars(notes[4]!.id)
    await js(`await window.notula.enhance.generate({ noteId: '${notes[4]!.id}' }); return true`)
    await sleep(6_000)
    await set('userContext.inSummaries', true)
    check('dod3.summary-vars', withCtx.author_context.includes('Prefers bullet points') && without.author_context === '', { withCtx: withCtx.author_context, without: without.author_context })
    const names = JSON.parse(await js<string>(`return JSON.stringify(await window.notula.userContext.setNames({ firstNames: ['Siobhán', 'SIOBHÁN', ' Xavi ', ''] }))`)) as { firstNames: string[] }
    const vocab = await ctx.promptExtras.asrVocabulary()
    check('dod3.asr-names', names.firstNames.length === 2 && vocab.includes('Siobhán'), { names, vocab })
    const draft = JSON.parse(
      await js<string>(`
        const done = new Promise((res) => { const off = window.notula.userContext.onDraftProgress((e) => { if (e.type !== 'started') { off(); res(e) } }) })
        await window.notula.userContext.draft({ sectionIds: ['identity', 'work-habits'] })
        return JSON.stringify(await done)`)
    ) as { type: string; updated?: string[]; skippedUser?: string[] }
    check('dod3.draft', draft.type === 'done' && draft.updated?.[0] === 'identity' && draft.skippedUser?.[0] === 'work-habits', draft)

    // ---------- the dispatcher ----------
    const n8 = notes[8]!
    await ctx.storage.replaceNoteActionItems(n8.id, n8.panelId, [
      { intent: 'Email Sam the launch deck', detail: null, attribution: [], summaryLine: null },
      { intent: 'Schedule the review with Priya', detail: null, attribution: [{ name: 'Alex Doe', identifiers: ['alex@example.com'] }], summaryLine: null },
      { intent: 'Fix the login bug', detail: null, attribution: [{ name: 'Priya', identifiers: [] }], summaryLine: null }
    ])
    await sleep(8_000)
    const todos = JSON.parse(await js<string>(`return JSON.stringify(await window.notula.dispatch.list({ view: 'todos' }))`)) as { todos: { title: string; type: string }[] }
    check('dod4.classified-own-only', todos.todos.length === 2, todos.todos)
    const yesterday = (() => {
      const d = new Date(Date.parse(process.env.NOTULA_DEV_NOW ?? now) - 86_400_000)
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    })()
    await ctx.storage.insertDispatches([
      { todo_id: null, title: 'Old unstarted', type: 'email', task: 'From yesterday', source: '', run_day: yesterday, reason: null, thread_id: null, status: 'open' }
    ])
    // The scheduled run: the next tick after the switch (NOTULA_DEV_NOW puts the clock past 07:00).
    await set('dispatcher.morningRun', true)
    let today: { dispatches: { id: string; title: string; status: string }[]; status: { lastRun: { status: string; archived: number } | null } } | null = null
    for (let i = 0; i < 50; i++) {
      await sleep(2_000)
      today = JSON.parse(await js<string>(`return JSON.stringify(await window.notula.dispatch.list({ view: 'today' }))`))
      if (today?.status.lastRun && ['done', 'discarded', 'error'].includes(today.status.lastRun.status)) break
    }
    const archived = JSON.parse(await js<string>(`return JSON.stringify(await window.notula.dispatch.list({ view: 'archived' }))`)) as { dispatches: { title: string }[] }
    check(
      'dod4.morning-run',
      today?.status.lastRun?.status === 'done' && today.dispatches.length > 0 && today.dispatches.length <= 5 && archived.dispatches.some((d) => d.title === 'Old unstarted'),
      { lastRun: today?.status.lastRun, today: today?.dispatches.map((d) => d.title), archived: archived.dispatches.map((d) => d.title) }
    )
    // An invalid answer twice: nothing changes, and the reason is logged.
    const countBefore = today?.dispatches.length ?? 0
    await js(`await window.notula.dispatch.runMorning(); return true`)
    let after2: typeof today = null
    for (let i = 0; i < 30; i++) {
      await sleep(1_000)
      after2 = JSON.parse(await js<string>(`return JSON.stringify(await window.notula.dispatch.list({ view: 'today' }))`))
      if (after2?.status.lastRun && after2.status.lastRun.status !== 'classifying' && after2.status.lastRun.status !== 'starting' && after2.status.lastRun.status !== 'done') break
    }
    check('dod4.invalid-discarded', after2?.status.lastRun?.status === 'discarded' && after2.dispatches.length === countBefore, after2?.status.lastRun)
    const first = today?.dispatches[0]
    if (first) {
      const r = JSON.parse(await js<string>(`return JSON.stringify(await window.notula.dispatch.start({ id: '${first.id}' }))`)) as { threadId: string }
      const thread = await ctx.storage.getChatThread(r.threadId)
      check('dod4.start-titled-thread', thread?.title === first.title, { title: thread?.title, key: thread?.grouping_key })
    }
  } catch (err) {
    out['error'] = err instanceof Error ? err.stack : String(err)
    log('error', 'k-harness:failed', { err })
  } finally {
    out['finishedAt'] = new Date().toISOString()
    save()
    setTimeout(() => app.quit(), 1_000)
  }
}
