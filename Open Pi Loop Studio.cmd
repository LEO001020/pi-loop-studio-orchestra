@echo off
setlocal
cd /d "%~dp0"
"%~dp0.runtime\node-home\node.exe" "%~dp0scripts\launch.mjs"
if errorlevel 1 (echo Launch failed. See .local\last-launch.json and .local\server.stderr.log. & pause & exit /b 1)

