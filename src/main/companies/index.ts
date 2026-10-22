// SPDX-License-Identifier: Apache-2.0
// registerCompanies(): companies, company pages and the opt-in favicon fetch;
// the `companies:*` IPC. The maps are the people maps (people-repo.ts); `people:changed`
// covers both lists (people/index.ts).

import { ipcMain } from 'electron'
import { notulaError } from '@shared/errors'
import type { InvokeChannel, InvokeReq, InvokeRes } from '@shared/ipc'
import type { MainContext } from '../context'
import { expected } from '../ipc-expected'
import { log } from '../log'
import { listQuery, myEmails } from '../people'
import { CompanyIcons, validDomain } from './favicon'

function bad(message: string): Error {
  return expected(notulaError('invalid-input', message))
}

async function scope(ctx: MainContext): Promise<{ myEmails: string[]; genericDomains: string[] }> {
  const [mine, generic] = await Promise.all([myEmails(ctx), ctx.settings.get('people.genericEmailDomains')])
  return { myEmails: mine, genericDomains: generic }
}

function domainArg(req: unknown): string {
  const domain = validDomain((req as { domain?: unknown } | null)?.domain)
  if (!domain) throw bad('domain is invalid.')
  return domain
}

export function registerCompanies(ctx: MainContext): void {
  const icons = new CompanyIcons(ctx)

  ipcMain.handle(
    'companies:list' satisfies InvokeChannel,
    async (_e, req: InvokeReq<'companies:list'>): Promise<InvokeRes<'companies:list'>> =>
      ctx.storage.listCompanies({ ...listQuery(req), ...(await scope(ctx)) })
  )

  ipcMain.handle(
    'companies:get' satisfies InvokeChannel,
    async (_e, req: InvokeReq<'companies:get'>): Promise<InvokeRes<'companies:get'>> => ctx.storage.getCompany(domainArg(req), await scope(ctx))
  )

  ipcMain.handle(
    'companies:icon' satisfies InvokeChannel,
    async (_e, req: InvokeReq<'companies:icon'>): Promise<InvokeRes<'companies:icon'>> => icons.get(domainArg(req))
  )

  // Turning the icons off stops every request and deletes the cache.
  ctx.bus.on('settings:changed', (e) => {
    if (!e.keys.includes('companies.faviconsEnabled') || e.settings['companies.faviconsEnabled']) return
    void ctx.storage
      .deleteAllCompanyIcons()
      .then((n) => log('info', 'companies:icons-cleared', { count: n }))
      .catch((err: unknown) => log('warn', 'companies:icons-clear-failed', { err }))
  })
}
