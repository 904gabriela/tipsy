@echo off
title Tipsy
cd /d "%~dp0"
echo.
echo   Starting Tipsy. Leave this window open while you use it.
echo   Close it when you are done.
echo.
node server.js
if errorlevel 1 (
  echo.
  echo   Something went wrong. Send the text above to Claude.
  pause
)
