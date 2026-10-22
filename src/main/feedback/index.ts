// SPDX-License-Identifier: Apache-2.0
// Feedback reports and the `feedback:*` IPC.
//
// Notula has no backend, so nothing here uploads anything. The user sends the report
// themselves:
// - `feedback:open` builds a `mailto:` link (body capped at 1,800 characters) or a
//   new-issue URL (under 6,000 characters) and hands it to the system. Each needs its build
//   constant (both empty by default) and is a `handoff`, so it is refused while
//   "Nothing leaves this machine" is on.
// - `feedback:save-report` writes a zip (fflate, like the logs zip) with `report.txt`, the attachments and,
//   only when asked, the already-redacted logs, then reveals it.
// The renderer never builds an external URL itself.

import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { zipSync, type Zippable } from 'fflate'
import { notulaError } from '@shared/errors'
import type { InvokeChannel, InvokeReq, InvokeRes } from '@shared/ipc'
import { FEEDBACK_CATEGORIES, FEEDBACK_LIMITS, type FeedbackMode, type FeedbackOpenInput, type FeedbackReportInput, type FeedbackSystemInfo } from '@shared/types/feedback'
import type { MainContext } from '../context'
import { osName } from '../device-info'
import { expected } from '../ipc-expected'
import { log } from '../log'
import { egressBlocked } from '../privacy'

const FEEDBACK_EMAIL = __NOTULA_FEEDBACK_EMAIL__
const ISSUES_URL = __NOTULA_ISSUES_URL__

const MESSAGE_MAX = 20_000
const ATTACHMENTS_MAX = 20
const SHORTENED_NOTE = '(message shortened; use Save report for the full text)'
const MODE_LABEL: Record<FeedbackMode, string> = { bug: 'Bug', question: 'Question', feature: 'Feature' }
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif'])
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi', '.wmv', '.mpg', '.mpeg', '.ogv', '.3gp'])

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

function bad(message: string): Error {
  return expected(notulaError('invalid-input', message))
}

export function systemInfo(): FeedbackSystemInfo {
  return {
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron,
    os: `${osName()} ${process.getSystemVersion()}`,
    arch: process.arch,
    emailAvailable: FEEDBACK_EMAIL !== '',
    issuesAvailable: /^https?:\/\//i.test(ISSUES_URL)
  }
}

interface ReportFields {
  mode: FeedbackMode
  category: string | null
  message: string
  includeSystemInfo: boolean
}

function fields(v: unknown): ReportFields {
  if (!isObject(v)) throw bad('request must be an object.')
  const mode = v['mode']
  if (mode !== 'bug' && mode !== 'question' && mode !== 'feature') throw bad('mode is invalid.')
  const category = v['category'] ?? null
  if (category !== null && !(FEEDBACK_CATEGORIES as readonly unknown[]).includes(category)) throw bad('category is invalid.')
  if (mode === 'feature' && category === null) throw bad('Choose a feature category')
  const message = typeof v['message'] === 'string' ? v['message'].trim() : ''
  if (!message) throw bad('Add a message')
  if (message.length > MESSAGE_MAX) throw bad('The message is too long.')
  return { mode, category: category as string | null, message, includeSystemInfo: v['includeSystemInfo'] !== false }
}

/** "[Notula] Bug: Notes". */
export function subjectOf(f: ReportFields): string {
  return `[Notula] ${MODE_LABEL[f.mode]}${f.category ? `: ${f.category}` : ''}`
}

function systemLines(): string[] {
  const s = systemInfo()
  return [`Notula ${s.appVersion}`, `Electron ${s.electronVersion}`, `${s.os} (${s.arch})`]
}

/** The text every way out shares: the message, then the system info when ticked. */
export function bodyOf(f: ReportFields): string {
  const parts = [f.message]
  if (f.includeSystemInfo) parts.push(['---', ...systemLines()].join('\n'))
  return parts.join('\n\n')
}

/** `report.txt` in the zip. */
export function reportText(f: ReportFields, attachments: string[], logs: string[]): string {
  const lines = [
    'Notula feedback report',
    '',
    `Type: ${MODE_LABEL[f.mode]}`,
    `Category: ${f.category ?? '(none)'}`,
    `Created: ${new Date().toISOString()}`,
    '',
    f.message,
    ''
  ]
  if (f.includeSystemInfo) lines.push('System', ...systemLines().map((l) => `- ${l}`), '')
  if (attachments.length > 0) lines.push('Attachments', ...attachments.map((a) => `- attachments/${a}`), '')
  if (logs.length > 0) lines.push('Logs (redacted)', ...logs.map((l) => `- logs/${l}`), '')
  return lines.join('\n')
}

