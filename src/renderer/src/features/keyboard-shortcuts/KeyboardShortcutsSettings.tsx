// SPDX-License-Identifier: Apache-2.0
// Settings ▸ Keyboard shortcuts. The six groups,
// each row with its key chips; rows whose feature is behind an off Labs switch say so.
//
// Quick ask, voice typing and New note can be changed: "Change" records keys in this window
// (the live voice-typing shortcut is suspended meanwhile; Escape aborts; 10 s times out;
// the editing combinations are ignored), main validates and asks the owner to apply it,
// and "Reset" stores the default. Main owns registration (`shortcuts:set`).
//
// The dictation bar rows: hold and hands-free dictation are lists (`multiple`) of up to 3 chords
// for the keyboard helper, shown as chips with Add and remove (`shortcuts:set-list`). A chord
// records as the largest set of keys held at once (modifier-only is fine), read by physical key
// so the right-side modifiers and the numpad stay distinct. Pressing it twice quickly on the
// hands-free row records a double tap. While no hands-free list is set, the entries derived from
// the hold chords show as defaults; removing every entry brings them back. The rows grey out
// with "Needs the keyboard helper." while the helper is unavailable (`shortcuts:hook-status`),
// and show the neutral conflict note while main reports one. The voice typing toggle is the
// fallback and is listed only while the helper is unavailable (or its conflict note is up).
// A hold or hands-free chord may be one extra mouse button (middle, back, forward), alone or
// after modifiers: the recorder takes it from this window's own mouse events (the primary and
// secondary buttons stay free for clicking), and the row says what the button does while voice
// typing is on. Every other row's recorder takes the press too, so main refuses it in words.
// `StandaloneShortcut` is one row's control for Settings ▸ Voice typing.

import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import { parseError } from '@shared/errors'
import { DICTATION_LIMITS } from '@shared/types/dictation'
import { mouseButtonLabel, mouseButtonOf, WINDOWS_MOUSE_MAX, type HookEntry, type HookStatus } from '@shared/types/dictation-bar'
import { isHookShortcut, type CustomisableShortcutId, type HookShortcutId, type ShortcutGroup, type ShortcutRow } from '@shared/types/shortcuts'
import { navigateToSettings } from '../../app/navigation'
import { debugLog, isMac } from '../../app/platform'
import { chipsFor, chordChips, chordKeyOf, chordText, mouseKeyOf, readKey, type Chip } from './keys'
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
/** The recorder's mouse events: a press, its release, and the click that would follow. */
const MOUSE_EVENTS = ['mousedown', 'mouseup', 'auxclick'] as const
/** After a chord comes up, a second press this soon makes it a double tap. */
const DOUBLE_TAP_WINDOW_MS = 450

const CUSTOMISABLE: readonly string[] = ['quickAsk', 'dictation', 'newNote', 'dictationHold', 'dictationHandsFree', 'recordToggle']
const NEEDS_HELPER = 'Needs the keyboard helper.'
/** The neutral conflict note: it never names or looks for another app. */
export const CONFLICT_NOTE = 'Another app may also answer this shortcut. If voice typing starts twice or not at all, pick another one.'

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

/** A small mouse with the button marked: the wheel, the rear or front side button, or a dot. */
function MouseGlyph({ button }: { button: number }): JSX.Element {
  return (
    <svg className="ks-mouse" viewBox="0 0 12 16" width="10" height="14" aria-hidden="true" focusable="false">
      <rect x="2" y="1" width="9" height="14" rx="4.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <path d="M6.5 1v5M2 6h9" stroke="currentColor" strokeWidth="1" />
      {button === 3 ? <rect x="5.5" y="2.6" width="2" height="3" rx="1" fill="currentColor" /> : null}
      {button === 4 ? <rect x="0.4" y="8.6" width="2.2" height="2.6" rx="0.8" fill="currentColor" /> : null}
      {button === 5 ? <rect x="0.4" y="5.4" width="2.2" height="2.6" rx="0.8" fill="currentColor" /> : null}
      {button > 5 ? <circle cx="6.5" cy="10.5" r="1.4" fill="currentColor" /> : null}
    </svg>
  )
}

function Chips({ chips }: { chips: Chip[] }): JSX.Element {
  return (
    <span className="ks-chips" role="img" aria-label={chips.map((c) => c.name).join(' + ')}>
      {chips.map((c, i) => (
        <kbd key={i} className={`ks-chip${c.mouse ? ' ks-chip--mouse' : ''}`} title={c.name} aria-hidden="true">
          {c.mouse ? <MouseGlyph button={c.mouse} /> : null}
          {c.text}
        </kbd>
      ))}
    </span>
  )
}

export function KeyChips({ accelerator }: { accelerator: string }): JSX.Element {
  return <Chips chips={chipsFor(accelerator)} />
}

