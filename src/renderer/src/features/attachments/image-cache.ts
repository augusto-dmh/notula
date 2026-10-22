// SPDX-License-Identifier: Apache-2.0
// Decrypted attachment images, held in memory only: bytes come
// from `attachments:read` and become `data:` URLs (the page's CSP allows `data:` images,
// not `blob:`), kept in a small LRU so a strip and its viewer do not read the same image
// twice. Nothing is written anywhere.

export type ImageResult = { state: 'ok'; url: string } | { state: 'unavailable' }

type Entry = { state: 'loading'; promise: Promise<ImageResult> } | ImageResult

const MAX_CACHED = 24
const cache = new Map<string, Entry>()

function touch(id: string, e: Entry): void {
  cache.delete(id)
  cache.set(id, e)
  while (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value as string)
}

/**
 * A `data:` URL built straight from the bytes, never through a Blob: Chromium may page
 * large Blobs to `blob_storage` on disk, and these are decrypted images.
 */
function dataUrl(bytes: Uint8Array, mimeType: string): string {
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  return `data:${mimeType};base64,${btoa(binary)}`
}

/** The image as a `data:` URL, read and decrypted once. */
export function loadImage(id: string): Promise<ImageResult> {
  const hit = cache.get(id)
  if (hit) {
    touch(id, hit)
    return hit.state === 'loading' ? hit.promise : Promise.resolve(hit)
  }
  const promise = window.notula.attachments
    .read({ attachmentId: id })
    .then((r): ImageResult => {
      if (r.status !== 'ok' || (r.mimeType !== 'image/png' && r.mimeType !== 'image/jpeg')) return { state: 'unavailable' }
      return { state: 'ok', url: dataUrl(new Uint8Array(r.bytes), r.mimeType) }
    })
    .catch((): ImageResult => ({ state: 'unavailable' }))
    .then((result) => {
      if (cache.get(id)?.state === 'loading') touch(id, result)
      return result
    })
  touch(id, { state: 'loading', promise })
  return promise
}

/** Forgets an image (after a remove). */
export function forgetImage(id: string): void {
  cache.delete(id)
}
