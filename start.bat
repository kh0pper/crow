@echo off
:: Crow AI Platform — Windows Launcher
:: Double-click this file to start the setup wizard.

cd /d "%~dp0"

echo.
echo =================================================
echo    Crow AI Platform
echo =================================================
echo.

:: Check for Node.js
where node >nul 2>nul
if errorlevel 1 (
  echo   Node.js is required but not installed.
  echo.
  echo   Opening the Node.js download page...
  echo   Install Node.js, then double-click this file again.
  echo.
  start https://nodejs.org
  pause
  exit /b 1
)

for /f "tokens=1 delims=." %%a in ('node -v') do set NODE_VER=%%a
set NODE_VER=%NODE_VER:v=%
if %NODE_VER% LSS 18 (
  echo   Node.js is too old. Need version 18 or newer.
  echo   Opening the Node.js download page...
  start https://nodejs.org
  pause
  exit /b 1
)

echo   Node.js found — OK

:: Install dependencies if needed
if not exist "node_modules" (
  echo   Installing dependencies (first run only^)...
  npm install --silent
)

:: Initialize database if needed
if not exist "data\crow.db" (
  echo   Initializing database...
  node scripts\init-db.js
)

:: Open the setup wizard
echo.
echo   Opening setup wizard in your browser...
echo   If it doesn't open, go to: http://localhost:3456
echo.
echo   Close this window when you're done with setup.
echo.

start http://localhost:3456
node scripts\wizard-web.js
