# Online_Poker

Ein selbst gehosteter **Texas-Hold'em-Pokertisch im Browser** für private Runden. Der Server ist in Node.js geschrieben und verbindet alle Mitspieler per WebSocket in Echtzeit. Die gesamte Oberfläche steckt in einer einzigen `index.html`. Die Hole Cards eines Spielers schickt der Server nur an diesen Spieler. Für alle sichtbar werden sie erst beim Showdown oder bei der 7-2-Aufdeckung.

> Die App hat **keine Anmeldung und kein Passwort**. Wer die URL kennt, kann zusehen, einen Namen aus der Spielerliste wählen und neue Namen anlegen. Gib die Adresse deshalb nur an Mitspieler weiter oder schütze sie zusätzlich, zum Beispiel per Basic-Auth in Caddy.

## Funktionen

**Spiel**
- No-Limit Texas Hold'em mit bis zu 9 Spielern. Weitere Besucher sehen als Zuschauer zu.
- Die Big Blind ergibt sich aus dem Buy-in des ersten Spielers, sodass der Startstack 100 BB beträgt. Alle Beträge werden in Euro in 5-Cent-Schritten geführt.
- Straddle und Re-Straddle mit 10-Sekunden-Phase sowie Blind Call gegen einen All-in-Straddle.
- *Run it Twice / Three Times*: Bei einem All-in stimmen die beteiligten Spieler ab, wie oft das Board ausgeteilt wird.
- *Sweat*: All-in-Spieler decken ihre Karte selbst langsam auf, per Maus oder Wischen.
- *Rabbit Hunt*: Nach der Hand lassen sich die nicht ausgeteilten Board-Karten ansehen.
- Optionale Hausregeln, live umschaltbar: die 7-2-Regel und *The Train* (3 Hände in Folge), jeweils mit einem Betrag pro Spieler.
- *Call Clock*: Braucht ein Spieler länger als 2 Minuten, können die anderen ihm 60 Sekunden geben. Danach wird automatisch gefoldet.
- Aussetzen, Pleite-Pause (ab 3 Spielern bleiben 30 Sekunden für Rebuy oder Aussetzen) und Emotes.

**Kasse und Daten**
- Eine dauerhafte Spielerliste mit Hauptnamen. Am Tisch lässt sich zusätzlich ein Nickname anzeigen.
- Buy-in, Rebuy (40 BB bis zum größten Stack am Tisch), Abzug als Korrektur und Cashout. Jede Buchung wird festgehalten.
- Eine Transaktionsübersicht der laufenden Session und ein Session-Archiv der abgeschlossenen Sessions.
- Eine Handhistorie mit den letzten Händen.
- Profilbilder als kleine JPEGs, gespeichert pro Hauptname.
- Alles wird in `data/ledger.json` gespeichert. Die Datei wird atomar über eine temporäre Datei und Umbenennen geschrieben.

