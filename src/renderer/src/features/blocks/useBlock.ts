// SPDX-License-Identifier: Apache-2.0
// The draft-block cards' store: read a block, keep it
// fresh on `blocks:changed`, autosave edits after 750 ms (flushed before any action), and execute
// with `expectedUpdatedAt`. A stale write reloads the block and says so.

import { useCallback, useEffect, useRef, useState } from 'react'
import { parseError } from '@shared/errors'
import { BLOCK_LIMITS, type BlockExecuteOptions, type WorkflowBlock, type WorkflowBlockType } from '@shared/types/workflow-blocks'
import { showToast } from '../../app/toast'

export const STALE_COPY = 'This draft changed. Review it and try again.'

export interface BlockHandle<T> {
  block: WorkflowBlock | null
  /** The content as edited (ahead of the stored copy while a save is pending). */
  content: T | null
  error: string | null
  edit(next: T): void
  flush(): Promise<WorkflowBlock | null>
  execute(options?: BlockExecuteOptions): Promise<{ block: WorkflowBlock; failure: { errorCode: string; error: string } | null } | null>
  dismiss(): Promise<void>
  busy: boolean
}

/** The block id a tool call's result names. */
export function blockIdOf(result: unknown): string | null {
  const id = result && typeof result === 'object' ? (result as { blockId?: unknown }).blockId : null
  return typeof id === 'string' && id ? id : null
}

export function useBlock<T>(blockId: string | null, type: WorkflowBlockType, saveErrorCopy: string): BlockHandle<T> {
  const [block, setBlock] = useState<WorkflowBlock | null>(null)
  const [content, setContent] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const pending = useRef<T | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latest = useRef<WorkflowBlock | null>(null)
  latest.current = block

  const load = useCallback(async (): Promise<WorkflowBlock | null> => {
    if (!blockId) return null
    try {
      const b = await window.notula.blocks.get({ blockId })
      setBlock(b)
      if (!pending.current) setContent(b.content as T)
      setError(null)
      return b
    } catch (err) {
      setError(parseError(err).message)
      return null
    }
  }, [blockId])

  useEffect(() => {
    void load()
  }, [load])
  useEffect(
    () =>
      window.notula.blocks.onChanged((e) => {
        if (e.blockId === blockId && !pending.current) void load()
      }),
    [blockId, load]
  )

  const flush = useCallback(async (): Promise<WorkflowBlock | null> => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    const next = pending.current
    const cur = latest.current
    if (!next || !cur) return cur
    pending.current = null
    try {
      const r = await window.notula.blocks.update({ blockId: cur.id, type, expectedUpdatedAt: cur.updated_at, content: next })
      if ('stale' in r) {
        showToast({ id: `block-stale-${cur.id}`, kind: 'error', title: STALE_COPY })
        return await load()
      }
      setBlock(r)
      latest.current = r
      return r
    } catch (err) {
      const msg = parseError(err).message
      showToast({ id: `block-save-${cur.id}`, kind: 'error', title: msg || saveErrorCopy })
      return null
    }
  }, [load, saveErrorCopy, type])

  useEffect(() => () => void flush(), [flush])

  const edit = useCallback(
    (next: T): void => {
      setContent(next)
      pending.current = next
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => void flush(), BLOCK_LIMITS.autosaveMs)
    },
    [flush]
  )

  const execute = useCallback(
    async (options?: BlockExecuteOptions) => {
      setBusy(true)
      try {
        const b = await flush()
        if (!b) return null
        const r = await window.notula.blocks.execute({ blockId: b.id, type, expectedUpdatedAt: b.updated_at, ...(options ? { options } : {}) })
        if ('stale' in r) {
          showToast({ id: `block-stale-${b.id}`, kind: 'error', title: STALE_COPY })
          await load()
          return null
        }
        setBlock(r.block)
        return r
      } catch {
        // The call itself failed: the stored state decides (a finished execution still counts).
        const b = await load()
        return b ? { block: b, failure: b.execution && ['created', 'sent', 'updated'].includes(b.execution.status) ? null : { errorCode: 'unknown', error: '' } } : null
      } finally {
        setBusy(false)
      }
    },
    [flush, load, type]
  )

  const dismiss = useCallback(async () => {
    const b = await flush()
    if (!b) return
    try {
      const r = await window.notula.blocks.update({ blockId: b.id, type, dismiss: true })
      if (!('stale' in r)) setBlock(r)
    } catch (err) {
      showToast({ kind: 'error', title: parseError(err).message || saveErrorCopy })
    }
  }, [flush, saveErrorCopy, type])

  return { block, content, error, edit, flush, execute, dismiss, busy }
}

/** The thread's blocks of one type, newest last (for "Go to newest draft"). */
export function useThreadBlocks(threadId: string, type: WorkflowBlockType): WorkflowBlock[] {
  const [list, setList] = useState<WorkflowBlock[]>([])
  useEffect(() => {
    let alive = true
    const read = (): void => {
      window.notula.blocks
        .list({ sourceType: 'chat_thread', sourceId: threadId })
        .then((all) => alive && setList(all.filter((b) => b.type === type)))
        .catch(() => undefined)
    }
    read()
    const off = window.notula.blocks.onChanged(() => read())
    return () => {
      alive = false
      off()
    }
  }, [threadId, type])
  return list
}
