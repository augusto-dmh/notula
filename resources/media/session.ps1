# SPDX-License-Identifier: Apache-2.0
# Notula media-session reader (content sources, passive provider).
#
# Windows PowerShell 5.1. Windows PowerShell can't subscribe to WinRT events itself, so a small
# C# shim is compiled at start with the in-box .NET Framework compiler (CodeDom, explicit WinRT
# references, no SDK) and runs the whole loop:
#
# - It subscribes to the system media sessions (SessionsChanged, CurrentSessionChanged and each
#   session's MediaPropertiesChanged, PlaybackInfoChanged and TimelinePropertiesChanged) and
#   waits on wait handles: no polling. A burst is collapsed for 150 ms, then one `sessions` line
#   is printed if anything changed. Timeline-only changes print at most once a second.
# - Lines (UTF-8 JSON, one per line on stdout):
#     {"ev":"ready","msCompile":n,"ms":n}
#     {"ev":"sessions","cause":"media+playback","sessions":[{"app","cur","title","artist","album",
#       "status","posMs","endMs","rate","updated"}]}            updated = epoch ms of the timeline
#     {"ev":"locate","id":n,"matches":[{"window","tab","sel","addr"}],"windows":n,"ms":n}
#     {"ev":"unavailable","reason":"..."}                        then exit 3, no restarts
# - Commands on stdin, one per line, tab-separated:
#     locate <id> <process> <base64 UTF-8 title> <1|0 address>
#   reads the tab strip of that browser's windows (UI Automation, the browser's own toolbar and
#   tab strip only: it never descends into a web page), returns the tabs whose name starts with
#   the title, and the address bar only for a matched tab that is the selected one. It never
#   clicks, focuses or switches anything.
# - Only the app ids in -Apps are reported (the measured browsers).
# - It exits when stdin closes (main's stop) or when the -OwnerPid process is gone.
# - Constrained Language Mode, missing WinRT metadata, a compile failure or no media-session
#   manager print `unavailable` and exit 3.

param(
  [int]$OwnerPid = 0,
  [string]$Apps = ''
)

$ErrorActionPreference = 'Stop'

# Constrained Language Mode blocks everything below: say so with cmdlets only, and stop.
if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') {
  Write-Output '{"ev":"unavailable","reason":"constrained-language"}'
  exit 3
}

function Exit-Unavailable([string]$reason) {
  [Console]::Out.WriteLine('{"ev":"unavailable","reason":"' + $reason + '"}')
  [Console]::Out.Flush()
  exit 3
}

$sw = [Diagnostics.Stopwatch]::StartNew()

$src = @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Automation;
using Microsoft.Win32.SafeHandles;
using Windows.Foundation;
using Windows.Media.Control;

public static class NotulaMediaReader {
  const int C_SESSIONS = 1, C_CURRENT = 2, C_MEDIA = 4, C_PLAYBACK = 8, C_TIMELINE = 16;

  static GlobalSystemMediaTransportControlsSessionManager Mgr;
  static readonly AutoResetEvent Changed = new AutoResetEvent(false);
  static readonly AutoResetEvent CmdReady = new AutoResetEvent(false);
  static readonly ManualResetEvent Quit = new ManualResetEvent(false);
  static readonly object Gate = new object();
  // Writes take their own lock: a slow stdout must never block the WinRT event callbacks.
  static readonly object OutGate = new object();
  static readonly Queue<string> Cmds = new Queue<string>();
  static readonly List<Hook> Hooks = new List<Hook>();
  static int Causes;
  static HashSet<string> Apps;
  static StreamWriter Out;
  static string LastSessions = "";

  sealed class Hook {
    public GlobalSystemMediaTransportControlsSession Session;
    public TypedEventHandler<GlobalSystemMediaTransportControlsSession, MediaPropertiesChangedEventArgs> Media;
    public TypedEventHandler<GlobalSystemMediaTransportControlsSession, PlaybackInfoChangedEventArgs> Playback;
    public TypedEventHandler<GlobalSystemMediaTransportControlsSession, TimelinePropertiesChangedEventArgs> Timeline;
  }

  static void Mark(int cause) {
    lock (Gate) { Causes |= cause; }
    Changed.Set();
  }