/** Cuts `text` at a line end so that `fits(result)` holds, adding the shortened note. */
export function shorten(text: string, fits: (t: string) => boolean): { text: string; shortened: boolean } {
  if (fits(text)) return { text, shortened: false }
  const lines = text.split('\n')
  while (lines.length > 1) {
    lines.pop()
    const candidate = `${lines.join('\n').trimEnd()}\n\n${SHORTENED_NOTE}`
    if (fits(candidate)) return { text: candidate, shortened: true }
  }
  // One long line: cut by characters, then at a word.
  let cut = lines[0] ?? ''
  while (cut.length > 0) {
    cut = cut.slice(0, Math.floor(cut.length * 0.9))
    const at = cut.lastIndexOf(' ')
    const candidate = `${(at > 0 ? cut.slice(0, at) : cut).trimEnd()}…\n\n${SHORTENED_NOTE}`
    if (fits(candidate)) return { text: candidate, shortened: true }
  }
  return { text: SHORTENED_NOTE, shortened: true }
}

export function mailtoUrl(f: ReportFields, address: string): { url: string; shortened: boolean } {
  const body = shorten(bodyOf(f), (t) => t.length <= FEEDBACK_LIMITS.mailtoBodyMax)
  const url = `mailto:${encodeURIComponent(address).replace(/%40/g, '@')}?subject=${encodeURIComponent(subjectOf(f))}&body=${encodeURIComponent(body.text)}`
  return { url, shortened: body.shortened }
}

export function issueUrl(f: ReportFields, base: string): { url: string; shortened: boolean } {
  const title = subjectOf(f).replace(/^\[Notula\] /, '')
  const join = base.includes('?') ? '&' : '?'
  const build = (body: string): string => `${base}${join}title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`
  const body = shorten(bodyOf(f), (t) => build(t).length < FEEDBACK_LIMITS.issueUrlMax)
  return { url: build(body.text), shortened: body.shortened }
}

// ---------- attachments and the zip ----------

interface Attachment {
  path: string
  name: string
  bytes: number
  video: boolean
}

/** Checks feedback attachments: images or videos only, within the per-file and total size limits. */
export async function checkAttachments(paths: unknown): Promise<Attachment[]> {
  if (!Array.isArray(paths)) throw bad('attachmentPaths must be a list.')
  if (paths.length > ATTACHMENTS_MAX) throw bad(`Attach at most ${ATTACHMENTS_MAX} files.`)
  const out: Attachment[] = []
  const wrongType: string[] = []
  const tooBig: string[] = []
  for (const p of paths) {
    if (typeof p !== 'string' || !p) throw bad('An attachment path is invalid.')
    const name = basename(p)
    const ext = extname(p).toLowerCase()
    const video = VIDEO_EXTENSIONS.has(ext)
    if (!video && !IMAGE_EXTENSIONS.has(ext)) {
      wrongType.push(name)
      continue
    }
    let bytes: number
    try {
      const s = await stat(p)
      if (!s.isFile()) throw new Error('not a file')
      bytes = s.size
    } catch {
      throw bad(`${name} can't be read.`)
    }
    if (bytes > FEEDBACK_LIMITS.fileMaxBytes) tooBig.push(name)
    out.push({ path: p, name, bytes, video })
  }
  if (wrongType.length > 0) throw bad(`Only images and videos can be attached. Remove ${wrongType.join(', ')} and try again.`)
  if (tooBig.length > 0) throw bad(`Files must be 20 MB or smaller: ${tooBig.join(', ')}`)
  const total = out.reduce((n, a) => n + a.bytes, 0)
  if (total > FEEDBACK_LIMITS.totalMaxBytes) throw bad('Attachments must be 40 MB or smaller in total.')
  return out
}

const AUTH_FIELD = /("?(?:authorization|x-api-key|api[_-]?key|token)"?\s*[:=]\s*"?)(?!\[redacted\])([^"\s,}]{6,})/gi
const AUTH_SCHEME = /\b(Bearer|Token|Basic)\s+(?!\[redacted\])[A-Za-z0-9._~+/=-]{12,}/g

/** The app's log files. The logger already redacts; auth-looking values are scrubbed again here. */
async function logFiles(ctx: MainContext): Promise<{ name: string; text: string }[]> {
  const dir = join(ctx.userDataPath, 'logs')
  let names: string[]
  try {
    names = (await readdir(dir, { withFileTypes: true })).filter((e) => e.isFile()).map((e) => e.name)
  } catch {
    return []
  }
  const out: { name: string; text: string }[] = []
  for (const name of names.sort()) {
    try {
      const text = await readFile(join(dir, name), 'utf8')
      out.push({ name, text: text.replace(AUTH_FIELD, '$1[redacted]').replace(AUTH_SCHEME, '$1 [redacted]') })
    } catch {
      // Rotated away meanwhile.
    }
  }
  return out
}

