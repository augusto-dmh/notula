// SPDX-License-Identifier: Apache-2.0
// Dev-only harness for the device lock. Unpackaged builds only,
// with NOTULA_DEV_DEVICE_LOCK_HARNESS=1 and NOTULA_DEV_DEVICE_LOCK_STUB=1: the OS verifier is the
// stub file, so no Windows Hello or Touch ID prompt ever opens. Phases (NOTULA_DEV_DEVICE_LOCK_HARNESS_PHASE):
// - `1`: a fresh profile; the switch rules, protected changes, relock and unlock, held sends; leaves the lock on;
// - `2`: a cold start with the lock on;
// - `3`: a cold start whose OS method is gone.
// Writes <userData>/device-lock-harness-<phase>.json (and lock-view PNGs), then quits.

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, powerMonitor, type BrowserWindow } from 'electron'
import type { DeviceLockApi, MainContext } from '../context'
import { assertEgress } from '../net/egress'
import { log } from '../log'

interface Result {
  id: string
  ok: boolean
  detail: string
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export async function runDeviceLockHarness(ctx: MainContext, lock: DeviceLockApi): Promise<void> {
  const phase = process.env.NOTULA_DEV_DEVICE_LOCK_HARNESS_PHASE ?? '1'
  const results: Result[] = []
  const check = (id: string, ok: boolean, detail: unknown): void => {
    results.push({ id, ok, detail: typeof detail === 'string' ? detail : JSON.stringify(detail) })
  }
  const stub = (availability: string, result: string): void =>
    writeFileSync(join(ctx.userDataPath, 'device-lock-stub.json'), JSON.stringify({ availability, result }))

  let win: BrowserWindow | null = null
  for (let i = 0; i < 100 && !win; i++) {
    const w = ctx.windows.main()
    if (w && !w.webContents.isLoading()) win = w
    else await sleep(200)
  }
  if (!win) {
    check('window', false, 'no main window')
    finish()
    return
  }
  await sleep(2_500)
  const js = (code: string): Promise<string> =>
    win!.webContents.executeJavaScript(code, true).then(
      (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v)),
      (err: unknown) => `exec-error:${String(err)}`
    )
  const call = (expr: string): Promise<string> =>
    js(`(${expr}).then((v) => JSON.stringify(v ?? null), (e) => 'rejected:' + e.message)`)
  const shot = async (name: string): Promise<void> => {
    const img = await win!.webContents.capturePage()
    writeFileSync(join(ctx.userDataPath, `harness-${name}.png`), img.toPNG())
  }

