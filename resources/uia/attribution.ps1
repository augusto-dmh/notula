# SPDX-License-Identifier: Apache-2.0
# Notula speaker attribution reader.
#
# Windows PowerShell 5.1 with the in-box .NET UI Automation client. It polls one meeting app's
# UI Automation tree and prints one JSON record per line on stdout (zoom-roster, teams-roster,
# meet-roster and the *-monitor-version lines). Main does everything else (timeline, stamping,
# self filtering).
#
# - It never touches the network, audio or files, and it only reads other apps' UI.
# - No tiles found means no participants: main treats that as the blind state.
# - Constrained Language Mode, or assemblies that will not load, print
#   {"event":"uia-unavailable","reason":...} and exit with code 3 (no restarts).
# - It exits when stdin closes (main's stop) or when its owner process is gone.
#
# Zoom names the current speaker by the first of three methods that names someone: a marker
# element the window uses for whoever is talking, the tiles' speaking label, then a fixed slot (the
# large tile of the focus layout). When the window's state makes them unreliable it names nobody
# and reports one refusal class instead:
#   sparse    too little of the tree: the walk stopped early, or only buttons were exposed;
#   mismatch  the numbers don't add up (no or an implausible count, unnamed tiles, more tiles
#             than people) or two parts of the view point at different speakers;
#   layout    a layout it can't trust: tiles inside tiles, non-video participants hidden, a share
#             whose content can't be found, or a layout it doesn't recognise;
#   self      the user's own view sits apart or is hidden;
#   window    not the main meeting view (a mini or stand-in window): the marker still counts;
#   version   fixed slot on a Zoom version not in $checkedZoomVersions;
#   idle      the view was read and nobody is talking (a muted first tile counts here).
# The cause goes into a zoom-refusal-detail line, which main logs at debug level only.
# The record's participantCount is the meeting's total as Zoom states it, or absent.
#
# Chromium-based windows (Meet in Chrome, new Teams' WebView2) build their web accessibility
# tree only once an assistive-technology client uses it. The reader asks for it with one MSAA
# hit test into the page area (IAccessible::accHitTest, the call a screen reader makes); that
# is the only native interop here, declared below.

param(
  [Parameter(Mandatory = $true)][ValidateSet('zoom', 'teams', 'meet')][string]$App,
  [int]$IntervalMs = 500,
  [string]$SelectorsJson = '-',
  [string]$SelfName = '-',
  [int]$OwnerPid = 0
)

$ErrorActionPreference = 'Stop'

# Constrained Language Mode blocks the .NET calls below: say so with cmdlets only, and stop.
if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') {
  Write-Output '{"event":"uia-unavailable","reason":"constrained-language"}'
  exit 3
}

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Esc([string]$s) {
  if ($null -eq $s) { return '' }
  $e = $s.Replace('\', '\\').Replace('"', '\"')
  return [regex]::Replace($e, '[\x00-\x1f]', { param($m) '\u{0:x4}' -f [int][char]$m.Value })
}

function Write-Record([string]$json) {
  [Console]::Out.WriteLine($json)
  [Console]::Out.Flush()
}

function Exit-Unavailable([string]$reason) {
  Write-Record ('{"event":"uia-unavailable","reason":"' + (Esc $reason) + '"}')
  exit 3
}

$native = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class NotulaUiaNative {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr p, EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("oleacc.dll")] static extern int AccessibleObjectFromWindow(IntPtr h, uint id, ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object o);
  public static IntPtr[] Windows(uint[] pids) {
    var set = new HashSet<uint>(pids);
    var list = new List<IntPtr>();
    EnumWindows((h, l) => {
      uint p; GetWindowThreadProcessId(h, out p);
      if (set.Contains(p) && IsWindowVisible(h)) list.Add(h);
      return true;
    }, IntPtr.Zero);
    return list.ToArray();
  }
  public static string Title(IntPtr h) { var sb = new StringBuilder(512); GetWindowText(h, sb, 512); return sb.ToString(); }
  public static string ClassOf(IntPtr h) { var sb = new StringBuilder(256); GetClassName(h, sb, 256); return sb.ToString(); }
  public static bool Minimized(IntPtr h) { return IsIconic(h); }
  public static int[] Rect(IntPtr h) { RECT r; GetWindowRect(h, out r); return new int[] { r.Left, r.Top, r.Right, r.Bottom }; }
  /** The largest Chromium content child of a window (WebView2 hosts), or the window itself. */
  public static IntPtr ChromiumHost(IntPtr top) {
    IntPtr best = IntPtr.Zero; long area = 0;
    EnumChildWindows(top, (h, l) => {
      string c = ClassOf(h);
      if (c == "Chrome_WidgetWin_0" || c == "Chrome_WidgetWin_1" || c == "Chrome_RenderWidgetHostHWND") {
        RECT r; GetWindowRect(h, out r);
        long a = (long)(r.Right - r.Left) * (r.Bottom - r.Top);
        if (a > area && IsWindowVisible(h)) { area = a; best = h; }
      }
      return true;
    }, IntPtr.Zero);
    return best;
  }
  /** One MSAA hit test at (x, y) through the window's client object: Chromium then builds its web tree. */
  public static bool HitTest(IntPtr h, int x, int y) {
    try {
      Guid iid = new Guid("618736E0-3C3D-11CF-810C-00AA00389B71");
      object o;
      if (AccessibleObjectFromWindow(h, 0xFFFFFFFC, ref iid, out o) != 0 || o == null) return false;
      var acc = o as Accessibility.IAccessible;
      if (acc == null) return false;
      acc.accHitTest(x, y);
      return true;
    } catch { return false; }
  }
}
'@