/** A hook entry: its chord chips, and "twice" for a double tap. */
export function EntryChips({ entry }: { entry: HookEntry }): JSX.Element {
  return (
    <span className="ks-entry__keys">
      <Chips chips={chordChips(entry.keys)} />
      {entry.doubleTap ? <span className="ks-entry__twice">twice</span> : null}
    </span>
  )
}

const entryName = (e: HookEntry): string => `${chordChips(e.keys).map((c) => c.name).join(' + ')}${e.doubleTap ? ', twice' : ''}`

const isMouseKey = (k: string): boolean => mouseButtonOf(k) !== null
/** The recorder's hint for the keys held so far; with a mouse button, chip text ("Back button"). */
const heldHint = (keys: readonly string[]): string => {
  const text = chordText(keys)
  return keys.some(isMouseKey) ? chordChips(text).map((c) => c.text).join(' + ') : text
}

/** The modifiers a mouse event says are down, as chord keys. */
function eventModifiers(e: MouseEvent): string[] {
  const out: string[] = []
  if (e.ctrlKey) out.push('Ctrl')
  if (e.altKey) out.push(isMac ? 'Option' : 'Alt')
  if (e.shiftKey) out.push('Shift')
  if (e.metaKey) out.push(isMac ? 'Cmd' : 'Win')
  return out
}

/** Records one accelerator (`onSave`) or, for a hook row, one chord entry. */
function Recorder({
  row,
  doubleTap,
  onSave,
  onCancel
}: {
  row: ShortcutRow
  /** A hands-free row: pressing the chord twice quickly records a double tap. */
  doubleTap: boolean
  onSave(value: { accelerator: string } | { entry: HookEntry }): void
  onCancel(error: string | null): void
}): JSX.Element {
  const [hint, setHint] = useState(isHookShortcut(row.id) ? 'Press keys or a mouse button' : 'Press keys')
  const doneRef = useRef(false)

  useEffect(() => {
    const id = row.id as CustomisableShortcutId
    // The live voice-typing shortcuts would swallow the keys while they are recorded, on any
    // row: a bound mouse button would never reach this window, so main couldn't refuse it.
    window.notula.dictation.suspendShortcut({ suspended: true })
    const finish = (value: { accelerator: string } | { entry: HookEntry } | null, error: string | null = null): void => {
      if (doneRef.current) return
      doneRef.current = true
      if (value) onSave(value)
      else onCancel(error)
    }
    const timer = setTimeout(() => finish(null, 'Shortcut recording timed out'), RECORD_MS)

    // Hook chords: the largest set of keys held at once, taken when every key is up again.
    // A hands-free row waits briefly for the same chord again (a double tap).
    const held = new Set<string>()
    let peak: string[] = []
    let first: string | null = null
    let pending: ReturnType<typeof setTimeout> | null = null
    // Modifiers a mouse press says are down though their key-down came before recording began.
    let implied: string[] = []
    const press = (k: string): void => {
      if (pending) {
        clearTimeout(pending)
        pending = null
      }
      held.add(k)
      const now = [...held, ...implied.filter((m) => !held.has(m) && !held.has(`Right${m}`))]
      if (now.length > peak.length) peak = now
      setHint(heldHint(peak))
    }
    const release = (k: string): void => {
      held.delete(k)
      if (isMouseKey(k)) implied = []
      if (held.size > 0 || peak.length === 0) return
      const keys = peak
      peak = []
      if (keys.length < 2 && !keys.some(isMouseKey)) {
        setHint(isMac ? 'Hold two or more keys, like ⌃ ⌥, or press a mouse button' : 'Hold two or more keys, like Ctrl + Win, or press a mouse button')
        return
      }
      const text = chordText(keys)
      if (first === text) return finish({ entry: { keys: text, doubleTap: true } })
      first = text
      if (!doubleTap) return finish({ entry: { keys: text, doubleTap: false } })
      setHint(`${heldHint(keys)} — press again for a double tap`)
      pending = setTimeout(() => finish({ entry: { keys: text, doubleTap: false } }), DOUBLE_TAP_WINDOW_MS)
    }
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
      if (e.type === 'keydown') press(k)
      else release(k)
    }
    // The middle, back and forward buttons record; their default (scrolling, going back) never runs.
    const onChordMouse = (e: MouseEvent): void => {
      const k = mouseKeyOf(e)
      if (!k) return
      e.preventDefault()
      e.stopPropagation()
      if (e.type === 'mousedown') {
        implied = eventModifiers(e)
        press(k)
      } else if (e.type === 'mouseup' && held.has(k)) release(k)
    }
    // Any other row takes the press as it is, and main refuses a mouse button in words. It
    // finishes on the release: finishing on the press would leave the release unhandled, and
    // the back button's release would take the window back a page.
    let mousePress: { k: string; mods: string[] } | null = null
    const onMouse = (e: MouseEvent): void => {
      const k = mouseKeyOf(e)
      if (!k) return
      e.preventDefault()
      e.stopPropagation()
      if (e.type === 'mousedown') {
        const mods = eventModifiers(e).map((m) => (m === 'Option' ? 'Alt' : m === 'Win' ? 'Super' : m === 'Cmd' ? 'Command' : m))
        mousePress = { k, mods }
      } else if (e.type === 'mouseup' && mousePress?.k === k) finish({ accelerator: [...mousePress.mods, k].join('+') })
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
          finish({ accelerator: r.accelerator })
      }
    }

    const onMouseEvent = isHookShortcut(id) ? onChordMouse : onMouse
    if (isHookShortcut(id)) {
      window.addEventListener('keydown', onChordKey, true)
      window.addEventListener('keyup', onChordKey, true)
    } else window.addEventListener('keydown', onKey, true)
    for (const type of MOUSE_EVENTS) window.addEventListener(type, onMouseEvent, true)
    return () => {
      clearTimeout(timer)
      if (pending) clearTimeout(pending)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('keydown', onChordKey, true)
      window.removeEventListener('keyup', onChordKey, true)
      for (const type of MOUSE_EVENTS) window.removeEventListener(type, onMouseEvent, true)
      window.notula.dictation.suspendShortcut({ suspended: false })
    }
  }, [row.id, doubleTap, onSave, onCancel])

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