  // No AsTask (its facade needs the SDK's union Windows.winmd): wait on the status.
  static T Wait<T>(IAsyncOperation<T> op) {
    DateTime until = DateTime.UtcNow.AddSeconds(5);
    while (op.Status == AsyncStatus.Started) {
      if (DateTime.UtcNow > until) throw new TimeoutException();
      Thread.Sleep(2);
    }
    return op.GetResults();
  }

  public static void Line(string json) {
    lock (OutGate) { Out.WriteLine(json); Out.Flush(); }
  }

  public static string Esc(string s) {
    if (s == null) return "";
    StringBuilder b = new StringBuilder(s.Length + 8);
    foreach (char c in s) {
      if (c == '"') b.Append("\\\"");
      else if (c == '\\') b.Append("\\\\");
      else if (c < 0x20 || c == 0x2028 || c == 0x2029) b.Append("\\u").Append(((int)c).ToString("x4"));
      else b.Append(c);
    }
    return b.ToString();
  }

  static string Num(double v) {
    if (double.IsNaN(v) || double.IsInfinity(v)) return "null";
    return Math.Round(v).ToString("0", CultureInfo.InvariantCulture);
  }

  static bool Wanted(string app) {
    return Apps == null || (app != null && Apps.Contains(app));
  }

  // Hooks every current session once; drops the ones that are gone.
  static void Rehook() {
    IReadOnlyList<GlobalSystemMediaTransportControlsSession> now;
    try { now = Mgr.GetSessions(); } catch (Exception) { return; }
    List<GlobalSystemMediaTransportControlsSession> live = new List<GlobalSystemMediaTransportControlsSession>();
    foreach (GlobalSystemMediaTransportControlsSession x in now) live.Add(x);
    for (int i = Hooks.Count - 1; i >= 0; i--) {
      Hook h = Hooks[i];
      if (live.Contains(h.Session)) continue;
      try {
        h.Session.MediaPropertiesChanged -= h.Media;
        h.Session.PlaybackInfoChanged -= h.Playback;
        h.Session.TimelinePropertiesChanged -= h.Timeline;
      } catch (Exception) { }
      Hooks.RemoveAt(i);
    }
    foreach (GlobalSystemMediaTransportControlsSession x in live) {
      bool known = false;
      foreach (Hook h in Hooks) if (object.ReferenceEquals(h.Session, x)) { known = true; break; }
      if (known) continue;
      string app;
      try { app = x.SourceAppUserModelId; } catch (Exception) { continue; }
      if (!Wanted(app)) continue;
      Hook n = new Hook();
      n.Session = x;
      n.Media = (s, e) => Mark(C_MEDIA);
      n.Playback = (s, e) => Mark(C_PLAYBACK);
      n.Timeline = (s, e) => Mark(C_TIMELINE);
      try {
        x.MediaPropertiesChanged += n.Media;
        x.PlaybackInfoChanged += n.Playback;
        x.TimelinePropertiesChanged += n.Timeline;
        Hooks.Add(n);
      } catch (Exception) { }
    }
  }

  static string CauseName(int c) {
    List<string> l = new List<string>();
    if ((c & C_SESSIONS) != 0) l.Add("sessions");
    if ((c & C_CURRENT) != 0) l.Add("current");
    if ((c & C_MEDIA) != 0) l.Add("media");
    if ((c & C_PLAYBACK) != 0) l.Add("playback");
    if ((c & C_TIMELINE) != 0) l.Add("timeline");
    return l.Count == 0 ? "initial" : string.Join("+", l.ToArray());
  }

