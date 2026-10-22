// SPDX-License-Identifier: Apache-2.0
// notula-desk key listener (macOS): the dictation bar's key-state source.
// Run as `osascript -l JavaScript keyhook-mac.js` by the notula-desk utility process, only while a
// hook shortcut is set and Voice typing is armed. Listen-only: an NSEvent global monitor (a
// listen-only event tap underneath) for flagsChanged, keyDown and keyUp. It needs Input
// Monitoring / Accessibility; without it no events arrive and main keeps the globalShortcut
// fallback. Fn is never reported. Same JSON-lines protocol and reporting rules as keyhook.ps1;
// no Start-menu masking. `{"event":"secure-input","on":true}` while secure input blocks events.
// Not yet tested on real hardware.

ObjC.import('Cocoa')
ObjC.import('Carbon')

const IsSecureEventInputEnabled = (() => {
  try {
    return ObjC.bindFunction('IsSecureEventInputEnabled', ['bool', []])
  } catch (e) {
    return () => false
  }
})()

const MODS = { 59: 'ctrl', 62: 'ctrl_r', 58: 'alt', 61: 'alt_r', 56: 'shift', 60: 'shift_r', 55: 'cmd', 54: 'cmd_r' }
const KEYS = {
  49: 'space', 53: 'esc',
  0: 'a', 11: 'b', 8: 'c', 2: 'd', 14: 'e', 3: 'f', 5: 'g', 4: 'h', 34: 'i', 38: 'j', 40: 'k', 37: 'l', 46: 'm',
  45: 'n', 31: 'o', 35: 'p', 12: 'q', 15: 'r', 1: 's', 17: 't', 32: 'u', 9: 'v', 13: 'w', 7: 'x', 16: 'y', 6: 'z',
  29: '0', 18: '1', 19: '2', 20: '3', 21: '4', 23: '5', 22: '6', 26: '7', 28: '8', 25: '9'
}

const out = $.NSFileHandle.fileHandleWithStandardOutput
function send(obj) {
  const s = $.NSString.alloc.initWithUTF8String(JSON.stringify(obj) + '\n')
  out.writeData(s.dataUsingEncoding($.NSUTF8StringEncoding))
}

let chordKeys = {}
let active = false
const down = {}
const reported = {}
const modDown = () => Object.keys(MODS).some((k) => down[k])

function onEvent(ev) {
  const type = ev.type
  const code = ev.keyCode
  if (type === $.NSEventTypeFlagsChanged) {
    const name = MODS[code]
    if (!name) return
    down[code] = !down[code]
    send({ event: 'key', k: name, d: down[code] ? 1 : 0 })
    return
  }
  const isDown = type === $.NSEventTypeKeyDown
  if (isDown && ev.isARepeat) return
  if (!!down[code] === isDown) return
  const modBefore = modDown()
  down[code] = isDown
  const name = KEYS[code]
  if (isDown) {
    let k = name
    let report = false
    if (name === 'esc') report = active
    else if (name && chordKeys[name]) report = modBefore
    else {
      k = 'other'
      report = modBefore
    }
    reported[code] = report ? k : null
    if (report) send({ event: 'key', k: k, d: 1 })
  } else {
    if (reported[code]) send({ event: 'key', k: reported[code], d: 0 })
    reported[code] = null
  }
}

const mask = $.NSEventMaskFlagsChanged | $.NSEventMaskKeyDown | $.NSEventMaskKeyUp
const monitor = $.NSEvent.addGlobalMonitorForEventsMatchingMaskHandler(mask, onEvent)
if (!monitor || monitor.isNil()) {
  send({ event: 'error', message: 'monitor-failed' })
} else {
  send({ event: 'ready' })
}

// stdin: one JSON request per line, read in the background.
const input = $.NSFileHandle.fileHandleWithStandardInput
let buffer = ''
function readSome() {
  const data = input.availableData
  if (data.length === 0) return false
  buffer += $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding).js
  let i
  while ((i = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, i).trim()
    buffer = buffer.slice(i + 1)
    if (!line) continue
    try {
      const req = JSON.parse(line)
      if (req.op === 'config') {
        chordKeys = {}
        for (const k of req.keys || []) chordKeys[k] = true
      } else if (req.op === 'active') active = !!req.on
      else if (req.op === 'stop') return false
    } catch (e) {
      send({ event: 'error', message: String(e) })
    }
  }
  return true
}

const center = $.NSNotificationCenter.defaultCenter
let running = true
center.addObserverForNameObjectQueueUsingBlock($.NSFileHandleDataAvailableNotification, input, $.NSOperationQueue.mainQueue, () => {
  if (!readSome()) running = false
  else input.waitForDataInBackgroundAndNotify
})
input.waitForDataInBackgroundAndNotify

let secure = false
const loop = $.NSRunLoop.currentRunLoop
while (running) {
  loop.runModeBeforeDate($.NSDefaultRunLoopMode, $.NSDate.dateWithTimeIntervalSinceNow(1))
  const now = !!IsSecureEventInputEnabled()
  if (now !== secure) {
    secure = now
    send({ event: 'secure-input', on: now })
  }
}
if (monitor && !monitor.isNil()) $.NSEvent.removeMonitor(monitor)
