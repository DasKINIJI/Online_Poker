#!/usr/bin/env bash
# =============================================================================
# update.sh – aktualisiert eine mit deploy.sh eingerichtete Installation,
#             ohne Spielerdaten zu verlieren.
#
# Zwei Wege:
#   1. Nur Oberfläche: Hat sich nur index.html geändert, wird die Datei im
#      laufenden Container ausgetauscht. Kein Neustart – der Tisch, Stacks und
#      Sitzplätze laufen einfach weiter. Spieler laden die Seite neu.
#   2. Vollständig: Image neu bauen und Container ersetzen. Vorher wird data/
#      (Ledger + hochgeladene Medien) als Backup gesichert. Die Docker-Volumes
#      bleiben ohnehin erhalten; nur der laufende Tisch (im Arbeitsspeicher)
#      beginnt neu.
#
# Aufruf im Repository:   ./update.sh
# Das Skript fragt vor jeder Änderung nach und enthält keine Zugangsdaten.
# =============================================================================
set -Eeuo pipefail

main() {
  trap 'printf "\nFEHLER in Zeile %s: %s\nAbbruch. Der laufende Container ist unverändert, sofern der Schritt \"Neu bauen\" noch nicht erreicht war.\n" "$LINENO" "$BASH_COMMAND" >&2' ERR

  local SCRIPT_DIR
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  local -r STATE_FILE_NAME="deploy.env"
  local -r OVERRIDE_FILE_NAME="docker-compose.override.yml"
  local -r APP_ITEMS=(Dockerfile docker-compose.yml package.json package-lock.json server.js index.html cards)
  local -r OPTIONAL_ITEMS=(.env.example update.sh deploy.sh)

  # ------------------------------------------------------------ Ausgabe ---
  local B="" G="" Y="" R="" N=""
  if [[ -t 1 ]]; then B=$'\e[1m'; G=$'\e[32m'; Y=$'\e[33m'; R=$'\e[31m'; N=$'\e[0m'; fi
  step() { printf '\n%s==> %s%s\n' "$B" "$*" "$N"; }
  info() { printf '%s\n' "$*"; }
  ok()   { printf '%s✔ %s%s\n' "$G" "$*" "$N"; }
  warn() { printf '%s⚠ %s%s\n' "$Y" "$*" "$N" >&2; }
  die()  { printf '%s✖ %s%s\n' "$R" "$*" "$N" >&2; exit 1; }
  ask() {
    local __var=$1 prompt=$2 def=${3-} ans
    while true; do
      if [[ -n $def ]]; then read -r -p "$prompt [$def]: " ans || die "Eingabe abgebrochen."; ans=${ans:-$def}
      else read -r -p "$prompt: " ans || die "Eingabe abgebrochen."; fi
      if [[ -n $ans ]]; then break; fi
      info "Bitte einen Wert eingeben."
    done
    printf -v "$__var" '%s' "$ans"
  }
  confirm() {
    local ans
    while true; do
      read -r -p "$1 [j/n]: " ans || die "Eingabe abgebrochen."
      case ${ans,,} in j|ja|y|yes) return 0 ;; n|nein|no) return 1 ;; *) info "Bitte j oder n eingeben." ;; esac
    done
  }

  [[ -t 0 ]] || die "Bitte interaktiv in einem Terminal starten."

  # ------------------------------------------------- Rechte & Docker ---
  local -a SUDO=() DOCKER=(docker)
  if [[ $EUID -ne 0 ]]; then
    command -v sudo >/dev/null 2>&1 || die "Dieses Skript braucht root-Rechte oder sudo."
    SUDO=(sudo)
  fi
  command -v docker >/dev/null 2>&1 || die "Docker ist nicht installiert. Erst ./deploy.sh ausführen."
  if docker info >/dev/null 2>&1; then DOCKER=(docker)
  elif "${SUDO[@]}" docker info >/dev/null 2>&1; then DOCKER=("${SUDO[@]}" docker)
  else die "Der Docker-Dienst antwortet nicht."; fi
  dk() { "${DOCKER[@]}" "$@"; }

  cat <<EOF
