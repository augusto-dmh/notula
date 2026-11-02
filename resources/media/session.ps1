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
#       "status","posMs","endMs","rate","updated"[,"web","hwnd"]}]}  updated = epoch ms of the
#       timeline; web = chrome|edge and hwnd = its window handle, for a web-app session only
#     {"ev":"locate","id":n,"matches":[{"window","tab","sel","addr"}],"windows":n,"ms":n}
#     {"ev":"apps","id":n,"shortcuts":[{"name","exe","profile","appId","host","aumid"}],
#       "folders":[{"browser","profile","folder"}],"ms":n}   host = the --app-url host only
#     {"ev":"window-title","id":n,"title":"..."|null}
#     {"ev":"lesson-read","id":n,"nodes":[[depth,"Type","name"],...]|null,"reason":"...","ms":n}
#     {"ev":"seek","id":n,"result":"ok|refused|gone"}
#     {"ev":"unavailable","reason":"..."}                        then exit 3, no restarts
# - Commands on stdin, one per line, tab-separated. None of them clicks, focuses or switches
#   anything:
#     locate <id> <process> <base64 UTF-8 title> <1|0 address>
#   reads the tab strip of that browser's windows (UI Automation, the browser's own toolbar and
#   tab strip only: it never descends into a web page), returns the tabs whose name starts with
#   the title, and the address bar only for a matched tab that is the selected one.
#     apps <id>
#   the browsers' installed web apps: the Chrome and Edge shortcuts with an --app-id in the Start
#   menus and on the Desktops (target file name, the parsed --profile-directory, --app-id and
#   --app-url host, AppUserModel ID; never the arguments themselves), and the folder NAMES under
#   each profile's Web Applications folder. No file inside a profile is opened.
#     window-title <id> <hwnd>
#   the title of a browser window (chrome, msedge, brave processes only), by handle.
#     lesson-read <id> <hwnd> <budget ms>
#   the window read: one cached UI Automation fetch of a browser window's tree, by handle; only
#   the web page's Text, Button, Group and Hyperlink nodes, as depth, type and name, for main to
#   parse (the worker keeps the lesson fields and drops the rest). No pattern is used, nothing is
#   invoked. Over the budget it answers `over-budget`; with UI Automation calls stuck on a hung
#   window it answers `stuck` (the worker then starts a fresh reader).
#     seek <id> <app id> <ms>
#   TryChangePlaybackPositionAsync on that session (a reported app id only; the current session,
#   else the only one playing; `refused` when it can't tell). It never plays.
# - UI Automation never runs on the event loop: each call gets its own thread and a hard timeout,
#   past which it is abandoned (NotulaUia), so a hung window can't hold up the session lines.
# - Only these app ids are reported: the ones in -Apps (the measured browsers), browser web apps
#   (`Chrome._crx_<id>`, `MSEdge._crx__<id>`), and the AppUserModel IDs of the browsers' app
#   shortcuts. An unknown app
#   id rescans the shortcuts at most once a minute; shortcuts already read are cached by path
#   and time. Every other session (a media player) is never read past its app id.
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
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Automation;
using Microsoft.Win32.SafeHandles;
using Windows.Foundation;
using Windows.Media.Control;

public static class NotulaMediaReader {
  const int C_SESSIONS = 1, C_CURRENT = 2, C_MEDIA = 4, C_PLAYBACK = 8, C_TIMELINE = 16, C_WINDOW = 32;

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

  /** A web app's playing window was told apart off the loop: print again with it. */
  public static void WindowPicked() {
    Mark(C_WINDOW);
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
    if (app == null) return false;
    return Apps == null || Apps.Contains(app) || WebOf(app) != null;
  }

  /** chrome or edge for a browser web app's session, else null (a browser itself, a player). */
  static string WebOf(string app) {
    if (app == null || (Apps != null && Apps.Contains(app))) return null;
    if (app.StartsWith("Chrome._crx_", StringComparison.Ordinal)) return "chrome";
    // Measured on Edge 156 shortcuts: either this shape or `<host>-<hash>_<publisher>!App`.
    if (app.StartsWith("MSEdge._crx_", StringComparison.Ordinal)) return "edge";
    return NotulaApps.BrowserOf(app);
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
    if ((c & C_WINDOW) != 0) l.Add("window");
    return l.Count == 0 ? "initial" : string.Join("+", l.ToArray());
  }

