#!/usr/bin/env bash
# =============================================================================
# deploy.sh – stellt den Poker-Server auf einem Linux-VPS in Docker bereit
#             und richtet optional Caddy als HTTPS-Reverse-Proxy ein.
#
# Das Skript fragt alles Nötige interaktiv ab und erklärt vor jeder Änderung
# am System, was passiert. Es kann gefahrlos mehrfach ausgeführt werden:
# gespeicherte Antworten (deploy.env) werden beim nächsten Lauf als
# Vorschlag angeboten, ein vorhandener Container wird neu gebaut, Daten in
# den Docker-Volumes bleiben erhalten.
#
# Aufruf (im geklonten Repository):   ./deploy.sh
# Das Skript enthält keine Zugangsdaten oder Geheimnisse.
# =============================================================================
set -Eeuo pipefail
trap 'printf "\nFEHLER in Zeile %s: %s\nAbbruch. Bereits ausgeführte Schritte bleiben bestehen; das Skript kann erneut gestartet werden.\n" "$LINENO" "$BASH_COMMAND" >&2' ERR

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
readonly INTERNAL_PORT=3000          # Port im Container (server.js: process.env.PORT || 3000)
readonly STATE_FILE_NAME="deploy.env"
readonly OVERRIDE_FILE_NAME="docker-compose.override.yml"
readonly APP_ITEMS=(Dockerfile docker-compose.yml package.json package-lock.json server.js index.html cards)
readonly OPTIONAL_ITEMS=(.env.example update.sh)
readonly MARK_BEGIN_PREFIX="# >>> deploy.sh:"
readonly MARK_END_PREFIX="# <<< deploy.sh:"

# ---------------------------------------------------------------- Ausgabe ---
if [[ -t 1 ]]; then B=$'\e[1m'; G=$'\e[32m'; Y=$'\e[33m'; R=$'\e[31m'; N=$'\e[0m'; else B=; G=; Y=; R=; N=; fi
step() { printf '\n%s==> %s%s\n' "$B" "$*" "$N"; }
info() { printf '%s\n' "$*"; }
ok()   { printf '%s✔ %s%s\n' "$G" "$*" "$N"; }
warn() { printf '%s⚠ %s%s\n' "$Y" "$*" "$N" >&2; }
die()  { printf '%s✖ %s%s\n' "$R" "$*" "$N" >&2; exit 1; }

# ---------------------------------------------------------------- Eingabe ---
# ask VAR "Frage" [Vorschlag]  – wiederholt, bis ein nicht-leerer Wert kommt
ask() {
  local __var=$1 prompt=$2 def=${3-} ans
  while true; do
    if [[ -n $def ]]; then
      read -r -p "$prompt [$def]: " ans || die "Eingabe abgebrochen."
      ans=${ans:-$def}
    else
      read -r -p "$prompt: " ans || die "Eingabe abgebrochen."
    fi
    [[ -n $ans ]] && break
    info "Bitte einen Wert eingeben."
  done
  printf -v "$__var" '%s' "$ans"
}

# confirm "Frage" – ja = 0, nein = 1; kein Standardwert, es muss geantwortet werden
confirm() {
  local ans
  while true; do
    read -r -p "$1 [j/n]: " ans || die "Eingabe abgebrochen."
    case ${ans,,} in
      j|ja|y|yes) return 0 ;;
      n|nein|no)  return 1 ;;
      *) info "Bitte j oder n eingeben." ;;
    esac
  done
}

# choose VAR "Frage" "Option 1" "Option 2" ...  – speichert die Nummer
choose() {
  local __var=$1 prompt=$2; shift 2
  local i=1 opt ans
  info "$prompt"
  for opt in "$@"; do info "  $i) $opt"; i=$((i + 1)); done
  while true; do
    read -r -p "Auswahl [1-$#]: " ans || die "Eingabe abgebrochen."
    if [[ $ans =~ ^[0-9]+$ ]] && (( ans >= 1 && ans <= $# )); then break; fi
    info "Bitte eine Zahl zwischen 1 und $# eingeben."
  done
  printf -v "$__var" '%s' "$ans"
}

# ------------------------------------------------------- Rechte & Docker ---
SUDO=()
if [[ $EUID -ne 0 ]]; then
  command -v sudo >/dev/null 2>&1 || die "Dieses Skript braucht root-Rechte oder sudo."
  SUDO=(sudo)
fi
as_root() { "${SUDO[@]}" "$@"; }

DOCKER=(docker)
docker_cmd() { "${DOCKER[@]}" "$@"; }
pick_docker_cmd() {
  if docker info >/dev/null 2>&1; then DOCKER=(docker)
  elif as_root docker info >/dev/null 2>&1; then DOCKER=("${SUDO[@]}" docker)
  else die "Docker ist installiert, aber der Docker-Dienst antwortet nicht (prüfen mit: sudo systemctl status docker)."
  fi
}

# ----------------------------------------------------------- Distribution ---
OS_ID=""; OS_LIKE=""
detect_os() {
  [[ -r /etc/os-release ]] || die "/etc/os-release fehlt – Distribution nicht erkennbar."
  # shellcheck disable=SC1091  # Systemdatei, existiert erst auf dem Zielsystem
  OS_ID=$(. /etc/os-release && printf '%s' "${ID:-}")
  # shellcheck disable=SC1091
  OS_LIKE=$(. /etc/os-release && printf '%s' "${ID_LIKE:-}")
}
os_family() {
  case " $OS_ID $OS_LIKE " in
    *" debian "*|*" ubuntu "*|*" raspbian "*) echo debian ;;
    *" fedora "*|*" rhel "*|*" centos "*)     echo fedora ;;
    *" arch "*)                               echo arch ;;
    *)                                        echo unknown ;;
  esac
}
pkg_install() {
  case $(os_family) in
    debian) as_root apt-get update && as_root apt-get install -y "$@" ;;
    fedora) as_root dnf install -y "$@" ;;
    arch)   as_root pacman -S --needed --noconfirm "$@" ;;
    *)      die "Automatische Paketinstallation für '$OS_ID' nicht unterstützt. Bitte installiere manuell: $*" ;;
  esac
}

