# 生成 CRLF 换行的 .bat 脚本，ASCII 文件名；运行时探测 npm，兼容官方安装、nvm 和 Scoop。
$ErrorActionPreference = "Stop"
$dir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path

# 运行脚本会先探测 PATH，再尝试官方安装目录；不依赖某台机器的用户路径。
$dev = @"
@echo off
setlocal
chcp 65001 >nul
set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"
where npm.cmd >nul 2>&1
if errorlevel 1 if exist "%ProgramFiles%\nodejs\npm.cmd" set "PATH=%ProgramFiles%\nodejs;%PATH%"
where npm.cmd >nul 2>&1
if errorlevel 1 (
    echo [FAIL] npm.cmd not found. Install Node.js 20+ or add it to PATH.
    pause >nul
    exit /b 1
)
cd /d "%~dp0"
echo [Start] Compiling and launching (first run ~1-2 min)...
echo.
call npm.cmd run tauri dev
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" (
    echo.
    echo [FAIL] App failed to start, see log above.
    pause >nul
    exit /b %EXIT_CODE%
)
echo.
echo [Done] App exited. Press any key to close.
pause >nul
exit /b %EXIT_CODE%
"@

$build = @"
@echo off
setlocal
chcp 65001 >nul
set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"
where npm.cmd >nul 2>&1
if errorlevel 1 if exist "%ProgramFiles%\nodejs\npm.cmd" set "PATH=%ProgramFiles%\nodejs;%PATH%"
where npm.cmd >nul 2>&1
if errorlevel 1 (
    echo [FAIL] npm.cmd not found. Install Node.js 20+ or add it to PATH.
    pause >nul
    exit /b 1
)
cd /d "%~dp0"
echo [Build] Generating release (first run ~5-10 min)...
echo.
call npm.cmd run tauri build
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" (
    echo.
    echo [FAIL] Build error, see log above.
    pause >nul
    exit /b %EXIT_CODE%
)
echo.
echo [OK] Build done! Installers in src-tauri\target\release\bundle\
explorer "src-tauri\target\release\bundle"
pause >nul
exit /b %EXIT_CODE%
"@

$test = @"
@echo off
setlocal
chcp 65001 >nul
set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"
where npm.cmd >nul 2>&1
if errorlevel 1 if exist "%ProgramFiles%\nodejs\npm.cmd" set "PATH=%ProgramFiles%\nodejs;%PATH%"
where npm.cmd >nul 2>&1
if errorlevel 1 (
    echo [FAIL] npm.cmd not found. Install Node.js 20+ or add it to PATH.
    pause >nul
    exit /b 1
)
cd /d "%~dp0"
echo [Test] Running unit tests...
echo.
call npm.cmd test
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" (
    echo.
    echo [FAIL] Tests failed, see log above.
    pause >nul
    exit /b %EXIT_CODE%
)
echo.
echo [OK] All tests passed.
pause >nul
exit /b %EXIT_CODE%
"@

$utf8 = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText("$dir\run-dev.bat", ($dev -replace '\r?\n', "`r`n"), $utf8)
[System.IO.File]::WriteAllText("$dir\run-build.bat", ($build -replace '\r?\n', "`r`n"), $utf8)
[System.IO.File]::WriteAllText("$dir\run-test.bat", ($test -replace '\r?\n', "`r`n"), $utf8)
Write-Output "Generated run-dev.bat / run-build.bat / run-test.bat (CRLF, npm PATH detection)"