/** A `multiple` row: entry chips with remove buttons, Add (up to 3) and Reset. */
function ListControl({ row, recording, onRecord, onRecorded, hook }: ControlProps): JSX.Element {
  const id = row.id as HookShortcutId
  const list = row.entries ?? []
  const broken = row.available && hookBroken(hook)
  const save = useCallback(
    (entries: HookEntry[] | null, failure: string): void => {
      void window.notula.shortcuts
        .setList({ id, entries })
        .then((res) => onRecorded({ error: res.ok ? null : res.error }))
        .catch((err: unknown) => {
          debugLog('shortcuts:set-list-failed', { code: parseError(err).code })
          onRecorded({ error: failure })
        })
    },
    [id, onRecorded]
  )
  // The recorder keeps one callback while it is open; the list it appends to is read at save time.
  const listRef = useRef(list)
  listRef.current = list
  const onSave = useCallback(
    (v: { accelerator: string } | { entry: HookEntry }): void => {
      if ('entry' in v) save([...listRef.current, v.entry], 'Couldn’t record shortcut. Try again.')
    },
    [save]
  )
  const onCancel = useCallback((error: string | null) => onRecorded({ error }), [onRecorded])
  if (!row.available) {
    return (
      <div className="settings-row__control ks-control">
        <button type="button" className="ks-off" onClick={() => navigateToSettings('labs')}>
          Off — turn on in Labs
        </button>
      </div>
    )
  }
  return (
    <div className={`settings-row__control ks-control ks-list${broken ? ' is-disabled' : ''}`} title={broken ? NEEDS_HELPER : undefined}>
      {list.length === 0 && !recording ? <span className="ks-none">Off</span> : null}
      {list.map((e, i) => (
        <span key={`${e.keys}:${e.doubleTap}`} className={`ks-entry${row.derived ? ' is-default' : ''}`}>
          <EntryChips entry={e} />
          <button
            type="button"
            className="ks-entry__remove"
            aria-label={`Remove ${entryName(e)}`}
            disabled={recording}
            onClick={() => {
              const next = list.filter((_, j) => j !== i)
              // Hands-free with nothing left goes back to the derived entries.
              save(id === 'dictationHandsFree' && next.length === 0 ? null : next, 'Couldn’t remove the shortcut. Try again.')
            }}
          >
            ×
          </button>
        </span>
      ))}
      {recording ? <Recorder row={row} doubleTap={id === 'dictationHandsFree' && !isMac} onSave={onSave} onCancel={onCancel} /> : null}
      <span className="ks-actions">
        {!row.isDefault && !recording ? (
          <button type="button" className="n-btn n-btn--sm n-btn--ghost" onClick={() => save(null, 'Couldn’t reset the shortcut. Try again.')}>
            Reset
          </button>
        ) : null}
        {!recording && list.length < DICTATION_LIMITS.maxShortcutEntries ? (
          <button type="button" className="n-btn n-btn--sm" aria-label={`Add a shortcut for ${row.label}`} disabled={broken} onClick={onRecord}>
            Add
          </button>
        ) : null}
      </span>
    </div>
  )
}

