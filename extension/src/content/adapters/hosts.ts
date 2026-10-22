// SPDX-License-Identifier: Apache-2.0
// Member areas the generic reader knows by host: Hotmart, Kiwify and Memberkit. They host
// lessons in their own player or embed one from Vimeo, Panda Video or YouTube, often in a
// cross-origin iframe. The hosts and the player origins are unverified until measured.

export const MEMBER_AREAS: { name: string; host: RegExp }[] = [
  { name: 'hotmart', host: /(^|\.)hotmart\.com$|(^|\.)club\.hotmart\.com$/ },
  { name: 'kiwify', host: /(^|\.)kiwify\.com\.br$|(^|\.)kiwify\.com$/ },
  { name: 'memberkit', host: /(^|\.)memberkit\.com\.br$/ }
]

export function memberArea(hostname: string): string | null {
  return MEMBER_AREAS.find((m) => m.host.test(hostname))?.name ?? null
}