try {
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  Add-Type -TypeDefinition $native -ReferencedAssemblies Accessibility
} catch {
  Exit-Unavailable ('assemblies: ' + $_.Exception.Message)
}

$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$CT = [System.Windows.Automation.ControlType]

function From-B64([string]$s) {
  if ([string]::IsNullOrEmpty($s) -or $s -eq '-') { return '' }
  try { return [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($s)) } catch { return '' }
}

$selfName = (From-B64 $SelfName).Trim()
$selectors = $null
$selJson = From-B64 $SelectorsJson
if ($selJson) { try { $selectors = $selJson | ConvertFrom-Json } catch { $selectors = $null } }
if ($App -eq 'meet') {
  # The default Meet selectors; main passes the user's attribution.meetSelectors.
  if ($null -eq $selectors) {
    $selectors = [pscustomobject]@{ galleryTileClass = 'dkjMxf'; selfPreviewClass = 'aGWPv'; speakingIndicatorClass = 'kssMZb'
      talkingMeansActive = $true; selfByNameMatch = $true; selfFromMeetingControls = $false }
  }
}

$processNames = @{ zoom = @('Zoom'); teams = @('ms-teams'); meet = @('chrome') }[$App]

# One cache request for the tile subtrees: raw view (generic containers included), the three
# properties the readers need, fetched in one cross-process call per poll.
$cache = New-Object System.Windows.Automation.CacheRequest
$cache.TreeScope = $TS::Subtree
$cache.TreeFilter = [System.Windows.Automation.Automation]::RawViewCondition
$cache.AutomationElementMode = [System.Windows.Automation.AutomationElementMode]::None
$cache.Add($AE::NameProperty)
$cache.Add($AE::ClassNameProperty)
$cache.Add($AE::ControlTypeProperty)
# Zoom's layout comes from the tiles' sizes.
if ($App -eq 'zoom') { $cache.Add($AE::BoundingRectangleProperty) }

# Zoom's whole window, read twice a second for the marker, the count and the share banner.
$viewCache = New-Object System.Windows.Automation.CacheRequest
$viewCache.TreeScope = $TS::Subtree
$viewCache.TreeFilter = [System.Windows.Automation.Automation]::RawViewCondition
$viewCache.AutomationElementMode = [System.Windows.Automation.AutomationElementMode]::None
$viewCache.Add($AE::NameProperty)
$viewCache.Add($AE::ClassNameProperty)
$viewCache.Add($AE::ControlTypeProperty)

# A second request that keeps live references, for the periodic scan that finds the tiles.
$scanCache = New-Object System.Windows.Automation.CacheRequest
$scanCache.TreeScope = $TS::Subtree
$scanCache.TreeFilter = [System.Windows.Automation.Automation]::RawViewCondition
$scanCache.Add($AE::NameProperty)
$scanCache.Add($AE::ClassNameProperty)
$scanCache.Add($AE::ControlTypeProperty)

$state = @{
  hwnd = [IntPtr]::Zero
  root = $null          # the document (Chromium) or the window (Zoom)
  container = $null     # what each poll refreshes (Refresh-Groups), from the last full scan
  lastScanMs = -100000
  nextScanMs = 0
  scanBackoffMs = 2500
  rescanMs = 30000
  lastTriggerMs = -100000
  lastWindowsMs = -100000
  windows = @()
  lastLine = ''
  lastLineMs = 0
  view = $null          # Zoom: the last whole-window read (Zoom-View)
  lastViewMs = -100000
  lastDetail = ''
}
$clock = [System.Diagnostics.Stopwatch]::StartNew()

