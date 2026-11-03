@echo off
title DOOD - team on Wi-Fi
cd /d "%~dp0"
echo.
echo  Starting DOOD for your team on the same Wi-Fi...
echo.

if not exist "node_modules" (
  echo  Not installed yet - please run Install-DOOD-Server.bat first.
  pause
  exit /b 1
)

rem Stop any older DOOD that is still running, so the new one starts cleanly.
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 3000,5173 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }" >nul 2>&1
timeout /t 2 /nobreak >nul

if not exist "apps\web\dist\index.html" (
  echo  Preparing the screens, about a minute...
  call npm run build
  if errorlevel 1 goto fail
)

set "PHONEIP="
for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "(Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway -ne $null } | Select-Object -First 1).IPv4Address.IPAddress"`) do set "PHONEIP=%%i"

start "DOOD - keep this window open" cmd /k "cd /d "%~dp0" && npm start"

echo.
echo  ==============================================================
echo   DOOD is starting. Wait about 10 seconds.
echo.
echo   On this computer      :  http://localhost:3000
if defined PHONEIP (
echo   Everyone else on Wi-Fi :  http://%PHONEIP%:3000
) else (
echo   Everyone else on Wi-Fi :  http://THIS-COMPUTER-IP:3000
)
echo.
echo   If others cannot open it, right-click Allow-DOOD-Firewall.bat
echo   and choose Run as administrator (once).
echo   To stop DOOD, close the black "DOOD" window.
echo  ==============================================================
echo.
timeout /t 8 /nobreak >nul
start "" "http://localhost:3000"
pause
exit /b 0

:fail
echo.
echo  Something went wrong. Take a photo of the message above.
pause
exit /b 1