/** A name unique in the zip folder: "a.png", "a (2).png". */
function uniqueName(name: string, taken: Set<string>): string {
  const ext = extname(name)
  const stem = name.slice(0, name.length - ext.length)
  let candidate = name
  for (let i = 2; taken.has(candidate.toLowerCase()); i++) candidate = `${stem} (${i})${ext}`
  taken.add(candidate.toLowerCase())
  return candidate
}

export async function buildReportZip(ctx: MainContext, input: FeedbackReportInput): Promise<Uint8Array> {
  const f = fields(input)
  const attachments = await checkAttachments(input.attachmentPaths ?? [])
  const files: Zippable = {}
  const taken = new Set<string>()
  const attachmentNames: string[] = []
  for (const a of attachments) {
    const name = uniqueName(a.name, taken)
    attachmentNames.push(name)
    // Images and videos are already compressed.
    files[`attachments/${name}`] = [new Uint8Array(await readFile(a.path)), { level: 0 }]
  }
  const logs = input.includeLogs === true ? await logFiles(ctx) : []
  for (const l of logs) files[`logs/${l.name}`] = new TextEncoder().encode(l.text)
  files['report.txt'] = new TextEncoder().encode(
    reportText(
      f,
      attachmentNames,
      logs.map((l) => l.name)
    )
  )
  return zipSync(files, { level: 6 })
}

function stamp(at = new Date()): string {
  return at.toISOString().replace(/[:.]/g, '-')
}

// ---------- handlers ----------

export function registerFeedback(ctx: MainContext): void {
  ipcMain.handle('feedback:system-info' satisfies InvokeChannel, (): InvokeRes<'feedback:system-info'> => systemInfo())

  ipcMain.handle(
    'feedback:save-report' satisfies InvokeChannel,
    async (e, req: InvokeReq<'feedback:save-report'>): Promise<InvokeRes<'feedback:save-report'>> => {
      if (!isObject(req)) throw bad('request must be an object.')
      fields(req)
      await checkAttachments(req.attachmentPaths ?? [])
      const options: Electron.SaveDialogOptions = {
        title: 'Save feedback report',
        buttonLabel: 'Save',
        defaultPath: join(app.getPath('downloads'), `notula-feedback-${stamp()}.zip`),
        filters: [{ name: 'Zip archive', extensions: ['zip'] }]
      }
      // Dev builds only: NOTULA_DEV_DIALOG_DIR answers the save dialog, for scripted checks.
      const devDir = ctx.isDev ? process.env['NOTULA_DEV_DIALOG_DIR'] : undefined
      const owner = BrowserWindow.fromWebContents(e.sender) ?? ctx.windows.main()
      const res = devDir
        ? { canceled: false, filePath: join(devDir, basename(options.defaultPath ?? 'notula-feedback.zip')) }
        : owner
          ? await dialog.showSaveDialog(owner, options)
          : await dialog.showSaveDialog(options)
      if (res.canceled || !res.filePath) return { saved: false, path: null }
      try {
        const bytes = await buildReportZip(ctx, req)
        await writeFile(res.filePath, bytes)
        log('info', 'feedback:report-saved', { bytes: bytes.byteLength, logs: req.includeLogs === true, attachments: req.attachmentPaths.length })
      } catch (err) {
        log('error', 'feedback:report-failed', { err })
        throw notulaError('internal', 'Couldn’t save the report')
      }
      if (devDir) log('debug', 'feedback:reveal-skipped', { path: res.filePath })
      else shell.showItemInFolder(res.filePath)
      return { saved: true, path: res.filePath }
    }
  )

  ipcMain.handle('feedback:open' satisfies InvokeChannel, async (_e, req: InvokeReq<'feedback:open'>): Promise<InvokeRes<'feedback:open'>> => {
    if (!isObject(req)) throw bad('request must be an object.')
    const target = (req as FeedbackOpenInput).target
    if (target !== 'email' && target !== 'issue') throw bad('target is invalid.')
    const f = fields(req)
    const configured = target === 'email' ? FEEDBACK_EMAIL !== '' : systemInfo().issuesAvailable
    if (!configured) return { opened: false, shortened: false, reason: 'not-configured' }
    if (await egressBlocked(ctx, { kind: 'handoff' })) return { opened: false, shortened: false, reason: 'local-only' }
    const built = target === 'email' ? mailtoUrl(f, FEEDBACK_EMAIL) : issueUrl(f, ISSUES_URL)
    await shell.openExternal(built.url)
    log('debug', 'feedback:opened', { target, shortened: built.shortened })
    return { opened: true, shortened: built.shortened, reason: null }
  })
}
