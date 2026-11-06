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
#   watch-foreground {args:{on}} -> {}  starts or stops the full-screen watcher
#                  (foreground-watch.cs), whose unsolicited lines have no id:
#                  {"event":"fullscreen","full":bool,"x":int,"y":int}, once at start, then on change
#   dblclick    -> {ms}          (the double-click interval, GetDoubleClickTime)
#   duck        {args:{root, only?, factor?, ms?}} -> {entries:[{key, saved, set, device, process}]}
#                  lowers every active app session on every output device outside root's
#                  process tree to factor (0.2) x its level, fading over ms (150); levels 0..1
#   unduck      {args:{entries?:[{key, saved, set}], ms?}} -> {sessions, devices}
#                  fades what this helper lowered back up over ms (250), plus the given entries
#                  it doesn't hold (a crash marker); a level the user moved is left alone
#   levels      {args:{pid, set?}} -> {levels:[...]}  (the sessions in pid's tree, set first
#                  when given; only for the dev check, on its own player)
#   unmute      -> {changed:bool} (the default output's mute; only for an older build's marker)
# The script exits when its owner process is gone (Windows does not end children with
# their parent) or when stdin closes, raising whatever it still holds lowered. The notula-desk
# process starts it on the first request that needs it and closes its stdin after 10 idle minutes.

param([int]$OwnerPid = 0)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
# The full-screen watcher's source joins this one: one compile for both (each compile costs a
# compiler run, which is most of the script's cold start).
$deskSource = @'
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
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", EntryPoint = "GetWindowLongW")] public static extern int GetWindowLong(IntPtr h, int index);
  // ES_MULTILINE (0x4) is an edit-class style bit, so only edit windows are read; -1 = unknown.
  public static int EditMultiline(IntPtr h) {
    if (h == IntPtr.Zero) return -1;
    var cls = new StringBuilder(128); GetClassName(h, cls, 128);
    if (cls.ToString().IndexOf("edit", StringComparison.OrdinalIgnoreCase) < 0) return -1;
    return (GetWindowLong(h, -16) & 0x4) != 0 ? 1 : 0;
  }
}
public static class NotulaDeskTime {
  [DllImport("user32.dll")] public static extern uint GetDoubleClickTime();
}
'@
Add-Type -TypeDefinition ($deskSource + [Environment]::NewLine + [System.IO.File]::ReadAllText((Join-Path $PSScriptRoot 'foreground-watch.cs')))

