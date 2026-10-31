# SPDX-License-Identifier: Apache-2.0
# notula-desk (Windows): dictation's OS helper, run warm by the notula-desk utility process.
#
# Protocol: one JSON request per stdin line, {"id":n,"op":"..."}; one JSON reply per stdout
# line, {"id":n,"ok":true,...}. No network, no files. Ops:
#   ping        -> {}
#   foreground  -> {process, title, pid}
#   context     -> {result, process, title, field:{name,type,password,editable,multiline}, before, after, selection}
#                  multiline: ES_MULTILINE of the field's own edit window; null without one
#                  result: captured | empty | secure_input | error
#   field       -> {result, pid, window, before, selection, after, cutBefore, cutAfter}
#                  the paste watcher's light read: the foreground window and the text within
#                  2,000 characters of the caret; cut* = the window cut the text there.
#                  result: read | no-focus | secure | no-text | wide-selection
#   modifiers   -> {held:bool}   (Shift, Ctrl, Alt, Win)
#   paste       -> {sent:bool}   (Ctrl+V into the foreground window)
#   fullscreen  -> {fullscreen:bool, x, y}  (the foreground window covers its whole monitor;
#                  x, y = that monitor's top-left in physical pixels)
#   dblclick    -> {ms}          (the double-click interval, GetDoubleClickTime)
#   mute        -> {changed:bool} (mutes the default output; changed = false when it already was)
#   unmute      -> {changed:bool} (unmutes the default output)
# The script exits when its owner process is gone (Windows does not end children with
# their parent) or when stdin closes.

param([int]$OwnerPid = 0)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class NotulaDesk {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey);
  public static string Title(IntPtr h) { var sb = new StringBuilder(512); GetWindowText(h, sb, 512); return sb.ToString(); }
  public static bool Held(int vk) { return (GetAsyncKeyState(vk) & 0x8000) != 0; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
  [DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr m, ref MONITORINFO mi);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern IntPtr GetShellWindow();
  [DllImport("user32.dll")] public static extern IntPtr GetDesktopWindow();
  [DllImport("user32.dll", EntryPoint = "GetWindowLongW")] public static extern int GetWindowLong(IntPtr h, int index);
  // ES_MULTILINE (0x4) is an edit-class style bit, so only edit windows are read; -1 = unknown.
  public static int EditMultiline(IntPtr h) {
    if (h == IntPtr.Zero) return -1;
    var cls = new StringBuilder(128); GetClassName(h, cls, 128);
    if (cls.ToString().IndexOf("edit", StringComparison.OrdinalIgnoreCase) < 0) return -1;
    return (GetWindowLong(h, -16) & 0x4) != 0 ? 1 : 0;
  }
  // The monitor's top-left when the foreground window covers it entirely (not the desktop or the shell).
  public static int[] FullscreenMonitor() {
    IntPtr h = GetForegroundWindow();
    if (h == IntPtr.Zero || h == GetShellWindow() || h == GetDesktopWindow()) return null;
    var cls = new StringBuilder(64); GetClassName(h, cls, 64);
    string c = cls.ToString();
    if (c == "Progman" || c == "WorkerW" || c == "Shell_TrayWnd") return null;
    RECT r; if (!GetWindowRect(h, out r)) return null;
    var mi = new MONITORINFO(); mi.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
    if (!GetMonitorInfo(MonitorFromWindow(h, 2), ref mi)) return null;
    var m = mi.rcMonitor;
    if (r.Left <= m.Left && r.Top <= m.Top && r.Right >= m.Right && r.Bottom >= m.Bottom) return new int[] { m.Left, m.Top };
    return null;
  }
}
'@

