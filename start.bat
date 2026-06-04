@echo off
cd /d %~dp0
title AutoTrade KR Server
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Install from https://nodejs.org
  pause
  exit /b 1
)
echo ==============================================
echo  AutoTrade KR  -  http://localhost:3000
echo  Auto-restart on crash. Close window to stop.
echo ==============================================
:loop
node proxy-server.js
echo.
echo [WARN] Server stopped. Restarting in 3 seconds...
timeout /t 3 /nobreak >nul
goto loop
