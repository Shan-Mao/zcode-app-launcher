@echo off
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo 未找到 Node.js。请先安装 Node.js 18+：https://nodejs.org/
  echo.
  pause
  exit /b 1
)

node "%~dp0install.mjs"
echo.
pause
