# 端到端验证「默认热键被占用时应用仍能完成启动」（PowerShell 5.1，无需管理员）。
#
# 场景：Ctrl+Shift+Q/E/R 被 RegisterHotKey 抢占后，修复前的 setup 会把
# on_shortcut 的 Err 用 ? 抛给 run() 末尾的 expect，release 构建双击秒退；
# 修复后应用记 [hotkey] 日志继续启动。
#
# 步骤：清场 → 本脚本 P/Invoke 预占三个默认热键 → 启动 release exe → 等 8 秒
# → 断言进程仍存活 → 断言 selection.log 出现新的 [hotkey] 行 → 清理。
# 全过 exit 0 输出 PASS；任一步失败 exit 1 并说明原因。
# 用法：powershell -NoProfile -File scripts/verify-hotkey-conflict.ps1
$ErrorActionPreference = 'Stop'

$exe = Join-Path $PSScriptRoot '..\src-tauri\target\release\immersive-translator-windows.exe'
$log = Join-Path $env:APPDATA 'com.immersivetranslator.windows\selection.log'

function Fail([string]$reason) {
    Write-Host "FAIL: $reason"
    exit 1
}

if (-not (Test-Path $exe)) {
    Fail "release exe 不存在：$exe（先 cargo build --release --features custom-protocol）"
}

# 清场：杀掉已运行实例，避免旧进程（已注册默认热键、已在写日志）干扰断言
Get-Process -Name 'immersive-translator-windows' -ErrorAction SilentlyContinue |
    Stop-Process -Force
Start-Sleep -Milliseconds 500

# 注意：PS 5.1 的 Add-Type 编译 C# 没有隐式 using，IntPtr 需要 using System（漏掉即 CS0246）
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class HotkeyPin {
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool UnregisterHotKey(IntPtr hWnd, int id);
}
'@

# MOD_CONTROL=2 | MOD_SHIFT=4；VK 与 lib.rs 默认三键一致：Q=0x51 E=0x45 R=0x52
$mods = 2 -bor 4
$keys = @(
    @{ id = 1; vk = 0x51; name = 'Ctrl+Shift+Q' },
    @{ id = 2; vk = 0x45; name = 'Ctrl+Shift+E' },
    @{ id = 3; vk = 0x52; name = 'Ctrl+Shift+R' }
)

$proc = $null
try {
    # 预占热键：被本进程持有 → 被测应用的 RegisterHotKey 必然失败。
    # 预占本身失败说明键已被其它软件占住，冲突场景同样成立，警告后继续。
    foreach ($k in $keys) {
        $ok = [HotkeyPin]::RegisterHotKey([IntPtr]::Zero, $k.id, $mods, $k.vk)
        if (-not $ok) {
            Write-Host "WARN: 预占 $($k.name) 失败（该键已被其它软件占用），冲突场景仍成立"
        }
    }

    # 记住日志现有行数，之后只断言新增行（避免历史 [hotkey] 行造成假阳性）
    $linesBefore = 0
    if (Test-Path $log) {
        $linesBefore = @(Get-Content -LiteralPath $log -Encoding UTF8).Count
    }

    $proc = Start-Process -FilePath $exe -PassThru
    Start-Sleep -Seconds 8

    # 断言 1：进程仍存活（修复前 setup panic → 秒退）
    if ($proc.HasExited) {
        Fail "应用启动后 8 秒内退出（ExitCode=$($proc.ExitCode)）——热键冲突导致启动失败"
    }

    # 断言 2：selection.log 尾部出现新的 [hotkey] 行（降级分支确实走到了）
    if (-not (Test-Path $log)) {
        Fail "selection.log 不存在：$log（应用没写 [hotkey] 冲突日志）"
    }
    $all = @(Get-Content -LiteralPath $log -Encoding UTF8)
    $newLines = @($all | Select-Object -Skip $linesBefore)
    # 用 .Contains 而非 -like：方括号是通配符特殊字符
    $hotkeyLines = @($newLines | Where-Object { $_.Contains('[hotkey]') })
    if ($hotkeyLines.Count -eq 0) {
        Fail "selection.log 尾部没有新的 [hotkey] 行（新增 $($newLines.Count) 行均不含标记）"
    }

    Write-Host 'PASS: 热键被占用时应用仍存活，且记录了冲突日志：'
    $hotkeyLines | ForEach-Object { Write-Host "  $_" }
    exit 0
}
catch {
    Fail "脚本异常：$($_.Exception.Message)"
}
finally {
    # 清理：杀被测进程 + 释放预占热键（进程退出也会释放，显式做幂等兜底）
    if ($proc -and -not $proc.HasExited) {
        Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    }
    foreach ($k in $keys) {
        [void][HotkeyPin]::UnregisterHotKey([IntPtr]::Zero, $k.id)
    }
}
