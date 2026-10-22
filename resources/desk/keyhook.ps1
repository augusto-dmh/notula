# SPDX-License-Identifier: Apache-2.0
# notula-desk key hook (Windows): the dictation bar's key-state source.
# Started by the notula-desk utility process only while a hook shortcut is set and Voice typing is
# armed; it exits when stdin closes or its owner process is gone. No network, no files.
#
# A C# WH_KEYBOARD_LL hook, compiled at start with Add-Type so there is no native addon to build
# or sign, on its own message-loop thread. It only observes: it never swallows a key.
# The callback copies the event into a queue and returns; a writer thread prints it.
#
# Protocol: JSON lines on stdin
#   {"op":"config","keys":["space"],"chords":[["ctrl","win"],["ctrl","space","win"]]}
#   {"op":"active","on":true}          Esc is reported only while a dictation is active
# JSON lines on stdout
#   {"event":"ready"}                  the hook is installed
#   {"event":"key","k":"ctrl_r","d":1} a transition (d = 1 down, 0 up), never a repeat
#   {"event":"lost"}                   re-installing the hook failed
#   {"event":"error","message":"..."}
# What it reports: every modifier (ctrl, alt, shift, win, with _r for the right side); the
# chords' other keys (space, a letter …) only while a modifier is down; esc only while active;
# any other key as "other" (no identity) only while a modifier is down. Nothing else, ever.
#
# Start-menu masking: when every key of a chord containing win is down, the next win key-up is
# preceded by a dummy VK 0xE8 down/up (unassigned), so the shell sees a chord, not a lone Win.
# Windows silently removes a hook whose callback overruns LowLevelHooksTimeout; the hook thread
# re-installs itself every 60 s (new hook first, then the old one removed) and reports "lost"
# only when installing fails.

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
  const int WH_KEYBOARD_LL = 13;
  const int WM_KEYDOWN = 0x100, WM_KEYUP = 0x101, WM_SYSKEYDOWN = 0x104, WM_SYSKEYUP = 0x105;
  const uint WM_QUIT = 0x12, WM_APP_REINSTALL = 0x8001;
  const int LLKHF_INJECTED = 0x10;
  const byte VK_MASK = 0xE8;
  const uint KEYEVENTF_KEYUP = 0x2;

  [StructLayout(LayoutKind.Sequential)]
  struct KBDLLHOOKSTRUCT { public uint vkCode; public uint scanCode; public uint flags; public uint time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)]
  struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public int x; public int y; }

  delegate IntPtr HookProc(int nCode, IntPtr wParam, IntPtr lParam);

  [DllImport("user32.dll", SetLastError = true)] static extern IntPtr SetWindowsHookEx(int id, HookProc fn, IntPtr mod, uint thread);
  [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr h, int n, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern int GetMessage(out MSG m, IntPtr hwnd, uint min, uint max);
  [DllImport("user32.dll")] static extern bool PostThreadMessage(uint thread, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("kernel32.dll")] static extern IntPtr GetModuleHandle(string name);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();

  static readonly HookProc proc = Callback;
  static IntPtr hook = IntPtr.Zero;
  static uint hookThread;
  static readonly BlockingCollection<string> outbox = new BlockingCollection<string>(4096);
  static readonly bool[] down = new bool[256];
  static readonly bool[] reported = new bool[256];

  // Configuration (replaced whole; read by the callback).
  static volatile HashSet<string> chordKeys = new HashSet<string>();
  static volatile List<string[]> winChords = new List<string[]>();
  static volatile bool active;
  static bool maskArmed;

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
        if ((info.flags & LLKHF_INJECTED) == 0 && (isDown || isUp) && down[vk] != isDown) {
          string name = Name(vk);
          bool modBefore = ModifierDown();
          down[vk] = isDown;
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
            if (reported[vk]) Emit(IsModifier(name) || name == "esc" || (name != null && chordKeys.Contains(name)) ? name : "other", false);
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
      MSG m;
      while (GetMessage(out m, IntPtr.Zero, 0, 0) > 0) {
        if (m.message == WM_APP_REINSTALL) {
          IntPtr fresh = Install();
          if (fresh == IntPtr.Zero) { outbox.TryAdd("{\"event\":\"lost\"}"); continue; }
          IntPtr old = hook;
          hook = fresh;
          UnhookWindowsHookEx(old);
        }
      }
      timer.Dispose();
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

  public static void Configure(string[] keys, string[][] chords) {
    var set = new HashSet<string>(keys);
    var wins = new List<string[]>();
    foreach (var c in chords) { if (Array.IndexOf(c, "win") >= 0) wins.Add(c); }
    chordKeys = set;
    winChords = wins;
  }

  public static void SetActive(bool on) { active = on; }
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
        [NotulaKeyHook]::Configure([string[]]@($req.keys), [string[][]]$chords)
      }
      'active' { [NotulaKeyHook]::SetActive([bool]$req.on) }
      'stop' { $running = $false }
    }
  } catch {
    [NotulaKeyHook]::Send('{"event":"error","message":' + (ConvertTo-Json ([string]$_.Exception.Message)) + '}')
  }
}

[NotulaKeyHook]::Stop()
Start-Sleep -Milliseconds 100
exit 0
