#!/usr/bin/env bash
# videogen — script de démarrage de l'instance GPU.
# Lancé par l'amorce « onstart » (générée par l'interface) à CHAQUE démarrage du conteneur,
# après vérification de son empreinte SHA-256. Idempotent : ne refait que ce qui manque.
#
# Variables d'environnement (transmises par l'interface à la création de l'instance) :
#   COMFY_ACCESS_TOKEN  jeton exigé par Caddy (généré dans le navigateur, >= 32 caractères)
#   ALLOWED_ORIGIN      origine de l'interface (ex. https://utilisateur.github.io)
#   HF_TOKEN            token Hugging Face (lecture, dépôts protégés)
#   MODELS              familles de modèles à installer, séparées par des virgules (ltx25,wan22,hunyuan15)
#   IDLE_MINUTES        arrêt si la file ComfyUI est vide depuis N minutes (défaut 20, 0 = jamais)
#   MAX_HOURS           arrêt si l'instance tourne depuis plus de X heures (défaut 4, 0 = jamais)
#   COMFY_VERSION       tag ComfyUI (défaut ci-dessous)
# Injectées par Vast : CONTAINER_ID, CONTAINER_API_KEY (clé limitée à CETTE instance).
set -uo pipefail

VG_HOME=${VG_HOME:-/workspace/videogen}
SRC=$VG_HOME/src
RUN=$VG_HOME/run
LOGS=$VG_HOME/logs
BIN=$VG_HOME/bin
STATE=$VG_HOME/state
COMFY_DIR=$VG_HOME/ComfyUI
export VG_HOME COMFY_DIR

COMFY_VERSION=${COMFY_VERSION:-v0.44.2}
CADDY_VERSION=2.11.9
CADDY_SHA256=5b8cb7faf8726a2028ad96a66e54e6e81e8f361bc6175e5d22bbd997cc5177fb
CLOUDFLARED_VERSION=2026.10.7
CLOUDFLARED_SHA256=1f99fb518b83dec2ba8d870a7cc991d82a77e6196295a3d2754ba17ab9f91872
export IDLE_MINUTES=${IDLE_MINUTES:-20} MAX_HOURS=${MAX_HOURS:-4} MODELS=${MODELS:-ltx25} COMFY_VERSION

