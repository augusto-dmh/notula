// SPDX-License-Identifier: Apache-2.0
// The slice of the Chromium extension API this package uses, declared by hand so the package has
// no dependencies of its own. Shapes follow the Chrome extension reference (MV3, Chrome 116+).
// Only what the code calls is declared; extend it when a new call is needed.

declare namespace chrome {
  namespace events {
    interface Event<T extends (...args: never[]) => unknown> {
      addListener(callback: T): void
      removeListener(callback: T): void
    }
  }

  namespace runtime {
    const id: string
    const lastError: { message?: string } | undefined

    interface MessageSender {
      id?: string
      url?: string
      origin?: string
      frameId?: number
      documentId?: string
      tab?: tabs.Tab
    }

    interface Port {
      name: string
      postMessage(message: unknown): void
      disconnect(): void
      onMessage: events.Event<(message: unknown, port: Port) => void>
      onDisconnect: events.Event<(port: Port) => void>
    }

    interface Manifest {
      version: string
      [key: string]: unknown
    }

    interface InstalledDetails {
      reason: 'install' | 'update' | 'chrome_update' | 'shared_module_update'
      previousVersion?: string
    }

    function getManifest(): Manifest
    function getURL(path: string): string
    function connectNative(application: string): Port
    function sendMessage(message: unknown): Promise<unknown>
    function openOptionsPage(): Promise<void>

    const onMessage: events.Event<
      (message: unknown, sender: MessageSender, sendResponse: (response?: unknown) => void) => boolean | undefined
    >
    const onInstalled: events.Event<(details: InstalledDetails) => void>
    const onStartup: events.Event<() => void>
  }

  namespace storage {
    interface StorageArea {
      get(keys?: string | string[] | null): Promise<Record<string, unknown>>
      set(items: Record<string, unknown>): Promise<void>
      remove(keys: string | string[]): Promise<void>
    }
    const local: StorageArea
    const session: StorageArea
    const onChanged: events.Event<(changes: Record<string, { oldValue?: unknown; newValue?: unknown }>, area: string) => void>
  }

  namespace tabs {
    interface Tab {
      id?: number
      windowId: number
      active: boolean
      audible?: boolean
      incognito: boolean
      url?: string
      title?: string
      mutedInfo?: { muted: boolean }
    }
    interface ChangeInfo {
      status?: string
      url?: string
      audible?: boolean
    }
    function get(tabId: number): Promise<Tab>
    function query(query: { active?: boolean; lastFocusedWindow?: boolean; currentWindow?: boolean; url?: string | string[] }): Promise<Tab[]>
    function sendMessage(tabId: number, message: unknown, options?: { frameId?: number }): Promise<unknown>
    function create(props: { url: string; active?: boolean }): Promise<Tab>
    const onRemoved: events.Event<(tabId: number, info: { windowId: number; isWindowClosing: boolean }) => void>
    const onUpdated: events.Event<(tabId: number, changeInfo: ChangeInfo, tab: Tab) => void>
  }

  namespace scripting {
    interface RegisteredContentScript {
      id: string
      matches?: string[]
      js?: string[]
      allFrames?: boolean
      runAt?: 'document_start' | 'document_end' | 'document_idle'
      persistAcrossSessions?: boolean
      world?: 'ISOLATED' | 'MAIN'
    }
    interface InjectionTarget {
      tabId: number
      allFrames?: boolean
      frameIds?: number[]
    }
    function registerContentScripts(scripts: RegisteredContentScript[]): Promise<void>
    function unregisterContentScripts(filter?: { ids?: string[] }): Promise<void>
    function getRegisteredContentScripts(filter?: { ids?: string[] }): Promise<RegisteredContentScript[]>
    function executeScript(injection: { target: InjectionTarget; files: string[]; world?: 'ISOLATED' | 'MAIN' }): Promise<unknown[]>
  }

  namespace permissions {
    interface Permissions {
      origins?: string[]
      permissions?: string[]
    }
    function request(permissions: Permissions): Promise<boolean>
    function remove(permissions: Permissions): Promise<boolean>
    function contains(permissions: Permissions): Promise<boolean>
    function getAll(): Promise<Permissions>
    const onRemoved: events.Event<(permissions: Permissions) => void>
    const onAdded: events.Event<(permissions: Permissions) => void>
  }

  namespace action {
    function setBadgeText(details: { text: string; tabId?: number }): Promise<void>
    function setBadgeBackgroundColor(details: { color: string; tabId?: number }): Promise<void>
    function setTitle(details: { title: string; tabId?: number }): Promise<void>
  }

  namespace commands {
    interface Command {
      name?: string
      description?: string
      shortcut?: string
    }
    function getAll(): Promise<Command[]>
    const onCommand: events.Event<(command: string, tab?: tabs.Tab) => void>
  }

  namespace i18n {
    function getMessage(name: string, substitutions?: string | string[]): string
    function getUILanguage(): string
  }

  namespace extension {
    function isAllowedIncognitoAccess(): Promise<boolean>
  }
}

interface NavigatorUAData {
  brands: { brand: string; version: string }[]
}

interface Navigator {
  readonly userAgentData?: NavigatorUAData
}