/** One row's keys and its Reset / Change buttons. */
function Control(p: ControlProps): JSX.Element {
  const { row, recording, onRecord, onRecorded } = p
  const save = useCallback(
    (accelerator: string | null, failure: string): void => {
      void window.notula.shortcuts
        .set({ id: row.id as CustomisableShortcutId, accelerator })
        .then((res) => onRecorded({ error: res.ok ? null : (res.error ?? 'Couldn’t record shortcut. Try again.') }))
        .catch((err: unknown) => {
          debugLog('shortcuts:set-failed', { code: parseError(err).code })
          onRecorded({ error: failure })
        })
    },
    [row.id, onRecorded]
  )
  const onSave = useCallback((v: { accelerator: string } | { entry: HookEntry }) => save('accelerator' in v ? v.accelerator : v.entry.keys, 'Couldn’t record shortcut. Try again.'), [save])
  const onCancel = useCallback((error: string | null) => onRecorded({ error }), [onRecorded])
  if (row.multiple) return <ListControl {...p} />
  const keys = keysFor(row)
  const editable = CUSTOMISABLE.includes(row.id)
  return (
    <div className="settings-row__control ks-control">
      {!row.available ? (
        <button type="button" className="ks-off" onClick={() => navigateToSettings('labs')}>
          Off — turn on in Labs
        </button>
      ) : recording ? (
        <Recorder row={row} doubleTap={false} onSave={onSave} onCancel={onCancel} />
      ) : keys ? (
        <KeyChips accelerator={keys} />
      ) : (
        <span className="ks-none">Off</span>
      )}
      {editable && row.available ? (
        <span className="ks-actions">
          {!row.isDefault && !recording ? (
            <button type="button" className="n-btn n-btn--sm n-btn--ghost" onClick={() => save(null, 'Couldn’t reset the shortcut. Try again.')}>
              Reset
            </button>
          ) : null}
          {!recording ? (
            <button type="button" className="n-btn n-btn--sm" aria-label={`Change ${row.label} shortcut`} onClick={onRecord}>
              Change
            </button>
          ) : null}
        </span>
      ) : null}
    </div>
  )
}

/** The mouse buttons of a row's entries. */
const rowButtons = (row: ShortcutRow): number[] =>
  (row.entries ?? []).flatMap((e) => e.keys.split('+').map(mouseButtonOf)).filter((b): b is number => b !== null)

/** A hook row holding a mouse button: what the button does while voice typing is on. */
function mouseNote(row: ShortcutRow, hook: HookStatus | null): string | null {
  const buttons = rowButtons(row)
  if (!isHookShortcut(row.id) || !row.available || !buttons.length || hookBroken(hook)) return null
  if (hook?.mouse === 'failed') return 'The mouse button shortcut isn’t working right now. Your key shortcuts still work.'
  const far = isMac ? undefined : buttons.find((b) => b > WINDOWS_MOUSE_MAX)
  if (far !== undefined) return `This computer can’t detect ${mouseButtonLabel(far).toLowerCase()}. Try the middle, back or forward button.`
  if (isMac) return 'The mouse button also keeps its usual action.'
  return 'While voice typing is on, the mouse button in this shortcut does nothing else.'
}

/** The row's note: an error, the helper, the conflict, or the derived defaults. */
function noteFor(row: ShortcutRow, hook: HookStatus | null, error: string | null): { text: string; error: boolean } | null {
  if (error) return { text: error, error: true }
  if (isHookShortcut(row.id) && row.available && hookBroken(hook)) return { text: NEEDS_HELPER, error: false }
  if (row.conflict && row.available) return { text: CONFLICT_NOTE, error: false }
  if (row.derived && row.available && (row.entries?.length ?? 0) > 0) return { text: 'Defaults from your hold shortcuts', error: false }
  return null
}

function Row({ error, ...p }: ControlProps & { error: string | null }): JSX.Element | null {
  if (!keysFor(p.row) && !p.row.multiple) return null
  const note = noteFor(p.row, p.hook, error)
  const mouse = mouseNote(p.row, p.hook)
  return (
    <div className="settings-row ks-row">
      <div className="settings-row__text">
        <div className="settings-row__label">{p.row.label}</div>
        {note ? (
          <div className={`settings-row__hint${note.error ? ' ks-error' : ''}`} role={note.error ? 'alert' : undefined}>
            {note.text}
          </div>
        ) : null}
        {mouse ? <div className="settings-row__hint">{mouse}</div> : null}
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
  const note = noteFor(row, hook, error)
  const mouse = mouseNote(row, hook)
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
      {note ? (
        <p className={`ks-standalone__note${note.error ? ' ks-error' : ''}`} role={note.error ? 'alert' : undefined}>
          {note.text}
        </p>
      ) : null}
      {mouse ? <p className="ks-standalone__note">{mouse}</p> : null}
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
        // The voice typing toggle is the fallback: listed only while the keyboard helper can't run.
        const list = rows.filter((r) => r.group === g.id && (keysFor(r) !== '' || r.multiple) && !(r.id === 'dictation' && hook?.available && !r.conflict))
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
