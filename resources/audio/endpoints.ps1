# SPDX-License-Identifier: Apache-2.0
# Notula capture-endpoint monitor.
#
# Windows PowerShell 5.1 with an in-box C# helper over the Core Audio COM API (MMDevice and
# IAudioSessionManager2). While Notula captures, it lists the active capture endpoints and,
# for each, the processes whose audio session on it is in the Active state, so main can
# follow the microphone a meeting app is using. Each session carries its process's exe
# name and up to four ancestor exe names (new Teams captures from msedgewebview2.exe under
# ms-teams.exe). One JSON line on stdout when the picture changes:
#   {"t":"endpoints","list":[{"id":"{0.0.1...}","name":"Microphone (USB)","sessions":[{"pid":1,"exes":["a.exe","b.exe"]}]}]}
#
# - Observe only: it opens no audio stream, changes no device, and never touches the network.
# - Constrained Language Mode, or a helper that will not compile, prints
#   {"t":"unavailable","reason":...} and exits with code 3 (main does not restart it).
# - It exits when its owner process is gone (Windows does not end children with their parent).

param(
  [int]$IntervalMs = 1000,
  [int]$OwnerPid = 0
)

$ErrorActionPreference = 'Stop'

if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') {
  Write-Output '{"t":"unavailable","reason":"constrained-language"}'
  exit 3
}

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$native = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

namespace NotulaAudio {
  [StructLayout(LayoutKind.Sequential)] public struct PropertyKey { public Guid fmtid; public int pid; }
  [StructLayout(LayoutKind.Sequential)] public struct PropVariant { public ushort vt; public ushort r1, r2, r3; public IntPtr p; public IntPtr p2; }

