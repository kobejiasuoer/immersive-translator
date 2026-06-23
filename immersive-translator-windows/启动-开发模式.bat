@echo off
chcp 65001 >nul
REM ============================================================
REM  ImmersiveTranslator 开发模式启动脚本（双击运行）
REM  作用：临时把 Node/Rust 加入 PATH，启动 tauri dev
REM  关闭窗口即退出应用
REM ============================================================

set "PATH=C:\Program Files\nodejs;C:\Users\022954\.cargo\bin;%PATH%"

cd /d "%~dp0"
echo [启动] 编译并启动应用（首次约 1-2 分钟，请耐心等待）...
echo.
call npm run tauri dev
echo.
echo [结束] 应用已退出。按任意键关闭本窗口。
pause >nul