# Other apps' audio (Core Audio). Optional: without it, duck, unduck, levels and unmute fail.
# Ducking lowers each app's own session volume on every active output device, so headphones
# and speakers alike; the device volumes and the user's mixer are never touched. Core Audio
# runs on MTA threads so a fade never holds the request loop; one lock orders the ducks and
# restores. Sessions are named by a short hash of their session id, never by the app.
$script:AudioOk = $false
try {
  Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
[ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface INotulaEndpointVolume {
  [PreserveSig] int RegisterControlChangeNotify(IntPtr p);
  [PreserveSig] int UnregisterControlChangeNotify(IntPtr p);
  [PreserveSig] int GetChannelCount(out uint c);
  [PreserveSig] int SetMasterVolumeLevel(float l, IntPtr ctx);
  [PreserveSig] int SetMasterVolumeLevelScalar(float l, IntPtr ctx);
  [PreserveSig] int GetMasterVolumeLevel(out float l);
  [PreserveSig] int GetMasterVolumeLevelScalar(out float l);
  [PreserveSig] int SetChannelVolumeLevel(uint ch, float l, IntPtr ctx);
  [PreserveSig] int SetChannelVolumeLevelScalar(uint ch, float l, IntPtr ctx);
  [PreserveSig] int GetChannelVolumeLevel(uint ch, out float l);
  [PreserveSig] int GetChannelVolumeLevelScalar(uint ch, out float l);
  [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, IntPtr ctx);
  [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
}
[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface INotulaMMDevice {
  [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr p, [MarshalAs(UnmanagedType.IUnknown)] out object o);
}
[ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface INotulaMMDeviceCollection {
  [PreserveSig] int GetCount(out uint n);
  [PreserveSig] int Item(uint i, out INotulaMMDevice device);
}
[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface INotulaMMDeviceEnumerator {
  [PreserveSig] int EnumAudioEndpoints(int flow, int mask, out INotulaMMDeviceCollection devices);
  [PreserveSig] int GetDefaultAudioEndpoint(int flow, int role, out INotulaMMDevice device);
}
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class NotulaMMDeviceEnumerator {}
[ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface INotulaSessionManager2 {
  [PreserveSig] int GetAudioSessionControl(IntPtr guid, uint flags, out IntPtr control);
  [PreserveSig] int GetSimpleAudioVolume(IntPtr guid, uint flags, out IntPtr volume);
  [PreserveSig] int GetSessionEnumerator(out INotulaSessionEnumerator sessions);
}
[ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface INotulaSessionEnumerator {
  [PreserveSig] int GetCount(out int n);
  [PreserveSig] int GetSession(int i, [MarshalAs(UnmanagedType.IUnknown)] out object session);
}
[ComImport, Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface INotulaSessionControl2 {
  [PreserveSig] int GetState(out int state);
  [PreserveSig] int GetDisplayName(out IntPtr name);
  [PreserveSig] int SetDisplayName(IntPtr name, IntPtr ctx);
  [PreserveSig] int GetIconPath(out IntPtr path);
  [PreserveSig] int SetIconPath(IntPtr path, IntPtr ctx);
  [PreserveSig] int GetGroupingParam(out Guid g);
  [PreserveSig] int SetGroupingParam(IntPtr g, IntPtr ctx);
  [PreserveSig] int RegisterAudioSessionNotification(IntPtr n);
  [PreserveSig] int UnregisterAudioSessionNotification(IntPtr n);
  [PreserveSig] int GetSessionIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id);
  [PreserveSig] int GetSessionInstanceIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id);
  [PreserveSig] int GetProcessId(out uint pid);
  [PreserveSig] int IsSystemSoundsSession();
}
[ComImport, Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface INotulaSimpleVolume {
  [PreserveSig] int SetMasterVolume(float level, IntPtr ctx);
  [PreserveSig] int GetMasterVolume(out float level);
  [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, IntPtr ctx);
  [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
}

// The default output's mute switch: only to undo a marker an older build left.
public static class NotulaAudio {
  public static bool SetMute(bool on) {
    var e = (INotulaMMDeviceEnumerator)(new NotulaMMDeviceEnumerator());
    INotulaMMDevice dev;
    Marshal.ThrowExceptionForHR(e.GetDefaultAudioEndpoint(0, 1, out dev));
    var iid = typeof(INotulaEndpointVolume).GUID;
    object o;
    Marshal.ThrowExceptionForHR(dev.Activate(ref iid, 23, IntPtr.Zero, out o));
    var v = (INotulaEndpointVolume)o;
    bool was;
    Marshal.ThrowExceptionForHR(v.GetMute(out was));
    if (was == on) return false;
    Marshal.ThrowExceptionForHR(v.SetMute(on, IntPtr.Zero));
    return true;
  }
}

public class NotulaDuckEntry {
  public string Key;
  public string Process;
  public int Device;
  public float Saved;
  public float Set;
  internal string Instance;
  internal float Last;
  internal bool Dropped;
  internal INotulaSimpleVolume Vol;
  internal INotulaSessionControl2 Ctl;
}

public static class NotulaDuck {
  const float Tol = 0.02f;
  static readonly object Gate = new object();
  static List<NotulaDuckEntry> held = new List<NotulaDuckEntry>();
  static Thread last;

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct ProcEntry {
    public uint dwSize; public uint cntUsage; public uint th32ProcessID; public IntPtr th32DefaultHeapID;
    public uint th32ModuleID; public uint cntThreads; public uint th32ParentProcessID; public int pcPriClassBase;
    public uint dwFlags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
  }
  [DllImport("kernel32.dll")] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)] static extern bool Process32FirstW(IntPtr snap, ref ProcEntry e);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)] static extern bool Process32NextW(IntPtr snap, ref ProcEntry e);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);

  class Procs { public Dictionary<uint, uint> Parent = new Dictionary<uint, uint>(); public Dictionary<uint, string> Name = new Dictionary<uint, string>(); }
  class Found { public uint Pid; public string Key; public string Instance; public int Device; public INotulaSimpleVolume Vol; public INotulaSessionControl2 Ctl; }
  class Spec { public string Key; public float Saved; public float Set; }

  static Procs Snapshot() {
    var p = new Procs();
    IntPtr snap = CreateToolhelp32Snapshot(2, 0);
    if (snap == IntPtr.Zero || snap == new IntPtr(-1)) return p;
    try {
      var e = new ProcEntry(); e.dwSize = (uint)Marshal.SizeOf(typeof(ProcEntry));
      for (bool ok = Process32FirstW(snap, ref e); ok; ok = Process32NextW(snap, ref e)) {
        p.Parent[e.th32ProcessID] = e.th32ParentProcessID;
        p.Name[e.th32ProcessID] = e.szExeFile;
      }
    } finally { CloseHandle(snap); }
    return p;
  }

  // pid is root or descends from it. Depth-capped: a parent id can be reused by a later process.
  static bool Under(Procs p, uint pid, uint root) {
    for (int i = 0; i < 64 && pid != 0; i++) {
      if (pid == root) return true;
      uint up;
      if (!p.Parent.TryGetValue(pid, out up) || up == pid) return false;
      pid = up;
    }
    return false;
  }

  // The session identifier names the app on a device and outlives the process; Windows keeps
  // an app's level under it, so a restarted app comes back at the level it left with.
  static string KeyOf(string identifier) {
    using (var h = SHA256.Create()) {
      var b = h.ComputeHash(Encoding.UTF8.GetBytes(identifier));
      return BitConverter.ToString(b, 0, 8).Replace("-", "").ToLowerInvariant();
    }
  }

  // App sessions on every active output device; system sounds and shared sessions are left out.
  static List<Found> Sessions(bool activeOnly) {
    var list = new List<Found>();
    var en = (INotulaMMDeviceEnumerator)(new NotulaMMDeviceEnumerator());
    INotulaMMDeviceCollection devs;
    Marshal.ThrowExceptionForHR(en.EnumAudioEndpoints(0, 1, out devs));
    uint n;
    Marshal.ThrowExceptionForHR(devs.GetCount(out n));
    var iid = typeof(INotulaSessionManager2).GUID;
    for (uint i = 0; i < n; i++) {
      try {
        INotulaMMDevice dev;
        if (devs.Item(i, out dev) != 0) continue;
        object o;
        if (dev.Activate(ref iid, 23, IntPtr.Zero, out o) != 0) continue;
        INotulaSessionEnumerator se;
        if (((INotulaSessionManager2)o).GetSessionEnumerator(out se) != 0) continue;
        int c;
        if (se.GetCount(out c) != 0) continue;
        for (int k = 0; k < c; k++) {
          object so;
          if (se.GetSession(k, out so) != 0) continue;
          var ctl = so as INotulaSessionControl2;
          var vol = so as INotulaSimpleVolume;
          if (ctl == null || vol == null) continue;
          int state;
          if (activeOnly && (ctl.GetState(out state) != 0 || state != 1)) continue;
          if (ctl.IsSystemSoundsSession() == 0) continue;
          uint pid;
          if (ctl.GetProcessId(out pid) != 0 || pid == 0) continue;
          string ident, inst;
          if (ctl.GetSessionIdentifier(out ident) != 0 || string.IsNullOrEmpty(ident)) continue;
          if (ctl.GetSessionInstanceIdentifier(out inst) != 0 || string.IsNullOrEmpty(inst)) continue;
          var f = new Found(); f.Pid = pid; f.Key = KeyOf(ident); f.Instance = inst; f.Device = (int)i; f.Vol = vol; f.Ctl = ctl;
          list.Add(f);
        }
      } catch { /* one device failing leaves the others */ }
    }
    return list;
  }

  // Processes with an active input session: audio routers and virtual mixers (they take one
  // app's sound in and play it out again) and call apps. Lowering a router too would stack
  // the dip on every hop of the chain, and a call should stay as loud as the user set it.
  static HashSet<uint> Capturing() {
    var pids = new HashSet<uint>();
    var en = (INotulaMMDeviceEnumerator)(new NotulaMMDeviceEnumerator());
    INotulaMMDeviceCollection devs;
    if (en.EnumAudioEndpoints(1, 1, out devs) != 0) return pids;
    uint n;
    if (devs.GetCount(out n) != 0) return pids;
    var iid = typeof(INotulaSessionManager2).GUID;
    for (uint i = 0; i < n; i++) {
      try {
        INotulaMMDevice dev;
        if (devs.Item(i, out dev) != 0) continue;
        object o;
        if (dev.Activate(ref iid, 23, IntPtr.Zero, out o) != 0) continue;
        INotulaSessionEnumerator se;
        if (((INotulaSessionManager2)o).GetSessionEnumerator(out se) != 0) continue;
        int c;
        if (se.GetCount(out c) != 0) continue;
        for (int k = 0; k < c; k++) {
          object so;
          if (se.GetSession(k, out so) != 0) continue;
          var ctl = so as INotulaSessionControl2;
          if (ctl == null) continue;
          int state;
          if (ctl.GetState(out state) != 0 || state != 1) continue;
          uint pid;
          if (ctl.GetProcessId(out pid) == 0 && pid != 0) pids.Add(pid);
        }
      } catch { /* one device failing leaves the others */ }
    }
    return pids;
  }

  // Steps every live entry toward Set (down) or Saved (up), never above Saved. A level that
  // moved since Notula's last step is the user's: that session is let go and never raised.
  static void Fade(List<NotulaDuckEntry> list, bool up, int ms) {
    int steps = Math.Max(1, ms / 30);
    var from = new Dictionary<NotulaDuckEntry, float>();
    foreach (var e in list) from[e] = e.Last;
    for (int s = 1; s <= steps; s++) {
      foreach (var e in list) {
        if (e.Dropped) continue;
        try {
          float cur;
          Marshal.ThrowExceptionForHR(e.Vol.GetMasterVolume(out cur));
          if (Math.Abs(cur - e.Last) > Tol) { e.Dropped = true; continue; }
          float to = up ? e.Saved : e.Set;
          float v = Math.Min(e.Saved, from[e] + (to - from[e]) * s / steps);
          Marshal.ThrowExceptionForHR(e.Vol.SetMasterVolume(v, IntPtr.Zero));
          e.Last = v;
        } catch { e.Dropped = true; /* the session ended */ }
      }
      if (s < steps) Thread.Sleep(ms / steps);
    }
  }

  // Runs body on an MTA thread holding the lock; the caller waits until body reaches its
  // first answer (ready), then the rest (the fade) carries on in the background.
  static void Run(Func<Action> body, int waitMs) {
    Exception err = null;
    var ready = new ManualResetEvent(false);
    var t = new Thread(delegate () {
      lock (Gate) {
        Action rest = null;
        try { rest = body(); } catch (Exception x) { err = x; }
        ready.Set();
        if (rest != null) rest();
      }
    });
    t.IsBackground = true;
    t.SetApartmentState(ApartmentState.MTA);
    last = t;
    t.Start();
    if (!ready.WaitOne(waitMs)) throw new TimeoutException("audio sessions did not answer");
    if (err != null) throw err;
  }

  // Lowers every active session outside root's process tree (only > 0: just that tree, for the
  // dev check) to factor x its level over ms. Sessions already held keep their first level.
  public static NotulaDuckEntry[] Duck(int root, int only, float factor, int ms) {
    NotulaDuckEntry[] got = null;
    Run(delegate () {
      var procs = Snapshot();
      var capturing = Capturing();
      var mine = new List<NotulaDuckEntry>();
      foreach (var f in Sessions(true)) {
        if (root > 0 && Under(procs, f.Pid, (uint)root)) continue;
        if (only > 0 && !Under(procs, f.Pid, (uint)only)) continue;
        if (capturing.Contains(f.Pid)) continue;
        string inst = f.Instance;
        if (held.Exists(delegate (NotulaDuckEntry h) { return h.Instance == inst; })) continue;
        float lv;
        bool muted;
        if (f.Vol.GetMasterVolume(out lv) != 0 || lv < 0.01f) continue;
        if (f.Vol.GetMute(out muted) == 0 && muted) continue;
        string name;
        procs.Name.TryGetValue(f.Pid, out name);
        var e = new NotulaDuckEntry();
        e.Key = f.Key; e.Instance = inst; e.Process = name ?? ""; e.Device = f.Device; e.Vol = f.Vol; e.Ctl = f.Ctl;
        e.Saved = lv; e.Set = lv * factor; e.Last = lv;
        mine.Add(e);
      }
      held.AddRange(mine);
      got = mine.ToArray();
      return delegate () { Fade(mine, false, ms); };
    }, 1500);
    return got;
  }

  // Raises what this helper holds. Looked up again by key, only when the level still sits
  // between Set and Saved: the given entries it doesn't hold (a marker from a crash, or a
  // helper that died) and held sessions that ended (their app may have started a new one).
  // A session the user moved stays let go. Returns {sessions, devices}.
  public static int[] Unduck(string[] keys, float[] saved, float[] set, int ms) {
    int[] counts = null;
    Run(delegate () {
      var list = new List<NotulaDuckEntry>();
      var specs = new Dictionary<string, Spec>();
      var known = new HashSet<string>();
      foreach (var h in held) {
        known.Add(h.Key);
        if (h.Dropped) continue;
        int st;
        if (h.Ctl.GetState(out st) == 0 && st != 2) { list.Add(h); continue; }
        var sp = new Spec(); sp.Key = h.Key; sp.Saved = h.Saved; sp.Set = h.Set;
        specs[h.Key] = sp;
      }
      held = new List<NotulaDuckEntry>();
      if (keys != null) for (int i = 0; i < keys.Length; i++) {
        if (known.Contains(keys[i])) continue;
        var sp = new Spec(); sp.Key = keys[i]; sp.Saved = saved[i]; sp.Set = set[i];
        specs[keys[i]] = sp;
      }
      if (specs.Count > 0) {
        foreach (var f in Sessions(false)) {
          Spec sp;
          if (!specs.TryGetValue(f.Key, out sp)) continue;
          string inst = f.Instance;
          if (list.Exists(delegate (NotulaDuckEntry h) { return h.Instance == inst; })) continue;
          float cur;
          if (f.Vol.GetMasterVolume(out cur) != 0) continue;
          if (cur < sp.Set - Tol || cur > sp.Saved + Tol) continue;
          var e = new NotulaDuckEntry();
          e.Key = f.Key; e.Instance = inst; e.Process = ""; e.Device = f.Device; e.Vol = f.Vol; e.Ctl = f.Ctl;
          e.Saved = sp.Saved; e.Set = sp.Set; e.Last = cur;
          list.Add(e);
        }
      }
      var devs = new HashSet<int>();
      foreach (var e in list) devs.Add(e.Device);
      counts = new int[] { list.Count, devs.Count };
      return delegate () { Fade(list, true, ms); };
    }, 1500);
    return counts;
  }

  // Levels of the sessions in pid's process tree, set first when level >= 0. Only the dev
  // check calls this, on its own player.
  public static float[] Levels(int pid, float level) {
    var outl = new List<float>();
    Run(delegate () {
      var procs = Snapshot();
      foreach (var f in Sessions(false)) {
        if (!Under(procs, f.Pid, (uint)pid)) continue;
        if (level >= 0) Marshal.ThrowExceptionForHR(f.Vol.SetMasterVolume(level, IntPtr.Zero));
        float lv;
        if (f.Vol.GetMasterVolume(out lv) == 0) outl.Add(lv);
      }
      return null;
    }, 1500);
    return outl.ToArray();
  }

  // Waits for a fade still running (the script's exit).
  public static void Settle(int ms) {
    var t = last;
    if (t != null) t.Join(ms);
  }
}
'@
  $script:AudioOk = $true
} catch {}

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
      'duck' {
        if (-not $script:AudioOk) { throw "audio unavailable" }
        $a = $req.args
        $factor = 0.2; if ($null -ne $a.factor) { $factor = [float]$a.factor }
        $ms = 150; if ($null -ne $a.ms) { $ms = [int]$a.ms }
        $got = [NotulaDuck]::Duck([int]$a.root, [int]$a.only, $factor, $ms)
        $list = @(foreach ($e in $got) { @{ key = $e.Key; saved = [Math]::Round([double]$e.Saved, 4); set = [Math]::Round([double]$e.Set, 4); device = $e.Device; process = $e.Process } })
        $r = @{ entries = $list }
      }
      'unduck' {
        if (-not $script:AudioOk) { throw "audio unavailable" }
        $a = $req.args
        $ms = 250; if ($null -ne $a.ms) { $ms = [int]$a.ms }
        $keys = New-Object System.Collections.Generic.List[string]
        $saved = New-Object System.Collections.Generic.List[float]
        $set = New-Object System.Collections.Generic.List[float]
        foreach ($e in @($a.entries)) {
          if ($null -eq $e -or $null -eq $e.key) { continue }
          $keys.Add([string]$e.key); $saved.Add([float]$e.saved); $set.Add([float]$e.set)
        }
        $c = [NotulaDuck]::Unduck($keys.ToArray(), $saved.ToArray(), $set.ToArray(), $ms)
        $r = @{ sessions = $c[0]; devices = $c[1] }
      }
      'levels' {
        if (-not $script:AudioOk) { throw "audio unavailable" }
        $level = -1; if ($null -ne $req.args.set) { $level = [float]$req.args.set }
        $r = @{ levels = @([NotulaDuck]::Levels([int]$req.args.pid, $level) | ForEach-Object { [Math]::Round([double]$_, 4) }) }
      }
      'unmute' {
        if (-not $script:AudioOk) { throw "audio unavailable" }
        $r = @{ changed = [bool][NotulaAudio]::SetMute($false) }
      }
      'watch-foreground' {
        if ([bool]$req.args.on) { [Notula.Desk.ForegroundWatch]::Start() } else { [Notula.Desk.ForegroundWatch]::Stop() }
        $r = @{}
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

[Notula.Desk.ForegroundWatch]::Stop()
if ($script:AudioOk) {
  try {
    [void][NotulaDuck]::Unduck($null, $null, $null, 100)
    [NotulaDuck]::Settle(1000)
  } catch {}
}