function Now-Unix { return [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }

function Find-Windows {
  if ($clock.ElapsedMilliseconds - $state.lastWindowsMs -lt 5000) { return $state.windows }
  $state.lastWindowsMs = $clock.ElapsedMilliseconds
  $pids = New-Object System.Collections.Generic.List[uint32]
  foreach ($n in $processNames) { foreach ($p in [System.Diagnostics.Process]::GetProcessesByName($n)) { $pids.Add([uint32]$p.Id); $p.Dispose() } }
  if ($pids.Count -eq 0) { $state.windows = @(); return @() }
  $state.windows = @([NotulaUiaNative]::Windows($pids.ToArray()))
  return $state.windows
}

function Is-MeetingWindow([IntPtr]$h) {
  $title = [NotulaUiaNative]::Title($h)
  switch ($App) {
    'meet' { return ($title -match '(^|\s)Meet(\s[-–]|$)|Google Meet|meet\.google\.com') }
    'teams' { return ($title -match '\| Microsoft Teams' -and $title -notmatch '^(Chat|Activity|Calendar|Teams|Calls|Files|Apps|Copilot|OneDrive)\s*\|') }
    'zoom' { return ($title -match '^Zoom( Meeting| Webinar)?$|Zoom Meeting|Zoom Workplace$' -or [NotulaUiaNative]::ClassOf($h) -eq 'ZPContentViewWndClass') }
  }
  return $false
}

function Reset-Target([IntPtr]$h) {
  $state.hwnd = $h
  $state.root = $null
  $state.container = $null
  $state.lastScanMs = -100000
  $state.nextScanMs = 0
  $state.scanBackoffMs = 2500
  $state.lastTriggerMs = -100000
  $state.view = $null
  $state.lastViewMs = -100000
}

# Chromium: one MSAA hit test in the page area so the web tree exists, then the document.
function Find-Document([IntPtr]$h) {
  if ($clock.ElapsedMilliseconds - $state.lastTriggerMs -ge 3000) {
    $state.lastTriggerMs = $clock.ElapsedMilliseconds
    $host_ = [NotulaUiaNative]::ChromiumHost($h)
    $target = if ($host_ -ne [IntPtr]::Zero) { $host_ } else { $h }
    $r = [NotulaUiaNative]::Rect($target)
    $x = [int](($r[0] + $r[2]) / 2); $y = [int]($r[1] + ($r[3] - $r[1]) * 0.6)
    [void][NotulaUiaNative]::HitTest($h, $x, $y)
    if ($target -ne $h) { [void][NotulaUiaNative]::HitTest($target, $x, $y) }
  }
  $win = $AE::FromHandle($h)
  $cond = New-Object System.Windows.Automation.AndCondition(
    (New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $CT::Document)),
    (New-Object System.Windows.Automation.PropertyCondition($AE::AutomationIdProperty, 'RootWebArea')))
  $docs = New-Object System.Windows.Automation.CacheRequest
  $docs.TreeFilter = [System.Windows.Automation.Automation]::RawViewCondition
  $docs.Add($AE::NameProperty)
  $docs.Add($AE::BoundingRectangleProperty)
  $docs.Push()
  try { $found = $win.FindAll($TS::Descendants, $cond) } finally { $docs.Pop() }
  # Chromium windows hold several web roots (tab strip, side panels): the page is the one named
  # like the window, else the largest.
  $title = [NotulaUiaNative]::Title($h)
  $best = $null; $bestArea = -1
  foreach ($d in $found) {
    $n = $d.Cached.Name
    if ($n -and $title.StartsWith($n)) { return $d }
    $r = $d.Cached.BoundingRectangle
    $area = if ($r.IsEmpty) { 0 } else { $r.Width * $r.Height }
    if ($area -gt $bestArea) { $bestArea = $area; $best = $d }
  }
  if ($null -ne $best -and $bestArea -gt 0) { return $best }
  return $null
}

function Same-Name([string]$a, [string]$b) {
  return $a -and $b -and ($a.Trim().ToLowerInvariant() -eq $b.Trim().ToLowerInvariant())
}

# Class tokens are matched as ' <class> ' inside ' <ClassName> ' (no splitting per element).
$galleryToken = if ($selectors) { ' ' + $selectors.galleryTileClass + ' ' } else { '' }
$selfToken = if ($selectors) { ' ' + $selectors.selfPreviewClass + ' ' } else { '' }
$speakingToken = if ($selectors) { ' ' + $selectors.speakingIndicatorClass + ' ' } else { '' }
$tileName = '^(?<name>[^,()]{1,80}?)\s*(\((?<tag>[^)]*)\))?\s*,\s*(?<rest>.*)$'
$tileRest = '(?i)video|camera|mute|mic|speaking|talking|presenting|hand'

function Is-Tile($e) {
  if ($App -eq 'meet') {
    $c = $e.Cached.ClassName
    if (-not $c) { return $false }
    $p = ' ' + $c + ' '
    return $p.Contains($galleryToken) -or $p.Contains($selfToken)
  }
  $ct = $e.Cached.ControlType
  if ($ct -ne $CT::Group -and $ct -ne $CT::ListItem -and $ct -ne $CT::Custom -and $ct -ne $CT::Pane) { return $false }
  $n = $e.Cached.Name
  return [bool]($n -and $n -match $tileName -and $Matches['rest'] -match $tileRest)
}

