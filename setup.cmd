@echo off
title AIVault setup
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed.
  echo Install it with:  winget install OpenJS.NodeJS.LTS
  echo or download it from https://nodejs.org  then run setup.cmd again.
  pause
  exit /b 1
)
node engine\cli.mjs setup %*
echo.
pause
