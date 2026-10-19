@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-ai-hr.ps1"
if errorlevel 1 (
    echo.
    echo AI Recruiter failed to start. Check the error above.
    pause
)
endlocal
