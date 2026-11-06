// SPDX-License-Identifier: Apache-2.0
// Dev-only check for the retention picker's label helper
// (src/renderer/src/features/retention/retention-label.ts): presets keep their labels, any other
// stored hour count becomes a custom entry in days or hours.
// Run: node scripts/dev/retention-label-check.ts   (Node's type stripping; exits 1 on a failure)

import { retentionLabel, type RetentionLabel } from '../../src/renderer/src/features/retention/retention-label.ts'
import { RETENTION_OPTIONS } from '../../src/shared/types/retention.ts'

const CASES: { name: string; hours: number | null; want: RetentionLabel }[] = [
  { name: '36 → custom, in hours', hours: 36, want: { label: '36 hours (custom)', period: '36 hours', custom: true } },
  { name: '48 → custom, in days', hours: 48, want: { label: '2 days (custom)', period: '2 days', custom: true } },
  { name: '24 → the one-day preset', hours: 24, want: { label: '1 day', period: '1 day', custom: false } },
  { name: 'null → off', hours: null, want: { label: 'Off', period: 'Off', custom: false } },
  { name: '1 → custom, one hour', hours: 1, want: { label: '1 hour (custom)', period: '1 hour', custom: true } },
  { name: '8760 → the one-year preset', hours: 8760, want: { label: '1 year', period: '1 year', custom: false } }
]

let failed = 0
for (const c of CASES) {
  const got = retentionLabel(c.hours, RETENTION_OPTIONS)
  const ok = got.label === c.want.label && got.period === c.want.period && got.custom === c.want.custom
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${c.name}${ok ? '' : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(c.want)}`}`)
}
console.log(failed ? `${failed} of ${CASES.length} failed` : `all ${CASES.length} passed`)
process.exit(failed ? 1 : 0)