  [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceEnumerator {
    [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollection devices);
  }

  [ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceCollection {
    [PreserveSig] int GetCount(out uint count);
    [PreserveSig] int Item(uint index, out IMMDevice device);
  }

  [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDevice {
    [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
    [PreserveSig] int OpenPropertyStore(int access, out IPropertyStore store);
    [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
  }

  [ComImport, Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IPropertyStore {
    [PreserveSig] int GetCount(out uint count);
    [PreserveSig] int GetAt(uint index, out PropertyKey key);
    [PreserveSig] int GetValue(ref PropertyKey key, out PropVariant value);
  }

  // IAudioSessionManager's two methods come first in the vtable.
  [ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionManager2 {
    [PreserveSig] int GetAudioSessionControl(IntPtr sessionGuid, int flags, out IntPtr control);
    [PreserveSig] int GetSimpleAudioVolume(IntPtr sessionGuid, int flags, out IntPtr volume);
    [PreserveSig] int GetSessionEnumerator(out IAudioSessionEnumerator sessions);
  }

  [ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionEnumerator {
    [PreserveSig] int GetCount(out int count);
    [PreserveSig] int GetSession(int index, [MarshalAs(UnmanagedType.IUnknown)] out object session);
  }

  // IAudioSessionControl's nine methods first, then IAudioSessionControl2's.
  [ComImport, Guid("bfb7ff88-7239-4fc9-8fa2-07c950be9c6d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionControl2 {
    [PreserveSig] int GetState(out int state);
    [PreserveSig] int GetDisplayName(out IntPtr name);
    [PreserveSig] int SetDisplayName(IntPtr name, IntPtr ctx);
    [PreserveSig] int GetIconPath(out IntPtr path);
    [PreserveSig] int SetIconPath(IntPtr path, IntPtr ctx);
    [PreserveSig] int GetGroupingParam(out Guid param);
    [PreserveSig] int SetGroupingParam(IntPtr param, IntPtr ctx);
    [PreserveSig] int RegisterAudioSessionNotification(IntPtr client);
    [PreserveSig] int UnregisterAudioSessionNotification(IntPtr client);
    [PreserveSig] int GetSessionIdentifier(out IntPtr id);
    [PreserveSig] int GetSessionInstanceIdentifier(out IntPtr id);
    [PreserveSig] int GetProcessId(out uint pid);
  }

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct ProcessEntry32 {
    public uint dwSize; public uint cntUsage; public uint th32ProcessID; public IntPtr th32DefaultHeapID;
    public uint th32ModuleID; public uint cntThreads; public uint th32ParentProcessID; public int pcPriClassBase;
    public uint dwFlags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
  }

  public static class Endpoints {
    const int eCapture = 1;
    const int DEVICE_STATE_ACTIVE = 1;
    const int CLSCTX_ALL = 23;
    const int AudioSessionStateActive = 1;
    const int VT_LPWSTR = 31;
    const uint TH32CS_SNAPPROCESS = 2;
    const int MAX_ANCESTORS = 4;
    static readonly Guid ClsidEnumerator = new Guid("BCDE0395-E52F-467C-8E3D-C4579291692E");
    static readonly Guid IidSessionManager2 = new Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F");
    static PropertyKey FriendlyName = new PropertyKey { fmtid = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"), pid = 14 };

    [DllImport("ole32.dll")] static extern int PropVariantClear(ref PropVariant v);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32FirstW(IntPtr snap, ref ProcessEntry32 e);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32NextW(IntPtr snap, ref ProcessEntry32 e);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);

    static IMMDeviceEnumerator enumerator;

    static void Release(object o) { if (o != null && Marshal.IsComObject(o)) Marshal.ReleaseComObject(o); }

    static string Esc(string s) {
      if (s == null) return "";
      var b = new StringBuilder(s.Length + 8);
      foreach (char c in s) {
        if (c == '"' || c == '\\') { b.Append('\\'); b.Append(c); }
        else if (c < 0x20) b.AppendFormat("\\u{0:x4}", (int)c);
        else b.Append(c);
      }
      return b.ToString();
    }

    static string Name(IMMDevice dev) {
      IPropertyStore store = null;
      try {
        if (dev.OpenPropertyStore(0, out store) != 0 || store == null) return "";
        PropVariant v;
        if (store.GetValue(ref FriendlyName, out v) != 0) return "";
        try { return v.vt == VT_LPWSTR && v.p != IntPtr.Zero ? Marshal.PtrToStringUni(v.p) : ""; }
        finally { PropVariantClear(ref v); }
      } finally { Release(store); }
    }

    /** Active-state session pids on one capture endpoint (system sounds, pid 0, skipped). */
    static List<uint> Sessions(IMMDevice dev) {
      var pids = new List<uint>();
      object mgrObj = null;
      IAudioSessionEnumerator sessions = null;
      try {
        Guid iid = IidSessionManager2;
        if (dev.Activate(ref iid, CLSCTX_ALL, IntPtr.Zero, out mgrObj) != 0 || mgrObj == null) return pids;
        var mgr = (IAudioSessionManager2)mgrObj;
        if (mgr.GetSessionEnumerator(out sessions) != 0 || sessions == null) return pids;
        int n;
        if (sessions.GetCount(out n) != 0) return pids;
        for (int i = 0; i < n; i++) {
          object s = null;
          try {
            if (sessions.GetSession(i, out s) != 0 || s == null) continue;
            var c = (IAudioSessionControl2)s;
            int state; uint pid;
            if (c.GetState(out state) != 0 || state != AudioSessionStateActive) continue;
            if (c.GetProcessId(out pid) != 0 || pid == 0) continue;
            if (!pids.Contains(pid)) pids.Add(pid);
          } catch { } finally { Release(s); }
        }
      } finally { Release(sessions); Release(mgrObj); }
      return pids;
    }

    static Dictionary<uint, ProcessEntry32> Processes() {
      var map = new Dictionary<uint, ProcessEntry32>();
      IntPtr snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
      if (snap == IntPtr.Zero || snap == new IntPtr(-1)) return map;
      try {
        var e = new ProcessEntry32 { dwSize = (uint)Marshal.SizeOf(typeof(ProcessEntry32)) };
        if (!Process32FirstW(snap, ref e)) return map;
        do { map[e.th32ProcessID] = e; } while (Process32NextW(snap, ref e));
      } finally { CloseHandle(snap); }
      return map;
    }

    static string Exes(uint pid, Dictionary<uint, ProcessEntry32> procs) {
      var parts = new List<string>();
      var seen = new HashSet<uint>();
      uint at = pid;
      for (int i = 0; i <= MAX_ANCESTORS && at != 0 && seen.Add(at); i++) {
        ProcessEntry32 e;
        if (!procs.TryGetValue(at, out e)) break;
        parts.Add("\"" + Esc(e.szExeFile.ToLowerInvariant()) + "\"");
        at = e.th32ParentProcessID;
      }
      return string.Join(",", parts.ToArray());
    }

    public static string Snapshot() {
      if (enumerator == null) enumerator = (IMMDeviceEnumerator)Activator.CreateInstance(Type.GetTypeFromCLSID(ClsidEnumerator));
      IMMDeviceCollection list = null;
      var rows = new List<string>();
      Dictionary<uint, ProcessEntry32> procs = null;
      try {
        if (enumerator.EnumAudioEndpoints(eCapture, DEVICE_STATE_ACTIVE, out list) != 0 || list == null) return null;
        uint count;
        if (list.GetCount(out count) != 0) return null;
        for (uint i = 0; i < count; i++) {
          IMMDevice dev = null;
          try {
            if (list.Item(i, out dev) != 0 || dev == null) continue;
            string id;
            if (dev.GetId(out id) != 0) continue;
            var pids = Sessions(dev);
            var sessions = new List<string>();
            if (pids.Count > 0) {
              if (procs == null) procs = Processes();
              pids.Sort();
              foreach (uint pid in pids) sessions.Add("{\"pid\":" + pid + ",\"exes\":[" + Exes(pid, procs) + "]}");
            }
            rows.Add("{\"id\":\"" + Esc(id) + "\",\"name\":\"" + Esc(Name(dev)) + "\",\"sessions\":[" + string.Join(",", sessions.ToArray()) + "]}");
          } finally { Release(dev); }
        }
      } finally { Release(list); }
      rows.Sort(StringComparer.Ordinal);
      return "{\"t\":\"endpoints\",\"list\":[" + string.Join(",", rows.ToArray()) + "]}";
    }
  }
}
'@

try {
  Add-Type -TypeDefinition $native -Language CSharp
} catch {
  $reason = ($_.Exception.Message -replace '[\r\n"\\]', ' ')
  if ($reason.Length -gt 200) { $reason = $reason.Substring(0, 200) }
  [Console]::Out.WriteLine('{"t":"unavailable","reason":"compile: ' + $reason + '"}')
  [Console]::Out.Flush()
  exit 3
}

$owner = $null
if ($OwnerPid -gt 0) {
  try { $owner = [System.Diagnostics.Process]::GetProcessById($OwnerPid) } catch { exit 0 }
}

$ErrorActionPreference = 'Continue'
$last = $null
$failures = 0
[Console]::Out.WriteLine('{"t":"ready"}')
[Console]::Out.Flush()
while ($null -eq $owner -or -not $owner.HasExited) {
  try {
    $line = [NotulaAudio.Endpoints]::Snapshot()
    $failures = 0
    if ($null -ne $line -and $line -ne $last) {
      [Console]::Out.WriteLine($line)
      [Console]::Out.Flush()
      $last = $line
    }
  } catch {
    # A device can vanish mid-enumeration; a run of failures means the API is not usable here.
    $failures++
    if ($failures -ge 10) {
      $reason = ($_.Exception.Message -replace '[\r\n"\\]', ' ')
      if ($reason.Length -gt 200) { $reason = $reason.Substring(0, 200) }
      [Console]::Out.WriteLine('{"t":"unavailable","reason":"snapshot: ' + $reason + '"}')
      [Console]::Out.Flush()
      exit 3
    }
  }
  [System.Threading.Thread]::Sleep($IntervalMs)
}
