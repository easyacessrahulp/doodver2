@echo off
title DOOD - link the OpenAI key
cd /d "%~dp0"
echo.
echo  Paste your OpenAI API key and press Enter.
echo  (Right-click in this window to paste.)
set "OAKEY="
set /p OAKEY= OpenAI key: 
if not defined OAKEY ( echo  Nothing entered - nothing changed. & pause & exit /b 1 )
(
echo OPENAI_API_KEY=%OAKEY%
echo OPENAI_MODEL=gpt-4o-mini
)> "apps\api\.env"
echo.
echo  Saved. Close the black DOOD window and start DOOD again with Start-DOOD-LAN.bat.
pause
