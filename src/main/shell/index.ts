// SPDX-License-Identifier: Apache-2.0
// The application menu. Fixed accelerators: Settings CmdOrCtrl+, · New
// CmdOrCtrl+Shift+N · Close CmdOrCtrl+W · Minimize CmdOrCtrl+M · Hide CmdOrCtrl+H
// (macOS) · Quit CmdOrCtrl+Q · Reload CmdOrCtrl+R.
//
// - Quit is the soft quit: it hides the window and Notula stays in the tray.
//   Restart Notula and Check for Updates… go through the lifecycle and the updater.
// - Window → New asks the lifecycle for a new note (`notes:new-requested`, or
//   `notes:new-blocked` while capture is active).
// - Settings… pushes `settings:open` with no section, so Settings keeps its page when
//   it is already open.
// - Reload keeps its accelerator, but while the main window is transcribing it asks
//   first: a reload is a page hide, which stops capture.
// - Window → New takes `ctx.shortcuts.effective('newNote')`, and the
//   registry rebuilds the menu when it changes. File
//   (Windows) and the app menu (macOS) gain "Import recording…" through `ctx.imports`, and
//   "Import notes…" through the Markdown importer's hook.
//   Help holds License (Settings ▸ About's open-source licenses; Help Center is hidden)
//   and Troubleshooting ▸ trace, macOS unified log, Export Logs… and the logs folder.
//   Toggle Developer Tools exists in unpackaged builds only.

import { app, BaseWindow, BrowserWindow, dialog, Menu, type MenuItemConstructorOptions } from 'electron'
import type { MainContext } from '../context'
import { promptImportNotes } from '../imports-md'
import { openSettingsSection, requestNewNote, restartApp, softQuit } from '../lifecycle'
import { log } from '../log'
import { checkForUpdatesNow } from '../updater/state'
import { exportLogsInteractive, openLogsFolder, startTrace, toggleUnifiedLog, unifiedLogRunning } from '../diagnostics'

const isMac = process.platform === 'darwin'

/** View → Reload. A reload of the transcribing window stops capture, so it is confirmed first. */
async function reloadWindow(ctx: MainContext, from: BaseWindow | undefined): Promise<void> {
  const target = from instanceof BrowserWindow ? from : BrowserWindow.getFocusedWindow()
  if (!target || target.isDestroyed()) return
  if (ctx.capture.isCapturing() && target === ctx.windows.main()) {
    const { response } = await dialog.showMessageBox(target, {
      type: 'warning',
      message: 'Reload while transcribing?',
      detail: 'Reloading stops the transcript. You can resume it once the window has reloaded.',
      buttons: ['Cancel', 'Reload'],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    })
    log('info', 'shell:reload-while-capturing', { noteId: ctx.capture.currentNoteId(), reload: response === 1 })
    if (response !== 1 || target.isDestroyed()) return
  }
  target.webContents.reload()
}

