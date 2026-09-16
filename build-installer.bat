@echo off
chcp 65001 >nul
title StockDesk v1.9.3 - 打包 Windows 安装器
cd /d "%~dp0"

echo [1/3] 检查开发依赖...
if not exist "node_modules\.bin\electron.cmd" (
    call npm install --include=dev --no-audit --no-fund
    if errorlevel 1 ( echo 安装依赖失败 & pause & exit /b 1 )
)
if not exist "node_modules\.bin\electron-builder.cmd" (
    call npm install --include=dev --no-audit --no-fund
    if errorlevel 1 ( echo electron-builder 安装失败 & pause & exit /b 1 )
)

echo [2/3] 离线检查...
call npm run test:release
if errorlevel 1 ( echo 核心检查失败 & pause & exit /b 1 )

echo [3/3] 打包 NSIS + portable...
call npm run dist
if errorlevel 1 (
    echo.
    echo 打包失败。如网络受限，可在当前 CMD 先执行：
    echo   set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
    echo   set ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
    echo 再重试。
    pause
    exit /b 1
)

echo 完成，产物位于 build\dist\
dir /b build\dist\*.exe 2>nul
pause
