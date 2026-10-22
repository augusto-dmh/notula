// SPDX-License-Identifier: Apache-2.0
// Smoke harness for the general settings (device info, feedback, app icon, tips). Dev only: unpackaged builds with
// `NOTULA_DEV_G_HARNESS=1` (checks) or `=2` (after a restart: the stored icon and What's new).
// It drives the real bridge from the main window, captures the pages it checks into
// `<userData>/g-shots/`, writes `<userData>/g-harness-<phase>.json` and quits. Run it only against
// a scratch NOTULA_USER_DATA_DIR with NOTULA_DEV_DIALOG_DIR set: it seeds notes and changes settings.
// Phase 2 ends by restoring the default icon.

import { existsSync, mkdirSync, readFileSync, truncateSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, netLog } from 'electron'
import { unzipSync } from 'fflate'
import { LABS_FEATURES } from '@shared/types/labs'
import type { MainContext } from '../context'
import { log } from '../log'
import { iconImage } from '../app-icon/tints'
import { mailtoUrl } from '../feedback'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export async function runGHarness(ctx: MainContext, phase: 1 | 2): Promise<void> {
  const out: Record<string, unknown> = { phase, startedAt: new Date().toISOString() }
  const userData = app.getPath('userData')
  const file = join(userData, `g-harness-${phase}.json`)
  const shots = join(userData, 'g-shots')
  mkdirSync(shots, { recursive: true })
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
    const go = async (path: string): Promise<void> => {
      await js(`location.hash = ${JSON.stringify(`#${path}`)}; return true`)
      await sleep(1_200)
    }
    const shot = async (name: string): Promise<void> => {
      const img = await wc!.capturePage()
      writeFileSync(join(shots, `${phase}-${name}.png`), img.toPNG())
    }
    const prefs = (): Promise<Record<string, unknown>> => js(`return await window.notula.prefs.get()`)

    if (phase === 2) {
      const state = await js<{ current: string | null }>(`return await window.notula.appIcon.getState()`)
      check('icon-after-restart', state.current === 'blue', state)
      await sleep(1_500)
      await shot('home-whats-new')
      const entry = await js<unknown>(`return await window.notula.nux.getWhatsNew()`)
      const card = await js<boolean>(`return !!document.querySelector('.nux-whatsnew')`)
      check('whats-new-shows-after-version-change', entry !== null && card, entry)
      await js(`document.querySelector('.nux-whatsnew__close').click(); return true`)
      await sleep(800)
      const after = await js<unknown>(`return await window.notula.nux.getWhatsNew()`)
      check('whats-new-once', after === null && !(await js<boolean>(`return !!document.querySelector('.nux-whatsnew')`)))
      // Undo the icon change for the next run (brief: the taskbar icon must end as it started).
      const reset = await js<{ current: string | null }>(`return await window.notula.appIcon.set({ value: null })`)
      check('icon-restored-default', reset.current === null)
      out['finishedAt'] = new Date().toISOString()
      save()
      setTimeout(() => app.quit(), 1_000)
      return
    }

    const now = new Date().toISOString()
    await ctx.settings.set('onboarding.aiProvidersDoneAt', now as never)
    await ctx.settings.set('onboarding.calendarDoneAt', now as never)
    await sleep(1_500)

    // ---- tips: a fresh profile ----
    await go('/home')
    await shot('home-fresh')
    check('tip-ai-setup-on-fresh-home', await js<boolean>(`return !!document.querySelector('.nux-tip[aria-label="Add an AI provider to get summaries"]')`))
    const wnFresh = await js<unknown>(`return await window.notula.nux.getWhatsNew()`)
    check('whats-new-not-on-fresh-profile', wnFresh === null)

    // ---- profile and This device ----
    await go('/settings/profile')
    const savedCount = await js<number>(`
      window.__gSaves = 0
      window.__gOff = window.notula.prefs.onChanged((e) => { if (e.keys.includes('profile.name')) window.__gSaves++ })
      const input = [...document.querySelectorAll('input')].find((i) => i.placeholder === 'Jamie Rivera')
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      for (const v of ['A', 'Ad', 'Ada', 'Ada L', 'Ada Lovelace']) {
        set.call(input, v); input.dispatchEvent(new Event('input', { bubbles: true }))
        await new Promise((r) => setTimeout(r, 120))
      }
      await new Promise((r) => setTimeout(r, 400))
      const early = window.__gSaves
      await new Promise((r) => setTimeout(r, 1500))
      return early * 100 + window.__gSaves`)
    const toast = await js<boolean>(`return document.body.innerText.includes('Profile updated')`)
    const p1 = await prefs()
    check('profile-saves-once-after-1s', savedCount === 1 && p1['profile.name'] === 'Ada Lovelace' && toast, { savedCount, toast })
    const info = await js<{ dataFolder: string; firstRunAt: string | null }>(`return await window.notula.device.getInfo()`)
    check('device-card-real-folder', info.dataFolder === userData && !!info.firstRunAt && (await js<boolean>(`return document.body.innerText.includes(${JSON.stringify(userData)})`)), info)
    await shot('profile')

    // ---- preferences rows ----
    await go('/settings/preferences')
    await shot('preferences')
    const prefsRows = await js<Record<string, boolean>>(`
      const t = document.body.innerText
      return { enter: t.includes('Chat Enter key behavior'), tips: t.includes('Show tips') && t.includes('Reset tips'), labs: t.includes('Discover and test experimental features in development'), icon: !!document.querySelector('[role=radiogroup][aria-label="App icon"]'), labsTip: !!document.querySelector('.nux-tip[aria-label="New experimental features are in Labs"]') }`)
    check('preferences-rows', Object.values(prefsRows).every(Boolean), prefsRows)

    // ---- app icon ----
    const locked = await js<{ title: string; disabled: string | null }>(`
      const b = document.querySelector('[aria-label="Black app icon"]'); return { title: b.title, disabled: b.getAttribute('aria-disabled') }`)
    const refused = await js<string>(`try { await window.notula.appIcon.set({ value: 'black' }); return 'accepted' } catch (e) { return String(e.message) }`)
    check('locked-colour-refused-by-main', refused.includes('Unlock after 10 notes (0/10)') && locked.title === 'Unlock after 10 notes (0/10)', { refused, locked })
    for (let n = 0; n < 100; n++) await ctx.storage.createNote({ origin: 'new_note_button', title: `G harness ${n}`, created_via: 'Windows' } as never)
    const blue = await js<{ current: string | null; noteCount: number }>(`return await window.notula.appIcon.set({ value: 'blue' })`)
    check('blue-applied', blue.current === 'blue' && blue.noteCount === 100, blue)
    writeFileSync(join(shots, 'icon-blue-256.png'), iconImage('blue').toPNG())
    for (const v of ['black', 'white', 'yellow', 'red', 'pink'] as const) writeFileSync(join(shots, `icon-${v}-256.png`), iconImage(v).toPNG())
    await go('/settings/preferences')
    await js(`document.querySelector('[role=radiogroup][aria-label="App icon"]').scrollIntoView({ block: 'center' }); return true`)
    await sleep(500)
    await shot('preferences-icon-blue')

    // ---- Labs ----
    await go('/settings/labs')
    await shot('labs')
    const isWin = process.platform === 'win32'
    const expected = LABS_FEATURES.filter((f) => !f.platforms || f.platforms.includes(isWin ? 'win32' : process.platform === 'darwin' ? 'darwin' : ('none' as never))).length
    const rendered = await js<number>(`return document.querySelectorAll('.labs-item').length`)
    check('labs-every-row-in-section', rendered === expected, { rendered, expected })
    const p2 = await prefs()
    check('labs-tip-ended-by-visit', !!(p2['nux.dismissed'] as Record<string, string>)['labs'])
    const child = await js<{ before: boolean; after: boolean; prefOn: boolean }>(`
      const sw = (l) => document.querySelector('button[role=switch][aria-label="' + l + '"]')
      const before = sw('Dispatcher').disabled
      sw('Action items').click()
      await new Promise((r) => setTimeout(r, 600))
      const p = await window.notula.prefs.get()
      return { before, after: sw('Dispatcher').disabled, prefOn: p['actionItems.enabled'] === true }`)
    check('labs-toggle-live-and-child-disabled', child.before && !child.after && child.prefOn, child)
    check('labs-mac-only-hidden', !(await js<boolean>(`return document.body.innerText.includes('Screen corner')`)) === isWin)
    const beta = await js<{ text: boolean; disabled: boolean }>(`
      const b = document.querySelector('button[role=switch][aria-label="Join the beta"]')
      return { text: document.body.innerText.includes('Beta updates aren’t available in this build'), disabled: !!b && b.disabled }`)
    check('beta-row-disabled-without-feed', beta.text && beta.disabled, beta)
    const channel = await js<unknown>(`return await window.notula.update.setChannel({ channel: 'beta' })`)
    check('set-channel-refuses-beta-without-feed', JSON.stringify(channel) === JSON.stringify({ ok: false, reason: __NOTULA_UPDATE_FEED_URL_BETA__ === '' ? 'no-beta-feed' : 'no-feed' }), channel)
    const stable = await js<unknown>(`return await window.notula.update.setChannel({ channel: 'stable' })`)
    check('set-channel-stable-ok', JSON.stringify(stable) === JSON.stringify({ ok: true, reason: null }), stable)

    // ---- feedback, under a net log ----
    const netFile = join(userData, 'g-netlog.json')
    await netLog.startLogging(netFile, { captureMode: 'default' })
    await go('/settings/feedback')
    await shot('feedback')
    const dialogDir = process.env['NOTULA_DEV_DIALOG_DIR'] ?? ''
    const png = join(dialogDir, 'shot.png')
    writeFileSync(png, iconImage('pink').toPNG())
    const big = join(dialogDir, 'big.mp4')
    writeFileSync(big, '')
    truncateSync(big, 25 * 1024 * 1024)
    const refusedBig = await js<string>(`try { await window.notula.feedback.saveReport({ mode: 'bug', category: 'Notes', message: 'x', includeSystemInfo: true, includeLogs: false, attachmentPaths: [${JSON.stringify(big)}] }); return 'accepted' } catch (e) { return String(e.message) }`)
    check('25mb-video-refused', refusedBig.includes('20 MB') && refusedBig.includes('big.mp4'), refusedBig)
    const noMsg = await js<string>(`try { await window.notula.feedback.saveReport({ mode: 'feature', category: null, message: 'hi', includeSystemInfo: true, includeLogs: false, attachmentPaths: [] }); return 'accepted' } catch (e) { return String(e.message) }`)
    check('feature-needs-category', noMsg.includes('Choose a feature category'), noMsg)
    const saved = await js<{ saved: boolean; path: string | null }>(`return await window.notula.feedback.saveReport({ mode: 'bug', category: 'Notes', message: 'The editor lost my heading.\\nSteps: type, undo.', includeSystemInfo: true, includeLogs: true, attachmentPaths: [${JSON.stringify(png)}] })`)
    const entries = saved.path && existsSync(saved.path) ? Object.keys(unzipSync(new Uint8Array(readFileSync(saved.path)))) : []
    const report = saved.path ? new TextDecoder().decode(unzipSync(new Uint8Array(readFileSync(saved.path)))['report.txt'] ?? new Uint8Array()) : ''
    check(
      'zip-contents',
      entries.includes('report.txt') && entries.includes('attachments/shot.png') && entries.some((e) => e.startsWith('logs/')) && report.includes('Category: Notes'),
      { entries, report }
    )
    const savedNoLogs = await js<{ path: string | null }>(`return await window.notula.feedback.saveReport({ mode: 'question', category: null, message: 'Where is the export?', includeSystemInfo: false, includeLogs: false, attachmentPaths: [] })`)
    const entries2 = savedNoLogs.path ? Object.keys(unzipSync(new Uint8Array(readFileSync(savedNoLogs.path)))) : []
    check('zip-logs-only-when-ticked', entries2.length === 1 && entries2[0] === 'report.txt', entries2)
    const open = await js<unknown>(`return await window.notula.feedback.open({ target: 'email', mode: 'bug', category: null, message: 'x', includeSystemInfo: true })`)
    check('open-email-hidden-without-constant', JSON.stringify(open) === JSON.stringify({ opened: false, shortened: false, reason: 'not-configured' }), open)
    const long = mailtoUrl({ mode: 'bug', category: 'Chat', message: Array.from({ length: 80 }, (_, i) => `Line ${i}: the reply was cut off mid-sentence.`).join('\n'), includeSystemInfo: true }, 'feedback@example.invalid')
    const body = decodeURIComponent(long.url.split('&body=')[1] ?? '')
    check('mailto-capped-at-1800', long.shortened && body.length <= 1800 && body.endsWith('(message shortened; use Save report for the full text)'), { length: body.length })
    await netLog.stopLogging()
    const net = readFileSync(netFile, 'utf8')
    const urls = [...new Set([...net.matchAll(/"url":"([^"]+)"/g)].map((m) => m[1]).filter((u) => u && !/^(devtools|file|data|blob|chrome|about):/.test(u) && !u.startsWith('http://localhost')))]
    check('feedback-no-network', urls.length === 0, urls)

    // ---- tips: counters, reset, switch ----
    const tips = await js<{ counter: number; dismissed: boolean }>(`
      for (let i = 0; i < 3; i++) window.notula.nux.increment({ id: 'slash-menu' })
      await new Promise((r) => setTimeout(r, 800))
      const p = await window.notula.prefs.get()
      return { counter: p['nux.counters']['slash-menu'], dismissed: !!p['nux.dismissed']['slash-menu'] }`)
    check('slash-counter-ends-at-3', tips.counter === 3 && tips.dismissed, tips)
    await js(`await window.notula.nux.reset(); return true`)
    const p3 = await prefs()
    const kept = Object.keys(p3['nux.dismissed'] as Record<string, string>)
    check('reset-brings-tips-back', kept.every((k) => k.startsWith('whats-new:')) && Object.keys(p3['nux.counters'] as object).length === 0, kept)
    await go('/home')
    const shownOn = await js<boolean>(`return !!document.querySelector('.nux-tip')`)
    await js(`window.notula.prefs.set({ 'nux.enabled': false }); return true`)
    await sleep(800)
    const shownOff = await js<boolean>(`return !!document.querySelector('.nux-tip, .nux-hint, .nux-pointer')`)
    check('show-tips-off-hides', !shownOn ? false : !shownOff, { shownOn, shownOff })
    await js(`window.notula.prefs.set({ 'nux.enabled': true }); return true`)

    // ---- prepare phase 2: a version change ----
    const dismissed = { ...((await ctx.settings.get('nux.dismissed')) as Record<string, string>) }
    delete dismissed[`whats-new:${app.getVersion()}`]
    await ctx.settings.set('nux.dismissed', dismissed as never)
    await ctx.settings.set('nux.lastSeenVersion', '0.0.0')
    out['finishedAt'] = new Date().toISOString()
    save()
  } catch (err) {
    out['error'] = err instanceof Error ? (err.stack ?? err.message) : String(err)
    save()
    log('error', 'g-harness:failed', { err })
  }
  setTimeout(() => app.quit(), 1_000)
}
