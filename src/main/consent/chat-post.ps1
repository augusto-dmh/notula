# SPDX-License-Identifier: Apache-2.0
# Notula: post the meeting notice in a Zoom or Teams chat.
# Bundled as text, written to <userData>\helpers and checked by SHA-256 before every run.
#
# Input: one JSON line on stdin { app, message, budgetMs, pollMs, hintMs, restoreMs, targetPid? }.
# The message never goes on the command line. Closing stdin cancels the run.
# Output: JSON lines on stdout:
#   { event: 'waiting', for: 'chat-field' | 'draft' }    { event: 'hint' }   (no field after hintMs)
#   { event: 'result', status: 'success' | 'failure' | 'unavailable' | 'cancelled', reason?, pasted? }
#
# Steps: find the meeting window (a window of the app with a Leave / End / Hang up button), find its
# chat field, wait while it holds a draft (never touch it), bring the window forward and recheck the
# foreground right before the keys, paste through a clipboard snapshot (SendInput Ctrl+V, restored
# after restoreMs), read the field back (exact match required), send with the Send button's Invoke
# or else Enter, confirm the field emptied, and give focus back to the window the user had.

$ErrorActionPreference = 'Stop'

function Emit($o) {
  [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
}

# Constrained Language Mode blocks .NET calls, so this line uses only core cmdlets.
if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') {
  Write-Output '{"event":"result","status":"unavailable","reason":"helper-unavailable"}'
  exit 0
}

try {
  $req = [Console]::In.ReadLine() | ConvertFrom-Json
  Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Windows.Forms
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class NotulaPost {
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public InputUnion u; }
  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  public static uint PidOf(IntPtr h) { uint p; GetWindowThreadProcessId(h, out p); return p; }
  public static bool Bring(IntPtr h) {
    if (IsIconic(h)) ShowWindow(h, 9);
    IntPtr fg = GetForegroundWindow();
    uint ignored;
    uint fgThread = GetWindowThreadProcessId(fg, out ignored);
    uint me = GetCurrentThreadId();
    bool attached = fgThread != 0 && fgThread != me && AttachThreadInput(me, fgThread, true);
    bool ok = SetForegroundWindow(h);
    if (attached) AttachThreadInput(me, fgThread, false);
    return ok;
  }
  static INPUT Key(ushort vk, bool up) {
    INPUT i = new INPUT(); i.type = 1; i.u.ki.wVk = vk; i.u.ki.dwFlags = up ? 2u : 0u; return i;
  }
  public static bool CtrlV() {
    INPUT[] seq = { Key(0x11, false), Key(0x56, false), Key(0x56, true), Key(0x11, true) };
    return SendInput((uint)seq.Length, seq, Marshal.SizeOf(typeof(INPUT))) == seq.Length;
  }
  public static bool Enter() {
    INPUT[] seq = { Key(0x0D, false), Key(0x0D, true) };
    return SendInput((uint)seq.Length, seq, Marshal.SizeOf(typeof(INPUT))) == seq.Length;
  }
}
'@
} catch {
  Emit @{ event = 'result'; status = 'unavailable'; reason = 'helper-unavailable' }
  exit 0
}

# Closing stdin (or any further input) completes this read: the run is cancelled. The raw stream's
# ReadAsync runs on the thread pool; Console.In's ReadLineAsync would block here.
$cancelBuf = New-Object byte[] 16
$cancel = [Console]::OpenStandardInput().ReadAsync($cancelBuf, 0, 16)

$AE = [System.Windows.Automation.AutomationElement]
$CT = [System.Windows.Automation.ControlType]
$Scope = [System.Windows.Automation.TreeScope]
$message = [string]$req.message
$deadline = (Get-Date).AddMilliseconds([double]$req.budgetMs)
$hintAt = (Get-Date).AddMilliseconds([double]$req.hintMs)
$pollMs = [int]$req.pollMs
$hinted = $false
$waitingFor = ''