function buildMenu(ctx: MainContext): Menu {
  const settingsItem: MenuItemConstructorOptions = {
    label: isMac ? 'Settings…' : 'Settings',
    accelerator: 'CmdOrCtrl+,',
    click: () => openSettingsSection(undefined, 'menu')
  }
  const checkItem: MenuItemConstructorOptions = {
    label: 'Check for updates…',
    click: () => checkForUpdatesNow('menu')
  }
  const restartItem: MenuItemConstructorOptions = { label: 'Restart Notula', click: () => restartApp('menu') }
  const quitItem: MenuItemConstructorOptions = {
    label: isMac ? 'Quit Notula' : 'Quit',
    accelerator: 'CmdOrCtrl+Q',
    click: () => void softQuit('menu')
  }

  const importItem: MenuItemConstructorOptions = {
    label: 'Import recording…',
    click: () => void ctx.imports.promptAndStart().catch((err: unknown) => log('error', 'shell:import-failed', { err }))
  }
  // Markdown and vault imports: main's folder picker, then the preview.
  const importNotesItem: MenuItemConstructorOptions = {
    label: 'Import notes…',
    click: () => void promptImportNotes().catch((err: unknown) => log('error', 'shell:import-notes-failed', { err }))
  }

  const template: MenuItemConstructorOptions[] = []

  if (isMac) {
    template.push({
      label: 'Notula',
      submenu: [
        { role: 'about', label: 'About Notula' },
        checkItem,
        { type: 'separator' },
        settingsItem,
        importItem,
        importNotesItem,
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide', label: 'Hide Notula', accelerator: 'CmdOrCtrl+H' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        restartItem,
        quitItem
      ]
    })
  } else {
    template.push({
      label: 'File',
      submenu: [settingsItem, importItem, importNotesItem, checkItem, { type: 'separator' }, restartItem, quitItem]
    })
  }

  // No undo/redo roles: they would bypass the editor's Yjs undo manager, which
  // already answers Mod+Z / Mod+Y / Shift+Mod+Z.
  template.push({
    label: 'Edit',
    submenu: [
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { role: 'pasteAndMatchStyle' },
      { role: 'selectAll' }
    ]
  })

  template.push({
    label: 'View',
    submenu: [
      { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: (_item, win) => void reloadWindow(ctx, win) },
      ...(ctx.isDev ? ([{ role: 'toggleDevTools' }] satisfies MenuItemConstructorOptions[]) : []),
      { type: 'separator' },
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' }
    ]
  })

  template.push({
    label: 'Window',
    submenu: [
      {
        label: 'New',
        // `shortcuts.newNote`, else CmdOrCtrl+Shift+N.
        accelerator: ctx.shortcuts.effective('newNote'),
        // Menu notes auto-start transcription (the new-note default).
        click: () => requestNewNote('app_menu', { autoTranscribe: true })
      },
      { type: 'separator' },
      { role: 'minimize', accelerator: 'CmdOrCtrl+M' },
      { role: 'close', accelerator: 'CmdOrCtrl+W' },
      ...(isMac ? ([{ type: 'separator' }, { role: 'front' }] satisfies MenuItemConstructorOptions[]) : [])
    ]
  })

  template.push({
    role: 'help',
    submenu: [
      { label: 'License', click: () => openSettingsSection('about', 'menu') },
      { type: 'separator' },
      {
        label: 'Troubleshooting',
        submenu: [
          { label: 'Record Performance Trace (10s)', click: () => void startTrace(ctx, 'menu') },
          ...(isMac
            ? ([
                {
                  label: unifiedLogRunning() ? 'Stop macOS Unified Log' : 'Start macOS Unified Log',
                  click: () => void toggleUnifiedLog(ctx, 'menu').catch(() => undefined)
                }
              ] satisfies MenuItemConstructorOptions[])
            : []),
          { label: 'Export Logs…', click: () => void exportLogsInteractive(ctx, 'menu').catch(() => undefined) },
          { label: isMac ? 'Show logs in Finder' : 'Show Logs Folder', click: () => void openLogsFolder(ctx) }
        ]
      }
    ]
  })

  return Menu.buildFromTemplate(template)
}

let shellCtx: MainContext | null = null

/**
 * Builds the application menu again: the New note accelerator changed
 *, or the unified-log item's label flipped.
 */
export function rebuildApplicationMenu(ctx?: MainContext): void {
  const c = ctx ?? shellCtx
  if (!c) return
  try {
    Menu.setApplicationMenu(buildMenu(c))
    log('debug', 'shell:menu-rebuilt', { newNote: c.shortcuts.effective('newNote') })
  } catch (err) {
    log('error', 'shell:menu-rebuild-failed', { err })
  }
}

export function registerShell(ctx: MainContext): void {
  shellCtx = ctx
  Menu.setApplicationMenu(buildMenu(ctx))

  // Windows and Linux: keep the accelerators but hide the menu bar (Alt shows it).
  if (!isMac) {
    app.on('browser-window-created', (_e, win) => {
      win.setAutoHideMenuBar(true)
      win.setMenuBarVisibility(false)
    })
  }
}
