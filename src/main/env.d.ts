// SPDX-License-Identifier: Apache-2.0
// Build-time constants defined by electron.vite.config.ts for the main bundle.

/** `NOTULA_UPDATE_FEED_URL` at build time, or ''. The updater's feed; '' = no feed. */
declare const __NOTULA_UPDATE_FEED_URL__: string

/** `NOTULA_UPDATE_FEED_URL_BETA` at build time, or '': the beta channel's feed. */
declare const __NOTULA_UPDATE_FEED_URL_BETA__: string
/** `NOTULA_FEEDBACK_EMAIL` at build time, or '' (the feedback hand-off). */
declare const __NOTULA_FEEDBACK_EMAIL__: string
/** `NOTULA_ISSUES_URL` at build time, or '' (the feedback hand-off). */
declare const __NOTULA_ISSUES_URL__: string

/** Bundled text files (PowerShell helpers, the CLI), written to userData and hash-checked. */
declare module '*?raw' {
  const text: string
  export default text
}
