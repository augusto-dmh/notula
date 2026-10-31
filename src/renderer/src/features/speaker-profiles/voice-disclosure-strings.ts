// SPDX-License-Identifier: Apache-2.0
// What Recognize voices keeps, said where the user turns it on and reads about it. With it on,
// the note job compares every speaker's voice and keeps the unconfirmed ones up to 14 days, people
// who never agreed included; a voice is remembered for longer only with an agreement.
// Draft, for owner review (`style/COPY.md`, section 13). The participant notice says the same in
// `@shared/lib/speaker-notices`.

/** The last sentences of the notice card. */
export const VOICES_KEPT_NOTICE =
  'With Recognize voices on, Notula compares everyone’s voices in a meeting on this computer and keeps them up to 14 days to suggest names. It remembers a voice only when that person agrees.'

/** Settings ▸ Speaker tags ▸ Recognize voices (≤ 30 words, ≤ 170 characters). */
export const VOICES_KEPT_SETTINGS =
  'Notula compares everyone’s voices in a meeting on this computer and keeps them up to 14 days to suggest names. It remembers a voice only when that person agrees.'
