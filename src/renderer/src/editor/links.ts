// SPDX-License-Identifier: Apache-2.0
// Link rules: only http, https, mailto and tel; values that
// start with `/` or `#` are rejected. Links render with target _blank and rel
// noopener noreferrer; main's window-open handler sends them to the OS browser.

import { Extension, type JSONContent } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { isMod } from '../app/platform'

export const LINK_PROTOCOLS = ['http:', 'https:', 'mailto:', 'tel:'] as const

export const LINK_ATTRIBUTES = { target: '_blank', rel: 'noopener noreferrer' } as const

export function isAllowedLink(raw: string): boolean {
  const value = raw.trim()
  if (value === '' || value.startsWith('/') || value.startsWith('#')) return false
  try {
    return (LINK_PROTOCOLS as readonly string[]).includes(new URL(value).protocol)
  } catch {
    return false
  }
}

/** File extensions that are also TLDs or read like one (`.md`, `.py`, `.sh`, `.rs`, …). */
const FILE_EXTENSIONS = new Set([
  'md', 'mdx', 'txt', 'json', 'jsonc', 'yml', 'yaml', 'toml', 'ini', 'env', 'lock', 'log', 'csv', 'xml',
  'ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs', 'py', 'rb', 'rs', 'go', 'java', 'kt', 'swift', 'cs',
  'cpp', 'hpp', 'php', 'sh', 'ps1', 'bat', 'sql', 'css', 'scss', 'html', 'vue', 'svelte', 'zip', 'pdf',
  'docx', 'xlsx', 'pptx', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'mov', 'mp4', 'mp3', 'wav', 'exe', 'dll'
])

/**
 * A bare word like `AGENTS.md` or `config.ts` (no scheme, no `www.`, no path),
 * whose last dot part is a file extension: a filename, never auto-linked.
 */
export function isBareFilename(value: string): boolean {
  const v = value.trim()
  if (!v || /^[a-z][a-z0-9+.-]*:/i.test(v) || /^www\./i.test(v) || /[/?#@]/.test(v)) return false
  const dot = v.lastIndexOf('.')
  return dot > 0 && FILE_EXTENSIONS.has(v.slice(dot + 1).toLowerCase())
}

/**
 * The link extension's `shouldAutoLink`: its default rules (a scheme links; an IPv4 or
 * dotless host does not) plus the filename rule above. Typing already needs a scheme
 * (`isAllowedLink`); this also covers pasting a bare word over a selection.
 */
export function shouldAutoLink(url: string): boolean {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url) || (/^[a-z][a-z0-9+.-]*:/i.test(url) && !url.includes('@'))) return true
  const host = (url.includes('@') ? (url.split('@').pop() ?? '') : url).split(/[/?#:]/)[0] ?? ''
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || !host.includes('.')) return false
  return !isBareFilename(url)
}

/** Drops link marks whose href breaks the rules (markdown parsing does not check them). */
export function sanitizeLinks(node: JSONContent): JSONContent {
  const out: JSONContent = { ...node }
  if (node.marks) out.marks = node.marks.filter((m) => m.type !== 'link' || isAllowedLink(String(m.attrs?.['href'] ?? '')))
  if (node.content) out.content = node.content.map(sanitizeLinks)
  return out
}

/**
 * In an editable editor a plain click places the caret; Mod+click opens the link.
 * A read-only editor follows links on a plain click (the browser does it natively).
 */
export const LinkOpen = Extension.create({
  name: 'notulaLinkOpen',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('notulaLinkOpen'),
        props: {
          handleClick: (view, _pos, event) => {
            if (event.button !== 0 || !view.editable || !isMod(event)) return false
            const anchor = (event.target as HTMLElement | null)?.closest('a')
            const href = anchor?.getAttribute('href')
            if (!anchor || !href || !view.dom.contains(anchor) || !isAllowedLink(href)) return false
            window.open(href, '_blank', 'noopener,noreferrer')
            event.preventDefault()
            return true
          }
        }
      })
    ]
  }
})
