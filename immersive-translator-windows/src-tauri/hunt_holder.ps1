$ErrorActionPreference = "Continue"
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class Sus {
  [DllImport("ntdll.dll")] public static extern int NtSuspendProcess(IntPtr h);
  [DllImport("ntdll.dll")] public static extern int NtResumeProcess(IntPtr h);
  [DllImport("user32.dll")] public static extern bool OpenClipboard(IntPtr h);
  [DllImport("user32.dll")] public static extern bool CloseClipboard();
  [DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(int access, bool inherit, int pid);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
}
'@
function Test-Free([int]$n = 5) {
  $ok = 0
  for ($i = 0; $i -lt $n; $i++) {
    if ([Sus]::OpenClipboard([IntPtr]::Zero)) { $ok++; [Sus]::CloseClipboard() | Out-Null }
    Start-Sleep -Milliseconds 150
  }
  return $ok
}
$baseline = Test-Free
Write-Output ("baseline(before any suspend): ok=" + $baseline + "/5")

$suspects = @("Weixin", "WeChatAppEx", "wps", "WorkBuddy", "Clash Verge", "ChatGPT", "Apifox", "idea64", "sublime_text", "TextInputHost", "msedgewebview2", "ZCode")
foreach ($name in $suspects) {
  $procs = Get-Process -Name $name -ErrorAction SilentlyContinue
  if (-not $procs) { continue }
  $pids = @($procs | ForEach-Object { $_.Id })
  $pids = $pids | Select-Object -First 4
  $handles = @()
  foreach ($p in $pids) {
    $h = [Sus]::OpenProcess(0x1F0FFF, $false, $p)
    if ($h -ne [IntPtr]::Zero) {
      [Sus]::NtSuspendProcess($h) | Out-Null
      $handles += ,@($h, $p)
    }
  }
  if ($handles.Count -eq 0) { continue }
  Start-Sleep -Milliseconds 200
  $ok = Test-Free 5
  foreach ($pair in $handles) { [Sus]::NtResumeProcess($pair[0]) | Out-Null; [Sus]::CloseHandle($pair[0]) | Out-Null }
  $verdict = ""
  if ($ok -ge 4) { $verdict = "  *** CLIPBOARD FREED - CULPRIT FOUND ***" } elseif ($ok -ge 1) { $verdict = "  * partial free - suspicious" }
  Write-Output ("{0} (pid {1}) while suspended: ok={2}/5{3}" -f $name, ($pids -join ","), $ok, $verdict)
}
Write-Output "--- cbdhsvc (clipboard history service) ---"
$cb = Get-CimInstance Win32_Service -Filter "Name like 'cbdhsvc%'" -ErrorAction SilentlyContinue | Select-Object -First 1
if ($cb -and $cb.ProcessId -gt 0) {
  $h = [Sus]::OpenProcess(0x1F0FFF, $false, [int]$cb.ProcessId)
  if ($h -ne [IntPtr]::Zero) {
    [Sus]::NtSuspendProcess($h) | Out-Null
    Start-Sleep -Milliseconds 200
    $ok = Test-Free 5
    [Sus]::NtResumeProcess($h) | Out-Null; [Sus]::CloseHandle($h) | Out-Null
    $verdict = ""
    if ($ok -ge 4) { $verdict = "  *** CLIPBOARD FREED - CULPRIT FOUND ***" } elseif ($ok -ge 1) { $verdict = "  * partial free" }
    Write-Output ("cbdhsvc svchost (pid {0}) while suspended: ok={1}/5{2}" -f $cb.ProcessId, $ok, $verdict)
  } else { Write-Output ("cbdhsvc pid=" + $cb.ProcessId + " cannot open (access denied)") }
} else { Write-Output "cbdhsvc not found" }
$final = Test-Free
Write-Output ("final state: ok=" + $final + "/5")