  static void EmitSessions(string cause, bool windows) {
    StringBuilder sb = new StringBuilder(512);
    bool first = true;
    IReadOnlyList<GlobalSystemMediaTransportControlsSession> all;
    try { all = Mgr.GetSessions(); } catch (Exception) { all = new List<GlobalSystemMediaTransportControlsSession>(); }
    // Only the current session itself is `cur`, not every session of its app id: main follows the
    // `cur` one, and `seek` moves that same one.
    GlobalSystemMediaTransportControlsSession curSession = Current(all);
    foreach (GlobalSystemMediaTransportControlsSession x in all) {
      try {
        string app = x.SourceAppUserModelId;
        if (!Wanted(app)) continue;
        bool isCur = object.ReferenceEquals(x, curSession);
        GlobalSystemMediaTransportControlsSessionMediaProperties p = Wait(x.TryGetMediaPropertiesAsync());
        GlobalSystemMediaTransportControlsSessionTimelineProperties tl = x.GetTimelineProperties();
        GlobalSystemMediaTransportControlsSessionPlaybackInfo pb = x.GetPlaybackInfo();
        double? rate = pb.PlaybackRate;
        StringBuilder one = new StringBuilder(256);
        one.Append("{\"app\":\"").Append(Esc(app));
        one.Append("\",\"cur\":").Append(isCur ? "true" : "false");
        one.Append(",\"title\":\"").Append(Esc(p.Title));
        one.Append("\",\"artist\":\"").Append(Esc(p.Artist));
        one.Append("\",\"album\":\"").Append(Esc(p.AlbumTitle));
        one.Append("\",\"status\":\"").Append(pb.PlaybackStatus.ToString());
        one.Append("\",\"posMs\":").Append(Num(tl.Position.TotalMilliseconds));
        one.Append(",\"endMs\":").Append(Num(tl.EndTime.TotalMilliseconds));
        one.Append(",\"rate\":").Append(rate.HasValue && !double.IsNaN(rate.Value) && !double.IsInfinity(rate.Value) ? rate.Value.ToString("R", CultureInfo.InvariantCulture) : "null");
        one.Append(",\"updated\":").Append(tl.LastUpdatedTime.ToUnixTimeMilliseconds().ToString(CultureInfo.InvariantCulture));
        string web = WebOf(app);
        if (web != null) {
          long hwnd = NotulaWindows.Of(app, windows);
          one.Append(",\"web\":\"").Append(web).Append("\",\"hwnd\":");
          one.Append(hwnd == 0 ? "null" : "\"" + hwnd.ToString(CultureInfo.InvariantCulture) + "\"");
        }
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

  /** The OS's current session as one of `all` (by identity, else the first of its app id); null when none. */
  static GlobalSystemMediaTransportControlsSession Current(IReadOnlyList<GlobalSystemMediaTransportControlsSession> all) {
    GlobalSystemMediaTransportControlsSession c = null;
    string app = null;
    try {
      c = Mgr.GetCurrentSession();
      if (c != null) app = c.SourceAppUserModelId;
    } catch (Exception) { return null; }
    if (c == null) return null;
    foreach (GlobalSystemMediaTransportControlsSession x in all) if (object.ReferenceEquals(x, c)) return x;
    foreach (GlobalSystemMediaTransportControlsSession x in all) {
      try { if (x.SourceAppUserModelId == app) return x; } catch (Exception) { }
    }
    return null;
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

  static string Id(int id) {
    return id.ToString(CultureInfo.InvariantCulture);
  }

  static void HandleCommand(string line) {
    string[] f = line.Split('\t');
    if (f.Length < 2) return;
    int id;
    if (!int.TryParse(f[1], NumberStyles.Integer, CultureInfo.InvariantCulture, out id)) return;
    long hwnd;
    switch (f[0]) {
      case "locate":
        if (f.Length >= 5) Locate(id, f);
        return;
      case "apps":
        try { Line(NotulaApps.Inventory(id)); }
        catch (Exception) { Line("{\"ev\":\"apps\",\"id\":" + Id(id) + ",\"shortcuts\":[],\"folders\":[],\"ms\":0,\"error\":true}"); }
        return;
      case "window-title":
        if (f.Length < 3 || !long.TryParse(f[2], NumberStyles.None, CultureInfo.InvariantCulture, out hwnd)) return;
        string title = null;
        try { title = NotulaWindows.Title(hwnd); } catch (Exception) { }
        Line("{\"ev\":\"window-title\",\"id\":" + Id(id) + ",\"title\":" + (title == null ? "null" : "\"" + Esc(title) + "\"") + "}");
        return;
      case "lesson-read":
        int budget;
        if (f.Length < 4 || !long.TryParse(f[2], NumberStyles.None, CultureInfo.InvariantCulture, out hwnd)) return;
        if (!int.TryParse(f[3], NumberStyles.None, CultureInfo.InvariantCulture, out budget)) return;
        NotulaWindows.LessonRead(id, hwnd, Math.Max(100, Math.Min(budget, 3000)));
        return;
      case "seek":
        long ms;
        if (f.Length < 4 || !long.TryParse(f[3], NumberStyles.None, CultureInfo.InvariantCulture, out ms)) return;
        string result;
        // A timeout or an error says nothing about the session: `gone` is only for one that ended.
        try { result = Seek(f[2], ms); } catch (Exception) { result = "refused"; }
        Line("{\"ev\":\"seek\",\"id\":" + Id(id) + ",\"result\":\"" + result + "\"}");
        return;
    }
  }

  // Moves the position only: a paused player stays paused.
  static string Seek(string app, long ms) {
    if (!Wanted(app)) return "gone";
    // Past 100 days is no lesson position (and would overflow the 100 ns units).
    if (ms > 8640000000L) return "refused";
    IReadOnlyList<GlobalSystemMediaTransportControlsSession> all = Mgr.GetSessions();
    List<GlobalSystemMediaTransportControlsSession> same = new List<GlobalSystemMediaTransportControlsSession>();
    foreach (GlobalSystemMediaTransportControlsSession x in all) {
      string a;
      try { a = x.SourceAppUserModelId; } catch (Exception) { continue; }
      if (a == app) same.Add(x);
    }
    if (same.Count == 0) return "gone";
    // The session main follows: the current one, else the only one of the app id, else the only
    // one playing. Two that can't be told apart are never guessed at.
    GlobalSystemMediaTransportControlsSession pick = null;
    GlobalSystemMediaTransportControlsSession cur = Current(all);
    if (cur != null && same.Contains(cur)) pick = cur;
    else if (same.Count == 1) pick = same[0];
    else {
      foreach (GlobalSystemMediaTransportControlsSession x in same) {
        bool playing;
        try { playing = x.GetPlaybackInfo().PlaybackStatus == GlobalSystemMediaTransportControlsSessionPlaybackStatus.Playing; } catch (Exception) { continue; }
        if (!playing) continue;
        if (pick != null) return "refused";
        pick = x;
      }
      if (pick == null) return "refused";
    }
    GlobalSystemMediaTransportControlsSessionPlaybackInfo pb = pick.GetPlaybackInfo();
    if (pb.PlaybackStatus == GlobalSystemMediaTransportControlsSessionPlaybackStatus.Closed) return "gone";
    if (!pb.Controls.IsPlaybackPositionEnabled) return "refused";
    // The position is in 100 ns units.
    return Wait(pick.TryChangePlaybackPositionAsync(ms * 10000L)) ? "ok" : "refused";
  }

  static void Locate(int id, string[] f) {
    string process = f[2];
    if (process != "msedge" && process != "chrome" && process != "brave") return;
    string title;
    try { title = Encoding.UTF8.GetString(Convert.FromBase64String(f[3])); } catch (Exception) { return; }
    bool address = f[4] == "1";
    string fail = "{\"ev\":\"locate\",\"id\":" + Id(id) + ",\"matches\":[],\"windows\":0,\"ms\":0,\"error\":true}";
    // Main waits 4 s for the answer.
    string refused = NotulaUia.Run(() => NotulaTabs.Locate(id, process, title, address), 3500, (result, err) => Line(result ?? fail));
    if (refused != null) Line(fail);
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
    EmitSessions("initial", true);

    WaitHandle[] handles = new WaitHandle[] { Quit, owner, Changed, CmdReady };
    Stopwatch clock = Stopwatch.StartNew();
    long lastEmit = -1000;
    while (true) {
      // An unknown app id that came too soon after the last shortcut scan is looked at again
      // once the minute is over.
      long due = NotulaApps.RescanDueIn();
      int i = WaitHandle.WaitAny(handles, due < 0 ? Timeout.Infinite : (int)Math.Min(due, int.MaxValue));
      if (i == WaitHandle.WaitTimeout) {
        NotulaApps.ClearDue();
        Mark(C_SESSIONS);
        continue;
      }
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
        // A web app's window is looked for again on a new session or new media only; play, pause,
        // timeline and a window told apart keep the one found before.
        EmitSessions(CauseName(c), (c & (C_SESSIONS | C_CURRENT | C_MEDIA)) != 0);
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

// The shell's link and property interfaces, declared up to the methods used.
[ComImport, Guid("000214F9-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IShellLinkW {
  void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder file, int cch, IntPtr findData, uint flags);
  void GetIDList(out IntPtr pidl);
  void SetIDList(IntPtr pidl);
  void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder name, int cch);
  void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string name);
  void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder dir, int cch);
  void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string dir);
  void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder args, int cch);
}

[StructLayout(LayoutKind.Sequential, Pack = 4)]
struct PROPERTYKEY {
  public Guid fmtid;
  public uint pid;
}

[StructLayout(LayoutKind.Sequential)]
struct PROPVARIANT {
  public ushort vt;
  public ushort r1, r2, r3;
  public IntPtr p;
  public IntPtr p2;
}

[ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IPropertyStore {
  [PreserveSig] int GetCount(out uint count);
  [PreserveSig] int GetAt(uint index, out PROPERTYKEY key);
  [PreserveSig] int GetValue(ref PROPERTYKEY key, out PROPVARIANT value);
}

// The browsers' installed web apps: their shortcuts (Start menus, Desktops) and the folder names
// under each profile's Web Applications folder. Only a browser's own shortcuts are read past
// their target; nothing inside a profile is opened.
public static class NotulaApps {
  sealed class Lnk {
    public DateTime At;
    public string Exe;
    public string Args;
    public string Aumid;
  }

  const long RescanMs = 60000;
  const int MaxFiles = 3000, MaxDepth = 3, MaxFolders = 500;
  static readonly Dictionary<string, Lnk> Read = new Dictionary<string, Lnk>(StringComparer.OrdinalIgnoreCase);
  static readonly Dictionary<string, int> Checked = new Dictionary<string, int>(StringComparer.Ordinal);
  static readonly Stopwatch Clock = Stopwatch.StartNew();
  static Dictionary<string, string> Known = new Dictionary<string, string>(StringComparer.Ordinal);
  // Bumped only when the set of app ids changes, so a player's id is looked up once per change.
  static int Gen;
  static long LastScan = -1, DueAt = -1;

  [DllImport("ole32.dll")] static extern int PropVariantClear(ref PROPVARIANT v);

  /** chrome or edge when the id is an app shortcut's AppUserModel ID, else null. */
  public static string BrowserOf(string app) {
    string b;
    if (Known.TryGetValue(app, out b)) return b;
    int g;
    if (Checked.TryGetValue(app, out g) && g == Gen) return null;
    long now = Clock.ElapsedMilliseconds;
    if (LastScan >= 0 && now - LastScan < RescanMs) {
      if (DueAt < 0) DueAt = LastScan + RescanMs;
      return null;
    }
    try {
      Scan(null, null);
    } catch (Exception) {
      // Not looked at: the id is asked again once the minute is over.
      LastScan = now;
      if (DueAt < 0) DueAt = LastScan + RescanMs;
      return null;
    }
    if (Checked.Count > 256) Checked.Clear();
    Checked[app] = Gen;
    return Known.TryGetValue(app, out b) ? b : null;
  }

  public static long RescanDueIn() {
    return DueAt < 0 ? -1 : Math.Max(0, DueAt - Clock.ElapsedMilliseconds);
  }

  public static void ClearDue() {
    DueAt = -1;
  }

  public static string Inventory(int id) {
    Stopwatch sw = Stopwatch.StartNew();
    List<string[]> shortcuts = new List<string[]>();
    List<string[]> folders = new List<string[]>();
    Scan(shortcuts, folders);
    StringBuilder sb = new StringBuilder(1024);
    sb.Append("{\"ev\":\"apps\",\"id\":").Append(id.ToString(CultureInfo.InvariantCulture)).Append(",\"shortcuts\":[");
    for (int i = 0; i < shortcuts.Count; i++) {
      string[] s = shortcuts[i];
      if (i > 0) sb.Append(",");
      // The parsed fields only: the arguments (full launch URLs) stay here.
      sb.Append("{\"name\":").Append(JStr(s[0]));
      sb.Append(",\"exe\":").Append(JStr(s[1]));
      sb.Append(",\"profile\":").Append(JStr(Arg(s[2], "profile-directory")));
      sb.Append(",\"appId\":").Append(JStr(Arg(s[2], "app-id")));
      sb.Append(",\"host\":").Append(JStr(HostOf(Arg(s[2], "app-url"))));
      sb.Append(",\"aumid\":").Append(JStr(s[3])).Append("}");
    }
    sb.Append("],\"folders\":[");
    for (int i = 0; i < folders.Count; i++) {
      string[] f = folders[i];
      if (i > 0) sb.Append(",");
      sb.Append("{\"browser\":\"").Append(f[0]);
      sb.Append("\",\"profile\":\"").Append(NotulaMediaReader.Esc(f[1]));
      sb.Append("\",\"folder\":\"").Append(NotulaMediaReader.Esc(f[2])).Append("\"}");
    }
    sb.Append("],\"ms\":").Append(sw.ElapsedMilliseconds.ToString(CultureInfo.InvariantCulture)).Append("}");
    return sb.ToString();
  }

  static string JStr(string s) {
    return s == null ? "null" : "\"" + NotulaMediaReader.Esc(s) + "\"";
  }

  /** `--name=value` or `--name="value with spaces"`; null when absent or empty. */
  static string Arg(string args, string name) {
    if (args == null) return null;
    Match m = Regex.Match(args, "(?:^|\\s)--" + Regex.Escape(name) + "=(?:\"([^\"]*)\"|(\\S+))");
    if (!m.Success) return null;
    string v = (m.Groups[1].Success ? m.Groups[1].Value : m.Groups[2].Value).Trim();
    return v.Length == 0 ? null : v;
  }

  /** An http(s) URL's host, lowercased; null for anything else. */
  static string HostOf(string url) {
    Uri u;
    if (url == null || !Uri.TryCreate(url, UriKind.Absolute, out u)) return null;
    if (u.Scheme != Uri.UriSchemeHttps && u.Scheme != Uri.UriSchemeHttp) return null;
    string h = u.Host.ToLowerInvariant();
    return h.Length == 0 ? null : h;
  }

  static string BrowserOfExe(string exe) {
    string e = exe == null ? "" : exe.ToLowerInvariant();
    if (e == "chrome_proxy.exe" || e == "chrome.exe") return "chrome";
    if (e == "msedge_proxy.exe" || e == "msedge.exe") return "edge";
    return null;
  }

  static List<string[]> Roots() {
    List<string[]> r = new List<string[]>();
    HashSet<string> seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    Action<string, bool> add = (p, deep) => {
      if (string.IsNullOrEmpty(p) || !seen.Add(p.TrimEnd('\\'))) return;
      r.Add(new string[] { p, deep ? "1" : "0" });
    };
    add(Environment.GetFolderPath(Environment.SpecialFolder.Programs), true);
    add(Environment.GetFolderPath(Environment.SpecialFolder.CommonPrograms), true);
    add(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), false);
    add(Environment.GetFolderPath(Environment.SpecialFolder.CommonDesktopDirectory), false);
    string home = Environment.GetEnvironmentVariable("USERPROFILE");
    if (!string.IsNullOrEmpty(home)) add(Path.Combine(home, "Desktop"), false);
    foreach (string v in new string[] { "OneDrive", "OneDriveConsumer", "OneDriveCommercial" }) {
      string od = Environment.GetEnvironmentVariable(v);
      if (!string.IsNullOrEmpty(od)) add(Path.Combine(od, "Desktop"), false);
    }
    return r;
  }

  static void Scan(List<string[]> shortcuts, List<string[]> folders) {
    Dictionary<string, string> known = new Dictionary<string, string>(StringComparer.Ordinal);
    HashSet<string> live = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    int files = 0;
    foreach (string[] root in Roots()) Walk(root[0], root[1] == "1" ? MaxDepth : 0, ref files, live, known, shortcuts);
    List<string> gone = new List<string>();
    foreach (string k in Read.Keys) if (!live.Contains(k)) gone.Add(k);
    foreach (string k in gone) Read.Remove(k);
    bool same = known.Count == Known.Count;
    if (same) foreach (string k in known.Keys) if (!Known.ContainsKey(k)) { same = false; break; }
    if (!same) Gen++;
    Known = known;
    LastScan = Clock.ElapsedMilliseconds;
    if (folders != null) Folders(folders);
  }

  static void Walk(string dir, int depth, ref int files, HashSet<string> live, Dictionary<string, string> known, List<string[]> shortcuts) {
    if (files >= MaxFiles || !Directory.Exists(dir)) return;
    string[] lnks;
    try { lnks = Directory.GetFiles(dir, "*.lnk"); } catch (Exception) { return; }
    foreach (string path in lnks) {
      if (++files > MaxFiles) return;
      live.Add(path);
      DateTime at;
      try { at = File.GetLastWriteTimeUtc(path); } catch (Exception) { continue; }
      Lnk l;
      if (!Read.TryGetValue(path, out l) || l.At != at) {
        l = Parse(path, at);
        Read[path] = l;
      }
      string browser = BrowserOfExe(l.Exe);
      if (browser == null || l.Args == null || l.Args.IndexOf("--app-id=", StringComparison.Ordinal) < 0) continue;
      if (!string.IsNullOrEmpty(l.Aumid)) known[l.Aumid] = browser;
      if (shortcuts != null) shortcuts.Add(new string[] { Path.GetFileNameWithoutExtension(path), l.Exe, l.Args, l.Aumid });
    }
    if (depth <= 0) return;
    string[] subs;
    try { subs = Directory.GetDirectories(dir); } catch (Exception) { return; }
    foreach (string sub in subs) Walk(sub, depth - 1, ref files, live, known, shortcuts);
  }

  static Lnk Parse(string path, DateTime at) {
    Lnk l = new Lnk();
    l.At = at;
    object o = null;
    try {
      o = Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("00021401-0000-0000-C000-000000000046")));
      ((IPersistFile)o).Load(path, 0);
      IShellLinkW link = (IShellLinkW)o;
      StringBuilder target = new StringBuilder(1024);
      link.GetPath(target, target.Capacity, IntPtr.Zero, 0);
      l.Exe = Path.GetFileName(target.ToString());
      // Arguments and the app id of a browser's own shortcuts only.
      if (BrowserOfExe(l.Exe) == null) return l;
      StringBuilder args = new StringBuilder(4096);
      link.GetArguments(args, args.Capacity);
      l.Args = args.ToString();
      if (l.Args.IndexOf("--app-id=", StringComparison.Ordinal) >= 0) l.Aumid = Aumid((IPropertyStore)o);
    } catch (Exception) {
      // Unreadable or not a file link.
    } finally {
      if (o != null) Marshal.ReleaseComObject(o);
    }
    return l;
  }

