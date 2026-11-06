# SPDX-License-Identifier: Apache-2.0
# notula-desk key hook (Windows): the dictation bar's key-state source.
# Started by the notula-desk utility process only while a hook shortcut is set and Voice typing is
# armed; it exits when stdin closes or its owner process is gone. No network, no files.
#
# A C# WH_KEYBOARD_LL hook, compiled at start with Add-Type so there is no native addon to build
# or sign, on its own message-loop thread. It never swallows a key.
# The callback copies the event into a queue and returns; a writer thread prints it.
#
# A WH_MOUSE_LL hook joins it on the same thread only while the config names mouse buttons, and
# is removed as soon as the list empties: with key chords only there is no mouse hook at all.
# Its callback returns at once for anything but a bound button (moves, wheel, the primary
# buttons): no allocation, no queueing. A bound button's press that completes one of its chords
# (the chord's modifiers held, and no other key or button) is swallowed, and so is its release,
# so Back does not also go back; any other press passes untouched. A release is swallowed only
# when its press was, even when the button is unbound in between. Injected input always passes,
# and nothing is swallowed while suspended (a shortcut is being recorded in Settings).
#
# Protocol: JSON lines on stdin
#   {"op":"config","keys":["space"],"chords":[["ctrl","win"],["ctrl","space","win"]],"mouse":[4]}
#   {"op":"active","on":true}          Esc is reported only while a dictation is active
#   {"op":"watch","on":true}           Return and Tab are reported as commits while a paste is watched
#   {"op":"suspend","on":true}         swallow nothing (a shortcut is being recorded)
# JSON lines on stdout
#   {"event":"ready"}                  the hook is installed
#   {"event":"key","k":"ctrl_r","d":1} a transition (d = 1 down, 0 up), never a repeat
#   {"event":"lost"}                   re-installing the hook failed
#   {"event":"commit","k":"enter"}     Return or Tab ("tab") went down while watching
#   {"event":"mouse","on":true}        the mouse hook went on (false: off)
#   {"event":"mouse","on":false,"failed":true}  installing the mouse hook failed
#   {"event":"error","message":"..."}
# What it reports: every modifier (ctrl, alt, shift, win, with _r for the right side); the
# chords' other keys (space, a letter …) only while a modifier or a bound mouse button is down;
# esc only while active; any other key as "other" (no identity) on the same terms; the bound
# mouse buttons (mouse3 middle, mouse4 back, mouse5 forward), every transition, with or without
# a modifier. Nothing else, ever.
#
# Start-menu masking: when every key of a chord containing win is down, the next win key-up is
# preceded by a dummy VK 0xE8 down/up (unassigned), so the shell sees a chord, not a lone Win.
# Windows silently removes a hook whose callback overruns LowLevelHooksTimeout; the hook thread
# re-installs itself every 60 s (new hook first, then the old one removed) and reports "lost"
# only when installing fails. The mouse hook follows the same cycle; failing it removes the old
# one too and reports only the mouse part, and the next cycle tries again.
# Releases can go unseen (a removed hook, the lock screen): when nothing has arrived for 2 s, and
# on each cycle, a key or button still marked down that the OS says is up is reported up.

param([int]$OwnerPid = 0)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding = [System.Text.Encoding]::UTF8

Add-Type -TypeDefinition @'
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;

public static class NotulaKeyHook {
  const int WH_KEYBOARD_LL = 13, WH_MOUSE_LL = 14;
  const int WM_KEYDOWN = 0x100, WM_KEYUP = 0x101, WM_SYSKEYDOWN = 0x104, WM_SYSKEYUP = 0x105;
  const int WM_MBUTTONDOWN = 0x207, WM_MBUTTONUP = 0x208, WM_XBUTTONDOWN = 0x20B, WM_XBUTTONUP = 0x20C;
  const uint WM_QUIT = 0x12, WM_APP_REINSTALL = 0x8001, WM_APP_MOUSE = 0x8002, WM_APP_CHECK = 0x8003;
  const int LLKHF_INJECTED = 0x10;
  const uint LLMHF_INJECTED = 0x1, LLMHF_LOWER_IL_INJECTED = 0x2;
  const byte VK_MASK = 0xE8;
  const uint KEYEVENTF_KEYUP = 0x2;