  static void EmitSessions(string cause) {
    StringBuilder sb = new StringBuilder(512);
    string cur = null;
    try {
      GlobalSystemMediaTransportControlsSession c = Mgr.GetCurrentSession();
      if (c != null) cur = c.SourceAppUserModelId;
    } catch (Exception) { }
    bool first = true;
    IReadOnlyList<GlobalSystemMediaTransportControlsSession> all;
    try { all = Mgr.GetSessions(); } catch (Exception) { all = new List<GlobalSystemMediaTransportControlsSession>(); }
    foreach (GlobalSystemMediaTransportControlsSession x in all) {
      try {
        string app = x.SourceAppUserModelId;
        if (!Wanted(app)) continue;
        GlobalSystemMediaTransportControlsSessionMediaProperties p = Wait(x.TryGetMediaPropertiesAsync());
        GlobalSystemMediaTransportControlsSessionTimelineProperties tl = x.GetTimelineProperties();
        GlobalSystemMediaTransportControlsSessionPlaybackInfo pb = x.GetPlaybackInfo();
        double? rate = pb.PlaybackRate;
        StringBuilder one = new StringBuilder(256);
        one.Append("{\"app\":\"").Append(Esc(app));
        one.Append("\",\"cur\":").Append(app == cur ? "true" : "false");
        one.Append(",\"title\":\"").Append(Esc(p.Title));
        one.Append("\",\"artist\":\"").Append(Esc(p.Artist));
        one.Append("\",\"album\":\"").Append(Esc(p.AlbumTitle));
        one.Append("\",\"status\":\"").Append(pb.PlaybackStatus.ToString());
        one.Append("\",\"posMs\":").Append(Num(tl.Position.TotalMilliseconds));
        one.Append(",\"endMs\":").Append(Num(tl.EndTime.TotalMilliseconds));
        one.Append(",\"rate\":").Append(rate.HasValue && !double.IsNaN(rate.Value) && !double.IsInfinity(rate.Value) ? rate.Value.ToString("R", CultureInfo.InvariantCulture) : "null");
        one.Append(",\"updated\":").Append(tl.LastUpdatedTime.ToUnixTimeMilliseconds().ToString(CultureInfo.InvariantCulture));
        one.Append("}");
        if (!first) sb.Append(",");
        sb.Append(one.ToString());
        first = false;
      } catch (Exception) {
        // The session closed while it was read.
      }
    }
    string list = sb.ToString();
    if (list == LastSessions && cause != "initial") return;
    LastSessions = list;
    Line("{\"ev\":\"sessions\",\"cause\":\"" + cause + "\",\"sessions\":[" + list + "]}");
  }

  static void ReadStdin() {
    try {
      StreamReader r = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
      string l;
      while ((l = r.ReadLine()) != null) {
        if (l.Length == 0 || l.Length > 8192) continue;
        lock (Gate) { if (Cmds.Count < 32) Cmds.Enqueue(l); }
        CmdReady.Set();
      }
    } catch (Exception) { }
    Quit.Set();
  }

  static void HandleCommand(string line) {
    string[] f = line.Split('\t');
    if (f.Length < 5 || f[0] != "locate") return;
    int id;
    if (!int.TryParse(f[1], NumberStyles.Integer, CultureInfo.InvariantCulture, out id)) return;
    string process = f[2];
    if (process != "msedge" && process != "chrome" && process != "brave") return;
    string title;
    try { title = Encoding.UTF8.GetString(Convert.FromBase64String(f[3])); } catch (Exception) { return; }
    string result;
    try { result = NotulaTabs.Locate(id, process, title, f[4] == "1"); }
    catch (Exception) { result = "{\"ev\":\"locate\",\"id\":" + id.ToString(CultureInfo.InvariantCulture) + ",\"matches\":[],\"windows\":0,\"ms\":0,\"error\":true}"; }
    Line(result);
  }

  public static int Run(int ownerPid, string apps, int msCompile, long msStart) {
    Out = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
    if (!string.IsNullOrEmpty(apps)) Apps = new HashSet<string>(apps.Split(','), StringComparer.OrdinalIgnoreCase);
    WaitHandle owner = new ManualResetEvent(false);
    Process ownerProc = null;
    if (ownerPid > 0) {
      try {
        ownerProc = Process.GetProcessById(ownerPid);
        ManualResetEvent h = new ManualResetEvent(false);
        h.SafeWaitHandle = new SafeWaitHandle(ownerProc.Handle, false);
        owner = h;
      } catch (Exception) {
        return 0;
      }
    }
    try {
      Mgr = Wait(GlobalSystemMediaTransportControlsSessionManager.RequestAsync());
    } catch (Exception) {
      Line("{\"ev\":\"unavailable\",\"reason\":\"no-session-manager\"}");
      return 3;
    }
    if (Mgr == null) {
      Line("{\"ev\":\"unavailable\",\"reason\":\"no-session-manager\"}");
      return 3;
    }
    Mgr.SessionsChanged += (s, e) => Mark(C_SESSIONS);
    Mgr.CurrentSessionChanged += (s, e) => Mark(C_CURRENT);
    Rehook();
    Thread reader = new Thread(ReadStdin);
    reader.IsBackground = true;
    reader.Start();
    Line("{\"ev\":\"ready\",\"msCompile\":" + msCompile.ToString(CultureInfo.InvariantCulture) + ",\"ms\":" + msStart.ToString(CultureInfo.InvariantCulture) + "}");
    EmitSessions("initial");

    WaitHandle[] handles = new WaitHandle[] { Quit, owner, Changed, CmdReady };
    Stopwatch clock = Stopwatch.StartNew();
    long lastEmit = -1000;
    while (true) {
      int i = WaitHandle.WaitAny(handles);
      if (i == 0 || i == 1) break;
      if (i == 2) {
        // Collapse a burst, then read once.
        Thread.Sleep(150);
        int c;
        lock (Gate) { c = Causes; Causes = 0; }
        if (c == 0) continue;
        if (c == C_TIMELINE) {
          long wait = 1000 - (clock.ElapsedMilliseconds - lastEmit);
          if (wait > 0) {
            if (Quit.WaitOne((int)wait)) break;
            lock (Gate) { c |= Causes; Causes = 0; }
          }
        }
        if ((c & C_SESSIONS) != 0) Rehook();
        EmitSessions(CauseName(c));
        lastEmit = clock.ElapsedMilliseconds;
      } else {
        while (true) {
          string cmd;
          lock (Gate) {
            if (Cmds.Count == 0) break;
            cmd = Cmds.Dequeue();
          }
          HandleCommand(cmd);
        }
      }
    }
    GC.KeepAlive(ownerProc);
    return 0;
  }
}