  try {
    if (phase === '1') {
      stub('Available', 'Verified')
      check('1a status', (await call('window.notula.deviceLock.getStatus()')).includes('"enabled":false'), await call('window.notula.deviceLock.getStatus()'))

      stub('NotConfiguredForUser', 'Verified')
      const r1b = await call('window.notula.deviceLock.setEnabled({ enabled: true })')
      check('1b enable refused while unavailable', r1b.includes('"enabled":false') && r1b.includes('"unavailableReason":"not-configured"'), r1b)

      stub('Available', 'Canceled')
      const r1c = await call('window.notula.deviceLock.setEnabled({ enabled: true })')
      check('1c enable needs a verification', r1c.includes('"enabled":false'), r1c)

      stub('Available', 'Verified')
      const r1d = await call('window.notula.deviceLock.setEnabled({ enabled: true })')
      check('1d enable after verification', r1d.includes('"enabled":true') && r1d.includes('"locked":false'), r1d)

      // Switch rules: on during a cloud transcription is refused.
      await ctx.settings.set('asr.provider', 'deepgram')
      const realCapturing = ctx.capture.isCapturing
      ctx.capture.isCapturing = () => true
      const r2a = await call('window.notula.privacy.setLocalOnly({ enabled: true, confirmed: true })')
      ctx.capture.isCapturing = realCapturing
      check('2a on refused during cloud transcription', r2a.includes('"reason":"cloud-transcription-active"'), r2a)

      const r2b = await call('window.notula.privacy.setLocalOnly({ enabled: true, confirmed: true })')
      const s2b = await ctx.settings.getAll()
      check(
        '2b on applies; providers local; previous saved',
        r2b.includes('"ok":true') && s2b['privacy.localOnly'] && s2b['asr.provider'] === 'local' && s2b['privacy.previousProviders']?.asr === 'deepgram',
        { r2b, asr: s2b['asr.provider'], llm: s2b['llm.provider'], prev: s2b['privacy.previousProviders'] }
      )

      // A local LLM on a LAN address is refused while on.
      await ctx.settings.set('llm.local.baseUrl', 'http://192.168.1.50:11434/v1')
      const lan = await assertEgress(ctx, { kind: 'llm' }, 'http://192.168.1.50:11434/v1', 'harness').then(
        () => 'allowed',
        (e: Error) => e.message
      )
      const st2c = await call('window.notula.privacy.localOnlyStatus()')
      check('2c LAN local LLM refused', lan.includes('local-only mode') && st2c.includes('local-llm-not-loopback'), { lan, st2c })
      await ctx.settings.set('llm.local.baseUrl', 'http://127.0.0.1:11434/v1')

      // Bypassing writes: renderer patches of main-only keys are dropped; main's protected write refuses.
      await js(`(window.notula.prefs.set({ 'privacy.localOnly': false, 'security.deviceLock': false }), 'sent')`)
      await sleep(500)
      const s5d = await ctx.settings.getAll()
      stub('Available', 'Canceled')
      const mainWrite = await ctx.settings.set('notifications.scheduledBlocked', true).then(
        () => 'applied',
        (e: Error) => e.message
      )
      check(
        '5d bypassing writes refused',
        s5d['privacy.localOnly'] && s5d['security.deviceLock'] && mainWrite.includes('Not verified'),
        { localOnly: s5d['privacy.localOnly'], deviceLock: s5d['security.deviceLock'], mainWrite }
      )

      // Protected switches with a cancel: unchanged.
      const off1 = await call('window.notula.privacy.setLocalOnly({ enabled: false, confirmed: true })')
      const off2 = await call('window.notula.deviceLock.setEnabled({ enabled: false })')
      const loginOk = await lock.confirmProtectedChange('openAtLogin')
      const autoOk = await lock.confirmProtectedChange('notifications.autoDetectedBlocked')
      const s5c = await ctx.settings.getAll()
      check(
        '5c protected changes cancelled stay unchanged',
        off1.includes('"reason":"not-verified"') && off2.includes('"enabled":true') && !loginOk && !autoOk && s5c['privacy.localOnly'] && !s5c['notifications.scheduledBlocked'],
        { off1, off2, loginOk, autoOk }
      )

      // Held sends: a due delivery is held when the mode turns off, then reviewed.
      const note = await ctx.storage.createNote({ origin: 'new_note_button', title: 'Held send', created_via: 'Windows' } as never)
      const [d] = await ctx.storage.createIntegrationDeliveries([
        {
          provider: 'zapier',
          destinationId: null,
          automationId: null,
          noteId: note.id,
          panelId: null,
          targetKey: 'harness',
          trigger: 'manual',
          status: 'pending',
          nextAttemptAt: new Date(Date.now() - 60_000).toISOString()
        } as never
      ])
      stub('Available', 'Verified')
      const off3 = await call('window.notula.privacy.setLocalOnly({ enabled: false, confirmed: true })')
      const s2d = await ctx.settings.getAll()
      const held = await call('window.notula.privacy.listHeldSends()')
      const due = await ctx.storage.dueIntegrationDeliveries(new Date().toISOString(), 50)
      check(
        '2d off asks, providers stay local, sends held',
        off3.includes('"ok":true') && !s2d['privacy.localOnly'] && s2d['asr.provider'] === 'local' && held.includes(d?.id ?? '-') && !due.some((x) => x.id === d?.id),
        { off3, asr: s2d['asr.provider'], held: held.slice(0, 120), dueHasIt: due.some((x) => x.id === d?.id) }
      )
      const disc = await call(`window.notula.privacy.releaseHeldSend({ deliveryId: '${d?.id}', action: 'discard' })`)
      check('2e discard a held send', disc.includes('"status":"cancelled"'), disc.slice(0, 160))

      // Relock and unlock. The lock view prompts once on its own: the stub cancels it.
      stub('Available', 'Canceled')
      powerMonitor.emit('lock-screen')
      await sleep(400)
      const n1 = await call(`window.notula.notes.list({ scope: 'own', limit: 1 })`)
      const a1 = await call('window.notula.app.info()')
      const c1 = await call('window.notula.capture.getStatus()')
      check('5b lock-screen relocks; note IPC locked; capture allowed', lock.isLocked() && n1.includes('locked') && !a1.startsWith('rejected') && !c1.startsWith('rejected'), { n1, a1: a1.slice(0, 60), c1: c1.slice(0, 60) })
      await sleep(800)
      await shot('locked-relock')

      stub('Available', 'Canceled')
      const u1 = await call('window.notula.deviceLock.unlock()')
      stub('Available', 'RetriesExhausted')
      const u2 = await call('window.notula.deviceLock.unlock()')
      check('5e failed unlocks keep the lock', u1.includes('"reason":"canceled"') && u2.includes('"reason":"retries-exhausted"') && lock.isLocked(), { u1, u2 })
      await sleep(600)
      await shot('locked-retries')

      stub('Available', 'Verified')
      const u3 = await call('window.notula.deviceLock.unlock()')
      await sleep(400)
      const n2 = await call(`window.notula.notes.list({ scope: 'own', limit: 1 })`)
      check('5f unlock restores IPC', u3.includes('"ok":true') && !lock.isLocked() && !n2.startsWith('rejected'), { u3, n2: n2.slice(0, 60) })

      stub('Available', 'Canceled')
      powerMonitor.emit('suspend')
      await sleep(300)
      const suspended = lock.isLocked()
      stub('Available', 'Verified')
      await call('window.notula.deviceLock.unlock()')
      check('5g suspend relocks', suspended && !lock.isLocked(), { suspended })
      // Leaves the lock on for phase 2.
    } else if (phase === '2') {
      const n = await call(`window.notula.notes.list({ scope: 'own', limit: 1 })`)
      const st = await call('window.notula.deviceLock.getStatus()')
      check('5a cold start is locked; note IPC returns locked', lock.isLocked() && n.includes('locked: Notula is locked') && st.includes('"locked":true'), { n, st })
      await shot('locked-cold-start')
    } else if (phase === '3') {
      const st = await call('window.notula.deviceLock.getStatus()')
      const s = await ctx.settings.getAll()
      check('5e method gone: unlocked with the warning; lock off', !lock.isLocked() && !s['security.deviceLock'] && st.includes('no longer set up'), st)
      await sleep(500)
      await shot('method-gone')
    }
  } catch (err) {
    check('harness', false, err instanceof Error ? err.stack ?? err.message : String(err))
  }
  finish()

  function finish(): void {
    const out = { phase, passed: results.filter((r) => r.ok).length, total: results.length, results }
    writeFileSync(join(ctx.userDataPath, `device-lock-harness-${phase}.json`), JSON.stringify(out, null, 2))
    log('info', 'device-lock-harness:done', { phase, passed: out.passed, total: out.total })
    if (process.env.NOTULA_DEV_DEVICE_LOCK_HARNESS_KEEP !== '1') setTimeout(() => app.quit(), 500)
  }
}
