@echo off
setlocal
cd /d "%~dp0"
"%~dp0.runtime\node-home\node.exe" "%~dp0scripts\stop.mjs"
if errorlevel 1 (echo Graceful stop failed. No unrelated process was killed. & pause & exit /b 1)