function Finish($status, $reason, $pasted) {
  $o = @{ event = 'result'; status = $status }
  if ($reason) { $o.reason = $reason }
  if ($pasted) { $o.pasted = $true }
  Emit $o
  exit 0
}

function CheckCancel { if ($cancel.IsCompleted) { Finish 'cancelled' $null $false } }

function Waiting($what) {
  if ($script:waitingFor -ne $what) { $script:waitingFor = $what; Emit @{ event = 'waiting'; for = $what } }
}

function Pause-Poll {
  CheckCancel
  if ((Get-Date) -gt $deadline) { return $false }
  Start-Sleep -Milliseconds $pollMs
  CheckCancel
  return $true
}

function AppPids {
  if ($req.targetPid) { return @([int]$req.targetPid) }
  $names = if ($req.app -eq 'zoom') { @('Zoom') } else { @('ms-teams', 'Teams', 'msteams') }
  return @(Get-Process -Name $names -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
}

function Has-LeaveButton($win) {
  $cond = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $CT::Button)
  foreach ($b in $win.FindAll($Scope::Descendants, $cond)) {
    if ($b.Current.Name -match '^(Leave|End|Hang up)\b') { return $true }
  }
  return $false
}

function MeetingWindows {
  $out = @()
  foreach ($procId in AppPids) {
    $cond = New-Object System.Windows.Automation.PropertyCondition($AE::ProcessIdProperty, [int]$procId)
    foreach ($w in $AE::RootElement.FindAll($Scope::Children, $cond)) {
      try { if (Has-LeaveButton $w) { $out += $w } } catch {}
    }
  }
  return ,$out
}

function Find-Field($win) {
  $edit = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $CT::Edit)
  $doc = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $CT::Document)
  $either = New-Object System.Windows.Automation.OrCondition($edit, $doc)
  foreach ($e in $win.FindAll($Scope::Descendants, $either)) {
    $c = $e.Current
    $label = "$($c.Name) $($c.HelpText) $($c.AutomationId)"
    if (-not $c.IsEnabled -or -not $c.IsKeyboardFocusable -or $label -match '(?i)search') { continue }
    if ($label -match '(?i)(chat|message|compose|type here)') { return $e }
  }
  return $null
}

# The field's text, '' when empty, $null when it cannot be read. A value equal to the field's own
# name is its placeholder.
function Read-Field($f) {
  $text = $null
  try {
    $vp = $f.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    $text = $vp.Current.Value
  } catch {
    try {
      $tp = $f.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)
      $text = $tp.DocumentRange.GetText(8000)
    } catch { return $null }
  }
  if ($null -eq $text) { return $null }
  $t = ($text -replace "`r`n", "`n" -replace [char]0x00A0, ' ').Trim()
  if ($t -eq $f.Current.Name.Trim()) { return '' }
  return $t
}

function Snap-Clipboard {
  try {
    $d = [System.Windows.Forms.Clipboard]::GetDataObject()
    if (-not $d) { return $null }
    $copy = New-Object System.Windows.Forms.DataObject
    foreach ($fmt in $d.GetFormats($false)) {
      try { $v = $d.GetData($fmt, $false); if ($null -ne $v) { $copy.SetData($fmt, $false, $v) } } catch {}
    }
    return $copy
  } catch { return $null }
}

function Restore-Clipboard($copy) {
  try {
    if ($copy -and $copy.GetFormats().Length) { [System.Windows.Forms.Clipboard]::SetDataObject($copy, $true, 5, 100) }
    else { [System.Windows.Forms.Clipboard]::Clear() }
  } catch {}
}

# The meeting window itself, not just its app: another window of the same browser or app fails.
function In-Foreground($pids) {
  $fg = [NotulaPost]::GetForegroundWindow()
  if ($hwnd -and $fg -ne $hwnd) { return $false }
  return $pids -contains [int][NotulaPost]::PidOf($fg)
}