**Darstellung**
- Mehrere Kartendesigns: zwei- und vierfarbig aus den SVG-Vorlagen, dazu vollfarbig und Gold, die der Server daraus erzeugt. Rück- und Vorderseite sind anpassbar.
- Tischfarben Grün, Blau, Rot und Anthrazit.
- Soundeffekte (siehe [Sounds](#sounds)). Fehlt eine Datei, erzeugt der Browser den Klang synthetisch.

## Voraussetzungen

- **Lokal:** Node.js 18 oder neuer, weil der Server das globale `fetch` nutzt. Getestet ist Node 22. Dazu kommt npm.
- **Docker:** Docker Engine mit dem Compose-Plugin (`docker compose`).
- **VPS-Deployment:** Ein Linux-Server, auf dem Debian/Ubuntu, Fedora/RHEL oder Arch erkannt wird, mit root- oder sudo-Zugang. Außerdem eine Domain, deren DNS auf den Server zeigt.
- Ausgehender Internetzugang, falls die Sounds beim Start geladen werden sollen.

## Lokal starten

```bash
npm install
npm start            # = node server.js  ->  http://localhost:3000
```

Einen anderen Port wählst du mit `PORT=4000 npm start`.

Die Skripte `start.sh` (Linux/macOS/Git Bash) und `start.bat` (Windows, Doppelklick) installieren bei Bedarf die Abhängigkeiten, starten den Server und öffnen den Browser. Mitspieler im selben WLAN erreichen den Tisch über `http://<deine-IP>:3000`.

Selbsttest (dauert etwa eine Minute und läuft in einer temporären Kopie, das echte `data/ledger.json` bleibt unberührt):

```bash
npm test
```

## Mit Docker starten

```bash
docker compose up -d --build
```

Danach läuft die App unter `http://127.0.0.1:3000`. Standardmäßig ist der Port nur auf dem eigenen Rechner erreichbar.

Folgende Werte lassen sich über Umgebungsvariablen oder eine `.env`-Datei neben der `docker-compose.yml` anpassen:

```bash
CONTAINER_NAME=online-poker HOST_PORT=3000 BIND_ADDRESS=0.0.0.0 docker compose up -d --build
```

`BIND_ADDRESS=0.0.0.0` öffnet den Port für das ganze Netzwerk, zum Beispiel für Mitspieler im LAN.

## Deployment auf einem VPS mit `deploy.sh`

Klone das Repository auf dem Server und starte das Skript:

```bash
git clone <Repository-URL>
cd Online_Poker
./deploy.sh
```

Das Skript startet nichts ohne Rückfrage. Es erklärt vor jeder Änderung, was passiert, und arbeitet in sieben Schritten:

1. **Docker und Compose prüfen.** Fehlen sie, fragt das Skript nach und installiert sie dann über das offizielle Skript von get.docker.com bzw. das Compose-Plugin aus dem Paketmanager.
2. **Installationsverzeichnis abfragen.** Liegt es nicht im Repository, kopiert das Skript die App-Dateien dorthin.
3. **Containername, Domain und Host-Port abfragen.** Das Skript zeigt die belegten Ports an, sowohl von Host-Prozessen (`ss`) als auch von Docker-Containern (`docker ps`), und nimmt nur einen freien Port an. 80 und 443 bleiben für Caddy reserviert.
4. **Caddy klären.**
   - *Caddy ist vorhanden:* Das Skript fragt nach dem Pfad der Caddyfile und danach, ob Caddy als systemd-Dienst oder als Docker-Container läuft. Bei einem Container fragt es außerdem nach dem Namen, dem Pfad im Container und ob die Anbindung über ein gemeinsames Docker-Netzwerk oder `network_mode: host` erfolgt.
   - *Caddy ist nicht vorhanden:* Das Skript installiert Caddy nach Rückfrage gemäß der offiziellen Anleitung für die erkannte Distribution.
5. **Konfiguration schreiben.** Das betrifft `deploy.env` und bei Bedarf `docker-compose.override.yml`. Gibt es eine `.env.example`, fragt das Skript, ob eine `.env` erstellt werden soll, und fragt jeden Wert einzeln ab.
6. **Container bauen und starten.** Danach wartet das Skript, bis der Healthcheck „healthy“ meldet.
7. **Caddy einrichten.**
   - *Bei vorhandenem Caddy:* Das Skript legt ein Backup der Caddyfile an und zeigt den geplanten `reverse_proxy`-Block. Erst nach deiner Bestätigung trägt es ihn ein oder legt ihn als separate Datei unter `caddy/` ab. Anschließend prüft es die Konfiguration mit `caddy validate`. **Caddy wird nicht automatisch neu geladen.** Das Skript nennt dir den passenden Befehl, also `sudo systemctl reload caddy` oder `docker exec <caddy> caddy reload …`.
   - *Bei neu installiertem Caddy:* Das Skript schreibt die Caddyfile (die Standarddatei wird vorher gesichert), validiert sie und aktiviert den Dienst. Danach fragt es, ob die Ports 80/443 in ufw oder firewalld freigegeben werden sollen, und weist auf den nötigen DNS-Eintrag hin.

Am Ende gibt das Skript eine Zusammenfassung aus: URL, Port, Containername, Pfade, Backups und Volumes.

Das Skript kann **mehrfach ausgeführt** werden. Frühere Antworten aus `deploy.env` erscheinen als Vorschlag. Ein von diesem Skript eingefügter Caddy-Block ist markiert (`# >>> deploy.sh: <name>`) und wird bei einem erneuten Lauf ersetzt statt doppelt eingetragen. Die Spielerdaten bleiben erhalten.

## Konfiguration

| Was | Wert | Hinweis |
|---|---|---|
| Umgebungsvariable `PORT` | Standard `3000` | Port, auf dem `server.js` lauscht. Im Container fest auf 3000 gesetzt. |
| `CONTAINER_NAME` | Standard `online-poker` | Compose-Variable, wird von `deploy.sh` gesetzt |
| `HOST_PORT` | Standard `3000` | Compose-Variable, Port auf dem Host |
| `BIND_ADDRESS` | Standard `127.0.0.1` | Compose-Variable, Host-Adresse für den Port |
| Volume `poker-data` → `/app/data` | `ledger.json` | Spielerliste, Transaktionen, Archiv und Profilbilder. **Sichern!** |
| Volume `poker-sounds` → `/app/sounds` | `*.mp3` | Beim Start geladene Sounddateien |

Weitere Umgebungsvariablen nutzt die App nicht.

### Sounds

Beim Start lädt der Server fehlende Sounddateien von `mirelo.ai` in den Ordner `sounds/`. Laut Kommentar im Code **laufen diese Download-Links am 27.10.2026 ab**. Wurden die Dateien bis dahin nicht geladen, erzeugt der Browser die Klänge synthetisch. Bereits geladene Dateien bleiben im Volume erhalten.

### Datensicherung

```bash
docker run --rm -v <containername>_poker-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/poker-data-$(date +%F).tgz -C /data .
```

## Aktualisieren

Auf dem VPS:

```bash
cd <Repository-Verzeichnis>
git pull
./deploy.sh
```

Das Skript baut das Image neu und ersetzt den Container. Die Volumes bleiben dabei erhalten. Alternativ kannst du direkt im Installationsverzeichnis neu bauen:

```bash
docker compose --project-name <containername> --env-file deploy.env up -d --build
```

Hat `deploy.sh` eine `docker-compose.override.yml` angelegt, hänge `-f docker-compose.yml -f docker-compose.override.yml` an.

## Projektstruktur

```
server.js            HTTP- und WebSocket-Server, Spiellogik, Ledger
index.html           komplette Browser-Oberfläche
cards/2color, 4color SVG-Kartenvorlagen
selftest.js          Selbsttest (npm test)
start.sh, start.bat  lokaler Start mit Browser-Öffnung
Dockerfile           Image auf Basis von node:22-alpine
docker-compose.yml   Container, Port-Bindung, Volumes
deploy.sh            interaktives VPS-Deployment mit Caddy
```
