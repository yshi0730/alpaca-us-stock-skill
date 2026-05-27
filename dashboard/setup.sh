#!/usr/bin/env bash
#
# One-command, idempotent bring-up for the US Equity dashboard.
#
#   bash /home/storyclaw/.openclaw/workspace-alpaca-us-stock-trader/skills/alpaca-us-stock/dashboard/setup.sh                         # Layer 0 + Layer 1 infra
#   bash /home/storyclaw/.openclaw/workspace-alpaca-us-stock-trader/skills/alpaca-us-stock/dashboard/setup.sh creds KEY SECRET paper  # write creds + re-render
#
# The agent runs `setup.sh` at §S3, then `setup.sh creds ...` once the
# user provides the Alpaca key. Everything here is deterministic and
# safe to re-run every session / on cron — duplicate hubs / re-clones /
# double tunnels are all guarded against. The agent never hand-types the
# fragile 12-step infra sequence.
#
# Env overrides (testing / non-default layout):
#   CLAW_HOME          default ~/.claw
#   CLAW_SHARED_DB     default $CLAW_HOME/shared/shared.db
#   CLAW_HUB_PUBLIC    default $CLAW_HOME/hub/public
#   CLAW_DEVICE_SERIAL force the device id (else: /etc/claw/device-id, or
#                      a generate-once UUID persisted to ~/.claw/device-id)
#   CLAW_HUB_PORT      force the hub port (else: a free port picked once
#                      and persisted to ~/.claw/hub-port; avoids :3000)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAW="${CLAW_HOME:-$HOME/.claw}"
DASH_SKILL="$CLAW/dashboard-skill"
HUB="$CLAW/hub"
SHARED_DB="${CLAW_SHARED_DB:-$CLAW/shared/shared.db}"
PUBLIC="${CLAW_HUB_PUBLIC:-$HUB/public}"
AGENT_ID="alpaca-us-stock-trader"
TUNNEL_API="https://api.clawln.app"
DASH_REPO="https://github.com/yshi0730/claw-dashboard-skill.git"

log() { printf '\033[36m[setup]\033[0m %s\n' "$*"; }

# ── creds subcommand: write Alpaca creds + re-render ───────────────
cmd_creds() {
  local key="${1:-}" secret="${2:-}" mode="${3:-paper}"
  if [ -z "$key" ] || [ -z "$secret" ]; then
    echo "usage: setup.sh creds <KEY> <SECRET> [paper|live]" >&2
    exit 2
  fi
  mkdir -p "$(dirname "$SHARED_DB")"
  CLAW_SHARED_DB="$SHARED_DB" python3 - "$AGENT_ID" "$key" "$secret" "$mode" "$SHARED_DB" <<'PY'
import sqlite3, os, sys
agent, key, secret, mode, db_path = sys.argv[1:6]
db = sqlite3.connect(db_path)
db.execute("""CREATE TABLE IF NOT EXISTS agent_config(
  agent_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
  value_type TEXT DEFAULT 'string', category TEXT DEFAULT 'preference',
  label TEXT, updated_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY(agent_id,key))""")
paper = 'true' if mode != 'live' else 'false'
for k, v, t in (("alpaca_key", key, "string"),
                ("alpaca_secret", secret, "string"),
                ("alpaca_paper", paper, "bool")):
    db.execute("INSERT OR REPLACE INTO agent_config"
               "(agent_id,key,value,value_type,category) VALUES(?,?,?,?, 'mode')",
               (agent, k, v, t))
db.commit(); db.close()
print(f"creds written to agent_config (mode={mode})")
PY
  log "re-rendering with live creds"
  CLAW_SHARED_DB="$SHARED_DB" CLAW_HUB_PUBLIC="$PUBLIC" python3 "$SCRIPT_DIR/render.py"
}