# One depth-first pass over a cached tree: the tiles (not descended into) and each tile's parent.
# Elements are compared by reference: their UIA equality would cost a round trip each.
function Scan-Tiles($root) {
  $tiles = New-Object System.Collections.Generic.List[object]
  $parents = New-Object System.Collections.Generic.List[object]
  $path = New-Object System.Collections.Generic.List[object]
  $stack = New-Object System.Collections.Generic.Stack[object]
  $depths = New-Object System.Collections.Generic.Stack[int]
  $stack.Push($root)
  $depths.Push(0)
  while ($stack.Count -gt 0) {
    $e = $stack.Pop()
    $d = $depths.Pop()
    while ($path.Count -gt $d) { $path.RemoveAt($path.Count - 1) }
    $path.Add($e)
    # Meet's class test is inlined: a function call per element costs more than the walk.
    $hit = $false
    if ($App -eq 'meet') {
      $c = $e.Cached.ClassName
      if ($c) {
        $p = ' ' + $c + ' '
        $hit = $p.Contains($galleryToken) -or $p.Contains($selfToken)
      }
    } else { $hit = Is-Tile $e }
    if ($hit) {
      $tiles.Add($e)
      $parents.Add($(if ($path.Count -ge 2) { $path[$path.Count - 2] } else { $null }))
      continue
    }
    $kids = $e.CachedChildren
    if ($null -ne $kids) { for ($i = $kids.Count - 1; $i -ge 0; $i--) { $stack.Push($kids[$i]); $depths.Push($d + 1) } }
  }
  return @{ tiles = $tiles; parents = $parents }
}

# Elements under a cached element, counting up to $cap.
function Subtree-Size($root, [int]$cap) {
  $n = 0
  $stack = New-Object System.Collections.Generic.Stack[object]
  $stack.Push($root)
  while ($stack.Count -gt 0 -and $n -le $cap) {
    $e = $stack.Pop()
    $n++
    $kids = $e.CachedChildren
    if ($null -ne $kids) { foreach ($k in $kids) { $stack.Push($k) } }
  }
  return $n
}

# What each poll refreshes: a small shared parent once (it also shows tiles that join it), or
# the tiles of a large parent one by one. Each entry: @{ el = <live element>; whole = <bool> }.
function Refresh-Groups($found) {
  $groups = New-Object System.Collections.Generic.List[object]
  $seen = New-Object System.Collections.Generic.List[object]
  for ($i = 0; $i -lt $found.tiles.Count; $i++) {
    $parent = $found.parents[$i]
    $tile = $found.tiles[$i]
    if ($null -eq $parent) { $groups.Add(@{ el = $tile; whole = $false }); continue }
    $known = $false
    foreach ($s in $seen) { if ([object]::ReferenceEquals($s, $parent)) { $known = $true; break } }
    if ($known) { continue }
    $seen.Add($parent)
    if ((Subtree-Size $parent 400) -le 400) { $groups.Add(@{ el = $parent; whole = $true }) }
    else {
      for ($j = $i; $j -lt $found.tiles.Count; $j++) {
        if ([object]::ReferenceEquals($found.parents[$j], $parent)) { $groups.Add(@{ el = $found.tiles[$j]; whole = $false }) }
      }
    }
  }
  return $groups
}

# ---------- Meet (selector-driven) ----------
function Meet-Parse($tile) {
  $isSelf = (' ' + $tile.Cached.ClassName + ' ').Contains($selfToken)
  $name = ''
  $found = $false
  $first = $true
  $stack = New-Object System.Collections.Generic.Stack[object]
  $stack.Push($tile)
  while ($stack.Count -gt 0) {
    $e = $stack.Pop()
    $c = $e.Cached.ClassName
    if (-not $found -and $c -and (' ' + $c + ' ').Contains($speakingToken)) { $found = $true }
    if (-not $first -and -not $name -and $e.Cached.ControlType -eq $CT::Text) {
      $n = $e.Cached.Name
      if ($n) { $name = $n.Trim() }
    }
    $first = $false
    $kids = $e.CachedChildren
    if ($null -ne $kids) { for ($i = $kids.Count - 1; $i -ge 0; $i--) { $stack.Push($kids[$i]) } }
  }
  $active = if ($selectors.talkingMeansActive) { $found } else { -not $found }
  if (-not $isSelf -and $selectors.selfByNameMatch -and $name) {
    if ((Same-Name $name $selfName) -or $name -match '\((You|you)\)\s*$') { $isSelf = $true }
  }
  if ($name -match '^(.*?)\s*\((You|you)\)\s*$') { $name = $Matches[1] }
  return @{ name = $name; active = [bool]$active; isSelf = [bool]$isSelf; handRaised = $false }
}

# ---------- Teams and Zoom (name-based heuristics; Teams' tree comes through WebView2) ----------

