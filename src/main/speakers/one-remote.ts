// SPDX-License-Identifier: Apache-2.0
// The one-remote rule of live attribution: in a call of the user and exactly one other person,
// that person is the system channel's speaker whenever no tile says otherwise. One instance per
// detector, reset when its reader starts or stops. Pure: attribution.ts feeds it each roster
// record and logs its reason.
//
// - Other people: named tiles, minus the user (a self tile, `profile.name`, Zoom's `ownName`),
//   folded by case. Every one seen since the reset is remembered.
// - Count: the last total a record stated; a record without one leaves it. Unknown is allowed,
//   a known count other than 2 is not.
// - The user must be known first: `profile.name` matched a roster name once, or the reader
//   named the user.
// - Settling: once a second other person has ever appeared, a candidate holds 15 s first. The
//   same name unseen for over 7 s, or a different one, restarts the clock.

import { ATTRIBUTION_LIMITS, type TranscriptChunk } from '@shared/types/transcript'

/** Why the rule gives no name: no other person, two or more, a count that isn't 2, the user not yet known, or a candidate still settling. */
export type OneRemoteReason = 'nobody' | 'several' | 'count' | 'self-unknown' | 'settling'

export interface OneRemoteRecord {
  participants: readonly { name: string | null; isSelf: boolean }[]
  /** The meeting's total as the app states it; undefined when the record gave none. */
  count?: number
  profileName: string
  /** Zoom's revealed self name. */
  ownName: string | null
  at: number
}

/** Case-insensitive, without a trailing "(You)" or "(Me)". */
export function normName(name: string | null | undefined): string {
  return (name ?? '').replace(/\s*\((you|me)\)\s*$/i, '').trim().toLowerCase()
}

/** A system chunk's one-remote name and count; null on timeline stamps and older chunks. */
export function oneRemoteOf(c: TranscriptChunk): { name: string; peopleCount: 2 | null } | null {
  const d = c.detectedSpeaker
  const name = c.source === 'system' && d?.via === 'one-remote' ? d.participantName?.trim() : ''
  return name ? { name, peopleCount: d?.peopleCount === 2 ? 2 : null } : null
}

export class OneRemoteRule {
  /** The last count a record stated; null while unknown. */
  count: number | null = null
  private seen = new Set<string>()
  private selfKnown = false
  private candidate: { key: string; name: string; since: number; lastAt: number } | null = null
  /** The accepted name, refreshed by every record that still accepts it. */
  accepted: { name: string; at: number } | null = null
  reason: OneRemoteReason | null = 'nobody'

  reset(): void {
    this.count = null
    this.seen.clear()
    this.selfKnown = false
    this.candidate = null
    this.accepted = null
    this.reason = 'nobody'
  }

  update(r: OneRemoteRecord): { name: string | null; reason: OneRemoteReason | null } {
    if (typeof r.count === 'number' && Number.isFinite(r.count)) this.count = r.count
    const me = normName(r.profileName)
    const own = normName(r.ownName)
    if (own) this.selfKnown = true
    const others = new Map<string, string>()
    for (const p of r.participants) {
      const name = p.name?.trim()
      if (!name) continue
      const key = normName(name)
      if (p.isSelf) {
        this.selfKnown = true
        continue
      }
      if (me && key === me) {
        this.selfKnown = true
        continue
      }
      if (!key || key === own) continue
      if (!others.has(key)) others.set(key, name)
    }
    for (const k of others.keys()) this.seen.add(k)

    const reason = this.check(others, r.at)
    this.reason = reason
    this.accepted = reason === null && this.candidate ? { name: this.candidate.name, at: r.at } : null
    return { name: this.accepted?.name ?? null, reason }
  }

  private check(others: Map<string, string>, at: number): OneRemoteReason | null {
    let reason: OneRemoteReason | null = null
    if (others.size === 0) reason = 'nobody'
    else if (others.size > 1) reason = 'several'
    else if (this.count !== null && this.count !== 2) reason = 'count'
    else if (!this.selfKnown) reason = 'self-unknown'
    if (reason) {
      this.candidate = null
      return reason
    }
    const [key, name] = [...others][0] as [string, string]
    const c = this.candidate
    if (!c || c.key !== key || at - c.lastAt > ATTRIBUTION_LIMITS.oneRemoteRestartMs) {
      this.candidate = { key, name, since: at, lastAt: at }
    } else c.lastAt = at
    const held = at - (this.candidate as { since: number }).since
    return this.seen.size > 1 && held < ATTRIBUTION_LIMITS.oneRemoteSettleMs ? 'settling' : null
  }
}
