# Online_Poker

Ein selbst gehosteter **Texas-Hold'em-Pokertisch im Browser** für private Runden. Der Server ist in Node.js geschrieben und verbindet alle Mitspieler per WebSocket in Echtzeit. Die gesamte Oberfläche steckt in einer einzigen `index.html`. Die Hole Cards eines Spielers schickt der Server nur an diesen Spieler. Für alle sichtbar werden sie erst beim Showdown oder bei der 7-2-Aufdeckung.

> Das Repository enthält **keine Spielerdaten**. Eine neue Installation startet mit leerer Spielerliste, leerem Archiv und ohne Profilbilder.

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
- *Call Clock*: Ist ein Spieler 90 Sekunden inaktiv, kann ein Mitspieler die Uhr auslösen. Danach bleiben 60 Sekunden, sonst wird gefoldet.
- *Bereit-Runde*: Vor der ersten Hand und nach einer Pause startet die Hand erst, wenn alle bereit sind oder ein bereiter Spieler „Trotzdem starten“ drückt. Wer nicht bereit ist, setzt aus.
- Aussetzen, Pleite-Pause (ab 3 Spielern bleiben 30 Sekunden für Rebuy oder Aussetzen) und Emotes.
- *Reconnect*: Bricht die Verbindung ab, bleiben Platz und Stack erhalten. Derselbe Browser verbindet sich wieder, und ein anderes Gerät kann den Platz übernehmen.
- *Kill-Sounds*: Wer einen Mitspieler aus der Hand ausschaltet, löst seinen Kill-Sound #1–#5 aus. Gezählt wird pro Sitzung am Tisch.

