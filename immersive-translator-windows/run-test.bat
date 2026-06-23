@echo off
chcp 65001 >nul
set "PATH=C:\Program Files\nodejs;C:\Users\022954\.cargo\bin;%PATH%"
cd /d "%~dp0"
echo [Test] Running unit tests...
echo.
call "C:\Program Files\nodejs\npm.cmd" test
echo.
pause >nul