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
