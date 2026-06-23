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