# --------------------------------------------------------- Zustandsdatei ---
# Liest deploy.env sicher (KEY=VALUE, nur bekannte Schlüssel, kein 'source').
declare -A PREV=()
load_state() {
  local f=$1 key val
  [[ -f $f ]] || return 0
  while IFS='=' read -r key val; do
    case $key in
      CONTAINER_NAME|HOST_PORT|DOMAIN|CADDY_MODE|CADDYFILE|CADDY_CONTAINER|CADDY_CONFIG_IN_CONTAINER|CADDY_NETWORK|CADDY_REACH)
        PREV[$key]=$val ;;
    esac
  done < "$f"
}
prev() { printf '%s' "${PREV[$1]-}"; }

# ------------------------------------------------------------------ Ports ---
# Gibt alle belegten TCP-Ports (Host-Prozesse + Docker-Veröffentlichungen) aus.
used_ports() {
  {
    as_root ss -ltnH 2>/dev/null | awk '{print $4}' | sed -E 's/.*:([0-9]+)$/\1/'
    docker_cmd ps --format '{{.Ports}}' | tr ',' '\n' \
      | sed -nE 's/.*:([0-9]+)(-([0-9]+))?->.*/\1 \3/p' \
      | while read -r a b; do
          if [[ -n ${b:-} ]]; then seq "$a" "$b"; else echo "$a"; fi
        done
  } | grep -E '^[0-9]+$' | sort -nu
}

# Host-Port, den unser eigener Container gerade veröffentlicht (für erneute Läufe)
own_port() {
  docker_cmd port "$1" "${INTERNAL_PORT}/tcp" 2>/dev/null | sed -nE 's/.*:([0-9]+)$/\1/p' | head -n1 || true
}

# ------------------------------------------------------------------ Caddy ---
caddy_block() {
  # $1 Domain, $2 Ziel (host:port), $3 Markierungsname
  printf '%s %s\n%s {\n\treverse_proxy %s\n}\n%s %s\n' \
    "$MARK_BEGIN_PREFIX" "$3" "$1" "$2" "$MARK_END_PREFIX" "$3"
}

# Entfernt einen früher von diesem Skript eingefügten Block (zwischen den Markierungen)
strip_marked_block() {
  awk -v b="$MARK_BEGIN_PREFIX $2" -v e="$MARK_END_PREFIX $2" '
    $0 == b {skip=1; next}
    $0 == e {skip=0; next}
    skip {next}
    /^[[:space:]]*$/ {blank++; next}            # Leerzeilen puffern …
    {while (blank > 0) {print ""; blank--}; print}  # … und am Dateiende weglassen
  ' "$1"
}

backup_file() {
  local f=$1 bak
  bak="$f.bak-$(date +%Y%m%d-%H%M%S)"
  as_root cp -a "$f" "$bak"
  ok "Backup angelegt: $bak"
  LAST_BACKUP=$bak
}

# Schreibt Inhalt aus Datei $1 nach $2, behält Besitzer/Rechte und Inode (wichtig für
# einzeln gemountete Dateien in Docker-Containern).
write_in_place() { as_root tee "$2" < "$1" >/dev/null; }

caddy_validate_host() {
  command -v caddy >/dev/null 2>&1 || { warn "Befehl 'caddy' nicht gefunden – Validierung nicht möglich."; return 1; }
  as_root caddy validate --config "$1" --adapter caddyfile
}
caddy_validate_container() {
  # $1 Container, $2 Pfad im Container
  docker_cmd exec "$1" caddy validate --config "$2" --adapter caddyfile
}

# ================================================================= Ablauf ===
[[ -t 0 ]] || die "Bitte interaktiv in einem Terminal starten (keine umgeleitete Eingabe)."

