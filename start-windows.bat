@echo off
cd /d "%~dp0"
where node >nul 2>nul && (node server.mjs & goto :end)
where py >nul 2>nul && (echo Node.js not found - starting SINGLE-DEVICE mode. Install Node 20+ from https://nodejs.org for the shared server. & py -3 serve.py & goto :end)
echo Please install Node.js 20+ from https://nodejs.org and run this again.
:end
pause
