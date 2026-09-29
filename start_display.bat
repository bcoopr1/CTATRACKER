@echo off
rem Starts the CTA commute display: the tracker server plus a full-screen browser.
rem   start_display.bat          live data (needs .env key and routes in config.json)
rem   start_display.bat --demo   simulated buses
cd /d "%~dp0"

set PORT=8095
for /f %%p in ('python -c "import tracker; print(tracker.load_config()['port'])"') do set PORT=%%p

start "CTA commute server" /min python server.py %*
timeout /t 3 /nobreak >nul

rem A separate profile makes Edge honor --kiosk even if Edge is already open. Alt+F4 exits.
start "" msedge --kiosk "http://localhost:%PORT%/" --edge-kiosk-type=fullscreen --no-first-run --user-data-dir="%LOCALAPPDATA%\CommuteControlKiosk"
