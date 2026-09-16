@echo off
chcp 65001 >nul
title StockDesk v1.9.3 - 一键安装
setlocal
cd /d "%~dp0"

echo.
echo  ============================================
echo       StockDesk v1.9.3 - 一键安装程序
echo  ============================================
echo.

where node >nul 2>&1
if errorlevel 1 (
    echo [错误] 未检测到 Node.js。
    echo 请先安装 Node.js 20+，建议 22+：https://nodejs.org/
    pause
    exit /b 1
)

echo [1/3] 安装 Electron / electron-builder 等开发依赖...
call npm install --include=dev --no-audit --no-fund
if errorlevel 1 (
    echo.
    echo [错误] 依赖安装失败。
    echo 国内网络可先执行：
    echo   npm config set registry https://registry.npmmirror.com
    echo   set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
    pause
    exit /b 1
)

if not exist "node_modules\.bin\electron.cmd" (
    echo [错误] npm 已结束，但 Electron 未正确安装。
    echo 请检查 npm config get omit 是否为 dev；如是，请执行 npm config delete omit 后重试。
    pause
    exit /b 1
)

echo [2/3] 运行离线核心检查...
call npm run check
if errorlevel 1 (
    echo [错误] 核心检查未通过，请不要继续安装。
    pause
    exit /b 1
)

echo [3/3] 创建桌面快捷方式...
powershell -NoProfile -Command ^
  "$ws = New-Object -ComObject WScript.Shell; $desktop = [Environment]::GetFolderPath('Desktop'); $lnk = $ws.CreateShortcut(\"$desktop\StockDesk盯盘.lnk\"); $lnk.TargetPath = '%~dp0start.bat'; $lnk.WorkingDirectory = '%~dp0'; $lnk.IconLocation = '%~dp0renderer\assets\icon.png,0'; $lnk.Save()" 2>nul

echo.
echo [完成] StockDesk v1.9.3 已准备好。
echo 双击 start.bat 或桌面 StockDesk盯盘 快捷方式启动。
echo.
pause