function Heuristic-Parse($tile) {
  $n = $tile.Cached.Name
  $name = ''; $tag = ''; $rest = ''
  if ($n -match $tileName) { $name = $Matches['name'].Trim(); $tag = $Matches['tag']; $rest = $Matches['rest'] }
  $speaking = $rest -match '(?i)\b(is )?(speaking|talking)\b'
  if (-not $speaking) {
    $stack = New-Object System.Collections.Generic.Stack[object]
    $stack.Push($tile)
    while ($stack.Count -gt 0 -and -not $speaking) {
      $e = $stack.Pop()
      $c = $e.Cached.ClassName
      if (($c -and $c -match '(?i)speaking|active-speaker|voice-level') -or ($e.Cached.Name -and $e.Cached.Name -match '(?i)\b(is )?speaking\b')) { $speaking = $true }
      $kids = $e.CachedChildren
      if ($null -ne $kids) { foreach ($k in $kids) { $stack.Push($k) } }
    }
  }
  $isSelf = ($tag -match '(?i)^(you|me)$|,\s*me$') -or (Same-Name $name $selfName)
  return @{ name = $name; active = [bool]$speaking; isSelf = [bool]$isSelf; handRaised = ($rest -match '(?i)hand (is )?raised') }
}

# ---------- Zoom: the three methods and their refusals ----------

# Fixed slot names only on versions it was checked against in a live window. Add a version here
# after that check; until then fixed slot refuses with `version`.
$checkedZoomVersions = @()
$zoomVersion = ''
$viewCap = 4000
$zoomMarker = '^(?i)\s*(talking|speaking|active speaker)\s*:\s*(?<name>[^,]{1,80}?)\s*$'
$zoomCount = '(?i)\bpartic(i)?pants?\b\D{0,24}?(?<n>\d{1,4})\b|\b(?<n>\d{1,4})\s+partic(i)?pants?\b'
$zoomShare = "(?i)\byou are viewing\b.{1,80}\bscreen\b|\bis sharing (the |their |a )?screen\b"
$zoomShareContent = '(?i)\b(shared (screen|content)|screen share content|share content)\b'
$zoomNonVideo = '(?i)\b(show|hide) non-video participants\b|\bnon-video participants (are )?hidden\b'

# The whole window, read once: the marker names, Zoom's own participant total, the share banner
# and content, and whether the read is too thin to trust.
function Zoom-View($root) {
  $v = @{ truncated = $false; namedOther = 0; count = $null; markers = New-Object System.Collections.Generic.List[string]
    share = $false; shareContent = $false; nonVideoHidden = $false; selfTiles = 0 }
  $fresh = $root.GetUpdatedCache($viewCache)
  $stack = New-Object System.Collections.Generic.Stack[object]
  $stack.Push($fresh)
  $n = 0
  while ($stack.Count -gt 0) {
    if (++$n -gt $viewCap) { $v.truncated = $true; break }
    $e = $stack.Pop()
    $name = $e.Cached.Name
    $ct = $e.Cached.ControlType
    if ($name) {
      if ($ct -ne $CT::Button -and $ct -ne $CT::MenuItem -and $ct -ne $CT::TitleBar -and $ct -ne $CT::Window) { $v.namedOther++ }
      if ($name -match $zoomMarker) { $m = $Matches['name'].Trim(); if ($m -and -not ($v.markers | Where-Object { Same-Name $_ $m })) { $v.markers.Add($m) } }
      elseif ($null -eq $v.count -and ($ct -eq $CT::Button -or $ct -eq $CT::MenuItem -or $ct -eq $CT::TabItem -or $ct -eq $CT::Text) -and $name -match $zoomCount) { $v.count = [int]$Matches['n'] }
      if ($name -match $zoomShare) { $v.share = $true }
      elseif ($name -match $zoomShareContent) { $v.shareContent = $true }
      if ($name -match $zoomNonVideo -and $name -notmatch '(?i)^hide') { $v.nonVideoHidden = $true }
      if ($name -match $tileName -and $Matches['tag'] -match '(?i)^(you|me)$') { $v.selfTiles++ }
    }
    $kids = $e.CachedChildren
    if ($null -ne $kids) { foreach ($k in $kids) { $stack.Push($k) } }
  }
  return $v
}

# A tile with another tile under it: the speaking label can't tell whose it is.
function Has-Nested($tile) {
  $stack = New-Object System.Collections.Generic.Stack[object]
  $kids = $tile.CachedChildren
  if ($null -ne $kids) { foreach ($k in $kids) { $stack.Push($k) } }
  while ($stack.Count -gt 0) {
    $e = $stack.Pop()
    if (Is-Tile $e) { return $true }
    $kids = $e.CachedChildren
    if ($null -ne $kids) { foreach ($k in $kids) { $stack.Push($k) } }
  }
  return $false
}

function Zoom-Parse($tile) {
  $p = Heuristic-Parse $tile
  $r = $tile.Cached.BoundingRectangle
  $p.area = if ($r.IsEmpty) { 0 } else { $r.Width * $r.Height }
  $p.muted = [bool]($tile.Cached.Name -match '(?i)\b(audio |mic(rophone)? )?muted\b|\bmic(rophone)? off\b')
  $p.nested = Has-Nested $tile
  return $p
}

# grid: tiles of about one size; focus: one tile at least three times the next; share: a share is coming in.
function Zoom-Layout($parts, $view) {
  if ($view.share) { return 'share' }
  $areas = @($parts | Where-Object { $_.area -gt 0 } | ForEach-Object { $_.area } | Sort-Object -Descending)
  if ($areas.Count -eq 0) { return 'unknown' }
  if ($areas.Count -eq 1 -or $areas[0] -ge 3 * $areas[1]) { return 'focus' }
  if ($areas[0] -le 1.6 * $areas[$areas.Count - 1]) { return 'grid' }
  return 'unknown'
}

