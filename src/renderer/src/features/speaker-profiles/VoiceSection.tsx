// SPDX-License-Identifier: Apache-2.0
// The person page's Voice and Agreement sections: shown while either
// voice row is on, the person has a voice, or an agreement record or a pending request exists.
// Below them, the Person section: Link to <email> / Merge with… and Delete person.
//
// The renderer gets display fields only (states, dates, counts, the method). The notice text and
// the reply arrive only on View message (`agreement-text`), and are dropped again on Hide.
//
// Withdrawal is one action in every state that holds a voice or an active agreement:
// Forget voice with its "Why?" while a sample exists, else Withdraw agreement…, the same
// `forget-voice` call with reason `withdrawn`, which also ends the pending requests.

import { useCallback, useEffect, useState, type JSX, type ReactNode } from 'react'
import { personRouteKey } from '@shared/lib/people'
import type { SpeakerForgetReason, SpeakerMatchRow, SpeakerPersonView, SpeakerRosterRow, SpeakerSampleRow } from '@shared/types/speakers'
import { navigate, navigateToSettings } from '../../app/navigation'
import { debugLog } from '../../app/platform'
import { showToast } from '../../app/toast'
import { usePrefs } from '../settings/prefs-store'
import { SpeechSwitch } from '../transcript/LocalAsrSettings'
import { YourVoiceRows } from '../voiceprint'
import { openAgreementSheet } from './agreement-sheet'
import { SpDialog } from './Dialog'
import * as S from './strings'
import './speaker-profiles.css'

const UNDO_MS = 10_000