${B}Poker-Server – Update ohne Datenverlust${N}
Spielerdaten (Namen, Konten, Session-Archiv, Profilbilder, Sounds) liegen in
Docker-Volumes und bleiben bei jedem Weg erhalten.
EOF

  # --------------------------------------------- 1. Installation finden ---
  step "1/5 Installation finden"
  local INSTALL_DIR def_dir=""
  [[ -f $SCRIPT_DIR/$STATE_FILE_NAME ]] && def_dir=$SCRIPT_DIR
  while true; do
    ask INSTALL_DIR "Installationsverzeichnis (dort liegt die deploy.env)" "$def_dir"
    INSTALL_DIR=${INSTALL_DIR%/}
    [[ -f $INSTALL_DIR/$STATE_FILE_NAME ]] && break
    info "Keine $STATE_FILE_NAME in $INSTALL_DIR gefunden. Wurde dort ./deploy.sh ausgeführt?"
  done
  local STATE_FILE="$INSTALL_DIR/$STATE_FILE_NAME" CONTAINER_NAME="" key val
  while IFS='=' read -r key val; do
    [[ $key == CONTAINER_NAME ]] && CONTAINER_NAME=$val
  done < "$STATE_FILE"
  [[ -n $CONTAINER_NAME ]] || die "CONTAINER_NAME fehlt in $STATE_FILE."
  local status
  status=$(dk inspect -f '{{.State.Status}}' "$CONTAINER_NAME" 2>/dev/null || true)
  [[ $status == running ]] || die "Container '$CONTAINER_NAME' läuft nicht (Status: ${status:-nicht vorhanden}). Für eine Neuinstallation ./deploy.sh verwenden."
  ok "Container '$CONTAINER_NAME' läuft. Installationsverzeichnis: $INSTALL_DIR"
  local W=()
  [[ -w $INSTALL_DIR ]] || W=("${SUDO[@]}")

  # ------------------------------------------- 2. Neuen Stand holen ---
  step "2/5 Neuen Stand holen"
  if git -C "$SCRIPT_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    local branch upstream
    branch=$(git -C "$SCRIPT_DIR" rev-parse --abbrev-ref HEAD)
    info "Repository: $SCRIPT_DIR (Branch: $branch)"
    if confirm "Neue Änderungen von GitHub holen (git fetch, Anzeige vor dem Übernehmen)?"; then
      git -C "$SCRIPT_DIR" fetch --quiet || die "git fetch fehlgeschlagen (Zugang zum privaten Repository? Siehe README)."
      upstream=$(git -C "$SCRIPT_DIR" rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || true)
      if [[ -z $upstream ]]; then
        warn "Branch '$branch' hat keinen Upstream – überspringe git pull."
      elif [[ $(git -C "$SCRIPT_DIR" rev-list --count "HEAD..$upstream") == 0 ]]; then
        ok "Bereits aktuell."
      else
        info "Neue Commits:"
        git -C "$SCRIPT_DIR" log --oneline "HEAD..$upstream"
        info "Geänderte Dateien:"
        git -C "$SCRIPT_DIR" diff --stat "HEAD..$upstream"
        if confirm "Übernehmen (git pull --ff-only)?"; then
          git -C "$SCRIPT_DIR" pull --ff-only || die "git pull nicht möglich (lokale Änderungen?). Bitte 'git status' prüfen."
          ok "Stand aktualisiert."
        fi
      fi
    fi
  else
    info "$SCRIPT_DIR ist kein Git-Repository – es werden die vorhandenen Dateien verwendet."
  fi

  # ------------------------------------- 3. Änderungen ermitteln ---
  step "3/5 Unterschiede zum laufenden Container"
  for item in "${APP_ITEMS[@]}"; do
    [[ -e $SCRIPT_DIR/$item ]] || die "Datei fehlt im Repository: $item"
  done
  # Prüfsummen: Repository vs. Dateien im laufenden Container
  local_sum()     { (cd "$SCRIPT_DIR" && sha256sum "$1" | cut -d' ' -f1); }
  container_sum() { dk exec "$CONTAINER_NAME" sha256sum "/app/$1" 2>/dev/null | cut -d' ' -f1 || true; }
  local_tree()     { (cd "$SCRIPT_DIR" && find cards -type f | LC_ALL=C sort | xargs sha256sum | sha256sum | cut -d' ' -f1); }
  container_tree() { dk exec -w /app "$CONTAINER_NAME" sh -c 'find cards -type f | LC_ALL=C sort | xargs sha256sum | sha256sum' 2>/dev/null | cut -d' ' -f1 || true; }

  local -a changed=() server_side=()
  local f
  for f in index.html server.js package.json package-lock.json; do
    if [[ $(local_sum "$f") != "$(container_sum "$f")" ]]; then
      changed+=("$f")
      [[ $f != index.html ]] && server_side+=("$f")
    fi
  done
  if [[ $(local_tree) != "$(container_tree)" ]]; then changed+=(cards/); server_side+=(cards/); fi
  # Dockerfile/Compose liegen nicht im Container – Vergleich mit dem Installationsverzeichnis
  if [[ $(cd "$INSTALL_DIR" && pwd -P) != $(cd "$SCRIPT_DIR" && pwd -P) ]]; then
    for f in Dockerfile docker-compose.yml; do
      if ! cmp -s "$SCRIPT_DIR/$f" "$INSTALL_DIR/$f"; then changed+=("$f"); server_side+=("$f"); fi
    done
  fi

  if (( ${#changed[@]} == 0 )); then
    ok "Der Container ist bereits auf dem Stand des Repositorys. Nichts zu tun."
    info "(Änderungen nur an Dockerfile/docker-compose.yml im selben Verzeichnis erkennt das Skript nicht – dafür ./deploy.sh erneut ausführen.)"
    exit 0
  fi
  info "Geändert: ${changed[*]}"

  local mode
  if (( ${#server_side[@]} == 0 )); then
    info ""
    info "Es hat sich ${B}nur die Oberfläche (index.html)${N} geändert."
    info "  1) Live austauschen – kein Neustart, laufender Tisch bleibt erhalten (empfohlen)"
    info "  2) Trotzdem vollständig neu bauen und neu starten"
    info "  3) Abbrechen"
    while true; do read -r -p "Auswahl [1-3]: " mode || die "Eingabe abgebrochen."; [[ $mode =~ ^[123]$ ]] && break; done
  else
    info ""
    info "Server-seitige Änderungen (${server_side[*]}) brauchen einen Neubau und Neustart des Containers."
    info "  2) Vollständig neu bauen und neu starten"
    info "  3) Abbrechen"
    while true; do read -r -p "Auswahl [2-3]: " mode || die "Eingabe abgebrochen."; [[ $mode =~ ^[23]$ ]] && break; done
  fi
  [[ $mode == 3 ]] && { info "Abgebrochen – nichts verändert."; exit 0; }

  copy_to_install_dir() {
    [[ $(cd "$INSTALL_DIR" && pwd -P) == $(cd "$SCRIPT_DIR" && pwd -P) ]] && return 0
    local it
    for it in "$@"; do
      if [[ -e $SCRIPT_DIR/$it ]]; then "${W[@]}" cp -a "$SCRIPT_DIR/$it" "$INSTALL_DIR/"; fi
    done
    return 0
  }

  # ------------------------------------------- 4a. Nur Oberfläche ---
  if [[ $mode == 1 ]]; then
    step "4/5 Oberfläche live austauschen"
    info "Geplant: index.html nach $INSTALL_DIR kopieren (für spätere Neubauten) und per 'docker cp'"
    info "in den laufenden Container '$CONTAINER_NAME' legen. Der Server liest die Datei bei jedem Aufruf neu."
    confirm "Jetzt austauschen?" || { info "Abgebrochen – nichts verändert."; exit 0; }
    copy_to_install_dir index.html
    dk cp "$SCRIPT_DIR/index.html" "$CONTAINER_NAME:/app/index.html"
    [[ $(local_sum index.html) == "$(container_sum index.html)" ]] || die "Prüfsumme im Container stimmt nicht – bitte ./update.sh erneut ausführen."
    ok "index.html im Container ausgetauscht. Der Container lief ohne Unterbrechung weiter."
    step "5/5 Fertig"
    info "Spieler sehen die neue Oberfläche nach einem Neuladen der Seite (bei installierter App: App schließen und neu öffnen)."
    exit 0
  fi

  # ------------------------------------------- 4b. Vollständig ---
  step "4/5 Backup und Neubau"
  local open_tx
  open_tx=$(dk exec "$CONTAINER_NAME" node -e "try{const L=require('/app/data/ledger.json');console.log((L.tx||[]).length)}catch(e){console.log(0)}" 2>/dev/null || echo "?")
  if [[ $open_tx != 0 ]]; then
    warn "Es läuft gerade eine Session (${open_tx} offene Buchungen)."
    warn "Ein Neustart beendet den laufenden Tisch: Sitzplätze und aktuelle Stacks gehen verloren,"
    warn "die gebuchten Buy-ins bleiben erhalten. Besser: Session in der App erst schließen."
    confirm "Trotzdem jetzt neu starten?" || { info "Abgebrochen – nichts verändert."; exit 0; }
  else
    ok "Keine offene Session."
  fi

  local BACKUP_DIR="$INSTALL_DIR/backups" ts backup
  ts=$(date +%Y%m%d-%H%M%S)
  backup="$BACKUP_DIR/poker-data-$ts.tar"
  info "Geplant: data/ aus dem Container sichern nach $backup (Rechte 600, enthält Spielerdaten)."
  confirm "Backup anlegen?" || die "Ohne Backup wird nicht neu gebaut."
  "${W[@]}" mkdir -p "$BACKUP_DIR"
  "${W[@]}" chmod 700 "$BACKUP_DIR"
  dk cp "$CONTAINER_NAME:/app/data" - | "${W[@]}" tee "$backup" >/dev/null
  "${W[@]}" chmod 600 "$backup"
  tar -tf "$backup" >/dev/null 2>&1 || "${W[@]}" tar -tf "$backup" >/dev/null || die "Backup ist beschädigt – Abbruch vor dem Neubau."
  ok "Backup: $backup ($(du -h "$backup" 2>/dev/null | cut -f1 || echo '?'))"

  info "Geplant: App-Dateien nach $INSTALL_DIR kopieren, Image neu bauen und Container ersetzen."
  info "Die Volumes ${CONTAINER_NAME}_poker-data und ${CONTAINER_NAME}_poker-sounds werden weiterverwendet."
  confirm "Jetzt neu bauen und neu starten?" || { info "Abgebrochen. Backup bleibt bestehen."; exit 0; }
  copy_to_install_dir "${APP_ITEMS[@]}" "${OPTIONAL_ITEMS[@]}"
  if [[ -f $INSTALL_DIR/.env.example && ! -f $INSTALL_DIR/.env ]]; then
    info "Hinweis: Es gibt eine .env.example (z. B. DISCORD_WEBHOOK), aber noch keine .env."
    info "         Zum Einrichten danach ./deploy.sh ausführen – Daten bleiben erhalten."
  fi
  local -a COMPOSE=(compose --project-name "$CONTAINER_NAME" --project-directory "$INSTALL_DIR"
                    --env-file "$STATE_FILE" -f "$INSTALL_DIR/docker-compose.yml")
  [[ -f $INSTALL_DIR/$OVERRIDE_FILE_NAME ]] && COMPOSE+=(-f "$INSTALL_DIR/$OVERRIDE_FILE_NAME")
  dk "${COMPOSE[@]}" up -d --build

  info "Warte auf den Container (max. 90 s) …"
  local _ st=""
  for _ in $(seq 1 45); do
    st=$(dk inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' "$CONTAINER_NAME" 2>/dev/null || true)
    [[ $st == "running healthy" || $st == exited* || $st == dead* ]] && break
    sleep 2
  done
  if [[ $st != "running healthy" ]]; then
    warn "Status: '${st:-unbekannt}'. Letzte Log-Zeilen:"
    dk logs --tail 30 "$CONTAINER_NAME" || true
    die "Container läuft nicht sauber. Backup der Daten: $backup (Wiederherstellung siehe README)."
  fi
  ok "Container '$CONTAINER_NAME' läuft wieder (healthy)."

  step "5/5 Fertig"
  info "Spielerdaten: unverändert in den Volumes. Backup vor dem Update: $backup"
  info "Spieler laden die Seite neu (bei installierter App: schließen und neu öffnen)."
}

main "$@"
exit 0
