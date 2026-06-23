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