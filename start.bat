@echo off
chcp 65001 >nul
title StockDesk v1.9.3 盯盘
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
    echo [错误] 未检测到 Node.js，请先安装 Node.js 20+（建议 22+）。
    pause
    exit /b 1
)

if not exist "node_modules\.bin\electron.cmd" (
    echo [StockDesk] 未检测到本地 Electron，正在安装开发依赖...
    call npm install --include=dev --no-audit --no-fund
    if errorlevel 1 (
        echo.
        echo [错误] 依赖安装失败。
        echo 可尝试：
        echo   npm config set registry https://registry.npmmirror.com
        echo   set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
        echo 然后重新运行 start.bat
        pause
        exit /b 1
    )
)

call npm start
