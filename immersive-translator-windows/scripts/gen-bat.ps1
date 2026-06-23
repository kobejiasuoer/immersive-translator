# 生成 CRLF 换行的 .bat 脚本，文件名用纯 ASCII 避免编码问题
$ErrorActionPreference = "Stop"
$dir = "D:\workspace\immersive-translator-macos\immersive-translator-windows"

# 先删除旧的中文命名 bat（用通配，避免在脚本里写中文字面量）
Get-ChildItem -Path $dir -Filter "*.bat" | Where-Object { $_.Name -notmatch '^[A-Za-z0-9._-]+$' } | Remove-Item -Force

$dev = @"
@echo off
chcp 65001 >nul
REM ImmersiveTranslator dev launcher
set ""PATH=C:\Program Files\nodejs;C:\Users\022954\.cargo\bin;%PATH%""
cd /d ""%~dp0""
echo [Start] Compiling and launching (first run ~1-2 min)...
echo.
call npm run tauri dev
echo.
echo [Done] App exited. Press any key to close.
pause >nul
"@

$build = @"
@echo off
chcp 65001 >nul
REM ImmersiveTranslator build launcher
set ""PATH=C:\Program Files\nodejs;C:\Users\022954\.cargo\bin;%PATH%""
cd /d ""%~dp0""
echo [Build] Generating release (first run ~5-10 min)...
echo.
call npm run tauri build
if errorlevel 1 (
    echo.
    echo [FAIL] Build error, see log above.
    pause >nul
    exit /b 1
)
echo.
echo [OK] Build done! Installers in src-tauri\target\release\bundle\
explorer ""src-tauri\target\release\bundle""
pause >nul
"@

$test = @"
@echo off
chcp 65001 >nul
REM ImmersiveTranslator test launcher
set ""PATH=C:\Program Files\nodejs;C:\Users\022954\.cargo\bin;%PATH%""
cd /d ""%~dp0""
echo [Test] Running unit tests...
echo.
call npm test
echo.
pause >nul
"@

$utf8 = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText("$dir\run-dev.bat", ($dev -replace "`n", "`r`n"), $utf8)
[System.IO.File]::WriteAllText("$dir\run-build.bat", ($build -replace "`n", "`r`n"), $utf8)
[System.IO.File]::WriteAllText("$dir\run-test.bat", ($test -replace "`n", "`r`n"), $utf8)
Write-Output "Generated run-dev.bat / run-build.bat / run-test.bat (CRLF, ASCII names)"