# ── setup subcommand: Layer 0 + Layer 1 infra (idempotent) ─────────
cmd_setup() {
  # 1. STABLE device identity — a portable UUID, generated once and
  #    persisted. NOT the BIOS serial and NEVER machine-id. Rationale:
  #    BIOS serial is unreadable/garbage on many mini-PC models, absent
  #    on the cloud-preview VM, and anti-portable (would break the
  #    cloud→device migration — the URL must follow the user). A
  #    persisted UUID is stable across reboots/re-runs, identical logic
  #    on every HW model and on cloud, and migrates by copying the file.
  #    Resolution order (first hit wins):
  #      CLAW_DEVICE_SERIAL env  >  /etc/claw/device-id (provisioned,
  #      survives re-image)  >  ~/.claw/device-id (generate-once)
  ID_FILE_SYS="/etc/claw/device-id"
  ID_FILE="$CLAW/device-id"
  if [ -n "${CLAW_DEVICE_SERIAL:-}" ]; then
    SERIAL="$CLAW_DEVICE_SERIAL"
  elif [ -s "$ID_FILE_SYS" ]; then
    SERIAL="$(cat "$ID_FILE_SYS")"
  elif [ -s "$ID_FILE" ]; then
    SERIAL="$(cat "$ID_FILE")"
  else
    SERIAL="$(uuidgen 2>/dev/null || cat /proc/sys/kernel/random/uuid 2>/dev/null || true)"
    SERIAL="$(printf '%s' "$SERIAL" | tr -dc 'A-Za-z0-9' | cut -c1-12)"
    [ -n "$SERIAL" ] || { echo "ERROR: could not generate a device id; set CLAW_DEVICE_SERIAL" >&2; exit 1; }
    mkdir -p "$(dirname "$ID_FILE")"
    printf '%s' "$SERIAL" > "$ID_FILE"
    log "generated stable device id, persisted to $ID_FILE"
  fi
  # Normalize to the registration contract: exactly 12 alphanumerics,
  # uppercase (the Worker enforces ^[A-Z0-9]{12}$).
  SERIAL="$(printf '%s' "$SERIAL" | tr -dc 'A-Za-z0-9' | cut -c1-12 | tr 'a-z' 'A-Z')"
  if ! printf '%s' "$SERIAL" | grep -qE '^[A-Z0-9]{12}$'; then
    echo "ERROR: device id '$SERIAL' is not 12 alphanumerics. Set CLAW_DEVICE_SERIAL to a 12-char id." >&2
    exit 1
  fi
  log "device id: $SERIAL"

  # 1b. STABLE hub port. The OpenClaw Gateway already owns :3000, and the
  #     tunnel ingress (set server-side at register time) must point at
  #     whatever port the hub actually binds. Pick a free port once, then
  #     persist it so the ingress stays correct across re-runs.
  PORT_FILE="$CLAW/hub-port"
  if [ -n "${CLAW_HUB_PORT:-}" ]; then
    HUB_PORT="$CLAW_HUB_PORT"
  elif [ -s "$PORT_FILE" ]; then
    HUB_PORT="$(cat "$PORT_FILE")"
  else
    HUB_PORT=""
    for p in 7330 7430 8930 9330 7331; do
      if ! python3 -c "import socket,sys;s=socket.socket();s.settimeout(0.3);sys.exit(0 if s.connect_ex(('127.0.0.1',$p))==0 else 1)" 2>/dev/null; then
        HUB_PORT="$p"; break
      fi
    done
    [ -n "$HUB_PORT" ] || HUB_PORT=7330
    mkdir -p "$(dirname "$PORT_FILE")"
    printf '%s' "$HUB_PORT" > "$PORT_FILE"
    log "selected hub port $HUB_PORT, persisted to $PORT_FILE"
  fi
  log "hub port: $HUB_PORT"

  # 1c. FAST-PATH: if Layer 0 is already fully operational + tunnel
  #     verified end-to-end, skip the heavy bring-up (clone / pip /
  #     hub-app copy / register / start). The slow path was observed
  #     to hang for ~4 minutes when git pull or pip install silently
  #     stalled on a slow / flaky network; the fast path lets a
  #     warm device be ready in ~2 seconds instead.
  FAST_PATH=0
  if [ -d "$DASH_SKILL/.git" ] \
     && [ -s "$CLAW/config/tunnel.json" ] \
     && curl -fsS --max-time 2 "http://127.0.0.1:$HUB_PORT/api/health" >/dev/null 2>&1 \
     && pgrep -f "cloudflared tunnel run" >/dev/null 2>&1; then
    PUBLIC_URL=$(python3 -c "import json;print(json.load(open('$CLAW/config/tunnel.json')).get('public_url',''))" 2>/dev/null || true)
    if [ -n "$PUBLIC_URL" ] && curl -fsS --max-time 5 "${PUBLIC_URL}/api/health" >/dev/null 2>&1; then
      log "✓ fast-path: Layer 0 already up + tunnel verified · skipping clone/pip/copy/register"
      FAST_PATH=1
      mkdir -p "$(dirname "$SHARED_DB")" "$PUBLIC"   # ensure render-target dirs
    fi
  fi

  if [ "$FAST_PATH" = 0 ]; then

  # 2. Layer 0 source: clone or pull (offline-tolerant, hard timeout
  #    so a flaky / hanging network can't stall setup indefinitely).
  if [ -d "$DASH_SKILL/.git" ]; then
    log "updating claw-dashboard-skill (timeout 60s)"
    timeout 60 git -C "$DASH_SKILL" pull --quiet || log "pull failed/timed out — using existing checkout"
  else
    log "cloning claw-dashboard-skill (timeout 90s)"
    timeout 90 git clone --quiet "$DASH_REPO" "$DASH_SKILL" || { echo "ERROR: clone failed/timed out" >&2; exit 1; }
  fi

  # 3. python deps (Layer 0 hub + Layer 1 render). Skip pip entirely
  #    when all four are already importable — saves ~10-30s on warm
  #    re-runs and avoids the silent-pip-hang failure mode. Hard
  #    timeout when we do need to install.
  if python3 -c "import fastapi, uvicorn, jinja2, httpx" 2>/dev/null; then
    log "python deps already importable · skipping pip install"
  else
    log "installing python deps (timeout 120s)"
    timeout 120 python3 -m pip install --quiet fastapi uvicorn jinja2 httpx || log "WARN Layer0 pip failed/timed out"
    timeout 120 python3 -m pip install --quiet -r "$SCRIPT_DIR/requirements.txt" || log "WARN dashboard pip"
  fi

  # 4. dirs + hub-app (cp refreshes hub to the cloned version).
  #    Pre-create an empty shared.db so render.py at step 8 doesn't
  #    trip its "not initialized" fallback (which wrote a misleading
  #    page saying setup.sh hadn't run — exactly when it just had).
  #    With the file present, render.py falls through to the "no
  #    creds → connect Alpaca" page, which is the correct initial
  #    state after setup.sh and before §S5.
  mkdir -p "$HUB" "$CLAW/config" "$(dirname "$SHARED_DB")" "$PUBLIC"
  touch "$SHARED_DB"
  cp -R "$DASH_SKILL/hub-app/." "$HUB/"
  log "hub-app installed at $HUB"

  # 5. register device tunnel. Sends the chosen hub port so the Worker
  #    configures the tunnel ingress at http://localhost:$HUB_PORT.
  #    Idempotent server-side (same id → same tunnel; recovers a
  #    KV/Cloudflare desync). Offline-tolerant: reuse cached tunnel.json.
  if curl -fsS -X POST "$TUNNEL_API/devices/register" \
        -H "Content-Type: application/json" \
        -d "{\"serial\":\"$SERIAL\",\"port\":$HUB_PORT}" -o "$CLAW/config/tunnel.json" 2>/dev/null; then
    log "tunnel registered"
  elif [ -s "$CLAW/config/tunnel.json" ]; then
    log "WARN register call failed — reusing existing tunnel.json"
  else
    echo "ERROR: tunnel registration failed and no cached tunnel.json" >&2
    exit 1
  fi
  PUBLIC_URL=$(python3 -c "import json;print(json.load(open('$CLAW/config/tunnel.json')).get('public_url',''))" 2>/dev/null || true)
  TOKEN=$(python3 -c "import json;print(json.load(open('$CLAW/config/tunnel.json')).get('tunnel_token',''))" 2>/dev/null || true)
  log "tunnel url: ${PUBLIC_URL:-<unknown>}"

  # 6. hub: start only if not already serving on our port (no dup uvicorn)
  if curl -fsS "http://127.0.0.1:$HUB_PORT/api/health" >/dev/null 2>&1; then
    log "hub already running on :$HUB_PORT"
  else
    log "starting hub (uvicorn :$HUB_PORT)"
    ( cd "$HUB" && nohup python3 -m uvicorn app:app --host 0.0.0.0 --port "$HUB_PORT" \
        > "$CLAW/hub.log" 2>&1 & disown )
    sleep 2
  fi

  # 7. cloudflared: start only if not already running AND tunnel actually
  #    responds. Process-presence (pgrep) alone is not enough — a parent
  #    SIGKILL can leave a zombie cloudflared whose WebSocket to the
  #    Cloudflare edge is dead. That presents to the user as Error 1033
  #    ("Cloudflare Tunnel error · unable to resolve") even though the
  #    process is alive. So we verify via the public URL; if that fails
  #    we kill the zombie and start fresh.
  RESTART_CFD=1
  if pgrep -f "cloudflared tunnel run" >/dev/null 2>&1; then
    if [ -n "$PUBLIC_URL" ] && curl -fsS --max-time 5 "${PUBLIC_URL}/api/health" >/dev/null 2>&1; then
      log "cloudflared already running, tunnel verified"
      RESTART_CFD=0
    else
      log "cloudflared process exists but tunnel not responding (zombie / Error 1033) — killing + restarting"
      pkill -f "cloudflared tunnel run" 2>/dev/null || true
      sleep 1
    fi
  fi
  if [ "$RESTART_CFD" = 1 ]; then
    if command -v cloudflared >/dev/null 2>&1 && [ -n "$TOKEN" ]; then
      log "starting cloudflared"
      nohup cloudflared tunnel run --token "$TOKEN" > "$CLAW/tunnel.log" 2>&1 & disown
      sleep 3
      if [ -n "$PUBLIC_URL" ] && curl -fsS --max-time 8 "${PUBLIC_URL}/api/health" >/dev/null 2>&1; then
        log "✓ cloudflared started, tunnel verified"
      else
        log "WARN cloudflared started but tunnel not yet responding (Cloudflare edge may need ~10-30s to propagate)"
      fi
    else
      log "WARN cloudflared missing or no token — page is local-only for now"
    fi
  fi

  fi  # end FAST_PATH=0 branch (slow path: steps 2–7)

  # 8. first render (writes the placeholder/live page; safe without creds)
  log "rendering dashboard page"
  CLAW_SHARED_DB="$SHARED_DB" CLAW_HUB_PUBLIC="$PUBLIC" \
    python3 "$SCRIPT_DIR/render.py" || log "WARN render"

  # 9. status the agent relays to the user
  if python3 -c "import sqlite3,sys;sys.exit(0 if sqlite3.connect('$SHARED_DB').execute(\"SELECT 1 FROM agent_config WHERE agent_id='$AGENT_ID' AND key='alpaca_key'\").fetchone() else 1)" 2>/dev/null; then
    CREDS="set ✓"
  else
    CREDS="NOT set — run: bash /home/storyclaw/.openclaw/workspace-alpaca-us-stock-trader/skills/alpaca-us-stock/dashboard/setup.sh creds <KEY> <SECRET> paper"
  fi
  cat <<EOF

──────── dashboard ready ────────
 URL    : ${PUBLIC_URL:-<tunnel pending>}/static/us-equity.html
 hub    : http://127.0.0.1:$HUB_PORT   (log: $CLAW/hub.log)
 db     : $SHARED_DB
 creds  : $CREDS
─────────────────────────────────
EOF
}

case "${1:-setup}" in
  creds) shift; cmd_creds "$@" ;;
  setup | "") cmd_setup ;;
  *) echo "usage: setup.sh [setup] | creds <KEY> <SECRET> [paper|live]" >&2; exit 2 ;;
esac
