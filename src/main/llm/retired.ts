// SPDX-License-Identifier: Apache-2.0
// The last "this model is no longer available" answer per provider, for the notice in
// Settings ▸ AI (`llm:retired-model`). In memory only: after a restart the next failing
// call, or Test, records it again. A record shows only while the settings model is still
// the one that failed, so switching models clears the notice without a reset here.

import type { LlmProviderId, RetiredModel } from '@shared/types/enhance'
import { log } from '../log'

const lastRetired = new Map<LlmProviderId, RetiredModel>()

export function noteRetiredModel(provider: LlmProviderId, retired: RetiredModel): void {
  const prev = lastRetired.get(provider)
  lastRetired.set(provider, retired)
  if (prev?.model !== retired.model || prev.replacement !== retired.replacement) {
    log('info', 'llm:model-retired', { provider, model: retired.model, replacement: retired.replacement })
  }
}

/** The record for the provider while `model` is the one it names, else null. */
export function retiredModelFor(provider: LlmProviderId, model: string): RetiredModel | null {
  const r = lastRetired.get(provider)
  return r && model && r.model === model ? r : null
}