// The tab strip and the address bar, on demand. A separate class, so UI Automation loads only
// when the first command arrives.
public static class NotulaTabs {
  static readonly Regex Count = new Regex("^\\(\\d+\\+?\\)\\s+");
  const int MaxNodes = 3000, MaxDepth = 16, MaxMatches = 8;

  static string StripCount(string s) {
    return Count.Replace(s == null ? "" : s.Trim(), "");
  }

  // The browser's own UI only: breadth-first over children, never into a web page (Document).
  static void Walk(AutomationElement window, List<AutomationElement> tabs, ref AutomationElement edit) {
    CacheRequest cr = new CacheRequest();
    cr.Add(AutomationElement.ControlTypeProperty);
    cr.Add(AutomationElement.NameProperty);
    cr.TreeScope = TreeScope.Element;
    Queue<KeyValuePair<AutomationElement, int>> q = new Queue<KeyValuePair<AutomationElement, int>>();
    q.Enqueue(new KeyValuePair<AutomationElement, int>(window, 0));
    int nodes = 0;
    using (cr.Activate()) {
      while (q.Count > 0 && nodes < MaxNodes) {
        KeyValuePair<AutomationElement, int> item = q.Dequeue();
        AutomationElementCollection kids;
        try { kids = item.Key.FindAll(TreeScope.Children, Condition.TrueCondition); } catch (Exception) { continue; }
        foreach (AutomationElement k in kids) {
          nodes++;
          ControlType ct;
          try { ct = (ControlType)k.GetCachedPropertyValue(AutomationElement.ControlTypeProperty); } catch (Exception) { continue; }
          if (ct == ControlType.Document) continue;
          if (ct == ControlType.TabItem) { tabs.Add(k); continue; }
          if (ct == ControlType.Edit) { if (edit == null) edit = k; continue; }
          if (item.Value + 1 < MaxDepth) q.Enqueue(new KeyValuePair<AutomationElement, int>(k, item.Value + 1));
        }
      }
    }
  }

