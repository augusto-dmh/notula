// SPDX-License-Identifier: Apache-2.0
// The Windows side of notula-micmon: the PowerShell script that reports which consent-store
// entries use the microphone. Pure text, so scripts/dev/micmon-notify-check.ts can run the same
// script against a scratch key.
//
// The script waits on a registry change notification for the key (RegNotifyChangeKeyValue, the
// whole subtree, name and value changes) and on the owner process, in one wait with no fixed
// sleep. After a signal it lets the burst settle (the system writes the start and stop values
// separately), re-arms the notification, then scans once, so a change during the scan signals
// the next round. A scan also runs after 60 s without a signal, for a missed notification (the
// key deleted and created again). Without the notification (Add-Type unavailable, or the
// registration refused) it says so once and scans every 5 s.

/** Safety rescan while the notification is armed. */
export const MICMON_RESCAN_MS = 60_000
/** The scan interval when no notification can be armed. */
export const MICMON_FALLBACK_MS = 5_000
/** A signal waits this long for the rest of its burst before the scan. */
export const MICMON_SETTLE_MS = 250

/** The real consent store, under HKCU. */
export const MICMON_CONSENT_KEY = 'Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone'

// "In use" = LastUsedTimeStop is 0 and LastUsedTimeStart is not. Desktop apps are
// subkeys of NonPackaged named by path with `#` for `\`; packaged apps by family.
//
// The script runs all day while Notula sits in the tray, so each scan is kept cheap:
// no cmdlets (each one loads a module and runs a pipeline), the owner watched through one
// process handle, and most keys settled by their first value read.
// `t` lines: ready, apps {ids}, log {event} (no data), and scan {why} only with `debug`.
const WINDOWS_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$path = '__KEY_PATH__'
$debug = __DEBUG__
$hkcu = [Microsoft.Win32.Registry]::CurrentUser
function Say($line) {
  [Console]::Out.WriteLine($line)
  [Console]::Out.Flush()
}
# JSON string escaping, control characters included, so one odd subkey name never makes a line unparsable.
function Esc($s) {
  $e = $s.Replace('\\', '\\\\').Replace('"', '\\"')
  return [regex]::Replace($e, '[\\x00-\\x1f]', { param($m) '\\u{0:x4}' -f [int][char]$m.Value })
}
# Windows does not end a child with its parent: stop when notula-micmon is gone.
try { $owner = [System.Diagnostics.Process]::GetProcessById(__OWNER_PID__) } catch { exit 0 }
# One compile per detector start, never per scan.
$notify = $false
try {
  Add-Type -ErrorAction Stop -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class NotulaMicNotify {
  [DllImport("advapi32.dll")]
  static extern int RegNotifyChangeKeyValue(SafeRegistryHandle key, bool subtree, uint filter, SafeWaitHandle evt, bool async);
  // Subkey names and values anywhere below the key (REG_NOTIFY_CHANGE_NAME | _LAST_SET), signalled
  // on evt. Thread-agnostic: the registration does not end with the thread that made it.
  public static int Arm(SafeRegistryHandle key, SafeWaitHandle evt) {
    return RegNotifyChangeKeyValue(key, true, 0x1 | 0x4 | 0x10000000, evt, true);
  }
}
'@
  $notify = $true
} catch {}
$evt = New-Object System.Threading.AutoResetEvent $false
# The owner's process handle as a wait handle, so its exit ends the same wait.
$ownerWait = $null
try {
  $h = $owner.Handle
  if ($null -eq $h -or $h -eq [IntPtr]::Zero) { throw 'no handle' }
  $ownerWait = New-Object System.Threading.ManualResetEvent $false
  $ownerWait.SafeWaitHandle = New-Object Microsoft.Win32.SafeHandles.SafeWaitHandle -ArgumentList $h, $false
} catch { $ownerWait = $null }
$watched = $null
$told = $false
# Arms one notification. A signal re-arms the handle it came from; a handle whose key was deleted
# refuses, and the key is opened again. A handle with a pending registration is never re-armed
# or closed (closing it would signal).
function Arm {
  if (-not $script:notify) { return $false }
  if ($null -ne $script:watched) {
    if ([NotulaMicNotify]::Arm($script:watched.Handle, $evt.SafeWaitHandle) -eq 0) { return $true }
    $script:watched.Close()
    $script:watched = $null
  }
  $k = $hkcu.OpenSubKey($path)
  if ($null -eq $k) { return $false }
  if ([NotulaMicNotify]::Arm($k.Handle, $evt.SafeWaitHandle) -ne 0) {
    $k.Close()
    if (-not $script:told) { $script:told = $true; Say '{"t":"log","event":"micmon:notify-unavailable"}' }
    return $false
  }
  $script:watched = $k
  return $true
}
$last = $null
$since = [System.Diagnostics.Stopwatch]::StartNew()
function Scan($why) {
  $script:since.Restart()
  if ($debug) { Say ('{"t":"scan","why":"' + $why + '"}') }
  $ids = [System.Collections.Generic.List[string]]::new()
  $root = $hkcu.OpenSubKey($path)
  if ($null -ne $root) {
    foreach ($name in $root.GetSubKeyNames()) {
      $k = $root.OpenSubKey($name)
      if ($null -eq $k) { continue }
      if ($name -eq 'NonPackaged') {
        foreach ($sub in $k.GetSubKeyNames()) {
          $s = $k.OpenSubKey($sub)
          if ($null -eq $s) { continue }
          # In use = LastUsedTimeStop 0 and LastUsedTimeStart not; most keys stop at the first read.
          $stop = $s.GetValue('LastUsedTimeStop')
          if ($null -ne $stop -and [int64]$stop -eq 0) {
            $start = $s.GetValue('LastUsedTimeStart')
            if ($null -ne $start -and [int64]$start -ne 0) { $ids.Add('n:' + $sub) }
          }
          $s.Close()
        }
      } else {
        $stop = $k.GetValue('LastUsedTimeStop')
        if ($null -ne $stop -and [int64]$stop -eq 0) {
          $start = $k.GetValue('LastUsedTimeStart')
          if ($null -ne $start -and [int64]$start -ne 0) { $ids.Add('p:' + $name) }
        }
      }
      $k.Close()
    }
    $root.Close()
  }
  $ids.Sort()
  $key = [string]::Join([char]10, $ids)
  if ($key -ne $script:last) {
    $quoted = [System.Collections.Generic.List[string]]::new()
    foreach ($id in $ids) { $quoted.Add('"' + (Esc $id) + '"') }
    Say ('{"t":"apps","ids":[' + [string]::Join(',', $quoted) + ']}')
    $script:last = $key
  }
}
if (-not $notify) { $told = $true; Say '{"t":"log","event":"micmon:notify-unavailable"}' }
$armed = Arm
Say '{"t":"ready"}'
Scan 'start'
if ($null -ne $ownerWait) { $handles = [System.Threading.WaitHandle[]]@($evt, $ownerWait) } else { $handles = [System.Threading.WaitHandle[]]@($evt) }
while (-not $owner.HasExited) {
  $period = __FALLBACK_MS__
  if ($armed) { $period = __RESCAN_MS__ }
  $wait = $period - $since.ElapsedMilliseconds
  if ($wait -lt 0) { $wait = 0 }
  # Without the owner's handle, its exit is checked once a second instead.
  if ($null -eq $ownerWait -and $wait -gt 1000) { $wait = 1000 }
  $i = [System.Threading.WaitHandle]::WaitAny($handles, [int]$wait)
  if ($i -eq 1) { break }
  if ($i -eq 0) {
    [System.Threading.Thread]::Sleep(__SETTLE_MS__)
    $armed = Arm
    Scan 'signal'
  } elseif ($since.ElapsedMilliseconds -ge $period) {
    $why = 'fallback'
    if ($armed) { $why = 'safety' } else { $armed = Arm }
    Scan $why
  }
}
`

/**
 * The script for one detector start. `keyPath` is under HKCU (the consent store, or a dev
 * check's scratch key); `debug` adds a `scan` line per scan, for the check's count.
 */
export function micmonWindowsScript(o: { ownerPid: number; keyPath?: string; debug?: boolean }): string {
  // Single-quoted in PowerShell: a quote doubles.
  const key = (o.keyPath ?? MICMON_CONSENT_KEY).replace(/'/g, "''")
  return WINDOWS_SCRIPT.replace('__KEY_PATH__', () => key)
    .replace('__DEBUG__', o.debug ? '$true' : '$false')
    .replace('__OWNER_PID__', String(Math.trunc(o.ownerPid)))
    .replace('__FALLBACK_MS__', String(MICMON_FALLBACK_MS))
    .replace('__RESCAN_MS__', String(MICMON_RESCAN_MS))
    .replace('__SETTLE_MS__', String(MICMON_SETTLE_MS))
}
