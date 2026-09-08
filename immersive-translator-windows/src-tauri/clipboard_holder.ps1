Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public class ClipProbe {
  [DllImport("user32.dll")] public static extern IntPtr GetOpenClipboardWindow();
  [DllImport("user32.dll")] public static extern IntPtr GetClipboardOwner();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern int GetWindowTextW(IntPtr h, [MarshalAs(UnmanagedType.LPWStr)] StringBuilder sb, int n);
  [DllImport("user32.dll")] public static extern int GetClassNameW(IntPtr h, [MarshalAs(UnmanagedType.LPWStr)] StringBuilder sb, int n);
  public static string Describe(IntPtr h) {
    if (h == IntPtr.Zero) return "";
    uint pid; GetWindowThreadProcessId(h, out pid);
    var t = new StringBuilder(256); GetWindowTextW(h, t, 256);
    var c = new StringBuilder(256); GetClassNameW(h, c, 256);
    return string.Format("hwnd={0} pid={1} class={2} title={3}", h, pid, c, t);
  }
}
'@
$deadline = (Get-Date).AddSeconds(10)
$openCount = 0
$holderStats = @{}
$ownerStats = @{}
while ((Get-Date) -lt $deadline) {
  $open = [ClipProbe]::GetOpenClipboardWindow()
  if ($open -ne [IntPtr]::Zero) {
    $openCount++
    $d = [ClipProbe]::Describe($open)
    if (-not $holderStats.ContainsKey($d)) { $holderStats[$d] = 0 }
    $holderStats[$d]++
  }
  $owner = [ClipProbe]::GetClipboardOwner()
  if ($owner -ne [IntPtr]::Zero) {
    $d = [ClipProbe]::Describe($owner)
    if (-not $ownerStats.ContainsKey($d)) { $ownerStats[$d] = 0 }
    $ownerStats[$d]++
  }
  Start-Sleep -Milliseconds 100
}
Write-Output ("samples: 100, open-held count: " + $openCount)
Write-Output "--- clipboard OPEN holders seen ---"
$holderStats.GetEnumerator() | Sort-Object Value -Descending | ForEach-Object { "{0} x{1}" -f $_.Value, $_.Key }
Write-Output "--- clipboard OWNERS seen (last writer) ---"
$ownerStats.GetEnumerator() | Sort-Object Value -Descending | Select-Object -First 5 | ForEach-Object { "{0} x{1}" -f $_.Value, $_.Key }
