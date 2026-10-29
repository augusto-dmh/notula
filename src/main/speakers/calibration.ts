// SPDX-License-Identifier: Apache-2.0
// The calibration file: `resources/speakers/calibration.json`, loaded
// once at start. Voice gives no auto name and no suggestion while it is missing, invalid, or
// keyed to another extractor than the installed one (`modelSha` ≠ the `speaker-id` SHA).
// A condition missing from the file means no voice auto and the default suggest rule.

import { readFileSync } from 'node:fs'
import type {
  SpeakerCalibration,
  SpeakerCalibrationCondition,
  SpeakerChannel,
  SpeakerFusionSignal
} from '@shared/types/speakers'
import { speakerIdModelId } from '../asr/manifest'
import type { MainContext } from '../context'
import { resourcePath } from '../lifecycle/resources'
import { log } from '../log'

export type SpeakerCalibrationState =
  | { voice: true; file: SpeakerCalibration }
  | { voice: false; reason: 'missing' | 'invalid' | 'mismatch' | 'not-loaded'; file: SpeakerCalibration | null }

/** A condition as the file may hold it: `floor` (the unknown option's P) is an optional addition. */
export type SpeakerCalibrationConditionFile = SpeakerCalibrationCondition & { floor?: number }

const CHANNELS: readonly string[] = ['mic', 'system']
const LANGUAGES: readonly string[] = ['pt', 'en', 'other']
const BUCKETS: readonly string[] = ['<10s', '10-30s', '>=30s']
const SIGNALS: readonly SpeakerFusionSignal[] = ['voice', 'app', 'conversation', 'elimination']

let loaded: { file: SpeakerCalibration } | { file: null; reason: 'missing' | 'invalid' } | null = null

/** The loaded calibration. Synchronous: the file is read once, on the first call. */
export function getCalibration(ctx: MainContext): SpeakerCalibrationState {
  void ctx
  if (!loaded) {
    loaded = load()
    if (!loaded.file) log('warn', 'speakers:calibration', { state: loaded.reason })
  }
  if (!loaded.file) return { voice: false, reason: loaded.reason, file: null }
  return calibrationState(loaded.file, speakerIdModelId())
}

/** The state of a parsed file against the installed extractor's id (also for the bench). */
export function calibrationState(file: SpeakerCalibration, installedModelId: string): SpeakerCalibrationState {
  if (file.modelSha !== installedModelId) return { voice: false, reason: 'mismatch', file }
  return { voice: true, file }
}

function load(): { file: SpeakerCalibration } | { file: null; reason: 'missing' | 'invalid' } {
  let text: string
  try {
    text = readFileSync(resourcePath('speakers/calibration.json'), 'utf8')
  } catch {
    return { file: null, reason: 'missing' }
  }
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return { file: null, reason: 'invalid' }
  }
  const file = parseCalibration(json)
  return file ? { file } : { file: null, reason: 'invalid' }
}

/** Validates the file's shape; null when anything the decision reads is missing or out of range. */
export function parseCalibration(json: unknown): SpeakerCalibration | null {
  if (!isRecord(json)) return null
  const { modelSha, reportHash, createdAt, benchVersion, conditions, farCosine, fusion } = json
  if (typeof modelSha !== 'string' || !/^[0-9a-f]{64}$/.test(modelSha)) return null
  if (reportHash !== null && typeof reportHash !== 'string') return null
  if (typeof createdAt !== 'string' || typeof benchVersion !== 'number') return null
  if (!Array.isArray(conditions) || !conditions.every(isCondition)) return null
  if (!isRecord(farCosine) || !CHANNELS.every((c) => isUnit(farCosine[c]))) return null
  if (!isRecord(fusion)) return null
  for (const s of SIGNALS) {
    const f = fusion[s]
    if (!isRecord(f) || !isFiniteNumber(f.weight) || !isFiniteNumber(f.offset)) return null
  }
  return {
    modelSha,
    reportHash,
    createdAt,
    benchVersion,
    conditions: conditions as SpeakerCalibrationConditionFile[],
    farCosine: farCosine as Record<SpeakerChannel, number>,
    fusion: fusion as SpeakerCalibration['fusion']
  }
}

function isCondition(c: unknown): boolean {
  if (!isRecord(c)) return false
  if (typeof c.channel !== 'string' || !CHANNELS.includes(c.channel)) return false
  if (typeof c.language !== 'string' || !LANGUAGES.includes(c.language)) return false
  if (typeof c.bucket !== 'string' || !BUCKETS.includes(c.bucket)) return false
  if (typeof c.autoEnabled !== 'boolean') return false
  if (!isUnit(c.tauAuto) || !isUnit(c.tauSuggest) || !isUnit(c.margin) || !isUnit(c.tieMargin)) return false
  if (!isRecord(c.logistic) || !isFiniteNumber(c.logistic.a) || !isFiniteNumber(c.logistic.b)) return false
  if (c.floor !== undefined && !isUnit(c.floor)) return false
  return true
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}

function isFiniteNumber(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x)
}

function isUnit(x: unknown): x is number {
  return isFiniteNumber(x) && x >= 0 && x <= 1
}