cat <<EOF
${B}Poker-Server – Docker-Deployment${N}
Dieses Skript
  1. prüft Docker und Docker Compose (Installation nur nach Rückfrage),
  2. fragt Installationsverzeichnis, Containername, Domain und Port ab,
  3. baut und startet den Container,
  4. richtet Caddy als HTTPS-Reverse-Proxy ein oder bereitet die Konfiguration vor.
Vor jeder Änderung am System wird erklärt, was passiert, und nachgefragt.
EOF
confirm "Fortfahren?" || { info "Abgebrochen – nichts wurde verändert."; exit 0; }

detect_os
info "Erkannte Distribution: ${OS_ID:-unbekannt} (Familie: $(os_family))"

# ----------------------------------------------------- 1. Docker prüfen ---
step "1/7 Docker und Docker Compose prüfen"
if ! command -v curl >/dev/null 2>&1; then
  info "curl fehlt (wird für die Docker-/Caddy-Installation gebraucht)."
  if confirm "curl über den Paketmanager installieren?"; then pkg_install curl; else warn "Ohne curl sind Installationen nicht möglich."; fi
fi

if command -v docker >/dev/null 2>&1; then
  ok "Docker gefunden: $(docker --version)"
else
  info "Docker ist nicht installiert."
  info "Geplant: offizielles Installationsskript von https://get.docker.com herunterladen und ausführen."
  info "Es richtet die Docker-Paketquelle ein und installiert Docker Engine samt Compose-Plugin."
  confirm "Docker jetzt installieren?" || die "Ohne Docker kann nicht fortgefahren werden."
  command -v curl >/dev/null 2>&1 || die "curl fehlt."
  tmp_get=$(mktemp)
  curl -fsSL https://get.docker.com -o "$tmp_get"
  as_root sh "$tmp_get"
  rm -f "$tmp_get"
  info "Docker-Dienst wird aktiviert und gestartet (systemctl enable --now docker)."
  as_root systemctl enable --now docker
  ok "Docker installiert: $(docker --version)"
fi
pick_docker_cmd

if docker_cmd compose version >/dev/null 2>&1; then
  ok "Docker Compose gefunden: $(docker_cmd compose version --short 2>/dev/null || docker_cmd compose version)"
else
  info "Das Docker-Compose-Plugin ('docker compose') fehlt."
  case $(os_family) in arch) compose_pkg=docker-compose ;; *) compose_pkg=docker-compose-plugin ;; esac
  info "Geplant: Paket '$compose_pkg' über den Paketmanager installieren."
  confirm "Jetzt installieren?" || die "Ohne Docker Compose kann nicht fortgefahren werden."
  pkg_install "$compose_pkg"
  docker_cmd compose version >/dev/null 2>&1 || die "Docker Compose ist nach der Installation nicht verfügbar."
  ok "Docker Compose installiert."
fi