# The main meeting view: the meeting window at a usable size, not a mini or stand-in window.
function Is-MainView([IntPtr]$h) {
  $r = [NotulaUiaNative]::Rect($h)
  $title = [NotulaUiaNative]::Title($h)
  return ($r[2] - $r[0]) -ge 480 -and ($r[3] - $r[1]) -ge 320 -and ($title -match 'Zoom Meeting|Zoom Webinar|Zoom Workplace' -or [NotulaUiaNative]::ClassOf($h) -eq 'ZPContentViewWndClass')
}

function Refuse($z, [string]$class, [string]$detail) { $z.refusal = $class; $z.detail = $detail; return $z }

# Fixed slot: the one place the layout always puts the current speaker. Null when it doesn't apply.
function Zoom-Slot($z, $parts, $view, [IntPtr]$h) {
  if ($z.layout -eq 'grid') { return $z }
  if (-not (Is-MainView $h)) { return (Refuse $z 'window' 'not the main meeting view') }
  if ($checkedZoomVersions -notcontains $zoomVersion) { return (Refuse $z 'version' 'fixed slot not checked on this version') }
  if ($null -eq $view.count) { return (Refuse $z 'mismatch' 'no participant count') }
  if ($view.count -lt 1 -or $view.count -gt 1000) { return (Refuse $z 'mismatch' 'implausible participant count') }
  if (@($parts | Where-Object { -not $_.name }).Count -gt 0) { return (Refuse $z 'mismatch' 'a tile without a name') }
  if ($parts.Count -gt $view.count) { return (Refuse $z 'mismatch' 'more tiles than participants') }
  if ($view.nonVideoHidden) { return (Refuse $z 'layout' 'non-video participants hidden') }
  $video = @($parts | Where-Object { $_.area -gt 0 } | Sort-Object -Property { $_.area } -Descending)
  if ($z.layout -eq 'share') {
    if (-not $view.shareContent) { return (Refuse $z 'layout' 'share content not found') }
    if ($video.Count -ne 1) { return (Refuse $z 'layout' 'share view with several video tiles') }
  } elseif ($z.layout -ne 'focus') { return (Refuse $z 'layout' 'layout not recognised') }
  if ($z.selfView -ne 'shown') { return (Refuse $z 'self' "self view $($z.selfView)") }
  $main = $video[0]
  if ($null -eq $main) { return (Refuse $z 'layout' 'no video tile') }
  if ($main.muted) { return (Refuse $z 'idle' 'first tile muted') }
  if (-not $main.isSelf -and $main.name) { $z.method = 'slot'; $z.speaker = $main.name }
  return $z
}

# The three methods in order; the first that names someone wins. Conflicts and a thin read name nobody.
function Zoom-Speaker($parts, $view, [IntPtr]$h) {
  $z = @{ method = $null; speaker = $null; refusal = $null; detail = ''; count = $view.count; shareIncoming = [bool]$view.share; layout = 'unknown'; selfView = 'hidden' }
  $z.layout = Zoom-Layout $parts $view
  $z.selfView = if (@($parts | Where-Object { $_.isSelf }).Count -gt 0) { 'shown' } elseif ($view.selfTiles -gt 0) { 'separate' } else { 'hidden' }
  if ($view.truncated) { return (Refuse $z 'sparse' 'tree walk stopped early') }
  if ($view.namedOther -eq 0) { return (Refuse $z 'sparse' 'only buttons exposed') }
  $label = $null
  foreach ($p in $parts) { if ($p.active -and -not $p.isSelf -and $p.name) { $label = $p.name; break } }
  if ($view.markers.Count -gt 1) { return (Refuse $z 'mismatch' 'markers name different people') }
  $marker = if ($view.markers.Count -eq 1) { $view.markers[0] } else { $null }
  if ($marker -and $label -and -not (Same-Name $marker $label)) { return (Refuse $z 'mismatch' 'marker and speaking label disagree') }
  if ($marker) { $z.method = 'marker'; $z.speaker = $marker; return $z }
  if (@($parts | Where-Object { $_.nested }).Count -gt 0) { return (Refuse $z 'layout' 'tiles inside tiles') }
  if ($label) { $z.method = 'label'; $z.speaker = $label; return $z }
  return (Zoom-Slot $z $parts $view $h)
}

