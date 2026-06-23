@echo off
chcp 65001 >nul
REM ============================================================
REM  ImmersiveTranslator 单元测试脚本（双击运行）
REM ============================================================

set "PATH=C:\Program Files\nodejs;C:\Users\022954\.cargo\bin;%PATH%"

cd /d "%~dp0"
echo [测试] 运行核心逻辑单元测试...
echo.
call npm test
echo.
pause >nul