# The default output's mute switch (Core Audio). Optional: without it, mute and unmute fail.
$script:AudioOk = $false
try {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
[ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface INotulaEndpointVolume {
  int RegisterControlChangeNotify(IntPtr p);
  int UnregisterControlChangeNotify(IntPtr p);
  int GetChannelCount(out uint c);
  int SetMasterVolumeLevel(float l, IntPtr ctx);
  int SetMasterVolumeLevelScalar(float l, IntPtr ctx);
  int GetMasterVolumeLevel(out float l);
  int GetMasterVolumeLevelScalar(out float l);
  int SetChannelVolumeLevel(uint ch, float l, IntPtr ctx);
  int SetChannelVolumeLevelScalar(uint ch, float l, IntPtr ctx);
  int GetChannelVolumeLevel(uint ch, out float l);
  int GetChannelVolumeLevelScalar(uint ch, out float l);
  int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, IntPtr ctx);
  int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
}
[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface INotulaMMDevice {
  int Activate(ref Guid iid, int clsCtx, IntPtr p, [MarshalAs(UnmanagedType.IUnknown)] out object o);
}
[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface INotulaMMDeviceEnumerator {
  int EnumAudioEndpoints(int flow, int mask, out IntPtr devices);
  int GetDefaultAudioEndpoint(int flow, int role, out INotulaMMDevice device);
}
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class NotulaMMDeviceEnumerator {}
public static class NotulaAudio {
  static INotulaEndpointVolume Endpoint() {
    var e = (INotulaMMDeviceEnumerator)(new NotulaMMDeviceEnumerator());
    INotulaMMDevice dev;
    Marshal.ThrowExceptionForHR(e.GetDefaultAudioEndpoint(0, 1, out dev));
    var iid = typeof(INotulaEndpointVolume).GUID;
    object o;
    Marshal.ThrowExceptionForHR(dev.Activate(ref iid, 23, IntPtr.Zero, out o));
    return (INotulaEndpointVolume)o;
  }
  public static bool SetMute(bool on) {
    var v = Endpoint();
    bool was;
    Marshal.ThrowExceptionForHR(v.GetMute(out was));
    if (was == on) return false;
    Marshal.ThrowExceptionForHR(v.SetMute(on, IntPtr.Zero));
    return true;
  }
}
'@
  $script:AudioOk = $true
} catch {}

Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
public static class NotulaDeskTime {
  [DllImport("user32.dll")] public static extern uint GetDoubleClickTime();
}
'@

function Reply($obj) {
  [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress -Depth 5))
  [Console]::Out.Flush()
}

function Foreground {
  $h = [NotulaDesk]::GetForegroundWindow()
  $procId = [uint32]0
  [void][NotulaDesk]::GetWindowThreadProcessId($h, [ref]$procId)
  $name = ''
  try { $name = (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch {}
  return @{ process = $name; title = [NotulaDesk]::Title($h); pid = [int]$procId }
}

function Clip([string]$s, [int]$n, [bool]$tail) {
  if ($null -eq $s) { return '' }
  if ($s.Length -le $n) { return $s }
  if ($tail) { return $s.Substring($s.Length - $n) }
  return $s.Substring(0, $n)
}

function Context {
  $fg = Foreground
  $out = @{ result = 'empty'; process = $fg.process; title = $fg.title; field = $null; before = ''; after = ''; selection = '' }
  $el = [System.Windows.Automation.AutomationElement]::FocusedElement
  if ($null -eq $el) { return $out }
  $c = $el.Current
  $editable = $false
  $vp = $null
  $tp = $null
  try { $vp = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern) } catch {}
  try { $tp = $el.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern) } catch {}
  if ($null -ne $vp -and -not $vp.Current.IsReadOnly) { $editable = $true }
  if ($null -ne $tp) { $editable = $true }
  $multiline = $null
  try {
    $m = [NotulaDesk]::EditMultiline([IntPtr]$c.NativeWindowHandle)
    if ($m -ge 0) { $multiline = ($m -eq 1) }
  } catch {}
  $out.field = @{ name = (Clip $c.Name 240 $false); type = $c.ControlType.ProgrammaticName; password = [bool]$c.IsPassword; editable = $editable; multiline = $multiline }
  if ($c.IsPassword) { $out.result = 'secure_input'; return $out }
  if ($null -ne $tp) {
    try {
      $doc = $tp.DocumentRange
      $sel = $tp.GetSelection()
      if ($sel.Length -gt 0) {
        $s = $sel[0]
        $out.selection = Clip ($s.GetText(4000)) 2000 $false
        $b = $doc.Clone()
        $b.MoveEndpointByRange([System.Windows.Automation.Text.TextPatternRangeEndpoint]::End, $s, [System.Windows.Automation.Text.TextPatternRangeEndpoint]::Start)
        $out.before = Clip ($b.GetText(-1)) 2000 $true
        $a = $doc.Clone()
        $a.MoveEndpointByRange([System.Windows.Automation.Text.TextPatternRangeEndpoint]::Start, $s, [System.Windows.Automation.Text.TextPatternRangeEndpoint]::End)
        $out.after = Clip ($a.GetText(4000)) 2000 $false
      } else {
        $out.before = Clip ($doc.GetText(-1)) 2000 $true
      }
    } catch {}
  } elseif ($null -ne $vp) {
    try { $out.before = Clip $vp.Current.Value 2000 $true } catch {}
  }
  if ($out.before -or $out.after -or $out.selection -or $c.Name) { $out.result = 'captured' }
  return $out
}

# The paste watcher reads twice a second for up to 30 s, so this skips the process lookup and
# reads only a window around the caret, never the whole document. Character moves keep the
# window the same on every provider.
function Field {
  $span = 2000
  $h = [NotulaDesk]::GetForegroundWindow()
  $procId = [uint32]0
  [void][NotulaDesk]::GetWindowThreadProcessId($h, [ref]$procId)
  $out = @{ result = 'no-focus'; pid = [int]$procId; window = [string][int64]$h; before = ''; selection = ''; after = ''; cutBefore = $false; cutAfter = $false }
  $el = [System.Windows.Automation.AutomationElement]::FocusedElement
  if ($null -eq $el) { return $out }
  if ($el.Current.IsPassword) { $out.result = 'secure'; return $out }
  $out.result = 'no-text'
  $tp = $null
  try { $tp = $el.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern) } catch {}
  if ($null -ne $tp) {
    $sel = $tp.GetSelection()
    if ($sel.Length -eq 0) { return $out }
    $s = $sel[0]
    $selText = $s.GetText($span + 1)
    if ($selText.Length -gt $span) { $out.result = 'wide-selection'; return $out }
    $start = [System.Windows.Automation.Text.TextPatternRangeEndpoint]::Start
    $end = [System.Windows.Automation.Text.TextPatternRangeEndpoint]::End
    $ch = [System.Windows.Automation.Text.TextUnit]::Character
    $b = $s.Clone()
    $b.MoveEndpointByRange($end, $s, $start)
    $moved = $b.MoveEndpointByUnit($start, $ch, -$span)
    $out.before = $b.GetText(-1)
    $out.cutBefore = ([math]::Abs($moved) -ge $span)
    $a = $s.Clone()
    $a.MoveEndpointByRange($start, $s, $end)
    $moved = $a.MoveEndpointByUnit($end, $ch, $span)
    $out.after = $a.GetText(-1)
    $out.cutAfter = ($moved -ge $span)
    $out.selection = $selText
    $out.result = 'read'
    return $out
  }
  $vp = $null
  try { $vp = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern) } catch {}
  if ($null -ne $vp) {
    $v = [string]$vp.Current.Value
    $out.before = Clip $v (2 * $span) $true
    $out.cutBefore = ($v.Length -gt 2 * $span)
    $out.result = 'read'
  }
  return $out
}