# ---------- one poll ----------
function Poll {
  $now = Now-Unix
  $wins = @(Find-Windows | Where-Object { Is-MeetingWindow $_ })
  if ($wins.Count -eq 0) {
    if ($state.hwnd -ne [IntPtr]::Zero) { Reset-Target ([IntPtr]::Zero) }
    return (Roster @() $null $false $false 'no-window' $now)
  }
  $h = if ($wins -contains $state.hwnd) { $state.hwnd } else { $wins[0] }
  if ($h -ne $state.hwnd) { Reset-Target $h }
  if ([NotulaUiaNative]::Minimized($h)) { return (Roster @() $null $false $true 'minimized' $now) }

  if ($null -eq $state.root) {
    if ($App -eq 'zoom') { $state.root = $AE::FromHandle($h) } else { $state.root = Find-Document $h }
    if ($null -eq $state.root) { return (Roster @() $null $false $true 'no-accessibility-tree' $now) }
  }

  # The whole page is scanned only to find the tiles: every 30 s while tiles are known (120 s when
  # their grid is refreshed whole, which shows joins), with a backoff (5 s doubling to 60 s) while
  # none are found. Each poll refreshes
  # only the tiles' grid or the known tiles; a tile that went away triggers a rescan.
  if ($null -eq $state.container -and $clock.ElapsedMilliseconds -lt $state.nextScanMs) {
    return (Roster @() $null $false $true 'no-tiles' $now)
  }
  if ($null -eq $state.container -or $clock.ElapsedMilliseconds - $state.lastScanMs -ge $state.rescanMs) {
    $state.lastScanMs = $clock.ElapsedMilliseconds
    $found = Scan-Tiles ($state.root.GetUpdatedCache($scanCache))
    if ($found.tiles.Count -eq 0) {
      $state.container = $null
      $state.scanBackoffMs = [Math]::Min(60000, [Math]::Max(5000, $state.scanBackoffMs * 2))
      $state.nextScanMs = $clock.ElapsedMilliseconds + $state.scanBackoffMs
      return (Roster @() $null $false $true 'no-tiles' $now)
    }
    $state.scanBackoffMs = 2500
    $state.container = Refresh-Groups $found
    # A shared parent refreshed whole shows new tiles by itself: then a full rescan is rarely needed.
    $gallery = @($state.container | Where-Object { -not $_.whole }).Count -le 1
    $state.rescanMs = if ($gallery) { 120000 } else { 30000 }
  }

  $tiles = New-Object System.Collections.Generic.List[object]
  try {
    foreach ($g in $state.container) {
      $fresh = $g.el.GetUpdatedCache($cache)
      if ($g.whole) { foreach ($t in (Scan-Tiles $fresh).tiles) { $tiles.Add($t) } } else { $tiles.Add($fresh) }
    }
    if ($tiles.Count -eq 0) { throw 'no tiles left' }
  } catch {
    # A tile left (someone hung up, the layout changed): find them again now.
    $state.container = $null
    $state.nextScanMs = 0
    return (Roster @() $null $false $true 'no-tiles' $now)
  }
  if ($App -eq 'zoom') {
    $parts = @(foreach ($t in $tiles) { Zoom-Parse $t })
    if ($null -eq $state.view -or $clock.ElapsedMilliseconds - $state.lastViewMs -ge 500) {
      $state.lastViewMs = $clock.ElapsedMilliseconds
      $state.view = Zoom-View $state.root
    }
    $z = Zoom-Speaker $parts $state.view $h
    Zoom-Detail $z
    return (Roster $parts $z.speaker $false $true $null $now $z)
  }
  $parts = @(foreach ($t in $tiles) { if ($App -eq 'meet') { Meet-Parse $t } else { Heuristic-Parse $t } })
  $speaker = $null
  $selfActive = $false
  foreach ($p in $parts) {
    if (-not $p.active) { continue }
    if ($p.isSelf) { $selfActive = $true } elseif ($null -eq $speaker -and $p.name) { $speaker = $p.name }
  }
  return (Roster $parts $speaker $selfActive $true $null $now)
}

# The refusal's cause, once per change: main logs it at debug level only. Fixed phrases, no names.
function Zoom-Detail($z) {
  $key = "$($z.refusal)|$($z.detail)"
  if ($key -eq $state.lastDetail) { return }
  $state.lastDetail = $key
  if ($z.refusal) { Write-Record ('{"event":"zoom-refusal-detail","refusal":"' + (Esc $z.refusal) + '","detail":"' + (Esc $z.detail) + '"}') }
}

