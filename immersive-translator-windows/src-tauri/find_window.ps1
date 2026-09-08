param([string]$Keyword)
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Collections.Generic;
public class WFind {
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lp);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern int GetWindowTextW(IntPtr h, [MarshalAs(UnmanagedType.LPWStr)] StringBuilder sb, int max);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  delegate bool EnumWindowsProc(IntPtr h, IntPtr lp);
  public static List<string> Find(string kw) {
    var result = new List<string>();
    EnumWindows((h, lp) => {
      var t = new StringBuilder(256); GetWindowTextW(h, t, 256);
      uint pid; GetWindowThreadProcessId(h, out pid);
      var title = t.ToString();
      if (title.IndexOf(kw, StringComparison.OrdinalIgnoreCase) >= 0) {
        result.Add(string.Format("{0}|pid={1}|visible={2}|{3}", h, pid, IsWindowVisible(h), title));
      }
      return true;
    }, IntPtr.Zero);
    return result;
  }
}
'@
[WFind]::Find($Keyword) | ForEach-Object { $_ }
