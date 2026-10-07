@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo Server can cai Node.js 20 tro len. Cai Node.js, sau do chay lai file nay.
  pause
  exit /b 1
)

if not exist "node_modules\dotenv\package.json" (
  echo Dang cai thu vien...
  call npm.cmd ci --omit=dev --ignore-scripts --no-audit --no-fund
  if errorlevel 1 (
    pause
    exit /b 1
  )
)

if not exist ".env" (
  if not defined OPENAI_API_KEY (
    copy /y ".env.example" ".env" >nul
    echo Da tao file .env mau. Dien OPENAI_API_KEY va PUBLIC_BASE_URL vao file .env.
  )
)

node scripts\check-server.mjs
if errorlevel 1 (
  pause
  exit /b 1
)

echo Mo /operator.html de dieu khien, /listen.html de nghe va hien phu de.
echo Giu cua so nay mo. Nhan Ctrl+C de dung server.
node server.mjs
pause
