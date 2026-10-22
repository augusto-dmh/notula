// SPDX-License-Identifier: Apache-2.0
// UI strings come from _locales (en for now). Elements with `data-i18n="<key>"` get their text
// filled in; `t()` is for strings built in code.

export function t(key: string, ...subs: string[]): string {
  return chrome.i18n.getMessage(key, subs.length ? subs : undefined) || key
}

export function applyI18n(root: ParentNode = document): void {
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('[data-i18n]'))) {
    el.textContent = t(el.dataset.i18n ?? '')
  }
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('[data-i18n-label]'))) {
    el.setAttribute('aria-label', t(el.dataset.i18nLabel ?? ''))
  }
}

/** The settings page for this browser's shortcuts. */
export function shortcutsUrl(): string {
  const edge = navigator.userAgentData?.brands.some((b) => /edge/i.test(b.brand)) ?? /Edg\//.test(navigator.userAgent)
  return edge ? 'edge://extensions/shortcuts' : 'chrome://extensions/shortcuts'
}

/** The public privacy policy; a copy ships in the package as privacy.html. */
export const PRIVACY_URL = 'https://augusto-dmh.github.io/notula-releases/extension/privacy/'
