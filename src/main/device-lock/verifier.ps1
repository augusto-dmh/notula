# SPDX-License-Identifier: Apache-2.0
# Notula device lock: Windows Hello through UserConsentVerifier.
# Bundled text, written to <userData>/helpers and verified by SHA-256 before every run.
# Input on stdin, one JSON line: {"op":"check"} or {"op":"verify","message":"..."}.
# Output on stdout, one JSON line: {"result":"<word>"}. Never prints anything biometric (the OS shares nothing).
$ErrorActionPreference = 'Stop'
try {
  $line = [Console]::In.ReadLine()
  $req = $line | ConvertFrom-Json
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.Security.Credentials.UI.UserConsentVerifier, Windows.Security.Credentials.UI, ContentType = WindowsRuntime]
  $asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  } | Select-Object -First 1
  function Await($op, [Type]$type) {
    $task = $asTask.MakeGenericMethod($type).Invoke($null, @($op))
    $null = $task.Wait(-1)
    $task.Result
  }
  if ($req.op -eq 'check') {
    $r = Await ([Windows.Security.Credentials.UI.UserConsentVerifier]::CheckAvailabilityAsync()) ([Windows.Security.Credentials.UI.UserConsentVerifierAvailability])
  } elseif ($req.op -eq 'verify') {
    $msg = [string]$req.message
    if ($msg.Length -gt 200) { $msg = $msg.Substring(0, 200) }
    $r = Await ([Windows.Security.Credentials.UI.UserConsentVerifier]::RequestVerificationAsync($msg)) ([Windows.Security.Credentials.UI.UserConsentVerificationResult])
  } else {
    $r = 'BadRequest'
  }
  [Console]::Out.WriteLine((@{ result = [string]$r } | ConvertTo-Json -Compress))
} catch {
  [Console]::Out.WriteLine((@{ result = 'HelperFailed' } | ConvertTo-Json -Compress))
}
