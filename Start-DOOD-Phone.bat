@echo off
title DOOD - phone mode
cd /d "%~dp0"
echo.
echo  Starting DOOD so your phone can open it on the same Wi-Fi...
echo.

if not exist "node_modules" (
  echo  First-time setup - installing. This takes a few minutes, please wait...
  call npm install
  if errorlevel 1 goto fail
)

start "DOOD API - keep this window open" cmd /k "cd /d "%~dp0" && npm start"
start "DOOD website for phone - keep this window open" cmd /k "cd /d "%~dp0" && npm run dev:web"

echo  Waiting for DOOD to start...
timeout /t 10 /nobreak >nul

set "PHONEIP="
for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "(Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway -ne $null } | Select-Object -First 1).IPv4Address.IPAddress"`) do set "PHONEIP=%%i"

echo.
echo  ==============================================================
echo   DOOD is running.
echo.
echo   On this computer :  http://localhost:5173
if defined PHONEIP (
echo   On your phone    :  http://%PHONEIP%:5173
) else (
echo   On your phone    :  see the line starting "Network:" in the
echo                       "website for phone" window
)
echo.
echo   Your phone must be on the same Wi-Fi as this computer.
echo   To stop DOOD, close the two black windows it opened.
echo  ==============================================================
echo.
start "" "http://localhost:5173"
pause
exit /b 0

:fail
echo.
echo  Something went wrong during setup. Take a photo of the message above.
pause
exit /b 1
