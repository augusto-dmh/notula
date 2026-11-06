// SPDX-License-Identifier: Apache-2.0
// notula-desk (Windows): the dictation bar's full-screen watcher, shared by desk.ps1 and
// keyhook.ps1. Each script appends this file to its own C# source and compiles both in one
// Add-Type, so the watcher adds no compile of its own; that is why the usings sit inside the
// namespace.
//
// The watcher runs on its own thread with its own message loop, never on a low-level hook's
// thread: Windows removes a low-level hook whose callback overruns its timeout. It listens with
// out-of-context WinEvent hooks to foreground changes, minimize start and end, and location
// changes of the foreground window itself (that hook is scoped to the foreground process and
// follows it). After an event it re-evaluates at most every 250 ms, and prints
//   {"event":"fullscreen","full":bool,"x":int,"y":int}
// once at start and then only on change. x, y: the covered monitor's top-left in physical pixels
// (0 when not full screen).

namespace Notula.Desk {
  using System;
  using System.Runtime.InteropServices;
  using System.Text;
  using System.Threading;

  public static class ForegroundWatch {
    const uint EVENT_SYSTEM_FOREGROUND = 0x0003, EVENT_SYSTEM_MINIMIZESTART = 0x0016, EVENT_SYSTEM_MINIMIZEEND = 0x0017;
    const uint EVENT_OBJECT_LOCATIONCHANGE = 0x800B;
    const uint WINEVENT_OUTOFCONTEXT = 0x0000;
    const int OBJID_WINDOW = 0, CHILDID_SELF = 0;
    const uint WM_QUIT = 0x0012, WM_TIMER = 0x0113, PM_NOREMOVE = 0x0000;
    const int SETTLE_MS = 250;

    [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }
    [StructLayout(LayoutKind.Sequential)] struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public int x; public int y; }

    delegate void WinEventProc(IntPtr hook, uint ev, IntPtr hwnd, int idObject, int idChild, uint thread, uint time);

