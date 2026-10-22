// SPDX-License-Identifier: Apache-2.0
// Local troubleshooting tools.
// Nothing here is ever uploaded.

export interface UnifiedLogStatus {
  supported: boolean
  running: boolean
  path: string | null
}

/**
 * The `log stream` filter for audio troubleshooting on macOS: privacy decisions about Notula, the
 * system audio and screen-capture daemons, and Notula's own processes without their network chatter.
 */
export const UNIFIED_LOG_PREDICATE =
  '(process == "tccd" AND eventMessage CONTAINS[c] "com.notula.app")' +
  ' OR process == "coreaudiod" OR process == "audiomxd" OR process == "replayd"' +
  ' OR (process BEGINSWITH "Notula" AND NOT subsystem BEGINSWITH "com.apple.network")'

export const TRACE_LIMITS = { durationMs: 10_000, zipLevel: 9 } as const

/** `<ts>`: an ISO time with `:` and `.` replaced by `-`. */
export const DIAG_FILE_NAMES = {
  trace: 'trace-<ts>.json',
  heap: 'heap-<ts>.heapsnapshot',
  traceZip: 'trace-<ts>.zip',
  unifiedLog: '<ts>-unified-log.log',
  logsZip: 'notula-logs-<ts>.zip'
} as const
