// SPDX-License-Identifier: Apache-2.0
/// <reference types="vite/client" />
import type { NotulaApi } from '@shared/ipc'

declare global {
  interface Window {
    /** The preload bridge. The renderer's only way to reach main. */
    notula: NotulaApi
  }
}

export {}
