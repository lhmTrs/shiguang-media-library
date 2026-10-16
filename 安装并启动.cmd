@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 请先安装 Node.js 22.x：https://nodejs.org/en/download/archive/v22
  pause
  exit /b 1
)
node scripts/setup.mjs --start
if errorlevel 1 pause