# ------------------------------------------- 2. Installationsverzeichnis ---
step "2/7 Installationsverzeichnis"
info "Hier liegen danach die App-Dateien, deploy.env und ggf. docker-compose.override.yml."
info "Das Skript selbst liegt in: $SCRIPT_DIR"
while true; do
  ask INSTALL_DIR "Installationsverzeichnis (absoluter Pfad)"
  INSTALL_DIR=${INSTALL_DIR%/}
  [[ $INSTALL_DIR == /* ]] && break
  info "Bitte einen absoluten Pfad angeben (beginnt mit /)."
done

if [[ ! -d $INSTALL_DIR ]]; then
  info "Verzeichnis existiert nicht. Geplant: anlegen (mkdir -p) und dem Benutzer $(id -un) zuweisen."
  confirm "Anlegen?" || die "Abgebrochen."
  as_root mkdir -p "$INSTALL_DIR"
  as_root chown "$(id -u):$(id -g)" "$INSTALL_DIR"
fi
W=(); [[ -w $INSTALL_DIR ]] || W=("${SUDO[@]}")   # schreibt bei Bedarf mit sudo

if [[ $(cd "$INSTALL_DIR" && pwd -P) != $(cd "$SCRIPT_DIR" && pwd -P) ]]; then
  info "Geplant: App-Dateien aus $SCRIPT_DIR nach $INSTALL_DIR kopieren (vorhandene Dateien gleichen Namens werden überschrieben):"
  info "  ${APP_ITEMS[*]}"
  info "Spielerdaten liegen nicht in diesen Dateien, sondern in Docker-Volumes, und bleiben erhalten."
  confirm "Kopieren?" || die "Abgebrochen."
  for item in "${APP_ITEMS[@]}"; do
    [[ -e $SCRIPT_DIR/$item ]] || die "Datei fehlt im Repository: $item"
    "${W[@]}" cp -a "$SCRIPT_DIR/$item" "$INSTALL_DIR/"
  done
  for item in "${OPTIONAL_ITEMS[@]}"; do
    [[ -e $SCRIPT_DIR/$item ]] && "${W[@]}" cp -a "$SCRIPT_DIR/$item" "$INSTALL_DIR/"
  done
  ok "Dateien kopiert."
else
  ok "Installationsverzeichnis ist das Repository selbst – nichts zu kopieren."
fi

STATE_FILE="$INSTALL_DIR/$STATE_FILE_NAME"
load_state "$STATE_FILE"
[[ -f $STATE_FILE ]] && info "Frühere Einstellungen aus $STATE_FILE gefunden – sie werden als Vorschlag angezeigt."

# ------------------------------------------------ 3. Name, Domain, Port ---
step "3/7 Containername, Domain und Port"
while true; do
  ask CONTAINER_NAME "Containername (Kleinbuchstaben, Ziffern, - und _)" "$(prev CONTAINER_NAME)"
  if [[ ! $CONTAINER_NAME =~ ^[a-z0-9][a-z0-9_-]{0,62}$ ]]; then
    info "Ungültig: nur a–z, 0–9, - und _, beginnend mit Buchstabe oder Ziffer."; continue
  fi
  existing_project=$(docker_cmd ps -a --filter "name=^/${CONTAINER_NAME}\$" --format '{{.Label "com.docker.compose.project"}}' | head -n1)
  if [[ -n $(docker_cmd ps -a -q --filter "name=^/${CONTAINER_NAME}\$") && $existing_project != "$CONTAINER_NAME" ]]; then
    info "Ein anderer Container heißt bereits '$CONTAINER_NAME' (gehört nicht zu diesem Deployment). Bitte anderen Namen wählen."; continue
  fi
  break
done
PROJECT_NAME=$CONTAINER_NAME
if [[ -n $(prev CONTAINER_NAME) && $(prev CONTAINER_NAME) != "$CONTAINER_NAME" ]]; then
  warn "Bisher hieß der Container '$(prev CONTAINER_NAME)'. Die Spielerdaten liegen im Volume '$(prev CONTAINER_NAME)_poker-data'."
  warn "Mit dem neuen Namen entstehen NEUE, LEERE Volumes ('${CONTAINER_NAME}_poker-data'); die alten Daten bleiben unangetastet, werden aber nicht genutzt."
  confirm "Trotzdem den neuen Namen '$CONTAINER_NAME' verwenden?" || die "Abgebrochen. Starte erneut und behalte den bisherigen Namen."
fi

while true; do
  ask DOMAIN "Domain, unter der die App erreichbar sein soll (z. B. poker.beispiel.de)" "$(prev DOMAIN)"
  DOMAIN=${DOMAIN,,}
  [[ $DOMAIN =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$ ]] && break
  info "Das sieht nicht nach einem gültigen Domainnamen aus."
done

info ""
info "Belegte TCP-Ports auf dem Host (ss -ltnp):"
as_root ss -ltnpH | awk '{printf "  %-28s %s\n", $4, $6}' || true
info "Von Docker-Containern veröffentlichte Ports (docker ps):"
docker_cmd ps --format '  {{.Names}}: {{.Ports}}' || true
mapfile -t USED < <(used_ports)
OWN=$(own_port "$CONTAINER_NAME")
info ""
info "Belegt: ${USED[*]:-keine}"
[[ -n $OWN ]] && info "Hinweis: Port $OWN gehört bereits zu diesem Container und darf wiederverwendet werden."
info "Die Ports 80 und 443 sind für Caddy reserviert."
while true; do
  ask HOST_PORT "Host-Port für den Container (1024–65535, nur über 127.0.0.1 erreichbar)" "$(prev HOST_PORT)"
  if [[ ! $HOST_PORT =~ ^[0-9]+$ ]] || (( HOST_PORT < 1024 || HOST_PORT > 65535 )); then
    info "Bitte eine Zahl zwischen 1024 und 65535 eingeben."; continue
  fi
  if [[ $HOST_PORT != "$OWN" ]] && printf '%s\n' "${USED[@]}" | grep -qx "$HOST_PORT"; then
    info "Port $HOST_PORT ist belegt. Bitte einen freien Port wählen."; continue
  fi
  break
done

# ------------------------------------------------------- 4. Caddy klären ---
step "4/7 Caddy (HTTPS-Reverse-Proxy)"
c=""
CADDY_MODE=""; CADDYFILE=""; CADDY_CONTAINER=""; CADDY_CONFIG_IN_CONTAINER=""; CADDY_NETWORK=""; CADDY_REACH=""
UPSTREAM="127.0.0.1:$HOST_PORT"
if confirm "Ist Caddy auf diesem Server bereits vorhanden?"; then
  CADDY_PRESENT=1
  while true; do
    ask CADDYFILE "Pfad zur Caddyfile auf dem Host" "$(prev CADDYFILE)"
    as_root test -f "$CADDYFILE" && break
    info "Datei nicht gefunden: $CADDYFILE"
  done
  choose c "Wie läuft Caddy?" "als Systemdienst (systemd)" "als Docker-Container"
  if [[ $c == 1 ]]; then
    CADDY_MODE=systemd
  else
    CADDY_MODE=docker
    info "Laufende Container:"; docker_cmd ps --format '  {{.Names}}  ({{.Image}})'
    while true; do
      ask CADDY_CONTAINER "Name des Caddy-Containers" "$(prev CADDY_CONTAINER)"
      [[ -n $(docker_cmd ps -q --filter "name=^/${CADDY_CONTAINER}\$") ]] && break
      info "Kein laufender Container mit diesem Namen."
    done
    ask CADDY_CONFIG_IN_CONTAINER "Pfad derselben Caddyfile INNERHALB des Caddy-Containers" "$(prev CADDY_CONFIG_IN_CONTAINER)"
    choose c "Wie soll der Caddy-Container die App erreichen?" \
      "über ein gemeinsames Docker-Netzwerk (empfohlen bei Caddy im Bridge-Netz)" \
      "Caddy-Container läuft mit network_mode: host"
    if [[ $c == 1 ]]; then
      CADDY_REACH=network
      # shellcheck disable=SC2016  # Go-Template für docker inspect, soll nicht von Bash expandiert werden
      info "Netzwerke des Caddy-Containers: $(docker_cmd inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$CADDY_CONTAINER")"
      while true; do
        ask CADDY_NETWORK "Docker-Netzwerk, das Caddy und die App teilen sollen" "$(prev CADDY_NETWORK)"
        docker_cmd network inspect "$CADDY_NETWORK" >/dev/null 2>&1 && break
        info "Netzwerk '$CADDY_NETWORK' existiert nicht."
      done
      UPSTREAM="$CONTAINER_NAME:$INTERNAL_PORT"
    else
      CADDY_REACH=host
    fi
  fi
else
  CADDY_PRESENT=0
  CADDY_MODE=systemd
  CADDYFILE=/etc/caddy/Caddyfile
fi

# ------------------------------------- 5. Konfigurationsdateien schreiben ---
step "5/7 Konfiguration"
ENV_FILE="$INSTALL_DIR/.env"
if [[ -f $INSTALL_DIR/.env.example ]]; then
  info "Es gibt eine .env.example. Daraus kann eine .env mit deinen Werten erstellt werden."
  make_env=0
  if [[ -f $ENV_FILE ]]; then
    confirm "Es existiert bereits eine .env. Neu erstellen (alte wird gesichert)?" && make_env=1
  else
    confirm "Aus .env.example eine .env erstellen?" && make_env=1
  fi
  if (( make_env )); then
    [[ -f $ENV_FILE ]] && backup_file "$ENV_FILE"
    tmp_env=$(mktemp)
    while IFS= read -r line || [[ -n $line ]]; do
      if [[ $line =~ ^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]]; then
        k=${BASH_REMATCH[1]}; ex=${BASH_REMATCH[2]}
        read -r -p "Wert für $k (Beispiel in .env.example: '${ex}'): " v || die "Eingabe abgebrochen."
        printf '%s=%s\n' "$k" "$v" >> "$tmp_env"
      else
        printf '%s\n' "$line" >> "$tmp_env"
      fi
    done < "$INSTALL_DIR/.env.example"
    "${W[@]}" install -m 600 "$tmp_env" "$ENV_FILE"; rm -f "$tmp_env"
    ok ".env geschrieben (Rechte 600)."
  fi
fi

info "Geplant: $STATE_FILE schreiben (gespeicherte Antworten für den nächsten Lauf, keine Geheimnisse)."
tmp_state=$(mktemp)
cat > "$tmp_state" <<EOF
# Von deploy.sh erzeugt. Wird von docker compose (--env-file) und beim nächsten Lauf gelesen.
CONTAINER_NAME=$CONTAINER_NAME
HOST_PORT=$HOST_PORT
BIND_ADDRESS=127.0.0.1
DOMAIN=$DOMAIN
CADDY_MODE=$CADDY_MODE
CADDYFILE=$CADDYFILE
CADDY_CONTAINER=$CADDY_CONTAINER
CADDY_CONFIG_IN_CONTAINER=$CADDY_CONFIG_IN_CONTAINER
CADDY_NETWORK=$CADDY_NETWORK
CADDY_REACH=$CADDY_REACH
EOF
"${W[@]}" install -m 644 "$tmp_state" "$STATE_FILE"; rm -f "$tmp_state"
ok "$STATE_FILE geschrieben."

OVERRIDE="$INSTALL_DIR/$OVERRIDE_FILE_NAME"
if [[ $CADDY_REACH == network || -f $ENV_FILE ]]; then
  info "Geplant: $OVERRIDE_FILE_NAME schreiben ($( [[ -f $ENV_FILE ]] && printf '.env einbinden ' )$( [[ $CADDY_REACH == network ]] && printf 'Netzwerk %s anbinden' "$CADDY_NETWORK" ))."
  tmp_ov=$(mktemp)
  {
    echo "# Von deploy.sh erzeugt – wird bei jedem Lauf neu geschrieben."
    echo "services:"
    echo "  poker:"
    [[ -f $ENV_FILE ]] && printf '    env_file:\n      - .env\n'
    if [[ $CADDY_REACH == network ]]; then
      printf '    networks:\n      - default\n      - caddy_net\n'
      printf 'networks:\n  caddy_net:\n    external: true\n    name: %s\n' "$CADDY_NETWORK"
    fi
  } > "$tmp_ov"
  "${W[@]}" install -m 644 "$tmp_ov" "$OVERRIDE"; rm -f "$tmp_ov"
  ok "$OVERRIDE_FILE_NAME geschrieben."
elif [[ -f $OVERRIDE ]]; then
  info "Eine frühere $OVERRIDE_FILE_NAME wird nicht mehr gebraucht und wird entfernt."
  "${W[@]}" rm -f "$OVERRIDE"
fi

# --------------------------------------------- 6. Container starten ---
step "6/7 Container bauen und starten"
COMPOSE=(compose --project-name "$PROJECT_NAME" --project-directory "$INSTALL_DIR"
         --env-file "$STATE_FILE" -f "$INSTALL_DIR/docker-compose.yml")
[[ -f $OVERRIDE ]] && COMPOSE+=(-f "$OVERRIDE")
info "Geplant: docker compose up -d --build (Projekt '$PROJECT_NAME')."
info "Das Image wird gebaut, der Container '$CONTAINER_NAME' gestartet bzw. ersetzt."
info "Port: 127.0.0.1:$HOST_PORT -> Container:$INTERNAL_PORT. Volumes: ${PROJECT_NAME}_poker-data, ${PROJECT_NAME}_poker-sounds."
confirm "Jetzt bauen und starten?" || die "Abgebrochen. Konfiguration ist gespeichert; erneut starten mit ./deploy.sh."
docker_cmd "${COMPOSE[@]}" up -d --build

info "Warte auf den Container (max. 90 s) …"
status=""
for _ in $(seq 1 45); do
  status=$(docker_cmd inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' "$CONTAINER_NAME" 2>/dev/null || true)
  case $status in
    "running healthy") break ;;
    exited*|dead*) break ;;
  esac
  sleep 2
done
if [[ $status != "running healthy" ]]; then
  warn "Container-Status: '${status:-unbekannt}'. Letzte Log-Zeilen:"
  docker_cmd logs --tail 30 "$CONTAINER_NAME" || true
  die "Der Container läuft nicht sauber. Logs: docker logs $CONTAINER_NAME"
fi
ok "Container '$CONTAINER_NAME' läuft (healthy)."

# ------------------------------------------------------------ 7. Caddy ---
step "7/7 Caddy einrichten"
MARK=$CONTAINER_NAME
BLOCK=$(caddy_block "$DOMAIN" "$UPSTREAM" "$MARK")
LAST_BACKUP=""
CADDY_ACTIVATE=""
SNIPPET=""

if (( CADDY_PRESENT )); then
  info "Geplanter Caddy-Block:"
  printf '\n%s\n\n' "$BLOCK"
  if as_root grep -qxF "$MARK_BEGIN_PREFIX $MARK" "$CADDYFILE"; then
    info "Die Caddyfile enthält bereits einen Block dieses Deployments – er würde ersetzt."
  elif as_root grep -qwF "$DOMAIN" "$CADDYFILE"; then
    warn "Die Domain $DOMAIN kommt in der Caddyfile schon vor (nicht von diesem Skript):"
    as_root grep -nwF "$DOMAIN" "$CADDYFILE" || true
    warn "Ein zweiter Block für dieselbe Domain wäre ungültig. Empfohlen: separate Datei und manuell zusammenführen."
  fi
  choose c "Wie soll der Block bereitgestellt werden?" \
    "in die Caddyfile $CADDYFILE eintragen (vorher Backup)" \
    "als separate Datei in $INSTALL_DIR/caddy/ ablegen (Caddyfile bleibt unverändert)" \
    "Caddy-Schritt überspringen"
  if [[ $c == 1 ]]; then
    backup_file "$CADDYFILE"
    tmp_cf=$(mktemp)
    as_root cat "$CADDYFILE" > "$tmp_cf.orig"
    strip_marked_block "$tmp_cf.orig" "$MARK" > "$tmp_cf"
    printf '\n%s\n' "$BLOCK" >> "$tmp_cf"
    info "Neue Caddyfile wird geschrieben (Änderung gegenüber dem Backup):"
    diff -u "$LAST_BACKUP" "$tmp_cf" 2>/dev/null || as_root diff -u "$LAST_BACKUP" "$tmp_cf" || true
    if confirm "Diese Änderung in $CADDYFILE übernehmen?"; then
      write_in_place "$tmp_cf" "$CADDYFILE"
      ok "Caddyfile aktualisiert."
      valid=0
      if [[ $CADDY_MODE == systemd ]]; then caddy_validate_host "$CADDYFILE" && valid=1
      else caddy_validate_container "$CADDY_CONTAINER" "$CADDY_CONFIG_IN_CONTAINER" && valid=1; fi
      if (( valid )); then
        ok "Konfiguration ist gültig."
      else
        warn "Validierung fehlgeschlagen oder nicht möglich."
        if confirm "Backup $LAST_BACKUP wiederherstellen?"; then
          write_in_place "$LAST_BACKUP" "$CADDYFILE"; ok "Backup wiederhergestellt."
        fi
      fi
    else
      info "Caddyfile bleibt unverändert (Backup ist trotzdem vorhanden: $LAST_BACKUP)."
    fi
    rm -f "$tmp_cf" "$tmp_cf.orig"
  elif [[ $c == 2 ]]; then
    "${W[@]}" mkdir -p "$INSTALL_DIR/caddy"
    SNIPPET="$INSTALL_DIR/caddy/$DOMAIN.caddy"
    tmp_sn=$(mktemp); printf '%s\n' "$BLOCK" > "$tmp_sn"
    "${W[@]}" install -m 644 "$tmp_sn" "$SNIPPET"; rm -f "$tmp_sn"
    ok "Block abgelegt: $SNIPPET"
    if [[ $CADDY_MODE == systemd ]]; then
      if caddy_validate_host "$SNIPPET"; then ok "Block ist für sich genommen gültig."; else warn "Block konnte nicht validiert werden."; fi
      info "Zum Einbinden diese Zeile in $CADDYFILE ergänzen:  import $SNIPPET"
    else
      docker_cmd cp "$SNIPPET" "$CADDY_CONTAINER:/tmp/deploy-check.caddy"
      if caddy_validate_container "$CADDY_CONTAINER" /tmp/deploy-check.caddy; then ok "Block ist für sich genommen gültig."; else warn "Block konnte nicht validiert werden."; fi
      docker_cmd exec "$CADDY_CONTAINER" rm -f /tmp/deploy-check.caddy || true
      info "Zum Einbinden: Datei in den Caddy-Container mounten und in der Caddyfile per 'import <Pfad im Container>' laden – oder den Block direkt einfügen."
    fi
  fi
  if [[ $c != 3 ]]; then
    if [[ $CADDY_MODE == systemd ]]; then
      CADDY_ACTIVATE="sudo systemctl reload caddy"
    else
      CADDY_ACTIVATE="docker exec $CADDY_CONTAINER caddy reload --config $CADDY_CONFIG_IN_CONTAINER --adapter caddyfile"
    fi
    info ""
    info "${B}Caddy wird NICHT automatisch neu geladen.${N} Aktiviere die Änderung selbst mit:"
    info "  $CADDY_ACTIVATE"
  fi
else
  if command -v caddy >/dev/null 2>&1; then
    warn "Caddy ist doch installiert ($(caddy version 2>/dev/null | head -n1)). Bitte das Skript erneut starten und 'Ja' wählen."
    die "Abbruch, damit keine vorhandene Konfiguration überschrieben wird."
  fi
  case $(os_family) in
    debian)
      info "Geplant (offizielle Anleitung, https://caddyserver.com/docs/install#debian-ubuntu-raspbian):"
      info "  Pakete debian-keyring debian-archive-keyring apt-transport-https curl gnupg installieren,"
      info "  Caddy-Paketquelle (cloudsmith) mit Signaturschlüssel einrichten, dann 'apt install caddy'." ;;
    fedora)
      info "Geplant (offizielle Anleitung, https://caddyserver.com/docs/install#fedora-redhat-centos):"
      info "  dnf install 'dnf-command(copr)'; dnf copr enable @caddy/caddy; dnf install caddy" ;;
    arch)
      info "Geplant (offizielle Anleitung, https://caddyserver.com/docs/install#arch-linux-manjaro-parabola):"
      info "  pacman -S caddy" ;;
    *) die "Für '$OS_ID' kann Caddy nicht automatisch installiert werden. Anleitung: https://caddyserver.com/docs/install" ;;
  esac
  confirm "Caddy jetzt installieren?" || die "Abgebrochen. Der Container läuft bereits auf 127.0.0.1:$HOST_PORT."
  case $(os_family) in
    debian)
      as_root apt-get update
      as_root apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl gnupg
      curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
        | as_root gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
      curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
        | as_root tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
      as_root chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
      as_root apt-get update
      as_root apt-get install -y caddy ;;
    fedora)
      as_root dnf install -y 'dnf-command(copr)'
      as_root dnf copr enable -y @caddy/caddy
      as_root dnf install -y caddy ;;
    arch)
      as_root pacman -S --needed --noconfirm caddy ;;
  esac
  ok "Caddy installiert: $(caddy version | head -n1)"

  as_root mkdir -p "$(dirname "$CADDYFILE")"
  tmp_cf=$(mktemp)
  if as_root test -f "$CADDYFILE"; then
    info "Die Caddy-Installation hat eine Standard-Caddyfile angelegt."
    backup_file "$CADDYFILE"
    as_root cat "$CADDYFILE" > "$tmp_cf.orig"
    if as_root grep -qxF "$MARK_BEGIN_PREFIX $MARK" "$CADDYFILE"; then
      strip_marked_block "$tmp_cf.orig" "$MARK" > "$tmp_cf"
    else
      : > "$tmp_cf"   # Standard-Inhalt (Beispielseite auf :80) wird ersetzt; liegt im Backup
    fi
    rm -f "$tmp_cf.orig"
  fi
  printf '%s\n' "$BLOCK" >> "$tmp_cf"
  info "Geplanter Inhalt für $CADDYFILE:"
  printf '\n%s\n\n' "$(cat "$tmp_cf")"
  confirm "So schreiben?" || { rm -f "$tmp_cf"; die "Abgebrochen. Caddy ist installiert, aber nicht konfiguriert."; }
  if as_root test -f "$CADDYFILE"; then write_in_place "$tmp_cf" "$CADDYFILE"; else as_root install -m 644 "$tmp_cf" "$CADDYFILE"; fi
  rm -f "$tmp_cf"
  caddy_validate_host "$CADDYFILE" || die "Caddyfile ungültig. Backup: ${LAST_BACKUP:-keins}"
  ok "Caddyfile gültig."
  info "Geplant: Caddy-Dienst aktivieren und mit der neuen Konfiguration (neu) starten."
  confirm "Caddy-Dienst jetzt aktivieren?" || die "Abgebrochen. Später: sudo systemctl enable --now caddy && sudo systemctl reload caddy"
  as_root systemctl enable --now caddy
  as_root systemctl reload caddy || as_root systemctl restart caddy
  ok "Caddy läuft."
  CADDY_ACTIVATE="(bereits aktiviert)"

  step "Firewall"
  info "Caddy braucht eingehend TCP 80 und 443 (für HTTPS-Zertifikate und Zugriff)."
  if command -v ufw >/dev/null 2>&1 && as_root ufw status | grep -q '^Status: active'; then
    info "ufw ist aktiv. Geplant: ufw allow 80/tcp && ufw allow 443/tcp"
    if confirm "Ports 80 und 443 in ufw freigeben?"; then as_root ufw allow 80/tcp; as_root ufw allow 443/tcp; ok "Freigegeben."
    else info "Nicht geändert – bitte selbst freigeben."; fi
  elif command -v firewall-cmd >/dev/null 2>&1 && as_root firewall-cmd --state >/dev/null 2>&1; then
    info "firewalld ist aktiv. Geplant: Dienste http und https dauerhaft freigeben und neu laden."
    if confirm "Ports 80 und 443 in firewalld freigeben?"; then
      as_root firewall-cmd --permanent --add-service=http --add-service=https
      as_root firewall-cmd --reload; ok "Freigegeben."
    else info "Nicht geändert – bitte selbst freigeben."; fi
  else
    info "Keine aktive ufw/firewalld gefunden. Prüfe ggf. die Firewall deines VPS-Anbieters."
  fi
  info "DNS: Lege beim DNS-Anbieter einen A-Eintrag (und ggf. AAAA) für $DOMAIN an, der auf die öffentliche IP dieses Servers zeigt."
  info "Lokale Adressen dieses Servers: $(hostname -I 2>/dev/null || echo unbekannt)"
fi

# ------------------------------------------------------ Zusammenfassung ---
step "Zusammenfassung"
cat <<EOF
  URL:                https://$DOMAIN
  Lokal auf dem VPS:  http://127.0.0.1:$HOST_PORT
  Containername:      $CONTAINER_NAME   (Compose-Projekt: $PROJECT_NAME)
  Host-Port:          $HOST_PORT -> Container-Port $INTERNAL_PORT
  Installationspfad:  $INSTALL_DIR
  Einstellungen:      $STATE_FILE
  Daten-Volumes:      ${PROJECT_NAME}_poker-data (Ledger), ${PROJECT_NAME}_poker-sounds
  Caddy:              ${CADDY_MODE:-–} ${CADDY_CONTAINER:+(Container $CADDY_CONTAINER)}
  Caddyfile:          ${CADDYFILE:-–}
  Caddyfile-Backup:   ${LAST_BACKUP:-–}
  Separater Block:    ${SNIPPET:-–}
  Caddy aktivieren:   ${CADDY_ACTIVATE:-–}

  Logs:    docker logs -f $CONTAINER_NAME
  Update:  ./update.sh im Repository (Daten bleiben erhalten, siehe README)
EOF
ok "Fertig."
