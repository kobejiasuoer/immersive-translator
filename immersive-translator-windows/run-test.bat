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