  public static string Locate(int id, string process, string title, bool wantAddress) {
    Stopwatch sw = Stopwatch.StartNew();
    HashSet<int> pids = new HashSet<int>();
    foreach (Process p in Process.GetProcessesByName(process)) { pids.Add(p.Id); p.Dispose(); }
    StringBuilder sb = new StringBuilder(512);
    sb.Append("{\"ev\":\"locate\",\"id\":").Append(id.ToString(CultureInfo.InvariantCulture)).Append(",\"matches\":[");
    int windows = 0, found = 0;
    string want = StripCount(title);
    if (pids.Count > 0 && want.Length > 0) {
      AutomationElementCollection wins = AutomationElement.RootElement.FindAll(
        TreeScope.Children, new PropertyCondition(AutomationElement.ClassNameProperty, "Chrome_WidgetWin_1"));
      foreach (AutomationElement w in wins) {
        if (found >= MaxMatches) break;
        int wpid;
        string wname;
        try { wpid = w.Current.ProcessId; wname = w.Current.Name; } catch (Exception) { continue; }
        if (!pids.Contains(wpid) || string.IsNullOrEmpty(wname)) continue;
        windows++;
        List<AutomationElement> tabs = new List<AutomationElement>();
        AutomationElement edit = null;
        Walk(w, tabs, ref edit);
        foreach (AutomationElement t in tabs) {
          if (found >= MaxMatches) break;
          string name;
          try { name = (string)t.GetCachedPropertyValue(AutomationElement.NameProperty); } catch (Exception) { continue; }
          if (!StripCount(name).StartsWith(want, StringComparison.OrdinalIgnoreCase)) continue;
          bool sel = false;
          object pat;
          try {
            if (t.TryGetCurrentPattern(SelectionItemPattern.Pattern, out pat)) sel = ((SelectionItemPattern)pat).Current.IsSelected;
          } catch (Exception) { }
          string addr = null;
          if (wantAddress && sel && edit != null) {
            object vp;
            try {
              if (edit.TryGetCurrentPattern(ValuePattern.Pattern, out vp)) addr = ((ValuePattern)vp).Current.Value;
            } catch (Exception) { }
          }
          if (found > 0) sb.Append(",");
          sb.Append("{\"window\":\"").Append(NotulaMediaReader.Esc(wname));
          sb.Append("\",\"tab\":\"").Append(NotulaMediaReader.Esc(name));
          sb.Append("\",\"sel\":").Append(sel ? "true" : "false");
          sb.Append(",\"addr\":").Append(addr == null ? "null" : "\"" + NotulaMediaReader.Esc(addr) + "\"");
          sb.Append("}");
          found++;
        }
      }
    }
    sb.Append("],\"windows\":").Append(windows.ToString(CultureInfo.InvariantCulture));
    sb.Append(",\"ms\":").Append(sw.ElapsedMilliseconds.ToString(CultureInfo.InvariantCulture)).Append("}");
    return sb.ToString();
  }
}
'@

try {
  $fw = [Runtime.InteropServices.RuntimeEnvironment]::GetRuntimeDirectory()
  $winmd = Join-Path $env:windir 'System32\WinMetadata'
  $gac = Join-Path $env:windir 'Microsoft.NET\assembly\GAC_MSIL'
  $refs = @(
    (Join-Path $winmd 'Windows.Media.winmd'),
    (Join-Path $winmd 'Windows.Foundation.winmd'),
    (Join-Path $fw 'System.Runtime.WindowsRuntime.dll'),
    (Join-Path $fw 'System.Runtime.dll'),
    (Join-Path $fw 'System.Runtime.InteropServices.WindowsRuntime.dll'),
    (Join-Path $fw 'System.Threading.Tasks.dll'),
    (Join-Path $gac 'UIAutomationClient\v4.0_4.0.0.0__31bf3856ad364e35\UIAutomationClient.dll'),
    (Join-Path $gac 'UIAutomationTypes\v4.0_4.0.0.0__31bf3856ad364e35\UIAutomationTypes.dll'),
    (Join-Path $gac 'WindowsBase\v4.0_4.0.0.0__31bf3856ad364e35\WindowsBase.dll')
  )
  foreach ($r in $refs) { if (-not (Test-Path -LiteralPath $r)) { Exit-Unavailable 'missing-references' } }
  # Add-Type would load each reference into this process, and a .winmd can't be loaded that
  # way: compile with CodeDom directly (the same in-box compiler) and load the result in memory.
  $cp = New-Object System.CodeDom.Compiler.CompilerParameters
  $cp.GenerateInMemory = $true
  foreach ($r in ($refs + @('System.dll', 'System.Core.dll'))) { [void]$cp.ReferencedAssemblies.Add($r) }
  $res = (New-Object Microsoft.CSharp.CSharpCodeProvider).CompileAssemblyFromSource($cp, $src)
} catch {
  Exit-Unavailable 'compile-failed'
}
if ($res.Errors.HasErrors) {
  # Counts only: compiler text can quote the source, never a title, but it stays out of the log.
  [Console]::Error.WriteLine('compile errors: ' + @($res.Errors | Where-Object { -not $_.IsWarning }).Count)
  Exit-Unavailable 'compile-failed'
}
$msCompile = [int]$sw.ElapsedMilliseconds

$code = [NotulaMediaReader]::Run($OwnerPid, $Apps, $msCompile, [long]$sw.ElapsedMilliseconds)
exit $code
