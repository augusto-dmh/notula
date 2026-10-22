// SPDX-License-Identifier: Apache-2.0
// Note images from a drop or a paste. Dropped and
// picked files go to main as paths (`files.pathForFile`); pasted images, which have no
// path, as their bytes. Main checks, resizes, encrypts and stores them; this module keeps
// the in-flight placeholders and shows the upload toasts.

import { useSyncExternalStore } from 'react'
import { parseError } from '@shared/errors'
import type { AttachmentInput, AttachmentRejection } from '@shared/types/attachments'
import { debugLog } from '../../app/platform'
import { showToast } from '../../app/toast'

export interface PendingImage {
  key: string
  noteId: string
  name: string
  /** A `data:` preview of the local file. */
  preview: string | null
}

const listeners = new Set<() => void>()
let pending: readonly PendingImage[] = []

function emit(): void {
  for (const l of listeners) l()
}

function setPending(next: readonly PendingImage[]): void {
  pending = next
  emit()
}

export function usePendingImages(noteId: string): readonly PendingImage[] {
  const all = useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => pending
  )
  return all.filter((p) => p.noteId === noteId)
}

function preview(file: File): Promise<string | null> {
  return new Promise((resolve) => {
    if (file.size > 12 * 1024 * 1024) return resolve(null)
    const reader = new FileReader()
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null)
    reader.onerror = () => resolve(null)
    reader.readAsDataURL(file)
  })
}

export function isImageFile(f: File): boolean {
  return f.type === 'image/png' || f.type === 'image/jpeg' || /\.(png|jpe?g)$/i.test(f.name)
}

async function inputFor(file: File): Promise<AttachmentInput> {
  let path = ''
  try {
    path = window.notula.files.pathForFile(file)
  } catch {
    path = ''
  }
  if (path) return { path }
  return { name: file.name || 'Pasted image', mimeType: file.type || 'image/png', bytes: new Uint8Array(await file.arrayBuffer()) }
}

/** One toast per distinct message: the image limit, the type rule, or the size rules. */
function showRejections(rejected: AttachmentRejection[]): void {
  const seen = new Set<string>()
  for (const r of rejected) {
    if (seen.has(r.message)) continue
    seen.add(r.message)
    if (r.message === 'Unsupported file type') {
      showToast({ id: 'att-unsupported', kind: 'error', title: 'Unsupported file type', description: 'Use PNG or JPEG images' })
    } else if (r.message === 'Maximum of 10 attachments reached') {
      showToast({ id: 'att-max', kind: 'error', title: r.message })
    } else {
      showToast({ id: `att-${seen.size}`, kind: 'error', title: r.message })
    }
  }
}

/** Adds dropped or pasted images to a note: placeholders at once, then the stored list. */
export async function addNoteImages(noteId: string, files: File[], imagesBefore: number): Promise<void> {
  if (files.length === 0) return
  const images = files.filter((f) => isImageFile(f))
  const keys: string[] = images.map(() => crypto.randomUUID())
  setPending([...pending, ...images.map((f, i) => ({ key: keys[i] as string, noteId, name: f.name, preview: null }))])
  void Promise.all(images.map(preview)).then((previews) => {
    setPending(pending.map((p) => (keys.includes(p.key) ? { ...p, preview: previews[keys.indexOf(p.key)] ?? null } : p)))
  })
  try {
    const inputs = await Promise.all(files.map(inputFor))
    const result = await window.notula.attachments.addImages({ noteId, files: inputs })
    const added = result.attachments.length - imagesBefore
    if (result.rejected.length) showRejections(result.rejected)
    if (added > 0) showToast({ id: 'att-added', kind: 'success', title: 'File attached to note' })
  } catch (err) {
    debugLog('attachments-add-failed', { err: parseError(err) })
    showToast({ id: 'att-failed', kind: 'error', title: 'Couldn’t add the image. Try again.' })
  } finally {
    setPending(pending.filter((p) => !keys.includes(p.key)))
  }
}
