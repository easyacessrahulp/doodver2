@echo off
title DOOD - first-time install on the server
cd /d "%~dp0"
echo.
echo  ==============================================================
echo   DOOD first-time install  (brand-new, empty database)
echo  ==============================================================
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo  Node.js is not installed on this computer.
  echo  1. Open  https://nodejs.org  and download the LTS version ^(22 or newer^).
  echo  2. Install it with all the default options.
  echo  3. Restart the computer, then double-click this file again.
  pause
  exit /b 1
)

echo  Step 1 of 4: installing parts (a few minutes, please wait)...
call npm install
if errorlevel 1 goto fail

echo.
echo  Step 2 of 4: preparing the screens...
call npm run build
if errorlevel 1 goto fail

echo.
echo  Step 3 of 4: letting other computers on your Wi-Fi reach DOOD...
net session >nul 2>&1
if errorlevel 1 (
  echo  ^(Skipped - not run as administrator. If others cannot open DOOD later,
  echo   right-click Allow-DOOD-Firewall.bat and choose Run as administrator.^)
) else (
  netsh advfirewall firewall delete rule name="DOOD 3000" >nul 2>&1
  netsh advfirewall firewall add rule name="DOOD 3000" dir=in action=allow protocol=TCP localport=3000 profile=private,domain >nul
  echo  Done.
)

if exist "apps\api\.env" goto haveenv
echo.
echo  ==============================================================
echo   AI link ^(OpenAI^)
echo   Paste your OpenAI API key below and press Enter.
echo   ^(Right-click in this window to paste. Press Enter alone to skip -
echo    DOOD works without AI and you can add the key later.^)
echo  ==============================================================
set "OAKEY="
set /p OAKEY= OpenAI key: 
(
echo OPENAI_API_KEY=%OAKEY%
echo OPENAI_MODEL=gpt-4o-mini
)> "apps\api\.env"
if defined OAKEY ( echo  AI link saved. ) else ( echo  Skipped - no AI for now. )
:haveenv

echo.
echo  Step 4 of 4: starting DOOD...
call "%~dp0Start-DOOD-LAN.bat"
exit /b 0

:fail
echo.
echo  Something went wrong. Take a photo of the message above and send it to me.
pause
exit /b 1