mkdir -p "$LOGS" "$BIN" "$STATE" "$RUN"
# Arrête une éventuelle exécution précédente (relance de onstart sans redémarrage du conteneur) :
# d'abord les boucles de supervision, puis les processus eux-mêmes.
for f in "$RUN"/*.pid; do [ -f "$f" ] && kill "$(cat "$f")" 2>/dev/null; done
pkill -f "$BIN/caddy run" 2>/dev/null; pkill -f "$BIN/cloudflared tunnel" 2>/dev/null
pkill -f "$SRC/agent.py serve" 2>/dev/null; pkill -f "$COMFY_DIR/main.py" 2>/dev/null
rm -rf "$RUN" && mkdir -p "$RUN"
date +%s >"$RUN/boot_ts"

stamp() { date -u +%Y-%m-%dT%H:%M:%SZ; }
log() { echo "$(stamp) $*"; }
# Ligne publiée dans les logs du conteneur : l'interface la lit via l'API Vast (request_logs).
PUBLISH_TO=${VG_PUBLISH_TO:-/proc/1/fd/1}
pub() { log "$*"; { echo "$*" >>"$PUBLISH_TO"; } 2>/dev/null || true; }
mark() { python3 "$SRC/agent.py" mark "$@" 2>/dev/null || true; pub "VIDEOGEN_STEP=$1:$2${3:+ $3}"; }
die() { mark "$1" error "$2"; log "ERREUR $1 : $2"; exit 1; }

pub "VIDEOGEN_BOOT=$(cat "$RUN/boot_ts")"

# ---------------------------------------------------------------- 0. contrôles
export COMFY_ACCESS_TOKEN=${COMFY_ACCESS_TOKEN:-} ALLOWED_ORIGIN=${ALLOWED_ORIGIN:-}
[ "${#COMFY_ACCESS_TOKEN}" -ge 32 ] || die tools "COMFY_ACCESS_TOKEN absent ou trop court"
[[ "$ALLOWED_ORIGIN" =~ ^https?://[A-Za-z0-9.-]+(:[0-9]+)?$ ]] || die tools "ALLOWED_ORIGIN invalide"

supervise() { # supervise NOM COMMANDE... : relance la commande si elle s'arrête
  local name=$1; shift
  ( while true; do
      "$@" >>"$LOGS/$name.log" 2>&1
      echo "$(stamp) $name arrêté (code $?) — relance dans 3 s" >>"$LOGS/$name.log"
      sleep 3
    done ) &
  echo $! >"$RUN/$name.pid"
}

# ---------------------------------------------------------------- 1. outils (Caddy, cloudflared)
mark tools running
install_caddy() {
  [ -x "$BIN/caddy" ] && [ "$(cat "$BIN/caddy.sha256" 2>/dev/null)" = "$CADDY_SHA256" ] && return 0
  local tmp=$BIN/caddy.tgz
  curl -fsSL --retry 5 --retry-delay 3 -o "$tmp" \
    "https://github.com/caddyserver/caddy/releases/download/v$CADDY_VERSION/caddy_${CADDY_VERSION}_linux_amd64.tar.gz" || return 1
  echo "$CADDY_SHA256  $tmp" | sha256sum -c --quiet - || { rm -f "$tmp"; return 2; }
  tar -xzf "$tmp" -C "$BIN" caddy && chmod +x "$BIN/caddy" && echo "$CADDY_SHA256" >"$BIN/caddy.sha256"
  rm -f "$tmp"
}
install_cloudflared() {
  [ -x "$BIN/cloudflared" ] && [ "$(cat "$BIN/cloudflared.sha256" 2>/dev/null)" = "$CLOUDFLARED_SHA256" ] && return 0
  local tmp=$BIN/cloudflared.download
  curl -fsSL --retry 5 --retry-delay 3 -o "$tmp" \
    "https://github.com/cloudflare/cloudflared/releases/download/$CLOUDFLARED_VERSION/cloudflared-linux-amd64" || return 1
  echo "$CLOUDFLARED_SHA256  $tmp" | sha256sum -c --quiet - || { rm -f "$tmp"; return 2; }
  mv "$tmp" "$BIN/cloudflared" && chmod +x "$BIN/cloudflared" && echo "$CLOUDFLARED_SHA256" >"$BIN/cloudflared.sha256"
}
install_caddy || die tools "téléchargement ou empreinte de Caddy $CADDY_VERSION invalide"
install_cloudflared || die tools "téléchargement ou empreinte de cloudflared $CLOUDFLARED_VERSION invalide"
mark tools "done"

# ---------------------------------------------------------------- 2. agent + Caddy + tunnel
export VG_LOG_DIR=$LOGS COMFY_URL=http://127.0.0.1:28188 AGENT_PORT=28189
supervise agent python3 "$SRC/agent.py" serve
supervise caddy "$BIN/caddy" run --config "$SRC/Caddyfile" --adapter caddyfile

mark tunnel running
tunnel_loop() {
  local proto=quic url pid ready
  while true; do
    : >"$LOGS/cloudflared.log"
    "$BIN/cloudflared" tunnel --no-autoupdate --protocol "$proto" --url http://127.0.0.1:28080 \
      --metrics 127.0.0.1:28241 >>"$LOGS/cloudflared.log" 2>&1 &
    pid=$!
    url="" ready=""
    for _ in $(seq 1 90); do
      kill -0 "$pid" 2>/dev/null || break
      [ -z "$url" ] && url=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOGS/cloudflared.log" | head -n1)
      if [ -n "$url" ] && curl -fs -o /dev/null http://127.0.0.1:28241/ready; then ready=1; break; fi
      sleep 1
    done
    if [ -n "$ready" ]; then
      echo "$url" >"$RUN/tunnel_url"
      pub "VIDEOGEN_TUNNEL_URL=$url"
      python3 "$SRC/agent.py" mark tunnel "done" "$url"
      # Copie de l'URL dans le label de l'instance (si la clé restreinte de Vast le permet).
      if [ -n "${CONTAINER_API_KEY:-}" ] && [ -n "${CONTAINER_ID:-}" ]; then
        curl -fs -m 20 -X PUT -H "Authorization: Bearer $CONTAINER_API_KEY" -H 'Content-Type: application/json' \
          -d "{\"label\":\"videogen $url\"}" "https://console.vast.ai/api/v0/instances/$CONTAINER_ID/" \
          >/dev/null 2>&1 || true
      fi
      wait "$pid"
      pub "VIDEOGEN_STEP=tunnel:lost"
      rm -f "$RUN/tunnel_url"
    else
      kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null
      # QUIC (UDP 7844) souvent bloqué : bascule HTTP/2, et inversement.
      if [ "$proto" = quic ]; then proto=http2; else proto=quic; fi
      pub "VIDEOGEN_STEP=tunnel:retry $proto"
    fi
    sleep 3
  done
}
tunnel_loop >>"$LOGS/tunnel.log" 2>&1 &
echo $! >"$RUN/tunnel.pid"

# ---------------------------------------------------------------- 3. ComfyUI (installation / mise à jour)
mark comfy_install running
if [ -x /venv/main/bin/python ]; then PY=/venv/main/bin/python
elif python3 -c 'import torch' 2>/dev/null; then PY=$(command -v python3)
else
  python3 -m venv "$VG_HOME/venv" || die comfy_install "création du venv impossible"
  PY=$VG_HOME/venv/bin/python
  "$PY" -m pip install -q --upgrade pip
  "$PY" -m pip install -q torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu128 ||
    die comfy_install "installation de PyTorch impossible"
fi
log "Python : $PY ($("$PY" -c 'import torch;print(torch.__version__, torch.version.cuda)' 2>&1))"

if [ ! -d "$COMFY_DIR/.git" ]; then
  git clone -q --depth 1 --branch "$COMFY_VERSION" https://github.com/comfyanonymous/ComfyUI "$COMFY_DIR" ||
    die comfy_install "clonage de ComfyUI $COMFY_VERSION impossible"
else
  cur=$(git -C "$COMFY_DIR" describe --tags --exact-match 2>/dev/null || echo none)
  if [ "$cur" != "$COMFY_VERSION" ]; then
    git -C "$COMFY_DIR" fetch -q --depth 1 origin tag "$COMFY_VERSION" &&
      git -C "$COMFY_DIR" checkout -q "$COMFY_VERSION" || die comfy_install "mise à jour vers $COMFY_VERSION impossible"
  fi
fi
REQ_SUM=$(cat "$COMFY_DIR/requirements.txt" | sha256sum | cut -c1-64)
if [ "$(cat "$STATE/requirements.sha256" 2>/dev/null)" != "$REQ_SUM|$PY" ]; then
  "$PY" -m pip install -q -r "$COMFY_DIR/requirements.txt" >>"$LOGS/pip.log" 2>&1 ||
    die comfy_install "pip install -r requirements.txt a échoué (voir logs/pip.log)"
  "$PY" -m pip install -q -U "huggingface_hub>=1.0" >>"$LOGS/pip.log" 2>&1 ||
    die comfy_install "installation de huggingface_hub (hf) impossible"
  echo "$REQ_SUM|$PY" >"$STATE/requirements.sha256"
fi
mark comfy_install "done" "$COMFY_VERSION"

mark comfy_start running
supervise comfyui "$PY" "$COMFY_DIR/main.py" --listen 127.0.0.1 --port 28188 \
  --enable-cors-header "$ALLOWED_ORIGIN" --disable-auto-launch
for _ in $(seq 1 300); do
  curl -fs -o /dev/null http://127.0.0.1:28188/system_stats && break
  sleep 2
done
curl -fs -o /dev/null http://127.0.0.1:28188/system_stats || die comfy_start "ComfyUI ne répond pas (voir logs/comfyui.log)"
mark comfy_start "done"

# ---------------------------------------------------------------- 4. poids des modèles
mark models running "$MODELS"
if [ -x "$(dirname "$PY")/hf" ]; then HF_BIN="$(dirname "$PY")/hf"; export HF_BIN; fi
python3 "$SRC/agent.py" fetch-models
rc=$?
if [ $rc -eq 0 ]; then mark models "done"; else mark models error "voir /videogen/status"; fi

# ---------------------------------------------------------------- 5. prêt
mark ready "done"
log "Démarrage terminé."
