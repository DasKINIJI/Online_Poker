@echo off
rem Startet den Poker-Server und oeffnet die WebApp im Browser - einfach doppelklicken.
rem Anderer Port: in der Eingabeaufforderung "set PORT=4000" eingeben, dann start.bat
cd /d "%~dp0"
if not defined PORT set PORT=3000
set URL=http://localhost:%PORT%
rem Discord-Webhook fuer den P/L-Export (geheim halten)
if not defined DISCORD_WEBHOOK set DISCORD_WEBHOOK=https://discord.com/api/webhooks/1562855465858244659/zuZ-DHEwrxHKSRnQzIbiUZnJ7aHVnOBn4WqUzMNHFdgwcEk_2Zbnh9xC_i2C1BDQIQsA

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js fehlt - bitte installieren: https://nodejs.org
  start "" https://nodejs.org
  pause
  exit /b 1
)
if not exist "node_modules\ws" (
  echo Installiere Abhaengigkeiten ...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    pause
    exit /b 1
  )
)

rem Browser oeffnen, sobald der Server antwortet (max. 10 s)
start "" /min powershell -NoProfile -WindowStyle Hidden -Command "for($i=0;$i -lt 50;$i++){try{Invoke-WebRequest -UseBasicParsing '%URL%' -TimeoutSec 1 | Out-Null; break}catch{Start-Sleep -Milliseconds 200}}; Start-Process '%URL%'"

echo Poker laeuft auf %URL%  -  Mitspieler im WLAN: http://^<deine-IP^>:%PORT%  -  Beenden: dieses Fenster schliessen
node server.js
echo.
echo Server wurde beendet (Port %PORT% schon belegt?).
pause