  /** System.AppUserModel.ID, or null. */
  internal static string Aumid(IPropertyStore ps) {
    PROPERTYKEY key = new PROPERTYKEY();
    key.fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3");
    key.pid = 5;
    PROPVARIANT v;
    if (ps.GetValue(ref key, out v) != 0) return null;
    try {
      // VT_LPWSTR
      return v.vt == 31 && v.p != IntPtr.Zero ? Marshal.PtrToStringUni(v.p) : null;
    } finally {
      PropVariantClear(ref v);
    }
  }

  static void Folders(List<string[]> folders) {
    string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
    string[][] bases = new string[][] {
      new string[] { "chrome", Path.Combine(local, "Google\\Chrome\\User Data") },
      new string[] { "edge", Path.Combine(local, "Microsoft\\Edge\\User Data") }
    };
    foreach (string[] b in bases) {
      if (!Directory.Exists(b[1])) continue;
      string[] profiles;
      try { profiles = Directory.GetDirectories(b[1]); } catch (Exception) { continue; }
      foreach (string p in profiles) {
        string apps = Path.Combine(p, "Web Applications");
        if (!Directory.Exists(apps)) continue;
        string[] dirs;
        try { dirs = Directory.GetDirectories(apps, "_crx_*"); } catch (Exception) { continue; }
        foreach (string d in dirs) {
          if (folders.Count >= MaxFolders) return;
          folders.Add(new string[] { b[0], Path.GetFileName(p), Path.GetFileName(d) });
        }
      }
    }
  }
}