**Kasse und Daten**
- Eine dauerhafte Spielerliste mit Hauptnamen. Am Tisch lässt sich zusätzlich ein Nickname anzeigen.
- Buy-in, Rebuy (40 BB bis zum größten Stack am Tisch), Abzug als Korrektur und Cashout. Jede Buchung wird festgehalten.
- Eine Transaktionsübersicht der laufenden Session und ein Session-Archiv der abgeschlossenen Sessions.
- Beim Schließen einer Session entscheidet ein Teilnehmer, ob die Gewinne und Verluste per Discord-Webhook ins Dashboard gehen oder ob es eine „Spaßrunde“ ohne Übertragung war (siehe [Konfiguration](#konfiguration)).
- Hauptnamen lassen sich mit einem Bestätigungswort löschen, aber nicht, solange der Spieler am Tisch sitzt. Historie und Gewinne/Verluste bleiben lesbar.
- Eine Handhistorie mit den letzten Händen.
- Profilbilder pro Hauptname, als kleines JPEG oder als GIF.
- Eigene Sounds pro Hauptname: Sieges-Musik (spielt ab 50 BB im Hauptpot) und bis zu fünf Kill-Sounds, jeweils als MP3 oder WAV mit höchstens 1 MB und 6 Sekunden Spielzeit.
- Konten, Archiv und Profilbilder liegen in `data/ledger.json`, hochgeladene Medien in `data/md/`. Das Ledger wird atomar über eine temporäre Datei und Umbenennen geschrieben.

**Darstellung**
- Mehrere Kartendesigns: zwei- und vierfarbig aus den SVG-Vorlagen, dazu vollfarbig und Gold, die der Server daraus erzeugt. Rück- und Vorderseite sind anpassbar.
- Tischfarben Grün, Blau, Rot und Anthrazit.
- Soundeffekte (siehe [Sounds](#sounds)). Fehlt eine Datei, erzeugt der Browser den Klang synthetisch.
- Installierbar als App (PWA) mit Manifest, App-Icon und Service Worker. Karten und Sounds werden zwischengespeichert, die Seite selbst lädt immer zuerst aus dem Netz. Updates kommen also mit dem nächsten Neuladen an.

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

Das Repository ist **privat**. GitHub akzeptiert für `git clone` und `git pull` kein Passwort, deshalb braucht der Server einen eigenen Zugang (siehe [Zugriff auf das private Repository](#zugriff-auf-das-private-repository)). Mit eingerichtetem Deploy-Key klonst du so:

```bash
git clone git@github-online-poker:DasKINIJI/Online_Poker.git
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
   - *Bei vorhandenem Caddy:* Das Skript legt ein Backup der Caddyfile an und zeigt den geplanten `reverse_proxy`-Block. Erst nach deiner Bestätigung trägt es ihn ein oder legt ihn als separate Datei unter `caddy/` ab. Anschließend prüft es die Konfiguration mit `caddy validate`. **Caddy wird nicht automatisch neu geladen.** Das Skript nennt dir den passenden Befehl, also `sudo systemctl reload caddy` oder `docker exec caddy caddy reload …` (dabei `caddy` durch den Namen deines Caddy-Containers ersetzen).
   - *Bei neu installiertem Caddy:* Das Skript schreibt die Caddyfile (die Standarddatei wird vorher gesichert), validiert sie und aktiviert den Dienst. Danach fragt es, ob die Ports 80/443 in ufw oder firewalld freigegeben werden sollen, und weist auf den nötigen DNS-Eintrag hin.

Am Ende gibt das Skript eine Zusammenfassung aus: URL, Port, Containername, Pfade, Backups und Volumes.

Das Skript kann **mehrfach ausgeführt** werden. Frühere Antworten aus `deploy.env` erscheinen als Vorschlag. Ein von diesem Skript eingefügter Caddy-Block ist markiert (`# >>> deploy.sh: online-poker`) und wird bei einem erneuten Lauf ersetzt statt doppelt eingetragen. Die Spielerdaten bleiben erhalten.

> Die Beispiele unten gehen vom Containernamen `online-poker` aus, dem Standardwert in `docker-compose.yml`, und von einem Klon unter `~/Online_Poker`. Hast du in `deploy.sh` einen anderen Containernamen gewählt, setze diesen ein. Die Volumes heißen dann `<dein-name>_poker-data` und `<dein-name>_poker-sounds`.

## Zugriff auf das private Repository

GitHub lehnt Passwörter für Git-Operationen ab. Die Fehlermeldung lautet dann *„Password authentication is not supported for Git operations“*. Auf dem Server gibt es zwei Wege.

### Empfohlen: Deploy-Key per SSH (nur Lesezugriff, nur dieses Repository)

1. Schlüssel auf dem Server erzeugen:

   ```bash
   ssh-keygen -t ed25519 -f ~/.ssh/online_poker_deploy -N "" -C "online-poker-vps"
   cat ~/.ssh/online_poker_deploy.pub
   ```

2. Den ausgegebenen öffentlichen Schlüssel auf GitHub eintragen unter **https://github.com/DasKINIJI/Online_Poker/settings/keys** → *Add deploy key*. Die Option *Allow write access* bleibt aus.

3. Auf dem Server einen SSH-Alias anlegen, damit Git genau diesen Schlüssel nutzt:

   ```bash
   cat >> ~/.ssh/config <<'EOF'
   Host github-online-poker
       HostName github.com
       User git
       IdentityFile ~/.ssh/online_poker_deploy
       IdentitiesOnly yes
   EOF
   chmod 600 ~/.ssh/config
   ssh -T github-online-poker      # Erwartet: "Hi DasKINIJI/Online_Poker! You've successfully authenticated…"
   ```

4. Klonen:

   ```bash
   cd ~
   git clone git@github-online-poker:DasKINIJI/Online_Poker.git
   ```

   Hast du bereits per HTTPS geklont, stellst du den vorhandenen Klon um:

   ```bash
   cd ~/Online_Poker
   git remote set-url origin git@github-online-poker:DasKINIJI/Online_Poker.git
   ```

### Alternative: Fine-grained Token

Erstelle unter GitHub → *Settings → Developer settings → Fine-grained tokens* einen Token, der nur Zugriff auf `DasKINIJI/Online_Poker` hat, mit der Berechtigung **Contents: Read-only**. Beim `git clone https://github.com/DasKINIJI/Online_Poker.git` gibst du als Benutzernamen `DasKINIJI` ein und als Passwort **den Token**, nicht dein GitHub-Passwort. Ohne Credential-Helper fragt Git bei jedem `git pull` erneut.

## Konfiguration

| Was | Wert | Hinweis |
|---|---|---|
| Umgebungsvariable `PORT` | Standard `3000` | Port, auf dem `server.js` lauscht. Im Container fest auf 3000 gesetzt. |
| Umgebungsvariable `DISCORD_WEBHOOK` | leer | Discord-Webhook-URL für den Gewinn-/Verlust-Export einer Session. Leer bedeutet kein Export. **Geheim halten.** |
| `CONTAINER_NAME` | Standard `online-poker` | Compose-Variable, wird von `deploy.sh` gesetzt |
| `HOST_PORT` | Standard `3000` | Compose-Variable, Port auf dem Host |
| `BIND_ADDRESS` | Standard `127.0.0.1` | Compose-Variable, Host-Adresse für den Port |
| Volume `poker-data` → `/app/data` | `ledger.json`, `md/` | Spielerliste, Transaktionen, Archiv, Profilbilder und hochgeladene Medien. **Sichern!** |
| Volume `poker-sounds` → `/app/sounds` | `*.mp3` | Beim Start geladene Sounddateien |

Weitere Umgebungsvariablen nutzt die App nicht.

### Discord-Webhook einrichten

Die Vorlage `.env.example` enthält `DISCORD_WEBHOOK`. Beim nächsten Lauf fragt `./deploy.sh`, ob daraus eine `.env` erstellt werden soll. Die Datei bekommt die Rechte 600, und `deploy.sh` bindet sie über `docker-compose.override.yml` in den Container ein. Die Daten bleiben dabei erhalten. Die `.env` gehört nicht ins Repository.

Lokal ohne Docker reicht: `DISCORD_WEBHOOK=https://discord.com/api/webhooks/… npm start`.

### Sounds

Beim Start lädt der Server fehlende Sounddateien von `mirelo.ai` in den Ordner `sounds/`. Laut Kommentar im Code **laufen diese Download-Links am 27.10.2026 ab**. Wurden die Dateien bis dahin nicht geladen, erzeugt der Browser die Klänge synthetisch. Bereits geladene Dateien bleiben im Volume erhalten.

### Was bleibt bei Updates und Neustarts erhalten?

| Bleibt erhalten (Volumes) | Geht bei einem Neustart des Containers verloren (Arbeitsspeicher) |
|---|---|
| Spielerliste, Konten, Buchungen, Session-Archiv, Profilbilder, eigene Sounds, geladene Sounddateien | der laufende Tisch: Sitzplätze, aktuelle Stacks und die Handhistorie der laufenden Sitzung |

Deshalb schließt man vor einem vollständigen Update am besten die laufende Session in der App. `update.sh` warnt, wenn noch eine offen ist. Ein reines Oberflächen-Update (`index.html`) braucht keinen Neustart.

> Die Volumes sind an den **Containernamen** gebunden (`<name>_poker-data`). Wählst du in `deploy.sh` einen anderen Namen, startet die App mit neuen, leeren Volumes. Die alten Daten liegen dann unbenutzt im alten Volume. `deploy.sh` warnt in diesem Fall.

### Datensicherung

```bash
docker run --rm -v online-poker_poker-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/poker-data-$(date +%F).tgz -C /data .
```

### Backup wiederherstellen

`update.sh` legt vor jedem vollständigen Update unter `backups/` im Installationsverzeichnis ein Backup an. So spielst du es zurück:

```bash
docker stop online-poker
docker run --rm -v online-poker_poker-data:/data -v "$PWD/backups":/b alpine \
  sh -c 'rm -rf /data/* && tar -xf /b/poker-data-JJJJMMTT-HHMMSS.tar -C /data --strip-components=1'
docker start online-poker
```

### Installation leeren (Neuanfang)

Damit löschst du **alle** Spielerdaten unwiderruflich. Lege vorher ein Backup an.

```bash
docker stop online-poker
docker run --rm -v online-poker_poker-data:/data alpine sh -c 'rm -rf /data/*'
docker start online-poker
```

## Aktualisieren

Auf dem VPS im Repository:

```bash
cd ~/Online_Poker
./update.sh
```

`update.sh` arbeitet in fünf Schritten und fragt vor jeder Änderung nach:

1. Es findet die Installation über die `deploy.env` und prüft, ob der Container läuft.
2. Auf Wunsch holt es neue Commits von GitHub. Vor dem `git pull --ff-only` zeigt es die Commits und die geänderten Dateien an.
3. Es vergleicht die Dateien im Repository per Prüfsumme mit denen im **laufenden Container**.
4. Danach wählt es den passenden Weg:
   - **Nur `index.html` geändert:** Die Datei wird per `docker cp` live in den Container gelegt. Es gibt **keinen Neustart**, der Tisch läuft weiter. Der Server liest `index.html` bei jedem Aufruf neu, die Spieler laden die Seite einfach neu.
   - **Server-Dateien geändert** (`server.js`, `package*.json`, `cards/`, `Dockerfile`, `docker-compose.yml`): Das Skript warnt bei offener Session, sichert `data/` nach `backups/poker-data-<Zeitstempel>.tar` (Rechte 600), baut das Image neu und ersetzt den Container. Die Volumes bleiben dieselben.
5. Es wartet auf den Healthcheck und gibt eine Zusammenfassung aus.

Neue Konfigurationsoptionen, zum Beispiel ein Discord-Webhook, richtest du mit `./deploy.sh` ein. Ein erneuter Lauf ist gefahrlos, die Daten bleiben erhalten.

Ohne Skript geht ein vollständiges Update im Installationsverzeichnis so:

```bash
docker compose --project-name online-poker --env-file deploy.env up -d --build
```

Hat `deploy.sh` eine `docker-compose.override.yml` angelegt, hänge `-f docker-compose.yml -f docker-compose.override.yml` an.

## Projektstruktur

```
server.js            HTTP- und WebSocket-Server, Spiellogik, Ledger
index.html           komplette Browser-Oberfläche
cards/2color, 4color SVG-Kartenvorlagen
selftest.js          Selbsttest (npm test)
package-lock.json    feste Version der Abhängigkeit ws
.env.example         Vorlage für Umgebungsvariablen (DISCORD_WEBHOOK)
start.sh, start.bat  lokaler Start mit Browser-Öffnung
Dockerfile           Image auf Basis von node:22-alpine
docker-compose.yml   Container, Port-Bindung, Volumes
deploy.sh            interaktives VPS-Deployment mit Caddy
update.sh            Update ohne Datenverlust (Live-Tausch oder Neubau mit Backup)
```
