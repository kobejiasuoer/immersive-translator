# 独立诊断 Windows 模拟输入。仅向本脚本创建的测试窗口发送按键，
# 不读写剪贴板、不修改现有文档、不调整终端防护策略、不调用翻译服务。
# 用法：powershell -NoProfile -File scripts/diagnose-selection-input.ps1
# 可选：-OutputPath C:\Temp\selection-input.json
param([string]$OutputPath)
$ErrorActionPreference = 'Stop'

if (-not ('SelectionInputDiagnostic' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;

public static class SelectionInputDiagnostic {
    [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT {
        public ushort vk, scan;
        public uint flags, time;
        public UIntPtr extra;
    }
    [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT {
        public int dx, dy;
        public uint data, flags, time;
        public UIntPtr extra;
    }
    [StructLayout(LayoutKind.Explicit)] struct INPUTDATA {
        [FieldOffset(0)] public KEYBDINPUT key;
        [FieldOffset(0)] public MOUSEINPUT mouse;
    }
    [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public INPUTDATA data; }
    [StructLayout(LayoutKind.Sequential)] struct POINT { public int x, y; }
    [StructLayout(LayoutKind.Sequential)] struct MSG {
        public IntPtr hwnd;
        public uint message;
        public UIntPtr wParam;
        public IntPtr lParam;
        public uint time;
        public POINT pt;
        public uint privateData;
    }
    [UnmanagedFunctionPointer(CallingConvention.Winapi)] delegate IntPtr WindowProc(IntPtr h, uint m, UIntPtr w, IntPtr l);
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct WNDCLASS {
        public uint style;
        public WindowProc proc;
        public int classExtra, windowExtra;
        public IntPtr instance, icon, cursor, background;
        public string menu, name;
    }
    public class Attempt {
        public string Mode;
        public int Requested;
        public uint Sent;
        public int LastError;
        public bool ForegroundVerified;
        public bool ForegroundStayed;
        public int KeyMessages;
        public bool Success;
    }
    [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern ushort RegisterClassW(ref WNDCLASS wc);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern bool UnregisterClassW(string name, IntPtr instance);
    [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateWindowExW(uint ex, string cls, string title, uint style, int x, int y, int w, int h, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr param);
    [DllImport("user32.dll")] static extern IntPtr DefWindowProcW(IntPtr h, uint m, UIntPtr w, IntPtr l);
    [DllImport("user32.dll")] static extern bool DestroyWindow(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr SetFocus(IntPtr h);
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll", SetLastError=true)] static extern uint SendInput(uint count, INPUT[] inputs, int size);
    [DllImport("user32.dll")] static extern bool PeekMessageW(out MSG msg, IntPtr h, uint min, uint max, uint remove);
    [DllImport("user32.dll")] static extern bool TranslateMessage(ref MSG msg);
    [DllImport("user32.dll")] static extern IntPtr DispatchMessageW(ref MSG msg);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern IntPtr GetModuleHandleW(string name);
    [DllImport("kernel32.dll")] static extern void SetLastError(uint error);
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr p, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetTokenInformation(IntPtr token, int kind, IntPtr buffer, int size, out int returned);
    [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);
    [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthority(IntPtr sid, uint index);

    static int received;
    static readonly WindowProc proc = HandleMessage;
    static IntPtr HandleMessage(IntPtr h, uint m, UIntPtr w, IntPtr l) {
        if (m == 0x100 || m == 0x101 || m == 0x104 || m == 0x105) received++;
        return DefWindowProcW(h, m, w, l);
    }
    static void Pump(int ms) {
        var timer = Stopwatch.StartNew();
        MSG msg;
        while (timer.ElapsedMilliseconds < ms) {
            while (PeekMessageW(out msg, IntPtr.Zero, 0, 0, 1)) {
                TranslateMessage(ref msg);
                DispatchMessageW(ref msg);
            }
            Thread.Sleep(5);
        }
    }
    static INPUT Key(ushort vk, ushort scan, uint flags) {
        var input = new INPUT();
        input.type = 1;
        input.data.key = new KEYBDINPUT { vk=vk, scan=scan, flags=flags };
        return input;
    }
    public static int InputSize { get { return Marshal.SizeOf(typeof(INPUT)); } }

    public static string Integrity(int pid) {
        IntPtr p = OpenProcess(0x1000, false, pid);
        if (p == IntPtr.Zero) return "unknown (OpenProcess failed)";
        try {
            IntPtr t;
            if (!OpenProcessToken(p, 8, out t)) return "unknown (OpenProcessToken failed)";
            try {
                int n;
                GetTokenInformation(t, 25, IntPtr.Zero, 0, out n);
                if (n <= 0) return "unknown (TokenIntegrityLevel failed)";
                IntPtr b = Marshal.AllocHGlobal(n);
                try {
                    if (!GetTokenInformation(t, 25, b, n, out n)) return "unknown (TokenIntegrityLevel failed)";
                    IntPtr sid = Marshal.ReadIntPtr(b);
                    byte count = Marshal.ReadByte(GetSidSubAuthorityCount(sid));
                    if (count == 0) return "unknown (invalid SID)";
                    int level = Marshal.ReadInt32(GetSidSubAuthority(sid, (uint)count - 1));
                    return "0x" + level.ToString("x");
                } finally { Marshal.FreeHGlobal(b); }
            } finally { CloseHandle(t); }
        } finally { CloseHandle(p); }
    }

    public static Attempt[] Run() {
        foreach (int key in new int[] {0x10,0x11,0x12,0x5B,0x5C,0x43,0x87}) {
            if (GetAsyncKeyState(key) < 0) throw new InvalidOperationException("Release keyboard keys before running this test.");
        }
        IntPtr previous = GetForegroundWindow();
        IntPtr instance = GetModuleHandleW(null);
        string name = "SelectionInputDiagnostic_" + Guid.NewGuid().ToString("N");
        var wc = new WNDCLASS { proc=proc, instance=instance, background=new IntPtr(6), name=name };
        if (RegisterClassW(ref wc) == 0) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        IntPtr window = IntPtr.Zero;
        try {
            window = CreateWindowExW(0x80, name, "Selection input diagnostic (closes automatically)", 0x10CF0000, 30, 30, 480, 120, IntPtr.Zero, IntPtr.Zero, instance, IntPtr.Zero);
            if (window == IntPtr.Zero) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            SetForegroundWindow(window);
            SetFocus(window);
            Pump(150);
            var results = new List<Attempt>();
            Console.WriteLine("Please click the diagnostic window within 90 seconds. No existing documents or clipboard data will be touched.");
            var wait = Stopwatch.StartNew();
            while (wait.Elapsed < TimeSpan.FromSeconds(90) && GetForegroundWindow() != window) Thread.Sleep(100);
            if (GetForegroundWindow() != window) {
                results.Add(new Attempt {Mode="Foreground prerequisite", ForegroundVerified=false, Success=false});
                return results.ToArray();
            }
            Pump(100);
            foreach (var test in new Tuple<string, bool>[] { Tuple.Create("Ctrl+C virtual keys", false), Tuple.Create("Ctrl+C scan codes", true) }) {
                string mode = test.Item1;
                bool scan = test.Item2;
                if (GetForegroundWindow() != window) {
                    SetForegroundWindow(window);
                    Pump(100);
                }
                INPUT[] inputs = scan
                    ? new INPUT[] {Key(0,0x1d,8), Key(0,0x2e,8), Key(0,0x2e,10), Key(0,0x1d,10)}
                    : new INPUT[] {Key(0x11,0,0), Key(0x43,0,0), Key(0x43,0,2), Key(0x11,0,2)};
                var result = new Attempt {Mode=mode, Requested=inputs.Length, ForegroundVerified=GetForegroundWindow()==window};
                results.Add(result);
                if (!result.ForegroundVerified) break;
                received = 0;
                SetLastError(0);
                result.Sent = SendInput((uint)inputs.Length, inputs, InputSize);
                result.LastError = Marshal.GetLastWin32Error();
                if (result.Sent > 0 && result.Sent < inputs.Length) {
                    INPUT[] releases = mode == "F24 control test"
                        ? new INPUT[] {inputs[1]}
                        : new INPUT[] {inputs[2], inputs[3]};
                    SendInput((uint)releases.Length, releases, InputSize);
                }
                Pump(250);
                result.ForegroundStayed = GetForegroundWindow() == window;
                result.KeyMessages = received;
                result.Success = result.ForegroundVerified && result.Sent == inputs.Length && result.KeyMessages == inputs.Length;
            }
            return results.ToArray();
        } finally {
            bool restore = window != IntPtr.Zero && GetForegroundWindow() == window;
            if (window != IntPtr.Zero) DestroyWindow(window);
            if (restore && previous != IntPtr.Zero) SetForegroundWindow(previous);
            UnregisterClassW(name, instance);
        }
    }
}
'@
}

$processes = @(Get-Process -Id $PID)
$processes += @(Get-Process -Name immersive-translator-windows,idea64,chrome,sublime_text -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 })
$metadata = @($processes | ForEach-Object {
    $signature = if ($_.ProcessName -eq 'immersive-translator-windows' -and (Test-Path -LiteralPath $_.Path)) {
        Get-AuthenticodeSignature -LiteralPath $_.Path
    }
    $hash = if ($_.ProcessName -eq 'immersive-translator-windows' -and (Test-Path -LiteralPath $_.Path)) {
        (Get-FileHash -Algorithm SHA256 -LiteralPath $_.Path).Hash
    }
    [pscustomobject]@{
        Name = $_.ProcessName
        Pid = $_.Id
        Session = $_.SessionId
        Integrity = [SelectionInputDiagnostic]::Integrity($_.Id)
        Executable = $_.Path
        Signature = if ($signature) { $signature.Status.ToString() } else { $null }
        Signer = if ($signature -and $signature.SignerCertificate) { $signature.SignerCertificate.Subject } else { $null }
        Sha256 = $hash
    }
})
$results = [SelectionInputDiagnostic]::Run()
$securityProducts = @(Get-CimInstance -Namespace root/SecurityCenter2 -ClassName AntivirusProduct -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty displayName -Unique)
$report = [pscustomobject]@{
    Time = [DateTimeOffset]::Now.ToString('o')
    ProcessBits = [IntPtr]::Size * 8
    InputStructBytes = [SelectionInputDiagnostic]::InputSize
    Processes = $metadata
    Attempts = $results
    RegisteredSecurityProducts = $securityProducts
    Note = 'LastError=0 does not identify the cause; invalid foreground makes the test inconclusive. This test never accesses the clipboard.'
}
$json = $report | ConvertTo-Json -Depth 6
if ($OutputPath) {
    [IO.File]::WriteAllText([IO.Path]::GetFullPath($OutputPath), $json, (New-Object Text.UTF8Encoding($false)))
}
$json
if (@($results | Where-Object { -not $_.Success }).Count -gt 0) { exit 1 }
