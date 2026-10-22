// SPDX-License-Identifier: Apache-2.0
// Chat cards for file connectors: the Google Docs
// read preview, and the connector-action status lines (`Running Google Drive...`, `Ran Google
// Drive`, `Couldn’t run Google Drive`).

import type { JSX } from 'react'
import type { ToolCardProps } from '../../app/slots'
import { toolPhase } from '../chat/util'
import { openExternal } from '../integrations/store'
import './file-connectors.css'

const NAMES: Record<string, string> = { google_drive: 'Google Drive', onedrive: 'OneDrive', dropbox: 'Dropbox' }

function FileIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M4 1.8h5.2L12.5 5v9.2H4z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M9 2v3.3h3.3" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  )
}

export function ConnectorActionCard({ toolCall }: ToolCardProps): JSX.Element {
  const key = /_(google_drive|onedrive|dropbox)$/.exec(toolCall.name)?.[1] ?? ''
  const name = NAMES[key] ?? 'connector'
  const phase = toolPhase(toolCall)
  const r = (toolCall.result ?? null) as { count?: number; name?: string; url?: string | null; truncated?: boolean } | null
  const line = phase === 'running' ? `Running ${name}...` : phase === 'failed' ? `Couldn’t run ${name}` : `Ran ${name}`
  const detail = phase === 'done' && r ? (typeof r.count === 'number' ? ` · ${r.count === 0 ? 'no files' : `${r.count} file${r.count === 1 ? '' : 's'}`}` : r.name ? ` · ${r.name}${r.truncated ? ' (shortened)' : ''}` : '') : ''
  return (
    <div className={`chat-tool chat-tool--${phase}`}>
      <div className="chat-tool__line" title={phase === 'failed' && toolCall.error ? toolCall.error : undefined}>
        {phase === 'running' ? <span className="chat-tool__spin" aria-hidden="true" /> : <FileIcon />}
        <span>
          {line}
          {detail}
        </span>
        {phase === 'done' && r?.url ? (
          <button type="button" className="fc-link" onClick={() => r.url && openExternal(r.url)}>
            Open
          </button>
        ) : null}
      </div>
    </div>
  )
}

/** `readDriveDoc`: the document as read, shortened in the card. */
export function GoogleDocCard({ toolCall }: ToolCardProps): JSX.Element {
  const phase = toolPhase(toolCall)
  const r = (toolCall.result ?? null) as { title?: string; url?: string; text?: string; truncated?: boolean } | null
  if (phase !== 'done' || !r) {
    return (
      <div className={`chat-tool chat-tool--${phase}`}>
        <div className="chat-tool__line" title={toolCall.error ?? undefined}>
          {phase === 'running' ? <span className="chat-tool__spin" aria-hidden="true" /> : <FileIcon />}
          <span>{phase === 'running' ? 'Running Google Drive...' : 'Couldn’t run Google Drive'}</span>
        </div>
      </div>
    )
  }
  const lines = (r.text ?? '').split('\n')
  return (
    <div className="fc-doc">
      <div className="fc-doc__head">
        <FileIcon />
        <span className="fc-doc__title">{r.title || 'Untitled document'}</span>
        {r.url ? (
          <button type="button" className="fc-link" onClick={() => r.url && openExternal(r.url)}>
            Open Google Docs
          </button>
        ) : null}
      </div>
      <div className="fc-doc__body">
        {lines.slice(0, 60).map((l, i) => {
          const h = /^(#{1,3})\s+(.*)$/.exec(l)
          if (h) return <p key={i} className={`fc-doc__h fc-doc__h${h[1]?.length ?? 1}`}>{h[2]}</p>
          if (/^- /.test(l)) return <p key={i} className="fc-doc__li">{l.slice(2)}</p>
          return l.trim() ? <p key={i}>{l}</p> : null
        })}
      </div>
      {r.truncated || lines.length > 60 ? <p className="fc-doc__more">Only the start of this file is shown here.</p> : null}
    </div>
  )
}
