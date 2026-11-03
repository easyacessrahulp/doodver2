@echo off
title Allow DOOD through the Windows firewall
net session >nul 2>&1
if errorlevel 1 (
  echo.
  echo  Please right-click this file and choose "Run as administrator".
  pause
  exit /b 1
)
netsh advfirewall firewall delete rule name="DOOD 3000" >nul 2>&1
netsh advfirewall firewall add rule name="DOOD 3000" dir=in action=allow protocol=TCP localport=3000 profile=private,domain
echo.
echo  Done. Other computers and phones on your Wi-Fi can now open DOOD.
echo  (If your Wi-Fi is set to "Public" in Windows, change it to "Private" in Settings > Network.)
pause
