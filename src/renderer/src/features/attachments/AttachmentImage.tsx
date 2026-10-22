// SPDX-License-Identifier: Apache-2.0
// `AttachmentImage` (shared with the people and meeting features): an encrypted attachment shown from
// memory. Loads through `attachments:read`; "Couldn’t load image" when the file is
// missing, unreadable or fails its integrity check.

import { useEffect, useState, type JSX } from 'react'
import { loadImage, type ImageResult } from './image-cache'

export const FAILED_TO_LOAD = 'Couldn’t load the image'

export function useAttachmentUrl(attachmentId: string): ImageResult | null {
  const [result, setResult] = useState<ImageResult | null>(null)
  useEffect(() => {
    let alive = true
    setResult(null)
    void loadImage(attachmentId).then((r) => {
      if (alive) setResult(r)
    })
    return () => {
      alive = false
    }
  }, [attachmentId])
  return result
}

export function AttachmentImage(p: { attachmentId: string; alt: string; className?: string }): JSX.Element {
  const result = useAttachmentUrl(p.attachmentId)
  const cls = `att-image${p.className ? ` ${p.className}` : ''}`
  if (result === null) return <span className={`${cls} att-image--loading`} role="img" aria-label={p.alt} aria-busy="true" />
  if (result.state === 'unavailable') {
    return (
      <span className={`${cls} att-image--failed`} role="img" aria-label={FAILED_TO_LOAD}>
        <span className="att-image__failed-text">{FAILED_TO_LOAD}</span>
      </span>
    )
  }
  return <img className={cls} src={result.url} alt={p.alt} draggable={false} />
}