  [StructLayout(LayoutKind.Sequential)]
  struct KBDLLHOOKSTRUCT { public uint vkCode; public uint scanCode; public uint flags; public uint time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)]
  struct MSLLHOOKSTRUCT { public int x; public int y; public uint mouseData; public uint flags; public uint time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)]
  struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public int x; public int y; }

  delegate IntPtr HookProc(int nCode, IntPtr wParam, IntPtr lParam);

  [DllImport("user32.dll", SetLastError = true)] static extern IntPtr SetWindowsHookEx(int id, HookProc fn, IntPtr mod, uint thread);
  [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr h, int n, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern int GetMessage(out MSG m, IntPtr hwnd, uint min, uint max);
  [DllImport("user32.dll")] static extern bool PostThreadMessage(uint thread, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] static extern short GetAsyncKeyState(int vk);
  [DllImport("kernel32.dll")] static extern IntPtr GetModuleHandle(string name);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();

  static readonly HookProc proc = Callback;
  static readonly HookProc mouseProc = MouseCallback;
  static IntPtr hook = IntPtr.Zero;
  static IntPtr mouseHook = IntPtr.Zero;
  static uint hookThread;
  static readonly BlockingCollection<string> outbox = new BlockingCollection<string>(4096);
  static readonly bool[] down = new bool[256];
  static readonly bool[] reported = new bool[256];

  // Configuration (replaced whole; read by the callback).
  static volatile HashSet<string> chordKeys = new HashSet<string>();
  static volatile List<string[]> winChords = new List<string[]>();
  static volatile bool active;
  static volatile bool watching;
  static volatile bool suspended;
  static bool maskArmed;
  // Indexed by button number (3 middle, 4 back, 5 forward); null = no mouse chord, no mouse hook.
  static volatile bool[] boundMouse = null;
  // Per button: the modifier tokens (sides kept) of each chord it completes.
  static volatile string[][][] mouseChords = new string[33][][];
  // Hook-thread state: buttons down, and presses swallowed (their release is swallowed too).
  static readonly bool[] mouseDown = new bool[33];
  static readonly bool[] mouseSwallowed = new bool[33];
  static bool mouseFailed;
  // The last transition seen, for the check that finds releases that never arrived.
  static int lastEventTick = Environment.TickCount;
  // The OS's key state may leave out a press a hook swallowed; it counts once it has shown one.
  static bool asyncSeesSwallowed;

  /** The writer thread: stdout lines in order, flushed one by one. */
  public static void StartWriter() {
    var w = new Thread(() => {
      foreach (var line in outbox.GetConsumingEnumerable()) {
        Console.Out.WriteLine(line);
        Console.Out.Flush();
      }
    });
    w.IsBackground = true;
    w.Start();
  }

  /** Exits the process when the owner (the notula-desk utility process) is gone. */
  public static void WatchOwner(int pid) {
    if (pid <= 0) return;
    var t = new Thread(() => {
      while (true) {
        try { using (var p = Process.GetProcessById(pid)) { if (p.HasExited) break; } } catch { break; }
        Thread.Sleep(1000);
      }
      Environment.Exit(0);
    });
    t.IsBackground = true;
    t.Start();
  }

  public static void Send(string line) { outbox.TryAdd(line); }

  static string Name(uint vk) {
    switch (vk) {
      case 0xA2: case 0x11: return "ctrl";
      case 0xA3: return "ctrl_r";
      case 0xA4: case 0x12: return "alt";
      case 0xA5: return "alt_r";
      case 0xA0: case 0x10: return "shift";
      case 0xA1: return "shift_r";
      case 0x5B: return "win";
      case 0x5C: return "win_r";
      case 0x20: return "space";
      case 0x1B: return "esc";
    }
    if (vk >= 0x60 && vk <= 0x69) return "num" + (vk - 0x60);
    if (vk >= 0x41 && vk <= 0x5A) return ((char)('a' + (vk - 0x41))).ToString();
    if (vk >= 0x30 && vk <= 0x39) return ((char)('0' + (vk - 0x30))).ToString();
    if (vk >= 0x70 && vk <= 0x87) return "f" + (vk - 0x6F);
    return null;
  }

  static bool IsModifier(string n) { return n != null && (n.StartsWith("ctrl") || n.StartsWith("alt") || n.StartsWith("shift") || n.StartsWith("win")); }
  static string Base(string n) { return n.EndsWith("_r") ? n.Substring(0, n.Length - 2) : n; }

  static bool ModifierDown() {
    return down[0xA2] || down[0xA3] || down[0xA4] || down[0xA5] || down[0xA0] || down[0xA1] || down[0x5B] || down[0x5C] || down[0x11] || down[0x12] || down[0x10];
  }

  static bool BaseDown(string b) {
    switch (b) {
      case "ctrl": return down[0xA2] || down[0xA3] || down[0x11];
      case "alt": return down[0xA4] || down[0xA5] || down[0x12];
      case "shift": return down[0xA0] || down[0xA1] || down[0x10];
      case "win": return down[0x5B] || down[0x5C];
    }
    for (uint vk = 0; vk < 256; vk++) { if (down[vk] && Name(vk) == b) return true; }
    return false;
  }

  static bool KeyDown(string token) {
    switch (token) {
      case "ctrl": return down[0xA2] || down[0xA3] || down[0x11];
      case "ctrl_r": return down[0xA3];
      case "alt": return down[0xA4] || down[0xA5] || down[0x12];
      case "alt_r": return down[0xA5];
      case "shift": return down[0xA0] || down[0xA1] || down[0x10];
      case "shift_r": return down[0xA1];
      case "win": return down[0x5B] || down[0x5C];
      case "win_r": return down[0x5C];
    }
    return false;
  }

  /** A held modifier side is covered by one of the chord's tokens (the side itself, or no side). */
  static bool Covered(string[] mods, string side, string bas) {
    foreach (var t in mods) { if (t == side || t == bas) return true; }
    return false;
  }

  /** Every modifier of the chord is held, and no other modifier is. */
  static bool ModsExactly(string[] mods) {
    foreach (var t in mods) { if (!KeyDown(t)) return false; }
    if ((down[0xA2] || down[0x11]) && !Covered(mods, "ctrl", "ctrl")) return false;
    if (down[0xA3] && !Covered(mods, "ctrl_r", "ctrl")) return false;
    if ((down[0xA4] || down[0x12]) && !Covered(mods, "alt", "alt")) return false;
    if (down[0xA5] && !Covered(mods, "alt_r", "alt")) return false;
    if ((down[0xA0] || down[0x10]) && !Covered(mods, "shift", "shift")) return false;
    if (down[0xA1] && !Covered(mods, "shift_r", "shift")) return false;
    if (down[0x5B] && !Covered(mods, "win", "win")) return false;
    if (down[0x5C] && !Covered(mods, "win_r", "win")) return false;
    return true;
  }

  static bool IsModifierVk(int vk) { return (vk >= 0x10 && vk <= 0x12) || (vk >= 0xA0 && vk <= 0xA5) || vk == 0x5B || vk == 0x5C; }

  /** A bound button is down (keys are then reported as if a modifier were held). */
  static bool BoundMouseDown() {
    var bound = boundMouse;
    if (bound == null) return false;
    for (int b = 3; b <= 5; b++) { if (mouseDown[b] && bound[b]) return true; }
    return false;
  }

  /** Nothing is down but modifiers: no other key, no other button. */
  static bool OnlyModifiers(int button) {
    for (int vk = 0; vk < 256; vk++) { if (down[vk] && !IsModifierVk(vk)) return false; }
    for (int b = 3; b <= 5; b++) { if (b != button && mouseDown[b]) return false; }
    return true;
  }

  /** A swallowed press still waits for its release. */
  static bool MousePending() {
    for (int b = 3; b <= 5; b++) { if (mouseDown[b] && mouseSwallowed[b]) return true; }
    return false;
  }

  /** Hook thread: a button's release won't be seen. Forget it, and report it up while bound. */
  static void ReleaseMouse(int b) {
    if (!mouseDown[b]) return;
    mouseDown[b] = false;
    mouseSwallowed[b] = false;
    var bound = boundMouse;
    if (bound != null && bound[b]) Emit("mouse" + b, false);
  }

  static int MouseVk(int b) { return b == 3 ? 0x04 : b == 4 ? 0x05 : 0x06; }

  /** Hook thread: keys and buttons marked down that the OS says are up were released unseen. */
  static void CheckReleases() {
    for (int vk = 1; vk < 256; vk++) {
      if (!down[vk] || (GetAsyncKeyState(vk) & 0x8000) != 0) continue;
      down[vk] = false;
      if (reported[vk]) Emit(UpName(Name((uint)vk)), false);
      reported[vk] = false;
      if (vk == 0x5B || vk == 0x5C) maskArmed = false;
    }
    for (int b = 3; b <= 5; b++) {
      if (!mouseDown[b]) continue;
      if ((GetAsyncKeyState(MouseVk(b)) & 0x8000) != 0) {
        if (mouseSwallowed[b]) asyncSeesSwallowed = true;
        continue;
      }
      // "Up" may only mean the press was swallowed; until that is ruled out, its next press settles it.
      if (mouseSwallowed[b] && !asyncSeesSwallowed) continue;
      ReleaseMouse(b);
    }
  }

  static IntPtr MouseCallback(int nCode, IntPtr wParam, IntPtr lParam) {
    int msg = wParam.ToInt32();
    // Moves, the wheel and the primary buttons go straight on, with nothing else done.
    if (nCode < 0 || msg < WM_MBUTTONDOWN || msg > WM_XBUTTONUP) return CallNextHookEx(IntPtr.Zero, nCode, wParam, lParam);
    var bound = boundMouse;
    bool swallow = false;
    try {
      int button = 0;
      bool isDown = msg == WM_MBUTTONDOWN || msg == WM_XBUTTONDOWN;
      // MSLLHOOKSTRUCT: mouseData at offset 8, flags at 12 (read in place, no copy).
      uint data = (uint)Marshal.ReadInt32(lParam, 8);
      uint flags = (uint)Marshal.ReadInt32(lParam, 12);
      if (msg == WM_MBUTTONDOWN || msg == WM_MBUTTONUP) button = 3;
      else if (msg == WM_XBUTTONDOWN || msg == WM_XBUTTONUP) {
        uint x = (data >> 16) & 0xFFFF;
        button = x == 1 ? 4 : x == 2 ? 5 : 0;
      }
      if ((flags & (LLMHF_INJECTED | LLMHF_LOWER_IL_INJECTED)) != 0) button = 0;
      bool isBound = button != 0 && bound != null && bound[button];
      // A press while marked down: its release was never seen.
      if (button != 0 && isDown && mouseDown[button]) ReleaseMouse(button);
      if (isBound && isDown) {
        lastEventTick = Environment.TickCount;
        mouseDown[button] = true;
        bool completes = false;
        var sets = mouseChords[button];
        if (sets != null && !suspended && OnlyModifiers(button)) { foreach (var mods in sets) { if (ModsExactly(mods)) { completes = true; break; } } }
        mouseSwallowed[button] = completes;
        swallow = completes;
        Emit("mouse" + button, true);
      } else if (button != 0 && !isDown && mouseDown[button]) {
        // Also the release of a press made before its button was unbound.
        lastEventTick = Environment.TickCount;
        swallow = mouseSwallowed[button];
        mouseDown[button] = false;
        mouseSwallowed[button] = false;
        if (isBound) Emit("mouse" + button, false);
      }
      // The hook stayed for a swallowed release only: it can go now.
      if (button != 0 && bound == null && !MousePending()) PostThreadMessage(hookThread, WM_APP_MOUSE, IntPtr.Zero, IntPtr.Zero);
    } catch { }
    if (swallow) return (IntPtr)1;
    return CallNextHookEx(IntPtr.Zero, nCode, wParam, lParam);
  }

  /** The name a reported key's release goes under. */
  static string UpName(string name) {
    return IsModifier(name) || name == "esc" || (name != null && chordKeys.Contains(name)) ? name : "other";
  }

  static void Emit(string k, bool d) {
    outbox.TryAdd("{\"event\":\"key\",\"k\":\"" + k + "\",\"d\":" + (d ? "1" : "0") + "}");
  }

  static IntPtr Callback(int nCode, IntPtr wParam, IntPtr lParam) {
    if (nCode >= 0) {
      try {
        var info = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(KBDLLHOOKSTRUCT));
        int msg = wParam.ToInt32();
        bool isDown = msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN;
        bool isUp = msg == WM_KEYUP || msg == WM_SYSKEYUP;
        uint vk = info.vkCode & 0xFF;
        if (watching && isDown && (info.flags & LLKHF_INJECTED) == 0 && (vk == 0x0D || vk == 0x09)) {
          outbox.TryAdd(vk == 0x0D ? "{\"event\":\"commit\",\"k\":\"enter\"}" : "{\"event\":\"commit\",\"k\":\"tab\"}");
        }
        if ((info.flags & LLKHF_INJECTED) == 0 && (isDown || isUp) && down[vk] != isDown) {
          string name = Name(vk);
          bool modBefore = ModifierDown() || BoundMouseDown();
          down[vk] = isDown;
          lastEventTick = Environment.TickCount;
          if (isDown) {
            bool report = false;
            string k = name;
            if (IsModifier(name)) report = true;
            else if (name == "esc") report = active;
            else if (name != null && chordKeys.Contains(name)) report = modBefore;
            else { k = "other"; report = modBefore; }
            reported[vk] = report;
            if (report) Emit(k, true);
            // Arm the mask once every key of a win chord is down.
            foreach (var chord in winChords) {
              bool all = true;
              foreach (var b in chord) { if (!BaseDown(b)) { all = false; break; } }
              if (all) { maskArmed = true; break; }
            }
          } else {
            if (reported[vk]) Emit(UpName(name), false);
            reported[vk] = false;
            if ((vk == 0x5B || vk == 0x5C) && maskArmed) {
              maskArmed = false;
              keybd_event(VK_MASK, 0, 0, UIntPtr.Zero);
              keybd_event(VK_MASK, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
            }
          }
        }
      } catch { }
    }
    return CallNextHookEx(IntPtr.Zero, nCode, wParam, lParam);
  }

  static IntPtr Install() {
    return SetWindowsHookEx(WH_KEYBOARD_LL, proc, GetModuleHandle(null), 0);
  }

  static IntPtr InstallMouse() {
    return SetWindowsHookEx(WH_MOUSE_LL, mouseProc, GetModuleHandle(null), 0);
  }

  /** Hook thread: the mouse hook follows the config (on while buttons are bound, off when not). */
  static void SyncMouse(bool reinstall) {
    var bound = boundMouse;
    // A button unbound while down: a press that passed is forgotten (its release passes too); a
    // swallowed one stays marked, and the hook with it, until its release is swallowed as well.
    for (int b = 3; b <= 5; b++) {
      if (mouseDown[b] && !mouseSwallowed[b] && (bound == null || !bound[b])) mouseDown[b] = false;
    }
    if (bound != null && (mouseHook == IntPtr.Zero || reinstall)) {
      IntPtr fresh = InstallMouse();
      // Failing: the old hook goes too, so nothing is swallowed while the mouse part reports
      // failed, and buttons marked down are reported up. The next 60 s cycle tries again.
      if (fresh == IntPtr.Zero) {
        if (mouseHook != IntPtr.Zero) UnhookWindowsHookEx(mouseHook);
        mouseHook = IntPtr.Zero;
        for (int b = 3; b <= 5; b++) ReleaseMouse(b);
        mouseFailed = true;
        outbox.TryAdd("{\"event\":\"mouse\",\"on\":false,\"failed\":true}");
        return;
      }
      IntPtr old = mouseHook;
      mouseHook = fresh;
      if (old != IntPtr.Zero) UnhookWindowsHookEx(old);
      if (old == IntPtr.Zero || mouseFailed) outbox.TryAdd("{\"event\":\"mouse\",\"on\":true}");
      mouseFailed = false;
    } else if (bound == null && mouseHook != IntPtr.Zero && !MousePending()) {
      UnhookWindowsHookEx(mouseHook);
      mouseHook = IntPtr.Zero;
      mouseFailed = false;
      for (int i = 0; i < mouseDown.Length; i++) { mouseDown[i] = false; mouseSwallowed[i] = false; }
      outbox.TryAdd("{\"event\":\"mouse\",\"on\":false}");
    }
  }

  /** Runs the hook thread; returns false when the first install fails. */
  public static bool Start() {
    var ready = new ManualResetEvent(false);
    bool ok = false;
    var t = new Thread(() => {
      hookThread = GetCurrentThreadId();
      hook = Install();
      ok = hook != IntPtr.Zero;
      ready.Set();
      if (!ok) return;
      var timer = new Timer(_ => PostThreadMessage(hookThread, WM_APP_REINSTALL, IntPtr.Zero, IntPtr.Zero), null, 60000, 60000);
      var check = new Timer(_ => PostThreadMessage(hookThread, WM_APP_CHECK, IntPtr.Zero, IntPtr.Zero), null, 1000, 1000);
      MSG m;
      while (GetMessage(out m, IntPtr.Zero, 0, 0) > 0) {
        if (m.message == WM_APP_MOUSE) { SyncMouse(false); continue; }
        if (m.message == WM_APP_CHECK) {
          if (unchecked(Environment.TickCount - lastEventTick) < 2000) continue;
          CheckReleases();
          // A hook kept only for a swallowed release goes once that release is settled.
          if (boundMouse == null) SyncMouse(false);
          continue;
        }
        if (m.message == WM_APP_REINSTALL) {
          CheckReleases();
          SyncMouse(boundMouse != null);
          IntPtr fresh = Install();
          if (fresh == IntPtr.Zero) { outbox.TryAdd("{\"event\":\"lost\"}"); continue; }
          IntPtr old = hook;
          hook = fresh;
          UnhookWindowsHookEx(old);
        }
      }
      timer.Dispose();
      check.Dispose();
      if (mouseHook != IntPtr.Zero) UnhookWindowsHookEx(mouseHook);
      mouseHook = IntPtr.Zero;
      if (hook != IntPtr.Zero) UnhookWindowsHookEx(hook);
      hook = IntPtr.Zero;
      outbox.CompleteAdding();
    });
    t.IsBackground = true;
    t.Start();
    ready.WaitOne(5000);
    if (!ok) outbox.CompleteAdding();
    return ok;
  }

  public static void Stop() {
    if (hookThread != 0) PostThreadMessage(hookThread, WM_QUIT, IntPtr.Zero, IntPtr.Zero);
  }

  public static void Configure(string[] keys, string[][] chords, int[] mouse) {
    var set = new HashSet<string>(keys);
    var wins = new List<string[]>();
    foreach (var c in chords) { if (Array.IndexOf(c, "win") >= 0) wins.Add(c); }
    chordKeys = set;
    winChords = wins;
    // Only the buttons the OS's low-level events name (3 middle, 4 back, 5 forward) can fire.
    bool[] bound = null;
    var sets = new string[33][][];
    foreach (var b in mouse) {
      if (b < 3 || b > 5) continue;
      if (bound == null) bound = new bool[33];
      bound[b] = true;
      var list = new List<string[]>();
      foreach (var c in chords) {
        if (Array.IndexOf(c, "mouse" + b) < 0) continue;
        var mods = new List<string>();
        foreach (var k in c) { if (k != "mouse" + b) mods.Add(k); }
        list.Add(mods.ToArray());
      }
      sets[b] = list.ToArray();
    }
    mouseChords = sets;
    boundMouse = bound;
    if (hookThread != 0) PostThreadMessage(hookThread, WM_APP_MOUSE, IntPtr.Zero, IntPtr.Zero);
  }

  public static void SetSuspended(bool on) { suspended = on; }

  public static void SetActive(bool on) { active = on; }

  public static void SetWatching(bool on) { watching = on; }
}
'@

