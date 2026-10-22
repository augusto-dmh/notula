// SPDX-License-Identifier: Apache-2.0
// "How your data is used": built in main from the live configuration
// (`privacy:data-usage`), in Notula's words. Read-only.

import { useEffect, useState, type JSX } from 'react'
import type { DataUsage, DataUsageKind } from '@shared/types/local-only'
import { SettingsCard } from '../settings/primitives'
import { useLocalOnly } from './store'
import './local-only.css'

const KIND_LABEL: Record<DataUsageKind, string> = {
  llm: 'Notes AI',
  asr: 'Transcription',
  integration: 'Integration',
  calendar: 'Calendar',
  mcp: 'MCP server',
  updates: 'Updates',
  sources: 'Sources'
}

export function DataUsageCard(): JSX.Element | null {
  const status = useLocalOnly()
  const [usage, setUsage] = useState<DataUsage | null>(null)
  const changedAt = status?.changedAt ?? null
  const enabled = status?.enabled ?? null

  useEffect(() => {
    let live = true
    void window.notula.privacy
      .dataUsage()
      .then((u) => live && setUsage(u))
      .catch(() => live && setUsage(null))
    return () => {
      live = false
    }
  }, [changedAt, enabled])

  if (!usage) return null
  const sent = usage.destinations.filter((d) => d.active)
  return (
    <SettingsCard title="How your data is used">
      <div className="du">
        <section className="du__block">
          <h3 className="du__head">Stored on this computer</h3>
          <p className="du__text">
            Notes, transcripts, summaries, chats and recordings stay in Notula's encrypted database on this computer. Notula has no account or
            server, so nothing is uploaded to its makers.
          </p>
        </section>
        <section className="du__block">
          <h3 className="du__head">Sent only where you chose</h3>
          {usage.localOnly ? (
            <p className="du__text du__text--strong">Sent nowhere: Nothing leaves this machine is on.</p>
          ) : sent.length ? (
            <ul className="du__list">
              {sent.map((d, i) => (
                <li key={`${d.kind}-${i}`} className="du__item">
                  <span className="du__item-name">
                    {KIND_LABEL[d.kind]}: {d.name} <span className="du__item-host">({d.detail})</span>
                  </span>
                  <span className="du__item-what">{d.what}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="du__text">Nothing is sent anywhere with your current settings.</p>
          )}
        </section>
        <section className="du__block">
          <h3 className="du__head">Not collected</h3>
          <p className="du__text">No usage analytics, crash reports or diagnostics. Logs stay on this computer unless you export them.</p>
        </section>
        <section className="du__block">
          <h3 className="du__head">Training</h3>
          <p className="du__text">
            Notula does not train models. Whether your AI provider keeps or trains on what it receives is governed by your agreement with that
            provider.
          </p>
        </section>
      </div>
    </SettingsCard>
  )
}
