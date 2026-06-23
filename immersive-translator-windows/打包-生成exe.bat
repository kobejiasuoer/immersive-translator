@echo off
chcp 65001 >nul
REM ============================================================
REM  ImmersiveTranslator 打包脚本（双击运行）
REM  作用：生成独立 exe 安装包到 src-tauri\target\release\bundle\
REM  首次打包约 5-10 分钟
REM ============================================================

set "PATH=C:\Program Files\nodejs;C:\Users\022954\.cargo\bin;%PATH%"

cd /d "%~dp0"
echo [打包] 开始生成发布版本（Release，首次约 5-10 分钟）...
echo.
call npm run tauri build
if errorlevel 1 (
    echo.
    echo [失败] 打包出错，请看上方日志。
    pause >nul
    exit /b 1
)
echo.
echo [完成] 打包成功！安装包位于：
echo   src-tauri\target\release\bundle\
echo.
explorer "src-tauri\target\release\bundle"
pause >nul
