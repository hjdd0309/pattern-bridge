@echo off
setlocal
cd /d "%~dp0"

echo [Pattern Bridge] Starting...

:: -- 1. Check PM2 installation --
where pm2 >nul 2>&1
if errorlevel 1 (
    echo [setup] PM2 not found. Installing globally...
    call npm install -g pm2
    if errorlevel 1 (
        echo [error] Failed to install PM2. Make sure Node.js is installed.
        pause
        exit /b 1
    )
    echo [setup] PM2 installed.
)

:: -- 2. Check if pattern-bridge is registered in PM2 --
pm2 list 2>nul | findstr "pattern-bridge" >nul 2>&1
if errorlevel 1 (
    echo [setup] First run: registering collector with PM2...
    pm2 start ecosystem.config.cjs
    if errorlevel 1 (
        echo [error] pm2 start failed. Check ecosystem.config.cjs
        pause
        exit /b 1
    )
    pm2 save
    echo [setup] Collector is now running in the background.
) else (
    echo [ok] PM2 collector already registered.
)

:: -- 3. Launch Electron UI directly --
echo [ok] Opening Pattern Bridge UI...
node_modules\electron\dist\electron.exe src\ui\main.cjs

endlocal