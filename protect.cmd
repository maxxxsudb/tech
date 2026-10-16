@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22+ is required.
  exit /b 1
)
if not exist "node_modules\javascript-obfuscator\package.json" (
  call npm ci --ignore-scripts --no-audit --no-fund
  if errorlevel 1 exit /b 1
)
node scripts\protect.cjs %*
exit /b %errorlevel%
