// SPDX-License-Identifier: Apache-2.0
// Smoke harness for the assistants (reminders, recap, meeting dock, live context). Dev only: unpackaged builds with
// `NOTULA_DEV_A_HARNESS=1`. It drives the real app (bridge calls from the windows, the deep link
// that starts a note with transcription, the real capture path), writes
// `<userData>/a-harness.json` and quits. Run it only against a scratch NOTULA_USER_DATA_DIR, a mock
// LLM (NOTULA_DEV_ANTHROPIC_BASE_URL), a mock ASR (NOTULA_DEV_ASR_URL) and a local ICS feed
// (NOTULA_DEV_A_ICS_URL): it turns the assistant switches on and seeds notes.

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, type WebContents } from 'electron'
import type { PushChannel } from '@shared/ipc'
import type { CalendarEvent } from '@shared/types/notes'
import type { MainContext } from '../context'
import { log } from '../log'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export async function runAHarness(ctx: MainContext): Promise<void> {
  const out: Record<string, unknown> = { startedAt: new Date().toISOString() }
  const file = join(app.getPath('userData'), 'a-harness.json')
  const save = (): void => writeFileSync(file, JSON.stringify(out, null, 2))
  const check = (name: string, ok: boolean, detail?: unknown): void => {
    out[name] = { ok, ...(detail !== undefined ? { detail } : {}) }
    log('info', 'a-harness:check', { name, ok })
    save()
  }
  const windowOf = (kind: string): BrowserWindow | null =>
    BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && ctx.windows.kindOf(w.webContents) === kind) ?? null
  const run = async <T>(wc: WebContents, code: string): Promise<T> => (await wc.executeJavaScript(`(async () => { ${code} })()`, true)) as T
  const until = async (fn: () => Promise<boolean> | boolean, ms: number, step = 500): Promise<boolean> => {
    for (let t = 0; t < ms; t += step) {
      if (await fn()) return true
      await sleep(step)
    }
    return false
  }

  try {
    await until(() => ctx.storage.identity().then(() => true).catch(() => false), 60_000)
    let wc = ctx.windows.main()?.webContents
    await until(() => {
      wc = ctx.windows.main()?.webContents
      return !!wc && !wc.isLoading()
    }, 60_000)
    if (!wc) throw new Error('no main window')
    const main = wc
    const js = <T>(code: string): Promise<T> => run<T>(main, code)
    const now = new Date().toISOString()

    // ---------- setup ----------
    const set = async (k: string, v: unknown): Promise<void> => {
      await ctx.settings.set(k as never, v as never)
    }
    await set('onboarding.aiProvidersDoneAt', now)
    await set('onboarding.calendarDoneAt', now)
    await set('profile.name', 'Alex Doe')
    await set('profile.email', 'alex@example.com')
    await set('llm.provider', 'anthropic')
    await set('asr.provider', 'deepgram')
    await sleep(1_500)
    const budget = await ctx.storage.createNote({ origin: 'new_note_button', title: 'Payments check-in', created_via: 'Windows' })
    await ctx.storage.createPanel({
      document_id: budget.id,
      title: 'Summary',
      template_key: null,
      content: null,
      content_markdown: '## Notes\n- Payments: the sandbox tests are passing; production waits on the bank certificate.\n- Budget stays at 40k for Q4.\n',
      generated_content: null,
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
    await ctx.storage.updateNote(budget.id, { notes_text: 'Payments: the sandbox tests are passing; production waits on the bank certificate.', notes_md: 'Payments: the sandbox tests are passing; production waits on the bank certificate.' })

    // The ICS feed.
    const icsUrl = process.env['NOTULA_DEV_A_ICS_URL'] ?? ''
    await js(`await window.notula.calendar.addIcs({ url: ${JSON.stringify(icsUrl)}, label: 'A smoke', myEmail: 'alex@example.com' }); return true`)
    const t0 = Date.now()
    let events: CalendarEvent[] = []
    await until(async () => {
      events = await ctx.calendar.listEvents({ from: new Date(t0 - 86_400_000).toISOString(), to: new Date(t0 + 30 * 3_600_000).toISOString() })
      return events.length >= 4
    }, 30_000)
    const byTitle = (t: string): CalendarEvent | undefined => events.find((e) => e.summary === t)
    check('setup.calendar', events.length >= 4, events.map((e) => e.summary))

    // ---------- reminders (an invite 23 h ahead appears, 25 h doesn't; missing link at 19 min) ----------
    const focusedBefore = BrowserWindow.getFocusedWindow()?.id ?? null
    await set('reminders.enabled', true)
    await until(async () => (await ctx.storage.listReminders({ statuses: ['active'] })).length >= 2, 20_000)
    const active = await ctx.storage.listReminders({ statuses: ['active', 'pending'] })
    const keys = active.map((r) => `${r.kind}|${r.presentation.summary ?? r.presentation.title}`)
    const inv23 = byTitle('Partner intro (23 h)')
    const inv25 = byTitle('Partner follow-up (25 h)')
    const miss = byTitle('Design chat (no link)')
    check('reminders.invite-23h-appears', !!inv23 && active.some((r) => r.key === `missing_invite:${inv23.id}`), keys)
    check('reminders.invite-25h-absent', !inv25 || !active.some((r) => r.key === `missing_invite:${inv25.id}`), keys)
    check('reminders.missing-link-19min', !!miss && active.some((r) => r.key === `no_meeting_link:${miss.id}`), keys)
    await sleep(1_500)
    out['inOnboarding'] = ctx.ui.inOnboarding()
    const cards = windowOf('reminder-cards')
    check('reminders.card-window', !!cards && cards.isVisible() && !cards.isFocusable() && cards.isAlwaysOnTop(), {
      visible: cards?.isVisible(),
      bounds: cards?.getBounds(),
      focusedBefore,
      focusedAfter: BrowserWindow.getFocusedWindow()?.id ?? null
    })
    // Sender check: a card action from the main window is ignored.
    // Cards yield to meeting notifications on screen: clear those first.
    for (const p of ctx.notify.visible()) ctx.notify.hide(p.id)
    let shown: { card: { id: string } | null } | null = null
    await until(async () => {
      shown = cards ? await run<{ card: { id: string } | null }>(cards.webContents, `return await window.notula.reminderCards.getState()`).catch(() => null) : null
      return !!shown?.card
    }, 10_000)
    out['cardState'] = shown
    const cardId = (shown as { card: { id: string } | null } | null)?.card?.id ?? null
    if (cardId) {
      await js(`window.notula.reminderCards.action({ reminderId: ${JSON.stringify(cardId)}, actionId: 'dismiss' }); return true`)
      await sleep(1_000)
      const still = (await ctx.storage.listReminders({ statuses: ['active'] })).some((r) => r.id === cardId)
      check('reminders.sender-check', still)
      // A draft from the card window.
      await run(cards!.webContents, `window.notula.reminderCards.action({ reminderId: ${JSON.stringify(cardId)}, actionId: 'draft' }); return true`)
      const drafted = await until(async () => {
        const r = (await ctx.storage.listReminders({ statuses: ['active'] })).find((x) => x.id === cardId)
        return r?.actions.some((a) => a.kind === 'draft_block' && a.state === 'ready') ?? false
      }, 20_000)
      const r = (await ctx.storage.listReminders({ statuses: ['active'] })).find((x) => x.id === cardId)
      check('reminders.draft', drafted, r?.actions)
    }
    await set('reminders.enabled', false)
    await sleep(500)
    check('reminders.off-no-window', !windowOf('reminder-cards'))

    // ---------- recap from two instances of a weekly series, then the cache ----------
    await set('recurringRecap.enabled', true)
    const next = events.find((e) => e.summary === 'Weekly sync' && Date.parse(e.start?.dateTime ?? '') > t0)
    const series = next?.['recurringEventId'] as string | undefined
    let prevEvent = events.find((e) => e.summary === 'Weekly sync' && Date.parse(e.start?.dateTime ?? '') < t0)
    if (!prevEvent && next && series) {
      const s = Date.parse(next.start!.dateTime!) - 7 * 86_400_000
      prevEvent = { ...next, id: `${next.id}-prev`, start: { dateTime: new Date(s).toISOString() }, end: { dateTime: new Date(s + 1_800_000).toISOString() } }
    }
    if (next && prevEvent) {
      const prevNote = await ctx.storage.createNote({ origin: 'new_note_button', title: 'Weekly sync', created_via: 'Windows', calendarEvent: prevEvent })
      await ctx.storage.createPanel({
        document_id: prevNote.id,
        title: 'Summary',
        template_key: null,
        content: null,
        content_markdown: '## Decisions\n- Launch tracks for November 18.\n- No launch without payments.\n\n## Action items\n- [ ] Priya gets the bank agreement signed\n',
        generated_content: null,
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
      const showCard = (): string =>
        ctx.notify.show({
          variant: 'scheduled-meeting',
          title: 'Weekly sync',
          body: 'In 90 minutes',
          calendarEventId: next.id,
          eventStart: next.start?.dateTime ?? null,
          showDelayMs: 0,
          hideAfterMs: 60_000,
          quietWhileRecording: false,
          allowDuringOnboarding: true,
          onAction: () => {}
        })
      const id1 = showCard()
      await until(() => ctx.notify.cardWebContents(id1) !== null, 10_000)
      const first = ctx.notify.visible().find((p) => p.id === id1)?.lastTime ?? null
      const ready = await until(async () => {
        const w = ctx.notify.cardWebContents(id1)
        return !!w && (await run<boolean>(w, `return !!document.querySelector('.lt-recap.is-ready')`).catch(() => false))
      }, 20_000)
      const head = await run<string>(ctx.notify.cardWebContents(id1)!, `return document.querySelector('.lt-recap')?.textContent ?? ''`).catch(() => '')
      check('recap.raw-then-ready', first?.status === 'raw' && ready, { first, head })
      ctx.notify.hide(id1)
      await sleep(1_500)
      const id2 = showCard()
      await until(() => ctx.notify.cardWebContents(id2) !== null, 10_000)
      const second = ctx.notify.visible().find((p) => p.id === id2)?.lastTime ?? null
      check('recap.cache-reused', second?.status === 'ready', second)
      ctx.notify.hide(id2)
    } else {
      check('recap.raw-then-ready', false, { next: next?.id, series })
    }
    await set('recurringRecap.enabled', false)

    // ---------- meeting dock and live context during a real capture ----------
    await set('meetingDock.enabled', true)
    await set('liveContext.mode', 'search')
    const live = byTitle('Pricing review') ?? null
    const mainWin = ctx.windows.main()
    mainWin?.show()
    mainWin?.focus()
    await sleep(800)
    const focusBefore = BrowserWindow.getFocusedWindow()?.id ?? null
    main.send('deeplink:received' satisfies PushChannel, { type: 'new-note', data: { creationSource: 'deep_link', autoTranscribe: true, event: live } })
    const started = await until(() => ctx.capture.isCapturing(), 30_000)
    const noteId = ctx.capture.currentNoteId()
    check('capture.started', started, { noteId })
    await until(() => !!windowOf('meeting-dock')?.isVisible(), 10_000)
    const dockWin = windowOf('meeting-dock')
    const wa = dockWin ? (await import('electron')).screen.getDisplayMatching(dockWin.getBounds()).workArea : null
    const b = dockWin?.getBounds()
    check('dock.opens-docked-without-focus', !!dockWin && dockWin.isVisible() && !dockWin.isFocused() && dockWin.isAlwaysOnTop() && BrowserWindow.getFocusedWindow()?.id === focusBefore, {
      bounds: b,
      workArea: wa,
      focusBefore,
      focusAfter: BrowserWindow.getFocusedWindow()?.id ?? null
    })
    if (dockWin && b && wa) {
      const near = (a: number, e: number): boolean => Math.abs(a - e) <= 2
      check('dock.geometry', near(b.width, 251) && near(b.height, 162) && near(wa.x + wa.width - (b.x + b.width), 24) && near(wa.y + wa.height - (b.y + b.height), 24), { b, wa })
      // Drag (main moves it) and edge resize through the handles' row.
      await run(dockWin.webContents, `window.notula.meetingDock.setBounds({ x: ${b.x - 100}, y: ${b.y - 120}, width: 320, height: 360 }); return true`)
      await sleep(600)
      const r = dockWin.getBounds()
      check('dock.drag-resize', near(r.width, 320) && near(r.height, 360) && near(r.x, b.x - 100), r)
      // Ask through the composer.
      await run(
        dockWin.webContents,
        `const i = document.querySelector('.dock-input'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, 'what did they say about pricing?'); i.dispatchEvent(new Event('input', { bubbles: true })); await new Promise((r) => setTimeout(r, 400)); document.querySelector('.dock-send').click(); return true`
      )
      const answered = await until(async () => ((await ctx.storage.getMeetingDockHistory(noteId ?? ''))?.exchanges.length ?? 0) > 0, 30_000)
      const h = await ctx.storage.getMeetingDockHistory(noteId ?? '')
      check('dock.answers-with-sources', answered && (h?.exchanges[0]?.answer.length ?? 0) > 0, h?.exchanges[0])
      // Close, then the tray path (ctx.meetingDock.show) brings it back with its history.
      await run(dockWin.webContents, `await window.notula.meetingDock.close(); return true`)
      await sleep(500)
      const hidden = !dockWin.isVisible() && ctx.meetingDock.isAvailable()
      await ctx.meetingDock.show()
      await sleep(800)
      const back = dockWin.isVisible()
      const items = await run<number>(dockWin.webContents, `window.notula.meetingDock.setView({ expanded: true, view: 'chat' }); await new Promise((r) => setTimeout(r, 500)); return document.querySelectorAll('.dock-exchange').length`)
      check('dock.tray-reopen-with-history', hidden && back && items > 0, { hidden, back, items })
      // Lock: content windows hide, then come back.
      ctx.windows.setContentLocked(true)
      await sleep(300)
      const lockedHidden = !dockWin.isVisible()
      ctx.windows.setContentLocked(false)
      await sleep(300)
      check('lock.hides-and-restores', lockedHidden && dockWin.isVisible(), { lockedHidden, after: dockWin.isVisible() })
    }
    // Live context, search mode: the scripted meeting asks about payments.
    const liveAnswered = await until(async () => {
      const w = windowOf('live-context')
      if (!w) return false
      const c = await run<{ status: string } | null>(w.webContents, `return await window.notula.liveContext.getCard()`).catch(() => null)
      return c?.status === 'answered'
    }, 60_000, 500)
    const liveWin = windowOf('live-context')
    const liveCard = liveWin ? await run<unknown>(liveWin.webContents, `return await window.notula.liveContext.getCard()`).catch(() => null) : null
    check('live.search-answer', liveAnswered && !!liveWin && !liveWin.isFocused() && !liveWin.isFocusable(), liveCard)
    // Calendar mode: "the next sync is Thursday" near the end of the script.
    await set('liveContext.mode', 'calendar')
    const liveSlot = await until(async () => {
      const w = windowOf('live-context')
      if (!w) return false
      const c = await run<{ kind: string; status: string } | null>(w.webContents, `return await window.notula.liveContext.getCard()`).catch(() => null)
      return c?.kind === 'calendar' && (c.status === 'ready' || c.status === 'error')
    }, 150_000, 1_000)
    const alw2 = windowOf('live-context')
    const slotCard = alw2 ? await run<unknown>(alw2.webContents, `return await window.notula.liveContext.getCard()`).catch(() => null) : null
    check('live.calendar-slot', liveSlot && (slotCard as { status?: string } | null)?.status === 'ready', slotCard)
    check('live.no-focus-theft', BrowserWindow.getFocusedWindow()?.id === focusBefore, { focusBefore, now: BrowserWindow.getFocusedWindow()?.id ?? null })

    // Stop: the meeting dock closes and the card clears.
    await ctx.capture.stop('note_stop_button')
    await sleep(1_500)
    check('capture.stop-closes', !windowOf('meeting-dock'), {})

    // ---------- every switch off: no model call of ours (the runner counts the mock log) ----------
    await set('meetingDock.enabled', false)
    await set('liveContext.mode', 'off')
    out['offWindowStart'] = new Date().toISOString()
    main.send('deeplink:received' satisfies PushChannel, { type: 'new-note', data: { creationSource: 'deep_link', autoTranscribe: true, event: null } })
    await until(() => ctx.capture.isCapturing(), 30_000)
    await sleep(25_000)
    check('off.no-windows', !windowOf('meeting-dock') && !windowOf('live-context') && !windowOf('reminder-cards'))
    await ctx.capture.stop('note_stop_button')
    out['offWindowEnd'] = new Date().toISOString()
    save()
  } catch (err) {
    out['error'] = String(err instanceof Error ? err.stack : err)
    save()
  }
  await sleep(1_000)
  app.quit()
}
