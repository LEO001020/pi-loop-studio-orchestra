@echo off
setlocal
cd /d "%~dp0"
"%~dp0.runtime\node-home\node.exe" "%~dp0scripts\install.mjs" --desktop
if errorlevel 1 (echo Installation failed. See validation receipts. & pause & exit /b 1)
echo Installation completed. Open Pi Loop Studio.cmd launches the application.
pause

