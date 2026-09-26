#!/usr/bin/env bash
# Links this dev box as an OBS node of the LOCAL StreamWizard stack and writes
# .env.local for docker-compose.local.yml. Does what web-admin's "Add node"
# plus install.sh's claim step do, minus Tailscale/ufw/systemd:
#   1. insert a pending obs_nodes row with a claim-token hash (local Supabase)
#   2. POST /api/nodes/claim on the local rest-api, like install.sh
#   3. write .env.local from the response, pointed at host.docker.internal
#   4. set the row's api_url to http://localhost:<port>
#
# Needs: local Supabase (supabase start) and rest-api (bun dev) running.
#
#   scripts/local/register-node.sh [--name local-wsl] [--park-other-nodes]
#
# --park-other-nodes sets every other linked node to status 'disabled'. The panel
# gives new instances to the oldest linked node with room, so a leftover fake
# node would otherwise win. Undo: update obs_nodes set status='linked' where
# status='disabled' and name <> 'local-wsl';
set -euo pipefail

cd "$(dirname "$0")/../.."

NAME="local-wsl"
PARK=false
REST="${REST_API_URL_HOST:-http://localhost:8080}"
DB_CONTAINER="${SUPABASE_DB_CONTAINER:-supabase_db_streamwizard}"
PORT="${API_HOST_PORT:-3100}"

for arg in "$@"; do
  case "$arg" in
    --name=*) NAME="${arg#*=}" ;;
    --park-other-nodes) PARK=true ;;
    -h|--help) sed -n 2,20p "$0"; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

if [ -f .env.local ]; then
  echo ".env.local already exists; remove it first to register a new node." >&2
  exit 1
fi

psql_q() { docker exec -i "$DB_CONTAINER" psql -U postgres -v ON_ERROR_STOP=1 -At "$@"; }

curl -fsS -m 5 "$REST/health" >/dev/null 2>&1 || curl -fsS -m 5 -o /dev/null "$REST/" 2>/dev/null || {
  echo "rest-api not reachable at $REST (cd streamwizard/apps/rest-api && bun run dev)" >&2
  exit 1
}

TOKEN="$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n')"
TOKEN_HASH="$(printf '%s' "$TOKEN" | sha256sum | cut -d' ' -f1)"

NODE_ID="$(psql_q -c "insert into obs_nodes (name, max_instances, status, claim_token_hash, claim_token_expires_at)
  values ('$NAME', 2, 'pending', '$TOKEN_HASH', now() + interval '30 minutes') returning id;" | head -1)"
echo "created pending node $NAME ($NODE_ID)"

GPU_LINE="$(nvidia-smi --query-gpu=pci.bus_id,memory.total,name --format=csv,noheader,nounits | head -1)"
BUS_ID="$(echo "$GPU_LINE" | cut -d, -f1 | xargs)"
VRAM="$(echo "$GPU_LINE" | cut -d, -f2 | xargs)"
GPU_MODEL="$(echo "$GPU_LINE" | cut -d, -f3 | xargs)"
RAM_MB="$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)"

RESP="$(curl -fsS -X POST "$REST/api/nodes/claim" -H 'Content-Type: application/json' -d "$(jq -n \
  --arg token "$TOKEN" --arg bus "$BUS_ID" --arg model "$GPU_MODEL" \
  --argjson vram "$VRAM" --argjson ram "$RAM_MB" --argjson cores "$(nproc)" \
  '{token:$token, gpu_bus_id:$bus, vram_total_mb:$vram, ram_total_mb:$ram, cpu_cores:$cores, gpu_model:$model, storage_total_mb:0}')")"

LOCAL_DATA_DIR="$(pwd)/.local-data"
mkdir -p "$LOCAL_DATA_DIR/obs-configs" "$LOCAL_DATA_DIR/obs-plugins"

sed -e "s|^NODE_ID=.*|NODE_ID=$(jq -r .node_id <<<"$RESP")|" \
    -e "s|^NODE_API_KEY=.*|NODE_API_KEY=$(jq -r .node_api_key <<<"$RESP")|" \
    -e "s|^TOKEN_ENCRYPTION_KEY=.*|TOKEN_ENCRYPTION_KEY=$(jq -r .TOKEN_ENCRYPTION_KEY <<<"$RESP")|" \
    -e "s|^S3_ENDPOINT=.*|S3_ENDPOINT=$(jq -r .S3_ENDPOINT <<<"$RESP")|" \
    -e "s|^S3_ACCESS_KEY=.*|S3_ACCESS_KEY=$(jq -r .S3_ACCESS_KEY <<<"$RESP")|" \
    -e "s|^S3_SECRET_KEY=.*|S3_SECRET_KEY=$(jq -r .S3_SECRET_KEY <<<"$RESP")|" \
    -e "s|^S3_BUCKET=.*|S3_BUCKET=$(jq -r .S3_BUCKET <<<"$RESP")|" \
    -e "s|^S3_REGION=.*|S3_REGION=$(jq -r .S3_REGION <<<"$RESP")|" \
    -e "s|^API_HOST_PORT=.*|API_HOST_PORT=$PORT|" \
    -e "s|^LOCAL_DATA_DIR=.*|LOCAL_DATA_DIR=$LOCAL_DATA_DIR|" \
    -e "s|^OBS_CONFIG_BASE=.*|OBS_CONFIG_BASE=$LOCAL_DATA_DIR/obs-configs|" \
    -e "s|^PLUGINS_PATH=.*|PLUGINS_PATH=$LOCAL_DATA_DIR/obs-plugins|" \
    .env.local.example > .env.local
chmod 600 .env.local

psql_q -c "update obs_nodes set api_url = 'http://localhost:$PORT' where id = '$NODE_ID';" >/dev/null
if $PARK; then
  parked="$(psql_q -c "update obs_nodes set status = 'disabled' where status = 'linked' and id <> '$NODE_ID' returning name;" | paste -sd, -)"
  [ -n "$parked" ] && echo "parked other nodes: $parked"
fi

echo "linked. .env.local written; start with scripts/local/up.sh"