# $zoom: Zoom-Speaker's result; null on a blind record (nothing read: `sparse`).
function Roster($parts, $speaker, [bool]$selfActive, [bool]$windowPresent, $blindReason, [int64]$ts, $zoom = $null) {
  $items = New-Object System.Collections.Generic.List[string]
  $n = 0
  foreach ($p in $parts) {
    if ($n++ -ge 100) { break }
    $nm = if ($p.name) { '"' + (Esc $p.name) + '"' } else { 'null' }
    $active = if ($p.active) { 'true' } else { 'false' }
    $self = if ($p.isSelf) { 'true' } else { 'false' }
    $hand = if ($p.handRaised) { 'true' } else { 'false' }
    switch ($App) {
      'zoom' { $items.Add('{"name":' + $nm + ',"active":' + $active + '}') }
      'teams' { $items.Add('{"name":' + $nm + ',"active":' + $active + ',"isSelf":' + $self + ',"handRaised":' + $hand + '}') }
      'meet' { $items.Add('{"name":' + $nm + ',"active":' + $active + ',"isSelf":' + $self + '}') }
    }
  }
  $sp = if ($speaker) { '"' + (Esc $speaker) + '"' } else { 'null' }
  $sa = if ($selfActive) { 'true' } else { 'false' }
  $wp = if ($windowPresent) { 'true' } else { 'false' }
  $blind = if ($blindReason) { ',"blindReason":"' + (Esc $blindReason) + '"' } else { '' }
  $list = '[' + [string]::Join(',', $items) + ']'
  switch ($App) {
    'zoom' {
      $selfLine = ''
      foreach ($p in $parts) { if ($p.isSelf -and $p.name) { $selfLine = '"' + (Esc $p.name) + '"'; break } }
      if (-not $selfLine) { $selfLine = 'null' }
      if ($null -eq $zoom) { $zoom = @{ method = $null; refusal = 'sparse'; count = $null; shareIncoming = $false; layout = 'unknown'; selfView = 'hidden' } }
      # Zoom's own total, never the tiles on screen (a gallery shows one page of them).
      $count = if ($null -ne $zoom.count) { ',"participantCount":' + [int]$zoom.count } else { '' }
      $method = if ($zoom.method) { '"' + $zoom.method + '"' } else { 'null' }
      $refusal = if ($zoom.refusal) { '"' + $zoom.refusal + '"' } else { 'null' }
      $share = if ($zoom.shareIncoming) { 'true' } else { 'false' }
      return '{"event":"zoom-roster","participants":' + $list + ',"participantName":' + $sp + ',"ownName":' + $selfLine + ',"hasMeetingWindow":' + $wp + $count +
        ',"method":' + $method + ',"layout":"' + $zoom.layout + '","selfView":"' + $zoom.selfView + '","shareIncoming":' + $share + ',"refusal":' + $refusal + $blind + ',"timestamp":' + $ts + '}'
    }
    'teams' { return '{"event":"teams-roster","participants":' + $list + ',"participantName":' + $sp + ',"selfActive":' + $sa + ',"hasMeetingWindow":' + $wp + $blind + ',"timestamp":' + $ts + '}' }
    'meet' { return '{"event":"meet-roster","participants":' + $list + ',"participantName":' + $sp + ',"selfActive":' + $sa + $blind + ',"timestamp":' + $ts + '}' }
  }
}

# ---------- version lines ----------
function Version-Of([string]$processName) {
  foreach ($p in [System.Diagnostics.Process]::GetProcessesByName($processName)) {
    try { $v = $p.MainModule.FileVersionInfo.ProductVersion; if ($v) { return $v } } catch { } finally { $p.Dispose() }
  }
  return ''
}
if ($App -eq 'zoom') {
  $zoomVersion = Version-Of 'Zoom'
  Write-Record ('{"event":"zoom-speaker-monitor-version","zoomVersion":"' + (Esc $zoomVersion) + '"}')
}
if ($App -eq 'teams') { Write-Record ('{"event":"teams-speaker-monitor-version","teamsVersion":"' + (Esc (Version-Of 'ms-teams')) + '"}') }

# ---------- the loop ----------
$owner = $null
if ($OwnerPid -gt 0) { try { $owner = [System.Diagnostics.Process]::GetProcessById($OwnerPid) } catch { exit 0 } }
# Main stops the reader by closing stdin: a pending read completing with 0 bytes.
$stdin = [Console]::OpenStandardInput()
$buf = New-Object byte[] 256
$readTask = $stdin.ReadAsync($buf, 0, $buf.Length)

while ($true) {
  if ($null -ne $owner -and $owner.HasExited) { exit 0 }
  if ($readTask.IsCompleted) {
    if ($readTask.IsFaulted -or $readTask.Result -le 0) { exit 0 }
    $readTask = $stdin.ReadAsync($buf, 0, $buf.Length)
  }
  $started = $clock.ElapsedMilliseconds
  $line = $null
  try {
    $line = Poll
  } catch {
    # A target that changed under us (closed window, rebuilt page): start over next poll.
    Reset-Target ([IntPtr]::Zero)
    $state.lastWindowsMs = -100000
    Write-Record ('{"event":"reader-error","message":"' + (Esc $_.Exception.Message) + '"}')
  }
  if ($line) {
    # The same roster is repeated at most once a second (main refreshes "last seen" with it).
    $body = $line -replace ',"timestamp":\d+\}$', ''
    if ($body -ne $state.lastLine -or $clock.ElapsedMilliseconds - $state.lastLineMs -ge 1000) {
      Write-Record $line
      $state.lastLine = $body
      $state.lastLineMs = $clock.ElapsedMilliseconds
    }
  }
  $sleep = $IntervalMs - ($clock.ElapsedMilliseconds - $started)
  if ($sleep -lt 25) { $sleep = 25 }
  [System.Threading.Thread]::Sleep([int]$sleep)
}
