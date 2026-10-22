// SPDX-License-Identifier: Apache-2.0
// Settings ▸ Connectors: MCP servers while `mcpClient.enabled`, and the local MCP server
// card always; the Local API section under the MCP server card, and the Files group last.

import { createElement, Fragment, type JSX } from 'react'
import { FileConnectorsGroup } from '../file-connectors'
import { LocalApiSection } from '../local-api'
import { usePrefs } from '../settings/prefs-store'
import { LocalServerCard } from './LocalServer'
import { McpServersSection } from './McpServers'
import '../dictation/voice-typing.css'
import './connectors.css'

export function ConnectorsSettings(): JSX.Element {
  const prefs = usePrefs()
  return createElement(
    Fragment,
    null,
    createElement(LocalServerCard),
    createElement(LocalApiSection),
    prefs?.['mcpClient.enabled'] ? createElement(McpServersSection) : null,
    createElement(FileConnectorsGroup)
  )
}