[NotulaKeyHook]::WatchOwner($OwnerPid)
[NotulaKeyHook]::StartWriter()
if (-not [NotulaKeyHook]::Start()) {
  [Console]::Out.WriteLine('{"event":"error","message":"SetWindowsHookEx failed"}')
  [Console]::Out.Flush()
  exit 2
}
[NotulaKeyHook]::Send('{"event":"ready"}')

$running = $true
while ($running) {
  $text = [Console]::In.ReadLine()
  if ($null -eq $text) { break }
  if ($text.Trim().Length -eq 0) { continue }
  try {
    $req = $text | ConvertFrom-Json
    switch ($req.op) {
      'config' {
        $chords = @()
        foreach ($c in @($req.chords)) { $chords += ,([string[]]@($c)) }
        $mouse = @()
        if ($null -ne $req.mouse) { $mouse = @($req.mouse) }
        [NotulaKeyHook]::Configure([string[]]@($req.keys), [string[][]]$chords, [int[]]$mouse)
      }
      'active' { [NotulaKeyHook]::SetActive([bool]$req.on) }
      'watch' { [NotulaKeyHook]::SetWatching([bool]$req.on) }
      'suspend' { [NotulaKeyHook]::SetSuspended([bool]$req.on) }
      'stop' { $running = $false }
    }
  } catch {
    [NotulaKeyHook]::Send('{"event":"error","message":' + (ConvertTo-Json ([string]$_.Exception.Message)) + '}')
  }
}

[NotulaKeyHook]::Stop()
Start-Sleep -Milliseconds 100
exit 0