# Anything unexpected ends the run as a failure, with the user's clipboard put back.
$saved = $null
trap {
  if ($saved) { Restore-Clipboard $saved }
  Emit @{ event = 'result'; status = 'failure'; reason = 'composer-unreadable' }
  exit 0
}

# 1–3. The meeting window, its chat field, and an empty field.
$win = $null
$field = $null
while ($true) {
  CheckCancel
  $ready = $false
  try {
    $wins = MeetingWindows
    if ($wins.Count -gt 1) { Finish 'failure' 'several-meeting-windows' $false }
    $field = $null
    if ($wins.Count -eq 1) {
      $win = $wins[0]
      $field = Find-Field $win
      if ($field) {
        $value = Read-Field $field
        if ($null -eq $value) { Finish 'failure' 'composer-unreadable' $false }
        if ($value -eq '') { $ready = $true } else { Waiting 'draft' }
      } else { Waiting 'chat-field' }
    } else { Waiting 'chat-field' }
  } catch {
    # A window or element that went away while being read: poll again.
    $field = $null
    Waiting 'chat-field'
  }
  if ($ready) { break }
  if (-not $field -and -not $hinted -and (Get-Date) -gt $hintAt) { $hinted = $true; Emit @{ event = 'hint' } }
  if (-not (Pause-Poll)) {
    if ($field) { Finish 'failure' 'composer-not-empty' $false }
    Finish 'failure' 'composer-missing' $false
  }
}

# 4. Forward, focused, and the meeting app in the foreground right before the keys.
$pids = AppPids
$previous = [NotulaPost]::GetForegroundWindow()
$hwnd = [IntPtr]$win.Current.NativeWindowHandle
[void][NotulaPost]::Bring($hwnd)
try { $field.SetFocus() } catch {}
Start-Sleep -Milliseconds 150
CheckCancel
if ((Read-Field $field) -ne '') { Finish 'failure' 'composer-not-empty' $false }
if (-not (In-Foreground $pids)) { Finish 'failure' 'foreground-lost' $false }

# 5. Paste through a clipboard snapshot.
$saved = Snap-Clipboard
try { [System.Windows.Forms.Clipboard]::SetDataObject($message, $true, 5, 100) } catch { Finish 'failure' 'composer-unreadable' $false }
if (-not (In-Foreground $pids)) { Restore-Clipboard $saved; Finish 'failure' 'foreground-lost' $false }
[void][NotulaPost]::CtrlV()
Start-Sleep -Milliseconds ([int]$req.restoreMs)
Restore-Clipboard $saved

# 6. Read back: an exact match, or nothing is sent.
$want = ($message -replace "`r`n", "`n").Trim()
$got = Read-Field $field
if ($null -eq $got) { Finish 'failure' 'composer-unreadable' $true }
if ($got -ne $want) {
  [void][NotulaPost]::SetForegroundWindow($previous)
  Finish 'failure' 'composer-partial-text' ($got -ne '')
}

# 7. Send: the Send button's Invoke, else Enter; the field must empty.
CheckCancel
$sent = $false
$btnCond = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $CT::Button)
foreach ($b in $win.FindAll($Scope::Descendants, $btnCond)) {
  if ($b.Current.IsEnabled -and $b.Current.Name -match '^Send\b') {
    try { $b.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke(); $sent = $true } catch {}
    break
  }
}
if (-not $sent) {
  if (-not (In-Foreground $pids)) { Finish 'failure' 'foreground-lost' $true }
  [void][NotulaPost]::Enter()
}
$emptied = $false
for ($i = 0; $i -lt 20; $i++) {
  Start-Sleep -Milliseconds 100
  if ((Read-Field $field) -eq '') { $emptied = $true; break }
}

# 8. Focus back where the user had it.
if ($previous -ne [IntPtr]::Zero -and [NotulaPost]::IsWindow($previous)) { [void][NotulaPost]::Bring($previous) }
if ($emptied) { Finish 'success' $null $true }
Finish 'failure' 'composer-partial-text' $true
