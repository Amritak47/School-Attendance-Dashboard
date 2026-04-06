@echo off
title Moil Primary Attendance System
echo.
echo  ================================================
echo   Moil Primary School - Attendance System
echo   Starting up...
echo  ================================================
echo.

REM Install dependencies if needed
pip install -r requirements.txt --quiet

echo  Opening in your browser at http://localhost:5000
echo  Press Ctrl+C to stop the server
echo.

REM Open browser after 2 seconds
start /b cmd /c "timeout /t 2 >nul && start http://localhost:5000"

REM Start Flask app
python app.py

pause
