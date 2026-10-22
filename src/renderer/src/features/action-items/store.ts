// SPDX-License-Identifier: Apache-2.0
// The action items the renderer shows: one query per
// view (`action-items:list`), refreshed on `action-items:changed`. The list holds the
// non-archived items; the thumbs read a note's items, archived ones included.

import { useCallback, useEffect, useRef, useState } from 'react'
import { parseError, type ParsedError } from '@shared/errors'
import type { ActionItem, ActionItemsQuery } from '@shared/types/action-items'

export type ListState =
  | { status: 'loading' }
  | { status: 'error'; error: ParsedError }
  | { status: 'ready'; items: ActionItem[] }

const REFRESH_DEBOUNCE_MS = 120

export function useActionItems(query: ActionItemsQuery | null): { state: ListState; reload(): Promise<void>; patch(fn: (items: ActionItem[]) => ActionItem[]): void } {
  const [state, setState] = useState<ListState>({ status: 'loading' })
  const key = query ? JSON.stringify(query) : null
  const request = useRef(0)

  const reload = useCallback(async (): Promise<void> => {
    if (key === null) return
    const n = ++request.current
    try {
      const items = await window.notula.actionItems.list(JSON.parse(key) as ActionItemsQuery)
      if (n === request.current) setState({ status: 'ready', items })
    } catch (err) {
      if (n === request.current) setState((prev) => (prev.status === 'ready' ? prev : { status: 'error', error: parseError(err) }))
    }
  }, [key])

  useEffect(() => {
    if (key === null) return
    setState({ status: 'loading' })
    void reload()
    let timer: ReturnType<typeof setTimeout> | null = null
    const off = window.notula.actionItems.onChanged(() => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => void reload(), REFRESH_DEBOUNCE_MS)
    })
    return () => {
      off()
      if (timer) clearTimeout(timer)
    }
  }, [key, reload])

  const patch = useCallback((fn: (items: ActionItem[]) => ActionItem[]): void => {
    setState((prev) => (prev.status === 'ready' ? { status: 'ready', items: fn(prev.items) } : prev))
  }, [])

  return { state, reload, patch }
}
