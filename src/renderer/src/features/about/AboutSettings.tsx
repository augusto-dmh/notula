// SPDX-License-Identifier: Apache-2.0
// Settings ▸ About. The "Notula" card (version, licence, copyright, the full LICENSE
// collapsed), then "Open-source licenses": NOTICE, the speech models (MODELS.md), the
// components outside npm metadata, and the npm packages grouped by licence with a search
// field. Every licence text starts collapsed. "Open folder" shows the bundled
// `licenses/` folder. The files come from `licenses:get`; a missing one says so.

import { useEffect, useMemo, useState, type JSX } from 'react'
import { parseError } from '@shared/errors'
import type { LicensesInfo, ThirdPartyPackage } from '@shared/types/licenses'
import { debugLog } from '../../app/platform'
import { ChatMarkdown } from '../chat'
import { SettingsCard, SettingsRow } from '../settings/primitives'
import './about.css'

const MISSING = 'This file is missing from this copy of Notula.'

/** MODELS.md without its `# Speech models` title: the card already has it. */
const withoutTitle = (md: string): string => md.replace(/^# [^\n]*\n+/, '')

function Collapsible({ summary, text }: { summary: string; text: string | null }): JSX.Element {
  return (
    <details className="about-details">
      <summary className="about-details__summary">{summary}</summary>
      <pre className="about-text">{text ?? MISSING}</pre>
    </details>
  )
}

function groupByLicense(packages: ThirdPartyPackage[]): [string, ThirdPartyPackage[]][] {
  const groups = new Map<string, ThirdPartyPackage[]>()
  for (const p of packages) groups.set(p.license, [...(groups.get(p.license) ?? []), p])
  return [...groups.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
}

function PackageList({ packages }: { packages: ThirdPartyPackage[] }): JSX.Element {
  const [query, setQuery] = useState('')
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    const shown = q ? packages.filter((p) => p.name.toLowerCase().includes(q) || p.license.toLowerCase().includes(q)) : packages
    return groupByLicense(shown)
  }, [packages, query])
  return (
    <div className="about-packages">
      <input
        type="search"
        className="n-input about-packages__search"
        placeholder="Search packages or licenses"
        aria-label="Search packages"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {groups.length === 0 ? (
        <p className="about-empty">No packages match “{query.trim()}”.</p>
      ) : (
        groups.map(([license, list]) => (
          <section key={license} className="about-group">
            <h3 className="about-group__title">
              {license} <span className="about-group__count">{list.length}</span>
            </h3>
            {list.map((p) => (
              <details key={`${p.name}@${p.version}`} className="about-details">
                <summary className="about-details__summary">
                  <span className="about-pkg__name">{p.name}</span>
                  <span className="about-pkg__version">{p.version}</span>
                </summary>
                {/^https?:\/\//.test(p.repository) ? (
                  <a className="about-pkg__repo" href={p.repository} target="_blank" rel="noreferrer noopener">
                    {p.repository}
                  </a>
                ) : null}
                <pre className="about-text">{p.text ?? `Licensed under ${p.license}. The package ships no separate license file.`}</pre>
              </details>
            ))}
          </section>
        ))
      )}
    </div>
  )
}

export function AboutSettings(): JSX.Element {
  const [info, setInfo] = useState<LicensesInfo | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    void window.notula.licenses
      .get()
      .then(setInfo)
      .catch((err: unknown) => {
        debugLog('licenses:get-failed', { code: parseError(err).code })
        setFailed(true)
      })
  }, [])

  if (failed) return <p className="about-empty">Couldn’t read the license files. Reopen Settings to try again.</p>
  if (!info) {
    return (
      <div className="settings__loading" aria-busy="true">
        <div className="n-skeleton" style={{ height: 120 }} />
        <div className="n-skeleton" style={{ height: 160 }} />
      </div>
    )
  }

  return (
    <>
      <SettingsCard title="Notula">
        <SettingsRow title="Version" control={<span className="about-value">{info.version}</span>} />
        <SettingsRow
          title="License"
          description={`${info.copyright}. Licensed under the Apache License 2.0.`}
          control={<span className="about-value">{info.license}</span>}
        />
        <div className="about-card-body">
          <Collapsible summary="Apache License 2.0" text={info.licenseText} />
        </div>
      </SettingsCard>

      <SettingsCard
        title="Open-source licenses"
        description="Notula includes open-source software and can download speech models. Each keeps its own license."
      >
        <SettingsRow
          title="License files"
          description="LICENSE, NOTICE, MODELS.md and THIRD_PARTY_NOTICES.md, as shipped with this copy."
          control={
            <button type="button" className="n-btn n-btn--sm" onClick={() => window.notula.licenses.openFolder()}>
              Open folder
            </button>
          }
        />
        <div className="about-card-body">
          <Collapsible summary="Notice" text={info.notice} />
        </div>
      </SettingsCard>

      <SettingsCard title="Speech models">
        <div className="about-card-body about-md">{info.models ? <ChatMarkdown markdown={withoutTitle(info.models)} /> : <p>{MISSING}</p>}</div>
      </SettingsCard>

      <SettingsCard title="Bundled components">
        <div className="about-card-body about-md">{info.bundled ? <ChatMarkdown markdown={info.bundled} /> : <p>{MISSING}</p>}</div>
      </SettingsCard>

      <SettingsCard title={`npm packages (${info.packages.length})`}>
        <div className="about-card-body">
          {info.packages.length ? <PackageList packages={info.packages} /> : <p className="about-empty">{MISSING}</p>}
        </div>
      </SettingsCard>
    </>
  )
}
