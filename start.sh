#!/usr/bin/env bash
# Startet den Poker-Server und öffnet die WebApp im Browser.  Port ändern: PORT=4000 ./start.sh
cd "$(dirname "$0")" || exit 1
PORT="${PORT:-3000}"; URL="http://localhost:$PORT"

command -v node >/dev/null || { echo "Node.js fehlt – bitte installieren: https://nodejs.org"; exit 1; }
[ -d node_modules/ws ] || { echo "Installiere Abhängigkeiten …"; npm install --no-audit --no-fund || exit 1; }

PORT="$PORT" node server.js & SRV=$!
trap 'kill $SRV 2>/dev/null' EXIT INT TERM

# warten, bis der Server antwortet (max. 10 s)
for i in $(seq 1 50); do
  node -e "require('http').get('$URL',()=>process.exit(0)).on('error',()=>process.exit(1))" && break
  kill -0 $SRV 2>/dev/null || { echo "Server konnte nicht starten (Port $PORT belegt?)"; exit 1; }
  sleep 0.2
done

echo "Poker läuft auf $URL  –  Mitspieler im WLAN: http://<deine-IP>:$PORT  –  Beenden mit Strg+C"
if command -v open >/dev/null && [ "$(uname)" = Darwin ]; then open "$URL"
elif command -v explorer.exe >/dev/null; then explorer.exe "$URL"   # Windows (Git Bash / WSL) – kein "cmd /c": Git Bash würde /c in einen Pfad umschreiben
elif command -v xdg-open >/dev/null; then xdg-open "$URL" >/dev/null 2>&1
else echo "Bitte $URL im Browser öffnen."; fi
wait $SRV
