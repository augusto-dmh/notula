// SPDX-License-Identifier: Apache-2.0
// The display-media and media-permission handlers. Both answer the app's own windows
// whether or not capture is active: the onboarding system-audio probe uses them too.
//
// System audio is requested by the renderer as display media. Main answers with
// Electron's loopback audio:
// - Windows: plain `loopback` (no all-devices variant).
// - macOS: `loopback`, plus the first screen source when video was requested.
// When the renderer had to request video to get audio (the video fallback), the first
// screen source is supplied and the renderer stops the video track at once.

import { desktopCapturer, session, systemPreferences, type Session, type WebContents } from 'electron'
import { log } from '../log'

type MediaPermission = Parameters<Parameters<Session['setPermissionRequestHandler']>[0] & object>[1]

/** Permissions the app's own pages may use. Everything else is refused. */
const ALLOWED: ReadonlySet<MediaPermission> = new Set<MediaPermission>([
  'media',
  'display-capture',
  'speaker-selection',
  'clipboard-sanitized-write',
  'clipboard-read',
  'fullscreen',
  'notifications',
  'window-management'
])

function isAppOrigin(url: string): boolean {
  if (url.startsWith('file://')) return true
  const dev = process.env['ELECTRON_RENDERER_URL']
  if (!dev) return false
  try {
    return new URL(url).origin === new URL(dev).origin
  } catch {
    return false
  }
}

function fromAppWindow(wc: WebContents | null, origin: string): boolean {
  if (!wc || wc.isDestroyed()) return isAppOrigin(origin)
  return isAppOrigin(wc.getURL() || origin)
}

async function firstScreenSource(): Promise<Electron.DesktopCapturerSource | null> {
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
  return sources[0] ?? null
}

export function installMediaHandlers(): void {
  const ses = session.defaultSession

  ses.setDisplayMediaRequestHandler((request, callback) => {
    const origin = request.securityOrigin
    if (!isAppOrigin(origin) && !(request.frame && isAppOrigin(request.frame.url))) {
      log('warn', 'capture:display-media-refused', { origin })
      callback(null)
      return
    }
    log('info', 'capture:display-media-request', {
      platform: process.platform,
      audio: request.audioRequested,
      video: request.videoRequested
    })
    if (!request.videoRequested) {
      callback(request.audioRequested ? { audio: 'loopback' } : null)
      return
    }
    // Video was requested (the video fallback, or macOS before 14): a screen source
    // plus loopback. The renderer stops the video track immediately.
    void firstScreenSource()
      .then((video) => {
        if (!video) {
          log('error', 'capture:display-media-no-screen-source')
          callback(null)
          return
        }
        callback(request.audioRequested ? { video, audio: 'loopback' } : { video })
      })
      .catch((err: unknown) => {
        log('error', 'capture:display-media-failed', { err })
        callback(null)
      })
  })

  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    if (!ALLOWED.has(permission) || !fromAppWindow(wc, details.requestingUrl)) {
      log('warn', 'capture:permission-refused', { permission })
      callback(false)
      return
    }
    if (permission !== 'media') {
      callback(true)
      return
    }
    const types = 'mediaTypes' in details ? (details.mediaTypes ?? []) : []
    if (types.includes('video')) {
      // Notula never captures a camera.
      log('warn', 'capture:permission-refused', { permission, mediaTypes: types })
      callback(false)
      return
    }
    // The microphone goes through the OS media-access prompt, which only exists on
    // macOS. Elsewhere the OS decides at capture time.
    if (process.platform === 'darwin' && systemPreferences.getMediaAccessStatus('microphone') !== 'granted') {
      void systemPreferences
        .askForMediaAccess('microphone')
        .then((granted) => callback(granted))
        .catch((err: unknown) => {
          log('error', 'capture:mic-access-prompt-failed', { err })
          callback(false)
        })
      return
    }
    callback(true)
  })

  ses.setPermissionCheckHandler((wc, permission, requestingOrigin) => {
    return ALLOWED.has(permission) && fromAppWindow(wc, requestingOrigin)
  })
}
