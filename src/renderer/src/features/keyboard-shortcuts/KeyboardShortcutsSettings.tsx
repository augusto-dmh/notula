// SPDX-License-Identifier: Apache-2.0
// Settings ▸ Keyboard shortcuts. The six groups,
// each row with its key chips; rows whose feature is behind an off Labs switch say so.
//
// Quick ask, voice typing and New note can be changed: "Change" records keys in this window
// (the live voice-typing shortcut is suspended meanwhile; Escape aborts; 10 s times out;
// the editing combinations are ignored), main validates and asks the owner to apply it,
// and "Reset" stores the default. Main owns registration (`shortcuts:set`).
//
// The dictation bar rows: hold and hands-free dictation are chords
// for the keyboard helper. They record as the largest set of keys held at once (modifier-only
// is fine), can be turned off, and grey out with "Needs the keyboard helper." while the helper
// is unavailable (`shortcuts:hook-status`). `StandaloneShortcut` is one row's control for
// Settings ▸ Voice typing.

import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import { parseError } from '@shared/errors'
import type { HookStatus } from '@shared/types/dictation-bar'
import { isHookShortcut, type CustomisableShortcutId, type ShortcutGroup, type ShortcutRow } from '@shared/types/shortcuts'
import { navigateToSettings } from '../../app/navigation'
import { debugLog, isMac } from '../../app/platform'
import { chipsFor, chordKeyOf, chordText, readKey } from './keys'
import './keyboard-shortcuts.css'

const GROUPS: readonly { id: ShortcutGroup; title: string }[] = [
  { id: 'global', title: 'Global' },
  { id: 'general', title: 'General' },
  { id: 'notes', title: 'Notes and editor' },
  { id: 'lists', title: 'Lists and transcript' },
  { id: 'search', title: 'Search' },
  { id: 'chat', title: 'Chat and composers' }
]

const RECORD_MS = 10_000

const CUSTOMISABLE: readonly string[] = ['quickAsk', 'dictation', 'newNote', 'dictationHold', 'dictationHandsFree', 'recordToggle']
/** Rows whose recording would trigger a live global shortcut or hook chord. */
const SUSPENDS: readonly string[] = ['dictation', 'dictationHold', 'dictationHandsFree', 'recordToggle']
const NEEDS_HELPER = 'Needs the keyboard helper.'

function keysFor(row: ShortcutRow): string {
  return isMac ? row.effective.darwin : row.effective.default
}

/** The keyboard helper's status (`shortcuts:hook-status`), for the hook rows. */
export function useHookStatus(): HookStatus | null {
  const [status, setStatus] = useState<HookStatus | null>(null)
  useEffect(() => {
    let live = true
    void window.notula.dictation
      .getStatus()
      .then((s) => live && setStatus(s.hook))
      .catch(() => undefined)
    const off = window.notula.shortcuts.onHookStatus((s) => setStatus(s))
    return () => {
      live = false
      off()
    }
  }, [])
  return status
}

/** The helper failed or can't run (not merely idle because Voice typing is off). */
function hookBroken(s: HookStatus | null): boolean {
  return !!s && !s.available && (!!s.reason || !!s.lost)
}

export function KeyChips({ accelerator }: { accelerator: string }): JSX.Element {
  const chips = chipsFor(accelerator)
  return (
    <span className="ks-chips" role="img" aria-label={chips.map((c) => c.name).join(' + ')}>
      {chips.map((c, i) => (
        <kbd key={i} className="ks-chip" title={c.name} aria-hidden="true">
          {c.text}
        </kbd>
      ))}
    </span>
  )
}