// Browser windows by handle: the window of a web-app session (by the window's AppUserModel ID),
// its title, and the window read. UI Automation loads only when a method that needs it runs.
public static class NotulaWindows {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder sb, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder sb, int n);
  [DllImport("shell32.dll")] static extern int SHGetPropertyStoreForWindow(IntPtr h, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out IPropertyStore ps);

  const int MaxNodes = 4000, MaxChars = 400000, MaxName = 200, MaxTreeDepth = 120;
  static readonly Dictionary<string, long> Found = new Dictionary<string, long>(StringComparer.Ordinal);
  // Edge names a playing app window `<page title> - Audio playing` (localized).
  static readonly Regex AudioMarker = new Regex(" - (audio playing|playing audio|reproduzindo \u00e1udio|\u00e1udio em reprodu\u00e7\u00e3o|reproduciendo audio)$", RegexOptions.IgnoreCase);
  // Guards Found and Probing: picks also arrive from UI Automation threads.
  static readonly object Gate = new object();
  static readonly HashSet<string> Probing = new HashSet<string>(StringComparer.Ordinal);
  const int ProbeMs = 1500;

  static string ClassOf(IntPtr h) {
    StringBuilder sb = new StringBuilder(64);
    GetClassName(h, sb, sb.Capacity);
    return sb.ToString();
  }

  static string TextOf(IntPtr h) {
    StringBuilder sb = new StringBuilder(1024);
    return GetWindowText(h, sb, sb.Capacity) > 0 ? sb.ToString() : "";
  }

  static string AumidOf(IntPtr h) {
    IPropertyStore ps = null;
    Guid iid = typeof(IPropertyStore).GUID;
    try {
      if (SHGetPropertyStoreForWindow(h, ref iid, out ps) != 0 || ps == null) return null;
      return NotulaApps.Aumid(ps);
    } catch (Exception) {
      return null;
    } finally {
      if (ps != null) Marshal.ReleaseComObject(ps);
    }
  }

  /** A top-level window of a chrome, msedge or brave process. */
  static bool IsBrowserWindow(IntPtr h) {
    if (!IsWindow(h)) return false;
    uint pid;
    GetWindowThreadProcessId(h, out pid);
    try {
      using (Process p = Process.GetProcessById((int)pid)) {
        string n = p.ProcessName;
        return n == "chrome" || n == "msedge" || n == "brave";
      }
    } catch (Exception) {
      return false;
    }
  }

  static HashSet<uint> BrowserPids() {
    HashSet<uint> pids = new HashSet<uint>();
    foreach (string n in new string[] { "chrome", "msedge" }) {
      Process[] ps;
      try { ps = Process.GetProcessesByName(n); } catch (Exception) { continue; }
      foreach (Process p in ps) { pids.Add((uint)p.Id); p.Dispose(); }
    }
    return pids;
  }

  /**
   * The window of a web-app session; with several, the one carrying the audio marker. 0 when none.
   * Only window text is read here (on the event loop); the accessible names, a cross-process UI
   * Automation call, are read off the loop and the pick arrives later (`WindowPicked`).
   */
  public static long Of(string app, bool look) {
    long h;
    lock (Gate) {
      if (!look && Found.TryGetValue(app, out h) && (h == 0 || IsWindow(new IntPtr(h)))) return h;
    }
    HashSet<uint> pids = BrowserPids();
    List<IntPtr> wins = new List<IntPtr>();
    if (pids.Count > 0) {
      EnumWindows((w, l) => {
        uint pid;
        // The browsers' own windows only, before the property store is read: every Electron app's
        // windows share the class.
        if (!IsWindowVisible(w) || ClassOf(w) != "Chrome_WidgetWin_1") return true;
        GetWindowThreadProcessId(w, out pid);
        if (pids.Contains(pid) && SameApp(AumidOf(w), app)) wins.Add(w);
        return true;
      }, IntPtr.Zero);
    }
    IntPtr pick = IntPtr.Zero;
    if (wins.Count == 1) pick = wins[0];
    else if (wins.Count > 1) {
      foreach (IntPtr w in wins) if (AudioMarker.IsMatch(TextOf(w))) { pick = w; break; }
      if (pick == IntPtr.Zero) {
        // Keep the last pick while it is still one of them; the accessible names decide later.
        long before;
        lock (Gate) { if (!Found.TryGetValue(app, out before)) before = 0; }
        foreach (IntPtr w in wins) if (w.ToInt64() == before) pick = w;
        if (pick == IntPtr.Zero) pick = wins[0];
        Probe(app, wins);
      }
    }
    h = pick.ToInt64();
    lock (Gate) {
      if (Found.Count > 64) Found.Clear();
      Found[app] = h;
    }
    return h;
  }

  /** The audio marker in the windows' accessible names, read off the loop; one probe per app at a time. */
  static void Probe(string app, List<IntPtr> wins) {
    lock (Gate) { if (!Probing.Add(app)) return; }
    string refused = NotulaUia.Run(() => {
      foreach (IntPtr w in wins) if (AudioMarker.IsMatch(AccessibleName(w))) return w.ToInt64().ToString(CultureInfo.InvariantCulture);
      return null;
    }, ProbeMs, (result, err) => {
      long pick, cur;
      lock (Gate) {
        Probing.Remove(app);
        if (result == null || !long.TryParse(result, NumberStyles.None, CultureInfo.InvariantCulture, out pick)) return;
        if (Found.TryGetValue(app, out cur) && cur == pick) return;
        Found[app] = pick;
      }
      NotulaMediaReader.WindowPicked();
    });
    if (refused != null) lock (Gate) { Probing.Remove(app); }
  }

  // Measured on --app windows (Chrome and Edge 156): a window's id can add `.<profile>` parts.
  static bool SameApp(string window, string app) {
    if (window == null) return false;
    return window == app || (window.Length > app.Length && window.StartsWith(app, StringComparison.Ordinal) && window[app.Length] == '.');
  }

  static string AccessibleName(IntPtr h) {
    try { return AutomationElement.FromHandle(h).Current.Name ?? ""; } catch (Exception) { return ""; }
  }

  public static string Title(long hwnd) {
    IntPtr h = new IntPtr(hwnd);
    return IsBrowserWindow(h) ? TextOf(h) : null;
  }

  // ---------- the window read ----------

  public static void LessonRead(int id, long hwnd, int budget) {
    IntPtr h = new IntPtr(hwnd);
    if (!IsBrowserWindow(h)) {
      Reply(id, null, "not-browser", 0);
      return;
    }
    Stopwatch sw = Stopwatch.StartNew();
    // Past the budget the walk is abandoned, so a hung window never blocks the next read.
    string refused = NotulaUia.Run(() => Tree(h), budget, (nodes, err) => {
      string reason = err == "timeout" ? "over-budget" : (nodes != null ? null : (err != null ? "error" : "no-page"));
      Reply(id, err == null ? nodes : null, reason, sw.ElapsedMilliseconds);
    });
    if (refused != null) Reply(id, null, refused, 0);
  }

  static void Reply(int id, string nodes, string reason, long ms) {
    NotulaMediaReader.Line("{\"ev\":\"lesson-read\",\"id\":" + id.ToString(CultureInfo.InvariantCulture) +
      ",\"nodes\":" + (nodes ?? "null") + ",\"reason\":" + (reason == null ? "null" : "\"" + reason + "\"") +
      ",\"ms\":" + ms.ToString(CultureInfo.InvariantCulture) + "}");
  }

  /** One cached fetch of the window's tree; the page's nodes only, as [depth,"Type","name"]. */
  static string Tree(IntPtr h) {
    CacheRequest cr = new CacheRequest();
    cr.Add(AutomationElement.ControlTypeProperty);
    cr.Add(AutomationElement.NameProperty);
    cr.TreeScope = TreeScope.Element | TreeScope.Descendants;
    cr.TreeFilter = Automation.RawViewCondition;
    cr.AutomationElementMode = AutomationElementMode.None;
    AutomationElement root;
    using (cr.Activate()) { root = AutomationElement.FromHandle(h); }
    StringBuilder sb = new StringBuilder(4096);
    sb.Append("[");
    int count = 0;
    bool page = false;
    Emit(root, 0, false, sb, ref count, ref page);
    sb.Append("]");
    return page ? sb.ToString() : null;
  }

  static string Kind(ControlType ct) {
    if (ct == ControlType.Text) return "Text";
    if (ct == ControlType.Button) return "Button";
    if (ct == ControlType.Group) return "Group";
    if (ct == ControlType.Hyperlink) return "Hyperlink";
    return null;
  }

  static void Emit(AutomationElement e, int depth, bool inDoc, StringBuilder sb, ref int count, ref bool page) {
    if (count >= MaxNodes || sb.Length >= MaxChars || depth > MaxTreeDepth) return;
    ControlType ct;
    try { ct = (ControlType)e.GetCachedPropertyValue(AutomationElement.ControlTypeProperty); } catch (Exception) { return; }
    if (ct == ControlType.Document) {
      inDoc = true;
      page = true;
    } else if (inDoc) {
      string kind = Kind(ct);
      if (kind != null) {
        string name = null;
        try { name = e.GetCachedPropertyValue(AutomationElement.NameProperty) as string; } catch (Exception) { }
        name = name == null ? "" : name.Trim();
        if (name.Length > MaxName) name = name.Substring(0, MaxName);
        if (name.Length > 0 || kind != "Text") {
          if (count > 0) sb.Append(",");
          sb.Append("[").Append(depth.ToString(CultureInfo.InvariantCulture)).Append(",\"").Append(kind).Append("\",\"");
          sb.Append(NotulaMediaReader.Esc(name)).Append("\"]");
          count++;
        }
      }
    }
    AutomationElementCollection kids;
    try { kids = e.CachedChildren; } catch (Exception) { return; }
    foreach (AutomationElement k in kids) Emit(k, depth + 1, inDoc, sb, ref count, ref page);
  }
}

