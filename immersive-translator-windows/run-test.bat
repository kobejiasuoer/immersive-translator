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