function Recorder({
  row,
  onDone
}: {
  row: ShortcutRow
  onDone(result: { error: string | null }): void
}): JSX.Element {
  const [hint, setHint] = useState('Press keys')
  const doneRef = useRef(false)

  useEffect(() => {
    const id = row.id as CustomisableShortcutId
    // The live voice-typing shortcuts would swallow the keys while they are recorded.
    const suspends = SUSPENDS.includes(id)
    if (suspends) window.notula.dictation.suspendShortcut({ suspended: true })
    const finish = (error: string | null): void => {
      if (doneRef.current) return
      doneRef.current = true
      onDone({ error })
    }
    const timer = setTimeout(() => finish('Shortcut recording timed out'), RECORD_MS)
    const save = (accelerator: string): void => {
      clearTimeout(timer)
      setHint('Saving…')
      void window.notula.shortcuts
        .set({ id, accelerator })
        .then((res) => finish(res.ok ? null : (res.error ?? 'Couldn’t record shortcut. Try again.')))
        .catch((err: unknown) => {
          debugLog('shortcuts:set-failed', { code: parseError(err).code })
          finish('Couldn’t record shortcut. Try again.')
        })
    }

    // Hook chords: the largest set of keys held at once, taken when every key is up again.
    const held = new Set<string>()
    let peak: string[] = []
    const onChordKey = (e: KeyboardEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      if (e.repeat) return
      if (e.type === 'keydown' && e.key === 'Escape' && held.size === 0) return finish(null)
      const k = chordKeyOf(e)
      if (!k) {
        if (e.type === 'keydown') setHint('That key can’t be used. Try another')
        return
      }
      if (e.type === 'keydown') {
        held.add(k)
        if (held.size > peak.length) peak = [...held]
        setHint(chordText(peak))
        return
      }
      held.delete(k)
      if (held.size > 0 || peak.length === 0) return
      const keys = peak
      peak = []
      if (keys.length < 2) {
        setHint(isMac ? 'Hold two or more keys, like ⌃ ⌥' : 'Hold two or more keys, like Ctrl + Win')
        return
      }
      save(chordText(keys))
    }

    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      if (e.repeat) return
      const r = readKey(e)
      switch (r.kind) {
        case 'escape':
          finish(null)
          return
        case 'modifiers':
          return
        case 'needs-modifier':
          setHint(isMac ? 'Add ⌘, ⌥, ⌃ or ⇧' : 'Add Ctrl, Alt or Shift')
          return
        case 'reserved':
          setHint('That one is reserved. Try another')
          return
        case 'unsupported':
          setHint('That key can’t be used. Try another')
          return
        case 'combo':
          save(r.accelerator)
      }
    }

    if (isHookShortcut(id)) {
      window.addEventListener('keydown', onChordKey, true)
      window.addEventListener('keyup', onChordKey, true)
    } else window.addEventListener('keydown', onKey, true)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('keydown', onChordKey, true)
      window.removeEventListener('keyup', onChordKey, true)
      if (suspends) window.notula.dictation.suspendShortcut({ suspended: false })
    }
  }, [row.id, onDone])

  return (
    <span className="ks-recording" role="status" aria-label={`Recording shortcut for ${row.label}`}>
      {hint}
    </span>
  )
}

interface ControlProps {
  row: ShortcutRow
  recording: boolean
  onRecord(): void
  onRecorded(result: { error: string | null }): void
  hook: HookStatus | null
}

/** One row's keys and its Reset / Turn off / Change buttons. */
function Control({ row, recording, onRecord, onRecorded, hook }: ControlProps): JSX.Element {
  const keys = keysFor(row)
  const editable = CUSTOMISABLE.includes(row.id)
  const isHook = isHookShortcut(row.id)
  const broken = isHook && row.available && hookBroken(hook)
  const set = (accelerator: string | null, failure: string): void => {
    void window.notula.shortcuts
      .set({ id: row.id as CustomisableShortcutId, accelerator })
      .then((res) => onRecorded({ error: res.ok ? null : res.error }))
      .catch(() => onRecorded({ error: failure }))
  }
  return (
    <div className={`settings-row__control ks-control${broken ? ' is-disabled' : ''}`} title={broken ? NEEDS_HELPER : undefined}>
      {!row.available ? (
        <button type="button" className="ks-off" onClick={() => navigateToSettings('labs')}>
          Off — turn on in Labs
        </button>
      ) : recording ? (
        <Recorder row={row} onDone={onRecorded} />
      ) : keys ? (
        <KeyChips accelerator={keys} />
      ) : (
        <span className="ks-none">Off</span>
      )}
      {editable && row.available ? (
        <span className="ks-actions">
          {!row.isDefault && !recording ? (
            <button type="button" className="n-btn n-btn--sm n-btn--ghost" onClick={() => set(null, 'Couldn’t reset the shortcut. Try again.')}>
              Reset
            </button>
          ) : null}
          {isHook && keys && !recording ? (
            <button
              type="button"
              className="n-btn n-btn--sm n-btn--ghost"
              aria-label={`Turn off ${row.label}`}
              onClick={() => set('', 'Couldn’t turn the shortcut off. Try again.')}
            >
              Turn off
            </button>
          ) : null}
          {!recording ? (
            <button type="button" className="n-btn n-btn--sm" aria-label={`Change ${row.label} shortcut`} disabled={broken} onClick={onRecord}>
              Change
            </button>
          ) : null}
        </span>
      ) : null}
    </div>
  )
}