function Modifiers {
  $held = [NotulaDesk]::Held(0x10) -or [NotulaDesk]::Held(0x11) -or [NotulaDesk]::Held(0x12) -or [NotulaDesk]::Held(0x5B) -or [NotulaDesk]::Held(0x5C)
  return @{ held = [bool]$held }
}

function Paste {
  [System.Windows.Forms.SendKeys]::SendWait('^v')
  return @{ sent = $true }
}

$owner = $null
if ($OwnerPid -gt 0) { try { $owner = Get-Process -Id $OwnerPid -ErrorAction Stop } catch { exit 0 } }

Reply @{ id = 0; ok = $true; event = 'ready' }

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($null -ne $owner -and $owner.HasExited) { break }
  if ($line.Trim().Length -eq 0) { continue }
  $req = $null
  try { $req = $line | ConvertFrom-Json } catch { continue }
  $id = [int]$req.id
  try {
    switch ($req.op) {
      'ping' { $r = @{} }
      'foreground' { $r = Foreground }
      'context' { $r = Context }
      'field' { $r = Field }
      'modifiers' { $r = Modifiers }
      'paste' { $r = Paste }
      'dblclick' { $r = @{ ms = [int][NotulaDeskTime]::GetDoubleClickTime() } }
      'mute' {
        if (-not $script:AudioOk) { throw "audio unavailable" }
        $r = @{ changed = [bool][NotulaAudio]::SetMute($true) }
      }
      'unmute' {
        if (-not $script:AudioOk) { throw "audio unavailable" }
        $r = @{ changed = [bool][NotulaAudio]::SetMute($false) }
      }
      'fullscreen' {
        $m = [NotulaDesk]::FullscreenMonitor()
        if ($null -eq $m) { $r = @{ fullscreen = $false } } else { $r = @{ fullscreen = $true; x = $m[0]; y = $m[1] } }
      }
      default { throw "unknown op" }
    }
    $r.id = $id
    $r.ok = $true
    Reply $r
  } catch {
    Reply @{ id = $id; ok = $false; error = ($_.Exception.Message) }
  }
}
