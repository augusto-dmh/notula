// SPDX-License-Identifier: Apache-2.0
// The report: aggregates only — counts, rates and bounds by
// condition, signal set and scope, the gate, the model comparison, FAR, DER, CPU, T2, T3 and the
// A1–A16 checks. No name, no person id, no per-cluster row, no vector.

import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

function cell(v) {
  if (v === null || v === undefined) return '—'
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(4)
  if (typeof v === 'boolean') return v ? 'yes' : 'no'
  return String(v)
}

function table(head, rows) {
  if (!rows.length) return '_none_\n'
  return [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`)].join('\n') + '\n'
}

export function renderMarkdown(r) {
  const out = []
  out.push(`# Speaker bench report ${r.runId}${r.dry ? ' (dry run, synthetic tones)' : ''}`, '')
  out.push(`Bench version ${r.benchVersion}. Created ${r.createdAt}. Extractor ${r.modelId ? r.modelId.slice(0, 12) + '…' : 'not installed'}. ASR ${r.asrReady ? 'installed' : 'not installed'}.`, '')
  if (r.notes.length) out.push(...r.notes.map((n) => `- ${n}`), '')
  out.push('## Data', '')
  out.push(table(['', 'value'], Object.entries(r.data)))
  out.push('## The gate (voice auto, `≥30s` only, real clusters, attendee-filtered)', '')
  out.push(
    table(
      ['condition', 'auto-named', 'wrong', 'CP upper', 'bootstrap p95', 'people', 'coverage', 'passes'],
      Object.entries(r.gate).map(([k, g]) => [k, g.autoClusters, g.wrongNames, g.clopperPearsonUpper, g.bootstrapP95, g.people, g.coverage, g.pass])
    )
  )
  out.push('## Overall, by signal set and scope', '')
  out.push(
    table(
      ['variant', 'clusters', 'auto', 'correct', 'wrong', 'outsider named', 'coverage', 'suggest precision', 'missed', 'correct unknown'],
      Object.entries(r.overall).map(([k, t]) => [k, t.clusters, t.auto, t.correct, t.wrong, t.outsider, t.coverage, t.suggestPrecision, t.missed, t.correctUnknown])
    )
  )
  out.push('## By condition (fused and voice, attendee-filtered)', '')
  const condRows = []
  for (const [k, c] of Object.entries(r.byCondition)) {
    for (const v of ['fused:attendees', 'voice:attendees', 'voice:everyone']) {
      const t = c.variants[v]
      if (t) condRows.push([k, v, t.clusters, t.auto, t.wrong, t.coverage, t.suggestPrecision])
    }
  }
  out.push(table(['condition', 'variant', 'clusters', 'auto', 'wrong', 'coverage', 'suggest precision'], condRows))
  out.push('## Verification (FAR at FRR 5 %)', '')
  out.push(table(['channel', 'genuine', 'impostor', 'FAR', 'threshold'], Object.entries(r.verification).map(([k, v]) => [k, v.genuine, v.impostor, v.farAtFrr5, v.threshold])))
  out.push('## DER (frame level, word-timed hypotheses)', '')
  out.push(table(['channel', 'meetings', 'reference s', 'DER'], Object.entries(r.der).map(([k, v]) => [k, v.meetings, v.refSeconds, v.der])))
  out.push('## CPU', '')
  out.push(table(['', 'value'], [['audio hours', r.cpu.audioHours], ['passes', r.cpu.passes], ['pass wall s per audio hour', r.cpu.passWallSecondsPerAudioHour], ...Object.entries(r.cpu.cpuSecondsPerAudioHour).map(([k, v]) => [`CPU s per audio hour: ${k}`, v])]))
  out.push('## Platform replay (T2, the app rule; does not gate voice)', '')
  out.push(table(['variant', 'replays', 'system clusters', 'app auto', 'precision', 'coverage'], Object.entries(r.t2).map(([k, v]) => [k, v.replays, v.systemClusters, v.appAuto, v.precision, v.coverage])))
  out.push('## Stress (T3, composed; never counts toward the gate)', '')
  out.push(table(['variant', 'set', 'clusters', 'auto', 'wrong', 'coverage'], Object.entries(r.t3).flatMap(([k, v]) => Object.entries(v).map(([s, t]) => [k, s, t.clusters, t.auto, t.wrong, t.coverage]))))
  if (r.t3Skipped) out.push(`Skipped: ${r.t3Skipped}`, '')
  out.push('## Model comparison', '')
  if (r.models.skipped) out.push(`Skipped: ${r.models.skipped}`, '')
  else {
    out.push(table(['model', 'proxies', 'tests', 'gated coverage', 'FAR mic', 'FAR system'], r.models.results.map((m) => [m.id, m.proxies, m.tests, m.gatedCoverage, m.channels?.mic?.farAtFrr5, m.channels?.system?.farAtFrr5])))
    out.push(`Winner: ${r.models.winner ?? '—'} (${r.models.note})`, '')
  }
  out.push('## Calibration', '')
  out.push(table(['', 'value'], Object.entries(r.calibration)))
  out.push('## Acceptance invariants', '')
  out.push(table(['check', 'status', 'detail'], r.checks.map((c) => [c.id, c.status, JSON.stringify(c.detail)])))
  if (r.errors.length) out.push('## Errors', '', ...r.errors.map((e) => `- ${e}`), '')
  return out.join('\n')
}

/** Writes `<dir>/<runId>.json` and `.md`; returns the JSON's SHA-256 (the calibration's `reportHash`). */
export function writeReport(dir, report) {
  mkdirSync(dir, { recursive: true })
  const json = JSON.stringify(report, null, 1)
  writeFileSync(join(dir, `${report.runId}.json`), json)
  writeFileSync(join(dir, `${report.runId}.md`), renderMarkdown(report))
  return createHash('sha256').update(json).digest('hex')
}