function Row({ error, ...p }: ControlProps & { error: string | null }): JSX.Element | null {
  const isHook = isHookShortcut(p.row.id)
  if (!keysFor(p.row) && !isHook) return null
  const broken = isHook && p.row.available && hookBroken(p.hook)
  return (
    <div className="settings-row ks-row">
      <div className="settings-row__text">
        <div className="settings-row__label">{p.row.label}</div>
        {error || broken ? (
          <div className={`settings-row__hint${error ? ' ks-error' : ''}`} role={error ? 'alert' : undefined}>
            {error ?? NEEDS_HELPER}
          </div>
        ) : null}
      </div>
      <Control {...p} />
    </div>
  )
}

/** One customisable row's control, loaded on its own (Settings ▸ Voice typing). */
export function StandaloneShortcut({ id }: { id: CustomisableShortcutId }): JSX.Element | null {
  const [row, setRow] = useState<ShortcutRow | null>(null)
  const [recording, setRecording] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const hook = useHookStatus()
  const load = useCallback(() => {
    void window.notula.shortcuts
      .list()
      .then((rows) => setRow(rows.find((r) => r.id === id) ?? null))
      .catch((err: unknown) => debugLog('shortcuts:list-failed', { code: parseError(err).code }))
  }, [id])
  useEffect(() => {
    load()
    const offShortcuts = window.notula.shortcuts.onChanged(load)
    const offPrefs = window.notula.prefs.onChanged(load)
    return () => {
      offShortcuts()
      offPrefs()
    }
  }, [load])
  const onRecorded = useCallback(
    (r: { error: string | null }) => {
      setRecording(false)
      setError(r.error)
      load()
    },
    [load]
  )
  if (!row) return null
  const broken = isHookShortcut(id) && row.available && hookBroken(hook)
  return (
    <div className="ks-standalone">
      <Control
        row={row}
        recording={recording}
        onRecord={() => {
          setError(null)
          setRecording(true)
        }}
        onRecorded={onRecorded}
        hook={hook}
      />
      {error || broken ? (
        <p className={`ks-standalone__note${error ? ' ks-error' : ''}`} role={error ? 'alert' : undefined}>
          {error ?? NEEDS_HELPER}
        </p>
      ) : null}
    </div>
  )
}

export function KeyboardShortcutsSettings(): JSX.Element {
  const [rows, setRows] = useState<ShortcutRow[] | null>(null)
  const [recordingId, setRecordingId] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, string | null>>({})
  const hook = useHookStatus()

  const load = useCallback(() => {
    void window.notula.shortcuts
      .list()
      .then(setRows)
      .catch((err: unknown) => debugLog('shortcuts:list-failed', { code: parseError(err).code }))
  }, [])

  useEffect(() => {
    load()
    const offShortcuts = window.notula.shortcuts.onChanged(load)
    const offPrefs = window.notula.prefs.onChanged(load)
    return () => {
      offShortcuts()
      offPrefs()
    }
  }, [load])

  const onRecorded = useCallback(
    (id: string) => (result: { error: string | null }) => {
      setRecordingId(null)
      setErrors((e) => ({ ...e, [id]: result.error }))
      load()
    },
    [load]
  )
  // One stable callback per row, so the recorder's effect does not restart on every render.
  const callbacks = useRef(new Map<string, (r: { error: string | null }) => void>())
  const doneFor = (id: string): ((r: { error: string | null }) => void) => {
    let cb = callbacks.current.get(id)
    if (!cb) {
      cb = onRecorded(id)
      callbacks.current.set(id, cb)
    }
    return cb
  }

  if (!rows) {
    return (
      <div className="settings__loading" aria-busy="true">
        <div className="n-skeleton" style={{ height: 18, width: 120 }} />
        <div className="n-skeleton" style={{ height: 200 }} />
      </div>
    )
  }

  return (
    <>
      {GROUPS.map((g) => {
        const list = rows.filter((r) => r.group === g.id && (keysFor(r) !== '' || isHookShortcut(r.id)))
        if (list.length === 0) return null
        return (
          <section key={g.id} className="settings-group">
            <h2 className="settings-group__title">{g.title}</h2>
            <div className="settings-card ks-card">
              {list.map((r) => (
                <Row
                  key={r.id}
                  row={r}
                  recording={recordingId === r.id}
                  error={errors[r.id] ?? null}
                  hook={hook}
                  onRecord={() => {
                    setErrors((e) => ({ ...e, [r.id]: null }))
                    setRecordingId(r.id)
                  }}
                  onRecorded={doneFor(r.id)}
                />
              ))}
            </div>
          </section>
        )
      })}
    </>
  )
}
