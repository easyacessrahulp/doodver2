@echo off
title DOOD - update database safely
cd /d "%~dp0"
echo.
echo  This makes a backup of your data first, then updates the database.
echo  Nothing is deleted. Close DOOD before running this.
echo.
if not exist "node_modules" (
  echo  Not installed yet - please run Install-DOOD-Server.bat first.
  pause
  exit /b 1
)
call npm run update-db
echo.
pause
