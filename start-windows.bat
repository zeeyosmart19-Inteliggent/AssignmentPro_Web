@echo off
cd /d "%~dp0"
where py >nul 2>nul && (py -3 serve.py & goto :end)
where python >nul 2>nul && (python serve.py & goto :end)
echo Python 3 is needed. Install it from https://www.python.org/downloads/ and run this again.
:end
pause
