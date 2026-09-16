@echo off
chcp 65001 >nul
title StockDesk v1.9.3 - 离线检查
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo 未检测到 Node.js，请先安装 Node.js 20+。
  pause
  exit /b 1
)
call npm run test:release
pause
