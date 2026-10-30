@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-ai-hr.ps1"
if errorlevel 1 (
    echo.
    echo AI Recruiter setup failed. Check the error above.
    pause
) else (
    echo.
    echo AI Recruiter setup completed. Double-click start-ai-hr.bat to run.
    pause
)
endlocal