// UI Automation, off the event loop. A call into a hung browser window can wait as long as UI
// Automation's own timeouts, and the loop must keep printing sessions and answering seeks. Each
// job runs on its own thread with a hard timeout; past it the job is abandoned and its result
// dropped. Abandoned jobs still alive can't be stopped from here: with too many of them a new job
// answers `stuck`, and the worker starts a fresh reader.
public static class NotulaUia {
  sealed class Job {
    public Thread Thread;
    public bool Abandoned;
  }

  const int MaxStuck = 2, MaxLive = 6;
  static readonly object Gate = new object();
  static readonly List<Job> Jobs = new List<Job>();

  /**
   * Runs `work` on its own thread. `done` gets its result and null, or null and `error` or
   * `timeout`, on another thread. Returns null when started, else `stuck` or `busy` (nothing runs).
   */
  public static string Run(Func<string> work, int timeoutMs, Action<string, string> done) {
    string result = null, error = null;
    Job job = new Job();
    job.Thread = new Thread(() => {
      try { result = work(); } catch (Exception) { error = "error"; }
    }, 8 * 1024 * 1024);
    job.Thread.IsBackground = true;
    lock (Gate) {
      Jobs.RemoveAll(j => !j.Thread.IsAlive);
      int stuck = 0;
      foreach (Job x in Jobs) if (x.Abandoned) stuck++;
      if (stuck >= MaxStuck) return "stuck";
      if (Jobs.Count >= MaxLive) return "busy";
      Jobs.Add(job);
      job.Thread.Start();
    }
    Thread watch = new Thread(() => {
      if (job.Thread.Join(timeoutMs)) {
        done(result, error);
        return;
      }
      lock (Gate) { job.Abandoned = true; }
      done(null, "timeout");
    });
    watch.IsBackground = true;
    watch.Start();
    return null;
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
