// SPDX-License-Identifier: Apache-2.0
// The complete `window.notula` bridge. No logic: every member writes its ipcRenderer call
// with the channel literal inline, so each one can be resolved statically (by a text search
// or by static analysis of the bundle). Never add a helper that takes a channel parameter.
// Push members never hand the IpcRendererEvent to the page.
//
// `files.pathForFile` wraps `webUtils.getPathForFile` and sends nothing; the
// `imports:media-port` push is not a bridge member: its transferred port is forwarded
// to the media-worker page with `window.postMessage`.

import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import type {
  InvokeChannel,
  NotulaApi,
  PushChannel,
  PushPayload,
  SendChannel
} from '@shared/ipc'

const api: NotulaApi = {
  app: {
    info: () => ipcRenderer.invoke('app:info' satisfies InvokeChannel),
    getOpenAtLogin: () => ipcRenderer.invoke('app:get-open-at-login' satisfies InvokeChannel),
    setLaunchAtLogin: (p) => ipcRenderer.send('app:set-open-at-login' satisfies SendChannel, p),
    setTheme: (p) => ipcRenderer.send('app:set-theme' satisfies SendChannel, p),
    relaunch: () => ipcRenderer.invoke('app:relaunch' satisfies InvokeChannel),
    reportInteraction: () => ipcRenderer.send('app:user-interacted' satisfies SendChannel),
    setViewingNote: (p) => ipcRenderer.send('app:viewing-note' satisfies SendChannel, p)
  },
  update: {
    getState: () => ipcRenderer.invoke('update:get-state' satisfies InvokeChannel),
    install: () => ipcRenderer.invoke('update:install' satisfies InvokeChannel),
    delay: (p) => ipcRenderer.send('update:delay' satisfies SendChannel, p),
    onState: (cb) => {
      const listener = (_e: IpcRendererEvent, p: PushPayload<'update:state'>): void => cb(p)
      ipcRenderer.on('update:state' satisfies PushChannel, listener)
      return () => {
        ipcRenderer.removeListener('update:state' satisfies PushChannel, listener)
      }
    },
    setChannel: (req) => ipcRenderer.invoke('update:set-channel' satisfies InvokeChannel, req)
  },
  deeplink: {
    getPending: () => ipcRenderer.invoke('deeplink:get-pending' satisfies InvokeChannel),
    onReceived: (cb) => {
      const listener = (_e: IpcRendererEvent, p: PushPayload<'deeplink:received'>): void => cb(p)
      ipcRenderer.on('deeplink:received' satisfies PushChannel, listener)
      return () => {
        ipcRenderer.removeListener('deeplink:received' satisfies PushChannel, listener)
      }
    },
    onUnsupported: (cb) => {
      const listener = (_e: IpcRendererEvent, p: PushPayload<'deeplink:unsupported'>): void => cb(p)
      ipcRenderer.on('deeplink:unsupported' satisfies PushChannel, listener)
      return () => {
        ipcRenderer.removeListener('deeplink:unsupported' satisfies PushChannel, listener)
      }
    }
  },
  bubble: {
    getState: () => ipcRenderer.invoke('bubble:get-state' satisfies InvokeChannel),
    setDocument: (doc) => ipcRenderer.send('bubble:set-document' satisfies SendChannel, doc),
    dragStart: () => ipcRenderer.send('bubble:drag-start' satisfies SendChannel),
    dragEnd: () => ipcRenderer.send('bubble:drag-end' satisfies SendChannel),
    openNote: (p) => ipcRenderer.send('bubble:open-note' satisfies SendChannel, p),
    onVisible: (cb) => {
      const listener = (_e: IpcRendererEvent, p: PushPayload<'bubble:shown'>): void => cb(p)
      ipcRenderer.on('bubble:shown' satisfies PushChannel, listener)
      return () => {
        ipcRenderer.removeListener('bubble:shown' satisfies PushChannel, listener)
      }
    },
    onHover: (cb) => {
      const listener = (_e: IpcRendererEvent, p: PushPayload<'bubble:hovered'>): void => cb(p)
      ipcRenderer.on('bubble:hovered' satisfies PushChannel, listener)
      return () => {
        ipcRenderer.removeListener('bubble:hovered' satisfies PushChannel, listener)
      }
    },
    onDocument: (cb) => {
      const listener = (_e: IpcRendererEvent, p: PushPayload<'bubble:note'>): void => cb(p)
      ipcRenderer.on('bubble:note' satisfies PushChannel, listener)
      return () => {
        ipcRenderer.removeListener('bubble:note' satisfies PushChannel, listener)
      }
    },
    takeSnapshot: (req) => ipcRenderer.invoke('bubble:take-snapshot' satisfies InvokeChannel, req)
  },
  notify: {
    getPayload: () => ipcRenderer.invoke('notify:get-payload' satisfies InvokeChannel),
    action: (p) => ipcRenderer.send('notify:action' satisfies SendChannel, p),
    reportHeight: (p) => ipcRenderer.send('notify:content-height' satisfies SendChannel, p),
    setMenuOpen: (p) => ipcRenderer.send('notify:menu-open' satisfies SendChannel, p),
    onAnimateOut: (cb) => {
      const listener = (_e: IpcRendererEvent, p: PushPayload<'notify:animate-out'>): void => cb(p)
      ipcRenderer.on('notify:animate-out' satisfies PushChannel, listener)
      return () => {
        ipcRenderer.removeListener('notify:animate-out' satisfies PushChannel, listener)
      }
    },
    onLastTime: (cb) => {
      const listener = (_e: IpcRendererEvent, p: PushPayload<'notify:last-time'>): void => cb(p)
      ipcRenderer.on('notify:last-time' satisfies PushChannel, listener)
      return () => {
        ipcRenderer.removeListener('notify:last-time' satisfies PushChannel, listener)
      }
    }
  },
  meetings: {
    getMicApps: () => ipcRenderer.invoke('meetings:get-mic-apps' satisfies InvokeChannel),
    getStatus: () => ipcRenderer.invoke('meetings:get-status' satisfies InvokeChannel),
    onMicAppsChanged: (cb) => {
      const listener = (_e: IpcRendererEvent, p: PushPayload<'meetings:mic-apps-changed'>): void => cb(p)
      ipcRenderer.on('meetings:mic-apps-changed' satisfies PushChannel, listener)
      return () => {
        ipcRenderer.removeListener('meetings:mic-apps-changed' satisfies PushChannel, listener)
      }
    }
  },
  storage: {
    getStatus: () => ipcRenderer.invoke('storage:get-status' satisfies InvokeChannel),
    recover: (req) => ipcRenderer.invoke('storage:recover' satisfies InvokeChannel, req),
    onStatusChanged: (cb) => {
      const listener = (_e: IpcRendererEvent, p: PushPayload<'storage:status-changed'>): void => cb(p)
      ipcRenderer.on('storage:status-changed' satisfies PushChannel, listener)
      return () => {
        ipcRenderer.removeListener('storage:status-changed' satisfies PushChannel, listener)
      }
    }
  },
  notes: {
    list: (q) => ipcRenderer.invoke('notes:list' satisfies InvokeChannel, q),
    get: (req) => ipcRenderer.invoke('notes:get' satisfies InvokeChannel, req),
    create: (input) => ipcRenderer.invoke('notes:create' satisfies InvokeChannel, input),
    update: (req) => ipcRenderer.invoke('notes:update' satisfies InvokeChannel, req),
    trash: (req) => ipcRenderer.invoke('notes:trash' satisfies InvokeChannel, req),
    restore: (req) => ipcRenderer.invoke('notes:restore' satisfies InvokeChannel, req),
    findByEvent: (req) => ipcRenderer.invoke('notes:find-by-event' satisfies InvokeChannel, req),
    onChanged: (cb) => {
      const listener = (_e: IpcRendererEvent, p: PushPayload<'notes:changed'>): void => cb(p)
      ipcRenderer.on('notes:changed' satisfies PushChannel, listener)
      return () => {
        ipcRenderer.removeListener('notes:changed' satisfies PushChannel, listener)
      }
    },
    onNewRequested: (cb) => {
      const listener = (_e: IpcRendererEvent, p: PushPayload<'notes:new-requested'>): void => cb(p)
      ipcRenderer.on('notes:new-requested' satisfies PushChannel, listener)
      return () => {
        ipcRenderer.removeListener('notes:new-requested' satisfies PushChannel, listener)
      }
    },
    onNewBlocked: (cb) => {
      const listener = (): void => cb()
      ipcRenderer.on('notes:new-blocked' satisfies PushChannel, listener)
      return () => {
        ipcRenderer.removeListener('notes:new-blocked' satisfies PushChannel, listener)
      }
    },
    listTrash: () => ipcRenderer.invoke('notes:list-trash' satisfies InvokeChannel),
    deletePermanently: (req) => ipcRenderer.invoke('notes:delete-permanently' satisfies InvokeChannel, req),
    autoDeleteIfEmpty: (req) => ipcRenderer.invoke('notes:auto-delete-if-empty' satisfies InvokeChannel, req)
  },
  clipboard: {
    write: (req) => ipcRenderer.invoke('clipboard:write' satisfies InvokeChannel, req),
    writeText: (req) => ipcRenderer.invoke('clipboard:copy-text' satisfies InvokeChannel, req),
    writeImageRect: (req) => ipcRenderer.invoke('clipboard:write-image-rect' satisfies InvokeChannel, req)
  },
  ydoc: {
    load: (req) => ipcRenderer.invoke('ydoc:load' satisfies InvokeChannel, req),
    append: (req) => ipcRenderer.invoke('ydoc:append' satisfies InvokeChannel, req),
    onUpdated: (cb) => {
      const listener = (_e: IpcRendererEvent, p: PushPayload<'ydoc:updated'>): void => cb(p)
      ipcRenderer.on('ydoc:updated' satisfies PushChannel, listener)
      return () => {
        ipcRenderer.removeListener('ydoc:updated' satisfies PushChannel, listener)
      }
    }
  },
  panels: {
    list: (req) => ipcRenderer.invoke('panels:list' satisfies InvokeChannel, req),
    update: (req) => ipcRenderer.invoke('panels:update' satisfies InvokeChannel, req)
  },
  prefs: {
    get: () => ipcRenderer.invoke('prefs:get' satisfies InvokeChannel),
    set: (patch) => ipcRenderer.send('prefs:set' satisfies SendChannel, patch),
    onChanged: (cb) => {
      const listener = (_e: IpcRendererEvent, p: PushPayload<'prefs:changed'>): void => cb(p)
      ipcRenderer.on('prefs:changed' satisfies PushChannel, listener)
      return () => {
        ipcRenderer.removeListener('prefs:changed' satisfies PushChannel, listener)
      }
    }
  },
  capture: {
    setDesiredState: (state) => ipcRenderer.send('capture:set-desired-state' satisfies SendChannel, state),
    awaitSessionStopped: (req) =>
      ipcRenderer.invoke('capture:await-session-stopped' satisfies InvokeChannel, req),
    onSystemState: (cb) => {
      const listener = (_e: IpcRendererEvent, p: PushPayload<'capture:system-state'>): void => cb(p)
      ipcRenderer.on('capture:system-state' satisfies PushChannel, listener)
      return () => {
        ipcRenderer.removeListener('capture:system-state' satisfies PushChannel, listener)
      }
    },
    onCommand: (cb) => {
      const listener = (_e: IpcRendererEvent, p: PushPayload<'capture:command'>): void => cb(p)
      ipcRenderer.on('capture:command' satisfies PushChannel, listener)
      return () => {
        ipcRenderer.removeListener('capture:command' satisfies PushChannel, listener)
      }
    },
    sendEvent: (event) => ipcRenderer.send('capture:event' satisfies SendChannel, event),
    onVolume: (cb) => {
      const listener = (_e: IpcRendererEvent, p: PushPayload<'capture:volume'>): void => cb(p)
      ipcRenderer.on('capture:volume' satisfies PushChannel, listener)
      return () => {
        ipcRenderer.removeListener('capture:volume' satisfies PushChannel, listener)
      }
    },
    onSystemSourceChanged: (cb) => {
      const listener = (_e: IpcRendererEvent, p: PushPayload<'capture:system-source-changed'>): void =>
        cb(p)
      ipcRenderer.on('capture:system-source-changed' satisfies PushChannel, listener)
      return () => {
        ipcRenderer.removeListener('capture:system-source-changed' satisfies PushChannel, listener)
      }
    },
    getStatus: () => ipcRenderer.invoke('capture:get-status' satisfies InvokeChannel),
    restart: (req) => ipcRenderer.invoke('capture:restart' satisfies InvokeChannel, req),
    onStopRequested: (cb) => {
      const listener = (_e: IpcRendererEvent, p: PushPayload<'capture:stop-requested'>): void => cb(p)
      ipcRenderer.on('capture:stop-requested' satisfies PushChannel, listener)
      return () => {
        ipcRenderer.removeListener('capture:stop-requested' satisfies PushChannel, listener)
      }
    },
    getHealth: () => ipcRenderer.invoke('capture:get-health' satisfies InvokeChannel),
    onHealth: (cb) => {
      const listener = (_e: IpcRendererEvent, p: PushPayload<'capture:health'>): void => cb(p)
      ipcRenderer.on('capture:health' satisfies PushChannel, listener)
      return () => {
        ipcRenderer.removeListener('capture:health' satisfies PushChannel, listener)
      }
    },
    getInactivity: () => ipcRenderer.invoke('capture:get-inactivity' satisfies InvokeChannel),
    onInactivity: (cb) => {
      const listener = (_e: IpcRendererEvent, p: PushPayload<'capture:inactivity'>): void => cb(p)
      ipcRenderer.on('capture:inactivity' satisfies PushChannel, listener)
      return () => {
        ipcRenderer.removeListener('capture:inactivity' satisfies PushChannel, listener)
      }
    },
    answerInactivity: (p) => ipcRenderer.send('capture:inactivity-action' satisfies SendChannel, p)
  },
  power: {
    preventDisplaySleep: () => ipcRenderer.send('power:prevent-display-sleep' satisfies SendChannel),
    allowDisplaySleep: () => ipcRenderer.send('power:allow-display-sleep' satisfies SendChannel),
    getResumed: () => ipcRenderer.invoke('power:get-resumed' satisfies InvokeChannel),
    onResumed: (cb) => {
      const listener = (_e: IpcRendererEvent, p: PushPayload<'power:resumed'>): void => cb(p)
      ipcRenderer.on('power:resumed' satisfies PushChannel, listener)
      return () => {
        ipcRenderer.removeListener('power:resumed' satisfies PushChannel, listener)
      }
    },
    dismissResumed: (p) => ipcRenderer.send('power:dismiss-resumed' satisfies SendChannel, p)
  },
  input: {
    getState: () => ipcRenderer.invoke('input:get-state' satisfies InvokeChannel),
    setPreference: (pref) => ipcRenderer.send('input:set-preference' satisfies SendChannel, pref),
    onStateChanged: (cb) => {
      const listener = (_e: IpcRendererEvent, p: PushPayload<'input:state-changed'>): void => cb(p)
      ipcRenderer.on('input:state-changed' satisfies PushChannel, listener)
      return () => {
        ipcRenderer.removeListener('input:state-changed' satisfies PushChannel, listener)
      }
    },
    onDevicesChanged: (cb) => {
      const listener = (_e: IpcRendererEvent, p: PushPayload<'input:devices-changed'>): void => cb(p)
      ipcRenderer.on('input:devices-changed' satisfies PushChannel, listener)
      return () => {
        ipcRenderer.removeListener('input:devices-changed' satisfies PushChannel, listener)
      }
    },
    onActiveDeviceChanged: (cb) => {
      const listener = (_e: IpcRendererEvent, p: PushPayload<'input:active-device-changed'>): void => cb(p)
      ipcRenderer.on('input:active-device-changed' satisfies PushChannel, listener)
      return () => {
        ipcRenderer.removeListener('input:active-device-changed' satisfies PushChannel, listener)
      }
    }
  },
  system: {
    openAudioSettings: () => ipcRenderer.send('system:open-sound-settings' satisfies SendChannel),
    openPrivacySettings: (p) => ipcRenderer.send('system:open-privacy-settings' satisfies SendChannel, p),
    getLanguages: () => ipcRenderer.invoke('system:get-languages' satisfies InvokeChannel)
  },
  transcription: {
    onSessionState: (cb) => {
      const listener = (_e: IpcRendererEvent, p: PushPayload<'transcription:session-state'>): void => cb(p)
      ipcRenderer.on('transcription:session-state' satisfies PushChannel, listener)
      return () => {
        ipcRenderer.removeListener('transcription:session-state' satisfies PushChannel, listener)
      }
    }
  },
  transcript: {
    get: (req) => ipcRenderer.invoke('transcript:get' satisfies InvokeChannel, req),
    onChanged: (cb) => {
      const listener = (_e: IpcRendererEvent, p: PushPayload<'transcript:changed'>): void => cb(p)
      ipcRenderer.on('transcript:changed' satisfies PushChannel, listener)
      return () => {
        ipcRenderer.removeListener('transcript:changed' satisfies PushChannel, listener)
      }
    },
    deleteSections: (req) => ipcRenderer.invoke('transcript:delete-sections' satisfies InvokeChannel, req)
  },
  asr: {
    setKey: (req) => ipcRenderer.invoke('asr:set-key' satisfies InvokeChannel, req),
    hasKey: (req) => ipcRenderer.invoke('asr:has-key' satisfies InvokeChannel, req),
    clearKey: (req) => ipcRenderer.invoke('asr:clear-key' satisfies InvokeChannel, req),
    test: (req) => ipcRenderer.invoke('asr:test' satisfies InvokeChannel, req),
    getLocalModelState: (req) => ipcRenderer.invoke('asr:get-local-model-state' satisfies InvokeChannel, req),
    downloadLocalModel: (req) => ipcRenderer.invoke('asr:download-local-model' satisfies InvokeChannel, req),
    deleteLocalModel: (req) => ipcRenderer.invoke('asr:delete-local-model' satisfies InvokeChannel, req),
    onLocalModelStateChanged: (cb) => {
      const listener = (_e: IpcRendererEvent, p: PushPayload<'asr:local-model-state-changed'>): void => cb(p)
      ipcRenderer.on('asr:local-model-state-changed' satisfies PushChannel, listener)
      return () => {
        ipcRenderer.removeListener('asr:local-model-state-changed' satisfies PushChannel, listener)
      }
    }
  },
  enhance: {
    generate: (req) => ipcRenderer.invoke('enhance:generate' satisfies InvokeChannel, req),
    rewrite: (req) => ipcRenderer.invoke('enhance:rewrite' satisfies InvokeChannel, req),
    generateTitle: (req) => ipcRenderer.invoke('enhance:title' satisfies InvokeChannel, req),
    getActive: (req) => ipcRenderer.invoke('enhance:get-active' satisfies InvokeChannel, req),
    onEvent: (cb) => {
      const listener = (_e: IpcRendererEvent, p: PushPayload<'enhance:event'>): void => cb(p)
      ipcRenderer.on('enhance:event' satisfies PushChannel, listener)
      return () => {
        ipcRenderer.removeListener('enhance:event' satisfies PushChannel, listener)
      }
    }
  },
  llm: {
    setKey: (req) => ipcRenderer.invoke('llm:set-key' satisfies InvokeChannel, req),
    hasKey: (req) => ipcRenderer.invoke('llm:has-key' satisfies InvokeChannel, req),
    clearKey: (req) => ipcRenderer.invoke('llm:clear-key' satisfies InvokeChannel, req),
    test: (req) => ipcRenderer.invoke('llm:test' satisfies InvokeChannel, req),
    listModels: (req) => ipcRenderer.invoke('llm:list-models' satisfies InvokeChannel, req)
  },
  permissions: {
    getState: () => ipcRenderer.invoke('permissions:get-state' satisfies InvokeChannel),
    requestMicrophone: () => ipcRenderer.invoke('permissions:request-microphone' satisfies InvokeChannel),
    requestSystemAudio: (req) =>
      ipcRenderer.invoke('permissions:request-system-audio' satisfies InvokeChannel, req),
    checkSystemAudio: () => ipcRenderer.invoke('permissions:check-system-audio' satisfies InvokeChannel),
    onChanged: (cb) => {
      const listener = (_e: IpcRendererEvent, p: PushPayload<'permissions:changed'>): void => cb(p)
      ipcRenderer.on('permissions:changed' satisfies PushChannel, listener)
      return () => {
        ipcRenderer.removeListener('permissions:changed' satisfies PushChannel, listener)
      }
    }
  },
  onboarding: {
    setState: (p) => ipcRenderer.send('onboarding:set-state' satisfies SendChannel, p)
  },
  settings: {
    open: (p) => ipcRenderer.send('settings:open' satisfies SendChannel, p),
    onOpen: (cb) => {
      const listener = (_e: IpcRendererEvent, p: PushPayload<'settings:open'>): void => cb(p)
      ipcRenderer.on('settings:open' satisfies PushChannel, listener)
      return () => {
        ipcRenderer.removeListener('settings:open' satisfies PushChannel, listener)
      }
    }
  },
  templates: {
    list: () => ipcRenderer.invoke('templates:list' satisfies InvokeChannel),
    create: (req) => ipcRenderer.invoke('templates:create' satisfies InvokeChannel, req),
    update: (req) => ipcRenderer.invoke('templates:update' satisfies InvokeChannel, req),
    delete: (req) => ipcRenderer.invoke('templates:delete' satisfies InvokeChannel, req),
    onChanged: (cb) => {
      const listener = (_e: IpcRendererEvent, p: PushPayload<'templates:changed'>): void => cb(p)
      ipcRenderer.on('templates:changed' satisfies PushChannel, listener)
      return () => {
        ipcRenderer.removeListener('templates:changed' satisfies PushChannel, listener)
      }
    },
    setNoteTemplate: (p) => ipcRenderer.send('templates:set-note-template' satisfies SendChannel, p)
  },
  recipes: {
    list: () => ipcRenderer.invoke('recipes:list' satisfies InvokeChannel),
    upsert: (req) => ipcRenderer.invoke('recipes:upsert' satisfies InvokeChannel, req),
    delete: (req) => ipcRenderer.invoke('recipes:delete' satisfies InvokeChannel, req),
    restore: (req) => ipcRenderer.invoke('recipes:restore' satisfies InvokeChannel, req),
    onChanged: (cb) => {
      const listener = (_e: IpcRendererEvent, p: PushPayload<'recipes:changed'>): void => cb(p)
      ipcRenderer.on('recipes:changed' satisfies PushChannel, listener)
      return () => {
        ipcRenderer.removeListener('recipes:changed' satisfies PushChannel, listener)
      }
    },
    usage: () => ipcRenderer.invoke('recipes:usage' satisfies InvokeChannel),
    save: (req) => ipcRenderer.invoke('recipes:save' satisfies InvokeChannel, req),
    unsave: (req) => ipcRenderer.invoke('recipes:unsave' satisfies InvokeChannel, req)
  },
  chat: {
    sendMessage: (req) => ipcRenderer.invoke('chat:send-message' satisfies InvokeChannel, req),
    stop: (req) => ipcRenderer.invoke('chat:stop' satisfies InvokeChannel, req),
    listThreads: (req) => ipcRenderer.invoke('chat:list-threads' satisfies InvokeChannel, req),
    getThread: (req) => ipcRenderer.invoke('chat:get-thread' satisfies InvokeChannel, req),
    updateThread: (req) => ipcRenderer.invoke('chat:update-thread' satisfies InvokeChannel, req),
    deleteThread: (req) => ipcRenderer.invoke('chat:delete-thread' satisfies InvokeChannel, req),
    updateToolCall: (req) => ipcRenderer.invoke('chat:update-tool-call' satisfies InvokeChannel, req),
    onEvent: (cb) => {
      const listener = (_e: IpcRendererEvent, p: PushPayload<'chat:event'>): void => cb(p)
      ipcRenderer.on('chat:event' satisfies PushChannel, listener)
      return () => {
        ipcRenderer.removeListener('chat:event' satisfies PushChannel, listener)
      }
    },
    onChanged: (cb) => {
      const listener = (_e: IpcRendererEvent, p: PushPayload<'chat:changed'>): void => cb(p)
      ipcRenderer.on('chat:changed' satisfies PushChannel, listener)
      return () => {
        ipcRenderer.removeListener('chat:changed' satisfies PushChannel, listener)
      }
    }
  },
  calendar: {
    sources: () => ipcRenderer.invoke('calendar:sources' satisfies InvokeChannel),
    addIcs: (req) => ipcRenderer.invoke('calendar:add-ics' satisfies InvokeChannel, req),
    removeSource: (req) => ipcRenderer.invoke('calendar:remove-source' satisfies InvokeChannel, req),
    setOAuthClient: (req) => ipcRenderer.invoke('calendar:set-oauth-client' satisfies InvokeChannel, req),
    connect: (req) => ipcRenderer.invoke('calendar:connect' satisfies InvokeChannel, req),
    calendars: () => ipcRenderer.invoke('calendar:calendars' satisfies InvokeChannel),
    setVisible: (req) => ipcRenderer.invoke('calendar:set-visible' satisfies InvokeChannel, req),
    resetVisible: () => ipcRenderer.invoke('calendar:reset-visible' satisfies InvokeChannel),
    refresh: (req) => ipcRenderer.invoke('calendar:refresh' satisfies InvokeChannel, req),
    range: (req) => ipcRenderer.invoke('calendar:range' satisfies InvokeChannel, req),
    upcoming: (req) => ipcRenderer.invoke('calendar:upcoming' satisfies InvokeChannel, req),
    join: (req) => ipcRenderer.invoke('calendar:join' satisfies InvokeChannel, req),
    setViewingEvent: (p) => ipcRenderer.send('calendar:viewing-event' satisfies SendChannel, p),
    onChanged: (cb) => {
      const listener = (_e: IpcRendererEvent, p: PushPayload<'calendar:changed'>): void => cb(p)
      ipcRenderer.on('calendar:changed' satisfies PushChannel, listener)
      return () => {
        ipcRenderer.removeListener('calendar:changed' satisfies PushChannel, listener)
      }
    },
    setGrant: (req) => ipcRenderer.invoke('calendar:set-grant' satisfies InvokeChannel, req),
    eventColors: (req) => ipcRenderer.invoke('calendar:event-colors' satisfies InvokeChannel, req)
  },
  people: {
    participants: (req) => ipcRenderer.invoke('people:participants' satisfies InvokeChannel, req),
    list: (req) => ipcRenderer.invoke('people:list' satisfies InvokeChannel, req),
    get: (req) => ipcRenderer.invoke('people:get' satisfies InvokeChannel, req),
    onChanged: (cb) => {
      const listener = (): void => cb()
      ipcRenderer.on('people:changed' satisfies PushChannel, listener)
      return () => {
        ipcRenderer.removeListener('people:changed' satisfies PushChannel, listener)
      }
    }
  },
  folders: {
    list: () => ipcRenderer.invoke('folders:list' satisfies InvokeChannel),
    create: (req) => ipcRenderer.invoke('folders:create' satisfies InvokeChannel, req),
    update: (req) => ipcRenderer.invoke('folders:update' satisfies InvokeChannel, req),
    delete: (req) => ipcRenderer.invoke('folders:delete' satisfies InvokeChannel, req),
    addNotes: (req) => ipcRenderer.invoke('folders:add-notes' satisfies InvokeChannel, req),
    removeNote: (req) => ipcRenderer.invoke('folders:remove-note' satisfies InvokeChannel, req),
    setRule: (req) => ipcRenderer.invoke('folders:set-rule' satisfies InvokeChannel, req),
    deleteRule: (req) => ipcRenderer.invoke('folders:delete-rule' satisfies InvokeChannel, req),
    suggest: (req) => ipcRenderer.invoke('folders:suggest' satisfies InvokeChannel, req),
    onChanged: (cb) => {
      const listener = (_e: IpcRendererEvent, p: PushPayload<'folders:changed'>): void => cb(p)
      ipcRenderer.on('folders:changed' satisfies PushChannel, listener)
      return () => {
        ipcRenderer.removeListener('folders:changed' satisfies PushChannel, listener)
      }
    }
  },
  search: {
    query: (req) => ipcRenderer.invoke('search:query' satisfies InvokeChannel, req)
  },
  attribution: {
    getStatus: () => ipcRenderer.invoke('attribution:get-status' satisfies InvokeChannel),
    onStatusChanged: (cb) => {
      const listener = (_e: IpcRendererEvent, p: PushPayload<'attribution:status-changed'>): void => cb(p)
      ipcRenderer.on('attribution:status-changed' satisfies PushChannel, listener)
      return () => {
        ipcRenderer.removeListener('attribution:status-changed' satisfies PushChannel, listener)
      }
    },
    onCurrentSpeaker: (cb) => {
      const listener = (_e: IpcRendererEvent, p: PushPayload<'attribution:active-speaker'>): void => cb(p)
      ipcRenderer.on('attribution:active-speaker' satisfies PushChannel, listener)
      return () => {
        ipcRenderer.removeListener('attribution:active-speaker' satisfies PushChannel, listener)
      }
    }
  },
  speakerNames: {
    list: (req) => ipcRenderer.invoke('speaker-names:list' satisfies InvokeChannel, req),
    accept: (req) => ipcRenderer.invoke('speaker-names:accept' satisfies InvokeChannel, req),
    reject: (req) => ipcRenderer.invoke('speaker-names:reject' satisfies InvokeChannel, req),
    onChanged: (cb) => {
      const listener = (_e: IpcRendererEvent, p: PushPayload<'speaker-names:changed'>): void => cb(p)
      ipcRenderer.on('speaker-names:changed' satisfies PushChannel, listener)
      return () => {
        ipcRenderer.removeListener('speaker-names:changed' satisfies PushChannel, listener)
      }
    }
  },
  recordings: {
    list: (req) => ipcRenderer.invoke('recordings:list' satisfies InvokeChannel, req),
    export: (req) => ipcRenderer.invoke('recordings:export' satisfies InvokeChannel, req),
    delete: (req) => ipcRenderer.invoke('recordings:delete' satisfies InvokeChannel, req),
    usage: () => ipcRenderer.invoke('recordings:usage' satisfies InvokeChannel),
    deleteAll: (req) => ipcRenderer.invoke('recordings:delete-all' satisfies InvokeChannel, req)
  },
  imports: {
    start: (req) => ipcRenderer.invoke('imports:start' satisfies InvokeChannel, req),
    list: () => ipcRenderer.invoke('imports:list' satisfies InvokeChannel),
    dismiss: (req) => ipcRenderer.invoke('imports:dismiss' satisfies InvokeChannel, req),
    onChanged: (cb) => {
      const listener = (_e: IpcRendererEvent, p: PushPayload<'imports:changed'>): void => cb(p)
      ipcRenderer.on('imports:changed' satisfies PushChannel, listener)
      return () => {
        ipcRenderer.removeListener('imports:changed' satisfies PushChannel, listener)
      }
    }
  },
  files: {
    pathForFile: (file) => webUtils.getPathForFile(file)
  },
  attachments: {
    addImages: (req) => ipcRenderer.invoke('attachments:add-images' satisfies InvokeChannel, req),
    addFiles: (req) => ipcRenderer.invoke('attachments:add-files' satisfies InvokeChannel, req),
    list: (req) => ipcRenderer.invoke('attachments:list' satisfies InvokeChannel, req),
    remove: (req) => ipcRenderer.invoke('attachments:remove' satisfies InvokeChannel, req),
    read: (req) => ipcRenderer.invoke('attachments:read' satisfies InvokeChannel, req),
    copyImage: (req) => ipcRenderer.invoke('attachments:copy-image' satisfies InvokeChannel, req),
    saveAs: (req) => ipcRenderer.invoke('attachments:save-as' satisfies InvokeChannel, req),
    onChanged: (cb) => {
      const listener = (_e: IpcRendererEvent, p: PushPayload<'attachments:changed'>): void => cb(p)
      ipcRenderer.on('attachments:changed' satisfies PushChannel, listener)
      return () => {
        ipcRenderer.removeListener('attachments:changed' satisfies PushChannel, listener)
      }
    }
  },
  attachedLinks: {
    update: (req) => ipcRenderer.invoke('attached-links:update' satisfies InvokeChannel, req)
  },
  actionItems: {
    list: (req) => ipcRenderer.invoke('action-items:list' satisfies InvokeChannel, req),
    review: (req) => ipcRenderer.invoke('action-items:review' satisfies InvokeChannel, req),
    archive: (req) => ipcRenderer.invoke('action-items:archive' satisfies InvokeChannel, req),
    feedback: (req) => ipcRenderer.invoke('action-items:feedback' satisfies InvokeChannel, req),
    regeneratePreview: () => ipcRenderer.invoke('action-items:regenerate-preview' satisfies InvokeChannel),
    onRegenerateProgress: (cb) => {
      const listener = (_e: IpcRendererEvent, p: PushPayload<'action-items:regenerate-progress'>): void => cb(p)
      ipcRenderer.on('action-items:regenerate-progress' satisfies PushChannel, listener)
      return () => {
        ipcRenderer.removeListener('action-items:regenerate-progress' satisfies PushChannel, listener)
      }
    },
    applyRegenerated: (req) => ipcRenderer.invoke('action-items:apply-regenerated' satisfies InvokeChannel, req),
    startDraft: (req) => ipcRenderer.invoke('action-items:start-draft' satisfies InvokeChannel, req),
    onChanged: (cb) => {
      const listener = (_e: IpcRendererEvent, p: PushPayload<'action-items:changed'>): void => cb(p)
      ipcRenderer.on('action-items:changed' satisfies PushChannel, listener)
      return () => {
        ipcRenderer.removeListener('action-items:changed' satisfies PushChannel, listener)
      }
    }
  },
  tags: {
    classify: (req) => ipcRenderer.invoke('tags:classify' satisfies InvokeChannel, req)
  },
  followUp: {
    get: (req) => ipcRenderer.invoke('follow-up:get' satisfies InvokeChannel, req),
    generate: (req) => ipcRenderer.invoke('follow-up:generate' satisfies InvokeChannel, req),
    onProgress: (cb) => {
      const listener = (_e: IpcRendererEvent, p: PushPayload<'follow-up:progress'>): void => cb(p)
      ipcRenderer.on('follow-up:progress' satisfies PushChannel, listener)
      return () => {
        ipcRenderer.removeListener('follow-up:progress' satisfies PushChannel, listener)
      }
    },
    onResult: (cb) => {
      const listener = (_e: IpcRendererEvent, p: PushPayload<'follow-up:result'>): void => cb(p)
      ipcRenderer.on('follow-up:result' satisfies PushChannel, listener)
      return () => {
        ipcRenderer.removeListener('follow-up:result' satisfies PushChannel, listener)
      }
    },
    onError: (cb) => {
      const listener = (_e: IpcRendererEvent, p: PushPayload<'follow-up:error'>): void => cb(p)
      ipcRenderer.on('follow-up:error' satisfies PushChannel, listener)
      return () => {
        ipcRenderer.removeListener('follow-up:error' satisfies PushChannel, listener)
      }
    },
    rewrite: (req) => ipcRenderer.invoke('follow-up:rewrite' satisfies InvokeChannel, req),
    update: (req) => ipcRenderer.invoke('follow-up:update' satisfies InvokeChannel, req),
    handoff: (req) => ipcRenderer.invoke('follow-up:handoff' satisfies InvokeChannel, req),
    discard: (req) => ipcRenderer.invoke('follow-up:discard' satisfies InvokeChannel, req),
    listSuggested: () => ipcRenderer.invoke('follow-up:list-suggested' satisfies InvokeChannel)
  },
  companies: {
    list: (req) => ipcRenderer.invoke('companies:list' satisfies InvokeChannel, req),
    get: (req) => ipcRenderer.invoke('companies:get' satisfies InvokeChannel, req),
    icon: (req) => ipcRenderer.invoke('companies:icon' satisfies InvokeChannel, req)
  },
  quickAsk: {
    onVisible: (cb) => {
      const listener = (_e: IpcRendererEvent, p: PushPayload<'quick-ask:shown'>): void => cb(p)
      ipcRenderer.on('quick-ask:shown' satisfies PushChannel, listener)
      return () => {
        ipcRenderer.removeListener('quick-ask:shown' satisfies PushChannel, listener)
      }
    },
    submit: (p) => ipcRenderer.send('quick-ask:send' satisfies SendChannel, p),
    dismiss: () => ipcRenderer.send('quick-ask:close' satisfies SendChannel),
    onMessage: (cb) => {
      const listener = (_e: IpcRendererEvent, p: PushPayload<'quick-ask:send-chat-message'>): void => cb(p)
      ipcRenderer.on('quick-ask:send-chat-message' satisfies PushChannel, listener)
      return () => {
        ipcRenderer.removeListener('quick-ask:send-chat-message' satisfies PushChannel, listener)
      }
    },
    getPending: () => ipcRenderer.invoke('quick-ask:get-pending' satisfies InvokeChannel),
    getStatus: () => ipcRenderer.invoke('quick-ask:get-status' satisfies InvokeChannel)
  },
  captions: {
    getState: () => ipcRenderer.invoke('captions:get-state' satisfies InvokeChannel),
    setEnabled: (req) => ipcRenderer.invoke('captions:set-enabled' satisfies InvokeChannel, req),
    setMode: (req) => ipcRenderer.invoke('captions:set-mode' satisfies InvokeChannel, req),
    onState: (cb) => {
      const listener = (_e: IpcRendererEvent, p: PushPayload<'captions:state'>): void => cb(p)
      ipcRenderer.on('captions:state' satisfies PushChannel, listener)
      return () => {
        ipcRenderer.removeListener('captions:state' satisfies PushChannel, listener)
      }
    }
  },
  briefs: {
    get: (req) => ipcRenderer.invoke('briefs:get' satisfies InvokeChannel, req),
    ensure: (req) => ipcRenderer.invoke('briefs:ensure' satisfies InvokeChannel, req),
    onChanged: (cb) => {
      const listener = (_e: IpcRendererEvent, p: PushPayload<'briefs:changed'>): void => cb(p)
      ipcRenderer.on('briefs:changed' satisfies PushChannel, listener)
      return () => {
        ipcRenderer.removeListener('briefs:changed' satisfies PushChannel, listener)
      }
    }
  },
  demo: {
    start: () => ipcRenderer.invoke('demo:start' satisfies InvokeChannel),
    join: (p) => ipcRenderer.send('demo:join' satisfies SendChannel, p),
    close: () => ipcRenderer.send('demo:close' satisfies SendChannel),
    isActive: () => ipcRenderer.invoke('demo:is-active' satisfies InvokeChannel),
    getState: () => ipcRenderer.invoke('demo:get-state' satisfies InvokeChannel),
    setPlaying: (p) => ipcRenderer.send('demo:set-playing' satisfies SendChannel, p),
    onStateChanged: (cb) => {
      const listener = (_e: IpcRendererEvent, p: PushPayload<'demo:state-changed'>): void => cb(p)
      ipcRenderer.on('demo:state-changed' satisfies PushChannel, listener)
      return () => {
        ipcRenderer.removeListener('demo:state-changed' satisfies PushChannel, listener)
      }
    },
    onClosed: (cb) => {
      const listener = (): void => cb()
      ipcRenderer.on('demo:closed' satisfies PushChannel, listener)
      return () => {
        ipcRenderer.removeListener('demo:closed' satisfies PushChannel, listener)
      }
    }
  },
  screenSnapshots: {
    listSources: () => ipcRenderer.invoke('screen-snapshots:list-sources' satisfies InvokeChannel),
    openPicker: (p) => ipcRenderer.send('screen-snapshots:open-picker' satisfies SendChannel, p),
    start: (req) => ipcRenderer.invoke('screen-snapshots:start' satisfies InvokeChannel, req),
    stop: (req) => ipcRenderer.invoke('screen-snapshots:stop' satisfies InvokeChannel, req),
    getState: (req) => ipcRenderer.invoke('screen-snapshots:get-state' satisfies InvokeChannel, req),
    onState: (cb) => {
      const listener = (_e: IpcRendererEvent, p: PushPayload<'screen-snapshots:state'>): void => cb(p)
      ipcRenderer.on('screen-snapshots:state' satisfies PushChannel, listener)
      return () => {
        ipcRenderer.removeListener('screen-snapshots:state' satisfies PushChannel, listener)
      }
    },
    onAdded: (cb) => {
      const listener = (_e: IpcRendererEvent, p: PushPayload<'screen-snapshots:added'>): void => cb(p)
      ipcRenderer.on('screen-snapshots:added' satisfies PushChannel, listener)
      return () => {
        ipcRenderer.removeListener('screen-snapshots:added' satisfies PushChannel, listener)
      }
    }
  },
  snapshotRegion: {
    ready: () => ipcRenderer.send('snapshot-region:ready' satisfies SendChannel),
    done: (p) => ipcRenderer.send('snapshot-region:done' satisfies SendChannel, p),
    cancel: () => ipcRenderer.send('snapshot-region:cancel' satisfies SendChannel),
    onImage: (cb) => {
      const listener = (_e: IpcRendererEvent, p: PushPayload<'snapshot-region:image'>): void => cb(p)
      ipcRenderer.on('snapshot-region:image' satisfies PushChannel, listener)
      return () => {
        ipcRenderer.removeListener('snapshot-region:image' satisfies PushChannel, listener)
      }
    }
  },
  screenGuide: {
    open: () => ipcRenderer.send('screen-guide:open' satisfies SendChannel),
    dismiss: () => ipcRenderer.send('screen-guide:dismiss' satisfies SendChannel),
    getConfig: () => ipcRenderer.invoke('screen-guide:get-config' satisfies InvokeChannel),
    ready: () => ipcRenderer.send('screen-guide:ready' satisfies SendChannel),
    startDrag: (p) => ipcRenderer.send('screen-guide:start-drag' satisfies SendChannel, p),
    onLayout: (cb) => {
      const listener = (_e: IpcRendererEvent, p: PushPayload<'screen-guide:layout'>): void => cb(p)
      ipcRenderer.on('screen-guide:layout' satisfies PushChannel, listener)
      return () => {
        ipcRenderer.removeListener('screen-guide:layout' satisfies PushChannel, listener)
      }
    },
    onClosed: (cb) => {
      const listener = (): void => cb()
      ipcRenderer.on('screen-guide:closed' satisfies PushChannel, listener)
      return () => {
        ipcRenderer.removeListener('screen-guide:closed' satisfies PushChannel, listener)
      }
    }
  },
  integrations: {
    status: (req) => ipcRenderer.invoke('integrations:status' satisfies InvokeChannel, req),
    setCredential: (req) => ipcRenderer.invoke('integrations:set-credential' satisfies InvokeChannel, req),
    removeCredential: (req) => ipcRenderer.invoke('integrations:remove-credential' satisfies InvokeChannel, req),
    validate: (req) => ipcRenderer.invoke('integrations:validate' satisfies InvokeChannel, req),
    listDestinations: (req) => ipcRenderer.invoke('integrations:list-destinations' satisfies InvokeChannel, req),
    saveDestination: (req) => ipcRenderer.invoke('integrations:save-destination' satisfies InvokeChannel, req),
    testDestination: (req) => ipcRenderer.invoke('integrations:test-destination' satisfies InvokeChannel, req),
    search: (req) => ipcRenderer.invoke('integrations:search' satisfies InvokeChannel, req),
    share: (req) => ipcRenderer.invoke('integrations:share' satisfies InvokeChannel, req),
    listAutomations: (req) => ipcRenderer.invoke('integrations:list-automations' satisfies InvokeChannel, req),
    setAutomation: (req) => ipcRenderer.invoke('integrations:set-automation' satisfies InvokeChannel, req),
    listDeliveries: (req) => ipcRenderer.invoke('integrations:list-deliveries' satisfies InvokeChannel, req),
    retryDelivery: (req) => ipcRenderer.invoke('integrations:retry-delivery' satisfies InvokeChannel, req),
    cancelDelivery: (req) => ipcRenderer.invoke('integrations:cancel-delivery' satisfies InvokeChannel, req),
    slackDraft: (req) => ipcRenderer.invoke('integrations:slack-draft' satisfies InvokeChannel, req),
    onChanged: (cb) => {
      const listener = (_e: IpcRendererEvent, p: PushPayload<'integrations:changed'>): void => cb(p)
      ipcRenderer.on('integrations:changed' satisfies PushChannel, listener)
      return () => {
        ipcRenderer.removeListener('integrations:changed' satisfies PushChannel, listener)
      }
    },
    onDelivery: (cb) => {
      const listener = (_e: IpcRendererEvent, p: PushPayload<'integrations:delivery'>): void => cb(p)
      ipcRenderer.on('integrations:delivery' satisfies PushChannel, listener)
      return () => {
        ipcRenderer.removeListener('integrations:delivery' satisfies PushChannel, listener)
      }
    },
    connectOAuth: (req) => ipcRenderer.invoke('integrations:connect-oauth' satisfies InvokeChannel, req),
    cancelOAuth: (req) => ipcRenderer.invoke('integrations:cancel-oauth' satisfies InvokeChannel, req)
  },
  mcp: {
    listServers: () => ipcRenderer.invoke('mcp:list-servers' satisfies InvokeChannel),
    addServer: (req) => ipcRenderer.invoke('mcp:add-server' satisfies InvokeChannel, req),
    updateServer: (req) => ipcRenderer.invoke('mcp:update-server' satisfies InvokeChannel, req),
    removeServer: (req) => ipcRenderer.invoke('mcp:remove-server' satisfies InvokeChannel, req),
    reconnectServer: (req) => ipcRenderer.invoke('mcp:reconnect-server' satisfies InvokeChannel, req),
    listTools: (req) => ipcRenderer.invoke('mcp:list-tools' satisfies InvokeChannel, req),
    setToolPolicy: (req) => ipcRenderer.invoke('mcp:set-tool-policy' satisfies InvokeChannel, req),
    getLog: (req) => ipcRenderer.invoke('mcp:get-log' satisfies InvokeChannel, req),
    onChanged: (cb) => {
      const listener = (_e: IpcRendererEvent, p: PushPayload<'mcp:changed'>): void => cb(p)
      ipcRenderer.on('mcp:changed' satisfies PushChannel, listener)
      return () => {
        ipcRenderer.removeListener('mcp:changed' satisfies PushChannel, listener)
      }
    }
  },
  mcpServer: {
    getStatus: () => ipcRenderer.invoke('mcp-server:get-status' satisfies InvokeChannel),
    setConfig: (req) => ipcRenderer.invoke('mcp-server:set-config' satisfies InvokeChannel, req),
    createToken: (req) => ipcRenderer.invoke('mcp-server:create-token' satisfies InvokeChannel, req),
    listTokens: () => ipcRenderer.invoke('mcp-server:list-tokens' satisfies InvokeChannel),
    revokeToken: (req) => ipcRenderer.invoke('mcp-server:revoke-token' satisfies InvokeChannel, req),
    getStdioConfig: (req) => ipcRenderer.invoke('mcp-server:get-stdio-config' satisfies InvokeChannel, req),
    getActivity: () => ipcRenderer.invoke('mcp-server:get-activity' satisfies InvokeChannel),
    onChanged: (cb) => {
      const listener = (_e: IpcRendererEvent, p: PushPayload<'mcp-server:changed'>): void => cb(p)
      ipcRenderer.on('mcp-server:changed' satisfies PushChannel, listener)
      return () => {
        ipcRenderer.removeListener('mcp-server:changed' satisfies PushChannel, listener)
      }
    }
  },
  dictation: {
    getStatus: () => ipcRenderer.invoke('dictation:get-status' satisfies InvokeChannel),
    setShortcut: (req) => ipcRenderer.invoke('dictation:set-shortcut' satisfies InvokeChannel, req),
    suspendShortcut: (p) => ipcRenderer.send('dictation:suspend-shortcut' satisfies SendChannel, p),
    onState: (cb) => {
      const listener = (_e: IpcRendererEvent, p: PushPayload<'dictation:state'>): void => cb(p)
      ipcRenderer.on('dictation:state' satisfies PushChannel, listener)
      return () => {
        ipcRenderer.removeListener('dictation:state' satisfies PushChannel, listener)
      }
    },
    onCapture: (cb) => {
      const listener = (_e: IpcRendererEvent, p: PushPayload<'dictation:capture'>): void => cb(p)
      ipcRenderer.on('dictation:capture' satisfies PushChannel, listener)
      return () => {
        ipcRenderer.removeListener('dictation:capture' satisfies PushChannel, listener)
      }
    },
    sendAudio: (p) => ipcRenderer.send('dictation:audio' satisfies SendChannel, p),
    captureEvent: (p) => ipcRenderer.send('dictation:capture-event' satisfies SendChannel, p),
    pillAction: (p) => ipcRenderer.send('dictation:pill-action' satisfies SendChannel, p),
    history: {
      list: () => ipcRenderer.invoke('dictation:history-list' satisfies InvokeChannel),
      delete: (req) => ipcRenderer.invoke('dictation:history-delete' satisfies InvokeChannel, req),
      clear: (req) => ipcRenderer.invoke('dictation:history-clear' satisfies InvokeChannel, req),
      retry: (req) => ipcRenderer.invoke('dictation:history-retry' satisfies InvokeChannel, req),
      onChanged: (cb) => {
        const listener = (): void => cb()
        ipcRenderer.on('dictation:history-changed' satisfies PushChannel, listener)
        return () => {
          ipcRenderer.removeListener('dictation:history-changed' satisfies PushChannel, listener)
        }
      }
    },
    chatStart: (req) => ipcRenderer.invoke('dictation:chat-start' satisfies InvokeChannel, req),
    chatStop: (req) => ipcRenderer.invoke('dictation:chat-stop' satisfies InvokeChannel, req),
    chatCancel: (p) => ipcRenderer.send('dictation:chat-cancel' satisfies SendChannel, p)
  },
  dictationBar: {
    onState: (cb) => {
      const listener = (_e: IpcRendererEvent, p: PushPayload<'dictation-bar:state'>): void => cb(p)
      ipcRenderer.on('dictation-bar:state' satisfies PushChannel, listener)
      return () => {
        ipcRenderer.removeListener('dictation-bar:state' satisfies PushChannel, listener)
      }
    },
    action: (req) => ipcRenderer.invoke('dictation-bar:action' satisfies InvokeChannel, req),
    reportHitRects: (p) => ipcRenderer.send('dictation-bar:hit-rects' satisfies SendChannel, p),
    drag: (p) => ipcRenderer.send('dictation-bar:drag' satisfies SendChannel, p),
    onMenu: (cb) => {
      const listener = (_e: IpcRendererEvent, p: PushPayload<'dictation-bar:menu'>): void => cb(p)
      ipcRenderer.on('dictation-bar:menu' satisfies PushChannel, listener)
      return () => {
        ipcRenderer.removeListener('dictation-bar:menu' satisfies PushChannel, listener)
      }
    },
    pickMenu: (p) => ipcRenderer.send('dictation-bar:menu-pick' satisfies SendChannel, p)
  },
  netdoctor: {
    run: () => ipcRenderer.invoke('netdoctor:run' satisfies InvokeChannel),
    cancel: () => ipcRenderer.invoke('netdoctor:cancel' satisfies InvokeChannel),
    onProgress: (cb) => {
      const listener = (_e: IpcRendererEvent, p: PushPayload<'netdoctor:progress'>): void => cb(p)
      ipcRenderer.on('netdoctor:progress' satisfies PushChannel, listener)
      return () => {
        ipcRenderer.removeListener('netdoctor:progress' satisfies PushChannel, listener)
      }
    }
  },
  scratchpad: {
    listDays: () => ipcRenderer.invoke('scratchpad:list-days' satisfies InvokeChannel),
    getDay: (req) => ipcRenderer.invoke('scratchpad:get-day' satisfies InvokeChannel, req),
    saveDay: (req) => ipcRenderer.invoke('scratchpad:save-day' satisfies InvokeChannel, req),
    onChanged: (cb) => {
      const listener = (_e: IpcRendererEvent, p: PushPayload<'scratchpad:changed'>): void => cb(p)
      ipcRenderer.on('scratchpad:changed' satisfies PushChannel, listener)
      return () => {
        ipcRenderer.removeListener('scratchpad:changed' satisfies PushChannel, listener)
      }
    }
  },
  window: {
    setMode: (p) => ipcRenderer.send('window:mode' satisfies SendChannel, p),
    ensureMinWidth: (p) => ipcRenderer.send('window:ensure-min-width' satisfies SendChannel, p),
    showPreview: (p) => ipcRenderer.send('window:preview-show' satisfies SendChannel, p),
    hidePreview: () => ipcRenderer.send('window:preview-hide' satisfies SendChannel),
    onModeChanged: (cb) => {
      const listener = (_e: IpcRendererEvent, p: PushPayload<'window:mode-changed'>): void => cb(p)
      ipcRenderer.on('window:mode-changed' satisfies PushChannel, listener)
      return () => {
        ipcRenderer.removeListener('window:mode-changed' satisfies PushChannel, listener)
      }
    },
    getMode: () => ipcRenderer.invoke('window:get-mode' satisfies InvokeChannel),
    onPreviewSrc: (cb) => {
      const listener = (_e: IpcRendererEvent, p: PushPayload<'window:preview-src'>): void => cb(p)
      ipcRenderer.on('window:preview-src' satisfies PushChannel, listener)
      return () => {
        ipcRenderer.removeListener('window:preview-src' satisfies PushChannel, listener)
      }
    },
    previewReady: () => ipcRenderer.send('window:preview-ready' satisfies SendChannel),
    previewLoaded: () => ipcRenderer.send('window:preview-loaded' satisfies SendChannel)
  },
  screenCorner: {
    onVisible: (cb) => {
      const listener = (_e: IpcRendererEvent, p: PushPayload<'screen-corner:visible'>): void => cb(p)
      ipcRenderer.on('screen-corner:visible' satisfies PushChannel, listener)
      return () => {
        ipcRenderer.removeListener('screen-corner:visible' satisfies PushChannel, listener)
      }
    },
    click: () => ipcRenderer.send('screen-corner:click' satisfies SendChannel)
  },
  diag: {
    exportLogs: () => ipcRenderer.invoke('diag:export-logs' satisfies InvokeChannel),
    showLogsFolder: () => ipcRenderer.send('diag:show-logs-folder' satisfies SendChannel),
    startTrace: () => ipcRenderer.invoke('diag:trace-start' satisfies InvokeChannel),
    onTraceState: (cb) => {
      const listener = (_e: IpcRendererEvent, p: PushPayload<'diag:trace-state'>): void => cb(p)
      ipcRenderer.on('diag:trace-state' satisfies PushChannel, listener)
      return () => {
        ipcRenderer.removeListener('diag:trace-state' satisfies PushChannel, listener)
      }
    },
    toggleUnifiedLog: () => ipcRenderer.invoke('diag:unified-log-toggle' satisfies InvokeChannel),
    unifiedLogStatus: () => ipcRenderer.invoke('diag:unified-log-status' satisfies InvokeChannel)
  },
  shortcuts: {
    list: () => ipcRenderer.invoke('shortcuts:list' satisfies InvokeChannel),
    set: (req) => ipcRenderer.invoke('shortcuts:set' satisfies InvokeChannel, req),
    onHookStatus: (cb) => {
      const listener = (_e: IpcRendererEvent, p: PushPayload<'shortcuts:hook-status'>): void => cb(p)
      ipcRenderer.on('shortcuts:hook-status' satisfies PushChannel, listener)
      return () => {
        ipcRenderer.removeListener('shortcuts:hook-status' satisfies PushChannel, listener)
      }
    },
    onChanged: (cb) => {
      const listener = (): void => cb()
      ipcRenderer.on('shortcuts:changed' satisfies PushChannel, listener)
      return () => {
        ipcRenderer.removeListener('shortcuts:changed' satisfies PushChannel, listener)
      }
    }
  },
  dataExport: {
    chooseFolder: () => ipcRenderer.invoke('export:choose-folder' satisfies InvokeChannel),
    start: (req) => ipcRenderer.invoke('export:start' satisfies InvokeChannel, req),
    cancel: (req) => ipcRenderer.invoke('export:cancel' satisfies InvokeChannel, req),
    onProgress: (cb) => {
      const listener = (_e: IpcRendererEvent, p: PushPayload<'export:progress'>): void => cb(p)
      ipcRenderer.on('export:progress' satisfies PushChannel, listener)
      return () => {
        ipcRenderer.removeListener('export:progress' satisfies PushChannel, listener)
      }
    },
    onDone: (cb) => {
      const listener = (_e: IpcRendererEvent, p: PushPayload<'export:done'>): void => cb(p)
      ipcRenderer.on('export:done' satisfies PushChannel, listener)
      return () => {
        ipcRenderer.removeListener('export:done' satisfies PushChannel, listener)
      }
    }
  },
  consent: {
    getStatus: (req) => ipcRenderer.invoke('consent:get-status' satisfies InvokeChannel, req),
    onStatusChanged: (cb) => {
      const listener = (_e: IpcRendererEvent, p: PushPayload<'consent:status-changed'>): void => cb(p)
      ipcRenderer.on('consent:status-changed' satisfies PushChannel, listener)
      return () => {
        ipcRenderer.removeListener('consent:status-changed' satisfies PushChannel, listener)
      }
    },
    postNow: (req) => ipcRenderer.invoke('consent:post-now' satisfies InvokeChannel, req),
    copyMessage: (req) => ipcRenderer.invoke('consent:copy-message' satisfies InvokeChannel, req),
    markPosted: (req) => ipcRenderer.invoke('consent:mark-posted' satisfies InvokeChannel, req),
    resolvePending: (req) => ipcRenderer.invoke('consent:resolve-pending' satisfies InvokeChannel, req)
  },
  voiceprint: {
    getStatus: () => ipcRenderer.invoke('voiceprint:get-status' satisfies InvokeChannel),
    recordSample: (req) => ipcRenderer.invoke('voiceprint:record-sample' satisfies InvokeChannel, req),
    sendSampleAudio: (p) => ipcRenderer.send('voiceprint:sample-audio' satisfies SendChannel, p),
    onSampleProgress: (cb) => {
      const listener = (_e: IpcRendererEvent, p: PushPayload<'voiceprint:sample-progress'>): void => cb(p)
      ipcRenderer.on('voiceprint:sample-progress' satisfies PushChannel, listener)
      return () => {
        ipcRenderer.removeListener('voiceprint:sample-progress' satisfies PushChannel, listener)
      }
    },
    cancelSample: (p) => ipcRenderer.send('voiceprint:cancel-sample' satisfies SendChannel, p),
    setPassive: (req) => ipcRenderer.invoke('voiceprint:set-passive' satisfies InvokeChannel, req),
    identifyNote: (req) => ipcRenderer.invoke('voiceprint:identify-note' satisfies InvokeChannel, req),
    forget: () => ipcRenderer.invoke('voiceprint:forget' satisfies InvokeChannel),
    onStatusChanged: (cb) => {
      const listener = (_e: IpcRendererEvent, p: PushPayload<'voiceprint:status-changed'>): void => cb(p)
      ipcRenderer.on('voiceprint:status-changed' satisfies PushChannel, listener)
      return () => {
        ipcRenderer.removeListener('voiceprint:status-changed' satisfies PushChannel, listener)
      }
    }
  },
  transcriptReport: {
    create: (req) => ipcRenderer.invoke('transcript-report:create' satisfies InvokeChannel, req),
    list: (req) => ipcRenderer.invoke('transcript-report:list' satisfies InvokeChannel, req),
    delete: (req) => ipcRenderer.invoke('transcript-report:delete' satisfies InvokeChannel, req),
    export: (req) => ipcRenderer.invoke('transcript-report:export' satisfies InvokeChannel, req)
  },
  retention: {
    get: () => ipcRenderer.invoke('retention:get' satisfies InvokeChannel),
    preview: (req) => ipcRenderer.invoke('retention:preview' satisfies InvokeChannel, req),
    set: (req) => ipcRenderer.invoke('retention:set' satisfies InvokeChannel, req),
    cancelPending: () => ipcRenderer.invoke('retention:cancel-pending' satisfies InvokeChannel),
    getLog: () => ipcRenderer.invoke('retention:get-log' satisfies InvokeChannel),
    onChanged: (cb) => {
      const listener = (_e: IpcRendererEvent, p: PushPayload<'retention:changed'>): void => cb(p)
      ipcRenderer.on('retention:changed' satisfies PushChannel, listener)
      return () => {
        ipcRenderer.removeListener('retention:changed' satisfies PushChannel, listener)
      }
    }
  },
  meetingDock: {
    show: () => ipcRenderer.invoke('meeting-dock:show' satisfies InvokeChannel),
    close: () => ipcRenderer.invoke('meeting-dock:close' satisfies InvokeChannel),
    setBounds: (p) => ipcRenderer.send('meeting-dock:set-bounds' satisfies SendChannel, p),
    setView: (p) => ipcRenderer.send('meeting-dock:set-view' satisfies SendChannel, p),
    getState: () => ipcRenderer.invoke('meeting-dock:get-state' satisfies InvokeChannel),
    onState: (cb) => {
      const listener = (_e: IpcRendererEvent, p: PushPayload<'meeting-dock:state'>): void => cb(p)
      ipcRenderer.on('meeting-dock:state' satisfies PushChannel, listener)
      return () => {
        ipcRenderer.removeListener('meeting-dock:state' satisfies PushChannel, listener)
      }
    },
    getHistory: (req) => ipcRenderer.invoke('meeting-dock:history-get' satisfies InvokeChannel, req),
    saveHistory: (req) => ipcRenderer.invoke('meeting-dock:history-save' satisfies InvokeChannel, req)
  },
  liveContext: {
    onCard: (cb) => {
      const listener = (_e: IpcRendererEvent, p: PushPayload<'live-context:card'>): void => cb(p)
      ipcRenderer.on('live-context:card' satisfies PushChannel, listener)
      return () => {
        ipcRenderer.removeListener('live-context:card' satisfies PushChannel, listener)
      }
    },
    getCard: () => ipcRenderer.invoke('live-context:get-card' satisfies InvokeChannel),
    dismiss: (p) => ipcRenderer.send('live-context:dismiss' satisfies SendChannel, p),
    setIgnoreMouse: (p) => ipcRenderer.send('live-context:set-ignore-mouse' satisfies SendChannel, p),
    openDraft: (req) => ipcRenderer.invoke('live-context:open-draft' satisfies InvokeChannel, req),
    rate: (p) => ipcRenderer.send('live-context:rate' satisfies SendChannel, p)
  },
  reminders: {
    listActive: () => ipcRenderer.invoke('reminders:list-active' satisfies InvokeChannel),
    act: (p) => ipcRenderer.send('reminders:act' satisfies SendChannel, p),
    dismiss: (p) => ipcRenderer.send('reminders:dismiss' satisfies SendChannel, p),
    onChanged: (cb) => {
      const listener = (): void => cb()
      ipcRenderer.on('reminders:changed' satisfies PushChannel, listener)
      return () => {
        ipcRenderer.removeListener('reminders:changed' satisfies PushChannel, listener)
      }
    }
  },
  reminderCards: {
    getState: () => ipcRenderer.invoke('reminder-cards:get-state' satisfies InvokeChannel),
    action: (p) => ipcRenderer.send('reminder-cards:action' satisfies SendChannel, p),
    setIgnoreMouse: (p) => ipcRenderer.send('reminder-cards:set-ignore-mouse' satisfies SendChannel, p),
    resize: (p) => ipcRenderer.send('reminder-cards:resize' satisfies SendChannel, p),
    onCards: (cb) => {
      const listener = (_e: IpcRendererEvent, p: PushPayload<'reminder-cards:cards'>): void => cb(p)
      ipcRenderer.on('reminder-cards:cards' satisfies PushChannel, listener)
      return () => {
        ipcRenderer.removeListener('reminder-cards:cards' satisfies PushChannel, listener)
      }
    }
  },
  tasks: {
    list: (req) => ipcRenderer.invoke('tasks:list' satisfies InvokeChannel, req),
    toggle: (req) => ipcRenderer.invoke('tasks:toggle' satisfies InvokeChannel, req),
    add: (req) => ipcRenderer.invoke('tasks:add' satisfies InvokeChannel, req),
    delete: (req) => ipcRenderer.invoke('tasks:delete' satisfies InvokeChannel, req),
    getBadge: () => ipcRenderer.invoke('tasks:get-badge' satisfies InvokeChannel),
    onChanged: (cb) => {
      const listener = (): void => cb()
      ipcRenderer.on('tasks:changed' satisfies PushChannel, listener)
      return () => {
        ipcRenderer.removeListener('tasks:changed' satisfies PushChannel, listener)
      }
    }
  },
  summaryFeedback: {
    eligibility: (req) => ipcRenderer.invoke('summary-feedback:eligibility' satisfies InvokeChannel, req),
    shown: (req) => ipcRenderer.invoke('summary-feedback:shown' satisfies InvokeChannel, req),
    rate: (req) => ipcRenderer.invoke('summary-feedback:rate' satisfies InvokeChannel, req),
    dismiss: (req) => ipcRenderer.invoke('summary-feedback:dismiss' satisfies InvokeChannel, req),
    list: (req) => ipcRenderer.invoke('summary-feedback:list' satisfies InvokeChannel, req),
    suggestTemplateEdits: (req) => ipcRenderer.invoke('summary-feedback:suggest-template-edits' satisfies InvokeChannel, req)
  },
  userContext: {
    get: () => ipcRenderer.invoke('user-context:get' satisfies InvokeChannel),
    update: (req) => ipcRenderer.invoke('user-context:update' satisfies InvokeChannel, req),
    setNames: (req) => ipcRenderer.invoke('user-context:set-names' satisfies InvokeChannel, req),
    draft: (req) => ipcRenderer.invoke('user-context:draft' satisfies InvokeChannel, req),
    export: (req) => ipcRenderer.invoke('user-context:export' satisfies InvokeChannel, req),
    agents: () => ipcRenderer.invoke('user-context:agents' satisfies InvokeChannel),
    setAgentPaused: (req) => ipcRenderer.invoke('user-context:set-agent-paused' satisfies InvokeChannel, req),
    onDraftProgress: (cb) => {
      const listener = (_e: IpcRendererEvent, p: PushPayload<'user-context:draft-progress'>): void => cb(p)
      ipcRenderer.on('user-context:draft-progress' satisfies PushChannel, listener)
      return () => {
        ipcRenderer.removeListener('user-context:draft-progress' satisfies PushChannel, listener)
      }
    },
    onChanged: (cb) => {
      const listener = (): void => cb()
      ipcRenderer.on('user-context:changed' satisfies PushChannel, listener)
      return () => {
        ipcRenderer.removeListener('user-context:changed' satisfies PushChannel, listener)
      }
    }
  },
  dispatch: {
    list: (req) => ipcRenderer.invoke('dispatch:list' satisfies InvokeChannel, req),
    runNote: (req) => ipcRenderer.invoke('dispatch:run-note' satisfies InvokeChannel, req),
    runMorning: () => ipcRenderer.invoke('dispatch:run-morning' satisfies InvokeChannel),
    setStatus: (req) => ipcRenderer.invoke('dispatch:set-status' satisfies InvokeChannel, req),
    start: (req) => ipcRenderer.invoke('dispatch:start' satisfies InvokeChannel, req),
    onChanged: (cb) => {
      const listener = (): void => cb()
      ipcRenderer.on('dispatch:changed' satisfies PushChannel, listener)
      return () => {
        ipcRenderer.removeListener('dispatch:changed' satisfies PushChannel, listener)
      }
    }
  },
  localApi: {
    getStatus: () => ipcRenderer.invoke('local-api:get-status' satisfies InvokeChannel),
    setEnabled: (req) => ipcRenderer.invoke('local-api:set-enabled' satisfies InvokeChannel, req),
    listKeys: () => ipcRenderer.invoke('local-api:list-keys' satisfies InvokeChannel),
    createKey: (req) => ipcRenderer.invoke('local-api:create-key' satisfies InvokeChannel, req),
    updateKey: (req) => ipcRenderer.invoke('local-api:update-key' satisfies InvokeChannel, req),
    revokeKey: (req) => ipcRenderer.invoke('local-api:revoke-key' satisfies InvokeChannel, req),
    deleteKey: (req) => ipcRenderer.invoke('local-api:delete-key' satisfies InvokeChannel, req),
    getActivity: () => ipcRenderer.invoke('local-api:get-activity' satisfies InvokeChannel),
    onChanged: (cb) => {
      const listener = (_e: IpcRendererEvent, p: PushPayload<'local-api:changed'>): void => cb(p)
      ipcRenderer.on('local-api:changed' satisfies PushChannel, listener)
      return () => {
        ipcRenderer.removeListener('local-api:changed' satisfies PushChannel, listener)
      }
    }
  },
  companionCli: {
    getStatus: () => ipcRenderer.invoke('companion-cli:get-status' satisfies InvokeChannel),
    install: (req) => ipcRenderer.invoke('companion-cli:install' satisfies InvokeChannel, req),
    remove: (req) => ipcRenderer.invoke('companion-cli:remove' satisfies InvokeChannel, req),
    openLocation: () => ipcRenderer.invoke('companion-cli:open-location' satisfies InvokeChannel)
  },
  device: {
    getInfo: () => ipcRenderer.invoke('device:get-info' satisfies InvokeChannel),
    revealDataFolder: () => ipcRenderer.send('device:reveal-data-folder' satisfies SendChannel)
  },
  licenses: {
    get: () => ipcRenderer.invoke('licenses:get' satisfies InvokeChannel),
    openFolder: () => ipcRenderer.send('licenses:open-folder' satisfies SendChannel)
  },
  feedback: {
    systemInfo: () => ipcRenderer.invoke('feedback:system-info' satisfies InvokeChannel),
    saveReport: (req) => ipcRenderer.invoke('feedback:save-report' satisfies InvokeChannel, req),
    open: (req) => ipcRenderer.invoke('feedback:open' satisfies InvokeChannel, req)
  },
  appIcon: {
    getState: () => ipcRenderer.invoke('app-icon:get-state' satisfies InvokeChannel),
    set: (req) => ipcRenderer.invoke('app-icon:set' satisfies InvokeChannel, req)
  },
  nux: {
    dismiss: (p) => ipcRenderer.send('nux:dismiss' satisfies SendChannel, p),
    increment: (p) => ipcRenderer.send('nux:increment' satisfies SendChannel, p),
    reset: () => ipcRenderer.invoke('nux:reset' satisfies InvokeChannel),
    getWhatsNew: () => ipcRenderer.invoke('nux:whats-new' satisfies InvokeChannel)
  },
  privacy: {
    dataUsage: () => ipcRenderer.invoke('privacy:data-usage' satisfies InvokeChannel),
    localOnlyStatus: () => ipcRenderer.invoke('privacy:local-only-status' satisfies InvokeChannel),
    setLocalOnly: (req) => ipcRenderer.invoke('privacy:set-local-only' satisfies InvokeChannel, req),
    onLocalOnlyChanged: (cb) => {
      const listener = (_e: IpcRendererEvent, p: PushPayload<'privacy:local-only-changed'>): void => cb(p)
      ipcRenderer.on('privacy:local-only-changed' satisfies PushChannel, listener)
      return () => {
        ipcRenderer.removeListener('privacy:local-only-changed' satisfies PushChannel, listener)
      }
    },
    listHeldSends: () => ipcRenderer.invoke('privacy:list-held-sends' satisfies InvokeChannel),
    releaseHeldSend: (req) => ipcRenderer.invoke('privacy:release-held-send' satisfies InvokeChannel, req)
  },
  deviceLock: {
    getStatus: () => ipcRenderer.invoke('device-lock:get-status' satisfies InvokeChannel),
    setEnabled: (req) => ipcRenderer.invoke('device-lock:set-enabled' satisfies InvokeChannel, req),
    unlock: () => ipcRenderer.invoke('device-lock:unlock' satisfies InvokeChannel),
    onChanged: (cb) => {
      const listener = (_e: IpcRendererEvent, p: PushPayload<'device-lock:changed'>): void => cb(p)
      ipcRenderer.on('device-lock:changed' satisfies PushChannel, listener)
      return () => {
        ipcRenderer.removeListener('device-lock:changed' satisfies PushChannel, listener)
      }
    }
  },
  transcriptionRules: {
    list: () => ipcRenderer.invoke('transcription-rules:list' satisfies InvokeChannel),
    save: (req) => ipcRenderer.invoke('transcription-rules:save' satisfies InvokeChannel, req),
    decide: (req) => ipcRenderer.invoke('transcription-rules:decide' satisfies InvokeChannel, req),
    resolve: (req) => ipcRenderer.invoke('transcription-rules:resolve' satisfies InvokeChannel, req),
    onDecision: (cb) => {
      const listener = (_e: IpcRendererEvent, p: PushPayload<'transcription-rules:decision'>): void => cb(p)
      ipcRenderer.on('transcription-rules:decision' satisfies PushChannel, listener)
      return () => {
        ipcRenderer.removeListener('transcription-rules:decision' satisfies PushChannel, listener)
      }
    }
  },
  blocks: {
    get: (req) => ipcRenderer.invoke('blocks:get' satisfies InvokeChannel, req),
    list: (req) => ipcRenderer.invoke('blocks:list' satisfies InvokeChannel, req),
    update: (req) => ipcRenderer.invoke('blocks:update' satisfies InvokeChannel, req),
    execute: (req) => ipcRenderer.invoke('blocks:execute' satisfies InvokeChannel, req),
    onChanged: (cb) => {
      const listener = (_e: IpcRendererEvent, p: PushPayload<'blocks:changed'>): void => cb(p)
      ipcRenderer.on('blocks:changed' satisfies PushChannel, listener)
      return () => {
        ipcRenderer.removeListener('blocks:changed' satisfies PushChannel, listener)
      }
    }
  },
  automations: {
    list: () => ipcRenderer.invoke('automations:list' satisfies InvokeChannel),
    save: (req) => ipcRenderer.invoke('automations:save' satisfies InvokeChannel, req),
    delete: (req) => ipcRenderer.invoke('automations:delete' satisfies InvokeChannel, req),
    listRuns: (req) => ipcRenderer.invoke('automations:list-runs' satisfies InvokeChannel, req),
    resolveRun: (req) => ipcRenderer.invoke('automations:resolve-run' satisfies InvokeChannel, req),
    onChanged: (cb) => {
      const listener = (_e: IpcRendererEvent, p: PushPayload<'automations:changed'>): void => cb(p)
      ipcRenderer.on('automations:changed' satisfies PushChannel, listener)
      return () => {
        ipcRenderer.removeListener('automations:changed' satisfies PushChannel, listener)
      }
    }
  },
  customerCalls: {
    status: () => ipcRenderer.invoke('customer-calls:status' satisfies InvokeChannel),
    enable: () => ipcRenderer.invoke('customer-calls:enable' satisfies InvokeChannel),
    disable: () => ipcRenderer.invoke('customer-calls:disable' satisfies InvokeChannel),
    setExclusions: (req) => ipcRenderer.invoke('customer-calls:set-exclusions' satisfies InvokeChannel, req),
    listBacklog: (req) => ipcRenderer.invoke('customer-calls:list-backlog' satisfies InvokeChannel, req),
    add: (req) => ipcRenderer.invoke('customer-calls:add' satisfies InvokeChannel, req),
    syncStatus: (req) => ipcRenderer.invoke('customer-calls:sync-status' satisfies InvokeChannel, req)
  },
  webhooks: {
    list: () => ipcRenderer.invoke('webhooks:list' satisfies InvokeChannel),
    create: (req) => ipcRenderer.invoke('webhooks:create' satisfies InvokeChannel, req),
    update: (req) => ipcRenderer.invoke('webhooks:update' satisfies InvokeChannel, req),
    delete: (req) => ipcRenderer.invoke('webhooks:delete' satisfies InvokeChannel, req),
    test: (req) => ipcRenderer.invoke('webhooks:test' satisfies InvokeChannel, req),
    rotateSecret: (req) => ipcRenderer.invoke('webhooks:rotate-secret' satisfies InvokeChannel, req),
    onChanged: (cb) => {
      const listener = (_e: IpcRendererEvent, p: PushPayload<'webhooks:changed'>): void => cb(p)
      ipcRenderer.on('webhooks:changed' satisfies PushChannel, listener)
      return () => {
        ipcRenderer.removeListener('webhooks:changed' satisfies PushChannel, listener)
      }
    }
  },
  mail: {
    status: () => ipcRenderer.invoke('mail:status' satisfies InvokeChannel),
    searchThreads: (req) => ipcRenderer.invoke('mail:search-threads' satisfies InvokeChannel, req),
    saveDraft: (req) => ipcRenderer.invoke('mail:save-draft' satisfies InvokeChannel, req),
    send: (req) => ipcRenderer.invoke('mail:send' satisfies InvokeChannel, req),
    cancelSend: (req) => ipcRenderer.invoke('mail:cancel-send' satisfies InvokeChannel, req)
  },
  connectors: {
    listFilesStatus: () => ipcRenderer.invoke('connectors:list-files-status' satisfies InvokeChannel),
    searchFiles: (req) => ipcRenderer.invoke('connectors:search-files' satisfies InvokeChannel, req),
    readFile: (req) => ipcRenderer.invoke('connectors:read-file' satisfies InvokeChannel, req)
  },
  // Content sources, the browser extension's bridge, and import notes
  sources: {
    getStatus: () => ipcRenderer.invoke('sources:get-status' satisfies InvokeChannel),
    listPlaying: () => ipcRenderer.invoke('sources:list-playing' satisfies InvokeChannel),
    createNote: (req) => ipcRenderer.invoke('sources:create-note' satisfies InvokeChannel, req),
    getForNote: (req) => ipcRenderer.invoke('sources:get-for-note' satisfies InvokeChannel, req),
    link: (req) => ipcRenderer.invoke('sources:link' satisfies InvokeChannel, req),
    update: (req) => ipcRenderer.invoke('sources:update' satisfies InvokeChannel, req),
    unlink: (req) => ipcRenderer.invoke('sources:unlink' satisfies InvokeChannel, req),
    search: (req) => ipcRenderer.invoke('sources:search' satisfies InvokeChannel, req),
    fetchCaptions: (req) => ipcRenderer.invoke('sources:fetch-captions' satisfies InvokeChannel, req),
    setTranscriptPlan: (req) => ipcRenderer.invoke('sources:set-transcript-plan' satisfies InvokeChannel, req),
    listSeries: () => ipcRenderer.invoke('sources:list-series' satisfies InvokeChannel),
    getSeries: (req) => ipcRenderer.invoke('sources:get-series' satisfies InvokeChannel, req),
    updateSeries: (req) => ipcRenderer.invoke('sources:update-series' satisfies InvokeChannel, req),
    ungroupSeries: (req) => ipcRenderer.invoke('sources:ungroup-series' satisfies InvokeChannel, req),
    importCatalog: (req) => ipcRenderer.invoke('sources:import-catalog' satisfies InvokeChannel, req),
    deleteCatalog: (req) => ipcRenderer.invoke('sources:delete-catalog' satisfies InvokeChannel, req),
    backfillPreview: (req) => ipcRenderer.invoke('sources:backfill-preview' satisfies InvokeChannel, req),
    backfillApply: (req) => ipcRenderer.invoke('sources:backfill-apply' satisfies InvokeChannel, req),
    backfillUndo: (req) => ipcRenderer.invoke('sources:backfill-undo' satisfies InvokeChannel, req),
    mergeNotes: (req) => ipcRenderer.invoke('sources:merge-notes' satisfies InvokeChannel, req),
    mergeUndo: (req) => ipcRenderer.invoke('sources:merge-undo' satisfies InvokeChannel, req),
    grant: (req) => ipcRenderer.invoke('sources:grant' satisfies InvokeChannel, req),
    toolsStatus: () => ipcRenderer.invoke('sources:tools-status' satisfies InvokeChannel),
    toolsDownload: (req) => ipcRenderer.invoke('sources:tools-download' satisfies InvokeChannel, req),
    dismissHint: (req) => ipcRenderer.invoke('sources:dismiss-hint' satisfies InvokeChannel, req),
    onStatusChanged: (cb) => {
      const listener = (_e: IpcRendererEvent, p: PushPayload<'sources:status-changed'>): void => cb(p)
      ipcRenderer.on('sources:status-changed' satisfies PushChannel, listener)
      return () => {
        ipcRenderer.removeListener('sources:status-changed' satisfies PushChannel, listener)
      }
    },
    onPlayingChanged: (cb) => {
      const listener = (_e: IpcRendererEvent, p: PushPayload<'sources:playing-changed'>): void => cb(p)
      ipcRenderer.on('sources:playing-changed' satisfies PushChannel, listener)
      return () => {
        ipcRenderer.removeListener('sources:playing-changed' satisfies PushChannel, listener)
      }
    },
    onPosition: (cb) => {
      const listener = (_e: IpcRendererEvent, p: PushPayload<'sources:position'>): void => cb(p)
      ipcRenderer.on('sources:position' satisfies PushChannel, listener)
      return () => {
        ipcRenderer.removeListener('sources:position' satisfies PushChannel, listener)
      }
    },
    onChanged: (cb) => {
      const listener = (_e: IpcRendererEvent, p: PushPayload<'sources:changed'>): void => cb(p)
      ipcRenderer.on('sources:changed' satisfies PushChannel, listener)
      return () => {
        ipcRenderer.removeListener('sources:changed' satisfies PushChannel, listener)
      }
    },
    onCaptionsProgress: (cb) => {
      const listener = (_e: IpcRendererEvent, p: PushPayload<'sources:captions-progress'>): void => cb(p)
      ipcRenderer.on('sources:captions-progress' satisfies PushChannel, listener)
      return () => {
        ipcRenderer.removeListener('sources:captions-progress' satisfies PushChannel, listener)
      }
    },
    onToolsProgress: (cb) => {
      const listener = (_e: IpcRendererEvent, p: PushPayload<'sources:tools-progress'>): void => cb(p)
      ipcRenderer.on('sources:tools-progress' satisfies PushChannel, listener)
      return () => {
        ipcRenderer.removeListener('sources:tools-progress' satisfies PushChannel, listener)
      }
    },
    onMark: (cb) => {
      const listener = (_e: IpcRendererEvent, p: PushPayload<'sources:mark'>): void => cb(p)
      ipcRenderer.on('sources:mark' satisfies PushChannel, listener)
      return () => {
        ipcRenderer.removeListener('sources:mark' satisfies PushChannel, listener)
      }
    }
  },
  extBridge: {
    getStatus: () => ipcRenderer.invoke('ext-bridge:get-status' satisfies InvokeChannel),
    setEnabled: (req) => ipcRenderer.invoke('ext-bridge:set-enabled' satisfies InvokeChannel, req),
    repair: () => ipcRenderer.invoke('ext-bridge:repair' satisfies InvokeChannel),
    onStatusChanged: (cb) => {
      const listener = (_e: IpcRendererEvent, p: PushPayload<'ext-bridge:status-changed'>): void => cb(p)
      ipcRenderer.on('ext-bridge:status-changed' satisfies PushChannel, listener)
      return () => {
        ipcRenderer.removeListener('ext-bridge:status-changed' satisfies PushChannel, listener)
      }
    }
  },
  notesImport: {
    chooseFolder: () => ipcRenderer.invoke('notes-import:choose-folder' satisfies InvokeChannel),
    chooseFiles: () => ipcRenderer.invoke('notes-import:choose-files' satisfies InvokeChannel),
    scan: (req) => ipcRenderer.invoke('notes-import:scan' satisfies InvokeChannel, req),
    getPreview: (req) => ipcRenderer.invoke('notes-import:get-preview' satisfies InvokeChannel, req),
    setOptions: (req) => ipcRenderer.invoke('notes-import:set-options' satisfies InvokeChannel, req),
    start: (req) => ipcRenderer.invoke('notes-import:start' satisfies InvokeChannel, req),
    cancel: (req) => ipcRenderer.invoke('notes-import:cancel' satisfies InvokeChannel, req),
    listBatches: () => ipcRenderer.invoke('notes-import:list-batches' satisfies InvokeChannel),
    undoPreview: (req) => ipcRenderer.invoke('notes-import:undo-preview' satisfies InvokeChannel, req),
    undo: (req) => ipcRenderer.invoke('notes-import:undo' satisfies InvokeChannel, req),
    clearHistory: (req) => ipcRenderer.invoke('notes-import:clear-history' satisfies InvokeChannel, req),
    getCandidates: (req) => ipcRenderer.invoke('notes-import:get-candidates' satisfies InvokeChannel, req),
    onScanProgress: (cb) => {
      const listener = (_e: IpcRendererEvent, p: PushPayload<'notes-import:scan-progress'>): void => cb(p)
      ipcRenderer.on('notes-import:scan-progress' satisfies PushChannel, listener)
      return () => {
        ipcRenderer.removeListener('notes-import:scan-progress' satisfies PushChannel, listener)
      }
    },
    onProgress: (cb) => {
      const listener = (_e: IpcRendererEvent, p: PushPayload<'notes-import:progress'>): void => cb(p)
      ipcRenderer.on('notes-import:progress' satisfies PushChannel, listener)
      return () => {
        ipcRenderer.removeListener('notes-import:progress' satisfies PushChannel, listener)
      }
    },
    onChanged: (cb) => {
      const listener = (_e: IpcRendererEvent, p: PushPayload<'notes-import:changed'>): void => cb(p)
      ipcRenderer.on('notes-import:changed' satisfies PushChannel, listener)
      return () => {
        ipcRenderer.removeListener('notes-import:changed' satisfies PushChannel, listener)
      }
    }
  }
}

// Keep this call directly after `api`: the bundler then inlines the object literal into
// it, which static analysis needs to resolve every bridge member.
contextBridge.exposeInMainWorld('notula', api)

// The media-worker window receives a transferred MessagePort and hands
// it to its page. Other windows never get this push and never forward anything.
if (window.location.hash.startsWith('#/media-worker')) {
  ipcRenderer.on('imports:media-port' satisfies PushChannel, (e: IpcRendererEvent) => {
    window.postMessage({ type: 'notula:media-port' }, '*', e.ports)
  })
}