function day(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

function fail(what: string): (err: unknown) => void {
  return (err) => {
    debugLog('speaker-person-action-failed', { what, err: String(err).slice(0, 200) })
    showToast({ kind: 'error', title: S.couldnt(what) })
  }
}

/** The persisted person behind a derived (email) row, or null when there's none yet. */
function usePersonId(personId: string | undefined, email: string | undefined): string | null | undefined {
  const [resolved, setResolved] = useState<string | null | undefined>(personId ?? undefined)
  const resolve = useCallback(() => {
    if (personId) {
      setResolved(personId)
      return
    }
    if (!email) {
      setResolved(null)
      return
    }
    window.notula.speakerPeople
      .list({ query: email })
      .then((rows) => setResolved(rows.find((r) => r.email === email && r.personId)?.personId ?? null))
      .catch(() => setResolved(null))
  }, [personId, email])
  useEffect(resolve, [resolve])
  useEffect(() => window.notula.speakerPeople.onChanged(() => resolve()), [resolve])
  return resolved
}

function usePersonView(personId: string | null | undefined): [SpeakerPersonView | null | undefined, () => void] {
  const [view, setView] = useState<SpeakerPersonView | null | undefined>(undefined)
  const load = useCallback(() => {
    if (!personId) {
      setView(personId === null ? null : undefined)
      return
    }
    window.notula.speakerPeople
      .get({ personId })
      .then(setView)
      .catch(() => setView(null))
  }, [personId])
  useEffect(load, [load])
  useEffect(
    () =>
      window.notula.speakerPeople.onChanged((p) => {
        if (!p.personId || p.personId === personId) load()
      }),
    [load, personId]
  )
  return [view, load]
}

function Card({ title, state, children }: { title: string; state?: ReactNode; children: ReactNode }): JSX.Element {
  return (
    <section className="nt-pv__card" aria-label={title}>
      <div className="nt-pv__head">
        <h3 className="nt-pv__title">{title}</h3>
        {state}
      </div>
      {children}
    </section>
  )
}

function Row({ main, sub, actions }: { main: ReactNode; sub?: ReactNode; actions?: ReactNode }): JSX.Element {
  return (
    <div className="nt-pv__row">
      <div className="nt-pv__text">
        <div className="nt-pv__main">{main}</div>
        {sub ? <div className="nt-pv__sub">{sub}</div> : null}
      </div>
      {actions ? <div className="nt-pv__actions">{actions}</div> : null}
    </div>
  )
}

function StateDot({ kind, label }: { kind: 'on' | 'wait' | 'off'; label: string }): JSX.Element {
  return (
    <span className="nt-pv__state">
      <span className={`nt-pv__dot${kind === 'off' ? '' : ` nt-pv__dot--${kind}`}`} aria-hidden="true" />
      {label}
    </span>
  )
}

// ---------- Voice ----------

function MeetingsList({ personId }: { personId: string }): JSX.Element {
  const [rows, setRows] = useState<SpeakerMatchRow[] | null>(null)
  useEffect(() => {
    window.notula.speakerPeople.matches({ personId }).then(setRows, fail('load the meetings'))
  }, [personId])
  if (!rows) return <ul className="nt-pv__list" aria-busy="true" />
  return (
    <ul className="nt-pv__list">
      {rows.map((m) => (
        <li key={`${m.noteId}:${m.kind}`}>
          <button type="button" className="nt-pv__link" onClick={() => navigate(`/meeting/${encodeURIComponent(m.noteId)}`)}>
            {m.title || 'Untitled'}
          </button>
          <span className="nt-pv__sub">
            {day(m.date)} · {S.matchKind[m.kind]?.() ?? ''}
          </span>
        </li>
      ))}
    </ul>
  )
}

function SamplesList({ personId, name, skipped }: { personId: string; name: string; skipped: number }): JSX.Element {
  const [rows, setRows] = useState<SpeakerSampleRow[] | null>(null)
  const [removing, setRemoving] = useState<Set<string>>(new Set())
  const load = useCallback(() => {
    window.notula.speakerPeople.samples({ personId }).then(setRows, fail('load the samples'))
  }, [personId])
  useEffect(load, [load])

  const remove = async (sampleId: string): Promise<void> => {
    try {
      const { undoToken } = await window.notula.speakerPeople.removeSample({ sampleId })
      // The delete waits for the Undo window: the row is hidden until then.
      setRemoving((s) => new Set(s).add(sampleId))
      showToast({
        id: `speaker-sample-${sampleId}`,
        title: S.toastSampleRemoved(),
        durationMs: UNDO_MS,
        ...(undoToken
          ? {
              action: {
                label: S.toastUndo(),
                onClick: () => {
                  void window.notula.speakerNames.undo({ undoToken }).then(({ ok }) => {
                    if (ok)
                      setRemoving((s) => {
                        const n = new Set(s)
                        n.delete(sampleId)
                        return n
                      })
                  })
                }
              }
            }
          : {})
      })
    } catch (err) {
      fail('remove the sample')(err)
    }
  }

  return (
    <>
      <ul className="nt-pv__list">
        {(rows ?? [])
          .filter((r) => !removing.has(r.sampleId))
          .map((r) => (
            <li key={r.sampleId}>
              <div className="nt-pv__text">
                <span>
                  {r.noteId ? (
                    <button type="button" className="nt-pv__link" onClick={() => navigate(`/meeting/${encodeURIComponent(r.noteId ?? '')}`)}>
                      {r.noteTitle || 'Untitled'}
                    </button>
                  ) : (
                    S.sampleDeletedMeeting()
                  )}
                </span>
                <span className="nt-pv__sub">
                  {day(r.createdAt)} · {r.channel === 'mic' ? S.channelInTheRoom() : S.channelOnTheCall()} · {S.sampleSeconds(Math.max(1, Math.round(r.cleanMs / 1000)))} ·{' '}
                  {S.sampleVia[r.via]?.() ?? ''}
                </span>
              </div>
              <button type="button" className="n-btn n-btn--sm n-btn--ghost" onClick={() => void remove(r.sampleId)}>
                {S.sheetRemove()}
              </button>
            </li>
          ))}
      </ul>
      {skipped > 0 ? <p className="nt-pv__row nt-pv__sub">{S.voiceSkippedSamples(skipped, name)}</p> : null}
    </>
  )
}

/** `withdrawal`: the person has an agreement but no sample, so the action only ends the agreement. */
function ForgetVoiceDialog({ personId, name, withdrawal, onClose }: { personId: string; name: string; withdrawal: boolean; onClose(): void }): JSX.Element {
  const [reason, setReason] = useState<SpeakerForgetReason>(withdrawal ? 'withdrawn' : 'forget')
  const [busy, setBusy] = useState(false)
  const confirm = async (): Promise<void> => {
    setBusy(true)
    try {
      await window.notula.speakerPeople.forgetVoice({ personId, reason: withdrawal ? 'withdrawn' : reason, confirmed: true })
      showToast({ kind: 'success', title: withdrawal ? S.toastWithdrew(name) : S.toastForgotVoice(name) })
      onClose()
    } catch (err) {
      setBusy(false)
      fail(withdrawal ? 'withdraw the agreement' : 'forget the voice')(err)
    }
  }
  if (withdrawal) {
    return (
      <SpDialog
        title={S.withdrawTitle(name)}
        onClose={onClose}
        actions={[
          { label: S.cancel(), onClick: onClose, autoFocus: true },
          { label: S.withdrawConfirm(), kind: 'danger', disabled: busy, onClick: () => void confirm() }
        ]}
      >
        <p>{S.withdrawBody(name)}</p>
      </SpDialog>
    )
  }
  return (
    <SpDialog
      title={S.forgetVoiceTitle(name)}
      onClose={onClose}
      actions={[
        { label: S.cancel(), onClick: onClose, autoFocus: true },
        { label: S.voiceForget(), kind: 'danger', disabled: busy, onClick: () => void confirm() }
      ]}
    >
      <p>{S.forgetVoiceBody(name)}</p>
      <div className="nt-spd__choices" role="radiogroup" aria-label={S.forgetVoiceWhy()}>
        <strong>{S.forgetVoiceWhy()}</strong>
        <label className="nt-spd__choice">
          <input type="radio" name="nt-forget-why" checked={reason === 'forget'} onChange={() => setReason('forget')} />
          {S.forgetVoiceRemoving()}
        </label>
        <label className="nt-spd__choice">
          <input type="radio" name="nt-forget-why" checked={reason === 'withdrawn'} onChange={() => setReason('withdrawn')} />
          {S.forgetVoiceWithdrew(name)}
        </label>
      </div>
    </SpDialog>
  )
}

/** `othersOn`: Recognize voices; Remember <name>'s voice… is offered only then. */
function VoiceCard({ view, othersOn }: { view: SpeakerPersonView; othersOn: boolean }): JSX.Element {
  const { person, voice, agreement, pending } = view
  const name = person.name
  const personId = person.personId
  const active = !!agreement && !agreement.revokedAt
  const [panel, setPanel] = useState<'meetings' | 'samples' | null>(null)
  const [explain, setExplain] = useState(false)
  const [forgetting, setForgetting] = useState(false)

  const recordAgreement = async (): Promise<boolean> => {
    const r = await openAgreementSheet({ personId, name, canAskFirst: false })
    if (r.outcome === 'recorded') showToast({ kind: 'success', title: S.toastAgreementRecorded(name) })
    return r.outcome === 'recorded'
  }

  const rememberVoice = async (): Promise<void> => {
    if (active || (await recordAgreement())) setExplain(true)
  }

  const namePending = async (noteId: string, title: string): Promise<void> => {
    try {
      // The span decides which speaker; the identity key is only a hint.
      const r = await window.notula.speakerNames.namePending({ noteId, identityKey: '', personId })
      const token = r.undoToken
      showToast({
        title: S.toastNamed(r.chunksNamed, name),
        durationMs: UNDO_MS,
        ...(token ? { action: { label: S.toastUndo(), onClick: () => void window.notula.speakerNames.undo({ undoToken: token }) } } : {})
      })
    } catch (err) {
      fail(`name ${name} in ${title || 'this meeting'}`)(err)
    }
  }

  const remembered = voice.state === 'remembered' || voice.state === 'stale' || voice.since !== null
  const waiting = pending.length > 0
  const withdrawButton = (
    <button type="button" className="n-btn n-btn--sm n-btn--ghost" onClick={() => setForgetting(true)}>
      {S.voiceWithdraw()}
    </button>
  )

  let state: JSX.Element
  if (remembered) state = <StateDot kind="on" label={S.voiceSince(day(voice.since))} />
  else if (waiting) state = <StateDot kind="wait" label={S.waitingForReply(name)} />
  else state = <StateDot kind="off" label={S.off()} />

  return (
    <Card title={S.voiceSection()} state={state}>
      {remembered ? (
        <>
          {voice.stale ? <Row main={<span className="nt-pv__warn">{S.voiceNeedsNewSample(name)}</span>} /> : null}
          <Row
            main={S.voiceSince(day(voice.since))}
            sub={voice.expiresAt ? S.voiceForgottenBy(day(voice.expiresAt)) : undefined}
          />
          <Row
            main={
              voice.recognizedCount > 0 ? (
                <button type="button" className="nt-pv__link" aria-expanded={panel === 'meetings'} onClick={() => setPanel((p) => (p === 'meetings' ? null : 'meetings'))}>
                  {panel === 'meetings' ? S.voiceHideMeetings() : S.voiceRecognizedIn(voice.recognizedCount)}
                </button>
              ) : (
                S.voiceRecognizedNone()
              )
            }
          />
          {panel === 'meetings' ? <MeetingsList personId={personId} /> : null}
          <Row
            main={S.voiceRecognizeAutomatically()}
            sub={S.voiceRecognizeAutomaticallyDetail(name)}
            actions={
              <SpeechSwitch
                label={S.voiceRecognizeAutomatically()}
                checked={voice.autoRecognize}
                onChange={(enabled) => void window.notula.speakerPeople.setAuto({ personId, enabled }).catch(fail('change the setting'))}
              />
            }
          />
          <Row
            main={
              <button type="button" className="nt-pv__link" aria-expanded={panel === 'samples'} onClick={() => setPanel((p) => (p === 'samples' ? null : 'samples'))}>
                {panel === 'samples' ? S.voiceHideSamples() : S.voiceManageSamples()}
              </button>
            }
            actions={
              <button type="button" className="n-btn n-btn--sm n-btn--danger" onClick={() => setForgetting(true)}>
                {S.voiceForget()}
              </button>
            }
          />
          {panel === 'samples' ? <SamplesList personId={personId} name={name} skipped={voice.skippedSamples} /> : null}
        </>
      ) : waiting ? (
        <>
          <Row
            main={S.waitingForReply(name)}
            actions={
              active ? (
                withdrawButton
              ) : (
                <button type="button" className="n-btn n-btn--sm n-btn--primary" onClick={() => void recordAgreement()}>
                  {S.voiceRecordAgreement(name)}
                </button>
              )
            }
          />
          <ul className="nt-pv__list">
            {pending.map((p) => (
              <li key={p.noteId}>
                <div className="nt-pv__text">
                  <button type="button" className="nt-pv__link" onClick={() => navigate(`/meeting/${encodeURIComponent(p.noteId)}`)}>
                    {p.title || 'Untitled'}
                  </button>
                  <span className="nt-pv__sub">{day(p.askedAt)}</span>
                </div>
                {p.canName ? (
                  <button type="button" className="n-btn n-btn--sm" onClick={() => void namePending(p.noteId, p.title)}>
                    {S.voiceNameIn(name, p.title || 'this meeting')}
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      ) : active ? (
        <Row main={<p className="nt-pv__note">{S.voiceAgreedNoSample(name)}</p>} actions={withdrawButton} />
      ) : (
        <Row
          main={S.voiceNone(name)}
          sub={explain ? S.voiceStartsNextTime(name) : undefined}
          actions={
            othersOn && !explain ? (
              <button type="button" className="n-btn n-btn--sm" onClick={() => void rememberVoice()}>
                {S.voiceRemember(name)}
              </button>
            ) : null
          }
        />
      )}
      {forgetting ? <ForgetVoiceDialog personId={personId} name={name} withdrawal={!remembered} onClose={() => setForgetting(false)} /> : null}
    </Card>
  )
}

// ---------- Agreement ----------

function AgreementCard({ view }: { view: SpeakerPersonView }): JSX.Element | null {
  const a = view.agreement
  const name = view.person.name
  const personId = view.person.personId
  const [text, setText] = useState<{ noticeText: string; evidenceText?: string } | null>(null)
  const [removing, setRemoving] = useState(false)
  // A new record, or a revocation, drops a message shown for the old one.
  useEffect(() => setText(null), [a?.attestedAt, a?.revokedAt])
  if (!a) return null

  const toggleMessage = (): void => {
    if (text) {
      setText(null)
      return
    }
    window.notula.speakerPeople.agreementText({ personId }).then(setText, fail('load the message'))
  }
  const exportRecord = (): void => {
    window.notula.speakerPeople.exportAgreement({ personId }).then((r) => {
      if ('ok' in r) showToast({ kind: 'success', title: S.toastAgreementSaved() })
    }, fail('export the agreement record'))
  }
  const remove = async (): Promise<void> => {
    try {
      await window.notula.speakerPeople.deleteAgreement({ personId, confirmed: true })
      showToast({ kind: 'success', title: S.toastAgreementRemoved() })
    } catch (err) {
      fail('remove the record')(err)
    }
    setRemoving(false)
  }

  const method = S.agreementMethod[a.method]?.() ?? a.method
  const language = a.language === 'pt' ? S.languagePortuguese() : S.languageEnglish()
  const why = a.revokedVia ? (S.agreementEndedVia[a.revokedVia]?.(name) ?? '') : ''

  return (
    <Card
      title={S.agreementSection()}
      state={a.revokedAt ? <StateDot kind="off" label={S.agreementEnded(day(a.revokedAt), why)} /> : <StateDot kind="on" label={method} />}
    >
      <Row
        main={S.agreementSummary(method, day(a.attestedAt))}
        sub={[S.agreementMessageLine(language, a.noticeVersion), a.hasEvidence ? S.agreementWithReply() : null].filter(Boolean).join(' · ')}
      />
      {a.revokedAt ? <Row main={S.agreementEnded(day(a.revokedAt), why)} sub={S.agreementKeptAsProof()} /> : null}
      <Row
        main={
          <button type="button" className="nt-pv__link" aria-expanded={!!text} onClick={toggleMessage}>
            {text ? S.agreementHideMessage() : S.agreementViewMessage()}
          </button>
        }
        actions={
          <>
            <button type="button" className="n-btn n-btn--sm" onClick={exportRecord}>
              {S.agreementExport()}
            </button>
            {a.revokedAt ? (
              <button type="button" className="n-btn n-btn--sm n-btn--danger" onClick={() => setRemoving(true)}>
                {S.agreementRemove()}
              </button>
            ) : null}
          </>
        }
      />
      {text ? (
        <div className="nt-pv__message" lang={a.language}>
          <h4>{S.sheetMessageTo(name)}</h4>
          {text.noticeText}
          {text.evidenceText ? (
            <>
              <h4>{S.agreementReply()}</h4>
              {text.evidenceText}
            </>
          ) : null}
        </div>
      ) : null}
      {removing ? (
        <SpDialog
          title={S.agreementRemoveTitle()}
          onClose={() => setRemoving(false)}
          actions={[
            { label: S.cancel(), onClick: () => setRemoving(false), autoFocus: true },
            { label: S.agreementRemove(), kind: 'danger', onClick: () => void remove() }
          ]}
        >
          <p>{S.agreementRemoveBody(name)}</p>
        </SpDialog>
      ) : null}
    </Card>
  )
}

// ---------- Person: link, merge, delete ----------

interface MergePlan {
  fromId: string
  fromName: string
  intoId: string
  intoName: string
  intoRoute: string
  samplesRemoved: number
  /** A later withdrawal governs the merged voice: the merge forgets it. */
  withdrawnAt?: string
}

function MergePicker({ view, onPick, onClose }: { view: SpeakerPersonView; onPick(row: SpeakerRosterRow): void; onClose(): void }): JSX.Element {
  const [query, setQuery] = useState('')
  const [rows, setRows] = useState<SpeakerRosterRow[]>([])
  useEffect(() => {
    let alive = true
    const t = setTimeout(() => {
      window.notula.speakerPeople.list({ query: query.trim() }).then((r) => {
        if (alive) setRows(r.filter((x) => x.personId && x.personId !== view.person.personId && !x.isSelf))
      }, fail('load people'))
    }, 120)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [query, view.person.personId])
  return (
    <SpDialog title={S.mergePickTitle(view.person.name)} onClose={onClose} actions={[{ label: S.cancel(), onClick: onClose }]}>
      <input
        className="n-input nt-spd__search"
        value={query}
        placeholder={S.mergePickSearch()}
        aria-label={S.mergePickSearch()}
        onChange={(e) => setQuery(e.target.value)}
      />
      {rows.length ? (
        <ul className="nt-spd__list">
          {rows.map((r) => (
            <li key={r.personId}>
              <button type="button" onClick={() => onPick(r)}>
                <span>{r.name}</span>
                {r.email ? <small>{r.email}</small> : null}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p>{S.mergePickNone()}</p>
      )}
    </SpDialog>
  )
}

function PersonCard({ view }: { view: SpeakerPersonView }): JSX.Element {
  const { person } = view
  const [picking, setPicking] = useState(false)
  const [plan, setPlan] = useState<MergePlan | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [offerName, setOfferName] = useState<string | null>(null)
  const offer = view.mergeOffer
  useEffect(() => {
    setOfferName(null)
    if (!offer?.intoPersonId) return
    window.notula.speakerPeople.get({ personId: offer.intoPersonId }).then((v) => setOfferName(v.person.name), () => undefined)
  }, [offer?.intoPersonId])

  /** The person with an email survives; otherwise the one picked. */
  const planMerge = async (other: { personId: string; name: string; email?: string }): Promise<void> => {
    const keepThis = !!person.email && !other.email
    const from = keepThis ? { id: other.personId, name: other.name } : { id: person.personId, name: person.name }
    const into = keepThis ? { id: person.personId, name: person.name, email: person.email } : { id: other.personId, name: other.name, email: other.email }
    try {
      const preview = await window.notula.speakerPeople.mergePreview({ fromId: from.id, intoId: into.id })
      setPlan({
        fromId: from.id,
        fromName: from.name,
        intoId: into.id,
        intoName: into.name,
        intoRoute: personRouteKey({ ...(into.email ? { email: into.email } : {}), personId: into.id }),
        samplesRemoved: preview.samplesRemoved,
        ...(preview.withdrawnAt ? { withdrawnAt: preview.withdrawnAt } : {})
      })
    } catch (err) {
      fail('prepare the merge')(err)
    }
  }

  const merge = async (p: MergePlan): Promise<void> => {
    try {
      await window.notula.speakerPeople.merge({ fromId: p.fromId, intoId: p.intoId, confirmed: true })
      showToast({ kind: 'success', title: S.toastMerged(p.intoName) })
      setPlan(null)
      if (p.intoId !== person.personId) navigate(`/person/${encodeURIComponent(p.intoRoute)}`, { replace: true })
    } catch (err) {
      fail('merge')(err)
    }
  }

  const link = async (email: string): Promise<void> => {
    try {
      const r = await window.notula.speakerPeople.linkEmail({ personId: person.personId, email })
      if ('taken' in r) {
        await planMerge({ personId: r.taken.personId, name: r.taken.name, email })
        return
      }
      showToast({ kind: 'success', title: S.toastLinked(email) })
      navigate(`/person/${encodeURIComponent(email)}`, { replace: true })
    } catch (err) {
      fail('link the email')(err)
    }
  }

  const remove = async (): Promise<void> => {
    try {
      await window.notula.speakerPeople.delete({ personId: person.personId, confirmed: true })
      showToast({ kind: 'success', title: S.toastDeleted(person.name) })
      navigate('/people', { replace: true })
    } catch (err) {
      setDeleting(false)
      fail('delete the person')(err)
    }
  }

  return (
    <div className="nt-pv__footer">
      {offer ? (
        offer.intoPersonId ? (
          <button
            type="button"
            className="n-btn n-btn--sm"
            onClick={() => void planMerge({ personId: offer.intoPersonId ?? '', name: offerName ?? offer.email, email: offer.email })}
          >
            {S.voiceMergeWith(offerName ?? offer.email)}
          </button>
        ) : (
          <button type="button" className="n-btn n-btn--sm" onClick={() => void link(offer.email)}>
            {S.voiceLinkTo(offer.email)}
          </button>
        )
      ) : null}
      <button type="button" className="n-btn n-btn--sm" onClick={() => setPicking(true)}>
        {S.voiceMergeWithAny()}
      </button>
      {view.canDelete ? (
        <button type="button" className="n-btn n-btn--sm n-btn--danger" onClick={() => setDeleting(true)}>
          {S.personDelete()}
        </button>
      ) : (
        <span className="nt-pv__sub nt-pv__blocked">
          {S.personDeleteBlocked(person.name)}
        </span>
      )}
      {picking ? (
        <MergePicker
          view={view}
          onClose={() => setPicking(false)}
          onPick={(r) => {
            setPicking(false)
            if (r.personId) void planMerge({ personId: r.personId, name: r.name, ...(r.email ? { email: r.email } : {}) })
          }}
        />
      ) : null}
      {plan ? (
        <SpDialog
          title={S.mergeTitle(plan.fromName, plan.intoName)}
          onClose={() => setPlan(null)}
          actions={[
            { label: S.cancel(), onClick: () => setPlan(null), autoFocus: true },
            { label: S.mergeConfirm(), kind: 'danger', onClick: () => void merge(plan) }
          ]}
        >
          <p>{plan.withdrawnAt ? S.mergeBodyWithdrawn(plan.intoName, day(plan.withdrawnAt)) : S.mergeBody(plan.intoName, plan.samplesRemoved)}</p>
        </SpDialog>
      ) : null}
      {deleting ? (
        <SpDialog
          title={S.personDeleteTitle(person.name)}
          onClose={() => setDeleting(false)}
          actions={[
            { label: S.cancel(), onClick: () => setDeleting(false), autoFocus: true },
            { label: S.personDelete(), kind: 'danger', onClick: () => void remove() }
          ]}
        >
          <p>{S.personDeleteBody()}</p>
        </SpDialog>
      ) : null}
    </div>
  )
}

/** `personId` absent: a derived (email-only) person with no persisted row yet. */
export function VoiceSection({ personId: given, email, name }: { personId?: string; email?: string; name?: string }): JSX.Element | null {
  const prefs = usePrefs()
  const personId = usePersonId(given, email)
  const [view] = usePersonView(personId)
  const othersOn = !!prefs?.['speakers.voices']
  const voicesOn = othersOn || !!prefs?.['speakers.selfVoice']

  // A derived person with no persisted row: only the explanation, while a voice row is on.
  if (personId === null || view === null) {
    if (!voicesOn || !name) return null
    return (
      <div className="nt-pv">
        <Card title={S.voiceSection()} state={<StateDot kind="off" label={S.off()} />}>
          <Row main={S.voiceNone(name)} sub={S.voiceStartsNextTime(name)} />
        </Card>
      </div>
    )
  }
  if (!view) return null

  if (view.person.isSelf) {
    return (
      <div className="nt-pv">
        <Card title={S.voiceSection()}>
          <Row
            main={S.voiceSelfDetail()}
            actions={
              <button type="button" className="n-btn n-btn--sm" onClick={() => navigateToSettings('speaker-tags')}>
                {S.voiceOpenSettings()}
              </button>
            }
          />
          <YourVoiceRows />
        </Card>
      </div>
    )
  }

  const hasVoice = view.voice.since !== null || view.voice.state === 'remembered' || view.voice.state === 'stale'
  const showVoice = voicesOn || hasVoice || !!view.agreement || view.pending.length > 0
  return (
    <div className="nt-pv">
      {showVoice ? <VoiceCard view={view} othersOn={othersOn} /> : null}
      <AgreementCard view={view} />
      <PersonCard view={view} />
    </div>
  )
}