    [DllImport("user32.dll")] static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr mod, WinEventProc fn, uint pid, uint thread, uint flags);
    [DllImport("user32.dll")] static extern bool UnhookWinEvent(IntPtr h);
    [DllImport("user32.dll")] static extern int GetMessage(out MSG m, IntPtr hwnd, uint min, uint max);
    [DllImport("user32.dll")] static extern bool PeekMessage(out MSG m, IntPtr hwnd, uint min, uint max, uint remove);
    [DllImport("user32.dll")] static extern IntPtr DispatchMessage(ref MSG m);
    [DllImport("user32.dll")] static extern bool PostThreadMessage(uint thread, uint msg, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] static extern UIntPtr SetTimer(IntPtr hwnd, UIntPtr id, uint ms, IntPtr fn);
    [DllImport("user32.dll")] static extern bool KillTimer(IntPtr hwnd, UIntPtr id);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] static extern IntPtr GetShellWindow();
    [DllImport("user32.dll")] static extern IntPtr GetDesktopWindow();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
    [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr m, ref MONITORINFO mi);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();

    // Kept in a field for the hooks' lifetime: the OS calls it.
    static readonly WinEventProc proc = OnEvent;
    static readonly object gate = new object();
    static Thread thread;
    static uint threadId;

    // Watcher-thread state.
    static IntPtr locHook = IntPtr.Zero;
    static uint locPid;
    static IntPtr foreground = IntPtr.Zero;
    static UIntPtr timer = UIntPtr.Zero;
    static int lastEval;
    static string last;

    /** The monitor's top-left when the foreground window covers it entirely (not the desktop or the shell). */
    public static int[] FullscreenMonitor() { return FullscreenMonitor(GetForegroundWindow()); }

    static int[] FullscreenMonitor(IntPtr h) {
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

    /** Starts the watcher thread (once); it prints the current state as soon as it runs. */
    public static void Start() {
      lock (gate) {
        if (thread != null) return;
        var ready = new ManualResetEvent(false);
        var t = new Thread(() => Run(ready));
        t.IsBackground = true;
        thread = t;
        t.Start();
        ready.WaitOne(2000);
      }
    }

    /** Ends the watcher thread and its hooks; a later Start prints the state again. */
    public static void Stop() {
      lock (gate) {
        var t = thread;
        if (t == null) return;
        thread = null;
        if (threadId != 0) PostThreadMessage(threadId, WM_QUIT, IntPtr.Zero, IntPtr.Zero);
        t.Join(1000);
      }
    }

    static void Run(ManualResetEvent ready) {
      MSG m;
      threadId = GetCurrentThreadId();
      // The first user32 call creates the thread's queue, so Stop can post to it from now on.
      PeekMessage(out m, IntPtr.Zero, 0, 0, PM_NOREMOVE);
      last = null;
      foreground = IntPtr.Zero;
      IntPtr fgHook = SetWinEventHook(EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND, IntPtr.Zero, proc, 0, 0, WINEVENT_OUTOFCONTEXT);
      IntPtr minHook = SetWinEventHook(EVENT_SYSTEM_MINIMIZESTART, EVENT_SYSTEM_MINIMIZEEND, IntPtr.Zero, proc, 0, 0, WINEVENT_OUTOFCONTEXT);
      ready.Set();
      Evaluate();
      while (GetMessage(out m, IntPtr.Zero, 0, 0) > 0) {
        if (m.message == WM_TIMER && m.hwnd == IntPtr.Zero && timer != UIntPtr.Zero && m.wParam == (IntPtr)(long)timer.ToUInt64()) {
          KillTimer(IntPtr.Zero, timer);
          timer = UIntPtr.Zero;
          Evaluate();
          continue;
        }
        DispatchMessage(ref m);
      }
      if (timer != UIntPtr.Zero) KillTimer(IntPtr.Zero, timer);
      timer = UIntPtr.Zero;
      if (locHook != IntPtr.Zero) UnhookWinEvent(locHook);
      locHook = IntPtr.Zero;
      locPid = 0;
      if (minHook != IntPtr.Zero) UnhookWinEvent(minHook);
      if (fgHook != IntPtr.Zero) UnhookWinEvent(fgHook);
      threadId = 0;
    }

    // Watcher thread (out-of-context events arrive through its message loop).
    static void OnEvent(IntPtr hook, uint ev, IntPtr hwnd, int idObject, int idChild, uint thread, uint time) {
      if (ev == EVENT_OBJECT_LOCATIONCHANGE && (hwnd != foreground || idObject != OBJID_WINDOW || idChild != CHILDID_SELF)) return;
      if (timer != UIntPtr.Zero) return;
      int since = unchecked(Environment.TickCount - lastEval);
      if (since >= SETTLE_MS) { Evaluate(); return; }
      timer = SetTimer(IntPtr.Zero, UIntPtr.Zero, (uint)(SETTLE_MS - since), IntPtr.Zero);
      if (timer == UIntPtr.Zero) Evaluate();
    }

    static void Evaluate() {
      lastEval = Environment.TickCount;
      try {
        IntPtr fg = GetForegroundWindow();
        if (fg != foreground) { foreground = fg; Follow(fg); }
        int[] at = FullscreenMonitor(fg);
        string line = at == null
          ? "{\"event\":\"fullscreen\",\"full\":false,\"x\":0,\"y\":0}"
          : "{\"event\":\"fullscreen\",\"full\":true,\"x\":" + at[0] + ",\"y\":" + at[1] + "}";
        if (line == last) return;
        last = line;
        Console.Out.WriteLine(line);
        Console.Out.Flush();
      } catch { }
    }

    /** The location hook follows the foreground window's process. */
    static void Follow(IntPtr fg) {
      uint pid = 0;
      if (fg != IntPtr.Zero) GetWindowThreadProcessId(fg, out pid);
      if (pid == locPid && locHook != IntPtr.Zero) return;
      if (locHook != IntPtr.Zero) UnhookWinEvent(locHook);
      locHook = IntPtr.Zero;
      locPid = pid;
      if (pid != 0) locHook = SetWinEventHook(EVENT_OBJECT_LOCATIONCHANGE, EVENT_OBJECT_LOCATIONCHANGE, IntPtr.Zero, proc, pid, 0, WINEVENT_OUTOFCONTEXT);
    }
  }
}
